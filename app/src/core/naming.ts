/**
 * 文件名处理。
 *
 * 两件事容易漏：
 *   1. 从剪贴板粘贴进来的图片没有文件名（File.name 是空字符串），
 *      直接发出去对方会收到一个没有后缀、系统不知道用什么打开的文件；
 *   2. 对端发来的文件名必须净化，否则 `../../evil.dll` 会写到别的地方去。
 */

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/avif': 'avif',
  'text/plain': 'txt',
  'text/markdown': 'md',
  'text/csv': 'csv',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
};

export function extensionForMime(mime: string): string {
  const base = (mime || '').toLowerCase().split(';')[0]!.trim();
  const known = MIME_EXT[base];
  if (known) return known;
  const sub = base.includes('/') ? base.split('/')[1] : '';
  const cleaned = (sub || '').replace(/[^a-z0-9]/g, '');
  return cleaned || 'bin';
}

/** 只留文件名，去掉路径、控制字符和文件名里不合法的字符。 */
export function sanitizeFileName(name: string): string {
  const base = String(name || '')
    .split(/[\\/]/)
    .pop();
  const cleaned = (base ?? '')
    .replace(/[\u0000-\u001f<>:"|?*]/g, '_')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'unnamed';
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`
  );
}

/** 给没有名字的粘贴内容补一个带时间戳和后缀的名字。 */
export function synthesizeClipboardName(mime: string, now: Date, seq: number): string {
  return sanitizeFileName(`剪贴板-${stamp(now)}-${seq}.${extensionForMime(mime)}`);
}

export function synthesizeTextName(now: Date, seq: number): string {
  return sanitizeFileName(`文本-${stamp(now)}-${seq}.txt`);
}

/** 已经带了后缀就不动，没有才补。 */
export function ensureExtension(name: string, mime: string): string {
  const clean = sanitizeFileName(name);
  if (/\.[a-z0-9]{1,8}$/i.test(clean)) return clean;
  return `${clean}.${extensionForMime(mime)}`;
}
