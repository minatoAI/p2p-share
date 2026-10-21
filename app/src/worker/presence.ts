import type { PublicKeyJwk, SignalMessage } from '../core/protocol';
import { CODE_DIGITS, CODE_TTL_MS, MAX_CODES_PER_DEVICE } from '../core/pairing';
import { json } from './json';

interface Attachment {
  deviceId: string;
  name: string;
  /**
   * 这一条连接的唯一编号。
   *
   * 断开时要判断"同一设备还有没有别的连接"，而正在关闭的那条在 webSocketClose
   * 里仍然出现在 getWebSockets() 中（实测确认）。按对象身份比较不可靠，
   * 所以给每条连接一个编号，比编号来排除自己。
   */
  connId: string;
}

interface PresenceRow extends Record<string, SqlStorageValue> {
  device_id: string;
  name: string;
  last_seen: number;
  public_key: string | null;
}

interface CodeRow extends Record<string, SqlStorageValue> {
  code: string;
  device_id: string;
  created_at: number;
  expires_at: number;
}

/** 配对码查询的限流。码只有六位，不限流的话可以暴力试。 */
const LOOKUPS_PER_DEVICE_PER_MINUTE = 12;
const LOOKUPS_GLOBAL_PER_MINUTE = 120;
/** 错几次开始罚。前两次不罚，手滑是常事。 */
const MISSES_BEFORE_COOLDOWN = 2;
/** 第一次罚多久，之后每错一次翻倍，封顶一分钟。 */
const COOLDOWN_BASE_MS = 5_000;
const COOLDOWN_MAX_MS = 60_000;

/**
 * 在线状态板加信令转发，按设备号寻址。
 *
 * 它做四件事：
 *   1. 记住谁在线（在线与否从 getWebSockets() 推导，所以休眠恢复后结论仍然正确）；
 *   2. 播报订阅者关心的上下线；
 *   3. 按 to 字段把信令转发到目标设备；
 *   4. 登记和查询配对码，让两台陌生设备能碰头。
 *
 * 它不知道谁和谁是配对的，也不需要知道。配对关系存在两端本地，
 * 配对码只是接头暗号，查到对方是谁之后就交给六位短认证串去保证安全，
 * 所以这里存的码不需要保密，只需要难猜和有防刷。
 *
 * `share-*` 那几条同样只是转发。它不解析 token，也不判断访客有没有资格，
 * 资格是分享者那侧判的（见 core/share.ts）。灯塔在这条路径上是纯中继，
 * 这是有意的：它一旦开始判资格，就多存了一份本该在两端本地的状态。
 *
 * 免费额度红线：每条 WebSocket 消息算一次请求，每天十万次。
 * 所以这里不做心跳轮询，上下线完全靠连接事件，也不要让任何数据走这里。
 *
 * 单实例部署，靠单点换取实现简单。到瓶颈时按设备号前缀分片，
 * 代价是跨分片的在线通知要改成通过一个目录服务转发。
 */
export class PresenceDO implements DurableObject {
  private readonly sql: SqlStorage;
  /** 限流用的内存计数，休眠恢复会清零。清不清零都不影响正确性，只影响防刷强度。 */
  private globalLookups = { startedAt: 0, count: 0 };
  private readonly deviceLookups = new Map<string, { startedAt: number; count: number }>();

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: unknown,
  ) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_seen INTEGER NOT NULL
      );
    `);
    // 公钥是后来才需要存的（配对码查回来的时候要带上），
    // 已经建好的表用 ALTER 补列，重复执行会抛错，忽略即可。
    try {
      this.sql.exec(`ALTER TABLE devices ADD COLUMN public_key TEXT`);
    } catch {
      /* 列已经在了 */
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS watches (
        watcher TEXT NOT NULL,
        target TEXT NOT NULL,
        PRIMARY KEY (watcher, target)
      );
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS watches_by_target ON watches(target);`);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS pairing_codes (
        code TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.sql.exec(`CREATE INDEX IF NOT EXISTS codes_by_device ON pairing_codes(device_id);`);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    // 这个 DO 挂在 Worker 的 /ws/presence 上，转发过来时路径是原样的。
    // 用 URL 重写会破坏升级语义（Workers 要求原样透传请求），所以直接认两个路径。
    if (url.pathname === '/ws' || url.pathname === '/ws/presence') return this.upgrade(url);
    if (url.pathname === '/presence') {
      const ids = (url.searchParams.get('ids') ?? '').split(',').filter(Boolean);
      return json(this.snapshot(ids));
    }
    return json({ error: 'not-found' }, 404);
  }

  /* ---------------------------------------------------------- 连接 */

  private upgrade(url: URL): Response {
    const deviceId = url.searchParams.get('deviceId');
    const name = url.searchParams.get('name') || '未命名设备';
    if (!deviceId) return json({ error: 'missing-device-id' }, 400);

    // 同一台设备重连时踢掉旧连接，避免自己在状态板里出现两次
    for (const old of this.socketsOf(deviceId)) {
      try {
        old.close(4000, 'duplicate-session');
      } catch {
        /* 已经关掉了 */
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      deviceId,
      name,
      connId: crypto.randomUUID(),
    } satisfies Attachment);

    const now = Date.now();
    this.sql.exec(
      `INSERT INTO devices (device_id, name, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(device_id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`,
      deviceId,
      name,
      now,
    );

    // 告诉关心它的订阅者：这台设备上线了
    this.notifyWatchers(deviceId, true);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------------------------------------------------- 消息 */

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let msg: SignalMessage;
    try {
      msg = JSON.parse(message) as SignalMessage;
    } catch {
      return;
    }
    const from = this.attachmentOf(ws)?.deviceId;
    if (!from || !msg || typeof msg.t !== 'string') return;
    this.touch(from);

    switch (msg.t) {
      case 'watch': {
        this.setWatch(from, msg.ids ?? []);
        this.sendTo(ws, { t: 'presence-list', entries: this.snapshot(msg.ids ?? []) });
        return;
      }
      case 'pair-request':
      case 'pair-response':
      case 'connect-request':
      case 'share-connect':
      case 'share-revoked':
      case 'share-leave':
      case 'sdp':
      case 'ice': {
        const candidates = this.socketsOf(msg.to);
        const target = candidates[0];
        // 中继这一步的日志。端到端那边只能看到"浏览器没收到"，看不到中继
        // 到底收没收到、有没有转出去。把这里打出来才能把范围钉死在
        // "原生端没发出来"还是"中继没转出去"。
        console.log(
          `[中继] ${msg.t} from=${String(from).slice(0, 6)} to=${String(msg.to).slice(0, 6)} ` +
            `目标连接数=${candidates.length} ${
              candidates.length > 1 ? '⚠ 有多个同名连接' : ''
            }`,
        );
        if (!target) {
          console.log(`[中继] ⚠ ${msg.t} 没找到目标，回 peer-offline`);
          this.sendTo(ws, { t: 'error', code: 'peer-offline', message: '对方不在线' });
          return;
        }
        // from 一律由服务端填，客户端自称无效
        this.sendTo(target, { ...msg, from });
        return;
      }
      case 'hello': {
        this.sql.exec(
          `UPDATE devices SET name = ?, public_key = ?, last_seen = ? WHERE device_id = ?`,
          msg.name,
          JSON.stringify(msg.publicKey ?? null),
          Date.now(),
          from,
        );
        this.notifyWatchers(from, true);
        return;
      }
      case 'new-code': {
        this.sendTo(ws, this.issueCode(from, Date.now()));
        return;
      }
      case 'lookup-code': {
        this.sendTo(ws, this.lookupCode(from, msg.code, Date.now()));
        return;
      }
      case 'bye': {
        this.broadcastToWatchers(from, { t: 'presence', id: from, online: false });
        return;
      }
      default:
        return;
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.handleGone(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.handleGone(ws);
  }

  private handleGone(ws: WebSocket): void {
    const att = this.attachmentOf(ws);
    if (!att) return;
    this.sql.exec(`UPDATE devices SET last_seen = ? WHERE device_id = ?`, Date.now(), att.deviceId);
    // 同一设备可能有别的连接还在（重连的竞态），有的话就不算离线。
    // 注意要按 connId 把自己排除掉：正在关闭的这条仍会出现在 getWebSockets() 里。
    const others = this.socketsOf(att.deviceId).filter(
      (socket) => this.attachmentOf(socket)?.connId !== att.connId,
    );
    if (others.length === 0) {
      this.notifyWatchers(att.deviceId, false);
    }
  }

  /* ---------------------------------------------------------- 配对码 */

  /**
   * 发一个新码给这台设备。
   *
   * 码由服务端生成，保证不撞；每台设备留最近几条，这样刚好赶上换码也不会失败。
   */
  private issueCode(deviceId: string, now: number): SignalMessage {
    this.sql.exec(`DELETE FROM pairing_codes WHERE expires_at < ?`, now);
    const expiresAt = now + CODE_TTL_MS;

    let code = '';
    for (let attempt = 0; attempt < 10 && !code; attempt++) {
      const candidate = String(
        crypto.getRandomValues(new Uint32Array(1))[0]! % 10 ** CODE_DIGITS,
      ).padStart(CODE_DIGITS, '0');
      try {
        this.sql.exec(
          `INSERT INTO pairing_codes (code, device_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
          candidate,
          deviceId,
          now,
          expiresAt,
        );
        code = candidate;
      } catch {
        // 撞上已有码了，重来。空间是 10 的 CODE_DIGITS 次方，正常不会重试。
      }
    }
    if (!code) {
      return { t: 'error', code: 'code-exhausted', message: '生成配对码失败，稍后再试' };
    }

    // 只留最近几条，旧的淘汰
    const mine = this.sql
      .exec<CodeRow>(
        `SELECT * FROM pairing_codes WHERE device_id = ? ORDER BY created_at DESC`,
        deviceId,
      )
      .toArray();
    for (const row of mine.slice(MAX_CODES_PER_DEVICE)) {
      this.sql.exec(`DELETE FROM pairing_codes WHERE code = ?`, row.code);
    }

    return { t: 'code', code, expiresAt };
  }

  /** 查这个码是谁的。要带公钥回去，查询方才能算出六位数字。 */
  private lookupCode(deviceId: string, code: string, now: number): SignalMessage {
    // 同一个码的短时重复查询（网页在拿到 miss 后 600ms 自动重查一次）不再
    // 重复记 miss、也不重复消耗限流额度；否则一次码轮换会被当成两次输错，
    // 第二次就直接进 5 秒冷却。缓存只保留 1.5 秒。
    const recent = this.recentMisses.get(deviceId);
    if (recent && recent.code === code && now - recent.at < 1_500) {
      return {
        t: 'code-miss',
        code,
        reason: recent.reason,
        ...(recent.retryAfterMs ? { retryAfterMs: recent.retryAfterMs } : {}),
      };
    }
    const miss = (reason: string, retryAfterMs?: number): SignalMessage => {
      this.recentMisses.set(deviceId, { code, at: now, reason, retryAfterMs });
      return {
        t: 'code-miss',
        code,
        reason,
        ...(retryAfterMs ? { retryAfterMs } : {}),
      };
    };

    // 冷却优先于限流：错两次先停五秒，再错翻倍，封顶一分钟。
    // 这条比"每分钟十二次"更贴用户：按分钟算的话，用户分不清是自己打错还是被限了。
    const cooling = this.cooldownLeft(deviceId, now);
    if (cooling > 0) {
      return miss(`试错太多次，${Math.ceil(cooling / 1000)} 秒后再试`, cooling);
    }
    if (!this.takeLookupToken(deviceId, now)) {
      return miss('查询太频繁，等一下再试', 15_000);
    }
    const row = this.sql
      .exec<CodeRow>(`SELECT * FROM pairing_codes WHERE code = ?`, code)
      .toArray()[0];
    if (!row) {
      this.noteMiss(deviceId, now);
      return miss('没有这个码，可能已经换过了');
    }
    if (row.expires_at < now) {
      this.sql.exec(`DELETE FROM pairing_codes WHERE code = ?`, code);
      this.noteMiss(deviceId, now);
      return miss('这个码已经过期');
    }
    // 查到了：把欠的账清了
    this.failedLookups.delete(deviceId);
    this.recentMisses.delete(deviceId);
    const owner = this.sql
      .exec<PresenceRow>(`SELECT * FROM devices WHERE device_id = ?`, row.device_id)
      .toArray()[0];
    if (!owner?.public_key) {
      return miss('对方还没报上公钥，让它刷新一下页面');
    }
    let publicKey: PublicKeyJwk;
    try {
      publicKey = JSON.parse(owner.public_key) as PublicKeyJwk;
    } catch {
      return miss('对方公钥读不出来');
    }
    return {
      t: 'code-owner',
      code,
      deviceId: row.device_id,
      name: owner.name,
      publicKey,
    };
  }

  /* ---------------------------------------------------------- 查错冷却 */

  /** 每台设备错了几次、罚到什么时候。连错两次开始罚，5 秒起，逐次翻倍，封顶一分钟。 */
  private failedLookups = new Map<string, { misses: number; until: number }>();
  /** 最近一次 miss，用来吸收同一码的短时重复查询（自动重查）。 */
  private recentMisses = new Map<
    string,
    { code: string; at: number; reason: string; retryAfterMs?: number }
  >();

  private cooldownLeft(deviceId: string, now: number): number {
    const entry = this.failedLookups.get(deviceId);
    if (!entry) return 0;
    if (entry.until > now) return entry.until - now;
    // 罚完了，从零开始记
    if (entry.until !== 0) this.failedLookups.delete(deviceId);
    return 0;
  }

  private noteMiss(deviceId: string, now: number): void {
    const entry = this.failedLookups.get(deviceId) ?? { misses: 0, until: 0 };
    entry.misses += 1;
    if (entry.misses >= MISSES_BEFORE_COOLDOWN) {
      entry.until = now + Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** (entry.misses - MISSES_BEFORE_COOLDOWN));
    }
    this.failedLookups.set(deviceId, entry);
  }

  /**
   * 查询限流。六位数字是 10^6，配上每条码二十秒的寿命、查错冷却和这个限流，
   * 暴力试中一条的概率可以忽略。超过就当作查询不到。
   */
  private takeLookupToken(deviceId: string, now: number): boolean {
    if (now - this.globalLookups.startedAt > 60_000) {
      this.globalLookups = { startedAt: now, count: 0 };
    }
    if (this.globalLookups.count >= LOOKUPS_GLOBAL_PER_MINUTE) return false;
    this.globalLookups.count += 1;

    const mine = this.deviceLookups.get(deviceId);
    if (!mine || now - mine.startedAt > 60_000) {
      this.deviceLookups.set(deviceId, { startedAt: now, count: 1 });
      return true;
    }
    if (mine.count >= LOOKUPS_PER_DEVICE_PER_MINUTE) return false;
    mine.count += 1;
    return true;
  }

  /* ---------------------------------------------------------- 订阅 */

  private setWatch(watcher: string, ids: string[]): void {
    this.sql.exec(`DELETE FROM watches WHERE watcher = ?`, watcher);
    for (const id of ids) {
      if (!id || id === watcher) continue;
      this.sql.exec(
        `INSERT OR IGNORE INTO watches (watcher, target) VALUES (?, ?)`,
        watcher,
        id,
      );
    }
  }

  private snapshot(ids: string[]): Array<{ id: string; online: boolean; name?: string }> {
    const online = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      const id = this.attachmentOf(ws)?.deviceId;
      if (id) online.add(id);
    }
    return ids.filter(Boolean).map((id) => {
      const row = this.sql
        .exec<PresenceRow>(`SELECT * FROM devices WHERE device_id = ?`, id)
        .toArray()[0];
      const entry: { id: string; online: boolean; name?: string } = {
        id,
        online: online.has(id),
      };
      if (row) entry.name = row.name;
      return entry;
    });
  }

  /** 通知所有关心这台设备的订阅者 */
  private notifyWatchers(deviceId: string, online: boolean): void {
    const row = this.sql
      .exec<PresenceRow>(`SELECT * FROM devices WHERE device_id = ?`, deviceId)
      .toArray()[0];
    const msg: SignalMessage = {
      t: 'presence',
      id: deviceId,
      online,
      ...(row ? { name: row.name } : {}),
    };
    this.broadcastToWatchers(deviceId, msg);
  }

  private broadcastToWatchers(deviceId: string, msg: SignalMessage): void {
    const watchers = this.sql
      .exec<{ watcher: string } & Record<string, SqlStorageValue>>(
        `SELECT watcher FROM watches WHERE target = ?`,
        deviceId,
      )
      .toArray();
    if (!watchers.length) return;
    const payload = JSON.stringify(msg);
    for (const { watcher } of watchers) {
      for (const ws of this.socketsOf(watcher)) {
        try {
          ws.send(payload);
        } catch {
          /* 连接已经断开 */
        }
      }
    }
  }

  /* ---------------------------------------------------------- 工具 */

  private attachmentOf(ws: WebSocket): Attachment | null {
    try {
      return (ws.deserializeAttachment() as Attachment | null) ?? null;
    } catch {
      return null;
    }
  }

  private socketsOf(deviceId: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => this.attachmentOf(ws)?.deviceId === deviceId);
  }

  private touch(deviceId: string): void {
    this.sql.exec(`UPDATE devices SET last_seen = ? WHERE device_id = ?`, Date.now(), deviceId);
  }

  private sendTo(ws: WebSocket, msg: SignalMessage): void {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      // 这个 catch 以前是空的。发送失败就被无声吞掉，连"发送失败"这三个字
      // 都看不到——排查"中继说转了但对面没收到"时，最需要知道的恰恰是这里。
      console.log(
        `[中继] ⚠ 发送 ${msg.t} 失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
