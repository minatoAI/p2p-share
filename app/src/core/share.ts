/**
 * 公开链接分享：一条链接，一次只服务一个人。
 *
 * 这一层解决的是"资格、名额"，连接本身仍归 session.ts 管。
 * 分成两层的原因是测试：想验名额就必须有两条真实连接，想验连接不该被迫
 * 先造一条分享。
 *
 * 三个和配对那条路不一样的地方，都是有意为之：
 *
 *   1. **不配对，也不核对六位数字。** 准入凭据退化成"持有链接"，
 *      见 docs/11 第 5 节那张四行表。访客本来就是匿名的，没有东西可以核对。
 *   2. **公钥的锚点换了一个来源。** 配对时锚点是人眼核对的数字，这里换成
 *      注册表那条 HTTPS 响应：访客拿它验分享者，灯塔换公钥就会验签失败。
 *      反方向（分享者验访客）没有锚点可用，只验"设备号确实由这把公钥推导"，
 *      这是自洽检查，不是认证，公开分享要的就是这个程度。
 *   3. **永远是分享者发 offer。** 配对那边由设备号大小决定谁建通道，
 *      因为两边是对等的。这里两边不对等：名额在分享者手里，
 *      让一半访客来发起只会多出一套状态。这条规则不碰 ownsChannel。
 *
 * 网页端为什么停在单对单：一条链接同时只喂一个访客，第二个直接被告知
 * "当前有人正在取"，不排队。排队是把"一对一"稀释成"串行的一对多"，
 * 而网页端本来就没有做种能力，多源那块归原生端，见 docs/14 第 4 节。
 * 为什么队列配一个名额不如直接拒绝，写在 docs/20 第 3 节。
 */

import type { DeviceIdentity, RegistryPort } from './ports';
import type { PublicKeyJwk, ShareSignal, ShareStatus, SignalMessage } from './protocol';
import type { Direction, FileLike, TransferUpdate } from './transfer';
import type { SharePeer } from './session';

/** 一条链接同时服务的访客数。网页端就一个，多了不接。 */
export const MAX_CONCURRENT_VISITORS = 1;
/** 一条分享的默认有效期。注册表那边也是这个数，两边不一致会让界面说谎。 */
export const DEFAULT_SHARE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 访客停在"对方离线"上时，每隔多久重查一次注册表。
 *
 * 离线不是失败：分享者重新上线之后，注册表会把同一条链接的状态从 offline
 * 合成 available。之前这一层在离线态直接 return，页面只能等用户自己刷新，
 * 见 docs/35 的 WEB-1。重查本身只读注册表，不碰信令，代价很小。
 */
export const OFFLINE_RECHECK_INTERVAL_MS = 10_000;
/**
 * 自动重查最多持续多久。
 *
 * 60 秒是工单里定下的值：够覆盖"分享者正好切回页面"这一档，又不至于让一个
 * 已经没人管的标签页整夜每十秒打一次注册表。窗口走完之后「重试」按钮仍然可用，
 * 只是不再自动查。
 */
export const OFFLINE_RECHECK_WINDOW_MS = 60_000;

/* ------------------------------------------------------------ 链接 */

/**
 * 分享链接。token 放在 hash 里，不放查询串。
 *
 * 这不是为了好看：hash 不会发给服务器，也进不了 Pages 的访问日志和 Referer。
 * 一条公开链接的 token 就是它的准入凭据，能少露一面就少露一面。
 * 和配对链接 `#c=` 同一个形状，界面上两种链接一眼能分清。
 */
export function shareLink(origin: string, token: string): string {
  return `${origin}/#s=${token}`;
}

/**
 * 从输入里取出分享 token。
 *
 * 收三种：整条链接、`#s=` 后面那一段、直接粘的 32 位十六进制。
 * 只认十六进制并且必须满 32 位，免得把配对码或者别的东西当成 token。
 */
export function parseShareToken(text: string): string | null {
  const raw = (text ?? '').trim();
  if (!raw) return null;
  const fromHash = /[#&?]s=([0-9a-f]{32})/i.exec(raw)?.[1];
  if (fromHash) return fromHash.toLowerCase();
  if (/^[0-9a-f]{32}$/i.test(raw)) return raw.toLowerCase();
  return null;
}

/* ------------------------------------------------------------ 状态 */

export type VisitorPhase = 'connecting' | 'sending' | 'done' | 'left' | 'failed';

/** 分享者界面上一个访客一行 */
export interface VisitorInfo {
  deviceId: string;
  name: string;
  phase: VisitorPhase;
  note?: string;
}

/** 我挂出去的一条分享 */
export interface OutgoingShare {
  token: string;
  link: string;
  name: string;
  size: number;
  mime: string;
  createdAt: number;
  expiresAt: number;
  visitors: VisitorInfo[];
}

export type VisitPhase =
  | 'idle'
  | 'checking'
  | 'connecting'
  | 'downloading'
  | 'done'
  /** 三态里的那一态：分享者暂时离线，回来就能连 */
  | 'offline'
  | 'revoked'
  | 'expired'
  /** 分享者这一页已经不认得这个 token 了，多半是它刷新过 */
  | 'not-here'
  | 'not-found'
  /** 当前不是安全上下文，签不了名，认证做不了 */
  | 'needs-https'
  /** 注册表里没有公钥，或者公钥推导不出那个设备号。这种情况下不敢连 */
  | 'unanchored'
  /** 这一条链接正在喂别人。网页端一次只服务一个人，不排队 */
  | 'busy'
  | 'failed';

/** 访客侧那台设备看到的东西 */
export interface VisitState {
  token: string;
  phase: VisitPhase;
  name?: string;
  size?: number;
  mime?: string;
  deviceName?: string;
  /** 下载进度，0 到 1 */
  progress?: number;
  note?: string;
}

interface TrackedVisitor {
  deviceId: string;
  name: string;
  publicKey: PublicKeyJwk;
  phase: VisitorPhase;
  note?: string;
}

interface LocalShare {
  token: string;
  name: string;
  size: number;
  mime: string;
  createdAt: number;
  expiresAt: number;
  file: FileLike;
  visitors: Map<string, TrackedVisitor>;
}

/**
 * 这一层只用到会话层的五个动作。
 *
 * 写成接口而不是直接依赖 SessionManager 那个类，是为了能单独测名额：
 * 验"第二个访客会不会被挡在外面"，不需要先把 2 条真实的 WebRTC 连接打出来。
 * SessionManager 本来就满足这个形状，所以不需要任何适配代码。
 */
export interface ShareSessions {
  registerSharePeer(peerId: string, share: SharePeer): void;
  serveSharePeer(peerId: string): Promise<void>;
  closeSharePeer(peerId: string, reason: string): void;
  sendFile(peerId: string, file: FileLike): Promise<string>;
  sendSignal(msg: SignalMessage): void;
}

export interface ShareHubDeps {
  identity: DeviceIdentity;
  registry: RegistryPort;
  manager: ShareSessions;
  /** 设备名可以改，所以取的时候再读，不在构造时抓一份快照 */
  deviceName(): string;
  /**
   * 链接要指向哪一个站点。必须由调用方给，这里不留默认值：
   * 猜错一次的后果是链接指向另一台服务器， token 在那边根本不存在，
   * 点开的人只会看到"找不到这个分享"，而分享者以为一切正常。
   */
  origin: string;
}

export interface ShareHubEvents {
  log?(line: string): void;
  /** 我挂出去的那些分享变了 */
  shares?(list: OutgoingShare[]): void;
  /** 我作为访客看到的那些变了 */
  visit?(state: VisitState | null): void;
}

export class ShareHub {
  private readonly outgoing = new Map<string, LocalShare>();
  private visitState: VisitState | null = null;
  /** 访客正在下载的那个对端（也就是分享者）的设备号 */
  private visiting: { peerId: string; token: string } | null = null;
  /** 离线自动重查的定时器；null 表示现在没有排队的重查 */
  private offlineTimer: ReturnType<typeof setTimeout> | null = null;
  /** 自动重查窗口的起点，0 表示还没进过离线态 */
  private offlineRetryStartedAt = 0;

  constructor(
    private readonly deps: ShareHubDeps,
    private readonly events: ShareHubEvents,
  ) {}

  /* ---------------------------------------------------------- 分享者 */

  /**
   * 挂出一条分享。
   *
   * 顺序是先问注册表要 token，再进本地表。反过来会出现"链接已经发出去了，
   * 但注册表里没有这条"的窗口，访客打开只看到 not-found。
   */
  async createShare(file: FileLike, ttlMs = DEFAULT_SHARE_TTL_MS): Promise<OutgoingShare> {
    const now = Date.now();
    const created = await this.deps.registry.create({
      deviceId: this.deps.identity.deviceId,
      deviceName: this.deps.deviceName(),
      publicKey: this.deps.identity.publicKey,
      name: file.name,
      size: file.size,
      mime: file.type,
      ttlMs,
    });
    this.outgoing.set(created.token, {
      token: created.token,
      name: file.name,
      size: file.size,
      mime: file.type,
      createdAt: now,
      expiresAt: created.expiresAt,
      file,
      visitors: new Map(),
    });
    this.events.log?.(`已挂出分享：${file.name}，${Math.round(ttlMs / 3_600_000)} 小时内有效`);
    this.emitShares();
    return this.viewOf(created.token)!;
  }

  /** 撤销。注册表先改，再逐个通知还在用的访客。 */
  async revoke(token: string, notify = true): Promise<void> {
    const share = this.outgoing.get(token);
    this.outgoing.delete(token);
    try {
      await this.deps.registry.revoke({ token, deviceId: this.deps.identity.deviceId });
    } catch (err) {
      this.events.log?.(
        `⚠ 撤销没成功：${err instanceof Error ? err.message : String(err)}。这条链接先从这个页面去掉了。`,
      );
    }
    if (share && notify) {
      for (const v of share.visitors.values()) {
        if (v.phase === 'done' || v.phase === 'left') continue;
        this.deps.manager.sendSignal({
          t: 'share-revoked',
          from: this.deps.identity.deviceId,
          to: v.deviceId,
          token,
          reason: 'revoked',
        });
        this.deps.manager.closeSharePeer(v.deviceId, '分享已撤销');
      }
    }
    this.events.log?.(`已撤销分享：${share?.name ?? token}`);
    this.emitShares();
  }

  /**
   * 页面要走之前把还挂着的链接撤销掉。
   *
   * 必须显式做这一件事，因为身份现在只活在内存里：一刷新设备号就换了，
   * 注册表那一行绑的是旧设备号，新页面再也拿不到撤销它的凭据。
   * 不做的话，那条链接会在注册表里挂着二十几小时的"对方暂时离线"。
   *
   * 这里只清本地并发起请求，不通知访客：页面正在被拆，信令链路马上也断，
   * 访客那一侧会从传输状态或灯塔连接关闭上看到结果。
   */
  revokeAllForUnload(): string[] {
    const tokens = [...this.outgoing.keys()];
    this.outgoing.clear();
    this.emitShares();
    return tokens;
  }

  listOutgoing(): OutgoingShare[] {
    return [...this.outgoing.keys()].map((t) => this.viewOf(t)!);
  }

  private viewOf(token: string): OutgoingShare | undefined {
    const share = this.outgoing.get(token);
    if (!share) return undefined;
    return {
      token: share.token,
      link: shareLink(this.deps.origin, share.token),
      name: share.name,
      size: share.size,
      mime: share.mime,
      createdAt: share.createdAt,
      expiresAt: share.expiresAt,
      visitors: [...share.visitors.values()].map((v) => ({
        deviceId: v.deviceId,
        name: v.name,
        phase: v.phase,
        ...(v.note ? { note: v.note } : {}),
      })),
    };
  }

  private emitShares(): void {
    this.events.shares?.(this.listOutgoing());
  }

  /* ---------------------------------------------------------- 访客请求的处理 */

  /**
   * 会话层把 share-* 原样送到这里。
   *
   * 灯塔不参与判断资格，所以每一条都要在这里重新检查一遍，
   * 不能假定"能到这儿就说明灯塔放行过了"。
   */
  async onSignal(msg: ShareSignal): Promise<void> {
    if (msg.t === 'share-connect') return this.onVisitorConnect(msg);
    if (msg.to !== this.deps.identity.deviceId) return;
    if (msg.t === 'share-revoked') return this.onToldRevoked(msg.token, msg.reason);
    if (msg.t === 'share-leave') return this.onVisitorLeft(msg.token, msg.from);
  }

  private async onVisitorConnect(
    msg: Extract<ShareSignal, { t: 'share-connect' }>,
  ): Promise<void> {
    const refuse = (reason: 'revoked' | 'expired' | 'not-here' | 'busy'): void => {
      this.deps.manager.sendSignal({
        t: 'share-revoked',
        from: this.deps.identity.deviceId,
        to: msg.from,
        token: msg.token,
        reason,
      });
    };
    const share = this.outgoing.get(msg.token);
    if (!share) return refuse('not-here');
    if (share.expiresAt < Date.now()) return refuse('expired');

    // 设备号必须由公钥推导。这一条挡不住匿名访客冒充彼此（公开分享本来
    // 也不认访客的身份），但挡住了灯塔或者中间人塞进来一个自称某设备号的请求。
    const derived = await this.deps.identity.deviceIdFromKey(msg.publicKey);
    if (derived !== msg.from) {
      this.events.log?.(`⚠ 拒绝一个访客：它的设备号和送来的公钥对不上`);
      return;
    }

    // 同一个人重复点"取件"会再发一条 share-connect。已经在给它发了就忽略，
    // 不能把它自己顶掉。
    const active = share.visitors.get(msg.from);
    if (active && (active.phase === 'connecting' || active.phase === 'sending')) return;

    // 一次只服务一个人，第二个人直接被告知当前有人在取，不排队。
    // 排队等于把"一对一"稀释成"串行的一对多"：后来的人要等未知的时长，
    // 而网页端没有做种能力，多源那块归原生端，见 docs/14 第 4 节。
    //
    // 这一判断必须在把新访客写进表之前：activeOf 数的是 connecting 和 sending，
    // 先进表再判断，这个人会把自己算成占用者，然后被自己挡住。
    if (this.activeOf(share) >= MAX_CONCURRENT_VISITORS) {
      this.events.log?.(`正给别的访客发文件，挡住一个：${msg.name}`);
      return refuse('busy');
    }

    const visitor: TrackedVisitor = active ?? {
      deviceId: msg.from,
      name: msg.name,
      publicKey: msg.publicKey,
      phase: 'connecting',
    };
    visitor.name = msg.name;
    visitor.publicKey = msg.publicKey;
    share.visitors.set(msg.from, visitor);
    this.events.log?.(`有访客来取件：${msg.name}`);
    await this.serve(share, visitor);
  }

  /** 建通道、认证、把文件交给这个对端的引擎。 */
  private async serve(share: LocalShare, visitor: TrackedVisitor): Promise<void> {
    visitor.phase = 'connecting';
    this.emitShares();
    try {
      this.deps.manager.registerSharePeer(visitor.deviceId, {
        token: share.token,
        role: 'seeder',
        peerKey: visitor.publicKey,
        peerName: visitor.name,
      });
      await this.deps.manager.serveSharePeer(visitor.deviceId);
      visitor.phase = 'sending';
      this.emitShares();
      await this.deps.manager.sendFile(visitor.deviceId, share.file);
    } catch (err) {
      visitor.phase = 'failed';
      visitor.note = err instanceof Error ? err.message : String(err);
      this.events.log?.(`⚠ 给 ${visitor.name} 发送失败：${visitor.note}`);
      this.deps.manager.closeSharePeer(visitor.deviceId, '这个访客失败了');
    }
    this.emitShares();
  }

  /** 正在占着这条链接的访客数。名额只有一个，所以这里只可能是 0 或 1。 */
  private activeOf(share: LocalShare): number {
    let n = 0;
    for (const v of share.visitors.values()) {
      if (v.phase === 'connecting' || v.phase === 'sending') n += 1;
    }
    return n;
  }

  private onVisitorLeft(token: string, deviceId: string): void {
    const share = this.outgoing.get(token);
    const visitor = share?.visitors.get(deviceId);
    if (!share || !visitor) return;
    visitor.phase = 'left';
    this.deps.manager.closeSharePeer(deviceId, '访客离开了');
    this.events.log?.(`${visitor.name} 离开了`);
  }

  /* ---------------------------------------------------------- 传输回调 */

  /**
   * 界面把每一条传输状态转过来。
   *
   * 引擎那边只认传输 id，不认设备号，所以要靠 createShare 时记下的这张表
   * 把两者对上。分享者这边用它确认这一条链接空出来了，访客这边用它显示进度。
   */
  onTransferStatus(u: TransferUpdate): void {
    const visitor = u.peerId ? this.visitorOf(u.peerId) : null;
    if (visitor) {
      if (u.status === 'done') {
        visitor.phase = 'done';
        this.events.log?.(`${visitor.name} 取件完成`);
        this.deps.manager.closeSharePeer(visitor.deviceId, '传完了');
      } else if (u.status === 'error') {
        visitor.phase = 'failed';
        visitor.note = u.message ?? '传输失败';
        this.deps.manager.closeSharePeer(visitor.deviceId, visitor.note);
      }
      this.emitShares();
    }

    if (this.visiting && u.peerId === this.visiting.peerId) {
      if (u.status === 'done') this.setVisit({ phase: 'done' });
      else if (u.status === 'error')
        this.setVisit({ phase: 'failed', note: u.message ?? '传输失败' });
      else if (u.status === 'active' && this.visitState?.phase !== 'downloading')
        this.setVisit({ phase: 'downloading' });
    }
  }

  /**
   * 访客侧的进度。方向必须是"收"，而且必须来自我正在取件的那台设备。
   *
   * 分享者这一侧用不着它：那边每个访客的状态由 onTransferStatus 里的
   * done 和 error 驱动，进度条交给传输记录。
   */
  onProgress(direction: Direction, transferred: number, size: number): void {
    if (direction !== 'in' || !this.visiting || !this.visitState) return;
    this.setVisit({
      phase: this.visitState.phase,
      progress: size > 0 ? transferred / size : 1,
    });
  }

  private visitorOf(deviceId: string): TrackedVisitor | null {
    for (const share of this.outgoing.values()) {
      const visitor = share.visitors.get(deviceId);
      if (visitor) return visitor;
    }
    return null;
  }

  /* ---------------------------------------------------------- 访客侧 */

  currentVisit(): VisitState | null {
    return this.visitState;
  }

  /** 页面卸载时停掉还在排队的重查，别让定时器拖着一个已经拆掉的页面 */
  dispose(): void {
    this.stopOfflineTimer();
  }

  /**
   * 手动重试。
   *
   * 只在"对方离线"上做：撤销、到期这类重查也不会变，连上了就更不需要。
   * 点一次会重新给满 60 秒窗口，然后立刻查一遍，不用等下一个十秒。
   */
  async retryVisit(): Promise<void> {
    const state = this.visitState;
    if (!state || state.phase !== 'offline') return;
    this.stopOfflineTimer();
    this.offlineRetryStartedAt = 0;
    await this.lookup(state.token);
  }

  private setVisit(patch: Partial<VisitState> & { phase: VisitPhase }): void {
    const base = this.visitState ?? { token: patch.token ?? '' };
    this.visitState = { ...base, ...patch, token: patch.token ?? base.token };
    this.events.visit?.(this.visitState);
  }

  /**
   * 访客点开链接之后的一步。
   *
   * 顺序不能换：先问注册表拿公钥并验推导，再发 share-connect。
   * 反过来做的话，灯塔可以把 offer 送到任何一个它想送的设备号上，
   * 而我这边已经没有第二次机会判断"这条连接到底是不是那个分享者的"。
   */
  async visit(token: string): Promise<void> {
    const clean = parseShareToken(token);
    if (!clean) {
      this.stopOfflineTimer();
      this.setVisit({ token, phase: 'not-found', note: '这条链接里没有有效的分享编号' });
      return;
    }
    // 换一条链接就从头开始。setVisit 是往上叠的，不清空的话上一条的名字、
    // 进度和备注会跟着过来，界面看着像在说这一条。
    this.stopOfflineTimer();
    this.offlineRetryStartedAt = 0;
    this.visitState = null;
    this.setVisit({ token: clean, phase: 'checking' });
    await this.lookup(clean);
  }

  /**
   * 查一次注册表，再决定下一步。
   *
   * 首次访问、自动重查、手动重试都走这里。区别只在调用前有没有把界面切到
   * checking：重查不切，离线态就不会每十秒闪一下"正在问"。
   */
  private async lookup(clean: string): Promise<void> {
    // 这一次查询本身就取代了之前排着的那一次，查完还是离线会重新排
    this.stopOfflineTimer();
    let found: ShareStatus | undefined;
    try {
      found = await this.deps.registry.status(clean);
    } catch (err) {
      this.setVisit({
        token: clean,
        phase: 'failed',
        note: `问不到这条分享：${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }
    if (!found) {
      this.setVisit({ token: clean, phase: 'not-found' });
      return;
    }
    const meta = {
      name: found.name,
      size: found.size,
      mime: found.mime,
      deviceName: found.deviceName,
    };
    if (found.status === 'revoked') return this.setVisit({ token: clean, phase: 'revoked', ...meta });
    if (found.status === 'expired')
      return this.setVisit({ token: clean, phase: 'expired', ...meta });
    // 三态里最该留人的一态：不报错也不走，同时排自动重查。
    // 之前这里直接 return，于是分享者重新上线之后这一页也不会自己恢复。
    if (found.status === 'offline') {
      this.setVisit({ token: clean, phase: 'offline', ...meta });
      this.scheduleOfflineRetry(clean);
      return;
    }

    if (!this.deps.identity.canSign) {
      return this.setVisit({
        token: clean,
        phase: 'needs-https',
        ...meta,
        note: '当前不是安全上下文，签不了名，认证做不了',
      });
    }
    const key = found.publicKey;
    if (!key || key.kty === 'none') {
      // 注册表里没有公钥就没有锚点。这时候连过去，我无从验证对面是谁，
      // 而公开分享的访客本来就没有别的核对手段。宁可不做，不要假装做了。
      return this.setVisit({
        token: clean,
        phase: 'unanchored',
        ...meta,
        note: '这条分享没有登记公钥，无法验证对方身份',
      });
    }
    const derived = await this.deps.identity.deviceIdFromKey(key);
    if (derived !== found.deviceId) {
      return this.setVisit({
        token: clean,
        phase: 'unanchored',
        ...meta,
        note: '注册表里的公钥推导不出它的设备号，可能有人在中间',
      });
    }

    this.visiting = { peerId: found.deviceId, token: clean };
    this.deps.manager.registerSharePeer(found.deviceId, {
      token: clean,
      role: 'visitor',
      peerKey: key,
      peerName: found.deviceName,
    });
    this.deps.manager.sendSignal({
      t: 'share-connect',
      from: this.deps.identity.deviceId,
      to: found.deviceId,
      token: clean,
      name: this.deps.deviceName(),
      publicKey: this.deps.identity.publicKey,
    });
    this.setVisit({ token: clean, phase: 'connecting', ...meta });
  }

  /** 排下一次自动重查；60 秒窗口走完就不再排 */
  private scheduleOfflineRetry(token: string): void {
    if (this.offlineRetryStartedAt === 0) this.offlineRetryStartedAt = Date.now();
    if (Date.now() - this.offlineRetryStartedAt >= OFFLINE_RECHECK_WINDOW_MS) {
      this.stopOfflineTimer();
      return;
    }
    // 已经有一次在排队了，不要叠第二条
    if (this.offlineTimer !== null) return;
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = null;
      void this.recheckOffline(token);
    }, OFFLINE_RECHECK_INTERVAL_MS);
  }

  private async recheckOffline(token: string): Promise<void> {
    // 这十秒里可能换了链接、点了重试，或者已经被撤销
    if (this.visitState?.phase !== 'offline' || this.visitState.token !== token) return;
    await this.lookup(token);
  }

  private stopOfflineTimer(): void {
    if (this.offlineTimer === null) return;
    clearTimeout(this.offlineTimer);
    this.offlineTimer = null;
  }

  private onToldRevoked(token: string, reason: 'revoked' | 'expired' | 'not-here' | 'busy'): void {
    this.stopOfflineTimer();
    if (this.visitState?.token !== token) return;
    if (this.visiting?.token === token) {
      this.deps.manager.closeSharePeer(this.visiting.peerId, '对方不再服务这条分享');
      this.visiting = null;
    }
    this.setVisit({ token, phase: reason });
  }

  /** 访客主动取消。要通知对方，不然它以为这条链接还被自己占着。 */
  leave(): void {
    this.stopOfflineTimer();
    const state = this.visitState;
    const visiting = this.visiting;
    if (!state || !visiting) return;
    this.deps.manager.sendSignal({
      t: 'share-leave',
      from: this.deps.identity.deviceId,
      to: visiting.peerId,
      token: state.token,
    });
    this.deps.manager.closeSharePeer(visiting.peerId, '访客取消');
    this.visiting = null;
    this.setVisit({ token: state.token, phase: 'idle', note: '已取消' });
  }
}
