import { describe, expect, it } from 'vitest';
import {
  ensureExtension,
  extensionForMime,
  sanitizeFileName,
  synthesizeClipboardName,
} from '../../src/core/naming';

describe('文件名净化', () => {
  it('去掉路径，只留文件名', () => {
    expect(sanitizeFileName('../../../../Windows/System32/evil.dll')).toBe('evil.dll');
    expect(sanitizeFileName('C:\\Users\\a\\b.txt')).toBe('b.txt');
    expect(sanitizeFileName('/etc/passwd')).toBe('passwd');
  });

  it('挡住控制字符和 Windows 非法字符', () => {
    expect(sanitizeFileName('a\u0000b<>:"|?*c.txt')).toBe('a_b_______c.txt');
  });

  it('空名字和前导点回退成 unnamed', () => {
    expect(sanitizeFileName('')).toBe('unnamed');
    expect(sanitizeFileName('...')).toBe('unnamed');
    expect(sanitizeFileName('   ')).toBe('unnamed');
  });
});

describe('MIME 到后缀', () => {
  it('认识常见的图片类型', () => {
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/heic')).toBe('heic');
  });

  it('带参数的类型也能处理', () => {
    expect(extensionForMime('text/plain; charset=utf-8')).toBe('txt');
  });

  it('不认识的类型退回子类型，再退回 bin', () => {
    // 未知子类型里的非字母数字字符会被去掉，避免生成奇怪的扩展名
    expect(extensionForMime('application/x-thing')).toBe('xthing');
    expect(extensionForMime('')).toBe('bin');
    expect(extensionForMime('garbage')).toBe('bin');
  });
});

describe('剪贴板补名', () => {
  it('粘贴进来的图片补出带时间戳和后缀的名字', () => {
    const name = synthesizeClipboardName('image/png', new Date(2026, 9, 11, 0, 1, 54), 1);
    expect(name).toBe('剪贴板-20261011-000154-1.png');
  });

  it('同一秒内连续粘贴靠序号区分', () => {
    const now = new Date(2026, 9, 11, 0, 1, 54);
    expect(synthesizeClipboardName('image/png', now, 1)).not.toBe(
      synthesizeClipboardName('image/png', now, 2),
    );
  });
});

describe('补后缀', () => {
  it('已经带后缀就不动', () => {
    expect(ensureExtension('photo.jpg', 'image/png')).toBe('photo.jpg');
  });

  it('没有后缀才补', () => {
    expect(ensureExtension('photo', 'image/png')).toBe('photo.png');
  });

  it('长后缀按文件名处理，不当成后缀', () => {
    expect(ensureExtension('archive.tar.gz', 'application/zip')).toBe('archive.tar.gz');
    expect(ensureExtension('weird.thisislong', 'image/png')).toBe('weird.thisislong.png');
  });
});
