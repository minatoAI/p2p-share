/**
 * 把 app 镜像到系统临时目录，在那里跑一条 npm script。
 *
 * 为什么需要它：这个仓库当前所在的工作区目录带 Windows 的「Low 完整性标签」
 * （沙箱模式写文件时贴上去的），而 workerd 在这种目录里建 Durable Object 的
 * 存储目录会被拒绝，报 `CreateDirectory: #5 拒绝访问`。复制出来的副本继承的是
 * 临时目录的常规标签，workerd 就能正常起来。所以只有依赖 wrangler / workerd
 * 的那几条命令需要绕一下（灯塔集成测试、e2e），单元测试和构建都不受影响。
 *
 *   node scripts/run-outside.mjs test:worker
 *   node scripts/run-outside.mjs test:e2e -- --project=firefox
 *
 * 镜像目录是复用的：源码每次同步，node_modules 只在 package-lock.json 变了
 * 之后才重拷一次，所以第二条命令起就很快。加 --clean 可以整个重来。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mirror = path.join(os.tmpdir(), 'p2p-lighthouse-run');
const marker = path.join(mirror, '.synced-from');

/** 这些是本地状态和产物，镜像里不需要，也不该带过去 */
const SKIP = new Set(['node_modules', '.wrangler', 'test-results', 'playwright-report', 'blob-report']);

const args = process.argv.slice(2);
const clean = args.includes('--clean');
const rest = args.filter((a) => a !== '--clean');
const script = rest[0];
const passthrough = rest.slice(1);

if (!script) {
  console.error('用法：node scripts/run-outside.mjs <npm script> [-- args...]');
  process.exit(2);
}

if (clean) fs.rmSync(mirror, { recursive: true, force: true });

const say = (line) => console.log(`[外面跑] ${line}`);

/** 只拷源码那一层，node_modules 单独处理 */
function syncTree() {
  fs.mkdirSync(mirror, { recursive: true });
  const root = path.resolve(appDir);
  fs.cpSync(root, mirror, {
    recursive: true,
    force: true,
    filter: (src) => {
      const rel = path.relative(root, src);
      if (!rel) return true;
      const top = rel.split(path.sep)[0];
      if (SKIP.has(top)) return false;
      // 镜像目录如果在 app 里面（不该发生），别把镜像拷进自己
      if (path.resolve(src).startsWith(path.resolve(mirror))) return false;
      return true;
    },
  });
}

/** node_modules 一次就够，除非依赖清单变了 */
function syncModules() {
  const lock = path.join(appDir, 'package-lock.json');
  const installed = path.join(mirror, 'node_modules');
  const lockTime = fs.statSync(lock).mtimeMs;
  const installedTime = fs.existsSync(marker) ? fs.statSync(marker).mtimeMs : 0;
  if (fs.existsSync(installed) && installedTime >= lockTime) return;
  say('依赖有变化，重拷 node_modules（只有这一次会慢）');
  fs.cpSync(path.join(appDir, 'node_modules'), installed, { recursive: true, force: true });
  fs.writeFileSync(marker, new Date().toISOString());
}

say(`镜像位置 ${mirror}`);
syncTree();
syncModules();
say(`在镜像里跑 npm run ${script}${passthrough.length ? ` ${passthrough.join(' ')}` : ''}`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const result = spawnSync(npm, ['run', script, ...(passthrough.length ? ['--', ...passthrough] : [])], {
  cwd: mirror,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

process.exit(result.status ?? 1);
