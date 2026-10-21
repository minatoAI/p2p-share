/**
 * 两台"设备"的替身环境。
 *
 * 从 session.test.ts 里抽出来放在这里，是因为分享那条线要做的集成测试用的
 * 是同一套东西：两个真的 SessionManager，中间夹一个假的灯塔和假的点对点传输，
 * 走完 offer、answer、认证、传输。复制一份的话，两边会各自漂——
 * 会话层一改，忘记同步另一份，那测试就再也说明不了真实流程。
 *
 * 这里只有替身和组装，没有断言。测试用例仍然各写各的。
 */

import { WebCryptoIdentity } from '../../src/core/webcrypto';
import { CODE_DIGITS, CODE_TTL_MS } from '../../src/core/pairing';
import { SessionManager, type PresenceEntry, type SessionEvents } from '../../src/core/session';
import type { TransferHandlers } from '../../src/core/transfer';
import type {
  DeviceIdentity,
  PeerLink,
  PeerSession,
  PeerState,
  SessionOptions,
  SignalLink,
  SignalState,
  TransportPort,
} from '../../src/core/ports';
import type { PublicKeyJwk, SignalMessage } from '../../src/core/protocol';
import { MemorySink } from '../../src/adapters/memory/sink';
import { MemoryStore } from '../../src/adapters/memory/store';
import { memoryLinkPair } from '../../src/adapters/memory/link';

/* ==================================================== 假在线状态板 */

export class FakeSignal implements SignalLink {
  state: SignalState = 'open';
  private messages: Array<(m: SignalMessage) => void> = [];
  private states: Array<(s: SignalState) => void> = [];

  constructor(
    private readonly presence: FakePresence,
    readonly deviceId: string,
  ) {}

  send(msg: SignalMessage): void {
    this.presence.route(this.deviceId, msg);
  }

  onMessage(cb: (m: SignalMessage) => void): void {
    this.messages.push(cb);
  }

  onStateChange(cb: (s: SignalState) => void): void {
    this.states.push(cb);
  }

  /** 这份替身不会自己掉线，重连相关的东西只是满足接口 */
  onReconnect(): void {}

  reconnectNow(): void {}

  /** 测试用：把这条链路标成已连接，并通知监听者 */
  open(): void {
    this.state = 'open';
    for (const cb of this.states) cb('open');
  }

  close(): void {
    this.state = 'closed';
    this.presence.disconnect(this.deviceId);
  }

  deliver(msg: SignalMessage): void {
    for (const cb of this.messages) cb(msg);
  }
}

/** 只做四件事：按 to 转发、播报上下线、回应订阅、登记和查询配对码。设备号就是地址。 */
export class FakePresence {
  private readonly clients = new Map<string, FakeSignal>();
  private readonly watches = new Map<string, Set<string>>();
  private readonly codes = new Map<string, { deviceId: string; expiresAt: number }>();
  private readonly devices = new Map<string, { name: string; publicKey: PublicKeyJwk }>();
  /** 从这里开始发号，取模保证落在码长规定的位数里 */
  private nextCode = 482139;
  /** 测试用：让新发出来的码立刻过期 */
  expireCodes = false;
  /** 测试用：第一次查一个存在的码时故意回 miss，验证网页会自动重查一次 */
  missFirstLookupOnce = false;

  connect(deviceId: string, options: { open?: boolean } = {}): FakeSignal {
    const link = new FakeSignal(this, deviceId);
    if (options.open === false) link.state = 'closed';
    this.clients.set(deviceId, link);
    for (const [watcher, targets] of this.watches) {
      if (targets.has(deviceId)) {
        this.clients.get(watcher)?.deliver({ t: 'presence', id: deviceId, online: true });
      }
    }
    return link;
  }

  disconnect(deviceId: string): void {
    this.clients.delete(deviceId);
    for (const [watcher, targets] of this.watches) {
      if (targets.has(deviceId)) {
        this.clients.get(watcher)?.deliver({ t: 'presence', id: deviceId, online: false });
      }
    }
  }

  /** 谁现在在线，供测试断言 */
  online(): string[] {
    return [...this.clients.keys()];
  }

  route(from: string, msg: SignalMessage): void {
    if (msg.t === 'hello') {
      this.devices.set(from, { name: msg.name, publicKey: msg.publicKey });
      return;
    }
    if (msg.t === 'new-code') {
      const code = String(this.nextCode++ % 10 ** CODE_DIGITS).padStart(CODE_DIGITS, '0');
      const expiresAt = this.expireCodes ? Date.now() - 1000 : Date.now() + CODE_TTL_MS;
      this.codes.set(code, { deviceId: from, expiresAt });
      // 回给客户端的到期时间必须和这里存的一致，否则模拟出来的状态自相矛盾
      this.clients.get(from)?.deliver({ t: 'code', code, expiresAt });
      return;
    }
    if (msg.t === 'lookup-code') {
      const entry = this.codes.get(msg.code);
      const owner = entry ? this.devices.get(entry.deviceId) : undefined;
      const miss = (reason: string): void => {
        this.clients.get(from)?.deliver({ t: 'code-miss', code: msg.code, reason });
      };
      if (this.missFirstLookupOnce && entry && owner) {
        this.missFirstLookupOnce = false;
        return miss('没有这个码');
      }
      if (!entry || !owner) return miss('没有这个码');
      if (entry.expiresAt < Date.now()) return miss('这个码已经过期');
      this.clients.get(from)?.deliver({
        t: 'code-owner',
        code: msg.code,
        deviceId: entry.deviceId,
        name: owner.name,
        publicKey: owner.publicKey,
      });
      return;
    }
    if (msg.t === 'watch') {
      this.watches.set(from, new Set(msg.ids));
      this.clients.get(from)?.deliver({
        t: 'presence-list',
        entries: msg.ids.map((id) => ({ id, online: this.clients.has(id) })),
      });
      return;
    }
    if (msg.t === 'presence' || msg.t === 'presence-list') return;
    const to = (msg as { to?: string }).to;
    if (!to) return;
    const target = this.clients.get(to);
    if (!target) {
      this.clients.get(from)?.deliver({ t: 'error', code: 'peer-offline', message: '对方不在线' });
      return;
    }
    // from 由服务端填，客户端自称无效
    target.deliver({ ...msg, from } as SignalMessage);
  }
}

/* ==================================================== 假点对点传输 */

/** 会话的键：谁、连谁。按设备号索引会在"一台设备同时连多台"时错配。 */
const hubKey = (deviceId: string, peerId: string): string => `${deviceId}>${peerId}`;

export class FakeTransportHub {
  private readonly sessions = new Map<string, FakeSession>();
  private readonly links = new Map<string, PeerLink>();
  /** 测试用：这条设备收到的第一份 auth-challenge 会被丢掉 */
  dropFirstAuthChallengeAt: string | null = null;

  create(deviceId: string, opts: SessionOptions): FakeSession {
    const session = new FakeSession(deviceId, opts, this);
    this.sessions.set(hubKey(deviceId, opts.peerId), session);
    // 发起方一出场就产生 offer，走信令发给对端，和真实流程一致
    if (opts.initiator) queueMicrotask(() => session.emitSignal(sdp('offer')));
    // 两个方向都建好了才接得上。任何一侧后来才建，都在它自己的 create 里再试一次，
    // 所以这里两个方向都要试。
    queueMicrotask(() => {
      this.tryLink(deviceId, opts.peerId);
      this.tryLink(opts.peerId, deviceId);
    });
    return session;
  }

  /** 收到 offer 的那一侧，必须由**它自己那条会话**回 answer */
  onRemoteSignal(deviceId: string, peerId: string, msg: SignalMessage): void {
    if (msg.t === 'sdp' && msg.description.type === 'offer') {
      queueMicrotask(() => this.sessions.get(hubKey(deviceId, peerId))?.emitSignal(sdp('answer')));
    }
  }

  setLinkHandler(deviceId: string, cb: (link: PeerLink) => void): void {
    void deviceId;
    void cb;
  }

  /** 模拟链路断开 */
  dropAll(): void {
    for (const link of this.links.values()) {
      try {
        link.close();
      } catch {
        /* 已经断了 */
      }
    }
  }

  /**
   * 一条会话关掉了，就把它自己和这一对的链路一起撤掉。
   *
   * 留在表里会让下一条新会话跟这条死会话配对：两边都在等对方，
   * 而信令一条也不会再动，看不出是替身的问题。
   */
  retire(deviceId: string, peerId: string): void {
    this.sessions.delete(hubKey(deviceId, peerId));
    this.links.delete(hubKey(deviceId, peerId));
    this.links.delete(hubKey(peerId, deviceId));
  }

  /**
   * 按"谁连谁"配对，而不是按"前两个设备"。
   *
   * 早先这个替身是按设备号索引、只取前两个的，所以它只能模拟两台设备、
   * 每台一个会话；第三个设备永远拿不到链路，而"一台设备同时连多台"根本表达不了。
   */
  private tryLink(deviceId: string, peerId: string): void {
    const key = hubKey(deviceId, peerId);
    const otherKey = hubKey(peerId, deviceId);
    const mine = this.sessions.get(key);
    const other = this.sessions.get(otherKey);
    if (!mine || !other || this.links.has(key)) return;
    const [linkMine, linkOther] = memoryLinkPair();
    if (this.dropFirstAuthChallengeAt === deviceId) linkMine.dropNextAuthChallenge = true;
    if (this.dropFirstAuthChallengeAt === peerId) linkOther.dropNextAuthChallenge = true;
    this.links.set(key, linkMine);
    this.links.set(otherKey, linkOther);
    mine.setLink(linkMine);
    other.setLink(linkOther);
  }
}

function sdp(type: 'offer' | 'answer'): SignalMessage {
  return {
    t: 'sdp',
    from: '',
    to: '',
    description: { type, sdp: 'v=0\r\n' },
    sig: '',
  };
}

export class FakeSession implements PeerSession {
  private opts: SessionOptions;
  private linkHandler: ((link: PeerLink) => void) | null = null;
  private queuedLink: PeerLink | null = null;
  private link: PeerLink | null = null;
  private stateHandler: (s: PeerState) => void = () => {};

  constructor(
    readonly deviceId: string,
    opts: SessionOptions,
    private readonly hub: FakeTransportHub,
  ) {
    this.opts = opts;
  }

  async applySignal(msg: SignalMessage): Promise<void> {
    this.hub.onRemoteSignal(this.deviceId, this.opts.peerId, msg);
  }

  onLink(cb: (link: PeerLink) => void): void {
    this.linkHandler = cb;
    if (this.queuedLink) {
      const link = this.queuedLink;
      this.queuedLink = null;
      cb(link);
    }
  }

  onStateChange(cb: (s: PeerState) => void): void {
    this.stateHandler = cb;
  }

  close(): void {
    try {
      this.link?.close();
    } catch {
      /* 已经断了 */
    }
    // 撤掉这一对的链路，否则同一台设备重连时 links.has(key) 一直是真，
    // 新的两条会话永远配不到一起。
    this.hub.retire(this.deviceId, this.opts.peerId);
    this.stateHandler('closed');
  }

  emitSignal(msg: SignalMessage): void {
    this.opts.onSignal(msg);
  }

  /** hub 在建好链路之后调它 */
  setLink(link: PeerLink): void {
    this.link = link;
    if (this.linkHandler) this.linkHandler(link);
    else this.queuedLink = link;
  }
}

export class FakeTransport implements TransportPort {
  constructor(
    private readonly hub: FakeTransportHub,
    private readonly deviceId: string,
  ) {}

  createSession(opts: SessionOptions): PeerSession {
    return this.hub.create(this.deviceId, opts);
  }

  describeConfig(): { iceServerCount: number; hasTurn: boolean } {
    return { iceServerCount: 0, hasTurn: false };
  }
}

/* ==================================================== 组装 */

export async function makeDevice(name: string) {
  const crypto = await WebCryptoIdentity.generate();
  const deviceId = await crypto.deviceIdFromKey(crypto.publicKeyJwk);
  const identity: DeviceIdentity = {
    deviceId,
    publicKey: crypto.publicKeyJwk,
    canSign: true,
    sign: (d) => crypto.sign(d),
    verify: (k, d, s) => crypto.verify(k, d, s),
    digest: (d) => crypto.digest(d),
    deviceIdFromKey: (k) => crypto.deviceIdFromKey(k),
    fingerprint: (k) => crypto.fingerprint(k),
    randomBytes: (n) => crypto.randomBytes(n),
  };
  return { crypto, identity, deviceId, publicKey: crypto.publicKeyJwk, name };
}

export interface ClientEvents {
  logs: string[];
  /** 收到的文本。文本走 onText 交给界面显示，不经过落盘。 */
  texts: string[];
  contacts: unknown[][];
  presence: PresenceEntry[][];
  prompts: Array<{
    deviceId: string;
    name: string;
    sas: string;
    role: string;
    peerPlatform?: 'web' | 'native';
  }>;
  codes: string[];
  phases: string[];
  states: Array<{ state: string; peerId: string | null }>;
  errors: string[];
}

export function makeClient(
  device: Awaited<ReturnType<typeof makeDevice>>,
  presence: FakePresence,
  hub: FakeTransportHub,
  store: MemoryStore,
  /** 冒充场景下，可以指定在状态板上用哪个设备号上线 */
  presenceId?: string,
  /** 模拟灯塔连得慢：先建好链路但不打开 */
  deferSignal?: boolean,
  /** 覆盖连接超时，方便快速测超时 */
  connectTimeoutMs?: number,
  /**
   * 往传输回调和会话事件上接自己的东西。
   *
   * 分享那条线需要把 share-* 和传输状态转给 ShareHub，而 ShareHub 又反过来
   * 要 manager 当依赖，所以调用方传进来的是一对"以后再填"的引用。
   */
  hooks?: { transfer?: Partial<TransferHandlers>; events?: Partial<SessionEvents> },
) {
  const events: ClientEvents = {
    logs: [],
    texts: [],
    contacts: [],
    presence: [],
    prompts: [],
    codes: [],
    phases: [],
    states: [],
    errors: [],
  };
  const signal = presence.connect(presenceId ?? device.deviceId, { open: !deferSignal });
  const sink = new MemorySink();
  const manager = new SessionManager(
    {
      identity: device.identity,
      deviceName: device.name,
      signal,
      // 用**身份声称的**设备号建键，而不是 makeDevice 返回的真实设备号。
      // 冒充场景里这两者故意不同：管理器的身份是"我声称是谁"，
      // 对端那条会话引用的也是这个号，用真实号建键就配不上对。
      transport: new FakeTransport(hub, device.identity.deviceId),
      sink,
      store,
      transfer: { onText: (_id, text) => events.texts.push(text), ...hooks?.transfer },
      connectTimeoutMs,
    },
    {
      log: (l) => events.logs.push(l),
      contacts: (c) => events.contacts.push(c),
      presence: (p) => events.presence.push(p),
      pairingPrompt: (p) => {
        events.prompts.push(p as ClientEvents['prompts'][number]);
      },
      code: (code) => events.codes.push(code),
      phase: (_peerId, p) => events.phases.push(p),
      state: (state, peerId) => events.states.push({ state, peerId }),
      error: (m) => events.errors.push(m),
      ...hooks?.events,
    },
  );
  return { manager, events, signal, sink };
}

export const tick = async (times = 12) => {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
};

export async function waitFor(cond: () => boolean, label: string, timeout = 3000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`等待超时：${label}`);
}

/* ==================================================== 通用流程 */

/** 走一遍完整的配对：A 报码，B 输码，A 确认。 */
export async function pairViaCode(
  clientA: ReturnType<typeof makeClient>,
  clientB: ReturnType<typeof makeClient>,
) {
  clientA.manager.startAdvertising();
  await waitFor(() => clientA.events.codes.length > 0, 'A 拿到配对码');
  const code = clientA.events.codes[clientA.events.codes.length - 1]!;
  await clientB.manager.joinWithCode(code);
  await waitFor(() => clientA.events.prompts.length === 1, 'A 收到配对请求');
  return { code, promptA: clientA.events.prompts[0]!, promptB: clientB.events.prompts[0]! };
}
