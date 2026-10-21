/**
 * 把 /ws/* 转发给灯塔 Worker，包括 /ws/presence 的 WebSocket 升级。
 *
 * 这里必须原样透传 Request，不能重建：Upgrade 头一旦丢掉就升级不成
 * WebSocket，页面会一直停在"正在连灯塔"。
 */
export const onRequest = ({ request, env }) => env.LIGHTHOUSE.fetch(request);
