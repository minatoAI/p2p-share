import { expect, test } from '@playwright/test';
import { device, expectReceived, pair, sendFile, sendPanel } from './helpers';

/**
 * 本机端到端：真的配对一次、真的传一次，然后验证刷新之后就是一台新设备。
 *
 * 两个浏览器上下文当成两台设备。身份、通讯录、时间线都只在页面内存里，
 * 一个字节都不落盘，所以刷新就是换了一台设备；只有设备名存在 localStorage，
 * 那是给人看的标签，不是身份。跑在 http://localhost 上，这里是安全上下文，
 * 所以配对认证、六位短认证串、挑战应答全都真的在跑。
 *
 * 也可以打线上，验证真实 HTTPS 和真实公网：
 *   E2E_BASE_URL=https://p2p-share-web.pages.dev npx playwright test
 */
test('网页端的配对是临时的：刷新之后就是一台新设备，得重新配', async ({ browser }) => {
  const a = await device(browser, '电脑甲');
  const b = await device(browser, '手机乙');

  /* ---------------- 1. 配对 ---------------- */

  // 只输六位数字，不扫码也不点链接
  await pair(a.page, b.page);

  /* ---------------- 2. 在线状态 ---------------- */

  // 设备条已经去掉了：只连一台，顶栏那一行就是全部状态
  await expect(a.page.getByTestId('link-status')).toContainText('已连接');
  await expect(a.page.getByTestId('pair-panel')).toHaveCount(0);

  /* ---------------- 3. 第一次发送 ---------------- */

  await sendFile(a.page, '第一次.txt', '配对之后的第一份文件');
  await expectReceived(b.page, '第一次.txt');

  // 同一台机器上的两个上下文没有 STUN，只有 host 候选，所以路径判定必须是局域网。
  // 这一条同时守着"读不到地址时别把局域网误判成公网直连"那个回归。
  await expect(b.page.getByTestId('path')).toContainText('局域网');

  /* ---------------- 4. 两边都重开页面 ---------------- */

  await a.page.reload();
  await b.page.reload();

  // 刷新之后没有配对记录可读了：两边都回到配对页，也看不见对方。
  // 这一条是有意反着写的。以前这里断言"配对面板消失、对方仍然在线"，
  // 靠的是 IndexedDB 里存着的身份和通讯录；网页端现在定成只在内存里，
  // 持久那一档归原生端，见 docs/20 第 5 节。
  // 刷新之后回到第一步：这不是"掉回了配对页"，而是流程从头开始
  await a.page.getByTestId('scene-nearby').click();
  await b.page.getByTestId('scene-nearby').click();
  await expect(a.page.getByTestId('pair-panel')).toBeVisible();
  await expect(b.page.getByTestId('pair-panel')).toBeVisible();
  await expect(sendPanel(a.page)).toHaveCount(0);

  /* ---------------- 5. 重新配一次，照样能传 ---------------- */

  await pair(a.page, b.page);
  await sendFile(a.page, '第二次.txt', '重新配对之后发的');
  await expectReceived(b.page, '第二次.txt');

  await a.context.close();
  await b.context.close();
});

test('传输记录的格式标签、按类型给按钮、预览和下载', async ({ browser }) => {
  const a = await device(browser, '电脑甲');
  const b = await device(browser, '手机乙');
  await pair(a.page, b.page);

  // 一张真的 1×1 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/AAf/AAAAAElFTkSuQmCC',
    'base64',
  );
  await sendFile(a.page, '图.png', png, 'image/png');
  await expectReceived(b.page, '图.png');

  // 格式标签接在"收到"后面
  const item = b.page.locator('.item', { hasText: '图.png' }).first();
  await expect(item.locator('.tag.fmt')).toHaveText('图片');

  // 文件不给复制，只给预览和下载；列表没有清空，单条也没有移除
  await expect(item.getByRole('button', { name: '复制' })).toHaveCount(0);
  await expect(item.getByRole('button', { name: '预览' })).toHaveCount(1);
  await expect(item.getByRole('button', { name: '下载' })).toHaveCount(1);
  await expect(b.page.getByRole('button', { name: '清空' })).toHaveCount(0);

  // 预览能在页面里看
  await item.getByRole('button', { name: '预览' }).click();
  await expect(b.page.locator('.preview-body img')).toBeVisible();
  await b.page.getByRole('button', { name: '关闭' }).click();
  await expect(b.page.locator('.preview-body')).toHaveCount(0);

  // 下载再存一份
  const saved = b.page.waitForEvent('download');
  await item.getByRole('button', { name: '下载' }).click();
  expect((await saved).suggestedFilename()).toBe('图.png');

  // 文字走文字标签，并且只有文字才给复制
  await a.page.getByTestId('tab-text').click();
  await a.page.locator('textarea').first().fill('一段话');
  await a.page.getByRole('button', { name: '发送' }).click();
  const textItem = b.page.locator('.item').first();
  await expect(textItem.locator('.tag.fmt')).toHaveText('文字');
  await expect(textItem.getByRole('button', { name: '复制' })).toHaveCount(1);
  await expect(textItem.getByRole('button', { name: '预览' })).toHaveCount(0);

  await a.context.close();
  await b.context.close();
});

test('配过一台之后回到首页，再进配对页仍然要得到新码', async ({ browser }) => {
  const a = await device(browser, '电脑甲');
  const b = await device(browser, '手机乙');
  await pair(a.page, b.page);

  // 对方离开，A 的连接断掉，界面上出现"回首页"
  await b.context.close();
  const home = a.page.getByTestId('back-home');
  await expect(home).toBeVisible({ timeout: 20_000 });
  await home.click();

  // 这时 A 已经有配对记录。旧逻辑按"有没有联系人"决定报不报码，
  // 一进配对页就停掉 advertising，界面永远停在"正在向灯塔要配对码"，
  // "立即重试"也因为 refreshCode 是空操作而没反应。
  await a.page.getByTestId('scene-nearby').click();
  await expect(a.page.getByTestId('pair-code')).toHaveText(/^\d{3} \d{3}$/, {
    timeout: 15_000,
  });

  await a.context.close();
});

test('粘贴按钮读不到资源管理器文件时，直接说明要用 Ctrl+V', async ({ browser }) => {
  const a = await device(browser, '电脑甲');
  const b = await device(browser, '手机乙');
  await pair(a.page, b.page);

  // 资源管理器复制文件时，Edge 交给按钮的 ClipboardItem 是空 types；
  // 页面拿不到任何文件。这里按同样的形状模拟一次。
  await a.page.evaluate(() => {
    const clipboard = navigator.clipboard as unknown as {
      read: () => Promise<
        Array<{ types: string[]; getType: (type: string) => Promise<Blob> }>
      >;
    };
    clipboard.read = async () => [{ types: [], getType: async () => new Blob() }];
  });
  await a.page.getByRole('button', { name: '粘贴', exact: true }).click();
  await expect(a.page.getByTestId('paste-hint')).toContainText('Ctrl / ⌘ + V');

  await a.context.close();
  await b.context.close();
});

test('连不上服务时只出一条状态条，页面仍然可读可点', async ({ browser }) => {
  const context = await browser.newContext();
  // 把信令长连接掐掉，模拟服务不可达
  await context.routeWebSocket('**/ws/presence**', (ws) => ws.close());
  const page = await context.newPage();
  await page.goto('/');

  // 冷启动不再铺全屏模糊遮罩：顶部一条细状态条，页面照常可读
  const bar = page.getByTestId('offline');
  await expect(bar).toBeVisible();
  // 首连和重连都会很快切过来，两种说法都算对
  await expect(page.getByTestId('reconnect-status')).toContainText(/正在连接服务|次重连/);
  const box = await bar.boundingBox();
  expect(box?.height ?? 0).toBeLessThan(80);
  // 状态条不接管交互，首页的卡片仍然能点
  await page.getByTestId('scene-remote').click();
  await expect(page.getByTestId('share-panel')).toBeVisible();

  // 十五秒之后补一张说明卡片，仍然不是盖住一切的那一层
  await expect(page.getByTestId('offline-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('share-panel')).toBeVisible();
  // 到这一档顶栏才说「连接失败」，而且不能声称连着对方
  await expect(page.getByTestId('link-status')).toContainText('连接失败');
  await expect(page.getByTestId('link-status')).not.toContainText('已连接');

  await context.close();
});
