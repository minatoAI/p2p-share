/**
 * 公开链接这一条线的会话层集成测试。
 *
 * share.test.ts 验的是名额、撤销那些规则，它把会话层换成了假的。
 * 这里反过来：分享规则不变，把会话层换成真的两个 SessionManager，
 * 中间夹假的灯塔和假的点对点传输，走完 offer、answer、认证、分片传输。
 *
 * 要证明的是三件只有在真链路上才会露馅的事：
 *   一、没配对过的访客真的能连上并拿到字节一致的完整文件；
 *   二、一条链接在服务完一个人之后还能接着服务下一个人，两份字节都对；
 *   三、这条链接重新空出来是被真实的"传完"事件触发的，不是测试自己调的。
 *
 * "第二个人会被挡住"不在这三层里：那是名额判断，跟链路真假无关，
 * 写在 share.test.ts 里能稳定地摆出先后顺序。
 */

import { describe, expect, it } from 'vitest';
import { MemoryRegistry } from '../../src/adapters/memory/registry';
import { MemoryStore } from '../../src/adapters/memory/store';
import type { FileLike, TransferUpdate } from '../../src/core/transfer';
import { ShareHub } from '../../src/core/share';
import {
  FakePresence,
  FakeTransportHub,
  makeClient,
  makeDevice,
  pairViaCode,
  waitFor,
} from './peers';

const TEXT = '公开链接的内容。'.repeat(2000);

function fileLike(name: string, bytes: Uint8Array, type = 'text/plain'): FileLike {
  return {
    name,
    size: bytes.byteLength,
    type,
    slice: async (start, end) => bytes.slice(start, end).buffer as ArrayBuffer,
  };
}

/**
 * 一台设备：会话层是真的，分享层挂在它身上。
 *
 * 两边的回调都要往 ShareHub 转：share-* 信令由会话层原样送出来，
 * 传输状态要回去确认这一条链接空出来了。App 里用的是同一个 ref 的写法，
 * 因为 ShareHub 要拿 manager 当依赖，而 manager 又要拿这些回调，只能先留个空位。
 */
function makeShareNode(
  device: Awaited<ReturnType<typeof makeDevice>>,
  presence: FakePresence,
  transport: FakeTransportHub,
  registry: MemoryRegistry,
) {
  const ref: { hub: ShareHub | null } = { hub: null };
  const client = makeClient(
    device,
    presence,
    transport,
    new MemoryStore(),
    undefined,
    undefined,
    undefined,
    {
      transfer: {
        onStatus: (u: TransferUpdate) => ref.hub?.onTransferStatus(u),
        onProgress: (_id, direction, transferred, size) =>
          ref.hub?.onProgress(direction, transferred, size),
      },
      events: { shareSignal: (msg) => void ref.hub?.onSignal(msg) },
    },
  );
  const hub = new ShareHub(
    {
      identity: device.identity,
      registry,
      manager: client.manager,
      deviceName: () => device.name,
      origin: 'https://share.test',
    },
    { log: (l) => client.events.logs.push(l) },
  );
  ref.hub = hub;
  return { ...client, hub, device };
}

describe('公开链接：会话层集成', () => {
  it('没配对过的访客点开链接，拿到字节一致的完整文件', async () => {
    const presence = new FakePresence();
    const transport = new FakeTransportHub();
    const registry = new MemoryRegistry();

    const seederD = await makeDevice('分享者');
    const visitorD = await makeDevice('访客甲');
    const seeder = makeShareNode(seederD, presence, transport, registry);
    const visitor = makeShareNode(visitorD, presence, transport, registry);
    await seeder.manager.start();
    await visitor.manager.start();

    // 在线与否是在状态板那边的事实，注册表这边要有人替灯塔把它合进去
    registry.online.add(seederD.deviceId);

    const bytes = new TextEncoder().encode(TEXT);
    const share = await seeder.hub.createShare(fileLike('公开.txt', bytes));

    await visitor.hub.visit(share.link);

    await waitFor(() => visitor.sink.files.some((f) => f.committed), '访客落盘完成');
    const received = visitor.sink.files.find((f) => f.committed)!;
    expect(received.meta.name).toBe('公开.txt');
    expect(received.bytes).toEqual(bytes);

    // 访客这边一条通讯录记录都没有：这条连接从头到尾没有配对
    expect(await visitor.manager.contacts).toEqual([]);
    // 分享者界面上要能看到这个人取完了
    await waitFor(() => seeder.hub.listOutgoing()[0]!.visitors[0]!.phase === 'done', '访客标记为完成');
    expect(visitor.hub.currentVisit()!.phase).toBe('done');
  });

  it('同一条链接接着服务第二个人，放开是靠真实传完触发的', async () => {
    // 这里不断"第二个人会被挡住"：假链路把一次传输跑得太快，从 visit 返回时
    // 常常已经传完了，那个瞬间能不能撞上取决于微任务顺序，不是实现的决定。
    // 挡住那一条写在 share.test.ts，用假会话层可以稳定地摆出先后。
    // 这一层要验的是另一件事：名额是被真实的 done 事件放开的，第二个人
    // 不用分享者刷新、不用手动腾位，接着点就连得上，而且字节一样。
    const presence = new FakePresence();
    const transport = new FakeTransportHub();
    const registry = new MemoryRegistry();
    const seederD = await makeDevice('分享者');
    const seeder = makeShareNode(seederD, presence, transport, registry);
    await seeder.manager.start();
    registry.online.add(seederD.deviceId);

    const bytes = new TextEncoder().encode(TEXT);
    const share = await seeder.hub.createShare(fileLike('两个人.txt', bytes));

    const mk = async (name: string) => {
      const d = await makeDevice(name);
      const v = makeShareNode(d, presence, transport, registry);
      await v.manager.start();
      return v;
    };
    const first = await mk('访客甲');
    const second = await mk('访客乙');

    await first.hub.visit(share.link);
    await waitFor(() => first.sink.files.some((f) => f.committed), '甲收到文件');
    expect(first.sink.files.find((f) => f.committed)!.bytes).toEqual(bytes);

    await second.hub.visit(share.link);
    await waitFor(() => second.sink.files.some((f) => f.committed), '乙收到文件');
    expect(second.sink.files.find((f) => f.committed)!.bytes).toEqual(bytes);

    // 两个人各占一行，都记成取完了
    await waitFor(
      () => seeder.hub.listOutgoing()[0]!.visitors.filter((v) => v.phase === 'done').length === 2,
      '分享者把两个访客都记成完成',
    );
  });

  it('访客先配过对，再点自己那条链接也照样能取件', async () => {
    const presence = new FakePresence();
    const transport = new FakeTransportHub();
    const registry = new MemoryRegistry();
    const seederD = await makeDevice('分享者');
    const visitorD = await makeDevice('已经配对的访客');
    const seeder = makeShareNode(seederD, presence, transport, registry);
    const visitor = makeShareNode(visitorD, presence, transport, registry);
    await seeder.manager.start();
    await visitor.manager.start();

    // 正常配一次对：A 报码，B 输码，A 确认
    seeder.manager.startAdvertising();
    await waitFor(() => seeder.events.codes.length > 0, '分享者拿到配对码');
    const code = seeder.events.codes[seeder.events.codes.length - 1]!;
    await visitor.manager.joinWithCode(code);
    await waitFor(() => seeder.events.prompts.length === 1, '分享者收到配对请求');
    await seeder.manager.confirmPairing(true);
    await waitFor(
      () => seeder.manager.currentState === 'ready' && visitor.manager.currentState === 'ready',
      '两端认证通过',
    );
    expect((await visitor.manager.contacts).map((c) => c.peerId)).toEqual([seederD.deviceId]);

    registry.online.add(seederD.deviceId);
    const bytes = new TextEncoder().encode(TEXT);
    const share = await seeder.hub.createShare(fileLike('配对之后.txt', bytes));
    await visitor.hub.visit(share.link);

    await waitFor(() => visitor.sink.files.some((f) => f.committed), '访客收到文件');
    expect(visitor.sink.files.find((f) => f.committed)!.bytes).toEqual(bytes);
  });
});
