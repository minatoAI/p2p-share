import type {
  PublicKeyJwk,
  ShareStatus,
  ShareSummary,
} from '../../core/protocol';
import type { RegistryPort } from '../../core/ports';

/**
 * 灯塔分享注册表的浏览器实现。
 *
 * 四个方法对着 Worker 的四条路由。这里不上传任何一个字节的文件内容，
 * 只送元信息，见 docs/11 第 2 节。
 *
 * 出错一律抛出去，不返回"大概是不在线吧"那种默认值。离线是产品语义里
 * 四个状态之一（分享者暂时离线，稍后重试有效），和网络坏了不是一回事，
 * 在这一层替调用方做决定会把两种情况混成一个。
 */
export class FetchRegistry implements RegistryPort {
  /** 同源部署，所以默认走相对路径。Pages 把 /api/* 原样转给 Worker。 */
  constructor(private readonly base = '/api') {}

  private async request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, init);
    if (!res.ok && res.status !== 404) {
      let detail = `${res.status}`;
      try {
        const body = (await res.json()) as { error?: string; limit?: number };
        if (body.error) detail = `${body.error}${body.limit ? `（上限 ${body.limit} 条）` : ''}`;
      } catch {
        /* 错误体不是 JSON 就用状态码 */
      }
      throw new Error(detail);
    }
    return res;
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
    const res = await this.request('/share', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    const record = (await res.json()) as { token: string; expiresAt: number };
    return { token: record.token, expiresAt: record.expiresAt };
  }

  /** 404 是"注册表里没有这条"，那是一个答案，不是失败，所以返回 undefined */
  async status(token: string): Promise<ShareStatus | undefined> {
    const res = await this.request(`/share/${encodeURIComponent(token)}`);
    if (res.status === 404) return undefined;
    return (await res.json()) as ShareStatus;
  }

  async list(deviceId: string): Promise<ShareSummary[]> {
    const res = await this.request(`/shares?deviceId=${encodeURIComponent(deviceId)}`);
    return (await res.json()) as ShareSummary[];
  }

  async revoke(input: { token: string; deviceId: string }): Promise<void> {
    await this.request(`/share/${encodeURIComponent(input.token)}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: input.deviceId }),
    });
  }

  /**
   * 页面正在被拆掉时用的撤销。
   *
   * 和上面那个 revoke 的差别只有两件事：同步发出、不等结果。身份现在只在内存里，
   * 一刷新设备号就换，注册表那一行绑的是旧设备号，新页面没有凭据去撤它，
   * 所以必须在这一页还在的时候发出去。keepalive 就是干这个的：请求允许活过页面卸载。
   *
   * 不用 sendBeacon 是因为它只能 POST，而撤销这条路由是 DELETE。
   */
  revokeNow(tokens: string[], deviceId: string): void {
    for (const token of tokens) {
      try {
        void fetch(`${this.base}/share/${encodeURIComponent(token)}`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ deviceId }),
          keepalive: true,
        });
      } catch {
        /* 发不出去就只能等它自己到期。这一页已经没了，没有地方可以报错 */
      }
    }
  }
}
