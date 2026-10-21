/**
 * 把 /api/* 原样转发给灯塔 Worker。
 *
 * service binding 的请求不出 Cloudflare 网络，也不经过 Internet，
 * 所以这里没有额外的网络开销和鉴权问题：能调到的只有自己账号下的 Worker。
 *
 * 转发时保留原始 Request：路径、查询串、请求体、方法都不动，
 * Worker 那边的 Hono 路由看到的 URL 和直连时完全一样。
 */
export const onRequest = ({ request, env }) => env.LIGHTHOUSE.fetch(request);
