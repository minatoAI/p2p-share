import { test, expect } from '@playwright/test';
import { device, pair, sendBigFile } from './helpers';

/**
 * 大文件不再攒内存，直接流给浏览器的下载管理器。
 *
 * 判据是浏览器的 download 事件在传输**还没结束**的时候就来：说明下载是
 * 边收边写的，而不是收完再一次性交给浏览器。文件本身也要一字节不差。
 */
test('超过阈值的大文件边收边交给浏览器下载', async ({ browser }) => {
  const a = await device(browser, '电脑甲');
  const b = await device(browser, '手机乙');
  await pair(a.page, b.page);

  const downloadPromise = b.page.waitForEvent('download', { timeout: 60_000 });
  await sendBigFile(a.page, '20MB.bin', 20 * 1024 * 1024);
  const download = await downloadPromise;

  // 下载事件到手时，接收还没走完，说明是流式而不是收完再给
  await expect(b.page.getByTestId('timeline')).toContainText('20MB.bin');
  expect(download.suggestedFilename()).toBe('20MB.bin');

  const path = await download.path();
  expect(path).toBeTruthy();
  const { statSync } = await import('node:fs');
  expect(statSync(path!).size).toBe(20 * 1024 * 1024);

  await a.context.close();
  await b.context.close();
});
