import type { PathInfo, PeerLink, PeerState } from '../../core/ports';

/**
 * 内存点对点链路，用来在 Node 里跑完整的收发测试。
 *
 * 它模拟真实数据通道的两个关键行为：
 *   - congested 为 true 时，send() 不会投递，而是堆在缓冲区里，
 *     bufferedAmount() 随之增长。这就是背压测试要的输入。
 *   - 投递是同步的；引擎那边用一条 Promise 链把接收处理串起来，
 *     所以同步投递不会造成乱序。
 */
export class MemoryLink implements PeerLink {
  partner!: MemoryLink;
  state: PeerState = 'connected';

  private pending: Array<string | ArrayBuffer> = [];
  private buffered = 0;
  private messageHandlers: Array<(data: string | ArrayBuffer) => void> = [];
  private stateHandlers: Array<(s: PeerState) => void> = [];
  private drainHandlers: Array<() => void> = [];

  /** 设为 true 之后 send() 只堆积不投递，用来模拟链路堵住 */
  congested = false;

  /**
   * 单条消息上限。默认按 16 KiB 分片那一档来，模拟保守的传输层；
   * 测试可以把它调大，验证引擎会跟着改分片大小。
   */
  maxMessageSize = 16 * 1024 + 8;

  maxChunkSize(): number {
    return this.maxMessageSize;
  }

  send(data: string | ArrayBuffer): void {
    if (this.state !== 'connected') return;
    const size = typeof data === 'string' ? data.length : data.byteLength;
    if (this.congested) {
      this.pending.push(data);
      this.buffered += size;
      return;
    }
    this.partner.deliver(data);
  }

  bufferedAmount(): number {
    return this.buffered;
  }

  onMessage(cb: (data: string | ArrayBuffer) => void): void {
    this.messageHandlers.push(cb);
  }

  onStateChange(cb: (s: PeerState) => void): void {
    this.stateHandlers.push(cb);
  }

  onDrain(cb: () => void): void {
    this.drainHandlers.push(cb);
  }

  async path(): Promise<PathInfo> {
    return { kind: 'lan', localType: 'host', remoteType: 'host' };
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const cb of this.stateHandlers) cb('closed');
    this.partner.fail('closed');
  }

  /** 把堆积的数据一次性放行，并通知缓冲区已排空 */
  uncongest(): void {
    this.congested = false;
    const queued = this.pending;
    this.pending = [];
    for (const data of queued) this.partner.deliver(data);
    this.buffered = 0;
    for (const cb of this.drainHandlers) cb();
  }

  /**
   * 测试用：丢掉下一条到达这条链路的 auth-challenge。
   * 模拟真实数据通道刚打开时，对端（尤其是 JNI 侧）还没挂好处理函数。
   */
  dropNextAuthChallenge = false;

  deliver(data: string | ArrayBuffer): void {
    if (this.state !== 'connected') return;
    if (
      this.dropNextAuthChallenge &&
      typeof data === 'string' &&
      data.includes('"t":"auth-challenge"')
    ) {
      this.dropNextAuthChallenge = false;
      return;
    }
    for (const cb of this.messageHandlers) cb(data);
  }

  private fail(reason: PeerState): void {
    if (this.state === 'closed' || this.state === 'failed') return;
    this.state = reason;
    for (const cb of this.stateHandlers) cb(reason);
  }
}

/** 造一对互通的链路。索引 0 是 A 侧，索引 1 是 B 侧。 */
export function memoryLinkPair(): [MemoryLink, MemoryLink] {
  const a = new MemoryLink();
  const b = new MemoryLink();
  a.partner = b;
  b.partner = a;
  return [a, b];
}
