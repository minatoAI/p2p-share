/**
 * 灯塔集成测试的启动器：起一个本地 wrangler，等它就绪，跑测试，然后收摊。
 *
 * 直接用 node_modules 里的 wrangler 入口，不走 shell，
 * 这样 Windows 上 child.kill() 能真的把 workerd 带走。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '../..');
const port = 18000 + Math.floor(Math.random() * 800);
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 这个 Worker 现在只提供接口和 Durable Objects，不托管静态资源，
// 所以起它之前不需要先构建前端。前端产物归 pages/dist，由 Pages 项目上传。

const wranglerBin = path.join(appDir, 'node_modules/wrangler/bin/wrangler.js');
const child = spawn(process.execPath, [wranglerBin, 'dev', '--port', String(port), '--ip', '127.0.0.1'], {
  cwd: appDir,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (b) => {
  serverLog += b;
});
child.stderr.on('data', (b) => {
  serverLog += b;
});

async function waitForReady() {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) return false;
    try {
      const res = await fetch(`${base}/api/health`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  return false;
}

const ready = await waitForReady();
if (!ready) {
  console.error(`wrangler 没起来。日志：\n${serverLog}`);
  child.kill();
  process.exit(1);
}

const test = spawn(process.execPath, [path.join(__dirname, 'lighthouse.mjs'), base], { stdio: 'inherit' });
const code = await new Promise((resolve) => test.on('exit', (c) => resolve(c ?? 1)));

child.kill();
await sleep(300);
process.exit(code);
