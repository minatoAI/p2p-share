import { expect, type Browser, type Page } from '@playwright/test';

/**
 * 造一台"设备"：一个上下文，一个页面，一个预设的昵称。
 *
 * 页面现在是分步的，第一步永远是"这次怎么传"，所以要指定走进哪一支。
 * 默认面对面，因为大多数用例都是在测配对和直传。
 */
export async function device(browser: Browser, name: string, scene: 'nearby' | 'remote' = 'nearby') {
  const context = await browser.newContext();
  // 昵称在页面脚本跑之前就写进 localStorage，避免抢在会话建立之前改名字
  await context.addInitScript((value) => {
    localStorage.setItem('deviceName', value);
  }, name);
  const page = await context.newPage();
  await page.goto('/');
  // 选完场景自己往下走，不用再点下一步
  await page.getByTestId(`scene-${scene}`).click();
  // 声波配对下架期间，面对面进来直接是"让对方扫我的码"那一屏
  await expect(page.getByTestId(scene === 'nearby' ? 'pair-panel' : 'share-panel')).toBeVisible();
  if (scene === 'nearby') await expect(page.getByTestId('manual-panel')).toBeVisible();
  return { context, page };
}

export const sendPanel = (page: Page) => page.getByTestId('send-panel');

/** 配对两台设备：A 报码，B 进主动配对输码，比对六位数字，A 确认 */
export async function pair(a: Page, b: Page): Promise<string> {
  await expect(a.getByTestId('pair-code')).toHaveText(/^\d{3} \d{3}$/);
  const code = (await a.getByTestId('pair-code').innerText()).replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);

  // 输满就自动连，不再点"连接"。这里不点是有意的：点下去的时候它已经被
  // 自动连接置成 busy 并禁用了，点它反而会等一个永远不会来的可点状态。
  await b.getByTestId('pair-active').click();
  await b.getByTestId('join-input').fill(code);

  await expect(b.getByTestId('confirm-panel')).toBeVisible();
  await expect(a.getByTestId('confirm-panel')).toBeVisible();
  const sasA = (await a.getByTestId('sas').innerText()).trim();
  const sasB = (await b.getByTestId('sas').innerText()).trim();
  expect(sasA).toMatch(/^\d{6}$/);
  expect(sasA).toBe(sasB);
  // 码主从请求里当场知道对端是网页端；输码方此时还不知道，先不显示
  await expect(a.getByTestId('prompt-platform')).toHaveText('网页端 · 一次性');
  await expect(b.getByTestId('prompt-platform')).toHaveCount(0);
  await a.getByRole('button', { name: '一致', exact: true }).click();

  // 配对完直接进传输页，连通情况写在那一页顶上
  await expect(sendPanel(a)).toBeVisible();
  await expect(sendPanel(b)).toBeVisible();
  await expect(a.getByTestId('peer-platform')).toContainText('网页端 · 一次性');
  await expect(b.getByTestId('peer-platform')).toContainText('网页端 · 一次性');
  // WEB-2：会话页要能看出连的是哪台设备，而不是只有一个平台徽标
  await expect(a.getByTestId('peer-name')).toContainText('手机乙');
  await expect(b.getByTestId('peer-name')).toContainText('电脑甲');
  await expect(a.getByTestId('connected-panel')).toBeVisible();
  await expect(a.getByTestId('link-detail')).toContainText('毫秒', { timeout: 15_000 });
  return code;
}

/**
 * 从文件选择框发一个文件。这个 input 是隐藏的，直接用 DOM 接口喂文件。
 *
 * 页面现在有两个 file input（发送用的和挂分享用的），所以这里必须点 testid，
 * 不能再用 `input[type=file]` 那种会命中两个的写法。
 */
export async function sendFile(
  page: Page,
  name: string,
  body: string | Buffer,
  mime = 'text/plain',
) {
  await page.getByTestId('send-file-input').setInputFiles({
    name,
    mimeType: mime,
    buffer: Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'),
  });
}

/**
 * 在页面里就地造一个大文件再交给发送流程。
 *
 * 不用 setInputFiles 是因为那要把整个文件从测试进程传进浏览器，
 * 几百兆会把测试进程自己压垮，而且测的就不是传输了。
 */
export async function sendBigFile(page: Page, name: string, bytes: number) {
  await page.evaluate(
    async ({ name, bytes }) => {
      const blob = new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' });
      const file = new File([blob], name, { type: 'application/octet-stream' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const input = document.querySelector(
        '[data-testid="send-file-input"]',
      ) as HTMLInputElement;
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    },
    { name, bytes },
  );
}

/** 等时间线里出现某个文件名，并等到它显示完成 */
export async function expectReceived(page: Page, name: string, timeout = 40_000) {
  const item = page.locator('.item', { hasText: name }).first();
  // 三个断言都要吃同一个超时。只给最后一个的话，前两个还是默认 20 秒，
  // 整套连着跑、资源紧张时就会假失败。
  await expect(item).toBeVisible({ timeout });
  await expect(item).toContainText('收到', { timeout });
  await expect(item).toContainText('已完成', { timeout });
  return item;
}

/** 读出界面上的路径提示，用来判断这一趟到底走了哪条路 */
export async function readPath(page: Page): Promise<string> {
  return (await page.getByTestId('path').innerText()).trim();
}

/* ============================================================== 公开链接 */

/** 挑一个文件挂成公开链接，返回界面上显示的那条地址 */
export async function publishFile(page: Page, name: string, body: string): Promise<string> {
  await page.getByTestId('share-file-input').setInputFiles({
    name,
    mimeType: 'text/plain',
    buffer: Buffer.from(body, 'utf8'),
  });
  const link = page.getByTestId('share-link').first();
  await expect(link).toBeVisible();
  return (await link.innerText()).trim();
}

/** 打开一条分享链接。访客这一页不需要配对，直接进取件流程。 */
export async function openShareUrl(browser: Browser, name: string, url: string) {
  const context = await browser.newContext();
  await context.addInitScript((value) => {
    localStorage.setItem('deviceName', value);
  }, name);
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByTestId('visit-panel')).toBeVisible();
  return { context, page };
}
