import type { StorePort } from './ports';

export type TimelineStatus = 'pending' | 'active' | 'done' | 'error';
export type TimelineDirection = 'in' | 'out';

export interface TimelineEntry {
  id: string;
  at: number;
  direction: TimelineDirection;
  kind: 'file' | 'text';
  peerId: string;
  peerName: string;
  name?: string;
  size?: number;
  mime?: string;
  text?: string;
  status: TimelineStatus;
  /** 失败原因，或者落盘位置一类需要让用户知道的信息 */
  note?: string;
}

const COLLECTION = 'timeline';
const MAX_ENTRIES = 500;

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '未知';
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

/**
 * 传输历史。
 *
 * 一个必须写进界面的诚实声明：这里只存元数据，不存字节。
 * "重新下载"只有在发送方仍在线时才有意义，记录本身不能复活文件。
 */
export class Timeline {
  constructor(private readonly store: StorePort) {}

  async add(entry: TimelineEntry): Promise<void> {
    await this.store.put(COLLECTION, entry.id, entry);
    await this.trim();
  }

  async update(id: string, patch: Partial<TimelineEntry>): Promise<TimelineEntry | undefined> {
    const current = await this.store.get<TimelineEntry>(COLLECTION, id);
    if (!current) return undefined;
    const next = { ...current, ...patch, id: current.id, at: current.at };
    await this.store.put(COLLECTION, id, next);
    return next;
  }

  /** 时间倒序，最新的在最前面 */
  async list(): Promise<TimelineEntry[]> {
    const all = await this.store.list<TimelineEntry>(COLLECTION);
    return all.sort((a, b) => b.at - a.at);
  }

  async remove(id: string): Promise<void> {
    await this.store.remove(COLLECTION, id);
  }

  async clear(): Promise<void> {
    await this.store.clear(COLLECTION);
  }

  /** 只裁剪记录，不动用户已经落盘的文件，这一点要和菜单文案一致。 */
  private async trim(): Promise<void> {
    const all = await this.list();
    for (const entry of all.slice(MAX_ENTRIES)) {
      await this.store.remove(COLLECTION, entry.id);
    }
  }
}

/** 菜单里"复制"应该复制什么。文件不可复制，只能给出一行描述。 */
export function describeEntry(entry: TimelineEntry): string {
  if (entry.kind === 'text') return entry.text ?? '';
  const size = entry.size === undefined ? '' : ` (${formatBytes(entry.size)})`;
  return `${entry.name ?? '未命名'}${size}`;
}
