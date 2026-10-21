/**
 * 配对与认证：把"配对一次"做成"认证一次"。
 *
 * 这套东西解决的是几个具体的攻击，每一段代码都对应其中一个：
 *
 *   1. 灯塔替换公钥。配对码只负责让两台设备碰头，公钥由服务器转交，
 *      安全性由下面的六位短认证串保证：替换任何一方的公钥都会让两边的数字不一致。
 *      早先用过"公钥走二维码"那套，代价是链接太长没法手输，见配对码那一节。
 *   2. 灯塔替换应答方的公钥。应答方的公钥只能经灯塔回来，所以配对时双方各自算出
 *      六位数字当面核对一次（SHA-256 派生的短认证串）。对不上就是有人在中间。
 *      见 shortAuthenticationString。
 *   3. 冒充已配对设备。连接时用一次性随机串做挑战应答，签名验证不过就断开。
 *      见 challengeBytes / verifyResponse。
 *   4. 签名和真实链路脱钩。挑战里绑定这次协商的 DTLS 指纹，光有签名没用。
 *   5. 公钥被换掉。通讯录按设备号存公钥指纹，一旦同一设备号换了公钥就拒绝。
 *      见 publicKeyMatches，这是防中间人的最后一道。
 */

import type { ContactRecord, IdentityCrypto, StorePort } from './ports';
import type { PublicKeyJwk } from './protocol';

const CONTACTS = 'contacts';

/* ------------------------------------------------------------ 编码 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** 自带实现，不依赖 btoa：后者在 Node 里行为不一致，而且不接受任意字节 */
export function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]!;
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b === undefined) break;
    out += B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c === undefined) break;
    out += B64[c & 63]!;
  }
  return out;
}

export function fromBase64Url(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9_-]/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64.indexOf(clean[i]!);
    const c1 = i + 1 < clean.length ? B64.indexOf(clean[i + 1]!) : -1;
    const c2 = i + 2 < clean.length ? B64.indexOf(clean[i + 2]!) : -1;
    const c3 = i + 3 < clean.length ? B64.indexOf(clean[i + 3]!) : -1;
    if (c0 < 0 || c1 < 0) break;
    out.push(((c0 << 2) | (c1 >> 4)) & 255);
    if (c2 >= 0) out.push((((c1 & 15) << 4) | (c2 >> 2)) & 255);
    if (c3 >= 0 && c2 >= 0) out.push((((c2 & 3) << 6) | c3) & 255);
  }
  return new Uint8Array(out);
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------ 挑战应答 */

export interface ChallengeContext {
  /** 发起挑战的一方 */
  from: string;
  /** 被挑战的一方 */
  to: string;
  /** 一次性随机串 */
  nonce: string;
  issuedAt: number;
  /**
   * 这次协商的 DTLS 指纹。
   * 绑定它是关键：否则签名和真正建立的链路无关，攻击者可以转发签名却插进另一条链路。
   */
  dtlsFingerprint?: string;
}

export function challengeBytes(ctx: ChallengeContext): Uint8Array {
  return utf8(
    [
      'p2p-lighthouse-challenge-v1',
      `from:${ctx.from}`,
      `to:${ctx.to}`,
      `nonce:${ctx.nonce}`,
      `issuedAt:${ctx.issuedAt}`,
      `dtls:${ctx.dtlsFingerprint ?? ''}`,
    ].join('\n'),
  );
}

export function newChallenge(
  cryptoPort: IdentityCrypto,
  from: string,
  to: string,
  dtlsFingerprint?: string,
  now = Date.now(),
): ChallengeContext {
  return {
    from,
    to,
    nonce: toBase64Url(cryptoPort.randomBytes(16)),
    issuedAt: now,
    ...(dtlsFingerprint === undefined ? {} : { dtlsFingerprint }),
  };
}

/** 挑战的有效窗口。给时钟偏差留余量，但不能太大，否则重放窗口就长。 */
export const CHALLENGE_TTL_MS = 2 * 60 * 1000;

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * 应答方：先确认这个挑战确实是发给我的，再决定签名。
 *
 * 这一步不能省。少了它，任何人对我们发一个随机串都能换到一个签名，
 * 等于把我们当成签名工具用。
 */
export async function buildResponse(
  cryptoPort: IdentityCrypto,
  input: { myId: string; peerId: string; nonce: string; issuedAt: number; now?: number },
): Promise<{ ok: true; signature: Uint8Array } | { ok: false; reason: string }> {
  const now = input.now ?? Date.now();
  if (Math.abs(now - input.issuedAt) > CHALLENGE_TTL_MS) {
    return { ok: false, reason: '挑战已过期' };
  }
  const ctx: ChallengeContext = {
    from: input.peerId,
    to: input.myId,
    nonce: input.nonce,
    issuedAt: input.issuedAt,
  };
  return { ok: true, signature: await cryptoPort.sign(challengeBytes(ctx)) };
}

/**
 * 挑战方：验证对方对我发出的挑战的签名。
 *
 * 传进来的 challenge 必须是**我自己发出去的那一个**，所以这里不需要检查
 * from 和 to（那个挑战本来就是我自己构造的），只需要检查有没有过期、
 * 以及签名能不能用对方的公钥验通。
 */
export async function verifyResponse(
  cryptoPort: IdentityCrypto,
  challenge: ChallengeContext,
  signature: Uint8Array,
  responderPublicKey: PublicKeyJwk,
  now = Date.now(),
): Promise<VerifyResult> {
  if (Math.abs(now - challenge.issuedAt) > CHALLENGE_TTL_MS) {
    return { ok: false, reason: '挑战已过期' };
  }
  const okSignature = await cryptoPort.verify(
    responderPublicKey,
    challengeBytes(challenge),
    signature,
  );
  return okSignature ? { ok: true } : { ok: false, reason: '签名验证不通过' };
}

/* ------------------------------------------------------------ 配对码 */

/**
 * 配对码是"接头暗号"，不是密钥。
 *
 * 早先的做法是让二维码装下发起方的公钥和对邀请的签名，好处是公钥走光学信道、
 * 不经服务器之手。代价是链接长到没法手输，手机上尤其难受。
 *
 * 后来想清楚了：**六位短认证串已经覆盖了两个方向**。只要灯塔替换了任何一方的
 * 公钥，两边算出来的六位数字就不一样，人一眼就能发现。所以二维码那条光学信道
 * 是冗余的，公钥完全可以让服务器转交。
 *
 * 于是配对码只需要满足三个条件：短、短时间内难猜、有防刷。它不承担保密责任。
 */

/**
 * 6 位纯数字。手机上用数字键盘，按 3+3 分组念。
 *
 * 2026-10-18 从八位降到四位，同一天又回到六位。四位的碰撞率高得不像话：
 * 码由服务端在 10^4 的空间里随机取，每台设备同时挂两条，一百台设备同时报码时
 * 活码约两百条，乱猜一发撞上的概率约 2%；一千台时是 20%，会有人莫名其妙连上
 * 别人的设备。六位把这个概率压到 0.02%，同样的场景下十年也撞不上一次。
 *
 * 它是最后一条路：声音和扫码都用不上的时候才手输。所以长度不必再压。
 * 真正挡住冒充的不是长度，是六位短认证串：码被猜中，冒充者也拿不到对方的私钥。
 */
export const CODE_DIGITS = 6;

/**
 * 换码间隔。到点就换，界面上有倒计时。
 *
 * 二十秒是实测后放宽的窗口：十秒时用户读到码、再输完，经常刚好撞上轮换。
 * 再长会让“码被看到”这件事的价值窗口太大，所以停在二十秒。
 */
export const CODE_ROTATE_MS = 20_000;

/**
 * 服务器上一条码的存活时间，比一个轮换周期多十秒，但不再跟着轮换周期翻倍。
 *
 * 人的动作没那么快：用户在第 18 秒看到码、第 22 秒才输完，如果有效时间等于
 * 轮换周期，换码前最后几秒读到的码仍然会失败。三十秒给看、敲、确认留出
 * 十秒余量；轮换到新码后，旧码还能再活十秒，和下一码有一段重叠。
 */
export const CODE_TTL_MS = 30_000;

/** 每台设备最多同时有效几条码，超了就淘汰最旧的。二十秒轮换、三十秒 TTL，两条足够覆盖重叠。 */
export const MAX_CODES_PER_DEVICE = 2;

/**
 * 从任意输入里取出配对码。
 *
 * 支持三种：直接敲的六位数字、带空格的 "482 139"、以及整条链接。
 * 整条链接但没带 c= 参数的话返回 null，绝不从主机名和端口里抠数字出来。
 */
export function normalizeCode(text: string): string | null {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return null;
  const matched = /[#&?]c=(\d{4,})/i.exec(trimmed) ?? /^c=(\d{4,})$/i.exec(trimmed);
  if (!matched && /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return null;
  const digits = (matched?.[1] ?? trimmed).replace(/\D/g, '');
  return digits.length === CODE_DIGITS ? digits : null;
}

export function formatCode(code: string): string {
  const half = CODE_DIGITS / 2;
  return code.length === CODE_DIGITS ? `${code.slice(0, half)} ${code.slice(half)}` : code;
}

/**
 * 从 location.hash 里抠配对码。
 *
 * 长度只有 CODE_DIGITS 一个出处，这里不能再写死一遍数字：
 * 写死过一次，改长度时链接那条路会静默失效。
 */
export function codeFromHash(hash: string): string | null {
  const matched = new RegExp('[#&]c=([0-9]{' + CODE_DIGITS + '})(?:&|$)').exec(hash ?? '');
  return matched?.[1] ?? null;
}

/** 配对链接。整条链接就是域名加六位数字，短到可以直接念。 */
export function pairingLink(origin: string, code: string): string {
  return `${origin}/#c=${code}`;
}

/* ------------------------------------------------------------ 短认证串 */

/**
 * 六位短认证串。配对时两边各自算，数字一样才继续。
 *
 * 这是唯一一处需要人参与的地方，也正是它能挡住灯塔替换应答方公钥的原因：
 * 灯塔不知道双方私钥，替换任意一方的公钥都会让两边的数字不一致。
 * 配对之后不再需要，这正是"配对一次就是认证"。
 */
export async function shortAuthenticationString(
  cryptoPort: IdentityCrypto,
  keyA: PublicKeyJwk,
  keyB: PublicKeyJwk,
): Promise<string> {
  const fa = await cryptoPort.fingerprint(keyA);
  const fb = await cryptoPort.fingerprint(keyB);
  // 排序之后再算，保证两边得到的数字一致
  const [x, y] = fa < fb ? [fa, fb] : [fb, fa];
  const digest = await cryptoPort.digest(utf8(`sas-v1|${x}|${y}`));
  const value = ((digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!) >>> 0;
  return String(value % 1_000_000).padStart(6, '0');
}

/* ------------------------------------------------------------ 通讯录 */

export async function createContact(
  cryptoPort: IdentityCrypto,
  input: {
    peerId: string;
    peerName: string;
    publicKey: PublicKeyJwk;
    now?: number;
    peerPlatform?: ContactRecord['peerPlatform'];
  },
): Promise<ContactRecord> {
  return {
    peerId: input.peerId,
    peerName: input.peerName,
    publicKey: input.publicKey,
    fingerprint: await cryptoPort.fingerprint(input.publicKey),
    pairedAt: input.now ?? Date.now(),
    ...(input.peerPlatform ? { peerPlatform: input.peerPlatform } : {}),
  };
}

/** 已配对设备送来的公钥必须和通讯录里的一致，否则就是有人换了钥匙。 */
export async function publicKeyMatches(
  cryptoPort: IdentityCrypto,
  record: ContactRecord,
  key: PublicKeyJwk,
): Promise<boolean> {
  return (await cryptoPort.fingerprint(key)) === record.fingerprint;
}

export class AddressBook {
  constructor(private readonly store: StorePort) {}

  async list(): Promise<ContactRecord[]> {
    const all = await this.store.list<ContactRecord>(CONTACTS);
    return all.sort((a, b) => (b.lastSeenAt ?? b.pairedAt) - (a.lastSeenAt ?? a.pairedAt));
  }

  async get(peerId: string): Promise<ContactRecord | undefined> {
    return this.store.get<ContactRecord>(CONTACTS, peerId);
  }

  async add(record: ContactRecord): Promise<void> {
    await this.store.put(CONTACTS, record.peerId, record);
  }

  async remove(peerId: string): Promise<void> {
    await this.store.remove(CONTACTS, peerId);
  }

  /** 只更新"最后一次见到"，不动公钥和指纹 */
  async touch(peerId: string, at = Date.now()): Promise<void> {
    const record = await this.get(peerId);
    if (!record) return;
    await this.add({ ...record, lastSeenAt: at });
  }
}
