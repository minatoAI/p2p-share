/**
 * 公开链接那一层的测试：资格、名额、撤销。
 *
 * 这里刻意不建真实的点对点连接。会话层怎么握手、怎么认证，已由
 * session.test.ts 覆盖；这一层要验的是"谁准进、谁被挡在外面、谁占着这条链接"，
 * 用假会话层反而能把每一条决定看清楚。两层各自跑通之后，再由 e2e 对起来。
 */
import { describe, expect, it, vi } from 'vitest';
import { WebCryptoIdentity } from '../../src/core/webcrypto';
import { MemoryRegistry } from '../../src/adapters/memory/registry';
import {
  MAX_CONCURRENT_VISITORS,
  OFFLINE_RECHECK_INTERVAL_MS,
  OFFLINE_RECHECK_WINDOW_MS,
  ShareHub,
  parseShareToken,
  shareLink,
  type OutgoingShare,
  type ShareSessions,
  type VisitState,
} from '../../src/core/share';
import type { SharePeer } from '../../src/core/session';
import type { DeviceIdentity } from '../../src/core/ports';
import type { PublicKeyJwk, ShareSignal, SignalMessage } from '../../src/core/protocol';
import type { FileLike } from '../../src/core/transfer';

/* ==================================================== 替身 */

class FakeSessions implements ShareSessions {
  /** 每台对端最后一次登记的分享身份 */
  readonly registered = new Map<string, SharePeer>();
  readonly served: string[] = [];
  readonly closed: Array<{ peerId: string; reason: string }> = [];
  readonly files: string[] = [];
  readonly signals: SignalMessage[] = [];
  /** 让某台设备的连接建不起来，用来验失败会不会占死名额 */
  failServe: string | null = null;

  registerSharePeer(peerId: string, share: SharePeer): void {
    this.registered.set(peerId, share);
  }

  async serveSharePeer(peerId: string): Promise<void> {
    if (this.failServe === peerId) throw new Error('链路建不起来');
    this.served.push(peerId);
  }

  closeSharePeer(peerId: string, reason: string): void {
    this.closed.push({ peerId, reason });
  }

  async sendFile(peerId: string): Promise<string> {
    this.files.push(peerId);
    return `transfer-${peerId}`;
  }

  sendSignal(msg: SignalMessage): void {
    this.signals.push(msg);
  }

  /** 灯塔那边收到的、发给某台设备的分享信令 */
  shareSignalsTo(deviceId: string): ShareSignal[] {
    return this.signals.filter(
      (m): m is ShareSignal => m.t.startsWith('share-') && 'to' in m && m.to === deviceId,
    );
  }
}

async function makeIdentity(): Promise<DeviceIdentity> {
  const crypto = await WebCryptoIdentity.generate();
  return {
    deviceId: await crypto.deviceIdFromKey(crypto.publicKeyJwk),
    publicKey: crypto.publicKeyJwk,
    canSign: true,
    sign: (d) => crypto.sign(d),
    verify: (k, d, s) => crypto.verify(k, d, s),
    digest: (d) => crypto.digest(d),
    deviceIdFromKey: (k) => crypto.deviceIdFromKey(k),
    fingerprint: (k) => crypto.fingerprint(k),
    randomBytes: (n) => crypto.randomBytes(n),
  };
}

function fileLike(name: string, bytes = 1024): FileLike {
  const data = new Uint8Array(bytes);
  return {
    name,
    size: bytes,
    type: 'application/octet-stream',
    slice: async (start, end) => data.slice(start, end).buffer as ArrayBuffer,
  };
}

/** 一个访客的 share-connect。设备号确实由它送来的公钥推导，这是能过验的前提 */
async function connectFrom(
  identity: DeviceIdentity,
  token: string,
  name: string,
): Promise<ShareSignal & { t: 'share-connect' }> {
  return { t: 'share-connect', from: identity.deviceId, to: 'seeder', token, name, publicKey: identity.publicKey };
}

interface Harness {
  hub: ShareHub;
  identity: DeviceIdentity;
  registry: MemoryRegistry;
  sessions: FakeSessions;
  logs: string[];
  shares: OutgoingShare[][];
  visits: VisitState[];
}

/** 同一个注册表可以被多个 hub 共用，那就是"这台设备的两个页面" */
async function harness(
  options: { identity?: DeviceIdentity; registry?: MemoryRegistry } = {},
): Promise<Harness> {
  const identity = options.identity ?? (await makeIdentity());
  const registry = options.registry ?? new MemoryRegistry();
  const sessions = new FakeSessions();
  const logs: string[] = [];
  const shares: OutgoingShare[][] = [];
  const visits: VisitState[] = [];
  const hub = new ShareHub(
    {
      identity,
      registry,
      manager: sessions,
      deviceName: () => '我的电脑',
      origin: 'https://share.test',
    },
    { log: (l) => logs.push(l), shares: (list) => shares.push(list), visit: (s) => s && visits.push(s) },
  );
  return { hub, identity, registry, sessions, logs, shares, visits };
}

/** 界面上某个访客最后一次呈现出来的样子 */
function visitorOf(h: Harness, token: string, deviceId: string) {
  return h.shares
    .at(-1)
    ?.find((s) => s.token === token)
    ?.visitors.find((v) => v.deviceId === deviceId);
}

/**
 * 让这一轮决定彻底落地再断言。
 *
 * serve 里每一步都 await，不等它跑完就看到 connecting，那是测试比实现快，
 * 不是实现的状态。
 */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** 分享者回复给某个访客的那条"不再服务你" */
function refusalTo(h: Harness, deviceId: string) {
  return h.sessions.shareSignalsTo(deviceId).find(
    (m): m is Extract<ShareSignal, { t: 'share-revoked' }> => m.t === 'share-revoked',
  );
}

/* ==================================================== 链接 */

describe('分享链接', () => {
  it('token 放在 hash 里，不放查询串', () => {
    const token = 'a'.repeat(32);
    const link = shareLink('https://share.test', token);
    expect(link).toBe(`https://share.test/#s=${token}`);
    // hash 不会随请求发给服务器，也进不了访问日志和 Referer。
    // token 就是这条链接唯一的准入凭据。
    expect(link).not.toContain('?');
  });

  it('整条链接、#s= 那一段、裸编号三种输入都能认', () => {
    const token = '0123456789abcdef0123456789abcdef';
    expect(parseShareToken(shareLink('https://share.test', token))).toBe(token);
    expect(parseShareToken(`#s=${token}`)).toBe(token);
    expect(parseShareToken(token)).toBe(token);
    expect(parseShareToken(`  ${token.toUpperCase()}  `)).toBe(token);
  });

  it('配对码和残缺的编号不会被当成 token', () => {
    expect(parseShareToken('12345678')).toBeNull();
    expect(parseShareToken('0123456789abcdef0123456789abcde')).toBeNull();
    expect(parseShareToken('https://share.test/#c=12345678')).toBeNull();
    expect(parseShareToken('')).toBeNull();
  });
});

/* ==================================================== 挂出与撤销 */

describe('分享者侧', () => {
  it('挂出分享：公钥进了注册表，链接当场能拼出来', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('相片.jpg'));
    expect(share.link).toBe(shareLink('https://share.test', share.token));

    const row = h.registry.rows.get(share.token)!;
    expect(row.publicKey).toEqual(h.identity.publicKey);
    expect(row.deviceId).toBe(h.identity.deviceId);
    expect(row.name).toBe('相片.jpg');
  });

  it('撤销只打扰还没走完的访客，并关掉在用的连接', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('big.bin'));
    const finished = await makeIdentity();
    const active = await makeIdentity();

    // 第一个人已经取完（连接都关了），第二个人正在取。撤销不该再给第一个人发东西
    await h.hub.onSignal(await connectFrom(finished, share.token, '取完的'));
    h.hub.onTransferStatus({
      id: 't',
      direction: 'out',
      status: 'done',
      peerId: finished.deviceId,
    });
    await settle();
    await h.hub.onSignal(await connectFrom(active, share.token, '正在取的'));

    await h.hub.revoke(share.token);
    expect(refusalTo(h, active.deviceId)?.reason).toBe('revoked');
    expect(h.sessions.closed.some((c) => c.peerId === active.deviceId)).toBe(true);
    expect(
      h.sessions.signals.filter((m) => m.t === 'share-revoked' && m.to === finished.deviceId),
    ).toHaveLength(0);
    expect(h.registry.rows.get(share.token)!.revoked).toBe(true);
  });

  it('页面要走时把链接全部交出去，之后这一页谁也不认', async () => {
    const h = await harness();
    const a = await h.hub.createShare(fileLike('a.bin'));
    const b = await h.hub.createShare(fileLike('b.bin'));

    // 界面拿这些 token 去发撤销请求。身份只在内存里，刷新之后是新设备号，
    // 这一行要是还挂在注册表上，新页面没有凭据撤它。
    expect(h.hub.revokeAllForUnload().sort()).toEqual([a.token, b.token].sort());
    expect(h.hub.listOutgoing()).toHaveLength(0);

    const v = await makeIdentity();
    await h.hub.onSignal(await connectFrom(v, a.token, '访客'));
    expect(refusalTo(h, v.deviceId)?.reason).toBe('not-here');
    expect(h.sessions.served).toHaveLength(0);
  });
});

/* ==================================================== 一次只服务一个人 */

describe('一次只服务一个人', () => {
  it('第一个访客直接开始服务', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const v = await makeIdentity();
    await h.hub.onSignal(await connectFrom(v, share.token, '小李'));

    expect(h.sessions.served).toEqual([v.deviceId]);
    expect(h.sessions.files).toEqual([v.deviceId]);
    expect(h.sessions.registered.get(v.deviceId)).toMatchObject({
      token: share.token,
      role: 'seeder',
      peerName: '小李',
    });
    expect(visitorOf(h, share.token, v.deviceId)?.phase).toBe('sending');
    expect(refusalTo(h, v.deviceId)).toBeUndefined();
  });

  it('第二个访客被告知当前有人正在取，不会偷偷多开一条连接', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const all = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_VISITORS + 2 }, () => makeIdentity()),
    );
    for (const v of all) {
      await h.hub.onSignal(await connectFrom(v, share.token, '访客'));
    }

    expect(h.sessions.served).toEqual([all[0]!.deviceId]);
    for (const v of all.slice(1)) {
      expect(refusalTo(h, v.deviceId)?.reason).toBe('busy');
      // 被挡在外面的人不进列表：界面上列的是真的在取件的人
      expect(visitorOf(h, share.token, v.deviceId)).toBeUndefined();
    }
  });

  it('前一个取完，链接空出来，下一个人连得上', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const first = await makeIdentity();
    const next = await makeIdentity();
    await h.hub.onSignal(await connectFrom(first, share.token, '先来的'));
    await h.hub.onSignal(await connectFrom(next, share.token, '后来的'));
    expect(refusalTo(h, next.deviceId)?.reason).toBe('busy');

    h.hub.onTransferStatus({
      id: 't',
      direction: 'out',
      status: 'done',
      peerId: first.deviceId,
    });
    await settle();
    await h.hub.onSignal(await connectFrom(next, share.token, '后来的'));

    expect(h.sessions.served).toContain(next.deviceId);
    expect(visitorOf(h, share.token, next.deviceId)?.phase).toBe('sending');
  });

  it('访客主动离开也把这条链接让出来', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const gone = await makeIdentity();
    const next = await makeIdentity();
    await h.hub.onSignal(await connectFrom(gone, share.token, '先来的'));
    await h.hub.onSignal(await connectFrom(next, share.token, '后来的'));

    // 灯塔按 to 投递，所以送进来的消息一定是发给我的
    await h.hub.onSignal({
      t: 'share-leave',
      from: gone.deviceId,
      to: h.identity.deviceId,
      token: share.token,
    });
    await settle();
    await h.hub.onSignal(await connectFrom(next, share.token, '后来的'));

    expect(visitorOf(h, share.token, gone.deviceId)?.phase).toBe('left');
    expect(h.sessions.served).toContain(next.deviceId);
  });

  it('同一个人重复点取件，不会把它自己顶掉', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const v = await makeIdentity();
    await h.hub.onSignal(await connectFrom(v, share.token, '小李'));
    expect(h.sessions.served).toEqual([v.deviceId]);

    await h.hub.onSignal(await connectFrom(v, share.token, '小李'));

    expect(h.sessions.served).toEqual([v.deviceId]);
    expect(h.sessions.signals).toHaveLength(0);
  });

  it('连接建不起来的访客不占名额，下一个照样进得来', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const broken = await makeIdentity();
    h.sessions.failServe = broken.deviceId;
    await h.hub.onSignal(await connectFrom(broken, share.token, '访客'));

    expect(visitorOf(h, share.token, broken.deviceId)?.phase).toBe('failed');
    expect(h.sessions.closed.some((c) => c.peerId === broken.deviceId)).toBe(true);

    const next = await makeIdentity();
    await h.hub.onSignal(await connectFrom(next, share.token, '下一个'));
    expect(h.sessions.served).toContain(next.deviceId);
  });

  it('不认识的 token 明确拒绝，而不是让访客干等', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const v = await makeIdentity();
    await h.hub.onSignal(await connectFrom(v, 'f'.repeat(32), '访客'));

    expect(refusalTo(h, v.deviceId)?.reason).toBe('not-here');
    expect(h.sessions.served).toHaveLength(0);
    expect(share).toBeDefined();
  });

  it('过期的分享回的是过期，不是含糊的"对方不在了"', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'), -1000);
    const v = await makeIdentity();
    await h.hub.onSignal(await connectFrom(v, share.token, '访客'));

    expect(refusalTo(h, v.deviceId)?.reason).toBe('expired');
  });

  it('设备号和公钥对不上的访客直接不理', async () => {
    const h = await harness();
    const share = await h.hub.createShare(fileLike('a.bin'));
    const honest = await makeIdentity();
    await h.hub.onSignal({
      t: 'share-connect',
      // 冒充者拿的是别人的公钥，却自称另一个设备号
      from: 'a'.repeat(20),
      to: h.identity.deviceId,
      token: share.token,
      name: '冒充者',
      publicKey: honest.publicKey,
    });

    expect(h.sessions.served).toHaveLength(0);
    expect(h.logs.some((l) => l.includes('对不上'))).toBe(true);
    // 一条信令都不回：能走到这里的假消息是灯塔那边的问题，不在这里替它兜
    expect(h.sessions.signals).toHaveLength(0);
  });
});

/* ==================================================== 访客侧 */

describe('访客侧', () => {
  /** 在注册表里挂一条"分享者此刻在线"的分享，返回它的 token */
  async function seedShare(registry: MemoryRegistry, seeder: DeviceIdentity): Promise<string> {
    const { token } = await registry.create({
      deviceId: seeder.deviceId,
      deviceName: '我的电脑',
      publicKey: seeder.publicKey,
      name: '电影.mkv',
      size: 4096,
      mime: 'video/x-matroska',
    });
    registry.online.add(seeder.deviceId);
    return token;
  }

  it('验过锚点才发 share-connect', async () => {
    const h = await harness();
    const seeder = await makeIdentity();
    const token = await seedShare(h.registry, seeder);

    await h.hub.visit(token);

    expect(h.sessions.registered.get(seeder.deviceId)).toMatchObject({
      role: 'visitor',
      peerKey: seeder.publicKey,
      token,
    });
    const connect = h.sessions.shareSignalsTo(seeder.deviceId).find((m) => m.t === 'share-connect');
    expect(connect).toBeDefined();
    expect(h.visits.at(-1)).toMatchObject({ token, phase: 'connecting', name: '电影.mkv' });
  });

  it('分享者离线时不连接，但也不算失败', async () => {
    const h = await harness();
    const seeder = await makeIdentity();
    const token = await seedShare(h.registry, seeder);
    h.registry.online.clear();

    await h.hub.visit(token);

    expect(h.visits.at(-1)?.phase).toBe('offline');
    expect(h.sessions.signals.filter((m) => m.t === 'share-connect')).toHaveLength(0);
    h.hub.dispose();
  });

  it('分享者回来之后，离线页每十秒重查一次，自己接上', async () => {
    vi.useFakeTimers();
    try {
      const h = await harness();
      const seeder = await makeIdentity();
      const token = await seedShare(h.registry, seeder);
      h.registry.online.clear();

      await h.hub.visit(token);
      expect(h.visits.at(-1)?.phase).toBe('offline');

      // 分享者重新打开页面：注册表把同一条链接从离线合成可用
      h.registry.online.add(seeder.deviceId);
      await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_INTERVAL_MS);
      await vi.advanceTimersByTimeAsync(0);

      expect(h.visits.at(-1)?.phase).toBe('connecting');
      expect(h.sessions.signals.filter((m) => m.t === 'share-connect')).toHaveLength(1);
      h.hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('自动重查只持续六十秒，点重试会重新开一个窗口', async () => {
    vi.useFakeTimers();
    try {
      const h = await harness();
      const seeder = await makeIdentity();
      const token = await seedShare(h.registry, seeder);
      h.registry.online.clear();
      const status = vi.spyOn(h.registry, 'status');

      await h.hub.visit(token);
      expect(status).toHaveBeenCalledTimes(1);

      // 10、20、30、40、50、60 秒各查一次，总共六次
      await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_WINDOW_MS);
      expect(status).toHaveBeenCalledTimes(1 + OFFLINE_RECHECK_WINDOW_MS / OFFLINE_RECHECK_INTERVAL_MS);

      // 窗口走完之后不再自己查，页面一直停在离线，等用户点重试
      await vi.advanceTimersByTimeAsync(OFFLINE_RECHECK_INTERVAL_MS * 3);
      expect(status).toHaveBeenCalledTimes(1 + OFFLINE_RECHECK_WINDOW_MS / OFFLINE_RECHECK_INTERVAL_MS);
      expect(h.visits.at(-1)?.phase).toBe('offline');

      // 手动重试：立刻查一次，这条链接已经能取了
      h.registry.online.add(seeder.deviceId);
      await h.hub.retryVisit();
      expect(status).toHaveBeenCalledTimes(
        1 + OFFLINE_RECHECK_WINDOW_MS / OFFLINE_RECHECK_INTERVAL_MS + 1,
      );
      expect(h.visits.at(-1)?.phase).toBe('connecting');
      h.hub.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('链接查不到就是查不到，不和离线混为一谈', async () => {
    const h = await harness();
    await h.hub.visit('d'.repeat(32));
    expect(h.visits.at(-1)?.phase).toBe('not-found');
  });

  it('注册表里没有公钥就没有锚点，宁可不做', async () => {
    const h = await harness();
    const { token } = await h.registry.create({
      deviceId: 'nobody',
      deviceName: '旧版客户端',
      publicKey: { kty: 'none' },
      name: 'x.bin',
      size: 1,
      mime: '',
    });
    h.registry.online.add('nobody');

    await h.hub.visit(token);

    expect(h.visits.at(-1)?.phase).toBe('unanchored');
    expect(h.sessions.signals.filter((m) => m.t === 'share-connect')).toHaveLength(0);
  });

  it('公钥推导不出那个设备号，判定为中间有人', async () => {
    const h = await harness();
    const stolen = await makeIdentity();
    const { token } = await h.registry.create({
      deviceId: 'b'.repeat(20),
      deviceName: '被改过的记录',
      publicKey: stolen.publicKey,
      name: 'x.bin',
      size: 1,
      mime: '',
    });
    h.registry.online.add('b'.repeat(20));

    await h.hub.visit(token);

    expect(h.visits.at(-1)?.phase).toBe('unanchored');
    expect(h.sessions.signals.filter((m) => m.t === 'share-connect')).toHaveLength(0);
  });

  it('不是安全上下文时明说，不降级成"不认证也照传"', async () => {
    const registry = new MemoryRegistry();
    const seeder = await makeIdentity();
    const token = await seedShare(registry, seeder);

    const insecure = await harness({ registry, identity: { ...(await makeIdentity()), canSign: false } });
    await insecure.hub.visit(token);

    expect(insecure.visits.at(-1)?.phase).toBe('needs-https');
    expect(insecure.sessions.signals.filter((m) => m.t === 'share-connect')).toHaveLength(0);
  });

  it('被告知当前有人在取时停在 busy，不干等', async () => {
    const h = await harness();
    const seeder = await makeIdentity();
    const token = await seedShare(h.registry, seeder);
    await h.hub.visit(token);

    h.hub.onSignal({
      t: 'share-revoked',
      from: seeder.deviceId,
      to: h.identity.deviceId,
      token,
      reason: 'busy',
    });

    expect(h.visits.at(-1)?.phase).toBe('busy');
    expect(h.sessions.closed.some((c) => c.peerId === seeder.deviceId)).toBe(true);
  });

  it('收到撤销通知就关掉连接并停在 revoked', async () => {
    const h = await harness();
    const seeder = await makeIdentity();
    const token = await seedShare(h.registry, seeder);
    await h.hub.visit(token);

    h.hub.onSignal({
      t: 'share-revoked',
      from: seeder.deviceId,
      to: h.identity.deviceId,
      token,
      reason: 'revoked',
    });

    expect(h.visits.at(-1)?.phase).toBe('revoked');
    expect(h.sessions.closed.some((c) => c.peerId === seeder.deviceId)).toBe(true);
  });

  it('主动离开要通知对方', async () => {
    const h = await harness();
    const seeder = await makeIdentity();
    const token = await seedShare(h.registry, seeder);
    await h.hub.visit(token);
    h.hub.leave();

    expect(h.sessions.shareSignalsTo(seeder.deviceId).find((m) => m.t === 'share-leave')).toMatchObject({
      token,
    });
    expect(h.sessions.closed.some((c) => c.peerId === seeder.deviceId)).toBe(true);
  });

  it('与我无关的信令不改动我的取件状态', async () => {
    const h = await harness();
    const seeder = await makeIdentity();
    const token = await seedShare(h.registry, seeder);
    await h.hub.visit(token);

    h.hub.onSignal({
      t: 'share-revoked',
      from: 'x',
      to: 'me',
      token: 'e'.repeat(32),
      reason: 'revoked',
    });

    expect(h.visits.at(-1)?.phase).toBe('connecting');
  });
});
