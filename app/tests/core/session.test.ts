import { describe, expect, it } from 'vitest';
import { createContact, shortAuthenticationString } from '../../src/core/pairing';
import type { DeviceIdentity } from '../../src/core/ports';
import type { SignalMessage } from '../../src/core/protocol';
import { MemoryStore } from '../../src/adapters/memory/store';
import {
  FakePresence,
  FakeSignal,
  FakeTransportHub,
  makeClient,
  makeDevice,
  pairViaCode,
  tick,
  waitFor,
} from './peers';



describe('首次配对', () => {
  it('一个配对码换回同样的一对，流程走通后双方各自记下对方', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('我的电脑');
    const b = await makeDevice('我的手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();

    // A 报码，B 输码
    const { code, promptA, promptB } = await pairViaCode(clientA, clientB);
    expect(code).toMatch(/^\d{6}$/);
    expect(promptA.role).toBe('inviter');
    expect(promptB.role).toBe('joiner');
    expect(promptA.deviceId).toBe(b.deviceId);
    expect(promptA.name).toBe('我的手机');
    // 两边算出来的六位数字必须一样，这是配对时唯一需要人核对的东西
    expect(promptA.sas).toBe(promptB.sas);
    expect(promptA.sas).toMatch(/^\d{6}$/);
    // 网页端把"我是网页端"带进配对请求，码主这边当场就能显示一次性标记；
    // 输码方要等 pair-response 才知道，所以它的提示里此时没有这一项。
    expect(promptA.peerPlatform).toBe('web');
    expect(promptB.peerPlatform).toBeUndefined();

    // A 确认
    await clientA.manager.confirmPairing(true);
    await waitFor(
      () => clientA.manager.currentState === 'ready' && clientB.manager.currentState === 'ready',
      '两端都认证通过',
    );

    expect((await clientA.manager.contacts).map((c) => c.peerId)).toEqual([b.deviceId]);
    expect((await clientB.manager.contacts).map((c) => c.peerId)).toEqual([a.deviceId]);
    // 两边都要记住对端的端类型：码主从请求里学，输码方从回应里学
    expect((await clientA.manager.contacts)[0]!.peerPlatform).toBe('web');
    expect((await clientB.manager.contacts)[0]!.peerPlatform).toBe('web');
    // 认证是在数据通道上完成的，日志里应该留下证据
    expect(clientA.events.logs.join('\n')).toContain('经过认证的连接');
    expect(clientB.events.logs.join('\n')).toContain('经过认证的连接');
  });

  it(
    '第一份认证挑战被对端丢掉时会自动补发，连接仍然建立',
    async () => {
      const presence = new FakePresence();
      const hub = new FakeTransportHub();
      const a = await makeDevice('电脑');
      const b = await makeDevice('手机');
      const clientA = makeClient(a, presence, hub, new MemoryStore());
      const clientB = makeClient(b, presence, hub, new MemoryStore());
      // 让 B 丢掉收到的第一份 auth-challenge，等价于 Kotlin/JNI 侧还没来得及挂 handler
      hub.dropFirstAuthChallengeAt = b.deviceId;
      await clientA.manager.start();
      await clientB.manager.start();

      const { promptA } = await pairViaCode(clientA, clientB);
      expect(promptA.role).toBe('inviter');
      await clientA.manager.confirmPairing(true);
      await waitFor(
        () => clientA.manager.currentState === 'ready' && clientB.manager.currentState === 'ready',
        '丢掉第一份挑战后两端仍然认证通过',
        8000,
      );
      // 补发是这条修复的核心证据：没有它，A 会一直等 B 对第一份挑战的回应
      expect(clientA.events.logs.join('\n')).toContain('认证挑战没有回应，重发');
    },
    12000,
  );

  it(
    '同一个码第一次查不到时会自动重查一次',
    async () => {
      const presence = new FakePresence();
      const hub = new FakeTransportHub();
      const a = await makeDevice('电脑');
      const b = await makeDevice('手机');
      const clientA = makeClient(a, presence, hub, new MemoryStore());
      const clientB = makeClient(b, presence, hub, new MemoryStore());
      await clientA.manager.start();
      await clientB.manager.start();
      // 第一次查一个真实存在的码也故意回 miss，模拟码刚轮换的窗口
      presence.missFirstLookupOnce = true;

      const { promptA } = await pairViaCode(clientA, clientB);
      expect(promptA.role).toBe('inviter');
      expect(clientB.events.logs.join('\n')).toContain('配对码第一次没查到，600ms 后自动重查');
      // 自动重查成功后不应该把错误抛给用户
      expect(clientB.events.errors.join('\n')).not.toContain('这个配对码没找到');
    },
    8000,
  );

  it('码主能从请求里认出原生端，不用等回应', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();
    clientA.manager.startAdvertising();
    await waitFor(() => clientA.events.codes.length > 0, 'A 拿到配对码');
    const code = clientA.events.codes[0]!;

    // 模拟 Android 原生端直接发来的请求：多带一个 platform 字段
    clientB.signal.send({
      t: 'pair-request',
      from: b.deviceId,
      to: a.deviceId,
      code,
      name: b.name,
      publicKey: b.publicKey,
      platform: 'native',
    });
    await waitFor(() => clientA.events.prompts.length === 1, 'A 收到原生端请求');
    expect(clientA.events.prompts[0]!.peerPlatform).toBe('native');
  });

  it('拒绝配对时两边都不留记录', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();

    await pairViaCode(clientA, clientB);
    await clientA.manager.confirmPairing(false);
    await waitFor(() => clientB.events.errors.length > 0, 'B 收到拒绝');

    expect(await clientA.manager.contacts).toEqual([]);
    expect(await clientB.manager.contacts).toEqual([]);
    expect(clientB.events.errors.join('\n')).toContain('拒绝');
  });

  it('配对成功之后同一个码不能再用', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const c = await makeDevice('第三台');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    const clientC = makeClient(c, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();
    await clientC.manager.start();

    const { code } = await pairViaCode(clientA, clientB);
    await clientA.manager.confirmPairing(true);
    await waitFor(() => clientA.manager.currentState === 'ready', 'A 就绪');

    // C 拿同一个码来敲门。A 配对成功之后已经把这个码作废了。
    await clientC.manager.joinWithCode(code);
    await waitFor(() => clientC.events.prompts.length > 0, 'C 查到了码的主人');
    await waitFor(() => clientC.events.errors.length > 0, 'C 被拒');
    expect(clientC.events.errors.join('\n')).toContain('不是我发出去的');
    expect((await clientA.manager.contacts).map((x) => x.peerId)).toEqual([b.deviceId]);
  });

  it('服务器上已经过期的码查不到，两边都不留记录', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();

    // 服务器把这个码标成已经过期，B 查的时候就会被挡回来
    presence.expireCodes = true;
    clientA.manager.startAdvertising();
    await waitFor(() => clientA.events.codes.length > 0, 'A 拿到配对码');
    await clientB.manager.joinWithCode(clientA.events.codes[0]!);

    await waitFor(() => clientB.events.errors.length > 0, 'B 应当被挡回来');
    expect(clientB.events.errors.join('|')).toContain('过期');
    // 两边都没有配对记录，A 那边也不该收到任何配对请求
    expect(await clientA.manager.contacts).toEqual([]);
    expect(await clientB.manager.contacts).toEqual([]);
    expect(clientA.events.prompts).toEqual([]);
  });

  it('灯塔连上得晚也要拿到配对码', async () => {
    // 真机上踩到过：startAdvertising 先被"通讯录为空"那个事件调用，
    // 那时灯塔还没连上，要码的请求被丢掉；之后它又因为"已经在报码"提前返回，
    // 结果一个码都没有。本机 localhost 连得快，这个顺序碰不到，线上必踩。
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore(), undefined, true);
    const clientB = makeClient(b, presence, hub, new MemoryStore(), undefined, true);

    await clientA.manager.start();
    await clientB.manager.start();
    // 灯塔还没连上就先开始报码
    clientA.manager.startAdvertising();
    await tick();
    expect(clientA.events.codes).toEqual([]);

    // 灯塔这会儿才连上
    clientA.signal.open();
    clientB.signal.open();
    await waitFor(() => clientA.events.codes.length > 0, '补上了一个配对码');

    // 补上的码能正常用
    await clientB.manager.joinWithCode(clientA.events.codes[0]!);
    await waitFor(() => clientA.events.prompts.length === 1, 'A 收到配对请求');
    await clientA.manager.confirmPairing(true);
    await waitFor(() => clientA.manager.currentState === 'ready', '照样连上');
  });

  it('轮换期间旧码仍然有效，不会刚好赶上换码就失败', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();

    clientA.manager.startAdvertising();
    await waitFor(() => clientA.events.codes.length === 1, 'A 拿到第一个码');
    const first = clientA.events.codes[0]!;
    // 再换一次，模拟"读到码之后屏幕上刚好跳了一格"。
    // 只换一次是刻意的：有效时间就是两个轮换周期，换两次等于把它耗干，
    // 那种情况本来就该失败。
    clientA.manager.refreshCode();
    await waitFor(() => clientA.events.codes.length === 2, 'A 拿到第二个码');

    // 用户手上还是上一个码，仍然能配上
    await clientB.manager.joinWithCode(first);
    await waitFor(() => clientA.events.prompts.length === 1, 'A 收到请求');
    await clientA.manager.confirmPairing(true);
    await waitFor(() => clientA.manager.currentState === 'ready', '照样连上');
  });
});

describe('连通测试', () => {
  it('配对完成之后，量得到一次真的往返', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();

    const { promptB } = await pairViaCode(clientA, clientB);
    await clientA.manager.confirmPairing(true);
    await waitFor(() => clientB.manager.currentState === 'ready', 'B 这侧连上');

    const rtt = await clientB.manager.ping(promptB.deviceId);
    expect(rtt).toBeGreaterThanOrEqual(0);
    expect(rtt).toBeLessThan(4000);

    // 通道断了之后应当明确失败，而不是永远挂着
    hub.dropAll();
    await expect(clientB.manager.ping(promptB.deviceId, 50)).rejects.toThrow();
  });
});

describe('声音配对的带外指纹', () => {
  it('指纹对得上时，报码那边直接接受，不再弹六位数字', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();

    clientA.manager.startAdvertising();
    await waitFor(() => clientA.events.codes.length > 0, 'A 拿到码');
    const code = clientA.events.codes[0]!;
    // 正在播：这期间的请求直接接受
    clientA.manager.setAutoAccept(true);

    const tag = await a.crypto.fingerprint(a.publicKey);
    await clientB.manager.joinWithCode(code, { fingerprint: tag });

    await waitFor(() => clientA.manager.currentState === 'ready', 'A 连上');
    await waitFor(() => clientB.manager.currentState === 'ready', 'B 连上');
    expect(clientA.events.prompts).toHaveLength(0);
    expect(clientA.events.contacts.at(-1)?.map((c) => (c as { peerId: string }).peerId)).toContain(
      b.deviceId,
    );
  });

  it('声音里的指纹和灯塔给的公钥对不上就直接断，不给连', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();

    clientA.manager.startAdvertising();
    await waitFor(() => clientA.events.codes.length > 0, 'A 拿到码');
    const code = clientA.events.codes[0]!;

    await clientB.manager.joinWithCode(code, { fingerprint: 'deadbeef' });

    await waitFor(
      () => clientB.events.errors.some((e) => e.includes('对不上')),
      'B 发现指纹不一致',
    );
    expect(clientA.events.prompts).toHaveLength(0);
  });
});

describe('免重复配对', () => {
  it('配对一次之后，重开页面直接按设备号重连，不再需要任何令牌', async () => {
    const a = await makeDevice('我的电脑');
    const b = await makeDevice('我的手机');
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();

    // 第一轮：配对
    {
      const presence = new FakePresence();
      const hub = new FakeTransportHub();
      const clientA = makeClient(a, presence, hub, storeA);
      const clientB = makeClient(b, presence, hub, storeB);
      await clientA.manager.start();
      await clientB.manager.start();
      await pairViaCode(clientA, clientB);
      await clientA.manager.confirmPairing(true);
      await waitFor(
        () => clientA.manager.currentState === 'ready' && clientB.manager.currentState === 'ready',
        '配对完成并连上',
      );
    }

    // 第二轮：两个页面都重开，通讯录还在，灯塔和链路都是全新的
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const clientA = makeClient(a, presence, hub, storeA);
    const clientB = makeClient(b, presence, hub, storeB);
    await clientA.manager.start();
    await clientB.manager.start();
    await tick();

    // 通讯录没丢
    expect((await clientA.manager.contacts).map((c) => c.peerId)).toEqual([b.deviceId]);
    // 在线状态互相看得见
    await waitFor(
      () => clientA.manager.presenceOf(b.deviceId)?.online === true,
      'A 看到 B 在线',
    );

    // 不需要任何配对动作，直接连
    await clientA.manager.connect(b.deviceId);
    await waitFor(() => clientA.manager.currentState === 'ready', 'A 重连就绪');
    await waitFor(() => clientB.manager.currentState === 'ready', 'B 也认证通过');

    // 全程没有出现配对提示
    expect(clientA.events.prompts).toEqual([]);
    expect(clientB.events.prompts).toEqual([]);
  });

  it('对方不在线时连接会被拒绝，并说明原因', async () => {
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const storeA = new MemoryStore();
    // 先手工写入一条配对记录，模拟"以前配过"
    await storeA.put(
      'contacts',
      b.deviceId,
      await createContact(a.crypto, {
        peerId: b.deviceId,
        peerName: '我的手机',
        publicKey: b.publicKey,
      }),
    );

    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const clientA = makeClient(a, presence, hub, storeA);
    await clientA.manager.start();
    await tick();

    // B 从未上线，订阅结果说它离线
    await expect(clientA.manager.connect(b.deviceId)).rejects.toThrow(/不在线/);
  });
});

describe('连接超时', () => {
  it('对端一直不回应时明确报错，不会无限等', async () => {
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const storeA = new MemoryStore();
    await storeA.put(
      'contacts',
      b.deviceId,
      await createContact(a.crypto, {
        peerId: b.deviceId,
        peerName: '我的手机',
        publicKey: b.publicKey,
      }),
    );

    // B 只在状态板上在线，不做任何应答，用来模拟"对方卡住了"
    presence.connect(b.deviceId);
    const clientA = makeClient(a, presence, hub, storeA, undefined, false, 300);
    await clientA.manager.start();
    await tick();
    expect(clientA.manager.presenceOf(b.deviceId)?.online).toBe(true);

    await expect(clientA.manager.connect(b.deviceId)).rejects.toThrow(/连不上对方/);
    // 阶段事件也要走到失败，界面才有东西可显示
    expect(clientA.events.phases.join(',')).toContain('failed');
    // 超时之后状态要回到空闲，不能卡在 connecting
    await waitFor(() => clientA.manager.currentState === 'idle', '超时后回到空闲');
  });
});

describe('每个对端一条连接', () => {
  it('同时和两台设备各传一份，两边都收到各自的', async () => {
    // 这是会话注册表存在的理由。原来核心只有一个 session 和一个引擎，
    // 同一时刻只能和一个对端传；现在每个对端一套，两条可以并行。
    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const a = await makeDevice('电脑甲');
    const b = await makeDevice('手机乙');
    const c = await makeDevice('平板丙');
    const clientA = makeClient(a, presence, hub, new MemoryStore());
    const clientB = makeClient(b, presence, hub, new MemoryStore());
    const clientC = makeClient(c, presence, hub, new MemoryStore());
    await clientA.manager.start();
    await clientB.manager.start();
    await clientC.manager.start();

    // 甲分别和乙、丙各配一次
    await pairViaCode(clientA, clientB);
    await clientA.manager.confirmPairing(true);
    await waitFor(() => clientA.manager.stateOf(b.deviceId) === 'ready', '甲和乙连上');

    // 甲已经有乙了，这时要能和丙再配一次（界面上是"添加新设备"）。
    // 不能复用 pairViaCode：它等的是"第一个配对请求"，而甲已经有乙那一个了，
    // 复用会立刻返回并去确认旧的那次配对。
    clientA.manager.startAdvertising();
    await waitFor(() => clientA.events.codes.length > 0, '甲再拿到配对码');
    const code2 = clientA.events.codes[clientA.events.codes.length - 1]!;
    await clientC.manager.joinWithCode(code2);
    await waitFor(() => clientA.events.prompts.length === 2, '甲收到第二个配对请求');
    await clientA.manager.confirmPairing(true);
    await waitFor(() => clientA.manager.stateOf(c.deviceId) === 'ready', '甲和丙连上');

    // 两条链路必须同时是就绪的，而不是互相顶掉
    expect(clientA.manager.stateOf(b.deviceId)).toBe('ready');
    expect(clientA.manager.stateOf(c.deviceId)).toBe('ready');
    expect(clientB.manager.stateOf(a.deviceId)).toBe('ready');
    expect(clientC.manager.stateOf(a.deviceId)).toBe('ready');

    // 并行发，两条链路各走各的引擎
    const [idToB, idToC] = await Promise.all([
      clientA.manager.sendText(b.deviceId, '给乙的内容'),
      clientA.manager.sendText(c.deviceId, '给丙的内容'),
    ]);
    // 传输 ID 不能撞号，否则两边的记录会互相覆盖
    expect(idToB).not.toBe(idToC);

    await waitFor(() => clientB.events.texts.length === 1, '乙收到');
    await waitFor(() => clientC.events.texts.length === 1, '丙收到');
    expect(clientB.events.texts[0]).toBe('给乙的内容');
    expect(clientC.events.texts[0]).toBe('给丙的内容');

    // 传完之后两条连接都还在
    expect(clientA.manager.stateOf(b.deviceId)).toBe('ready');
    expect(clientA.manager.stateOf(c.deviceId)).toBe('ready');
  });
});

describe('认证挡住冒充', () => {
  it('别人拿我的设备号来连，签名对不上，连接被拒', async () => {
    const a = await makeDevice('我的电脑');
    const b = await makeDevice('我的手机');
    const attacker = await makeDevice('冒充者');

    // B 的通讯录里存的是 A 的真实公钥
    const storeB = new MemoryStore();
    await storeB.put(
      'contacts',
      a.deviceId,
      await createContact(b.crypto, {
        peerId: a.deviceId,
        peerName: '我的电脑',
        publicKey: a.publicKey,
      }),
    );

    // 冒充者用 A 的设备号，但拿的是自己的私钥
    const fake: DeviceIdentity = { ...attacker.identity, deviceId: a.deviceId };
    const storeFake = new MemoryStore();
    await storeFake.put(
      'contacts',
      b.deviceId,
      await createContact(attacker.crypto, {
        peerId: b.deviceId,
        peerName: '我的手机',
        publicKey: b.publicKey,
      }),
    );

    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const clientB = makeClient(b, presence, hub, storeB);
    // 冒充者在状态板上也用 A 的设备号上线，所以 B 看到的是"我的电脑在线"
    const clientFake = makeClient(
      { ...attacker, identity: fake },
      presence,
      hub,
      storeFake,
      a.deviceId,
    );
    await clientB.manager.start();
    await clientFake.manager.start();
    await tick();

    // 两端各自发起。B 那边用通讯录里 A 的公钥去验冒充者的签名，必然过不了。
    const forB = clientB.manager.connect(a.deviceId).catch((err: Error) => err);
    const forFake = clientFake.manager.connect(b.deviceId).catch((err: Error) => err);
    await Promise.all([forB, forFake]);

    await waitFor(() => clientB.events.errors.length > 0, 'B 报出认证失败');
    expect(clientB.events.errors.join('\n')).toContain('认证失败');
    expect(clientB.manager.currentState).not.toBe('ready');
    expect(clientFake.manager.currentState).not.toBe('ready');
  });

  it('链路断开之后状态回退，且待发任务不会静默卡住', async () => {
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const storeA = new MemoryStore();
    const storeB = new MemoryStore();
    await storeA.put(
      'contacts',
      b.deviceId,
      await createContact(a.crypto, { peerId: b.deviceId, peerName: '手机', publicKey: b.publicKey }),
    );
    await storeB.put(
      'contacts',
      a.deviceId,
      await createContact(b.crypto, { peerId: a.deviceId, peerName: '电脑', publicKey: a.publicKey }),
    );

    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const clientA = makeClient(a, presence, hub, storeA);
    const clientB = makeClient(b, presence, hub, storeB);
    await clientA.manager.start();
    await clientB.manager.start();
    await tick();

    await clientA.manager.connect(b.deviceId);
    await waitFor(() => clientA.manager.currentState === 'ready', '先连上');
    hub.dropAll();
    await waitFor(() => clientA.manager.currentState === 'idle', '断开后回到空闲');
    expect(clientA.events.errors.join('\n')).toContain('断了');
  });
});

/* ==================================================== 对端先发起时的竞态 */

/**
 * 只把第一次 get 挂起来的通讯录存储。
 *
 * `connectOnce` 的第一行就是 `await book.get(peerId)`。真实系统里那几毫秒
 * 正好够对端的 offer 飞过来，但靠等是等不到这个窗口的，所以把第一次 get
 * 拦住、等 offer 到位了再放行，顺序就完全确定了。
 */
class GatedStore extends MemoryStore {
  private gate: Promise<void> | null = null;
  private open = (): void => {};

  arm(): void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
  }

  release(): void {
    this.open();
  }

  override async get<T>(collection: string, key: string): Promise<T | undefined> {
    const gate = this.gate;
    this.gate = null;
    if (gate) await gate;
    return super.get<T>(collection, key);
  }
}

/**
 * 记下这条链路发出去的每一条信令，并在每条发出时回调。
 *
 * 要断言的是"某条消息**没有**发出"，界面上的日志里没有这个信息。
 */
function spyOutgoing(
  signal: FakeSignal,
  onSend?: (msg: SignalMessage) => void,
): SignalMessage[] {
  const sent: SignalMessage[] = [];
  const forward = signal.send.bind(signal);
  signal.send = (msg: SignalMessage): void => {
    sent.push(msg);
    onSend?.(msg);
    forward(msg);
  };
  return sent;
}

describe('对端先发起，connect() 正好在路上', () => {
  it('不能把刚接管过来的会话拆掉，否则 offer 作废、两边一起超时', async () => {
    const one = await makeDevice('一台');
    const two = await makeDevice('另一台');
    // 谁建通道由设备号大小决定，大的那侧建、也就先发 offer。
    // 这里让"原生端"拿到大的那个号，好复现真实失败里的顺序。
    const [native, web] = one.deviceId > two.deviceId ? [one, two] : [two, one];

    const storeNative = new MemoryStore();
    const storeWeb = new GatedStore();
    await storeNative.put(
      'contacts',
      web.deviceId,
      await createContact(native.crypto, {
        peerId: web.deviceId,
        peerName: web.name,
        publicKey: web.publicKey,
      }),
    );
    await storeWeb.put(
      'contacts',
      native.deviceId,
      await createContact(web.crypto, {
        peerId: native.deviceId,
        peerName: native.name,
        publicKey: native.publicKey,
      }),
    );

    const presence = new FakePresence();
    const hub = new FakeTransportHub();
    const clientNative = makeClient(native, presence, hub, storeNative);
    // 超时调短：修复前这个用例的结局是两边一起等到超时，不值得真等 20 秒
    const clientWeb = makeClient(web, presence, hub, storeWeb, undefined, undefined, 800);
    await clientNative.manager.start();
    await clientWeb.manager.start();
    await tick();

    // answer 一发出就放行 connect()。
    //
    // 这里不能慢慢等：假传输把链路建得太快，等下去认证都跑完了，connect()
    // 会在 alreadyConnected 那里直接返回，正好绕过这个竞态，什么都测不出来。
    let released = false;
    const outgoing = spyOutgoing(clientWeb.signal, (msg) => {
      if (msg.t === 'sdp' && !released) {
        released = true;
        storeWeb.release();
      }
    });

    // 浏览器这侧先发起 connect，卡在读通讯录上；原生端趁这个窗口把 offer 送进来
    storeWeb.arm();
    const connecting = clientWeb.manager.connect(native.deviceId);
    void clientNative.manager.connect(web.deviceId).catch(() => {});

    await waitFor(() => released, '浏览器接管了 offer 并回了 answer');
    // 让 connect() 从 book.get 上恢复过来，跑完它接下来那几步
    await tick();

    // 拆掉会话之后浏览器只能请对方重发，而对方认为自己早就发过了——
    // 这正是线上抓到的那两条信令：收到 sdp（answer），紧接着收到 connect-request。
    expect(outgoing.filter((m) => m.t === 'connect-request')).toHaveLength(0);
    await expect(connecting).resolves.toBeUndefined();
    await waitFor(
      () =>
        clientWeb.manager.stateOf(native.deviceId) === 'ready' &&
        clientNative.manager.stateOf(web.deviceId) === 'ready',
      '两端都认证通过',
    );
  });
});

describe('六位短认证串', () => {
  it('两边独立算出来的数字一致，被换掉公钥就不一致', async () => {
    const a = await makeDevice('电脑');
    const b = await makeDevice('手机');
    const attacker = await makeDevice('冒充者');
    const fromA = await shortAuthenticationString(a.crypto, a.publicKey, b.publicKey);
    const fromB = await shortAuthenticationString(b.crypto, b.publicKey, a.publicKey);
    const forged = await shortAuthenticationString(a.crypto, a.publicKey, attacker.publicKey);
    expect(fromA).toBe(fromB);
    expect(forged).not.toBe(fromB);
  });
});
