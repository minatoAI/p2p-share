/**
 * 灯塔集成测试。
 *
 * 跑在真实的 wrangler dev 上（本地 workerd，Durable Objects 用的是真实 SQLite 后端），
 * 所以它验证的是真的在线状态板和真的分享注册表行为，不是桩件。
 *
 * 这里没有房间相关的用例，也没有配对令牌的用例：房间已经删掉了，
 * 配对令牌完全存在设备本地，服务端不认识配对这件事。
 *
 * 用法：
 *   node tests/worker/lighthouse.mjs [http://127.0.0.1:8787]
 * 需要先起 wrangler dev。npm run test:worker 会自动处理。
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:8787';
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (err) {
    results.push({ name, ok: false, message: err.stack ?? String(err) });
    console.log(`  ✘ ${name}\n      ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function waitFor(fn, label, timeout = 6000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`等待超时：${label}`);
    await sleep(30);
  }
}

function connect(url) {
  const ws = new WebSocket(url);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  return {
    ws,
    inbox,
    open: () =>
      new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', () => reject(new Error('WebSocket 打开失败')), { once: true });
      }),
    next: (pred, label, timeout = 6000) => {
      const found = inbox.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const i = waiters.findIndex((w) => w.resolve === wrapped);
          if (i >= 0) waiters.splice(i, 1);
          reject(new Error(`等待超时：${label}`));
        }, timeout);
        const wrapped = (msg) => {
          clearTimeout(timer);
          resolve(msg);
        };
        waiters.push({ pred, resolve: wrapped });
      });
    },
    send: (obj) => ws.send(JSON.stringify(obj)),
    close: () => ws.close(),
  };
}

const api = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, init);
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* 可能没有 body */
  }
  return { status: res.status, body };
};

const postJson = (path, data) =>
  api(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  });

/* ============================================================== 基础 */

await check('健康检查，灯塔自述里明确写了不提供存储', async () => {
  const h = await api('/api/health');
  assert(h.status === 200 && h.body.ok === true, '健康检查应返回 ok');

  const info = await api('/api/lighthouse/info');
  assert(info.body.capabilities.signaling === true, '应声明提供信令');
  assert(info.body.capabilities.shareRegistry === true, '应声明提供分享注册表');
  assert(info.body.capabilities.storage === false, '应声明不提供存储');
  assert(info.body.capabilities.turn === false, '第 1 阶段不提供 TURN');
});

/* ============================================================== 在线状态板 */

const presenceUrl = (deviceId, name) =>
  `${BASE.replace(/^http/, 'ws')}/ws/presence?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(name ?? '')}`;

await check('状态板：两端订阅后互相看到对方在线', async () => {
  const a = connect(presenceUrl('pd-a', '我的电脑'));
  const b = connect(presenceUrl('pd-b', '我的手机'));
  await Promise.all([a.open(), b.open()]);
  a.send({ t: 'watch', ids: ['pd-b'] });
  b.send({ t: 'watch', ids: ['pd-a'] });

  const listA = await a.next((m) => m.t === 'presence-list', 'A 拿到订阅快照');
  assert(
    listA.entries.some((e) => e.id === 'pd-b' && e.online === true),
    `A 应当看到 pd-b 在线，实际 ${JSON.stringify(listA.entries)}`,
  );
  const listB = await b.next((m) => m.t === 'presence-list', 'B 拿到订阅快照');
  assert(
    listB.entries.some((e) => e.id === 'pd-a' && e.online === true),
    `B 应当看到 pd-a 在线，实际 ${JSON.stringify(listB.entries)}`,
  );

  // 查询接口给出同样的结论（返回的就是一个数组）
  const { body } = await api('/api/presence?ids=pd-a,pd-b');
  assert(
    Array.isArray(body) && body.every((e) => e.online),
    `查询接口应当说两台都在线，实际 ${JSON.stringify(body)}`,
  );

  a.close();
  b.close();
});

await check('状态板：按设备号单播，且 from 由服务端填写', async () => {
  const a = connect(presenceUrl('pd-a'));
  const b = connect(presenceUrl('pd-b'));
  const c = connect(presenceUrl('pd-c'));
  await Promise.all([a.open(), b.open(), c.open()]);

  // A 谎称自己是别人
  a.send({
    t: 'sdp',
    to: 'pd-b',
    from: 'pd-c',
    description: { type: 'offer', sdp: 'v=0' },
    sig: 'x',
  });
  const got = await b.next((m) => m.t === 'sdp', 'B 收到 SDP');
  assert(got.from === 'pd-a', `from 应当被覆盖成 pd-a，实际是 ${got.from}`);
  assert(got.description.sdp === 'v=0', '内容应当原样转发');

  await sleep(200);
  assert(!c.inbox.some((m) => m.t === 'sdp'), '没被订阅的第三方不该看到任何信令');

  a.close();
  b.close();
  c.close();
});

await check('状态板：指向不在线的设备会收到明确错误', async () => {
  const a = connect(presenceUrl('pd-a'));
  await a.open();
  a.send({ t: 'sdp', to: 'pd-nobody', description: { type: 'offer', sdp: 'v=0' }, sig: 'x' });
  const err = await a.next((m) => m.t === 'error', '收到对方离线');
  assert(err.code === 'peer-offline', `错误码应当是 peer-offline，实际 ${err.code}`);
  a.close();
});

await check('状态板：对端上线和断开都会通知订阅者', async () => {
  const a = connect(presenceUrl('pd-a'));
  await a.open();
  a.send({ t: 'watch', ids: ['pd-b'] });
  await a.next((m) => m.t === 'presence-list', '先拿到快照');

  const b = connect(presenceUrl('pd-b'));
  await b.open();
  const online = await a.next((m) => m.t === 'presence' && m.id === 'pd-b', 'B 上线通知');
  assert(online.online === true, 'B 应当是上线');

  b.close();
  const offline = await a.next(
    (m) => m.t === 'presence' && m.id === 'pd-b' && m.online === false,
    'B 离线通知',
  );
  assert(offline.online === false, 'B 应当是离线');
  // 正在关闭的那条连接仍然会出现在 getWebSockets() 里，所以这里同时守着
  // "别把正在关闭的自己算成还在线"那个回归。

  a.close();
});

await check('状态板：同一设备重连后，信令只会送到新连接', async () => {
  // 旧连接会被以 4000 踢掉。客户端是否立刻观察到这个关闭码取决于实现，
  // 所以这里断言的是真正要保证的那件事：重连之后消息不再落到旧连接上。
  const first = connect(presenceUrl('pd-dup'));
  await first.open();
  const second = connect(presenceUrl('pd-dup'));
  await second.open();

  const sender = connect(presenceUrl('pd-sender'));
  await sender.open();
  await sleep(200);
  sender.send({
    t: 'sdp',
    to: 'pd-dup',
    description: { type: 'offer', sdp: 'v=0' },
    sig: 'x',
  });

  const got = await second.next((m) => m.t === 'sdp', '新连接收到信令');
  assert(got.description.sdp === 'v=0', '内容应当原样转发');

  await sleep(300);
  assert(!first.inbox.some((m) => m.t === 'sdp'), '旧连接不该再收到任何信令');

  first.close();
  second.close();
  sender.close();
});

await check('状态板：配对请求只被当作普通信令转发，服务端不校验令牌', async () => {
  // 这是有意的：配对令牌完全存在设备本地，服务端不认识配对语义。
  // 目标不在线时它给出的就是普通的"对方离线"，而不是"令牌无效"。
  const attacker = connect(presenceUrl('pd-attacker'));
  await attacker.open();
  attacker.send({
    t: 'pair-request',
    to: 'pd-nobody',
    token: '不存在的令牌',
    name: '陌生人',
    publicKey: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' },
  });
  const err = await attacker.next((m) => m.t === 'error', '收到回应');
  assert(err.code === 'peer-offline', `服务端只该报告对方离线，实际 ${JSON.stringify(err)}`);
  attacker.close();
});

await check('状态板：连接请求同样按设备号转发', async () => {
  // 通道不是自己这侧建的时候，客户端靠这条消息请对方发起。
  const owner = connect(presenceUrl('pd-owner'));
  const other = connect(presenceUrl('pd-other'));
  await Promise.all([owner.open(), other.open()]);
  other.send({ t: 'connect-request', to: 'pd-owner' });
  const got = await owner.next((m) => m.t === 'connect-request', '收到连接请求');
  assert(got.from === 'pd-other', `from 应当是 pd-other，实际 ${got.from}`);
  owner.close();
  other.close();
});

await check('状态板：登记配对码并查回来，带回对方公钥', async () => {
  const owner = connect(presenceUrl('code-owner', '我的电脑'));
  await owner.open();
  owner.send({
    t: 'hello',
    deviceId: 'code-owner',
    name: '我的电脑',
    publicKey: { kty: 'EC', crv: 'P-256', x: 'x1', y: 'y1' },
  });
  owner.send({ t: 'new-code' });
  const issued = await owner.next((m) => m.t === 'code', '拿到配对码');
  assert(/^\d{6}$/.test(issued.code), `码应当是 6 位数字，实际 ${issued.code}`);
  assert(issued.expiresAt > Date.now(), '应当带到期时间');

  const seeker = connect(presenceUrl('code-seeker'));
  await seeker.open();
  seeker.send({ t: 'lookup-code', code: issued.code });
  const found = await seeker.next((m) => m.t === 'code-owner', '查到码的主人');
  assert(found.deviceId === 'code-owner', `主人应当是 code-owner，实际 ${found.deviceId}`);
  assert(found.name === '我的电脑', '应当带上昵称');
  assert(found.publicKey?.x === 'x1', '应当带上主人公钥，查询方才能算六位数字');

  owner.close();
  seeker.close();
});

await check('状态板：查不到的码会明确回复，而不是沉默', async () => {
  const seeker = connect(presenceUrl('code-seeker'));
  await seeker.open();
  seeker.send({ t: 'lookup-code', code: '00000000' });
  const miss = await seeker.next((m) => m.t === 'code-miss', '收到查不到的回话');
  assert(miss.code === '00000000', '应当把码带回来');
  assert(typeof miss.reason === 'string' && miss.reason.length > 0, '应当说明原因');
  seeker.close();
});

await check('状态板：同一个码的短时自动重查不重复记错', async () => {
  const seeker = connect(presenceUrl('code-retry-dedupe'));
  await seeker.open();
  const missFor = async (code, label) =>
    seeker.next((m) => m.t === 'code-miss' && m.code === code, label);

  // 第一次查错：记 1 次
  seeker.send({ t: 'lookup-code', code: '910001' });
  await missFor('910001', '第一次查错');

  // 网页在 600ms 后自动重查同一个码：服务端直接回同一个 miss，不再记错
  seeker.send({ t: 'lookup-code', code: '910001' });
  const repeated = await missFor('910001', '同码自动重查');
  assert(repeated.retryAfterMs === undefined, '同码重查不该当场罚冷却');

  // 换一个真正的新错码：此时才应该记第 2 次。如果没有去重，这里已经进入冷却。
  seeker.send({ t: 'lookup-code', code: '910002' });
  const second = await missFor('910002', '第二个不同的错码');
  assert(second.retryAfterMs === undefined, '同码重查被去重后，第二个不同错码还不该罚站');
  seeker.close();
});

await check('状态板：查错两次之后进冷却，并且告诉还要等多久', async () => {
  const seeker = connect(presenceUrl('code-brute'));
  await seeker.open();

  // next() 只找不收，所以断言要按码区分，不然三次拿到的都是第一条
  const missFor = async (code, label) => seeker.next((m) => m.t === 'code-miss' && m.code === code, label);

  // 前两次错只当手滑，不罚
  for (const code of ['900001', '900002']) {
    seeker.send({ t: 'lookup-code', code });
    const miss = await missFor(code, `查错 ${code}`);
    assert(miss.retryAfterMs === undefined, `前两次不该罚站，实际 ${miss.retryAfterMs}`);
  }

  // 第三次开始罚站，并且说清楚还要等多久
  seeker.send({ t: 'lookup-code', code: '900003' });
  const cooled = await missFor('900003', '进入冷却');
  assert(cooled.retryAfterMs >= 4000, `冷却应当有明确的时长，实际 ${cooled.retryAfterMs}`);
  assert(/秒后/.test(cooled.reason ?? ''), `原因里应当写清楚还要等多久，实际 ${cooled.reason}`);

  // 冷却期间再查，还是同样的回话，不会多给一次机会
  seeker.send({ t: 'lookup-code', code: '900004' });
  const again = await missFor('900004', '冷却期间再查');
  assert(again.retryAfterMs > 0, '冷却期间仍然应当拒绝');
  seeker.close();
});

/* ============================================================== 分享注册表 */

let shareToken;

await check('注册一个分享，初始状态是离线（因为还没有对应的在线分享者）', async () => {
  const r = await postJson('/api/share', {
    deviceId: 'device-a',
    deviceName: '我的电脑',
    name: '相片.jpg',
    size: 2048,
    mime: 'image/jpeg',
  });
  assert(r.status === 201, `期望 201，得到 ${r.status}`);
  shareToken = r.body.token;

  const s = await api(`/api/share/${shareToken}`);
  assert(s.status === 200, '应该查得到');
  // 访客页面还没做，所以这里只能是 offline；在线与否要由在线状态板
  // 那边的连接状态合起来判断，注册表本身不存这个信息。
  assert(s.body.status === 'offline', `期望 offline，得到 ${s.body.status}`);
  assert(s.body.name === '相片.jpg', '应带上文件名');
  assert(s.body.deviceId === 'device-a', '应带上分享者设备号，访客靠它去找人');
  assert(s.body.room === undefined, '注册表里不该再有房间号');
});

await check('分享者离线不会删掉注册表条目，链接仍然可查', async () => {
  const s = await api(`/api/share/${shareToken}`);
  assert(s.body.status === 'offline', '应保持离线而不是查不到');
});

await check('只有分享者本人能撤销，撤销后状态变永久失效', async () => {
  const forbidden = await api(`/api/share/${shareToken}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-b' }),
  });
  assert(forbidden.status === 403, `别人撤销应返回 403，得到 ${forbidden.status}`);

  const ok = await api(`/api/share/${shareToken}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-a' }),
  });
  assert(ok.status === 200, `本人撤销应成功，得到 ${ok.status}`);

  const s = await api(`/api/share/${shareToken}`);
  assert(s.body.status === 'revoked', `撤销后应是 revoked，得到 ${s.body.status}`);
});

await check('分享列表反映状态和到期时间', async () => {
  const r = await api('/api/shares?deviceId=device-a');
  assert(r.status === 200, '应该返回 200');
  const mine = r.body.find((s) => s.token === shareToken);
  assert(mine, '列表里应有刚注册的那条');
  assert(mine.state === 'revoked', `列表状态应是 revoked，得到 ${mine.state}`);
  assert(mine.expiresAt > Date.now(), '应带上到期时间');
});

await check('分享数量有上限，防止一个设备刷爆注册表', async () => {
  let limited = false;
  for (let i = 0; i < 25; i++) {
    const r = await postJson('/api/share', {
      deviceId: 'device-flood',
      deviceName: '刷单设备',
      name: `f${i}.bin`,
      size: 1,
      mime: '',
    });
    if (r.status === 429) {
      limited = true;
      break;
    }
  }
  assert(limited, '超过上限后应返回 429');
});

await check('缺参数时明确拒绝，而不是写进一条坏记录', async () => {
  const noName = await postJson('/api/share', { deviceId: 'device-a' });
  assert(noName.status === 400, `没有文件名应返回 400，得到 ${noName.status}`);
  const noDevice = await postJson('/api/share', { name: 'x.bin' });
  assert(noDevice.status === 400, `没有设备号应返回 400，得到 ${noDevice.status}`);
});

await check('注册表原样带回分享者公钥，访客靠它锚定对方', async () => {
  const key = { kty: 'EC', crv: 'P-256', x: 'pub-x', y: 'pub-y' };
  const r = await postJson('/api/share', {
    deviceId: 'share-anchor',
    deviceName: '我的电脑',
    publicKey: key,
    name: '录像.mp4',
    size: 4096,
    mime: 'video/mp4',
  });
  assert(r.status === 201, `期望 201，得到 ${r.status}`);

  const s = await api(`/api/share/${r.body.token}`);
  assert(s.status === 200, '应该查得到');
  assert(s.body.publicKey?.x === 'pub-x', `应带回公钥，实际 ${JSON.stringify(s.body.publicKey)}`);
  assert(
    s.body.publicKey?.crv === 'P-256',
    '公钥要能直接交给 WebCrypto 验签，曲线参数不能在路上丢掉',
  );
});

await check('没有登记公钥的老记录仍然可查，但锚点是空的', async () => {
  const r = await postJson('/api/share', {
    deviceId: 'share-nokey',
    deviceName: '旧版客户端',
    name: '笔记.txt',
    size: 10,
    mime: 'text/plain',
  });
  assert(r.status === 201, `旧客户端不送公钥也该挂得上，得到 ${r.status}`);

  const s = await api(`/api/share/${r.body.token}`);
  // 服务端不猜、不补一个看起来能用但实际上推不出设备号的钥匙。
  // 访客看到 kty 是 none 会拒绝连接，这是界面要显式说清楚的"验不了对方"。
  assert(s.body.publicKey?.kty === 'none', `缺公钥应如实标成 none，实际 ${JSON.stringify(s.body.publicKey)}`);
});

await check('分享者上线之后，同一条链接的状态从离线合成成可用', async () => {
  const r = await postJson('/api/share', {
    deviceId: 'share-live',
    deviceName: '我的电脑',
    publicKey: { kty: 'EC', crv: 'P-256', x: 'live-x', y: 'live-y' },
    name: '安装包.exe',
    size: 8192,
    mime: 'application/octet-stream',
  });
  assert(r.status === 201, `期望 201，得到 ${r.status}`);

  const before = await api(`/api/share/${r.body.token}`);
  assert(before.body.status === 'offline', `没人上线时应是 offline，得到 ${before.body.status}`);

  const seeder = connect(presenceUrl('share-live', '我的电脑'));
  await seeder.open();
  const after = await api(`/api/share/${r.body.token}`);
  assert(
    after.body.status === 'available',
    `分享者上线后应是 available，得到 ${after.body.status}（在线判断来自状态板，注册表不存它）`,
  );

  seeder.close();
  await sleep(200);
  const gone = await api(`/api/share/${r.body.token}`);
  assert(gone.body.status === 'offline', `分享者断开后应回到 offline，得到 ${gone.body.status}`);
});

await check('到期时间过了就是已过期，和在不在线无关', async () => {
  const r = await postJson('/api/share', {
    deviceId: 'share-expired',
    deviceName: '我的电脑',
    name: '临时.txt',
    size: 1,
    mime: 'text/plain',
    ttlMs: -1000,
  });
  assert(r.status === 201, `期望 201，得到 ${r.status}`);

  const holder = connect(presenceUrl('share-expired'));
  await holder.open();
  const s = await api(`/api/share/${r.body.token}`);
  assert(s.body.status === 'expired', `过期的分享即使人还在线也应判 expired，得到 ${s.body.status}`);
  holder.close();
});

await check('撤销优先于在线：被叫停的分享，分享者上线也不复活', async () => {
  const r = await postJson('/api/share', {
    deviceId: 'share-revoked-live',
    deviceName: '我的电脑',
    name: '撤回.txt',
    size: 1,
    mime: 'text/plain',
  });
  await api(`/api/share/${r.body.token}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'share-revoked-live' }),
  });

  const holder = connect(presenceUrl('share-revoked-live'));
  await holder.open();
  const s = await api(`/api/share/${r.body.token}`);
  assert(s.body.status === 'revoked', `撤销是永久状态，得到 ${s.body.status}`);
  holder.close();
});

/* ============================================================== 汇总 */

const failed = results.filter((r) => !r.ok);
console.log(`\n  ── 灯塔：${results.length - failed.length}/${results.length} 通过`);
if (failed.length) {
  console.log('\n失败详情：');
  for (const f of failed) console.log(`\n[${f.name}]\n${f.message}`);
}
process.exit(failed.length ? 1 : 0);
