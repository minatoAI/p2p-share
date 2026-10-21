import { describe, expect, it } from 'vitest';
import { createTransferIdFactory, newShortCode, randomHex } from '../../src/core/ids';
import { Timeline, describeEntry, formatBytes, type TimelineEntry } from '../../src/core/timeline';
import { MemoryStore } from '../../src/adapters/memory/store';

describe('传输 ID', () => {
  it('同一台设备内单调递增且不重复', () => {
    const next = createTransferIdFactory('aabbccdd');
    const ids = new Set([next(), next(), next(), next()]);
    expect(ids.size).toBe(4);
  });

  it('两台设备各发第一个文件也不会撞', () => {
    // 这是 demo 里真实存在的缺陷：ID 只由时间戳加页面内序号构成，
    // 两端同一毫秒各发第一个文件就会生成同一个 ID。
    const a = createTransferIdFactory('aaaaaaaa');
    const b = createTransferIdFactory('bbbbbbbb');
    const ida = a();
    const idb = b();
    expect(ida).not.toBe(idb);
    expect(ida.startsWith('aaaaaa')).toBe(true);
    expect(idb.startsWith('bbbbbb')).toBe(true);
  });

  it('短码是六位数字', () => {
    for (let i = 0; i < 20; i++) expect(newShortCode()).toMatch(/^\d{6}$/);
  });

  it('随机十六进制长度正确', () => {
    expect(randomHex(8)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('体积格式化', () => {
  it('按量级选单位', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.0 GB');
  });

  it('非法输入不抛异常', () => {
    expect(formatBytes(-1)).toBe('未知');
    expect(formatBytes(Number.NaN)).toBe('未知');
  });
});

function entry(patch: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    id: 't1',
    at: 1000,
    direction: 'out',
    kind: 'file',
    peerId: 'peer-1',
    peerName: '我的手机',
    name: 'a.jpg',
    size: 2048,
    status: 'done',
    ...patch,
  };
}

describe('时间线', () => {
  it('按时间倒序返回，最新的在最前', async () => {
    const store = new MemoryStore();
    const timeline = new Timeline(store);
    await timeline.add(entry({ id: 'old', at: 1000 }));
    await timeline.add(entry({ id: 'new', at: 3000 }));
    await timeline.add(entry({ id: 'mid', at: 2000 }));
    const list = await timeline.list();
    expect(list.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
  });

  it('更新状态时不动 id 和创建时间', async () => {
    const store = new MemoryStore();
    const timeline = new Timeline(store);
    await timeline.add(entry());
    const updated = await timeline.update('t1', { id: 'hacked', at: 9999, status: 'error', note: '连接失败' });
    expect(updated!.id).toBe('t1');
    expect(updated!.at).toBe(1000);
    expect(updated!.status).toBe('error');
    expect(updated!.note).toBe('连接失败');
  });

  it('更新不存在的记录返回 undefined', async () => {
    const timeline = new Timeline(new MemoryStore());
    expect(await timeline.update('missing', { status: 'done' })).toBeUndefined();
  });

  it('清除只清记录', async () => {
    const store = new MemoryStore();
    const timeline = new Timeline(store);
    await timeline.add(entry({ id: 'a' }));
    await timeline.add(entry({ id: 'b' }));
    await timeline.clear();
    expect(await timeline.list()).toEqual([]);
  });

  it('超过上限时裁掉最旧的记录', async () => {
    const store = new MemoryStore();
    const timeline = new Timeline(store);
    for (let i = 0; i < 505; i++) {
      await timeline.add(entry({ id: `e${i}`, at: i }));
    }
    const list = await timeline.list();
    expect(list.length).toBe(500);
    expect(list.some((e) => e.id === 'e0')).toBe(false);
    expect(list.some((e) => e.id === 'e504')).toBe(true);
  });
});

describe('复制菜单的语义', () => {
  it('文本复制原文', () => {
    expect(describeEntry(entry({ kind: 'text', text: '取件码 1234', name: undefined }))).toBe('取件码 1234');
  });

  it('文件只能复制一行描述，不能复制字节', () => {
    expect(describeEntry(entry())).toBe('a.jpg (2.0 KB)');
  });
});
