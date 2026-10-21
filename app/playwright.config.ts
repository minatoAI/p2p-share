import { defineConfig, devices } from '@playwright/test';

/**
 * 端到端测试。两个浏览器上下文当成两台设备，各自独立的 IndexedDB，
 * 所以设备身份、通讯录、时间线都是分开的。
 *
 * 两种跑法：
 *
 *   默认打本机 `http://localhost:5173`。`http://localhost` 在规范里算
 *   "潜在可信来源"，所以 `crypto.subtle` 可用，配对认证这一整套能真的跑起来，
 *   不需要 HTTPS。
 *
 *   设了 `E2E_BASE_URL` 就打线上，例如：
 *     E2E_BASE_URL=https://p2p-share-web.pages.dev npx playwright test
 *   这一趟验证的是真实 HTTPS、真实证书、真实公网，也是手机实际会遇到的环境。
 *   手机访问 http://192.168.x.x 是非安全上下文，那一档测不了认证。
 */

const remote = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  // 每条用例自己开上下文、自己配对，互不共享状态，所以可以并行。
  // 只有吞吐基准要独占机器，它自己声明了串行（见 throughput.spec.ts）。
  fullyParallel: true,
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : 3,
  reporter: [['list']],
  use: {
    baseURL: remote ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      // 同一份基准在 Firefox 上再跑一遍。浏览器数据通道的上限是引擎实现决定的，
      // 如果是 Chromium 独有，那换个浏览器就是一条能直接给用户的建议。
      // 只在跑裸通道基准和端到端时用得上：--project=firefox
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
      },
      testIgnore: ['**/throughput.spec.ts'],
    },
    {
      name: 'msedge',
      use: {
        ...devices['Desktop Chrome'],
        // 用系统已装的 Edge，省掉一次几百兆的浏览器下载。
        // 想换成 Playwright 自带的 chromium，先跑 npx playwright install chromium
        // 再把这一行删掉。
        channel: 'msedge',
        launchOptions: {
          // headless Chromium 默认把本地候选伪装成 mDNS 名字。两个上下文在同一台机器上，
          // 关掉这层伪装能让点对点连接稳定得多。
          args: ['--disable-features=WebRtcHideLocalIpsWithMdns'],
        },
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],
  // 打线上时不需要本地服务
  webServer: remote
    ? undefined
    : [
        {
          command: 'npm run dev:worker',
          url: 'http://127.0.0.1:8787/api/health',
          reuseExistingServer: true,
          timeout: 120_000,
        },
        {
          command: 'npm run dev',
          url: 'http://localhost:5173',
          reuseExistingServer: true,
          timeout: 120_000,
        },
      ],
});
