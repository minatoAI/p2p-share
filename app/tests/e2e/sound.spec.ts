import { expect, test } from '@playwright/test';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { device } from './helpers';

/**
 * 声音配对的两条：播得出去，听得回来。
 *
 * 听这一侧用浏览器自带的假麦克风，喂一段真的 ggwave 波形进去，等价于
 * "对面播了一下"。真实设备上是空气传声，这里把物理那一段换成了文件，
 * 编解码、采样率、逐帧解码、听到之后去连，全都是真的。
 *
 * ggwave 在 Node 里能直接跑，所以波形就在这个文件里现生成，不用提前准备音频。
 */
// 声波配对暂时下架（App 里 SOUND_PAIRING_ENABLED = false），
// 这套用例先跳过；把它改回 true 时一起去掉这个 skip。
test.skip(true, '声波配对暂时下架');

const require = createRequire(import.meta.url);
const factory = require('ggwave');

const CODE = '123456';
const RATE = 48_000;

async function makeChirp(): Promise<string> {
  const ggwave = await factory();
  ggwave.disableLog();
  const params = ggwave.getDefaultParameters();
  params.sampleRateInp = RATE;
  params.sampleRateOut = RATE;
  const id = ggwave.init(params);
  const bytes = new Uint8Array(
    ggwave.encode(id, CODE, ggwave.ProtocolId.GGWAVE_PROTOCOL_ULTRASOUND_FAST, 50),
  );
  ggwave.free(id);
  const samples = new Float32Array(bytes.buffer.slice(0));

  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(RATE, 24);
  buffer.writeUInt32LE(RATE * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i += 1) {
    buffer.writeInt16LE(Math.max(-1, Math.min(1, samples[i]!)) * 0x7fff, 44 + i * 2);
  }

  const path = joinPath(tmpdir(), 'audio-pair-e2e.wav');
  writeFileSync(path, buffer);
  return path;
}

const wavPath = await makeChirp();

// 假麦克风（--use-fake-device-for-media-stream）只有 Chromium 认，Firefox 上跑不了
test.skip(({ browserName }) => browserName !== 'chromium', '假麦克风只在 Chromium 上有');

test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  },
  permissions: ['microphone'],
});

test('进到面对面就自己听，听到就去连；播是循环的，点一下停', async ({ browser }) => {
  const me = await device(browser, '收听端');

  // 1. 不用点任何东西：进到这一步就在听，假麦克风里的那段码应当被认出来
  await expect(me.page.locator('.log')).toContainText(`听到 ${CODE}`, { timeout: 30_000 });

  // 2. 播：点一下开始循环播，再点一下停
  await expect(me.page.getByTestId('play-code')).toBeEnabled({ timeout: 30_000 });
  await me.page.getByTestId('play-code').click();
  await expect(me.page.getByTestId('play-code')).toHaveText('停下');
  await me.page.getByTestId('play-code').click();
  await expect(me.page.getByTestId('play-code')).toHaveText('发出声波', { timeout: 20_000 });

  await me.context.close();
});
