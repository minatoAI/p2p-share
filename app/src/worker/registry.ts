import type { PublicKeyJwk, ShareRecord } from '../core/protocol';
import { json } from './json';

const SHARE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SHARES_PER_DEVICE = 20;

interface ShareRow extends Record<string, SqlStorageValue> {
  token: string;
  code: string | null;
  device_id: string;
  device_name: string;
  public_key: string | null;
  name: string;
  size: number;
  mime: string;
  state: string;
  created_at: number;
  expires_at: number;
}

function hex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 分享注册表。
 *
 * 这里只存元信息，一个字节的用户数据都不存。
 * 这是"不做托管"这个设计决定在代码里的样子，见 docs/11 第 2 节和第 6 节。
 *
 * 注意它**不记房间**。访客拿到的是分享者的设备号，然后去在线状态板上
 * 按设备号找它，所以链接的有效性只取决于分享者在不在线。
 * 公钥、配对令牌这些都不在这里：配对关系完全存在两端设备本地。
 *
 * 这里只回答"这条分享注册过没有、被撤销没有、过期没有"。**在线与否不归它管**，
 * 那是在线状态板的事实，两个来源合起来才是访客看到的四个状态。这个合成
 * 放在 Worker 那一层（它同时握着两个 Durable Object 的句柄），见 index.ts 的
 * `/api/share/:token`。
 *
 * 单实例部署，靠单点换取实现的简单。免费额度是每天十万次请求，
 * 到瓶颈时按设备号前缀分片即可，接口不用改。
 */
export class RegistryDO implements DurableObject {
  private readonly sql: SqlStorage;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly env: unknown,
  ) {
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS shares (
        token TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        device_name TEXT NOT NULL,
        name TEXT NOT NULL,
        size INTEGER NOT NULL,
        mime TEXT NOT NULL,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    // 公钥是访客锚定分享者用的，后来才需要。已经建好的表用 ALTER 补列，
    // 重复执行会抛错，忽略即可（和 presence.ts 里 devices 那列一个办法）。
    try {
      this.sql.exec(`ALTER TABLE shares ADD COLUMN public_key TEXT`);
    } catch {
      /* 列已经在了 */
    }
    // 短编号是后来加的。老条目按 token 末 8 位补上；重复的留给唯一索引报错，
    // 正常数据里 16^8 的碰撞概率可以忽略。
    try {
      this.sql.exec(`ALTER TABLE shares ADD COLUMN code TEXT`);
    } catch {
      /* 列已经在了 */
    }
    this.sql.exec(`UPDATE shares SET code = substr(token, -8) WHERE code IS NULL`);
    try {
      this.sql.exec(`CREATE UNIQUE INDEX IF NOT EXISTS shares_by_code ON shares(code)`);
    } catch {
      /* 历史数据有碰撞就先不用唯一索引，查询仍按 code 找 */
    }
    this.sql.exec(`CREATE INDEX IF NOT EXISTS shares_by_device ON shares(device_id);`);
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const now = Date.now();

    if (req.method === 'POST' && path === '/share') {
      const body = (await req.json()) as Partial<ShareRecord> & { ttlMs?: number };
      return this.createShare(body, now);
    }
    if (req.method === 'GET' && path.startsWith('/share/')) {
      return this.getShare(path.slice('/share/'.length));
    }
    if (req.method === 'POST' && path.endsWith('/revoke')) {
      const token = path.slice('/share/'.length, -'/revoke'.length);
      const body = (await req.json()) as { deviceId?: string };
      return this.revokeShare(token, body.deviceId ?? '', now);
    }
    if (req.method === 'GET' && path === '/shares') {
      return this.listShares(url.searchParams.get('deviceId') ?? '', now);
    }
    if (req.method === 'POST' && path === '/sweep') {
      return this.sweep(now);
    }
    return json({ error: 'not-found' }, 404);
  }

  private createShare(body: Partial<ShareRecord> & { ttlMs?: number }, now: number): Response {
    const deviceId = String(body.deviceId ?? '');
    if (!deviceId || !body.name) return json({ error: 'bad-request' }, 400);

    const mine = this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM shares WHERE device_id = ? AND state = 'available' AND expires_at > ?`,
        deviceId,
        now,
      )
      .toArray()[0];
    if ((mine?.n ?? 0) >= MAX_SHARES_PER_DEVICE) {
      return json({ error: 'too-many-shares', limit: MAX_SHARES_PER_DEVICE }, 429);
    }

    let token = hex(16);
    let code = token.slice(-8);
    for (let i = 0; i < 8 && this.rowByCode(code); ++i) {
      token = hex(16);
      code = token.slice(-8);
    }
    const expiresAt = now + (body.ttlMs ?? SHARE_TTL_MS);
    const record: ShareRecord = {
      token,
      code,
      deviceId,
      deviceName: String(body.deviceName ?? '未命名设备'),
      // 公钥可以缺：旧客户端不送，服务端不该因为少一个字段就把分享拒掉。
      // 缺了会存成 kty:'none'，访客查到它就直接拒绝连接（没有锚点可验，
      // 宁可不做），而不是连过去假装验证过。
      publicKey: (body.publicKey ?? { kty: 'none' }) as PublicKeyJwk,
      name: String(body.name),
      size: Number(body.size ?? 0),
      mime: String(body.mime ?? 'application/octet-stream'),
      state: 'available',
      createdAt: now,
      expiresAt,
    };
    this.sql.exec(
      `INSERT INTO shares (token, code, device_id, device_name, public_key, name, size, mime, state, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      record.token,
      record.code,
      record.deviceId,
      record.deviceName,
      JSON.stringify(record.publicKey),
      record.name,
      record.size,
      record.mime,
      record.state,
      record.createdAt,
      record.expiresAt,
    );
    return json(record, 201);
  }

  /**
   * 查一条分享，返回注册表里那条原始记录。
   *
   * 这里**不给状态**。状态有四个（可用、离线、已取消、已过期），后两个能从
   * state 和 expires_at 算出来，前一个只有在线状态板知道。合成放在 Worker，
   * 免得在这里存一份会过期的在线判断。
   */
  private getShare(token: string): Response {
    const row = this.row(token);
    if (!row) return json({ error: 'not-found' }, 404);
    return json(this.recordOf(row));
  }

  private revokeShare(token: string, deviceId: string, now: number): Response {
    const row = this.row(token);
    if (!row) return json({ error: 'not-found' }, 404);
    if (row.device_id !== deviceId) return json({ error: 'forbidden' }, 403);
    this.sql.exec(`UPDATE shares SET state = 'revoked' WHERE token = ?`, token);
    return json({ ok: true, token, revokedAt: now });
  }

  private listShares(deviceId: string, now: number): Response {
    const rows = this.sql
      .exec<ShareRow>(`SELECT * FROM shares WHERE device_id = ? ORDER BY created_at DESC`, deviceId)
      .toArray();
    return json(
      rows.map((r) => ({
        token: r.token,
        code: r.code ?? r.token.slice(-8),
        name: r.name,
        size: r.size,
        mime: r.mime,
        state: (r.state === 'revoked' ? 'revoked' : r.expires_at < now ? 'expired' : 'available') as
          | 'revoked'
          | 'expired'
          | 'available',
        createdAt: r.created_at,
        expiresAt: r.expires_at,
      })),
    );
  }

  /** 清掉过期条目。由定时任务或手动触发，Phase 1 只提供接口。 */
  private sweep(now: number): Response {
    const removed = this.sql.exec(
      `DELETE FROM shares WHERE expires_at < ? AND state != 'revoked'`,
      now,
    );
    return json({ ok: true, removed: removed.rowsWritten });
  }

  private row(id: string): ShareRow | undefined {
    return this.sql
      .exec<ShareRow>(`SELECT * FROM shares WHERE token = ? OR code = ?`, id, id)
      .toArray()[0];
  }

  private rowByCode(code: string): ShareRow | undefined {
    return this.sql.exec<ShareRow>(`SELECT * FROM shares WHERE code = ?`, code).toArray()[0];
  }

  private recordOf(row: ShareRow): ShareRecord {
    let publicKey: PublicKeyJwk = { kty: 'none' };
    if (row.public_key) {
      try {
        publicKey = JSON.parse(row.public_key) as PublicKeyJwk;
      } catch {
        /* 读不出来就留给访客那条链路去报错，不要在这里把整条分享判死 */
      }
    }
    return {
      token: row.token,
      code: row.code ?? row.token.slice(-8),
      deviceId: row.device_id,
      deviceName: row.device_name,
      publicKey,
      name: row.name,
      size: row.size,
      mime: row.mime,
      state: row.state === 'revoked' ? 'revoked' : 'available',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }
}
