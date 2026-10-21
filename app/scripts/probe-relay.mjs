/**
 * 直接问灯塔：按失败时那条一模一样的顺序发信令，sdp 会不会丢。
 *
 * 为什么要有这个：端到端复现一次要跑十几分钟，而且失败是概率性的。如果问题
 * 出在灯塔的中继上，用两个裸 WebSocket 客户端几秒钟就能问出答案，还不用管
 * 浏览器和原生端的时序。先把范围缩到"是不是灯塔"，再回去查别的。
 *
 * 用法：
 *   node scripts/probe-relay.mjs                 跑一轮，打印每一步到没到
 *   node scripts/probe-relay.mjs --rounds 200    跑 200 轮统计丢包
 */

const URL_BASE = process.env.LIGHTHOUSE ?? 'ws://127.0.0.1:8787/ws/presence';
const roundsArg = process.argv.indexOf('--rounds');
const ROUNDS = roundsArg > -1 ? Number(process.argv[roundsArg + 1]) : 1;

/** 起一个客户端，收到的消息按 t 记进数组 */
function client(deviceId, name) {
  const url = `${URL_BASE}?deviceId=${encodeURIComponent(deviceId)}&name=${encodeURIComponent(name)}`;
  const ws = new WebSocket(url);
  const received = [];
  const waiters = [];
  ws.addEventListener('message', (ev) => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    received.push(msg.t);
    // 只摘掉这次能匹配的等待者。早先写成 waiters.splice(0) 把所有等待者一次
    // 全摘了，不匹配的那些就永远不会再被调用——探针自己会凭空报"丢了"。
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i](msg)) waiters.splice(i, 1);
    }
  });
  return {
    ws,
    received,
    open: () =>
      new Promise((resolve, reject) => {
        ws.addEventListener('open', () => resolve(), { once: true });
        ws.addEventListener('error', () => reject(new Error('连不上灯塔')), { once: true });
      }),
    send: (msg) => ws.send(JSON.stringify(msg)),
    /** 等一条指定类型的消息，超时返回 null */
    waitFor: (type, timeoutMs = 3000) =>
      new Promise((resolve) => {
        const hit = received.includes(type);
        if (hit) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), timeoutMs);
        waiters.push((msg) => {
          if (msg.t !== type) return false;
          clearTimeout(timer);
          resolve(true);
          return true;
        });
      }),
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function oneRound(index) {
  const stamp = `${Date.now().toString(36)}${index}`;
  const a = client(`aaa${stamp}`.padEnd(20, '0'), '甲');
  const b = client(`bbb${stamp}`.padEnd(20, '0'), '乙');
  const missing = [];

  try {
    await Promise.all([a.open(), b.open()]);
    a.send({ t: 'hello', deviceId: `aaa${stamp}`.padEnd(20, '0'), name: '甲', publicKey: {} });
    b.send({ t: 'hello', deviceId: `bbb${stamp}`.padEnd(20, '0'), name: '乙', publicKey: {} });
    await sleep(60);

    // 从这里开始，顺序和端到端失败时记录到的完全一致
    a.send({ t: 'new-code', code: '12345678' });
    b.send({ t: 'code', code: '12345678' });
    await sleep(40);

    b.send({ t: 'pair-request', to: `aaa${stamp}`.padEnd(20, '0') });
    await sleep(40);

    a.send({ t: 'pair-response', to: `bbb${stamp}`.padEnd(20, '0'), accepted: true });
    a.send({ t: 'watch', ids: [`bbb${stamp}`.padEnd(20, '0')] });
    // 关键的两条：紧挨着发出去，看是不是只有 sdp 会丢
    a.send({
      t: 'sdp',
      to: `bbb${stamp}`.padEnd(20, '0'),
      description: { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' },
    });
    for (let i = 0; i < 3; i++) {
      a.send({ t: 'ice', to: `bbb${stamp}`.padEnd(20, '0'), candidate: { candidate: `c${i}` } });
    }

    const gotSdp = await b.waitFor('sdp', 2000);
    // 等冰也到齐再统计。sdp 一到就立刻数，冰还在路上，会误报丢包
    await b.waitFor('ice', 1000);
    await sleep(200);
    const iceCount = b.received.filter((t) => t === 'ice').length;
    if (!gotSdp) missing.push('sdp');
    if (iceCount < 3) missing.push(`ice ${iceCount}/3`);
    if (ROUNDS <= 5) missing.push(`[乙收到：${b.received.join(',')}]`);
  } finally {
    a.close();
    b.close();
  }
  return missing;
}

let sdpLost = 0;
let iceLost = 0;
for (let i = 0; i < ROUNDS; i++) {
  const missing = await oneRound(i);
  if (missing.some((m) => m.startsWith('sdp'))) sdpLost++;
  if (missing.some((m) => m.startsWith('ice'))) iceLost++;
  if (ROUNDS <= 5 || missing.length) {
    console.log(`第 ${i + 1} 轮：${missing.length ? `丢了 ${missing.join('、')}` : '全部收到'}`);
  }
  await sleep(30);
}

console.log(`\n共 ${ROUNDS} 轮：sdp 丢失 ${sdpLost} 次，ice 丢失 ${iceLost} 次`);
