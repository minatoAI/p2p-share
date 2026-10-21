// 用 vitest/config 的 defineConfig，这样 test 字段有类型
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// 前端开发服务器把灯塔相关路径代理到本地 wrangler（默认 8787），
// 这样浏览器里只有一个来源，WebSocket 也不用处理跨域。
// 同时开着几份 worktree 时端口会撞，所以让它跟着 LIGHTHOUSE_PORT 走。
const lighthousePort = process.env.LIGHTHOUSE_PORT ?? '8787';

export default defineConfig({
  plugins: [react()],
  build: {
    // 产物直接落到 Pages 项目里，`wrangler pages deploy` 从那里上传。
    // 原因是 Durable Objects 不能定义在 Pages 项目里（官方明确写了），
    // 所以接口留在 Worker，Pages 只负责静态资源加转发。
    outDir: 'pages/dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://127.0.0.1:${lighthousePort}`,
      '/ws': { target: `ws://127.0.0.1:${lighthousePort}`, ws: true },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
