import type { StorePort } from '../../core/ports';

/**
 * 内存存储。网页端用它，Node 测试也用它。
 *
 * 网页端不是"暂时没接持久化"，是有意不落盘：刷新就换一台设备，
 * 配对关系和传输记录都跟着清空。定这一档的形状见 docs/20。
 */
export class MemoryStore implements StorePort {
  private readonly data = new Map<string, Map<string, unknown>>();

  private bucket(collection: string): Map<string, unknown> {
    let b = this.data.get(collection);
    if (!b) {
      b = new Map();
      this.data.set(collection, b);
    }
    return b;
  }

  async get<T>(collection: string, key: string): Promise<T | undefined> {
    return this.bucket(collection).get(key) as T | undefined;
  }

  async put<T>(collection: string, key: string, value: T): Promise<void> {
    // 存副本，模拟真实持久化的值语义，避免测试里因为共享引用而误判
    this.bucket(collection).set(key, structuredClone(value));
  }

  async list<T>(collection: string): Promise<T[]> {
    return [...this.bucket(collection).values()] as T[];
  }

  async remove(collection: string, key: string): Promise<void> {
    this.bucket(collection).delete(key);
  }

  async clear(collection: string): Promise<void> {
    this.bucket(collection).clear();
  }
}
