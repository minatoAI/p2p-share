/**
 * 会话管理器：把"配对一次，之后免配对"这套流程串起来。
 *
 * 它对外只有几个动作：开始、生成邀请、接受邀请、确认配对、连接、发送。
 * 内部的顺序是固定的：
 *
 *   1. 连上在线状态板，声明自己是谁，订阅所有已配对设备的在线状态；
 *   2. 首次配对：一端生成邀请（二维码），另一端请求配对，双方核对六位数字，
 *      各自把对方的公钥写进本地通讯录；
 *   3. 之后每次连接：按设备号寻址，建立数据通道；
 *   4. **认证在数据通道上做**，不在信令上做。一次性随机串是在已经过 DTLS
 *      加密的通道里交换的，能正确应答的人必然就是这条链路的另一端。
 *      认证通过之前，传输引擎根本不接管这条链路。
 *
 * 服务器在整个过程中看不到配对关系，也不参与认证。它只知道"A 给 B 发了消息"。
 */

import type {
  ContactRecord,
  DeviceIdentity,
  PeerLink,
  PeerSession,
  SignalLink,
  SignalState,
  SinkPort,
  StorePort,
  TransportPort,
} from './ports';
import type {
  ControlMessage,
  PeerPlatform,
  PublicKeyJwk,
  ShareSignal,
  SignalMessage,
} from './protocol';
import { decodeControl, encodeControl } from './protocol';
import {
  AddressBook,
  buildResponse,
  CODE_DIGITS,
  CODE_ROTATE_MS,
  createContact,
  fromBase64Url,
  MAX_CODES_PER_DEVICE,
  newChallenge,
  normalizeCode,
  shortAuthenticationString,
  toBase64Url,
  verifyResponse,
  type ChallengeContext,
} from './pairing';
import { createTransferIdFactory } from './ids';
import { TransferEngine, type FileLike, type TransferHandlers } from './transfer';

/** 设备之间连不上的判定时间。超过就明确报错，不再无限等。 */
export const CONNECT_TIMEOUT_MS = 20_000;

/**
 * 认证挑战的重发间隔和次数。
 *
 * 数据通道刚打开时，对端（尤其是 Kotlin/JNI 那一侧）可能还没挂好消息处理函数，
 * 第一条 auth-challenge 会被丢掉；只靠 queueMicrotask 让一个微任务不够。
 * 这里最多补发两次，收到 auth-response 或连接就绪后自动停止。
 */
const AUTH_RETRY_MS = 800;
const AUTH_RETRY_MAX = 2;

export type SessionState = 'idle' | 'connecting' | 'authenticating' | 'ready' | 'failed';

/**
 * 连接阶段。分得比 SessionState 细，是为了让用户看见"卡在哪一步"。
 * signaling 是交换 SDP，ice 是打通网络路径，auth 是互相验证身份。
 */
export type ConnectPhase = 'signaling' | 'ice' | 'auth' | 'ready' | 'failed';

/** 阶段顺序，界面拿它算进度 */
export const CONNECT_PHASES: ConnectPhase[] = ['signaling', 'ice', 'auth', 'ready'];

export interface PresenceEntry {
  id: string;
  online: boolean;
  name?: string;
}

export interface PairingPrompt {
  deviceId: string;
  name: string;
  /** 六位短认证串，两边显示的数字必须一致 */
  sas: string;
  /** inviter 需要用户点确认；joiner 只是展示出来供核对 */
  role: 'inviter' | 'joiner';
  /** 对端是网页端还是原生端；输码方在对方回应前还拿不到 */
  peerPlatform?: PeerPlatform;
}

export interface SessionDeps {
  identity: DeviceIdentity;
  deviceName: string;
  signal: SignalLink;
  transport: TransportPort;
  sink: SinkPort;
  store: StorePort;
  transfer: TransferHandlers;
  /** 设备之间连不上的判定时间。测试里调小，平时用默认值。 */
  connectTimeoutMs?: number;
}

export interface SessionEvents {
  log?(line: string): void;
  contacts?(list: ContactRecord[]): void;
  presence?(entries: PresenceEntry[]): void;
  pairingPrompt?(prompt: PairingPrompt): void;
  pairingDone?(peerId: string): void;
  /** 我的配对码，界面上大字显示它。到点会自动换一个新的。 */
  code?(code: string, expiresAt: number): void;
  /** 码作废了（配对成功、或者停止报码） */
  codeCleared?(): void;
  /** 试错太多次，到这个时间点之前别再试。界面据此把输入框锁住并倒计时。 */
  codeCooldown?(until: number): void;
  state?(state: SessionState, peerId: string | null): void;
  /** 灯塔这条长连接的状态 */
  signal?(state: SignalState): void;
  /**
   * 连接走到了哪一步。界面靠它显示进度，让用户知道系统在动。
   * signaling → ice → auth → ready，失败时是 failed。
   */
  phase?(peerId: string, phase: ConnectPhase): void;
  /** 认证通过、链路可用。界面可以借它读路径和分片大小。 */
  link?(peerId: string, link: PeerLink): void;
  /**
   * 公开分享那几条信令。会话管理器不解释它们，一律转出去。
   *
   * 为什么不在这里处理：token 认不认、这条链接当前是不是正在给别人发，
   * 是分享的业务规则，而这一层管的是"一台设备的连接生命周期"。混进来的话，
   * 测试要建一条分享才能测连接，反过来也一样。
   */
  shareSignal?(msg: ShareSignal): void;
  error?(message: string): void;
}

/**
 * 一条公开分享登记下来的对端。
 *
 * 有了这个才算"公开分享的对端"。它的公钥不来自通讯录，role 决定谁建通道。
 */
export interface SharePeer {
  token: string;
  /** 我是这条分享的挂出方，还是点开链接的那一侧 */
  role: 'seeder' | 'visitor';
  /**
   * 对方的公钥。
   *
   * seeder 这份来自 share-connect，先验过"设备号确实由这把公钥推导"；
   * visitor 这份来自注册表那条 HTTPS 响应，同样验过推导。
   * 两个来源都不需要配对，也不需要人工核对六位数字，所以认证降级成
   * "验签而不是验锚点"：签名只对这把公钥成立，而这把公钥是不是真的那台设备，
   * seeder 侧无从判断（访客本来就是匿名的），visitor 侧由 HTTPS 那条响应保证。
   */
  peerKey: PublicKeyJwk;
  peerName: string;
}

/**
 * 一个对端的连接。
 *
 * 每个对端一套：会话、链路、认证状态、等待者、世代号，以及**各自的传输引擎**。
 * 引擎必须按对端分开，因为 `TransferEngine` 内部只认一条链路；共用一个引擎的话，
 * 即便会话表建好了，它也只会往最后接管的那条链路上发。
 */
interface Conn {
  readonly peerId: string;
  session: PeerSession | null;
  link: PeerLink | null;
  engine: TransferEngine;
  myChallenge: ChallengeContext | null;
  peerVerifiedMe: boolean;
  iVerifiedPeer: boolean;
  waiters: Array<{ resolve: () => void; reject: (err: Error) => void }>;
  state: SessionState;
  /** 这个对端自己的连接世代，用来识别旧链路的迟到回调 */
  generation: number;
  /** 连接超时的定时器 */
  timer: ReturnType<typeof setTimeout> | null;
  /** 有这一项就是公开分享的对端：没有通讯录记录，公钥另有一个来源 */
  share: SharePeer | null;
}

export class SessionManager {
  private readonly book: AddressBook;
  private readonly presenceState = new Map<string, PresenceEntry>();
  /** 我发出去的配对码，值是它在服务器上的到期时间。换码时会有两三条同时有效。 */
  private readonly issuedCodes = new Map<string, number>();
  private advertising = false;
  private rotateTimer: ReturnType<typeof setInterval> | null = null;

  private outgoingPairing: {
    peerId: string;
    name: string;
    publicKey: PublicKeyJwk;
    platform?: PeerPlatform;
  } | null = null;
  /** 等对方确认配对的超时。对方页面关掉、或者人走开了，请求不能永远挂着。 */
  private pairWaitTimer: ReturnType<typeof setTimeout> | null = null;
  /** 从声音里收到的那台设备的公钥指纹前 8 位。有它就说明这次配对有一条带外信道。 */
  private audioFingerprint: string | null = null;
  /**
   * 这次配对是靠声音里的指纹验过的。
   * 验过之后就不再弹六位数字：用户已经用耳朵完成了带外核对。
   */
  private audioVerified = false;
  /** 正在往外播的时候为 true：谁来连都直接接受，不再弹六位数字让人点。 */
  private autoAccept = false;
  /** 我正在用哪个码去连别人，用来对上服务器的回话 */
  private outgoingCode: string | null = null;
  /**
   * 码刚轮换、查询落空时自动重查一次。
   *
   * 服务器会保留最近两条码，但网页输入和服务器轮换仍可能撞在同一个瞬间。
   * 这里只对同一个码重查一次，服务端对 1.5 秒内同码重复查询不再记 miss；
   * 仍然查不到就把错误交给用户，不会无限重试。
   */
  private codeRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private codeRetried: string | null = null;
  private incomingPairing: {
    from: string;
    name: string;
    publicKey: PublicKeyJwk;
    code: string;
    platform?: PeerPlatform;
  } | null = null;

  /**
   * 每个对端一条连接，键是设备号。
   *
   * 早先只有一个 `session` 字段，所以同一时刻只能和一个对端连着：换设备时
   * 旧链路还在异步关闭，新连接就要在它的残局里建立，来回切换就不可靠了。
   */
  private readonly conns = new Map<string, Conn>();
  /** 最近连上的那个对端。currentState / activeChunkSize 这些"当前"接口用它。 */
  private primaryPeerId: string | null = null;
  /** 传输 ID 全局共用一个序号，多个引擎各从 1 开始会撞号 */
  private readonly newTransferId: () => string;
  /**
   * 来自"还不认识的设备"的信令。
   *
   * 配对刚完成的那一瞬间有个真实的竞态：一方把对方写进通讯录的同时，
   * 对方可能已经建好通道把 offer 发过来了。这时按设备号还查不到配对记录，
   * 直接丢掉就会变成两边互相等。所以先暂存，等确认了再补送。
   */
  private readonly pendingSignals = new Map<string, { at: number; msgs: SignalMessage[] }>();
  /** 同一个对端只跑一次连接，多路触发全部搭同一个 Promise */
  private readonly connectByPeer = new Map<string, Promise<void>>();
  private static readonly PENDING_TTL_MS = 30_000;

  constructor(
    private readonly deps: SessionDeps,
    private readonly events: SessionEvents,
  ) {
    this.book = new AddressBook(deps.store);
    this.newTransferId = createTransferIdFactory(deps.identity.deviceId);
  }

  /** 取某个对端的连接记录，没有就建一个（含它自己的传输引擎） */
  private conn(peerId: string): Conn {
    let existing = this.conns.get(peerId);
    if (!existing) {
      existing = {
        peerId,
        session: null,
        link: null,
        engine: new TransferEngine(this.deps.sink, this.stampPeer(peerId), {
          newTransferId: this.newTransferId,
        }),
        myChallenge: null,
        peerVerifiedMe: false,
        iVerifiedPeer: false,
        waiters: [],
        state: 'idle',
        generation: 0,
        timer: null,
        share: null,
      };
      this.conns.set(peerId, existing);
    }
    return existing;
  }

  /**
   * 把对端设备号盖到传输回调上。
   *
   * 引擎只认一条链路，不认设备号，所以这一层只能在这里补。包的是 onStatus
   * 一个口子，进度和产物都带 id，界面自己按 id 找。
   */
  private stampPeer(peerId: string): TransferHandlers {
    const h = this.deps.transfer;
    return {
      ...h,
      onStatus: (u) => h.onStatus?.({ ...u, peerId }),
    };
  }

  /** 某个对端当前的连接状态。界面按设备各自显示，不再只有一份。 */
  stateOf(peerId: string): SessionState {
    return this.conns.get(peerId)?.state ?? 'idle';
  }

  /** 某个对端的分片大小，界面按设备显示 */
  chunkSizeOf(peerId: string): number {
    return this.conns.get(peerId)?.engine.activeChunkSize ?? 0;
  }

  /** 最近连上的那个对端的状态，给"当前连接"这类展示用 */
  get currentState(): SessionState {
    return this.primaryPeerId ? this.stateOf(this.primaryPeerId) : 'idle';
  }

  /** 最近连上的那个对端的分片大小 */
  get activeChunkSize(): number {
    return this.primaryPeerId ? this.chunkSizeOf(this.primaryPeerId) : 0;
  }

  /** 灯塔长连接的状态 */
  get signalState(): SignalState {
    return this.deps.signal.state;
  }

  /** 改设备名，顺手重新播报一次，不用重连也不用重新配对 */
  setDeviceName(name: string): void {
    this.deps.deviceName = name;
    if (this.deps.signal.state === 'open') this.sendHello();
  }

  get activePeer(): string | null {
    return this.primaryPeerId;
  }

  get contacts(): Promise<ContactRecord[]> {
    return this.book.list();
  }

  presenceOf(peerId: string): PresenceEntry | undefined {
    return this.presenceState.get(peerId);
  }

  /* ---------------------------------------------------------- 启动 */

  async start(): Promise<void> {
    this.deps.signal.onMessage((msg) => {
      void this.handleSignal(msg);
    });
    this.deps.signal.onStateChange((state) => {
      this.events.signal?.(state);
      if (state === 'open') {
        this.sendHello();
        void this.watchContacts();
        // 断线重连之后码要重新登记，服务器那边可能已经过期清掉了
        this.ensureCode();
      } else if (state === 'closed') {
        // 灯塔只管牵线。它断了不影响已经建好的点对点连接，
        // 所以这里只报错，不拆任何一条对端连接。
        this.events.error?.('灯塔连接断开');
      }
    });
    if (this.deps.signal.state === 'open') {
      this.sendHello();
      void this.watchContacts();
    }
    await this.refreshContacts();
    // 灯塔如果在这之前就连上了，onStateChange 不会再触发，这里补一次
    this.ensureCode();
  }

  close(): void {
    for (const c of this.conns.values()) this.resetConn(c, '已关闭');
    this.deps.signal.close();
  }

  private sendHello(): void {
    this.deps.signal.send({
      t: 'hello',
      deviceId: this.deps.identity.deviceId,
      name: this.deps.deviceName,
      publicKey: this.deps.identity.publicKey,
    });
  }

  private async watchContacts(): Promise<void> {
    const ids = (await this.book.list()).map((c) => c.peerId);
    this.deps.signal.send({ t: 'watch', ids });
  }

  private async refreshContacts(): Promise<void> {
    const list = await this.book.list();
    this.events.contacts?.(list);
    this.events.presence?.(
      list.map(
        (c) =>
          this.presenceState.get(c.peerId) ?? { id: c.peerId, online: false, name: c.peerName },
      ),
    );
  }

  /* ---------------------------------------------------------- 配对 */

  /**
   * 开始对外报码：先要一个，之后每 30 秒换一次。
   *
   * 码由服务器生成（保证不撞），存在状态板里指向我这台设备。
   * 它只是接头暗号，安全性由六位短认证串保证，见 core/pairing.ts 那一节。
   */
  startAdvertising(): void {
    if (!this.advertising) {
      this.advertising = true;
      this.rotateTimer = setInterval(() => this.requestCode(), CODE_ROTATE_MS);
    }
    // 不能在这里直接 return。这个方法会被两个地方调用（灯塔连上、通讯录为空），
    // 先到的那个有可能撞上"灯塔还没连上"，requestCode 会被丢掉；
    // 后到的那个如果直接返回，就永远不会有码了。所以这里补一次。
    this.ensureCode();
  }

  /** 手上没有还在有效期内的码就再要一个。 */
  private ensureCode(): void {
    const now = Date.now();
    for (const expiresAt of this.issuedCodes.values()) {
      if (expiresAt > now) return;
    }
    this.requestCode();
  }

  /** 停止报码。配对成功、或者用户收起配对面板时调用。 */
  stopAdvertising(): void {
    this.advertising = false;
    if (this.rotateTimer !== null) {
      clearInterval(this.rotateTimer);
      this.rotateTimer = null;
    }
    this.issuedCodes.clear();
    this.events.codeCleared?.();
  }

  private requestCode(): void {
    if (!this.advertising) return;
    // 没连上就先不要，连上之后 signal 事件里会补一次
    if (this.deps.signal.state !== 'open') return;
    this.deps.signal.send({ t: 'new-code' });
  }

  /** 立刻换一个码。界面上那个"换一个"按钮，以及轮换定时器都走这里。 */
  refreshCode(): void {
    this.requestCode();
  }

  /** 输错码或者用链接进来的统一入口：先查这个码是谁的。 */
  async joinWithCode(text: string, opts: { fingerprint?: string } = {}): Promise<void> {
    const code = normalizeCode(text);
    if (!code) throw new Error(`配对码是 ${CODE_DIGITS} 位数字，也可以直接粘整条链接`);
    this.outgoingCode = code;
    // 用户重新提交了一个码：允许这个码再自动重查一次
    if (this.codeRetryTimer) {
      clearTimeout(this.codeRetryTimer);
      this.codeRetryTimer = null;
    }
    this.codeRetried = null;
    // 声音那条路上，对方把自己的公钥指纹一起播了出来。等灯塔把公钥送回来，
    // 拿它对一遍：对不上就是有人在中间换了钥匙。手输和扫码没有这个，走老路。
    this.audioFingerprint = opts.fingerprint ? opts.fingerprint.toLowerCase() : null;
    this.audioVerified = false;
    this.deps.signal.send({ t: 'lookup-code', code });
  }

  /** 被邀请方：确认这六位数字和对方屏幕上一致。 */
  async confirmPairing(accept: boolean): Promise<void> {
    const incoming = this.incomingPairing;
    if (!incoming) return;
    if (!accept) {
      this.deps.signal.send({
        t: 'pair-response',
        from: this.deps.identity.deviceId,
        to: incoming.from,
        accepted: false,
        reason: '对方拒绝了配对',
        platform: 'web',
      });
      this.incomingPairing = null;
      return;
    }
    // 用过就作废，避免同一个码再被第三台设备捡走
    this.issuedCodes.delete(incoming.code);
    this.stopAdvertising();

    await this.book.add(
      await createContact(this.deps.identity, {
        peerId: incoming.from,
        peerName: incoming.name,
        publicKey: incoming.publicKey,
        peerPlatform: incoming.platform,
      }),
    );
    const peerId = incoming.from;
    this.incomingPairing = null;

    // 先把联系人写好、订阅建好，再回 pair-response。
    //
    // 顺序反过来的话有个很窄的窗口：对方一收到 pair-response 就立刻发 offer，
    // 而我这边还在等 IndexedDB，收到 offer 时配对记录还没就位只能暂存，
    // 万一 flushPending 那一刻暂存还是空的，我就只能发 connect-request 请它
    // 重发。虽然现在对方会重发（那边也修了），但让窗口根本不存在更好。
    await this.refreshContacts();
    await this.watchContacts();
    this.deps.signal.send({
      t: 'pair-response',
      from: this.deps.identity.deviceId,
      to: peerId,
      accepted: true,
      platform: 'web',
    });
    this.events.pairingDone?.(peerId);
    void this.connect(peerId).catch((err: unknown) => {
      this.events.error?.(err instanceof Error ? err.message : String(err));
    });
  }

  private async handlePairRequest(msg: Extract<SignalMessage, { t: 'pair-request' }>): Promise<void> {
    const expiresAt = this.issuedCodes.get(msg.code);
    const fail = (reason: string): void => {
      this.deps.signal.send({
        t: 'pair-response',
        from: this.deps.identity.deviceId,
        to: msg.from,
        accepted: false,
        reason,
        platform: 'web',
      });
      this.events.log?.(`拒绝配对请求：${reason}`);
    };
    if (expiresAt === undefined) return fail('这个配对码不是我发出去的');
    if (expiresAt < Date.now()) {
      this.issuedCodes.delete(msg.code);
      return fail('配对码已经换过了，让对方用屏幕上新的那个');
    }

    const derived = await this.deps.identity.deviceIdFromKey(msg.publicKey);
    if (derived !== msg.from) return fail('设备号和公钥对不上');

    const sas = await shortAuthenticationString(
      this.deps.identity,
      this.deps.identity.publicKey,
      msg.publicKey,
    );
    this.incomingPairing = {
      from: msg.from,
      name: msg.name,
      publicKey: msg.publicKey,
      code: msg.code,
      platform: msg.platform,
    };
    // 正在往外播，说明对面是听见了才找上来的。这时候再让人核对数字
    // 等于让"自动配对"卡一下，所以直接接受。指纹那一关在对方那边把着。
    if (this.autoAccept) {
      this.events.log?.('正在播，对方的请求直接接受');
      await this.confirmPairing(true);
      return;
    }
    this.events.pairingPrompt?.({
      deviceId: msg.from,
      name: msg.name,
      sas,
      role: 'inviter',
      peerPlatform: msg.platform,
    });
  }

  private async handlePairResponse(
    msg: Extract<SignalMessage, { t: 'pair-response' }>,
  ): Promise<void> {
    const pending = this.outgoingPairing;
    if (!pending || pending.peerId !== msg.from) return;
    this.outgoingPairing = null;
    if (this.pairWaitTimer) {
      clearTimeout(this.pairWaitTimer);
      this.pairWaitTimer = null;
    }
    this.outgoingCode = null;
    if (!msg.accepted) {
      this.events.error?.(`对方拒绝了配对：${msg.reason ?? '未说明原因'}`);
      return;
    }
    await this.book.add(
      await createContact(this.deps.identity, {
        peerId: pending.peerId,
        peerName: pending.name,
        publicKey: pending.publicKey,
        peerPlatform: msg.platform ?? pending.platform,
      }),
    );
    await this.refreshContacts();
    await this.watchContacts();
    this.events.pairingDone?.(pending.peerId);
    await this.connect(pending.peerId);
  }

  /* ---------------------------------------------------------- 连接与认证 */

  /**
   * 连到一台已配对的设备。
   *
   * 同一个对端同时可能被三路触发：配对刚完成、对端发来连接请求、对端先发来 offer。
   * 所以这里按对端做 single-flight：同一个对端只跑一次连接，后来的一律搭上同一个
   * Promise。早先是拿"当前对端"去比对做守卫，在多设备场景下一路重置就会把另一路的
   * 承诺拒掉，表现是"换了对端"这种看着莫名其妙的失败。
   */
  connect(peerId: string): Promise<void> {
    const existing = this.connectByPeer.get(peerId);
    if (existing) return existing;
    if (this.alreadyConnected(peerId)) return Promise.resolve();

    const promise = this.connectOnce(peerId);
    this.connectByPeer.set(peerId, promise);
    const clear = (): void => {
      if (this.connectByPeer.get(peerId) === promise) this.connectByPeer.delete(peerId);
    };
    promise.then(clear, clear);
    return promise;
  }

  private async connectOnce(peerId: string): Promise<void> {
    const contact = await this.book.get(peerId);
    if (!contact) throw new Error('这台设备还没有配对记录，先配对一次');
    if (this.alreadyConnected(peerId)) return;

    const presence = this.presenceState.get(peerId);
    if (presence && !presence.online) throw new Error('对方不在线');

    const c = this.conn(peerId);
    // 上面那次 book.get 让出了执行权，对端的 offer 可能正好在这段窗口里到达，
    // 被 deliverSignal 接管成了一个已经应用过 offer 的会话。
    //
    // 这时不能重置：offer 是一次性的，拆掉会话等于把它作废，而它走的是
    // deliverSignal 不是 bufferSignal，暂存区是空的，flushPending 补不回来。
    // 于是下面改发 connect-request 请对端重发，对端却认为自己早发过了，
    // 两边一起等到超时。原生端抓到的"收到 sdp（answer）紧接着收到
    // connect-request"就是这个顺序。
    if (c.session === null) {
      // 只重置这个对端自己的连接，别的对端不受影响
      this.resetConn(c, '重新连接');
      this.setConnState(c, 'connecting');
      this.events.phase?.(peerId, 'signaling');
    }

    const promise = this.waitReady(c, peerId);

    // 对端可能比我先一步。它发来的 offer 先补进去，补出来的会话就是应答方。
    await this.flushPending(peerId);

    if (!c.session) {
      if (this.ownsChannel(peerId)) {
        this.createSession(c, true);
      } else {
        // 通道不是我这侧建的。请对方发起，等它的 offer。
        // 这样"谁建通道"始终只有一个答案，不会有 offer 撞车。
        this.deps.signal.send({
          t: 'connect-request',
          from: this.deps.identity.deviceId,
          to: peerId,
        });
      }
    }
    return promise;
  }

  /**
   * 等这条连接走到 ready。
   *
   * 从 connectOnce 里抽出来，是因为公开分享那条路也要等同一个终点，而它
   * 不走通讯录、也不走 flushPending。抽出来两处共用，就不会出现"一边改了
   * 超时行为另一边没改"。
   *
   * 定时器有就必须没有第二个：已经有一次连接在计时时不要再顶掉它，
   * 被顶掉的那个再没人清，到点会把一条好好连着的连接判成超时。
   * 接管对端 offer 的那条路正好会走到这里。
   */
  private waitReady(c: Conn, peerId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const settle = (finish: () => void): void => {
        if (c.timer) {
          clearTimeout(c.timer);
          c.timer = null;
        }
        finish();
      };
      c.waiters.push({
        resolve: () => settle(resolve),
        reject: (err) => settle(() => reject(err)),
      });
      // 设备之间连不上时必须有个了断。没有超时的话发送会一直等着，
      // 界面上看不出是慢还是坏了。
      const ms = this.deps.connectTimeoutMs ?? CONNECT_TIMEOUT_MS;
      if (c.timer === null) {
        c.timer = setTimeout(() => {
          this.events.phase?.(peerId, 'failed');
          this.failConn(c, `连不上对方：${Math.round(ms / 1000)} 秒内没打通`);
        }, ms);
      }
    });
  }

  private alreadyConnected(peerId: string): boolean {
    const c = this.conns.get(peerId);
    return c !== undefined && c.state === 'ready' && c.link !== null;
  }

  /** 建数据通道并发 offer 的那一侧。由设备号大小决定，两端结论一致。 */
  private ownsChannel(peerId: string): boolean {
    return this.deps.identity.deviceId > peerId;
  }

  /* ---------------------------------------------------------- 公开分享 */

  /**
   * 灯塔的这条信令路径上没有通讯录，所以"认不认这台设备"要有第二个答案。
   *
   * 第二种来源存在的时间很短（一条分享从接受到传完），但它必须在这里生效：
   * 分享者发出 offer 之后访客回的 answer 回来时如果只查通讯录，会被当陌生设备
   * 暂存，而 answer 不是 offer，flushPending 那条路明确只补 offer（见下面
   * handleSignal 里 sdp 那一支）。两端都会在同一个位置卡住，谁也不报错。
   */
  private async isKnownPeer(peerId: string): Promise<boolean> {
    if (this.conns.get(peerId)?.share) return true;
    return Boolean(await this.book.get(peerId));
  }

  /**
   * 登记一个公开分享的对端。
   *
   * 必须在任何信令到达之前调用：分享者这边是收到 share-connect 之后马上，
   * 访客这边是发出 share-connect 之前。登记之后 isKnownPeer 才认这台设备，
   * 随后的 sdp 和 ice 才不会掉进陌生设备那个暂存区。
   */
  registerSharePeer(peerId: string, share: SharePeer): void {
    const c = this.conn(peerId);
    const same = c.share !== null && c.share.token === share.token && c.share.role === share.role;
    c.share = share;
    // 同一个对端换了一条分享，或者带着新 token 重连：旧链路要拆掉。
    // 不拆的话认证那边用的还是上一条分享的公钥，签名必然验不过，
    // 而表现是"连上了又断开"，看不出跟 token 有关。
    if (!same) this.resetConn(c, '换了一条分享');
  }

  /**
   * 分享者：给一个已登记的访客建通道，发 offer。
   *
   * 公开分享里**永远是分享者发 offer**，这和配对那套不一样（那边由设备号大小
   * 决定，见 ownsChannel）。理由是访客的多少和先后是运行时才定的：拿设备号
   * 大小决定谁建，就有一半的访客由匿名那侧发起，分享者要同时处理"我在发 offer"
   * 和"我在等 offer"两种状态，而名额只在分享者这边。
   *
   * 这条规则只适用于分享路径，所以不碰 ownsChannel。配对的规则是跨语言的，
   * 浏览器、C++、Rust 三处必须一致，见 docs/18 第 9 节。
   */
  serveSharePeer(peerId: string): Promise<void> {
    const c = this.conns.get(peerId);
    if (!c?.share) return Promise.reject(new Error('这台不是哪条分享的访客'));
    if (c.share.role !== 'seeder') {
      return Promise.reject(new Error('访客不发起连接，等对方把 offer 送过来'));
    }
    if (this.alreadyConnected(peerId)) return Promise.resolve();
    if (!c.session) {
      this.resetConn(c, '开始服务这个访客');
      this.setConnState(c, 'connecting');
      this.events.phase?.(peerId, 'signaling');
      this.createSession(c, true);
    }
    return this.waitReady(c, peerId);
  }

  /** 一条分享结束了（撤销、访客走掉、过期）。拆连接并忘掉它的公钥。 */
  closeSharePeer(peerId: string, reason: string): void {
    const c = this.conns.get(peerId);
    if (!c) return;
    this.resetConn(c, reason);
    c.share = null;
  }

  /** 分享那几条信令由 ShareHub 直接送出去，不经配对的状态机 */
  sendSignal(msg: SignalMessage): void {
    this.deps.signal.send(msg);
  }

  private createSession(c: Conn, initiator: boolean): void {
    if (c.session) return;
    const generation = c.generation;
    c.session = this.deps.transport.createSession({
      polite: !initiator,
      initiator,
      peerId: c.peerId,
      onSignal: (m) => {
        if (m.t === 'sdp' || m.t === 'ice') {
          this.deps.signal.send({ ...m, from: this.deps.identity.deviceId, to: c.peerId });
        }
      },
    });
    c.session.onLink((link) => this.handleLink(c, link, generation));
    c.session.onStateChange((state) => {
      // 旧会话的失败事件不该影响这个对端的新会话
      if (generation !== c.generation) return;
      // 传输层说"正在连"，就是 ICE 在打洞了
      if (state === 'connecting') this.events.phase?.(c.peerId, 'ice');
      if (state === 'failed') {
        this.events.phase?.(c.peerId, 'failed');
        this.failConn(c, '点对点连接失败');
      }
    });
  }

  private handleLink(c: Conn, link: PeerLink, generation: number): void {
    c.link = link;
    link.onMessage((data) => {
      if (generation !== c.generation) return;
      // 认证期间只处理控制帧。二进制分片在认证通过之前一律丢弃。
      if (typeof data !== 'string') return;
      const msg = decodeControl(data);
      if (!msg) return;
      if (msg.t === 'auth-challenge' || msg.t === 'auth-response' || msg.t === 'auth-result') {
        void this.handleAuth(c, msg);
        return;
      }
      // 连通测试。放在会话这层，传输引擎那边对未知控制帧是直接忽略的。
      if (msg.t === 'ping') {
        this.sendControl(c, { t: 'pong', id: msg.id });
        return;
      }
      if (msg.t === 'pong') {
        const done = this.pongWaiters.get(msg.id);
        if (done) {
          this.pongWaiters.delete(msg.id);
          done();
        }
      }
    });
    link.onStateChange((state) => {
      // 关键：旧链路关闭的迟到通知不能拆掉这个对端的新连接
      if (generation !== c.generation) return;
      if (state === 'closed' || state === 'failed') this.failConn(c, '点对点连接断了');
    });
    // 不能同步发挑战：通道打开时对端可能还没来得及注册消息处理函数，
    // 同步发出去的第一条消息会被丢掉（真实浏览器里也会这样）。
    // 让出一个微任务，两端的监听都就位之后再开始认证。
    queueMicrotask(() => {
      void this.startAuth(c);
    });
  }

  private async startAuth(c: Conn): Promise<void> {
    this.events.phase?.(c.peerId, 'auth');
    this.setConnState(c, 'authenticating');
    c.peerVerifiedMe = false;
    c.iVerifiedPeer = false;
    // 挑战走数据通道，随机串本身就绑定了这条链路，不需要再绑 DTLS 指纹
    const ctx = newChallenge(this.deps.identity, this.deps.identity.deviceId, c.peerId);
    c.myChallenge = ctx;
    this.sendControl(c, { t: 'auth-challenge', nonce: ctx.nonce, issuedAt: ctx.issuedAt });

    // 第一条挑战可能落在对端还没挂好处理函数的窗口里。补发同一份挑战，
    // 对端重复应答不会改变结论（验签结果只取决于 nonce 和公钥）。
    const generation = c.generation;
    const retry = (attempt: number): void => {
      if (attempt > AUTH_RETRY_MAX) return;
      setTimeout(() => {
        if (generation !== c.generation || c.iVerifiedPeer || c.state === 'ready') return;
        if (!c.link || c.link.state !== 'connected') return;
        this.sendControl(c, { t: 'auth-challenge', nonce: ctx.nonce, issuedAt: ctx.issuedAt });
        this.events.log?.(`认证挑战没有回应，重发第 ${attempt} 次`);
        retry(attempt + 1);
      }, AUTH_RETRY_MS);
    };
    retry(1);
  }

  private async handleAuth(c: Conn, msg: ControlMessage): Promise<void> {
    if (msg.t === 'auth-challenge') {
      // 先确认挑战是发给我的，再签名
      const response = await buildResponse(this.deps.identity, {
        myId: this.deps.identity.deviceId,
        peerId: c.peerId,
        nonce: msg.nonce,
        issuedAt: msg.issuedAt,
      });
      if (!response.ok) {
        this.sendControl(c, { t: 'auth-result', ok: false, reason: response.reason });
        this.failConn(c, `拒绝了这个挑战：${response.reason}`);
        return;
      }
      this.sendControl(c, { t: 'auth-response', sig: toBase64Url(response.signature) });
      return;
    }

    if (msg.t === 'auth-response') {
      // 公钥有两个来源：配过的在通讯录里，公开分享的是这条连接登记时带进来的。
      // 挑战是我自己发的，签名只对某一把公钥成立，所以这一步唯一的悬念
      // 还是"这把钥匙算不算数"，而那两个答案各自有不同的来历，见 SharePeer。
      const peerKey = c.share?.peerKey ?? (await this.book.get(c.peerId))?.publicKey;
      if (!peerKey || !c.myChallenge) {
        this.sendControl(c, { t: 'auth-result', ok: false, reason: '没有这台的身份记录' });
        this.failConn(c, '对端既不在通讯录里，也不是哪条分享的访客');
        return;
      }
      const result = await verifyResponse(
        this.deps.identity,
        c.myChallenge,
        fromBase64Url(msg.sig),
        peerKey,
      );
      if (!result.ok) {
        this.sendControl(c, { t: 'auth-result', ok: false, reason: result.reason });
        this.failConn(c, `认证失败：${result.reason}`);
        return;
      }
      c.iVerifiedPeer = true;
      this.sendControl(c, { t: 'auth-result', ok: true });
      this.maybeReady(c);
      return;
    }

    if (msg.t === 'auth-result') {
      if (!msg.ok) {
        this.failConn(c, `对方拒绝了认证：${msg.reason ?? '未说明原因'}`);
        return;
      }
      c.peerVerifiedMe = true;
      this.maybeReady(c);
    }
  }

  /** 两个方向都验完才放行。任一边没过，传输引擎根本不接管这条链路。 */
  private maybeReady(c: Conn): void {
    if (!c.iVerifiedPeer || !c.peerVerifiedMe) return;
    const link = c.link;
    if (!link) return;
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
    // 只接管这个对端自己的引擎，别的对端照旧传着
    c.engine.attach(link);
    this.primaryPeerId = c.peerId;
    this.events.phase?.(c.peerId, 'ready');
    this.setConnState(c, 'ready');
    for (const waiter of c.waiters.splice(0)) waiter.resolve();
    void this.book.touch(c.peerId).then(() => this.refreshContacts());
    this.events.link?.(c.peerId, link);
    this.events.log?.(`已和 ${c.peerId} 建立经过认证的连接`);
  }

  /* ---------------------------------------------------------- 连通测试 */

  /** 等回话的那几个 ping。按 id 存，避免并发时互相顶掉。 */
  private pongWaiters = new Map<string, () => void>();

  /**
   * 量一次这条链路的往返。单位毫秒。
   *
   * 只证明"现在这一秒它真的能收到我的东西并回过来"，不测吞吐，也不替代认证。
   * 超时就 reject，界面据此让用户回上一步。
   */
  async ping(peerId: string, timeoutMs = 4000): Promise<number> {
    const c = this.conns.get(peerId);
    if (!c?.link) throw new Error('还没连上对方');
    const id = toBase64Url(this.deps.identity.randomBytes(8));
    const startedAt = Date.now();
    return new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pongWaiters.delete(id);
        reject(new Error('对方没有回话'));
      }, timeoutMs);
      this.pongWaiters.set(id, () => {
        clearTimeout(timer);
        resolve(Date.now() - startedAt);
      });
      this.sendControl(c, { t: 'ping', id });
    });
  }

  /**
   * 播声音的时候打开：这期间的配对请求不再弹确认。
   *
   * 只在"正在播"这一小段时间里开，停下来就关，不会变成长期放行。
   */
  setAutoAccept(on: boolean): void {
    this.autoAccept = on;
  }

  /** 自己公钥指纹的前 8 位，跟着声音一起播出去，让对方核对我的钥匙。 */
  audioTag(): Promise<string> {
    return this.deps.identity.fingerprint(this.deps.identity.publicKey);
  }

  /* ---------------------------------------------------------- 发送 */

  async sendFile(peerId: string, file: FileLike): Promise<string> {
    await this.ensureConnected(peerId);
    return this.conn(peerId).engine.enqueue(file);
  }

  async sendText(peerId: string, text: string): Promise<string> {
    await this.ensureConnected(peerId);
    return this.conn(peerId).engine.sendText(text);
  }

  /**
   * 发送之前把连接准备好。
   *
   * 分两条路：登记过分享的对端走 serveSharePeer（不查通讯录，永远我这侧发 offer），
   * 其余走原来那条 connect()。合在一个入口是因为调用方不该关心对端是哪来的。
   */
  private async ensureConnected(peerId: string): Promise<void> {
    if (this.conns.get(peerId)?.share) return this.serveSharePeer(peerId);
    return this.connect(peerId);
  }

  /* ---------------------------------------------------------- 信令分发 */

  private async handleSignal(msg: SignalMessage): Promise<void> {
    // 每条进来的信令都记一笔。原生端那边已经这么做了，这边是缺失的一半：
    // 排查"浏览器到底有没有收到那个 offer"时，只有原生端的记录答不了。
    // 走 events.log 是因为测试能直接从页面上读到它。
    // 这一行必须**绝对不会抛**。handleSignal 是 async 的，这里一抛异常就变成
    // 静默的 promise rejection，后面整个 switch 都不执行，那条信令等于被吞了，
    // 而且界面上一点痕迹都没有。可选链加 try 就是为了这个。
    try {
      if (msg.t === 'sdp' || msg.t === 'ice' || msg.t === 'connect-request') {
        const desc = msg.t === 'sdp' ? (msg as { description?: { type?: string } }).description : undefined;
        const kind = desc ? `（${desc.type ?? '?'}）` : '';
        this.events.log?.(`← 信令 ${msg.t}${kind} from ${String(msg.from ?? '').slice(0, 6)}`);
      }
    } catch {
      /* 记日志绝不能影响处理 */
    }
    switch (msg.t) {
      case 'presence-list': {
        for (const entry of msg.entries) this.presenceState.set(entry.id, entry);
        await this.refreshContacts();
        return;
      }
      case 'presence': {
        const previous = this.presenceState.get(msg.id);
        const entry: PresenceEntry = {
          id: msg.id,
          online: msg.online,
          ...(msg.name ?? previous?.name ? { name: msg.name ?? previous?.name } : {}),
        };
        this.presenceState.set(msg.id, entry);
        await this.refreshContacts();
        return;
      }
      case 'code': {
        const now = Date.now();
        this.issuedCodes.set(msg.code, msg.expiresAt);
        // 过期的和太旧的都清掉，只留最近几条
        for (const [code, expiresAt] of this.issuedCodes) {
          if (expiresAt < now) this.issuedCodes.delete(code);
        }
        while (this.issuedCodes.size > MAX_CODES_PER_DEVICE) {
          const oldest = [...this.issuedCodes.entries()].sort((a, b) => a[1] - b[1])[0];
          if (!oldest) break;
          this.issuedCodes.delete(oldest[0]);
        }
        this.events.code?.(msg.code, msg.expiresAt);
        return;
      }
      case 'code-owner': {
        if (msg.code !== this.outgoingCode) return;
        if (this.codeRetryTimer) {
          clearTimeout(this.codeRetryTimer);
          this.codeRetryTimer = null;
        }
        // 设备号必须由公钥推导，否则"自称是谁"没有约束
        const derived = await this.deps.identity.deviceIdFromKey(msg.publicKey);
        if (derived !== msg.deviceId) {
          this.outgoingCode = null;
          this.events.error?.('对方送来的公钥和它的设备号对不上，可能有人在中间');
          return;
        }
        if (this.audioFingerprint) {
          const heard = this.audioFingerprint;
          const actual = await this.deps.identity.fingerprint(msg.publicKey);
          this.audioFingerprint = null;
          if (!actual.startsWith(heard)) {
            this.outgoingCode = null;
            this.events.error?.('声音里的指纹和灯塔给的公钥对不上，可能有人在中间，已经断开');
            return;
          }
          this.audioVerified = true;
          this.events.log?.('声音里的指纹对上了，这次配对不用再核对六位数字');
        }
        this.outgoingPairing = {
          peerId: msg.deviceId,
          name: msg.name,
          publicKey: msg.publicKey,
        };
        if (this.pairWaitTimer) clearTimeout(this.pairWaitTimer);
        this.pairWaitTimer = setTimeout(() => {
          this.pairWaitTimer = null;
          if (!this.outgoingPairing) return;
          this.outgoingPairing = null;
          this.outgoingCode = null;
          this.events.error?.('对方一直没确认，再试一次吧');
        }, 45_000);
        // 拿到对方公钥就能算出六位数字，先显示出来供比对
        const sas = await shortAuthenticationString(
          this.deps.identity,
          msg.publicKey,
          this.deps.identity.publicKey,
        );
        // 声音里的指纹已经担了这次核对的责任，不再弹六位数字
        if (!this.audioVerified) {
          this.events.pairingPrompt?.({
            deviceId: msg.deviceId,
            name: msg.name,
            sas,
            role: 'joiner',
          });
        }
        this.deps.signal.send({ t: 'watch', ids: [msg.deviceId] });
        this.deps.signal.send({
          t: 'pair-request',
          from: this.deps.identity.deviceId,
          to: msg.deviceId,
          code: msg.code,
          name: this.deps.deviceName,
          publicKey: this.deps.identity.publicKey,
          platform: 'web',
        });
        return;
      }
      case 'code-miss': {
        if (msg.code !== this.outgoingCode) return;
        // 码刚好在查询路上轮换掉是可能的。同一个码只自动重查一次；
        // 服务端对 1.5 秒内的同码重复查询不记 miss，所以不会被这次重查罚冷却。
        if (
          !msg.retryAfterMs &&
          msg.reason.includes('没有这个码') &&
          this.codeRetried !== msg.code
        ) {
          this.codeRetried = msg.code;
          this.events.log?.('配对码第一次没查到，600ms 后自动重查');
          if (this.codeRetryTimer) clearTimeout(this.codeRetryTimer);
          this.codeRetryTimer = setTimeout(() => {
            this.codeRetryTimer = null;
            if (this.outgoingCode === msg.code) {
              this.deps.signal.send({ t: 'lookup-code', code: msg.code });
            }
          }, 600);
          return;
        }
        this.outgoingCode = null;
        this.events.error?.(`这个配对码没找到：${msg.reason}`);
        // 灯塔说"还在冷却"，界面就别再让用户白点
        if (typeof msg.retryAfterMs === 'number' && msg.retryAfterMs > 0) {
          this.events.codeCooldown?.(Date.now() + msg.retryAfterMs);
        }
        return;
      }
      case 'pair-request':
        await this.handlePairRequest(msg);
        return;
      case 'pair-response':
        await this.handlePairResponse(msg);
        return;
      case 'connect-request': {
        // 对端想连我，但通道是我这侧建的，所以由我来发起
        if (!(await this.book.get(msg.from))) {
          this.bufferSignal(msg.from, msg);
          return;
        }
        void this.connect(msg.from).catch((err: unknown) => {
          this.events.log?.(
            `应对方的连接请求时出错：${err instanceof Error ? err.message : String(err)}`,
          );
        });
        return;
      }
      case 'ice':
      case 'sdp': {
        // 还不认识的设备：只有 offer 值得暂存，等配对记录就位再补送。
        // 迟到的 ICE 候选一律丢掉（见 deliverSignal 里的说明）。
        if (!(await this.isKnownPeer(msg.from))) {
          if (msg.t === 'sdp' && msg.description.type === 'offer') {
            this.bufferSignal(msg.from, msg);
          }
          return;
        }
        await this.deliverSignal(msg);
        return;
      }
      case 'share-connect':
      case 'share-revoked':
      case 'share-leave':
        // 资格、名额都不在这里判。这一层只知道"有一条分享登记过这台设备"，
        // 而 token 是不是我挂出去的那一条，是 ShareHub 的事。
        this.events.shareSignal?.(msg);
        return;
      case 'error': {
        this.events.error?.(`灯塔返回错误：${msg.code} ${msg.message}`);
        return;
      }
      default:
        return;
    }
  }

  /* ---------------------------------------------------------- 收尾 */

  private bufferSignal(peerId: string, msg: SignalMessage): void {
    const entry = this.pendingSignals.get(peerId) ?? { at: Date.now(), msgs: [] };
    entry.msgs.push(msg);
    this.pendingSignals.set(peerId, entry);
    this.events.log?.(`暂存了一条来自 ${peerId} 的信令，等配对记录就位`);
  }

  /** 把暂存的信令补送出去。送出之后会话可能已经由应答方那一侧建好了。 */
  private async flushPending(peerId: string): Promise<void> {
    const entry = this.pendingSignals.get(peerId);
    if (!entry) return;
    this.pendingSignals.delete(peerId);
    if (Date.now() - entry.at > SessionManager.PENDING_TTL_MS) return;
    for (const msg of entry.msgs) await this.deliverSignal(msg);
  }

  /**
   * 把一条来自已知设备的信令送到对应那个对端的连接上。
   *
   * ICE 候选**永远不能**触发"接管对端发起的连接"。旧对端的候选经常在切换设备
   * 之后才姗姗来迟，拿它去接管会把那个对端刚建好的会话整个拆掉（实测过：同时
   * 存在四个 RTCPeerConnection，第三台连不上）。候选只对已经建好的会话有意义。
   */
  private async deliverSignal(msg: SignalMessage): Promise<void> {
    if (msg.t === 'connect-request') {
      if (await this.book.get(msg.from)) {
        void this.connect(msg.from).catch((err: unknown) => {
          this.events.log?.(
            `应对方的连接请求时出错：${err instanceof Error ? err.message : String(err)}`,
          );
        });
      }
      return;
    }
    if (msg.t !== 'sdp' && msg.t !== 'ice') return;

    const c = this.conns.get(msg.from);
    if (!c || !c.session) {
      if (msg.t === 'ice') return;
      // 只有 offer 才算对方在发起连接。answer 是回给我们的，迟到的同样不该触发接管。
      if (msg.description.type !== 'offer') return;
      // 接管之后必须把这条 offer 应用上去，否则应答方的握手永远走不完。
      const adopted = this.adoptOffer(msg.from);
      await adopted.session?.applySignal(msg);
      return;
    }
    await c.session.applySignal(msg);
  }

  /** 对端先发起：为它建一条连接并接管，正在等连接的调用方继续等着 */
  private adoptOffer(peerId: string): Conn {
    const c = this.conn(peerId);
    if (!c.session && c.state === 'idle') this.events.phase?.(peerId, 'signaling');
    this.resetConn(c, '对端先发起', true);
    this.setConnState(c, 'connecting');
    if (!c.session) this.createSession(c, false);
    return c;
  }

  private sendControl(c: Conn, msg: ControlMessage): void {
    const link = c.link;
    if (!link || link.state !== 'connected') return;
    link.send(encodeControl(msg));
  }

  private setConnState(c: Conn, state: SessionState): void {
    c.state = state;
    this.events.state?.(state, c.peerId);
  }

  private failConn(c: Conn, reason: string): void {
    this.events.error?.(reason);
    this.resetConn(c, reason);
  }

  /**
   * 清掉某个对端的会话。
   *
   * `keepWaiters` 是给"对端先发起"那条路用的：那次重置不是失败，而是为了
   * 接管对端已经建好的会话，所以正在等连接的调用方必须继续等着。
   * 不传的话会把等待者全部拒掉，表现是明明接管成功了，调用方却收到
   * "对端先发起"这种看着像失败的错误，发送直接中断。
   */
  private resetConn(c: Conn, reason: string, keepWaiters = false): void {
    // 链路断开会在两端互相触发，这里先挡掉重复进入
    if (!c.session && !c.link && c.state === 'idle') return;
    // 换代：从这里开始，这个对端旧链路的一切回调都不再被采纳
    c.generation += 1;
    c.engine.detach(reason);
    if (c.timer) {
      clearTimeout(c.timer);
      c.timer = null;
    }
    try {
      c.link?.close();
    } catch {
      /* 已经关掉 */
    }
    c.session?.close();
    c.link = null;
    c.session = null;
    c.myChallenge = null;
    c.peerVerifiedMe = false;
    this.audioVerified = false;
    c.iVerifiedPeer = false;
    if (!keepWaiters) {
      for (const waiter of c.waiters.splice(0)) waiter.reject(new Error(reason));
    }
    // 注意：这里不清 pendingSignals。connect() 的顺序是先重置再 flushPending，
    // 在这里清掉就会把"配对刚完成时对端先发来的信令"一起删掉。
    // 暂存项由 flushPending 消费，另有 30 秒有效期兜底。
    if (c.state !== 'idle') this.setConnState(c, 'idle');
  }
}
