import { describe, expect, it } from 'vitest';
import { WebCryptoIdentity } from '../../src/core/webcrypto';
import {
  AddressBook,
  buildResponse,
  CHALLENGE_TTL_MS,
  challengeBytes,
  codeFromHash,
  createContact,
  formatCode,
  fromBase64Url,
  newChallenge,
  normalizeCode,
  pairingLink,
  publicKeyMatches,
  shortAuthenticationString,
  toBase64Url,
  verifyResponse,
} from '../../src/core/pairing';
import { MemoryStore } from '../../src/adapters/memory/store';

/** 造一台设备的身份，顺便给出它的设备号，模拟"本机" */
async function makeDevice() {
  const crypto = await WebCryptoIdentity.generate();
  const deviceId = await crypto.deviceIdFromKey(crypto.publicKeyJwk);
  return { crypto, deviceId, publicKey: crypto.publicKeyJwk };
}

describe('base64url 编解码', () => {
  it('各种长度都能原样往返', () => {
    for (let n = 0; n <= 12; n++) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = (i * 37 + n) & 255;
      const text = toBase64Url(bytes);
      expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
      expect([...fromBase64Url(text)], `长度 ${n}`).toEqual([...bytes]);
    }
  });

  it('大块随机数据也能往返', () => {
    const bytes = new Uint8Array(1000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 251) % 256;
    expect([...fromBase64Url(toBase64Url(bytes))]).toEqual([...bytes]);
  });
});

describe('设备号由公钥决定', () => {
  it('同一个公钥永远算出同一个设备号', async () => {
    const a = await makeDevice();
    expect(await a.crypto.deviceIdFromKey(a.publicKey)).toBe(a.deviceId);
  });

  it('不同设备的设备号不同', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    expect(a.deviceId).not.toBe(b.deviceId);
  });

  it('设备号可打印且长度稳定', async () => {
    const a = await makeDevice();
    expect(a.deviceId).toMatch(/^[0-9a-f]{20}$/);
  });
});

describe('配对码', () => {
  it('六位数字直接输能认出来', () => {
    expect(normalizeCode('482139')).toBe('482139');
    expect(normalizeCode('  482 139 ')).toBe('482139');
    expect(normalizeCode('482-139')).toBe('482139');
  });

  it('整条链接也能认出来', () => {
    expect(normalizeCode('https://p2p-share-web.pages.dev/#c=482139')).toBe('482139');
    expect(normalizeCode('https://x.pages.dev/?c=482139')).toBe('482139');
    expect(normalizeCode('#c=482139')).toBe('482139');
  });

  it('位数不对的一律不认，绝不从链接里抠数字', () => {
    expect(normalizeCode('48213')).toBeNull();
    expect(normalizeCode('123456789')).toBeNull();
    expect(normalizeCode('')).toBeNull();
    expect(normalizeCode('abc')).toBeNull();
    // 整条链接但没带 c= 参数：主机名和端口里的数字不能被当成码
    expect(normalizeCode('https://192.168.1.5:5173/')).toBeNull();
  });

  it('按 3+3 分组显示，方便念给对方', () => {
    expect(formatCode('482139')).toBe('482 139');
  });

  it('配对链接就是域名加六位数字，短到能念出来', () => {
    const link = pairingLink('https://p2p-share-web.pages.dev', '482139');
    expect(link).toBe('https://p2p-share-web.pages.dev/#c=482139');
    expect(link.length).toBeLessThan(50);
  });

  it('从 hash 抠码用的是同一个长度，不会和常量脱节', () => {
    expect(codeFromHash('#c=482139')).toBe('482139');
    expect(codeFromHash('#s=abcdef&c=482139')).toBe('482139');
    expect(codeFromHash('#c=4821390')).toBeNull();
    expect(codeFromHash('')).toBeNull();
  });
});

describe('挑战应答：冒充已配对设备', () => {
  it('应答方签名，挑战方用通讯录里的公钥验通', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    // A 是挑战方，B 是应答方
    const ctx = newChallenge(a.crypto, a.deviceId, b.deviceId);
    const response = await buildResponse(b.crypto, {
      myId: b.deviceId,
      peerId: a.deviceId,
      nonce: ctx.nonce,
      issuedAt: ctx.issuedAt,
    });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(await verifyResponse(a.crypto, ctx, response.signature, b.publicKey)).toEqual({
      ok: true,
    });
  });

  it('别人冒充 B 签名一定失败', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const attacker = await makeDevice();
    const ctx = newChallenge(a.crypto, a.deviceId, b.deviceId);
    const forged = await attacker.crypto.sign(challengeBytes(ctx));
    const result = await verifyResponse(a.crypto, ctx, forged, b.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('签名');
  });

  it('签名绑定到具体这一对设备，换掉任意一端就验不过', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const c = await makeDevice();
    const ctxAToB = newChallenge(a.crypto, a.deviceId, b.deviceId);
    const response = await buildResponse(b.crypto, {
      myId: b.deviceId,
      peerId: a.deviceId,
      nonce: ctxAToB.nonce,
      issuedAt: ctxAToB.issuedAt,
    });
    if (!response.ok) throw new Error('应当签得出来');

    // 原配的一对验得通
    expect((await verifyResponse(a.crypto, ctxAToB, response.signature, b.publicKey)).ok).toBe(true);
    // 把同一个挑战挪到 A 和 C 之间，签名就对不上了
    const ctxAToC = { ...ctxAToB, to: c.deviceId };
    expect((await verifyResponse(a.crypto, ctxAToC, response.signature, b.publicKey)).ok).toBe(false);
  });

  it('过期的挑战不签也不验', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const old = Date.now() - CHALLENGE_TTL_MS - 1000;
    const ctx = newChallenge(a.crypto, a.deviceId, b.deviceId, undefined, old);

    const response = await buildResponse(b.crypto, {
      myId: b.deviceId,
      peerId: a.deviceId,
      nonce: ctx.nonce,
      issuedAt: ctx.issuedAt,
    });
    expect(response.ok).toBe(false);
    if (!response.ok) expect(response.reason).toContain('过期');

    const signature = await b.crypto.sign(challengeBytes(ctx));
    const result = await verifyResponse(a.crypto, ctx, signature, b.publicKey);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('过期');
  });

  it('随机串被改掉，签名失效', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const ctx = newChallenge(a.crypto, a.deviceId, b.deviceId);
    const response = await buildResponse(b.crypto, {
      myId: b.deviceId,
      peerId: a.deviceId,
      nonce: ctx.nonce,
      issuedAt: ctx.issuedAt,
    });
    if (!response.ok) throw new Error('应当签得出来');
    const tampered = { ...ctx, nonce: toBase64Url(a.crypto.randomBytes(16)) };
    expect((await verifyResponse(a.crypto, tampered, response.signature, b.publicKey)).ok).toBe(false);
  });
});

describe('六位短认证串：挡住灯塔替换应答方公钥', () => {
  it('两边各自算出来的数字一样', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const fromA = await shortAuthenticationString(a.crypto, a.publicKey, b.publicKey);
    const fromB = await shortAuthenticationString(b.crypto, b.publicKey, a.publicKey);
    expect(fromA).toBe(fromB);
    expect(fromA).toMatch(/^\d{6}$/);
  });

  it('灯塔把一方的公钥换成自己的，两边的数字就对不上', async () => {
    const a = await makeDevice();
    const b = await makeDevice();
    const attacker = await makeDevice();

    // A 那边看到的是 B 的公钥，B 那边看到的是 A 的公钥，本来一致
    const aSees = await shortAuthenticationString(a.crypto, a.publicKey, b.publicKey);
    // 灯塔把 B 的公钥换成自己的转发给 A
    const aSeesForged = await shortAuthenticationString(a.crypto, a.publicKey, attacker.publicKey);
    const bSees = await shortAuthenticationString(b.crypto, b.publicKey, a.publicKey);

    expect(aSeesForged).not.toBe(bSees);
    expect(aSees).toBe(bSees);
  });
});

describe('通讯录', () => {
  it('配对一次之后就一直记得对方', async () => {
    const store = new MemoryStore();
    const book = new AddressBook(store);
    const a = await makeDevice();
    const b = await makeDevice();

    const contact = await createContact(b.crypto, {
      peerId: a.deviceId,
      peerName: '我的电脑',
      publicKey: a.publicKey,
    });
    await book.add(contact);

    const list = await book.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.peerId).toBe(a.deviceId);
    expect(list[0]!.fingerprint).toBe(contact.fingerprint);
    // 没有过期时间这一类字段：配对一次就是长期有效
    expect((list[0] as unknown as { expiresAt?: unknown }).expiresAt).toBeUndefined();
  });

  it('记住对端是网页端还是原生端，旧记录不硬猜', async () => {
    const b = await makeDevice();
    const a = await makeDevice();
    const web = await createContact(b.crypto, {
      peerId: a.deviceId,
      peerName: '浏览器',
      publicKey: a.publicKey,
      peerPlatform: 'web',
    });
    expect(web.peerPlatform).toBe('web');
    const legacy = await createContact(b.crypto, {
      peerId: a.deviceId,
      peerName: '旧设备',
      publicKey: a.publicKey,
    });
    expect(legacy.peerPlatform).toBeUndefined();
  });

  it('对端再来时公钥必须一致', async () => {
    const b = await makeDevice();
    const a = await makeDevice();
    const attacker = await makeDevice();
    const contact = await createContact(b.crypto, {
      peerId: a.deviceId,
      peerName: '我的电脑',
      publicKey: a.publicKey,
    });
    expect(await publicKeyMatches(b.crypto, contact, a.publicKey)).toBe(true);
    // 同一个设备号却换了公钥，这是中间人的信号，必须拒绝
    expect(await publicKeyMatches(b.crypto, contact, attacker.publicKey)).toBe(false);
  });

  it('更新最后在线时间不会动公钥和指纹', async () => {
    const store = new MemoryStore();
    const book = new AddressBook(store);
    const a = await makeDevice();
    const b = await makeDevice();
    const contact = await createContact(b.crypto, {
      peerId: a.deviceId,
      peerName: '我的电脑',
      publicKey: a.publicKey,
      now: 1000,
    });
    await book.add(contact);
    await book.touch(a.deviceId, 2000);
    const after = await book.get(a.deviceId);
    expect(after!.lastSeenAt).toBe(2000);
    expect(after!.fingerprint).toBe(contact.fingerprint);
    expect(after!.pairedAt).toBe(1000);
  });

  it('可以移除设备', async () => {
    const book = new AddressBook(new MemoryStore());
    const a = await makeDevice();
    const b = await makeDevice();
    await book.add(
      await createContact(b.crypto, { peerId: a.deviceId, peerName: 'x', publicKey: a.publicKey }),
    );
    await book.remove(a.deviceId);
    expect(await book.get(a.deviceId)).toBeUndefined();
    expect(await book.list()).toEqual([]);
  });

  it('最近见到的排在前面', async () => {
    const book = new AddressBook(new MemoryStore());
    const me = await makeDevice();
    for (const [idx, name] of ['甲', '乙', '丙'].entries()) {
      const peer = await makeDevice();
      await book.add(
        await createContact(me.crypto, {
          peerId: peer.deviceId,
          peerName: name,
          publicKey: peer.publicKey,
          now: 1000 + idx,
        }),
      );
    }
    const ids = (await book.list()).map((c) => c.peerName);
    expect(ids).toEqual(['丙', '乙', '甲']);
  });
});

describe('完整流程：配对一次，之后免配对', () => {
  it('拿到码 → 核对六位数字 → 三天后靠挑战应答互相确认', async () => {
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();
    const bookA = new AddressBook(storeA);
    const bookB = new AddressBook(storeB);

    const a = await makeDevice();
    const b = await makeDevice();

    // 1. A 报码，B 输码。公钥由服务器转交，安全性不靠它。
    const code = '482139';
    expect(normalizeCode(code)).toBe(code);

    // 2. B 拿到了 A 的公钥（这里直接给，真实流程里来自服务器的 code-owner）
    //    两边各自算六位数字，必须一样才继续
    const sasOnA = await shortAuthenticationString(a.crypto, a.publicKey, b.publicKey);
    const sasOnB = await shortAuthenticationString(b.crypto, b.publicKey, a.publicKey);
    expect(sasOnA).toBe(sasOnB);

    // 3. 核对通过，双方各存一条记录
    await bookA.add(
      await createContact(a.crypto, {
        peerId: b.deviceId,
        peerName: '我的手机',
        publicKey: b.publicKey,
        now: 1000,
      }),
    );
    await bookB.add(
      await createContact(b.crypto, {
        peerId: a.deviceId,
        peerName: '我的电脑',
        publicKey: a.publicKey,
        now: 1000,
      }),
    );

    // 4. 三天后 A 上线，不需要任何码，直接从通讯录里拿公钥验证对方
    const later = 1000 + 3 * 24 * 3600 * 1000;
    const contactOfB = await bookA.get(b.deviceId);
    expect(contactOfB).toBeDefined();

    // A 挑战 B，B 应答，A 用通讯录里的公钥验
    const ctx = newChallenge(a.crypto, a.deviceId, b.deviceId, undefined, later);
    const response = await buildResponse(b.crypto, {
      myId: b.deviceId,
      peerId: a.deviceId,
      nonce: ctx.nonce,
      issuedAt: ctx.issuedAt,
      now: later,
    });
    if (!response.ok) throw new Error('应当签得出来');
    const result = await verifyResponse(
      a.crypto,
      ctx,
      response.signature,
      contactOfB!.publicKey,
      later,
    );
    expect(result).toEqual({ ok: true });
  });

  it('服务器把码指给另一台设备也骗不过六位数字', async () => {
    // 这是新模型的关键性质：公钥经服务器转交，所以服务器可以替换它。
    // 六位数字是唯一的安全锚点，替换任何一方的公钥都会让两边的数字不一致。
    const a = await makeDevice();
    const b = await makeDevice();
    const fake = await makeDevice();

    // A 看到的是"B 的公钥"，B 看到的是"假的 A 公钥"
    const aSees = await shortAuthenticationString(a.crypto, a.publicKey, b.publicKey);
    const bSeesForged = await shortAuthenticationString(b.crypto, fake.publicKey, b.publicKey);
    expect(aSees).not.toBe(bSeesForged);

    // 没有替换时两边一致
    const bSees = await shortAuthenticationString(b.crypto, a.publicKey, b.publicKey);
    expect(aSees).toBe(bSees);
  });
});
