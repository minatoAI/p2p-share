import type {
  DeviceIdentity,
  FileMeta,
  PathInfo,
  PeerLink,
  PeerSession,
  PeerState,
  SessionOptions,
  ReconnectInfo,
  ReconnectTrigger,
  SignalLink,
  SignalState,
  SinkPort,
  TransportPort,
  WriteSession,
} from '../../core/ports';
import { classifyPath } from '../../core/candidates';
import type { IceCandidateInit, SessionDescription, SignalMessage } from '../../core/protocol';
import { CHUNK_HEADER_BYTES, encodeSignal } from '../../core/protocol';
import { WebCryptoIdentity } from '../../core/webcrypto';

/* ============================================================ 身份 */

/**
 * 设备身份：一个 ECDSA P-256 密钥对，只活在这个页面里。
 *
 * 它不落盘，所以刷新一下就换一台"设备"：配对要重新配，挂出去的链接要重新挂。
 * 这是网页端有意选的形状，见 docs/20 第 2 节。原生端才做持久身份，因为那边有可信的
 * 本地存储和常驻进程。
 *
 * 身份的唯一用途是给 SDP 签名。因为 SDP 里带着 DTLS 指纹，
 * 灯塔要是能替换指纹就能把自己插进中间解密全部流量。
 * 灯塔可以自建、可能不受信，所以这一层不是可选项，见 docs/11 第 5 节。
 */
export async function createIdentity(): Promise<DeviceIdentity> {
  // crypto.subtle 只在安全上下文里存在。用 http://192.168.x.x 打开时没有它，
  // 于是退化成"有设备号、没有密码学能力"的身份：文件传输照常，
  // 但配对认证用不了，因为认证本来就依赖签名。
  if (!globalThis.crypto?.subtle) return degradedIdentity(randomId());

  const cryptoIdentity = await WebCryptoIdentity.generate();
  const publicKey = cryptoIdentity.publicKeyJwk;
  // 设备号始终由公钥现推，不走任何存下来的值
  return wrapIdentity(cryptoIdentity, await cryptoIdentity.deviceIdFromKey(publicKey));
}

function wrapIdentity(crypto: WebCryptoIdentity, deviceId: string): DeviceIdentity {
  return {
    deviceId,
    publicKey: crypto.publicKeyJwk,
    canSign: true,
    sign: (data) => crypto.sign(data),
    verify: (key, data, sig) => crypto.verify(key, data, sig),
    digest: (data) => crypto.digest(data),
    deviceIdFromKey: (key) => crypto.deviceIdFromKey(key),
    fingerprint: (key) => crypto.fingerprint(key),
    randomBytes: (n) => crypto.randomBytes(n),
  };
}

function degradedIdentity(deviceId: string): DeviceIdentity {
  const denied = (): Promise<never> =>
    Promise.reject(new Error('当前不是安全上下文，crypto.subtle 不可用'));
  return {
    deviceId,
    publicKey: { kty: 'none' },
    canSign: false,
    sign: denied,
    verify: async () => false,
    digest: denied,
    deviceIdFromKey: async () => '',
    fingerprint: async () => '',
    randomBytes: (n) => {
      const bytes = new Uint8Array(n);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    },
  };
}

export function randomId(bytes = 8): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ============================================================ 信令链路 */

/**
 * 每一条**到达 WebSocket 的原始帧**都记一笔，位置在 JSON.parse 之前、
 * 在任何处理之前。
 *
 * 为什么非要插到这一层：之前所有日志都在 handleSignal 里，那是解析之后的一步。
 * 如果帧根本没到达，或者到了但在解析前就没了，那些日志一律看不见，于是
 * "浏览器没收到 sdp"这个结论就无法区分是"没到"还是"到了没处理"。
 *
 * 挂在 globalThis 上是为了让测试能直接读：page.evaluate(() => __signalFrames)
 */
type RawFrame = { at: number; len: number; head: string };
const rawFrames: RawFrame[] = [];

function recordRawFrame(raw: string): void {
  rawFrames.push({ at: Date.now(), len: raw.length, head: raw.slice(0, 48) });
  if (rawFrames.length > 300) rawFrames.shift();
  (globalThis as unknown as { __signalFrames?: RawFrame[] }).__signalFrames = rawFrames;
}

/**
 * 掉线之后等的几档时间。
 *
 * 前几档故意很短：手机上切出去选个文件、切回来，用户期待的是"立刻接上"，
 * 而不是先看十秒钟的等待。后面封顶 10 秒，免得灯塔整体不可用时被反复砸。
 */
export const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000, 10_000];

/**
 * 建立连接本身的时限。
 *
 * 没有它会有一个很难查的坑：网络半死的时候 TCP 握手既不成功也不失败，
 * onclose 永远不来，于是界面上一直停在"正在重连"却没有任何进展。
 */
export const CONNECT_TIMEOUT_MS = 8_000;

export class WebSocketSignalLink implements SignalLink {
  private socket: WebSocket | null = null;
  private messageHandler: (msg: SignalMessage) => void = () => {};
  private errorHandler: (text: string) => void = () => {};
  private stateHandler: (s: SignalState) => void = () => {};
  private reconnectHandler: ((info: ReconnectInfo) => void) | null = null;
  private queue: SignalMessage[] = [];
  state: SignalState = 'connecting';

  /** 每次建立 socket 递增。旧 socket 的迟到回调靠它作废，不会污染新连接。 */
  private generation = 0;
  /** 本次掉线以来建过几条连接；连上之后归零。界面显示的就是它 */
  private attempt = 0;
  /** 本次掉线以来失败了几次。退避阶梯按它走 —— 和 attempt 分开，
   *  否则首次连接就失败的那一次会被算成"已经失败过一轮"，白等一档。 */
  private failures = 0;
  /** 是否连上过。用来区分「首次连接」和「掉线回来」 */
  private everOpened = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** 主动 close() 之后不再重连 */
  private disposed = false;

  constructor(private readonly url: string) {
    this.attachLifecycle();
    this.connect('closed');
  }

  /* ---------------------------------------------------------- 生命周期钩子 */

  /**
   * 页面从后台回来、网络恢复，都要立刻重试。
   *
   * 这一条是这次修的核心。手机上打开系统文件选择器时页面会被切到后台，
   * Edge 在那期间会把 WebSocket 关掉；而冻结期间 setTimeout 根本不跑，
   * 退避定时器等于停摆。不补这个钩子，用户切回来看到的就是一句
   * "正在重连"配上永远不动的界面。
   */
  private readonly onVisibility = (): void => {
    const doc = (globalThis as { document?: { visibilityState?: string } }).document;
    if (doc?.visibilityState !== 'visible') return;
    // 还连着就重新播报一次身份和订阅：服务器那边可能已经把这条连接
    // 当成掉线了，重播一遍比等它自己发现快得多。
    if (this.state === 'open') {
      this.stateHandler('open');
      return;
    }
    this.reconnectNow('resume');
  };

  private readonly onNetworkOnline = (): void => {
    if (this.state !== 'open') this.reconnectNow('online');
  };

  private attachLifecycle(): void {
    const doc = (globalThis as {
      document?: { addEventListener?: (t: string, cb: () => void) => void };
    }).document;
    doc?.addEventListener?.('visibilitychange', this.onVisibility);
    const win = globalThis as {
      addEventListener?: (t: string, cb: () => void) => void;
    };
    win.addEventListener?.('online', this.onNetworkOnline);
  }

  private detachLifecycle(): void {
    const doc = (globalThis as {
      document?: { removeEventListener?: (t: string, cb: () => void) => void };
    }).document;
    doc?.removeEventListener?.('visibilitychange', this.onVisibility);
    const win = globalThis as {
      removeEventListener?: (t: string, cb: () => void) => void;
    };
    win.removeEventListener?.('online', this.onNetworkOnline);
  }

  /* ---------------------------------------------------------- 建立连接 */

  private connect(trigger: ReconnectTrigger): void {
    if (this.disposed) return;
    this.clearRetry();
    this.clearConnectTimer();

    this.attempt += 1;
    this.state = 'connecting';
    this.emit({
      attempt: this.attempt,
      phase: 'trying',
      nextAt: null,
      delayMs: 0,
      trigger,
      resumed: this.everOpened,
    });

    const generation = ++this.generation;
    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (err) {
      // 构造就抛（例如浏览器在隐私模式下禁用），当成一次失败走退避，
      // 而不是让整个初始化炸掉。
      this.errorHandler(`建立信令连接失败：${err instanceof Error ? err.message : String(err)}`);
      this.down(trigger, generation);
      return;
    }
    this.socket = socket;

    this.connectTimer = setTimeout(() => {
      if (generation !== this.generation) return;
      this.errorHandler(`连灯塔超过 ${Math.round(CONNECT_TIMEOUT_MS / 1000)} 秒没连上，换一条`);
      this.down('error', generation);
    }, CONNECT_TIMEOUT_MS);

    socket.onopen = () => {
      if (generation !== this.generation) return;
      this.clearConnectTimer();
      this.state = 'open';
      this.attempt = 0;
      this.failures = 0;
      this.everOpened = true;
      this.stateHandler('open');
      const pending = this.queue;
      this.queue = [];
      for (const msg of pending) socket.send(encodeSignal(msg));
    };
    socket.onmessage = (ev) => {
      if (generation !== this.generation) return;
      const raw = typeof ev.data === 'string' ? ev.data : '';
      recordRawFrame(raw);
      let parsed: SignalMessage;
      try {
        parsed = JSON.parse(raw) as SignalMessage;
      } catch (err) {
        // 这里以前是静默 return 的，注释还写着"灯塔不会发非 JSON"。
        // 但一旦某条消息在传输里被截断，JSON 就解析不了，然后无声无息地丢掉，
        // 排查时完全看不见。信令里最大的那条是 sdp（带 ICE 候选），
        // 所以表现成"ice 全收到但 sdp 一条没有"。必须报出来。
        this.errorHandler(
          `信令解析失败（${raw.length} 字节，开头 ${JSON.stringify(raw.slice(0, 60))}）：` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
      try {
        void Promise.resolve(this.messageHandler(parsed)).catch((err: unknown) => {
          // messageHandler 是 async 的。它里面抛出来的异常如果不接，就是一个
          // 静默的未处理 rejection——信令被吞掉而界面上毫无痕迹，正是这次
          // 排查里最难的地方。所以这里必须接住并报出来。
          this.errorHandler(
            `处理信令 ${parsed?.t ?? '?'} 时出错：${err instanceof Error ? err.message : String(err)}`,
          );
        });
      } catch (err) {
        this.errorHandler(
          `处理信令 ${parsed?.t ?? '?'} 时出错：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    socket.onclose = () => this.down('closed', generation);
    // error 之后不一定跟着 close（各家浏览器不一样），所以两条都走，
    // 由 generation 保证同一代只会结算一次。
    socket.onerror = () => this.down('error', generation);
  }

  /** 一条连接失败或断开：结算状态，排下一次重连 */
  private down(trigger: ReconnectTrigger, generation: number): void {
    if (generation !== this.generation) return;
    // 让这条 socket 后续的回调全部失效
    this.generation += 1;
    this.clearConnectTimer();
    this.socket = null;
    this.state = 'closed';
    this.failures += 1;
    this.stateHandler('closed');
    if (this.disposed) return;
    this.scheduleRetry(trigger);
  }

  private scheduleRetry(trigger: ReconnectTrigger): void {
    if (this.disposed) return;
    this.clearRetry();
    const index = Math.min(Math.max(this.failures - 1, 0), RECONNECT_DELAYS_MS.length - 1);
    // 加点抖动：灯塔重启时所有设备的退避会同时归零，错开一点别一起砸上去
    const base = RECONNECT_DELAYS_MS[index] as number;
    const delay = Math.round(base * (0.85 + Math.random() * 0.3));
    const nextAt = Date.now() + delay;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect(trigger);
    }, delay);
    this.emit({
      attempt: this.attempt + 1,
      phase: 'waiting',
      nextAt,
      delayMs: delay,
      trigger,
      resumed: this.everOpened,
    });
  }

  /**
   * 立刻重试，不等退避走完。
   *
   * 页面恢复（resume）会把退避归零：冻结期间定时器根本没跑，用户不该
   * 为那段被系统冻住的时间再补等一轮。
   */
  reconnectNow(trigger: ReconnectTrigger = 'manual'): void {
    if (this.disposed) return;
    if (this.state === 'open') return;
    // 已经在握手了就别再建一条：两条同设备号的连接会在灯塔上互相顶掉，
    // 表现成"连上了又立刻掉"。页面恢复和网络恢复除外——那时候这条
    // 正在握手的连接多半已经随页面一起被冻死了。
    if (this.state === 'connecting' && (trigger === 'manual' || trigger === 'online')) return;

    // 页面恢复时把次数和退避一起归零：冻结期间定时器根本没跑，
    // 让用户为系统冻住的那段时间再补等一轮没有道理。
    if (trigger === 'resume') {
      this.attempt = 0;
      this.failures = 0;
    }
    this.generation += 1;
    this.clearConnectTimer();
    this.abortSocket();
    this.connect(trigger);
  }

  private emit(info: ReconnectInfo): void {
    this.reconnectHandler?.(info);
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private abortSocket(): void {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      /* 已经没了 */
    }
  }

  send(msg: SignalMessage): void {
    if (this.state === 'open' && this.socket) {
      try {
        this.socket.send(encodeSignal(msg));
        return;
      } catch {
        // 连接正好在这一刻断掉：退回队列，等重连之后补发
      }
    }
    this.queue.push(msg);
  }

  onMessage(cb: (msg: SignalMessage) => void): void {
    this.messageHandler = cb;
  }

  onStateChange(cb: (s: SignalState) => void): void {
    this.stateHandler = cb;
  }

  onReconnect(cb: (info: ReconnectInfo) => void): void {
    this.reconnectHandler = cb;
  }

  /** 收到但处理失败时往界面上报，别让它静默消失 */
  onError(handler: (text: string) => void): void {
    this.errorHandler = handler;
  }

  close(): void {
    // 主动关闭（页面卸载、或整个会话收尾）之后不该再自己重连，
    // 否则用户关掉页面还会留下一串重试。
    this.disposed = true;
    this.clearRetry();
    this.clearConnectTimer();
    this.generation += 1;
    this.abortSocket();
    this.state = 'closed';
    this.detachLifecycle();
  }
}

/* ============================================================ 点对点传输 */

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  // Cloudflare 的公共 STUN，官方写明免费不限量。中继在 Phase 3 接。
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** getStats 里候选统计对象的形状。它和 RTCIceCandidate 字段名相同但类型不同。 */
interface CandidateStats {
  candidateType?: string;
  address?: string;
  protocol?: string;
  relayProtocol?: string;
}

/** 只等本机候选多久，超时就放开公网候选 */
export const LAN_FIRST_MS = 3000;

export interface WebRtcTransportOptions {
  iceServers?: RTCIceServer[];
  /** 默认开启：先只用本机候选，连不上再放开公网候选。传 false 就一次全发。 */
  preferLan?: boolean;
  /** 强制只走中继，用来验证 TURN 是否真的可用 */
  forceRelay?: boolean;
}

/**
 * 用真实 RTCPeerConnection 实现 TransportPort。
 *
 * 注意这里没有用 PeerJS 之类的封装。原因见 docs/11 第 9 节：
 * 候选过滤、自定义分片、自己的信令格式、把 DTLS 指纹绑进签名，
 * 这四件事都必须自己控制，封装越厚越难做。
 */
export class WebRtcTransport implements TransportPort {
  constructor(private readonly opts: WebRtcTransportOptions = {}) {}

  describeConfig(): { iceServerCount: number; hasTurn: boolean } {
    const servers = this.opts.iceServers ?? DEFAULT_ICE_SERVERS;
    return {
      iceServerCount: servers.length,
      hasTurn: servers.some((s) => String(s.urls).startsWith('turn')),
    };
  }

  createSession(opts: SessionOptions): PeerSession {
    return new WebRtcSession(opts, this.opts);
  }
}

class WebRtcSession implements PeerSession {
  private readonly pc: RTCPeerConnection;
  private readonly dc: RTCDataChannel | null;
  private link: PeerLink | null = null;
  private linkHandler: (link: PeerLink) => void = () => {};
  private stateHandler: (s: PeerState) => void = () => {};
  private makingOffer = false;
  private ignoreOffer = false;
  private polite: boolean;
  private closed = false;
  /** 自己收集到的全局 IPv6 /64，用来判断对端是否在同一条链路上 */
  private readonly ownPrefixes = new Set<string>();

  constructor(
    private readonly opts: SessionOptions,
    transportOpts: WebRtcTransportOptions,
  ) {
    this.polite = opts.polite;
    // 不再有"仅局域网"这个开关。本机候选优先由 preferLan 负责，
    // STUN 一直开着，所以局域网连不上时能自然退到公网直连。
    const servers = transportOpts.iceServers ?? DEFAULT_ICE_SERVERS;
    this.pc = new RTCPeerConnection({
      iceServers: servers,
      ...(transportOpts.forceRelay ? { iceTransportPolicy: 'relay' as RTCIceTransportPolicy } : {}),
    });

    if (opts.initiator) {
      // 发起方建通道，这也顺带触发了 negotiationneeded
      const dc = this.pc.createDataChannel('data', { ordered: true });
      this.dc = dc;
      dc.onopen = () => {
        this.link = this.wrapChannel(dc);
        this.linkHandler(this.link);
        this.stateHandler('connected');
      };
      dc.onclose = () => this.stateHandler('closed');
    } else {
      // 应答方等对端把通道送过来，不主动建，避免两端同时发 offer
      this.dc = null;
      this.pc.ondatachannel = (ev) => {
        this.link = this.wrapChannel(ev.channel);
        this.linkHandler(this.link);
        this.stateHandler('connected');
      };
    }

    this.pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) {
          this.emitDescription(this.pc.localDescription);
        }
      } finally {
        this.makingOffer = false;
      }
    };

    /**
     * 局域网优先。
     *
     * 本机候选（typ host，包括被浏览器伪装成 .local 的那些）立刻发出去，
     * 公网反射和中继候选先压着。对方在同一个局域网里的话，光靠前面那几条
     * 就能连上，不必让双方都去等公网候选的连通性检查。
     * 三秒还没连上，就把压着的全放出去，走广域网。
     *
     * ICE 本身的优先级已经偏向 host 了（RFC 8445 里 host 是 126、srflx 是 100、
     * relay 是 0），这里只是把那件事提前到"发不发"这一层，省掉等待和多余的探测包。
     */
    const preferLan = transportOpts.preferLan !== false;
    const deferredCandidates: RTCIceCandidate[] = [];
    let widenTimer: ReturnType<typeof setTimeout> | undefined;
    const sendCandidate = (candidate: RTCIceCandidate): void => {
      this.opts.onSignal({ t: 'ice', from: '', to: '', candidate: candidate.toJSON() as IceCandidateInit });
    };
    const widen = (): void => {
      widenTimer = undefined;
      while (deferredCandidates.length) sendCandidate(deferredCandidates.shift()!);
    };
    this.pc.onicecandidate = (ev) => {
      if (!ev.candidate) return;
      const isLocal = /typ host/.test(ev.candidate.candidate);
      if (!preferLan || isLocal || this.pc.connectionState === 'connected') {
        sendCandidate(ev.candidate);
        return;
      }
      deferredCandidates.push(ev.candidate);
      if (widenTimer === undefined) widenTimer = setTimeout(widen, LAN_FIRST_MS);
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      const mapped: PeerState =
        s === 'connected' ? 'connected' : s === 'failed' ? 'failed' : s === 'closed' ? 'closed' : 'connecting';
      this.stateHandler(mapped);
    };
  }

  private emitDescription(desc: RTCSessionDescription): void {
    const description: SessionDescription = {
      type: desc.type === 'answer' ? 'answer' : 'offer',
      sdp: desc.sdp ?? '',
    };
    this.opts.onSignal({ t: 'sdp', from: '', to: '', description, sig: '' });
  }

  private wrapChannel(channel: RTCDataChannel): PeerLink {
    const pc = this.pc;
    const messageHandlers: Array<(data: string | ArrayBuffer) => void> = [];
    const stateHandlers: Array<(s: PeerState) => void> = [];
    const drainHandlers: Array<() => void> = [];
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = 512 * 1024;
    channel.onmessage = (ev) => {
      const data = ev.data as string | ArrayBuffer;
      for (const cb of messageHandlers) cb(data);
    };
    channel.onbufferedamountlow = () => {
      for (const cb of drainHandlers) cb();
    };
    // 状态改成实时读之后，"通道还没 open 就被 attach"这一种情况要有人来补一脚，
    // 否则引擎里的 pump() 再也没人触发。应答方拿到通道的时机各浏览器不完全一致。
    channel.onopen = () => {
      for (const cb of stateHandlers) cb('connected');
    };
    channel.onclose = () => {
      for (const cb of stateHandlers) cb('closed');
    };
    return {
      // 状态必须跟着通道读，不能写死。这里以前是一个常量 'connected'，
      // 于是传输引擎里那三处"链路断了就把这次发送判成失败"的守卫在浏览器里
      // 全部失效：手机被系统切到后台、SCTP 被拆掉之后，电脑端照样显示完成。
      // Node 侧的 MemoryLink 会真的改状态，所以核心层测试看不出这个差别，
      // 这条由端到端测试盯着。
      get state(): PeerState {
        // 关联整个断了才算 failed。connectionState 一时的 disconnected
        // 不做结论，那时通道自己还说是 open，ICE 有可能自己接回来。
        if (pc.connectionState === 'failed') return 'failed';
        switch (channel.readyState) {
          case 'open':
            return 'connected';
          case 'closing':
          case 'closed':
            return 'closed';
          default:
            return 'connecting';
        }
      },
      send: (data) => channel.send(data as never),
      bufferedAmount: () => channel.bufferedAmount,
      // Chrome 通常报 65536，也就是能发 64 KiB 的消息；按它减掉 8 字节头来分片。
      // 上限压到 64 KiB 是因为某些 Safari 版本会报一个不可信的大值，
      // 详见 docs/03 关于 maxMessageSize 的存疑条目。
      maxChunkSize: () => {
        const reported = this.pc.sctp?.maxMessageSize ?? 16 * 1024 + CHUNK_HEADER_BYTES;
        return Math.max(16 * 1024 + CHUNK_HEADER_BYTES, Math.min(reported, 64 * 1024));
      },
      onMessage: (cb) => messageHandlers.push(cb),
      onStateChange: (cb) => stateHandlers.push(cb),
      onDrain: (cb) => drainHandlers.push(cb),
      path: async () => this.readPath(),
      close: () => channel.close(),
    };
  }

  /** 读 getStats 找出真正选中的那对候选，这是判断路径性质的唯一可靠办法。 */
  private async readPath(): Promise<PathInfo> {
    try {
      const stats = await this.pc.getStats();
      let pair: RTCIceCandidatePairStats | undefined;
      stats.forEach((r) => {
        const cand = r as RTCIceCandidatePairStats;
        if (!pair && cand.type === 'candidate-pair' && cand.state === 'succeeded' && cand.localCandidateId) {
          pair = cand;
        }
      });
      if (!pair) return { kind: 'unknown', localType: '', remoteType: '' };
      // getStats 返回的是 candidate 统计对象而不是 RTCIceCandidate，
      // 字段名一样但类型不同，所以这里按统计对象的形状取。
      const local = stats.get(pair.localCandidateId!) as unknown as CandidateStats | undefined;
      const remote = pair.remoteCandidateId
        ? (stats.get(pair.remoteCandidateId) as unknown as CandidateStats | undefined)
        : undefined;
      const localType = local?.candidateType ?? '';
      const localAddress = local?.address ?? '';
      const remoteAddress = remote?.address ?? '';
      const remoteType = remote?.candidateType ?? '';
      return {
        kind: classifyPath(localType, localAddress, remoteType, remoteAddress),
        localType,
        remoteType,
      };
    } catch {
      return { kind: 'unknown', localType: '', remoteType: '' };
    }
  }

  /** 完美协商。两端同时想发东西时必须这么写，见 MDN 的 Perfect negotiation。 */
  async applySignal(msg: SignalMessage): Promise<void> {
    if (this.closed) return;
    if (msg.t === 'sdp') {
      const description = msg.description;
      const offerCollision =
        description.type === 'offer' && (this.makingOffer || this.pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) return;
      await this.pc.setRemoteDescription(description as RTCSessionDescriptionInit);
      if (description.type === 'offer') {
        await this.pc.setLocalDescription();
        if (this.pc.localDescription) this.emitDescription(this.pc.localDescription);
      }
      return;
    }
    if (msg.t === 'ice') {
      try {
        await this.pc.addIceCandidate(msg.candidate as RTCIceCandidateInit);
      } catch {
        /* 对端描述还没设好时可能失败，真实场景里要排队重试，Phase 1 先忽略 */
      }
    }
  }

  onLink(cb: (link: PeerLink) => void): void {
    this.linkHandler = cb;
    if (this.link) cb(this.link);
  }

  onStateChange(cb: (s: PeerState) => void): void {
    this.stateHandler = cb;
  }

  close(): void {
    this.closed = true;
    try {
      this.dc?.close();
    } catch {
      /* 已经关掉 */
    }
    this.pc.close();
  }
}

/* ============================================================ 落盘 */

/**
 * 接收端写盘的三档降级。
 *
 * Phase 1 只实现最下面一档（内存拼 Blob 再触发下载），
 * 因为这一档在全部平台都能跑。目录句柄那一档写在 docs/11 第 4 节，
 * 属于第 4 阶段。
 *
 * 能力声明是接口的一部分，所以核心层不需要判断浏览器类型：
 * 它问 canSilentWrite()，拿到的答案就是真实的。
 */
/**
 * 落盘。
 *
 * 两种模式，按平台能力自动选：
 *
 *   **边收边交给浏览器下载**（有 Service Worker 的浏览器）。页面把字节流喂给
 *   一条 ReadableStream，浏览器自己的下载管理器往磁盘写，内存里只留几个分片。
 *   大文件走这条，没有大小上限。
 *
 *   **内存缓冲**（剩下的情况：小文件，或者不支持上一条的浏览器）。字节先攒在
 *   内存里，收完再交给浏览器下载。好处是收完能在页面里直接打开看一眼。
 *
 * 这里不做"选一个目录直接写盘"：那个能力要用户手势、只有桌面 Chromium 有，
 * 而流式下载已经把"不占内存"这件事解决了，多一个目录选择只多一层心智负担。
 */
/** 超过这个大小就不再往内存里攒，直接流给浏览器的下载管理器。 */
const STREAM_MIN_BYTES = 16 * 1024 * 1024;

export class BrowserSink implements SinkPort {
  private readonly files = new Map<string, Uint8Array[]>();
  private worker: Promise<ServiceWorkerRegistration | null> | null = null;

  /**
   * 能流式交给浏览器就不限大小；不能的话只能按内存来。
   *
   * 这个数字是引擎在传输开始之前问的，那时还没开始写，所以只能按"这个平台
   * 能不能"来答。没有可查的浏览器规格可依，256 MB 是拍的：手机上通常远到不了
   * 这个量就先被系统杀掉了，桌面浏览器则宽裕得多，宁可保守。
   */
  maxBufferedBytes(): number | undefined {
    return this.canStreamDownload() ? undefined : 256 * 1024 * 1024;
  }

  /** 能不能把下载流给浏览器而不是先攒在内存里 */
  canStreamDownload(): boolean {
    return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof ReadableStream !== 'undefined';
  }

  /** 把一个文件流进浏览器的下载管理器 */
  private async beginStreamed(meta: FileMeta): Promise<WriteSession> {
    const reg = await this.ensureWorker();
    const worker = reg?.active;
    if (!worker) throw new Error('没有可用的下载通道');

    const channel = new MessageChannel();
    let onReady: ((id: string) => void) | null = null;
    let onStarted: (() => void) | null = null;
    let onAck: (() => void) | null = null;

    channel.port1.onmessage = (event: MessageEvent) => {
      const msg = event.data as { type?: string; id?: string };
      if (msg.type === 'ready') onReady?.(msg.id ?? '');
      else if (msg.type === 'started') onStarted?.();
      else if (msg.type === 'ack') {
        const done = onAck;
        onAck = null;
        done?.();
      }
    };
    channel.port1.start();

    const ready = new Promise<string>((resolve) => {
      onReady = resolve;
    });
    worker.postMessage(
      { type: 'prepare', name: meta.name, mime: meta.mime, size: meta.size },
      [channel.port2],
    );
    const id = await ready;
    if (!id) throw new Error('下载通道没准备好');

    // 用一个隐藏的 iframe 触发下载：地址被 Service Worker 接管，响应体就是下面这条流
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.setAttribute('aria-hidden', 'true');
    frame.src = `/__download/${id}`;
    document.body.appendChild(frame);

    const started = new Promise<boolean>((resolve) => {
      onStarted = () => resolve(true);
      window.setTimeout(() => resolve(false), 4000);
    });
    const didStart = await started;
    if (!didStart) {
      frame.remove();
      channel.port1.postMessage({ type: 'abort' });
      throw new Error('浏览器没有接下这个下载');
    }

    let aborted = false;
    let written = 0;
    const cleanup = () => {
      window.setTimeout(() => frame.remove(), 2000);
    };

    return {
      write: async (chunk) => {
        if (aborted) return;
        // 引擎复用缓冲区，交出去之前必须复制一份
        const copy = chunk.slice();
        const acked = new Promise<void>((resolve) => {
          onAck = resolve;
        });
        channel.port1.postMessage({ type: 'chunk', chunk: copy }, [copy.buffer]);
        // 下载被取消时 ack 不会来，别让整个传输永远卡住
        const ok = await Promise.race([
          acked.then(() => true),
          new Promise<boolean>((resolve) => window.setTimeout(() => resolve(false), 30_000)),
        ]);
        if (!ok) throw new Error('浏览器的下载停住了');
        written += chunk.byteLength;
      },
      // 文件已经交给浏览器的下载管理器了，这里没有可以预览的东西
      commit: async () => {
        if (!aborted) channel.port1.postMessage({ type: 'end' });
        cleanup();
        return undefined;
      },
      abort: async () => {
        if (aborted) return;
        aborted = true;
        channel.port1.postMessage({ type: 'abort' });
        cleanup();
      },
    };
  }

  private ensureWorker(): Promise<ServiceWorkerRegistration | null> {
    if (!this.canStreamDownload()) return Promise.resolve(null);
    if (!this.worker) {
      this.worker = navigator.serviceWorker
        .register('/sw-download.js')
        .then(() => navigator.serviceWorker.ready)
        .catch(() => null);
    }
    return this.worker;
  }

  async begin(meta: FileMeta): Promise<WriteSession> {
    // 大文件别攒内存，边收边交给浏览器下载。小文件仍然走内存，这样收到之后
    // 还能在页面里直接打开看一眼。
    if (meta.size >= STREAM_MIN_BYTES && this.canStreamDownload()) {
      try {
        return await this.beginStreamed(meta);
      } catch {
        /* 下载通道没起来，退回内存模式 */
      }
    }
    return this.beginBuffered(meta);
  }

  private async beginBuffered(meta: FileMeta): Promise<WriteSession> {
    this.files.set(meta.id, []);
    let aborted = false;
    const chunks = this.files.get(meta.id)!;
    return {
      write: async (chunk) => {
        if (aborted) return;
        chunks.push(chunk.slice());
      },
      commit: async () => {
        if (aborted) return undefined;
        const blob = new Blob(chunks as BlobPart[], {
          type: meta.mime || 'application/octet-stream',
        });
        // 下载和预览都用同一个 Blob，不再多拷贝一份
        downloadBlob(blob, meta.name);
        return {
          name: meta.name,
          mime: meta.mime,
          size: blob.size,
          open: async () => blob,
        };
      },
      abort: async () => {
        aborted = true;
        this.files.delete(meta.id);
      },
    };
  }

  async receiveText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      /* 没有权限就只留在界面上，让用户手动复制 */
    }
  }
}

/* ---------------------------------------------------------- 目录句柄的持久化 */

function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 给浏览器一点时间开始下载再回收
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
