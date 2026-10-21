/**
 * 原生端与浏览器端的互通。
 *
 * 这是整个原生客户端项目真正要证明的一件事：两边说同一套协议，
 * 能配对、能认证、能互传文件。前面的单元测试和跨语言对拍都是为它铺路。
 *
 * 需要先构建原生端：
 *   cd native && cargo build
 * 缺了二进制就跳过，不让它把整套端到端拖红。
 */

import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { device, sendFile } from './helpers';

// 默认用 C++ 版。想测 Rust 版就设 NATIVE_BIN 指过去。
const NATIVE_BIN =
  process.env.NATIVE_BIN ??
  join(process.cwd(), '..', 'native-cpp', 'build', 'p2p.exe');
// C++ 版链接的是 vcpkg 里的动态库，子进程的 PATH 要带上
const VCPKG_BIN = process.env.VCPKG_BIN ?? 'E:\dshHome\vcpkg\installed\x64-windows\bin';
// 默认打本地 wrangler（Miniflare）。设 LIGHTHOUSE 指向线上 Pages 端点就能
// 做"本地 vs 线上"的对照，判断某个问题是 Miniflare 的产物还是真问题。
const LIGHTHOUSE = process.env.LIGHTHOUSE ?? 'ws://127.0.0.1:8787/ws/presence';

/** 起一个原生端进程，把输出收起来供断言 */
function runNative(args: string[]) {
  const child = spawn(NATIVE_BIN, args, {
    windowsHide: true,
    env: { ...process.env, PATH: `${VCPKG_BIN};${process.env.PATH ?? ''}` },
  });
  let output = '';
  child.stdout.on('data', (b) => (output += String(b)));
  child.stderr.on('data', (b) => (output += String(b)));
  const done = new Promise<number>((resolve) => child.on('exit', (code) => resolve(code ?? -1)));
  return { child, output: () => output, done };
}

/** 从浏览器页面上读六位配对码 */
async function readCode(page: import('@playwright/test').Page): Promise<string> {
  await expect(page.getByTestId('pair-code')).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  const text = await page.getByTestId('pair-code').innerText();
  return text.replace(/\D/g, '');
}

test.describe('原生端与浏览器互通', () => {
  test.skip(() => !existsSync(NATIVE_BIN), '原生端还没构建，跳过');

  test('原生端发文件，浏览器收到', async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const peer = await device(browser, '浏览器端');
    const code = await readCode(peer.page);

    // 造一个跨分片边界的文件
    const dir = mkdtempSync(join(tmpdir(), 'native-send-'));
    const source = join(dir, '原生发的.bin');
    const payload = Buffer.alloc(700_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 251;
    writeFileSync(source, payload);

    const native = runNative([
      'join', code,
      '--name', '原生 Windows',
      '--send', source,
      '--lighthouse', LIGHTHOUSE,
    ]);

    // 浏览器这边核对六位数字并确认
    await expect(peer.page.getByTestId('confirm-panel')).toBeVisible({ timeout: 40_000 });
    await peer.page.getByRole('button', { name: '一致', exact: true }).click();

    // 浏览器应当收到，并且大小对得上
    const item = peer.page.locator('.item', { hasText: '原生发的.bin' }).first();
    try {
      await expect(item).toBeVisible({ timeout: 30_000 });
      await expect(item).toContainText('已完成', { timeout: 30_000 });
    } catch (err) {
      const nl = String.fromCharCode(10);
      await peer.page.locator('.logs').evaluate((el) => el.setAttribute('open', '')).catch(() => {});
      console.log('浏览器日志：', (await peer.page.locator('.log').innerText()).split(nl).join(' || '));
      // 最原始的到达记录：帧有没有到 WebSocket 这一层
      const frames = await peer.page.evaluate(
        () =>
          (globalThis as unknown as { __signalFrames?: { len: number; head: string }[] })
            .__signalFrames ?? [],
      );
      console.log(
        '浏览器收到的原始帧：',
        frames.map((f) => `${f.len}B:${f.head.slice(0, 24)}`).join(' || '),
      );
      console.log('原生端：', native.output().split(nl).join(' || '));
      throw err;
    }
    await expect(item.locator('.tag.fmt')).toHaveText('文件');

    const exit = await native.done;
    expect(native.output()).toContain('双向认证通过');
    expect(exit).toBe(0);

    await peer.context.close();
  });

  test('浏览器发文件，原生端收到并且字节一致', async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const dir = mkdtempSync(join(tmpdir(), 'native-recv-'));
    // 先把目录建好：Windows 上进程刚起时对新建临时目录的第一次 mkdir 偶尔会
    // 拿到 ACCESS_DENIED（安全软件/索引器短暂持有），原生端拿不到目录就退出。
    // 目录名保持中文，顺带覆盖 UTF-8 路径。
    const saveDir = join(dir, '收到');
    mkdirSync(saveDir, { recursive: true });
    const payload = Buffer.alloc(600_000);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 17) % 253;

    const native = runNative([
      'advertise',
      '--name', '原生 Windows',
      '--auto-accept',
      '--save-dir', saveDir,
      '--lighthouse', LIGHTHOUSE,
    ]);

    // 从原生端输出里取配对码
    let code = '';
    for (let i = 0; i < 60 && !code; i++) {
      const match = /配对码 (\d{6})/.exec(native.output());
      if (match) code = match[1]!;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(code, `原生端没给出配对码：${native.output()}`).toMatch(/^\d{6}$/);

    // 浏览器输码连过去
    const peer = await device(browser, '浏览器端');
    // 输满自动连，见 helpers.ts 里的说明
    await peer.page.getByTestId('pair-active').click();
    await peer.page.getByTestId('join-input').fill(code);
    // 输码方只显示六位数字让人念出来，确认要由报码方做——也就是原生端，
    // 它带着 --auto-accept。所以这里没有按钮可点，等它确认就行。
    // confirm-panel 是个**过渡状态**：配对一完成它就被 send-panel 替换掉。
    // 断言它的文字是在跟这场竞态赛跑，对端确认得够快就会输——实测这是
    // "Expected substring: 等它确认 / element(s) not found"，一项测试自身的
    // 假失败。真正要验的是最终到达了 send-panel，所以只断言那个。
    await expect(peer.page.getByTestId('send-panel')).toBeVisible({ timeout: 60_000 });

    // 发一个文件过去
    await sendFile(peer.page, '浏览器发的.bin', payload, 'application/octet-stream');
    try {
      await expect(peer.page.locator('.item', { hasText: '浏览器发的.bin' })).toContainText('已完成', {
        timeout: 30_000,
      });
    } catch (err) {
      await peer.page.locator('.logs').evaluate((el) => el.setAttribute('open', '')).catch(() => {});
      const nl = String.fromCharCode(10);
      console.log('浏览器时间线：', (await peer.page.locator('.timeline').innerText()).split(nl).join(' | '));
      console.log('浏览器日志：', (await peer.page.locator('.log').innerText()).split(nl).slice(-8).join(' || '));
      // 最原始的到达记录：帧有没有到 WebSocket 这一层（解析之前）
      const frames = await peer.page.evaluate(
        () =>
          (globalThis as unknown as { __signalFrames?: { len: number; head: string }[] })
            .__signalFrames ?? [],
      );
      console.log('浏览器收到的原始帧：', frames.map((f) => `${f.len}B:${f.head.slice(0, 30)}`).join(' || '));
      console.log('原生端输出：', native.output().split(nl).slice(-140).join(' || '));
      throw err;
    }

    await native.done;
    const received = join(saveDir, '浏览器发的.bin');
    expect(existsSync(received), `原生端没落盘：${native.output()}`).toBe(true);
    const got = readFileSync(received);
    expect(got.byteLength).toBe(payload.byteLength);
    expect(Buffer.compare(got, payload)).toBe(0);

    await peer.context.close();
  });
});

test.describe('原生端与浏览器互通：文字', () => {
  test.skip(() => !existsSync(NATIVE_BIN), '原生端还没构建，跳过');

  test('原生端发文字，浏览器收到', async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const peer = await device(browser, '浏览器端');
    const code = await readCode(peer.page);

    const native = runNative([
      'join', code,
      '--name', '原生 Windows',
      '--text', '原生端发来的一段话',
      '--lighthouse', LIGHTHOUSE,
    ]);

    await expect(peer.page.getByTestId('confirm-panel')).toBeVisible({ timeout: 40_000 });
    await peer.page.getByRole('button', { name: '一致', exact: true }).click();

    const item = peer.page.locator('.item', { hasText: '原生端发来的一段话' }).first();
    await expect(item).toBeVisible({ timeout: 60_000 });
    // 文字应该带"文字"标签，而不是文件的那种格式标签
    await expect(item.locator('.tag.fmt')).toHaveText('文字');
    await native.done;
    await peer.context.close();
  });

  test('浏览器发文字，原生端收到', async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const dir = mkdtempSync(join(tmpdir(), 'native-text-'));
    const native = runNative([
      'advertise',
      '--name', '原生 Windows',
      '--auto-accept',
      '--save-dir', dir,
      '--lighthouse', LIGHTHOUSE,
    ]);

    let code = '';
    for (let i = 0; i < 60 && !code; i++) {
      const match = /配对码 (\d{6})/.exec(native.output());
      if (match) code = match[1]!;
      else await new Promise((r) => setTimeout(r, 500));
    }
    expect(code).toMatch(/^\d{6}$/);

    const peer = await device(browser, '浏览器端');
    // 输满自动连，见 helpers.ts 里的说明
    await peer.page.getByTestId('pair-active').click();
    await peer.page.getByTestId('join-input').fill(code);
    await expect(peer.page.getByTestId('send-panel')).toBeVisible({ timeout: 60_000 });

    // 会话页默认停在「文件」页签，textarea 只在「文字」页签里；不先切过去
    // 会一直等一个不存在的元素，把真实失败拖成 180 秒超时。
    await peer.page.getByTestId('tab-text').click();
    await peer.page.locator('textarea').first().fill('浏览器发来的一段话');
    await peer.page.getByRole('button', { name: '发送' }).click();

    await native.done;
    expect(native.output()).toContain('收到文字：浏览器发来的一段话');
    await peer.context.close();
  });
});
