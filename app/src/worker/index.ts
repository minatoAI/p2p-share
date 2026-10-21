import { Hono } from 'hono';
import type { ShareRecord, ShareStatus } from '../core/protocol';
import { PresenceDO } from './presence';
import { RegistryDO } from './registry';
import type { Env } from './types';

export { PresenceDO, RegistryDO };

/**
 * 灯塔的 HTTP 面。
 *
 * 只有两件事：
 *   /ws/presence  按设备号寻址的信令长连接和在线状态板
 *   /api/share*   分享注册表，只存元信息，不存字节
 *
 * 没有房间。房间这个概念是给"一间屋子里的陌生人"用的，而配对和分享
 * 都按设备号寻址就够了，见 docs/11 第 5 节。
 *
 * 这里也没有任何一条路由会转发文件数据。原因见 docs/11 第 2 节：
 * Durable Objects 免费版每条 WebSocket 消息都算一次请求，数据走这里会把额度烧穿。
 *
 * 配对这件事服务端完全不参与：邀请令牌存在发起方本地，公钥走二维码，
 * 认证走点对点数据通道。所以这里找不到任何配对接口。
 */
const app = new Hono<{ Bindings: Env }>();

const registryOf = (env: Env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));
// 单实例。到瓶颈时按设备号前缀分片，代价是跨分片的在线通知要多一跳。
const presenceOf = (env: Env) => env.PRESENCE.get(env.PRESENCE.idFromName('presence'));

const REGISTRY_ORIGIN = 'https://registry.internal';
const PRESENCE_ORIGIN = 'https://presence.internal';

function postJson(stub: DurableObjectStub, path: string, body: unknown): Promise<Response> {
  return stub.fetch(`${REGISTRY_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

/* ------------------------------------------------------------ 基础 */

app.get('/api/health', (c) => c.json({ ok: true, now: Date.now() }));

app.get('/api/lighthouse/info', (c) =>
  c.json({
    name: 'p2p-lighthouse',
    phase: 2,
    // 明确告诉客户端这个灯塔不提供存储，链接分享靠分享者在线
    capabilities: { signaling: true, shareRegistry: true, storage: false, turn: false },
  }),
);

/* ------------------------------------------------------------ 分享 */

app.post('/api/share', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  return postJson(registryOf(c.env), '/share', body);
});

/**
 * 访客查一条分享。这里是四个状态的合成点。
 *
 * 注册表只知道"撤销过没有、过期没有"，在线状态板才知道"此刻有没有活的连接"。
 * 两个 Durable Object 各自都不该存对方的事实，所以由同时握着两个句柄的
 * Worker 来合。这多出来的一次 DO 调用只在访客打开链接时发生，不是热路径。
 */
app.get('/api/share/:token', async (c) => {
  const token = encodeURIComponent(c.req.param('token'));
  const found = await registryOf(c.env).fetch(`${REGISTRY_ORIGIN}/share/${token}`);
  if (!found.ok) return found;
  const record = (await found.json()) as ShareRecord;

  const presenceRes = await presenceOf(c.env).fetch(
    `${PRESENCE_ORIGIN}/presence?ids=${encodeURIComponent(record.deviceId)}`,
  );
  const entries = presenceRes.ok
    ? ((await presenceRes.json()) as Array<{ id: string; online: boolean }>)
    : [];
  const online = entries.some((e) => e.id === record.deviceId && e.online);

  const now = Date.now();
  const status: ShareStatus['status'] =
    record.state === 'revoked'
      ? 'revoked'
      : record.expiresAt < now
        ? 'expired'
        : online
          ? 'available'
          : 'offline';

  return c.json({
    token: record.token,
    status,
    name: record.name,
    size: record.size,
    mime: record.mime,
    deviceName: record.deviceName,
    deviceId: record.deviceId,
    publicKey: record.publicKey,
    expiresAt: record.expiresAt,
  } satisfies ShareStatus);
});

app.delete('/api/share/:token', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { deviceId?: string };
  return postJson(registryOf(c.env), `/share/${encodeURIComponent(c.req.param('token'))}/revoke`, body);
});

app.get('/api/shares', (c) =>
  registryOf(c.env).fetch(
    `${REGISTRY_ORIGIN}/shares?deviceId=${encodeURIComponent(c.req.query('deviceId') ?? '')}`,
  ),
);

/* ------------------------------------------------------------ 在线状态板 */

/**
 * 按设备号寻址的信令通道。这是唯一一条信令路径：
 * 两台已经配对的设备各自声明身份，订阅对方的在线状态，直接互发 SDP 和 ICE。
 */
app.get('/ws/presence', async (c) => {
  const deviceId = c.req.query('deviceId');
  if (!deviceId) return c.json({ error: 'missing-device-id' }, 400);
  // 原样转发请求，Upgrade 头必须保留，否则升级不成 WebSocket
  return presenceOf(c.env).fetch(c.req.raw);
});

app.get('/api/presence', (c) => {
  const ids = c.req.query('ids') ?? '';
  return presenceOf(c.env).fetch(`${PRESENCE_ORIGIN}/presence?ids=${encodeURIComponent(ids)}`);
});

/* ------------------------------------------------------------ 兜底 */

// 这个 Worker 不提供页面。静态资源由 Pages 项目负责，
// 只有 /api/* 和 /ws/* 会通过 service binding 转发到这里。
app.notFound((c) => c.json({ error: 'not-found', path: new URL(c.req.url).pathname }, 404));

export default app;
