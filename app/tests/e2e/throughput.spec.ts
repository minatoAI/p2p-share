import { expect, test } from '@playwright/test';

// 吞吐基准要独占机器：并行跑的时候别的用例会抢 CPU，数字就没意义了
test.describe.configure({ mode: 'serial' });
import os from 'node:os';
import { device, expectReceived, pair, readPath, sendBigFile, sendPanel } from './helpers';

/**
 * 吞吐基准。
 *
 * 默认不跑，因为它要传几百兆、要花几十秒。想跑就设环境变量：
 *
 *   E2E_THROUGHPUT=1 npx playwright test throughput
 *   E2E_THROUGHPUT=1 E2E_SIZE_MB=500 npx playwright test throughput
 *   E2E_THROUGHPUT=1 E2E_BASE_URL=https://p2p-share-web.pages.dev npx playwright test throughput
 *
 * 它的用处是分出"应用自身的上限"和"这段链路的实际速度"：
 * 两个上下文在同一台机器上、走 host 候选，所以这个数字就是应用能跑到多快。
 * 真机上远低于这个数，问题就在链路上，不在引擎里。
 */
test('吞吐基准：同一台机器上的两个浏览器上下文', async ({ browser }) => {
  test.skip(!process.env.E2E_THROUGHPUT, '要跑就设 E2E_THROUGHPUT=1');
  test.setTimeout(30 * 60_000);

  const sizeMb = Number(process.env.E2E_SIZE_MB ?? 200);
  const bytes = sizeMb * 1024 * 1024;

  const a = await device(browser, '发送端');
  const b = await device(browser, '接收端');
  await pair(a.page, b.page);
  await sendPanel(a.page).waitFor();

  // 等连接真的认证通过再开表，不然第一秒会被握手时间污染
  await expect(b.page.getByTestId('send-panel')).toBeVisible();
  await b.page.waitForTimeout(500);

  // 采样整机 CPU：用来判断这个上限是网络给的还是浏览器 CPU 给的。
  // 如果是 CPU 给的，那局域网和广域网的上限就是同一个数。
  const sample = () => os.cpus().reduce(
    (acc, c) => ({ busy: acc.busy + c.times.user + c.times.nice + c.times.sys, total: acc.total + Object.values(c.times).reduce((a, b) => a + b, 0) }),
    { busy: 0, total: 0 },
  );
  const cpu0 = sample();
  const started = Date.now();
  await sendBigFile(a.page, `基准-${sizeMb}MB.bin`, bytes);
  // 大文件要给足时间，按 1 MB/s 这种最坏情况留余量
  await expectReceived(b.page, `基准-${sizeMb}MB.bin`, Math.max(120_000, sizeMb * 1000));
  const seconds = (Date.now() - started) / 1000;

  const cpu1 = sample();
  const cores = os.cpus().length;
  // 整机占用换算成"用满了几个核"
  const coresBusy = ((cpu1.busy - cpu0.busy) / (cpu1.total - cpu0.total)) * cores;
  const mbps = sizeMb / seconds;
  console.log(`
  传输期间 CPU：整机 ${coresBusy.toFixed(2)} 个核在忙（共 ${cores} 核）`);
  console.log(
    `\n  吞吐：${mbps.toFixed(1)} MB/s（${sizeMb} MB 用了 ${seconds.toFixed(1)} 秒，约 ${(mbps * 8).toFixed(0)} Mbps）`,
  );
  console.log(`  发送端路径：${await readPath(a.page)}`);
  console.log(`  接收端路径：${await readPath(b.page)}\n`);

  await a.context.close();
  await b.context.close();
});
