import { test, expect } from '@playwright/test';
import QRCode from 'qrcode';
import { device } from './helpers';

/**
 * 没有 BarcodeDetector 时的扫码路径。
 *
 * 不管有没有 BarcodeDetector，走的都是同一条路：拉起系统相机拍一张，
 * 把文件交回来再认。这里把 BarcodeDetector 藏掉，等价于 iOS 那种情况，
 * 拍回来的照片是真的二维码，解开之后应当真的走到配对那一步。
 *
 * 两个项目都跑：Firefox 上这条也一样成立，因为它本来就没有这个接口。
 */
test('没有内置识别器时，拍照也能把码认出来并接上配对', async ({ browser }) => {
  const a = await device(browser, '电脑');
  await expect(a.page.getByTestId('pair-code')).toHaveText(/^\d{3} \d{3}$/, { timeout: 30_000 });
  const code = (await a.page.getByTestId('pair-code').innerText()).replace(/\D/g, '');

  const b = await device(browser, '手机');
  await b.context.addInitScript(() => {
    // 装成 iOS Safari 的样子：没有 BarcodeDetector
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).BarcodeDetector;
  });
  await b.page.reload();
  await b.page.getByTestId('scene-nearby').click();
  await expect(b.page.getByTestId('pair-panel')).toBeVisible();
  await b.page.getByTestId('pair-active').click();

  // 对方屏幕上那张二维码里的内容
  const png = await QRCode.toBuffer(`http://localhost:5173/#c=${code}`, { width: 400, margin: 2 });

  // 扫码只有一条路：点开系统相机拍一张。这里直接把照片喂给那个 input。
  await b.page
    .getByTestId('scan-input')
    .setInputFiles({ name: 'qr.png', mimeType: 'image/png', buffer: png });

  // 认出来之后码会一路走到配对：B 这边出现六位核对
  await expect(b.page.getByTestId('confirm-panel')).toBeVisible({ timeout: 30_000 });
  await expect(b.page.getByTestId('sas')).toHaveText(/^\d{6}$/);

  await a.context.close();
  await b.context.close();
});
