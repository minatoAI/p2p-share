import type { PublicKeyJwk, ShareStatus, ShareSummary } from '../../core/protocol';
import type { RegistryPort } from '../../core/ports';

interface Row {
  token: string;
  deviceId: string;
  deviceName: string;
  publicKey: PublicKeyJwk;
  name: string;
  size: number;
  mime: string;
  revoked: boolean;
  createdAt: number;
  expiresAt: number;
}

/**
 * 内存注册表，Node 测试用。
 *
 * `online` 这一项真实实现里没有：在线与否是在线状态板的事实，Worker 把它和
 * 注册表的记录合成四个状态。测试要单独控制它，所以在这里开一个口子，
 * 这样"分享者离线"那条语义不用起一个 workerd 也能验。
 */
export class MemoryRegistry implements RegistryPort {
  readonly rows = new Map<string, Row>();
  /** 此刻在线的设备号，由测试自己填 */
  readonly online = new Set<string>();
  private counter = 0;

  private statusOf(row: Row, now: number): ShareStatus['status'] {
    if (row.revoked) return 'revoked';
    if (row.expiresAt < now) return 'expired';
    return this.online.has(row.deviceId) ? 'available' : 'offline';
  }

  async create(input: {
    deviceId: string;
    deviceName: string;
    publicKey: PublicKeyJwk;
    name: string;
    size: number;
    mime: string;
    ttlMs?: number;
  }): Promise<{ token: string; expiresAt: number }> {
    const now = Date.now();
    const token = `${(++this.counter).toString(16).padStart(2, '0')}`.repeat(16).slice(0, 32);
    const expiresAt = now + (input.ttlMs ?? 24 * 60 * 60 * 1000);
    this.rows.set(token, {
      token,
      deviceId: input.deviceId,
      deviceName: input.deviceName,
      publicKey: input.publicKey,
      name: input.name,
      size: input.size,
      mime: input.mime,
      revoked: false,
      createdAt: now,
      expiresAt,
    });
    return { token, expiresAt };
  }

  async status(token: string): Promise<ShareStatus | undefined> {
    const row = this.rows.get(token);
    if (!row) return undefined;
    return {
      token: row.token,
      status: this.statusOf(row, Date.now()),
      name: row.name,
      size: row.size,
      mime: row.mime,
      deviceName: row.deviceName,
      deviceId: row.deviceId,
      publicKey: row.publicKey,
      expiresAt: row.expiresAt,
    };
  }

  async list(deviceId: string): Promise<ShareSummary[]> {
    const now = Date.now();
    return [...this.rows.values()]
      .filter((r) => r.deviceId === deviceId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((r) => ({
        token: r.token,
        name: r.name,
        size: r.size,
        mime: r.mime,
        state: r.revoked ? 'revoked' : r.expiresAt < now ? 'expired' : 'available',
        createdAt: r.createdAt,
        expiresAt: r.expiresAt,
      }));
  }

  async revoke(input: { token: string; deviceId: string }): Promise<void> {
    const row = this.rows.get(input.token);
    // 和真实实现一样：不是本人挂的就不许撤销
    if (row && row.deviceId === input.deviceId) row.revoked = true;
  }
}
