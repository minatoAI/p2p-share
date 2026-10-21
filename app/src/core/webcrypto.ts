/**
 * IdentityCrypto 的 WebCrypto 实现。
 *
 * 放在 core 里是因为 crypto.subtle 是标准接口，不算浏览器专有 API：
 * Node 18+、Cloudflare Workers 和现代浏览器都提供它。
 * 这样同一份实现既能在测试里跑，也能在页面里跑。
 *
 * 平台差别只有一处："私钥存在哪"。这一档哪里都不存，密钥只活在内存里，
 * 所以这个类只持有 CryptoKey 句柄，没有恢复入口。要持久化的是原生端。
 */

import type { IdentityCrypto } from './ports';
import type { PublicKeyJwk } from './protocol';

const ALGORITHM: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN_ALGORITHM: EcdsaParams = { name: 'ECDSA', hash: 'SHA-256' };

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) {
    // 非安全上下文（例如用 http://192.168.x.x 打开）里没有它。
    // 这不是可以兜底的错误：没有它就没有认证，也就没有"配对一次就是认证"。
    throw new Error('当前不是安全上下文，crypto.subtle 不可用。配对认证需要 HTTPS。');
  }
  return value;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class WebCryptoIdentity implements IdentityCrypto {
  private constructor(
    private readonly privateKey: CryptoKey,
    readonly publicKeyJwk: PublicKeyJwk,
  ) {}

  static async generate(): Promise<WebCryptoIdentity> {
    const api = subtle();
    // extractable 传 false：私钥不可导出，只能通过句柄使用
    const pair = await api.generateKey(ALGORITHM, false, ['sign', 'verify']);
    const jwk = (await api.exportKey('jwk', pair.publicKey)) as PublicKeyJwk;
    return new WebCryptoIdentity(pair.privateKey, jwk);
  }

  /** 公钥的 SPKI 字节。设备号和指纹都是它的哈希，所以同一个公钥处处算出同一个值。 */
  private async spki(publicKey: PublicKeyJwk): Promise<Uint8Array> {
    const api = subtle();
    // 公钥不是秘密，而且导成 SPKI 要求 extractable 为真
    const key = await api.importKey('jwk', publicKey, ALGORITHM, true, ['verify']);
    return new Uint8Array(await api.exportKey('spki', key));
  }

  async digest(data: Uint8Array): Promise<Uint8Array> {
    return new Uint8Array(await subtle().digest('SHA-256', data as BufferSource));
  }

  /** 设备号就是公钥哈希的前 80 位。它由公钥决定，所以"自称是谁"这件事有约束。 */
  async deviceIdFromKey(publicKey: PublicKeyJwk): Promise<string> {
    const hash = await this.digest(await this.spki(publicKey));
    return hex(hash.slice(0, 10));
  }

  /** 64 位短指纹，显示给人核对用的 */
  async fingerprint(publicKey: PublicKeyJwk): Promise<string> {
    const hash = await this.digest(await this.spki(publicKey));
    return hex(hash.slice(0, 8));
  }

  async sign(data: Uint8Array): Promise<Uint8Array> {
    const signature = await subtle().sign(SIGN_ALGORITHM, this.privateKey, data as BufferSource);
    return new Uint8Array(signature);
  }

  async verify(publicKey: PublicKeyJwk, data: Uint8Array, signature: Uint8Array): Promise<boolean> {
    try {
      const api = subtle();
      const key = await api.importKey('jwk', publicKey, ALGORITHM, false, ['verify']);
      return await api.verify(SIGN_ALGORITHM, key, signature as BufferSource, data as BufferSource);
    } catch {
      // 公钥格式不对、曲线不匹配等，一律当作验证失败
      return false;
    }
  }

  randomBytes(n: number): Uint8Array {
    const bytes = new Uint8Array(n);
    // getRandomValues 在非安全上下文里也有，所以挑战串始终是随机的
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  }
}
