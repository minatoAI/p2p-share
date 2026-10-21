/**
 * 核心层只依赖这四个端口，不依赖任何浏览器 API。
 *
 * 这样切分换来三件事：
 *   1. 核心逻辑（协议、分片、流控、时间线）能在 Node 里直接跑单元测试；
 *   2. 界面框架可以随时换，核心层不知道它存在；
 *   3. 以后做原生版，只换适配器，核心层一行不改。
 *
 * 平台限制一律通过能力声明暴露（见 SinkPort），核心层永远不判断 User-Agent。
 */

import type {
  PeerPlatform,
  PublicKeyJwk,
  ShareStatus,
  ShareSummary,
  SignalMessage,
} from './protocol';

/* ============================================================ 身份 */

export interface DeviceIdentity extends IdentityCrypto {
  deviceId: string;
  /** 交换给对方用于验签的公钥 */
  publicKey: PublicKeyJwk;
  /**
   * 能不能做密码学操作。`crypto.subtle` 只在安全上下文里存在，
   * 用 http://192.168.x.x 打开时它是 undefined，这时只能降级运行，
   * 而且**做不了认证**，也就没有"配对一次就是认证"。
   * 用能力声明而不是让上层去判断协议和地址，理由见 docs/11 第 4 节。
   */
  canSign: boolean;
}

export interface IdentityPort {
  loadOrCreate(): Promise<DeviceIdentity>;
}

/* ============================================================ 密码学 */

/**
 * 认证要用到的几个原语。
 *
 * 单独抽成端口而不是直接调 crypto.subtle，是为了让"谁被认证了、凭什么"
 * 这部分逻辑能在 Node 里跑测试。实现用的是 WebCrypto，
 * 它是标准接口，Node 18+、Workers 和浏览器都有，不算浏览器专有 API。
 */
export interface IdentityCrypto {
  /** 由公钥推导设备号。设备号必须由公钥决定，否则任何人都能自称是别人。 */
  deviceIdFromKey(publicKey: PublicKeyJwk): Promise<string>;
  /** 短指纹，给人看、供人工核对的 */
  fingerprint(publicKey: PublicKeyJwk): Promise<string>;
  /** 本机私钥签名 */
  sign(data: Uint8Array): Promise<Uint8Array>;
  verify(publicKey: PublicKeyJwk, data: Uint8Array, sig: Uint8Array): Promise<boolean>;
  digest(data: Uint8Array): Promise<Uint8Array>;
  randomBytes(n: number): Uint8Array;
}

/**
 * 通讯录里的一台设备。
 *
 * 配对一次就是认证：这份记录就是对端身份的凭据，之后所有连接都靠它验证，
 * 不再需要任何一次性令牌，所以也没有过期时间。
 */
export interface ContactRecord {
  peerId: string;
  peerName: string;
  publicKey: PublicKeyJwk;
  /** 配对时双方算出来的六位数字，人工核对过才写进来 */
  fingerprint: string;
  pairedAt: number;
  lastSeenAt?: number;
  /** web / native；旧版本配对没有这一项，界面按「端未标注」处理 */
  peerPlatform?: PeerPlatform;
}

/* ============================================================ 信令链路 */

export type SignalState = 'connecting' | 'open' | 'closed';

/**
 * 这次重连是被什么触发的。
 *
 * 分出来是为了让界面能说人话：页面从后台回来时报"页面恢复后重连"，
 * 用户点了按钮报"手动重连"，比一律"正在重连"好判断得多。
 */
export type ReconnectTrigger = 'closed' | 'error' | 'resume' | 'online' | 'manual';

/**
 * 灯塔重连的可观测进度。
 *
 * 这不是内部调试信息：手机切到后台再回来时连接会断，用户必须能看见
 * "系统确实在动"——第几次、还要等几秒、是不是已经在握手了。
 * 以前这些都没有，界面上只有一句"正在重连"，看起来和卡死没区别。
 */
export interface ReconnectInfo {
  /** 即将进行或正在进行的是第几次尝试，从 1 开始；连上之后不再发布 */
  attempt: number;
  /** waiting：在等退避走完；trying：已经在握手了 */
  phase: 'waiting' | 'trying';
  /** 下一次尝试的时刻（毫秒时间戳）。正在握手时为 null */
  nextAt: number | null;
  /** 本次退避的时间，毫秒。界面拿它画进度条 */
  delayMs: number;
  trigger: ReconnectTrigger;
  /** 之前已经连上过，所以这次是"掉线回来"，不是首次连接 */
  resumed: boolean;
}

/** 与灯塔之间的长连接。 */
export interface SignalLink {
  readonly state: SignalState;
  send(msg: SignalMessage): void;
  onMessage(cb: (msg: SignalMessage) => void): void;
  onStateChange(cb: (s: SignalState) => void): void;
  /** 重连进度，每次进入新的等待或握手阶段都会播报一次 */
  onReconnect(cb: (info: ReconnectInfo) => void): void;
  /**
   * 立刻重试，不等退避走完。
   *
   * 两个地方会调它：页面从后台恢复（冻结期间定时器根本没跑，退避等于停了），
   * 以及用户自己点"立即重连"。已经连着的时候调它是空操作。
   */
  reconnectNow(trigger?: ReconnectTrigger): void;
  close(): void;
}

/* ============================================================ 分享注册表 */

/**
 * 灯塔的分享注册表。
 *
 * 单独一个端口，不并进 SignalLink：后者是一条长连接，注册表是几次一次性的
 * 拉取。合在一起会让核心层的分享测试必须先起一条假 WebSocket，而这两个
 * 通道的时序关系恰恰是这次要验的东西之一（访客先查到状态，再去连设备号）。
 */
export interface RegistryPort {
  /** 挂出一条分享。只送元信息，不送字节 */
  create(input: {
    deviceId: string;
    deviceName: string;
    publicKey: PublicKeyJwk;
    name: string;
    size: number;
    mime: string;
    ttlMs?: number;
  }): Promise<{ token: string; expiresAt: number }>;
  /** 查一条分享。访客打开链接之后的第一件事 */
  status(token: string): Promise<ShareStatus | undefined>;
  /** 我挂出去的那些，界面用来恢复分享列表 */
  list(deviceId: string): Promise<ShareSummary[]>;
  /** 撤销。之后访客再查就是 revoked */
  revoke(input: { token: string; deviceId: string }): Promise<void>;
}

/* ============================================================ 点对点链路 */

export type PeerState = 'connecting' | 'connected' | 'failed' | 'closed';

/** 这次连接实际走的是哪条路，界面靠它告诉用户花不花流量。 */
export type PathKind = 'lan' | 'direct' | 'relay' | 'unknown';

export interface PathInfo {
  kind: PathKind;
  localType: string;
  remoteType: string;
}

export interface PeerLink {
  readonly state: PeerState;
  send(data: string | ArrayBuffer): void;
  /** 发送缓冲区里还没出去的字节数，流控靠它 */
  bufferedAmount(): number;
  /**
   * 这条链路单条消息的上限，由 SCTP 传输层给出。
   * 分片大小应该从它推导，而不是写死：写 16 KiB 在能发 64 KiB 的链路上
   * 会白白多出四倍的消息数和四倍的控制帧。
   */
  maxChunkSize(): number;
  onMessage(cb: (data: string | ArrayBuffer) => void): void;
  onStateChange(cb: (s: PeerState) => void): void;
  /** 缓冲区降到低水位时触发，用来从暂停中恢复 */
  onDrain(cb: () => void): void;
  path(): Promise<PathInfo>;
  close(): void;
}

export interface SessionOptions {
  /** 完美协商里的角色：一方 polite，一方 impolite */
  polite: boolean;
  /**
   * 谁主动建数据通道。只有发起方建，另一方等 ondatachannel，
   * 这样不会两端同时发 offer，协商冲突只在必要时才处理。
   */
  initiator: boolean;
  /**
   * 这条会话通向哪个对端。传输层本身不需要它，但它让诊断日志能标出对端，
   * 也让测试替身能把"哪两个会话该配对"判定正确（按设备号索引会错配）。
   */
  peerId: string;
  /** 本地新生成的 SDP / ICE，交给灯塔转发 */
  onSignal(msg: SignalMessage): void;
}

/** 一次连接的协商过程。适配器持有 RTCPeerConnection，核心层只喂信号、收链路。 */
export interface PeerSession {
  applySignal(msg: SignalMessage): Promise<void>;
  onLink(cb: (link: PeerLink) => void): void;
  onStateChange(cb: (s: PeerState) => void): void;
  close(): void;
}

export interface TransportPort {
  createSession(opts: SessionOptions): PeerSession;
  /** 供界面展示当前 ICE 配置，例如"未配置中继" */
  describeConfig(): { iceServerCount: number; hasTurn: boolean };
}

/* ============================================================ 落盘 */

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  mime: string;
}

/**
 * 收完之后交给界面的东西。
 *
 * `open()` 是懒的：内存模式直接给手上的 Blob；流式下载那种没有可预览的东西，返回 undefined。
 * 关键在于**不要为了预览把文件读进内存**，磁盘上的文件交给浏览器之后，
 * 视频拖进度条是浏览器自己按需读盘。
 */
export interface ReceivedArtifact {
  name: string;
  mime: string;
  size: number;
  open(): Promise<Blob>;
}

export interface WriteSession {
  write(chunk: Uint8Array): Promise<void>;
  /** 提交。返回可预览的产物，返回 undefined 表示这次不提供 */
  commit(): Promise<ReceivedArtifact | undefined>;
  abort(reason?: string): Promise<void>;
}

/**
 * 接收端写盘。能力差别很大，所以用能力声明而不是平台判断。
 *
 * 早先还有 canSilentWrite / canChooseDirectory 这一对，对应"选一个目录直接写盘"。
 * 后来大文件改成直接流给浏览器的下载管理器，那条路就不再需要了：它要用户手势，
 * 只有桌面 Chromium 有，收益却重复了。
 */
export interface SinkPort {
  /**
   * 单次接收最多能放多少字节。返回 undefined 表示不限。
   *
   * 能流式交给浏览器的实现返回 undefined；只能攒内存的实现要声明一个上限，
   * 与其传到一半神秘崩溃，不如在 meta 一到就明确拒绝。
   */
  maxBufferedBytes?(): number | undefined;
  begin(meta: FileMeta): Promise<WriteSession>;
  /** 文本内容不进文件系统 */
  receiveText(text: string): Promise<void>;
}

/* ============================================================ 持久化 */

export interface StorePort {
  get<T>(collection: string, key: string): Promise<T | undefined>;
  put<T>(collection: string, key: string, value: T): Promise<void>;
  list<T>(collection: string): Promise<T[]>;
  remove(collection: string, key: string): Promise<void>;
  clear(collection: string): Promise<void>;
}
