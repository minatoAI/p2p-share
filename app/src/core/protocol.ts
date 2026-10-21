/**
 * 两类消息，两条通道，不要混：
 *   SignalMessage  走灯塔（WebSocket）。只在建立连接之前有用，连接建好后灯塔退场。
 *   ControlMessage 走数据通道（DataChannel）。传输过程中的控制帧，和二进制分片同路。
 *
 * 这里自己定义 SessionDescription / IceCandidate，而不是直接用 DOM 的类型，
 * 目的是让核心层不依赖 DOM，从而能在 Node 里跑。
 */

export interface SessionDescription {
  type: 'offer' | 'answer';
  sdp: string;
}

/**
 * 公钥的 JWK 表示。
 * 这里不复用 DOM 的 JsonWebKey，是为了让核心层和灯塔都能引用它而不依赖 DOM 类型。
 */
export interface PublicKeyJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  [key: string]: unknown;
}

export interface IceCandidateInit {
  candidate: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

export interface MemberInfo {
  deviceId: string;
  name: string;
  online: boolean;
}

/**
 * 对端跑在什么环境里。
 *
 * 网页端的身份只活在当前页面里，刷新就换一台设备，所以那条配对记录本质上是一次性的；
 * 原生端把身份存在系统里，可以长期保留。旧版本不带这个字段，界面按「端未标注」处理。
 */
export type PeerPlatform = 'web' | 'native';

/* ------------------------------------------------------------ 公开分享 */

/**
 * 注册表里的两个持久状态。
 *
 * 只有这两个存在数据库里。**在线与否不是注册表的状态**，它由在线状态板回答，
 * 两者合起来才是访客看到的四个值，见 ShareStatus。
 * 分成两个而不是一个，是因为可恢复性完全不同：离线会自己回来，撤销是永久的。
 */
export type ShareState = 'available' | 'revoked';

/** 一条分享的元信息。注意这里一个字节的用户数据都没有，见 docs/11 第 2 节。 */
export interface ShareRecord {
  token: string;
  /** 末 8 位短编号；公开取件时可以只发这一串 */
  code?: string;
  /** 分享者的设备号。访客靠它去在线状态板上找分享者，所以不需要房间号 */
  deviceId: string;
  deviceName: string;
  /**
   * 分享者的公钥。
   *
   * 访客拿它做一件配对里由六位数字做的事：**锚定"我连过去的这台设备"**。
   * 公开分享没有人可以当面核对数字，所以锚点只能换到这个 HTTPS 响应上。
   * 灯塔如果要换掉分享者的公钥，访客这边签名验不过，直接失败。
   */
  publicKey: PublicKeyJwk;
  name: string;
  size: number;
  mime: string;
  state: ShareState;
  createdAt: number;
  expiresAt: number;
}

/** 访客查分享时看到的东西：注册表状态 + 分享者此刻是否在线。 */
export interface ShareStatus {
  token: string;
  /** available / offline / revoked / expired */
  status: 'available' | 'offline' | 'revoked' | 'expired';
  name: string;
  size: number;
  mime: string;
  deviceName: string;
  deviceId: string;
  /** 注册表里存了公钥才有（旧条目可能没有），没有就只能退回灯塔转交的那份 */
  publicKey?: PublicKeyJwk;
  expiresAt: number;
}

/** 我自己挂出去的那些分享，列表用。不含在线与否，那是 ShareStatus 的活。 */
export interface ShareSummary {
  token: string;
  code?: string;
  name: string;
  size: number;
  mime: string;
  state: ShareState | 'expired';
  createdAt: number;
  expiresAt: number;
}

/* ------------------------------------------------------------ 信令 */

export type SignalMessage =
  | { t: 'hello'; deviceId: string; name: string; publicKey: PublicKeyJwk }
  /* ---- 房间那一套：只服务首次配对，正在退役 ---- */
  | { t: 'roster'; members: MemberInfo[] }
  | { t: 'peer-joined'; member: MemberInfo }
  | { t: 'peer-left'; deviceId: string }
  /* ---- 在线状态板那一套：按设备号路由，房间不在其中 ---- */
  | { t: 'watch'; ids: string[] }
  | { t: 'presence'; id: string; online: boolean; name?: string }
  | { t: 'presence-list'; entries: Array<{ id: string; online: boolean; name?: string }> }
  /**
   * 配对码：短、会轮换、只用来碰头。
   *
   * 它不承担保密责任。灯塔替换任何一方的公钥都会被六位短认证串发现，
   * 所以码只需要难猜到够用、并且有防刷，见 core/pairing.ts 里那一节。
   */
  | { t: 'new-code' }
  | { t: 'code'; code: string; expiresAt: number }
  | { t: 'lookup-code'; code: string }
  | { t: 'code-owner'; code: string; deviceId: string; name: string; publicKey: PublicKeyJwk }
  | {
      t: 'code-miss';
      code: string;
      reason: string;
      /** 冷却中还剩多少毫秒。有值时界面上要倒着数，别再让用户点 */
      retryAfterMs?: number;
    }
  | {
      t: 'pair-request';
      from: string;
      to: string;
      /** 对方手里那个码，用来证明这次请求确实来自被我邀请的人 */
      code: string;
      name: string;
      publicKey: PublicKeyJwk;
      /** 可选：旧版本不发，读不到就不标注 */
      platform?: PeerPlatform;
    }
  | {
      t: 'pair-response';
      from: string;
      to: string;
      accepted: boolean;
      reason?: string;
      /** 和 pair-request 同义，让输码方也学会对端的端类型 */
      platform?: PeerPlatform;
    }
  /* ---- 公开分享那一套：访客不配对，token 就是准入凭据 ---- */
  /**
   * 访客持 token 来取件。
   *
   * 为什么不复用 pair-request：那条消息的前提是"我拿到了你屏幕上的一串数字"，
   * 而公开链接的访客什么也没有，只有一条链接。把两者分开，核心层里
   * "准入凭什么"这个问题才有两个答案，见 docs/11 第 5 节那张四行表。
   */
  | {
      t: 'share-connect';
      from: string;
      to: string;
      token: string;
      name: string;
      publicKey: PublicKeyJwk;
    }
  /**
   * 通知某个访客：这条分享不再服务你了。
   *
   * 四种原因要分开，因为访客该看到的话不一样。'not-here' 是这一页已经不认得
   * 这个 token 了（多半是分享者刷新了页面），诚实的说法是"分享者那边没有了"，
   * 而不是谎称被撤销。'busy' 是网页端一次只服务一个人，前面那个人还在取。
   */
  | {
      t: 'share-revoked';
      from: string;
      to: string;
      token: string;
      reason: 'revoked' | 'expired' | 'not-here' | 'busy';
    }
  /** 访客主动离开，分享者据此确认这一条链接空出来了 */
  | { t: 'share-leave'; from: string; to: string; token: string }
  /**
   * 请你来发起连接。
   *
   * 建数据通道、发 offer 的只能是同一侧（否则两端各建一条通道就乱了），
   * 而用户可能在任意一侧点"发送"。所以非发起方想连的时候先发这一条，
   * 由发起方真的去建。代价是多一个往返，换来的是永远不会有 offer 撞车。
   */
  | { t: 'connect-request'; from: string; to: string }
  | {
      t: 'sdp';
      from: string;
      to: string;
      description: SessionDescription;
      /** 对 description 的签名，base64。灯塔无法伪造，见 docs/11 第 5 节 */
      sig: string;
    }
  | { t: 'ice'; from: string; to: string; candidate: IceCandidateInit }
  | { t: 'bye'; from: string }
  | { t: 'error'; code: string; message: string };

export function encodeSignal(m: SignalMessage): string {
  return JSON.stringify(m);
}

/**
 * 信令里属于公开分享的那几条。
 *
 * 单独列一个类型是为了让核心层能只对它们开一个口子：灯塔不判断访客有没有
 * 资格（它不解析 token），资格全在分享者这一侧，见 core/share.ts。
 */
export type ShareSignal = Extract<
  SignalMessage,
  { t: 'share-connect' | 'share-revoked' | 'share-leave' }
>;

export function decodeSignal(raw: string): SignalMessage | null {
  try {
    const v = JSON.parse(raw) as SignalMessage;
    return v && typeof (v as { t?: unknown }).t === 'string' ? v : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 载荷控制帧 */

export type ControlMessage =
  | { t: 'meta'; id: string; name: string; size: number; mime: string }
  | { t: 'done'; id: string; size: number }
  | { t: 'ack'; id: string; received: number }
  /** 文字没有分片可确认，收到后单独回一条；发送端据此判断"对方收到了" */
  | { t: 'text-ack'; id: string }
  | { t: 'text'; id: string; text: string }
  | { t: 'error'; id?: string; message: string }
  /**
   * 对端取消传输。`id` 省略表示取消这条链路上的所有进行中传输；
   * `reason` 是取消原因，旧版本不带，按 `user` 处理。见 docs/36。
   */
  | { t: 'cancel'; id?: string; reason?: string }
  /**
   * 认证走数据通道，不走信令。
   *
   * 这是有意的：一次性随机串是在已经过 DTLS 加密的通道上交换的，
   * 能正确应答的人必然就是这条链路的另一端。假如认证走信令（通道建立之前），
   * 就必须额外把 DTLS 指纹绑进签名才安全。
   */
  | { t: 'auth-challenge'; nonce: string; issuedAt: number }
  | { t: 'auth-response'; sig: string }
  | { t: 'auth-result'; ok: boolean; reason?: string }
  /**
   * 连通测试。和认证分开：认证回答"对端是不是它"，这一对回答"这条链路现在通不通、
   * 往返多久"。走数据通道，所以量到的是真正的点对点延迟，不是灯塔的。
   */
  | { t: 'ping'; id: string }
  | { t: 'pong'; id: string };

/**
 * 取消原因到用户可见文案的映射。
 *
 * 三端必须显示同一句话，见 docs/36 第 3 节。不认识的 reason 和缺失的
 * reason 都归到「已取消」，避免旧版本或将来新增的原因露出生字段名。
 */
export function cancelReasonText(reason?: string): string {
  switch (reason) {
    case 'screen-off':
      return '已取消（屏幕关闭）';
    case 'peer-offline':
      return '已取消（对方离线）';
    default:
      return '已取消';
  }
}

export function encodeControl(m: ControlMessage): string {
  return JSON.stringify(m);
}

export function decodeControl(raw: string): ControlMessage | null {
  try {
    const v = JSON.parse(raw) as ControlMessage;
    return v && typeof (v as { t?: unknown }).t === 'string' ? v : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------ 二进制分片 */

/** 两个 uint32：分片序号、分片总数。发送端按方向串行，所以不需要带传输 ID。 */
export const CHUNK_HEADER_BYTES = 8;

export function encodeChunk(index: number, total: number, payload: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(CHUNK_HEADER_BYTES + payload.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, index, true);
  view.setUint32(4, total, true);
  out.set(payload, CHUNK_HEADER_BYTES);
  return out.buffer;
}

export function decodeChunk(buf: ArrayBuffer): {
  index: number;
  total: number;
  payload: Uint8Array;
} {
  const bytes = new Uint8Array(buf);
  if (bytes.byteLength < CHUNK_HEADER_BYTES) {
    throw new Error(`分片太短：${bytes.byteLength} 字节`);
  }
  const view = new DataView(buf);
  return {
    index: view.getUint32(0, true),
    total: view.getUint32(4, true),
    payload: bytes.subarray(CHUNK_HEADER_BYTES),
  };
}
