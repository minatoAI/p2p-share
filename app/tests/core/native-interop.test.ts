/**
 * 跨语言互操作：Rust 那边算出来的东西，浏览器这边必须算出同样的值。
 *
 * 样本由 `native/examples/fixture.rs` 生成，用的是写死的私钥，所以每次一样。
 * 重新生成：
 *   cd native && cargo run --quiet --example fixture > ../app/tests/core/fixtures/native-interop.json
 *
 * 为什么这条测试值得单独存在：协议里最容易翻车的不是逻辑，是**编码**。
 * 签名是 64 字节的 r||s 还是 DER、SPKI 是不是同一个字节序列、六位数字哈希前
 * 有没有排序、挑战串的分隔符和结尾，这四处任何一处不一致，两端都会连上却认证失败，
 * 而且现场看起来像"网络问题"。这里把它们钉死在一次断言里。
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WebCryptoIdentity } from '../../src/core/webcrypto';
import { challengeBytes, fromBase64Url, shortAuthenticationString } from '../../src/core/pairing';
import type { PublicKeyJwk } from '../../src/core/protocol';

interface Fixture {
  a: { deviceId: string; fingerprint: string; publicKey: PublicKeyJwk; spkiHex: string };
  b: { deviceId: string; fingerprint: string; publicKey: PublicKeyJwk };
  message: string;
  signature: string;
  signatureHex: string;
  sas: string;
  challengeBytes: string;
}

const fixture: Fixture = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/native-interop.json', import.meta.url)), 'utf-8'),
);

/** 只是为了拿到那几个方法，用它自己的密钥没有关系 */
const cryptoBox = await WebCryptoIdentity.generate();

describe('原生端与浏览器端的协议互操作', () => {
  it('同一把公钥，两边算出的设备号一致', async () => {
    // 设备号 = SPKI 的 SHA-256 前 10 字节。SPKI 差一个字节，这里就全错。
    expect(await cryptoBox.deviceIdFromKey(fixture.a.publicKey)).toBe(fixture.a.deviceId);
    expect(await cryptoBox.deviceIdFromKey(fixture.b.publicKey)).toBe(fixture.b.deviceId);
  });

  it('指纹也一致', async () => {
    expect(await cryptoBox.fingerprint(fixture.a.publicKey)).toBe(fixture.a.fingerprint);
    expect(await cryptoBox.fingerprint(fixture.b.publicKey)).toBe(fixture.b.fingerprint);
  });

  it('浏览器能验通原生端的签名', async () => {
    // 原生端输出的是 64 字节 r||s。要是那边漏了一步转成 DER，这条就会挂，
    // 而且真机上的表现是"连上了但认证失败"，很难查。
    const signature = fromBase64Url(fixture.signature);
    expect(signature.byteLength).toBe(64);
    const ok = await cryptoBox.verify(
      fixture.a.publicKey,
      new TextEncoder().encode(fixture.message),
      signature,
    );
    expect(ok).toBe(true);
  });

  it('改一个字节就验不过', async () => {
    const signature = fromBase64Url(fixture.signature);
    signature[0] = signature[0]! ^ 0xff;
    const ok = await cryptoBox.verify(
      fixture.a.publicKey,
      new TextEncoder().encode(fixture.message),
      signature,
    );
    expect(ok).toBe(false);
  });

  it('两边算出的六位数字一致', async () => {
    // 这是用户唯一要核对的东西，算错就等于配对码验证失效
    const sas = await shortAuthenticationString(
      cryptoBox,
      fixture.a.publicKey,
      fixture.b.publicKey,
    );
    expect(sas).toBe(fixture.sas);
    expect(sas).toMatch(/^\d{6}$/);
  });

  it('两侧公钥顺序反过来，六位数字不变', async () => {
    const reversed = await shortAuthenticationString(
      cryptoBox,
      fixture.b.publicKey,
      fixture.a.publicKey,
    );
    expect(reversed).toBe(fixture.sas);
  });

  it('挑战的规范化字节逐字符一致', () => {
    // 分隔符、字段顺序、结尾那个空的 dtls 行，都必须和原生端一字不差
    const bytes = challengeBytes({
      from: fixture.a.deviceId,
      to: fixture.b.deviceId,
      nonce: 'MDEyMzQ1Njc4OWFiY2RlZg',
      issuedAt: 1_700_000_000_000,
    });
    expect(new TextDecoder().decode(bytes)).toBe(fixture.challengeBytes);
  });
});
