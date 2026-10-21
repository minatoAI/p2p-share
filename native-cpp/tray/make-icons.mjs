// 生成托盘图标和"正在传输"的动画帧。
//
// 为什么画实心箭头而不是描边：16px 下描边的箭头两个头会粘成一团（实测），
// 实心形状缩下去还能看出是两条反向的箭头。
//
// 为什么不用 PNG 压缩的 ICO：LoadImage 走系统图标解码，PNG 帧在部分机器上
// 会触发 libpng 警告甚至崩，全部用 32 位 BMP 帧，老式但稳。
//
// 用法：node native-cpp/tray/make-icons.mjs
// 产物：assets/tray.ico、tray-badge.ico、tray-1.ico … tray-3.ico（动画帧）
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const requireApp = createRequire(join(here, '../../app/package.json'));
const sharp = requireApp('sharp');

// 两个箭头反向"滚动"：右箭头往右移出去、从左钻回来；左箭头相反。
// 位移量 t 在一个循环宽度（64）里走，每帧把箭头再画一份在对面，
// 配合整块圆角裁切，看起来就是连续循环，而不是来回摆。
const LOOP = 64;

function arrowRight(x) {
  return `<rect x="${x}" y="19" width="27" height="6.5" rx="1.2"/>
    <path d="M${x + 27} 12.8 L${x + 40} 22.25 L${x + 27} 31.7z"/>`;
}

function arrowLeft(x) {
  return `<rect x="${x}" y="38.5" width="27" height="6.5" rx="1.2"/>
    <path d="M${x} 32.2 L${x - 13} 41.65 L${x} 51.1z"/>`;
}

const tile = (t, badge) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <defs><clipPath id="tile"><rect width="64" height="64" rx="14"/></clipPath></defs>
  <rect width="64" height="64" rx="14" fill="#2f6feb"/>
  <g clip-path="url(#tile)" fill="#ffffff">
    ${arrowRight(12 + t)}
    ${arrowRight(12 + t - LOOP)}
    ${arrowLeft(25 - t)}
    ${arrowLeft(25 - t + LOOP)}
  </g>
  ${badge ? `<circle cx="50" cy="14" r="11" fill="#f59e0b" stroke="#2f6feb" stroke-width="3.5"/>` : ''}
</svg>`;

const sizes = [16, 20, 24, 32, 40, 48, 64, 128];

// 32 位 BMP 帧：BITMAPINFOHEADER + 自下而上的 BGRA + 1 位掩码
function bmpFrame(rgba, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);

  const pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    const dstRow = y * size * 4;
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      pixels[d] = rgba[s + 2];
      pixels[d + 1] = rgba[s + 1];
      pixels[d + 2] = rgba[s];
      pixels[d + 3] = rgba[s + 3];
    }
  }

  const maskStride = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskStride * size, 0);
  return Buffer.concat([header, pixels, mask]);
}

async function ico(svg, out, frame_sizes = sizes) {
  const frames = [];
  for (const size of frame_sizes) {
    const rgba = await sharp(Buffer.from(svg), { density: 384 })
      .resize(size, size)
      .ensureAlpha()
      .raw()
      .toBuffer();
    frames.push({ size, data: bmpFrame(rgba, size) });
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);

  let offset = 6 + 16 * frames.length;
  const entries = [];
  for (const { size, data } of frames) {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt8(0, 2);
    entry.writeUInt8(0, 3);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(data.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += data.length;
  }

  writeFileSync(out, Buffer.concat([header, ...entries, ...frames.map((f) => f.data)]));
  console.log(`${out}`);
}

mkdirSync(join(here, 'assets'), { recursive: true });

// 静止帧（t = 0）
await ico(tile(0, false), join(here, 'assets/tray.ico'));
// 未配置保存位置：右上角多一个橙点
await ico(tile(0, true), join(here, 'assets/tray-badge.ico'));
// 动画帧：每帧 4px，走完 64px 一个循环共 16 帧（含静止帧）。
// 步长越小越顺；之前 8px 一帧在播放时看得出"跳"。
const anim_sizes = [16, 20, 24, 32, 40, 48, 64];
for (let frame = 1; frame < 16; frame++) {
  await ico(tile(frame * 4, false), join(here, `assets/tray-${frame}.ico`), anim_sizes);
}

// 预览：把 16 帧按 4 倍放大排成两行，检查首尾是否接得上
{
  const parts = [];
  const cell = 88;
  for (let frame = 0; frame < 16; frame++) {
    const png = await sharp(Buffer.from(tile(frame * 4, false)), { density: 384 })
      .resize(20, 20)
      .png()
      .toBuffer();
    const big = await sharp(png).resize(cell - 8, cell - 8, { kernel: 'nearest' }).png().toBuffer();
    const col = frame % 8;
    const row = Math.floor(frame / 8);
    parts.push({ input: big, left: 8 + col * cell, top: 8 + row * cell });
  }
  await sharp({ create: { width: 8 * cell + 16, height: 2 * cell + 16, channels: 4, background: '#202020' } })
    .composite(parts)
    .png()
    .toFile(join(here, 'assets/preview-anim.png'));
}
