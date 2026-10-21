import { readFileSync } from 'node:fs';
import { expect, test, type Download } from '@playwright/test';
import { device, expectReceived, openShareUrl, publishFile } from './helpers';

/**
 * 公开链接的端到端：一条链接，谁打开都能取件，全程不配对。
 *
 * 核心层的单测验的是名额和撤销那些决定，这里要验的是另一件事：会话层在
 * 通讯录里没有任何记录的前提下，握手、认证、传输能不能真的跑通，以及访客
 * 拿到手的字节和分享者发出去的是不是完全一致。
 *
 * 完成与否以浏览器真的下载到了文件为准（download 事件），那比看界面上
 * 那一行"已完成"更硬。
 *
 * 第二个访客是**接着**取的，不是同时取的：网页端一条链接一次只喂一个人。
 * 这里不摆"两个人同时点"的场面，因为一次几十 KB 的传输在本地快到来不及
 * 观察那个被挡住的瞬间，摆出来只会变成一个靠时序侥幸通过的用例。
 */
async function textOf(download: Download): Promise<string> {
  const path = await download.path();
  if (!path) throw new Error('下载没落到临时目录，读不到内容');
  return readFileSync(path, 'utf8');
}

test('一条公开链接，两个访客接着取到同一份文件；刷新或撤销之后链接就没了', async ({ browser }) => {
  const seeder = await device(browser, '分享者甲', 'remote');
  const body = '公开链接的内容。'.repeat(5000);
  const url = await publishFile(seeder.page, '公开.txt', body);
  // 编号在 hash 里，不在查询串里
  expect(url).toMatch(/\/#s=[0-9a-f]{32}$/);

  /* ---------------- 1. 第一个访客 ---------------- */

  const first = await openShareUrl(browser, '访客一', url);
  const firstDownload = first.page.waitForEvent('download');
  await expectReceived(first.page, '公开.txt', 60_000);
  const file = await firstDownload;
  expect(file.suggestedFilename()).toContain('公开');
  expect(await textOf(file)).toBe(body);
  // 访客这一页从头到尾没有出现过配对面板：它不需要配对
  await expect(first.page.getByTestId('pair-panel')).toHaveCount(0);

  /* ---------------- 2. 第二个访客，等前一个取完之后接着取 ---------------- */

  // 先等分享者这一侧把第一个人记成"已取件"。这一格没放开就叫第二个人进来，
  // 看到的会是"当前有人正在取"，那是时序，不是这条用例要验的东西。
  await expect(seeder.page.getByTestId('share-list')).toContainText('已取件', { timeout: 30_000 });

  const second = await openShareUrl(browser, '访客二', url);
  const secondDownload = second.page.waitForEvent('download');
  await expectReceived(second.page, '公开.txt', 60_000);
  expect(await textOf(await secondDownload)).toBe(body);

  // 分享者界面上看得到这两个访客
  await expect(seeder.page.getByTestId('share-list')).toContainText('访客一');
  await expect(seeder.page.getByTestId('share-list')).toContainText('访客二');

  /* ---------------- 3. 刷新那一页：链接当场作废 ---------------- */

  // 身份只活在内存里，刷新之后就换了一台设备，注册表那一行再也没人能撤。
  // 所以页面走之前必须替它撤销，界面上后来的访客看到的应该是"已撤销"，
  // 而不是挂着二十四小时的"对方暂时离线"。
  await seeder.page.reload();
  // 刷新之后流程从头开始，要重新走进"远距离分享"才看得到分享面板
  await seeder.page.getByTestId('scene-remote').click();
  await expect(seeder.page.getByTestId('share-panel')).toBeVisible();
  const afterReload = await openShareUrl(browser, '访客三', url);
  await expect(afterReload.page.getByTestId('visit-panel')).toContainText('已经撤销');

  /* ---------------- 4. 撤销之后，链接立刻失效 ---------------- */

  const url2 = await publishFile(seeder.page, '公开.txt', body);
  await seeder.page.getByRole('button', { name: '撤销' }).first().click();
  const late = await openShareUrl(browser, '访客四', url2);
  await expect(late.page.getByTestId('visit-panel')).toContainText('已经撤销');

  await seeder.context.close();
  await first.context.close();
  await second.context.close();
  await afterReload.context.close();
  await late.context.close();
});

/**
 * 真机上踩过的那一种：文件眼看传完了，手机端在最后断开并报错，
 * 电脑端却显示发送完成。
 *
 * 这里不真拿一台手机，而是在访客页把 RTCDataChannel 的 send 换成"确认帧一律不发"，
 * 其余照常。效果和手机上"最后一刻崩掉、回执永远回不来"是同一种形状：
 * 链路看着好好的，只是对方不再确认。这时候分享者必须把这一次判成失败。
 *
 * 访客自己那边应该真的收完了：所以这一条同时钉住"完成"这个词在两端各自意味着什么。
 * 要等满引擎的确认超时（三十秒）才见分晓，慢是它本来就该慢。
 */
test('访客不回确认时，分享者不能显示完成', async ({ browser }) => {
  const seeder = await device(browser, '分享者乙', 'remote');
  const url = await publishFile(seeder.page, '没人确认.txt', '内容'.repeat(2000));

  const visitor = await browser.newContext();
  await visitor.addInitScript((name) => {
    localStorage.setItem('deviceName', name);
    const original = RTCDataChannel.prototype.send;
    RTCDataChannel.prototype.send = function (data) {
      // 只吞确认帧，别的照发，让访客真的把整个文件收进内存
      if (typeof data === 'string' && data.includes('"t":"ack"')) return;
      return original.call(this, data as never);
    };
  }, '访客乙');
  const page = await visitor.newPage();
  await page.goto(url);
  await expect(page.getByTestId('visit-panel')).toBeVisible();

  const download = page.waitForEvent('download');
  await expectReceived(page, '没人确认.txt', 60_000);
  await download;

  // 时间线里那一行（分享面板的条目也叫 .item，所以必须限定在 timeline 里找）
  const row = seeder.page.getByTestId('timeline').locator('.item', { hasText: '没人确认.txt' }).first();
  await expect(row).toContainText('失败：', { timeout: 45_000 });
  await expect(row).toContainText('没有确认收完');
  await expect(seeder.page.getByTestId('share-list')).toContainText('访客乙（失败）');
  await expect(seeder.page.getByTestId('share-list')).not.toContainText('已取件');

  await seeder.context.close();
  await visitor.close();
});
