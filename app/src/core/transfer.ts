/**
 * 传输引擎：分片、背压、重组、确认。
 *
 * 它只依赖 PeerLink / SinkPort 两个端口，所以既能在浏览器里跑，
 * 也能在 Node 里用内存适配器跑完整的收发测试。
 *
 * 设计取舍：
 *   - 一个方向同时只传一个文件（串行）。这样二进制分片只需要带序号，
 *     不需要带传输 ID，接收端的重组状态也只有一个，实现量小很多。
 *     代价是同一时刻不能并行传两个文件，Phase 1 接受这个代价。
 *   - 控制帧和二进制分片共用一条数据通道。通道是有序可靠的，
 *     所以控制帧插在分片中间不会造成乱序；但仍然保留乱序缓存作为兜底。
 *   - refill 靠 bufferedAmount 水位，不靠定时器。这是整个引擎里最不能省的一段。
 */

import {
  CHUNK_HEADER_BYTES,
  cancelReasonText,
  decodeChunk,
  decodeControl,
  encodeChunk,
  encodeControl,
  type ControlMessage,
} from './protocol';
import { ensureExtension, sanitizeFileName } from './naming';
import type { FileMeta, PeerLink, ReceivedArtifact, SinkPort, WriteSession } from './ports';

export interface FileLike {
  name: string;
  size: number;
  type: string;
  slice(start: number, end: number): Promise<ArrayBuffer>;
}

export type TransferStatus = 'pending' | 'active' | 'done' | 'error';
export type Direction = 'in' | 'out';

export interface TransferUpdate {
  id: string;
  direction: Direction;
  status: TransferStatus;
  meta?: FileMeta;
  message?: string;
  /**
   * 这一次传输属于哪个对端。
   *
   * 引擎自己填不出来：它只认一条链路，不认设备号。是会话层在建每个对端的
   * 引擎时把回调包了一层盖上去的。界面上的传输记录本来就该记住"和哪台传的"，
   * 多设备并发时这个字段不能少。
   */
  peerId?: string;
}

export interface TransferHandlers {
  /** 收完之后拿到可预览的产物 */
  onArtifact?(id: string, artifact: ReceivedArtifact): void;
  onProgress?(id: string, direction: Direction, transferred: number, size: number): void;
  onStatus?(update: TransferUpdate): void;
  /** 收到文本，不走文件系统 */
  onText?(id: string, text: string): void;
}

export interface TransferOptions {
  /** 传输 ID 工厂，必须带设备前缀，见 ids.ts */
  newTransferId: () => string;
  /** 不指定时按链路上报的单条消息上限推导 */
  chunkSize?: number;
  highWater?: number;
  lowWater?: number;
  drainTimeoutMs?: number;
  ackTimeoutMs?: number;
  /** 进度回调的最小间隔，防止每块都触发一次界面重绘 */
  progressIntervalMs?: number;
  /** 收满多少字节回一次确认，不必每块都回 */
  ackIntervalBytes?: number;
  /**
   * 一次从文件里读多少字节，再切成小片发。
   * 每块都单独读一次文件会走一遍 Blob 的跨线程通道，
   * 46 MB 按 16 KiB 分片就是近三千次读，光这一项就能把传输拖到很慢。
   */
  readAheadBytes?: number;
}

export const DEFAULT_CHUNK_SIZE = 16 * 1024;
export const MIN_CHUNK_SIZE = 16 * 1024;
/**
 * 分片上限。
 *
 * 实测 Chromium 的 `pc.sctp.maxMessageSize` 是 262144，也就是 256 KiB。
 * 早先我按 64 KiB 夹，等于白白丢掉四倍的消息粒度。实测把分片从 16 KB 放到
 * 256 KB，吞吐只涨了一成（6.1 → 6.8 MB/s），所以它不是瓶颈，
 * 但少四倍的消息数对每块都要做的分配、确认和进度回调都是净赚。
 */
export const MAX_CHUNK_SIZE = 256 * 1024;
export const DEFAULT_HIGH_WATER = 8 * 1024 * 1024;
export const DEFAULT_LOW_WATER = 1 * 1024 * 1024;
const DEFAULT_DRAIN_TIMEOUT = 5000;
const DEFAULT_ACK_TIMEOUT = 30000;
const DEFAULT_PROGRESS_INTERVAL = 100;
const DEFAULT_ACK_INTERVAL = 256 * 1024;
const DEFAULT_READ_AHEAD = 4 * 1024 * 1024;

/** 分片大小从传输层上报的单条消息上限推导，而不是写死一个数。 */
function clampChunkSize(maxMessageSize: number): number {
  const usable = maxMessageSize - CHUNK_HEADER_BYTES;
  return Math.max(MIN_CHUNK_SIZE, Math.min(usable, MAX_CHUNK_SIZE));
}

interface Outgoing {
  id: string;
  file: FileLike;
}

interface Incoming {
  meta: FileMeta;
  session: WriteSession;
  expected: number;
  total: number;
  bytes: number;
  lastAckBytes: number;
  cache: Map<number, Uint8Array>;
}

export class TransferEngine {
  private link: PeerLink | null = null;
  private readonly queue: Outgoing[] = [];
  private sending = false;
  private incoming: Incoming | null = null;
  private receiveChain: Promise<void> = Promise.resolve();
  private readonly acks = new Map<string, number>();
  /** 等待收尾确认。唤醒时带一个布尔：true 是又收到一个确认，false 是别再等了。 */
  private readonly ackWaiters = new Map<string, (confirmed: boolean) => void>();
  /**
   * 对端主动报回来的失败原因或取消文案，按传输 ID 存。
   * 值已经是给用户看的整句，waitForAck 直接原样抛出，不再二次加前缀。
   */
  private readonly remoteErrors = new Map<string, string>();
  private drainWaiters: Array<{ lowWater: number; resolve: () => void }> = [];
  private readonly progressAt = new Map<string, number>();

  private chunkSize: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly drainTimeoutMs: number;
  private readonly ackTimeoutMs: number;
  private readonly progressIntervalMs: number;
  private readonly ackIntervalBytes: number;
  private readonly readAheadBytes: number;

  constructor(
    private readonly sink: SinkPort,
    private readonly handlers: TransferHandlers,
    private readonly opts: TransferOptions,
  ) {
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    this.highWater = opts.highWater ?? DEFAULT_HIGH_WATER;
    this.lowWater = opts.lowWater ?? DEFAULT_LOW_WATER;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT;
    this.ackTimeoutMs = opts.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT;
    this.progressIntervalMs = opts.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL;
    this.ackIntervalBytes = opts.ackIntervalBytes ?? DEFAULT_ACK_INTERVAL;
    this.readAheadBytes = opts.readAheadBytes ?? DEFAULT_READ_AHEAD;
  }

  /** 当前实际使用的分片大小，界面和日志会显示它 */
  get activeChunkSize(): number {
    return this.chunkSize;
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get hasIncoming(): boolean {
    return this.incoming !== null;
  }

  /** 绑定一条点对点链路，之后到达的分片会被处理和重组。 */
  attach(link: PeerLink): void {
    this.link = link;
    // 传输层报多少就用多少。写死 16 KiB 在能发 64 KiB 的链路上是四倍的浪费。
    if (this.opts.chunkSize === undefined) {
      this.chunkSize = clampChunkSize(link.maxChunkSize());
    }
    link.onMessage((data) => {
      this.receiveChain = this.receiveChain
        .then(() => this.handle(data))
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          // 半途炸的这一次要带上是谁的哪次传输，否则发送端只能靠超时猜，
          // 界面上还会留下"接收端一声不响"的记录。
          const inc = this.incoming;
          if (inc) {
            this.incoming = null;
            void inc.session.abort(message);
            this.failIncoming(inc.meta.id, `接收端写入失败：${message}`);
            return;
          }
          this.handlers.onStatus?.({ id: '', direction: 'in', status: 'error', message });
        });
    });
    link.onDrain(() => this.checkDrain());
    link.onStateChange((state) => {
      if (state === 'closed' || state === 'failed') {
        this.failAll(state === 'failed' ? '连接失败' : '连接已关闭');
      } else if (state === 'connected') {
        void this.pump();
      }
    });
    if (link.state === 'connected') void this.pump();
  }

  /** 解绑链路，把排队中的任务全部作废。换对端之前必须调它。 */
  detach(reason = '连接已断开'): void {
    this.failAll(reason);
    this.link = null;
  }

  /** 排队发送一个文件，返回传输 ID。 */
  enqueue(file: FileLike): string {
    const id = this.opts.newTransferId();
    this.queue.push({ id, file });
    this.handlers.onStatus?.({
      id,
      direction: 'out',
      status: 'pending',
      meta: { id, name: sanitizeFileName(file.name), size: file.size, mime: file.type },
    });
    void this.pump();
    return id;
  }

  sendText(text: string): string {
    const id = this.opts.newTransferId();
    this.send({ t: 'text', id, text });
    this.handlers.onStatus?.({ id, direction: 'out', status: 'done' });
    return id;
  }

  /* ---------------------------------------------------------- 发送 */

  private async pump(): Promise<void> {
    if (this.sending) return;
    const link = this.link;
    if (!link || link.state !== 'connected') return;
    this.sending = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0]!;
        if (link.state !== 'connected') break;
        try {
          await this.sendJob(job);
          this.queue.shift();
          this.handlers.onStatus?.({ id: job.id, direction: 'out', status: 'done' });
        } catch (err) {
          this.queue.shift();
          const message = err instanceof Error ? err.message : String(err);
          this.handlers.onStatus?.({ id: job.id, direction: 'out', status: 'error', message });
        }
      }
    } finally {
      this.sending = false;
    }
  }

  private async sendJob(job: Outgoing): Promise<void> {
    const link = this.link;
    if (!link) throw new Error('还没有绑定链路');
    const { id, file } = job;
    const mime = file.type || 'application/octet-stream';
    const name = sanitizeFileName(file.name);
    const total = Math.ceil(file.size / this.chunkSize);
    const meta: FileMeta = { id, name, size: file.size, mime };

    this.handlers.onStatus?.({ id, direction: 'out', status: 'active', meta });
    this.send({ t: 'meta', ...meta });

    let transferred = 0;
    // 预读缓冲：一次读一大块，再切成小片发出去。
    // 收发单位仍然是 chunkSize，变小的只有"读文件"的次数。
    let buffer: Uint8Array | null = null;
    let bufferStart = 0;
    const readAhead = Math.max(this.chunkSize, this.readAheadBytes);

    for (let i = 0; i < total; i++) {
      await this.waitForDrain();
      if (link.state !== 'connected') throw new Error('发送中断：连接已关闭');
      const start = i * this.chunkSize;
      const end = Math.min(start + this.chunkSize, file.size);

      // 判断条件是"这一块**完整**落在缓冲里"，所以要用 end 而不是 start。
      // 用 start 判断的话，横跨缓冲末尾的那一块会被 subarray 悄悄截断，
      // 中间一整段字节丢掉，而分片计数还是对的，只有最后的总字节数对不上。
      // 这个 bug 只在分片大小除不尽预读大小时出现：测试里用 16 KiB 能整除 4 MiB，
      // 所以一直没暴露；真机上是 65528，除不尽，每 4 MiB 必丢一段。
      if (!buffer || start < bufferStart || end > bufferStart + buffer.byteLength) {
        const readEnd = Math.min(start + readAhead, file.size);
        buffer = new Uint8Array(await file.slice(start, readEnd));
        bufferStart = start;
      }
      const from = start - bufferStart;
      // encodeChunk 会把内容复制出去，所以这里复用缓冲区是安全的
      const payload = buffer.subarray(from, from + (end - start));

      link.send(encodeChunk(i, total, payload));
      transferred = end;
      this.emitProgress(id, 'out', transferred, file.size);
    }

    this.send({ t: 'done', id, size: file.size });
    await this.waitForAck(id, file.size);
  }

  /**
   * 等对方确认把整个文件收下了。没确认成，这里就抛错。
   *
   * 早先这个等待超时之后是静静返回的，返回值也不区分"确认到了"和"等不下去了"，
   * 于是调用方一律当成功。手机上"下载到最末尾崩掉"这种失败，在电脑端照样
   * 显示完成，两端各说各话。现在把三种结束分开：
   *   - 对方报来了失败原因 → 直接把那句话原文抛出去，两端显示同一句；
   *   - 链路断了 → 发送中断；
   *   - 确认停止增长 → 没收到收完确认，带上已确认的字节数。
   *
   * 超时按"确认还动不动"算，不按总时长算：广域网上最后一个分片还在路上时，
   * 对方读完、落盘、回确认本身就可能几十秒。中途每收到一个确认就重新计时，
   * 慢只是慢，不该判死。
   */
  private async waitForAck(id: string, size: number): Promise<void> {
    for (;;) {
      if ((this.acks.get(id) ?? 0) >= size) return;
      const reported = this.remoteErrors.get(id);
      if (reported) throw new Error(reported);
      const confirmed = await this.awaitAck(id);
      if (confirmed) continue;
      const late = this.remoteErrors.get(id);
      if (late) throw new Error(late);
      const link = this.link;
      if (!link || link.state !== 'connected') throw new Error('发送中断：连接已关闭');
      throw new Error(
        `发送中断：对方没有确认收完（已确认 ${this.acks.get(id) ?? 0} / ${size} 字节）`,
      );
    }
  }

  /** 等一个确认帧。收到确认返回 true，超时或链路断了返回 false。 */
  private awaitAck(id: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (confirmed: boolean) => {
        if (timer) clearTimeout(timer);
        this.ackWaiters.delete(id);
        resolve(confirmed);
      };
      timer = setTimeout(() => finish(false), this.ackTimeoutMs);
      this.ackWaiters.set(id, finish);
    });
  }

  private onAck(id: string, received: number): void {
    // 确认只增不减：中途确认和收尾确认可能交错到达，别让旧的把新的抹掉。
    const last = Math.max(this.acks.get(id) ?? 0, received);
    const grew = last > (this.acks.get(id) ?? 0);
    this.acks.set(id, last);
    // 只有真的往前走才重新计时。对方反复回同一个数字时，等待必须照样有尽头，
    // 否则"确认停 30 秒"会被一个不动的计数器拖成永远。
    if (grew) this.ackWaiters.get(id)?.(true);
  }

  /* ---------------------------------------------------------- 接收 */

  private handle(data: string | ArrayBuffer): Promise<void> | void {
    if (typeof data === 'string') {
      const msg = decodeControl(data);
      if (!msg) return;
      return this.handleControl(msg);
    }
    return this.handleChunk(data);
  }

  private handleControl(msg: ControlMessage): Promise<void> | void {
    switch (msg.t) {
      case 'meta':
        return this.startIncoming(msg);
      case 'done':
        return this.finishIncoming(msg.id, msg.size);
      case 'ack':
        this.onAck(msg.id, msg.received);
        return;
      case 'text':
        this.handlers.onText?.(msg.id, msg.text);
        this.handlers.onStatus?.({ id: msg.id, direction: 'in', status: 'done' });
        return;
      case 'error': {
        // 对端报回来的失败原因要能打断自己这边的收尾等待：
        // 只把它记成一条接收记录的话，发送端还要空等几十秒才失败，
        // 而且界面上会出现"接收失败"和"发送完成"两行互相矛盾的记录。
        const waiter = msg.id ? this.ackWaiters.get(msg.id) : undefined;
        if (msg.id) this.remoteErrors.set(msg.id, `对方报告失败：${msg.message}`);
        if (waiter) {
          waiter(false);
          return;
        }
        this.handlers.onStatus?.({
          id: msg.id ?? '',
          direction: 'in',
          status: 'error',
          message: msg.message,
        });
        return;
      }
      case 'cancel':
        return this.handleCancel(msg);
      default:
        return;
    }
  }

  /**
   * 对端取消了传输。带 id 只处理那一条；不带 id 时把当前接收和所有
   * 正在等确认的发送一起结束。
   *
   * 取消不再回 error 帧：对方是主动取消的，再报一次错只会让两边各多一条
   * 互相矛盾的消息。半截文件必须在这里删掉，不能留成一条可下载的记录。
   */
  private async handleCancel(msg: Extract<ControlMessage, { t: 'cancel' }>): Promise<void> {
    const message = cancelReasonText(msg.reason);

    // 先把发送端放出来，让它立刻失败；接收端的清理要走一次 IO，可以稍后。
    if (msg.id) {
      this.remoteErrors.set(msg.id, message);
      this.ackWaiters.get(msg.id)?.(false);
    } else {
      for (const id of [...this.ackWaiters.keys()]) {
        this.remoteErrors.set(id, message);
        this.ackWaiters.get(id)?.(false);
      }
    }

    const inc = this.incoming;
    if (inc && (!msg.id || inc.meta.id === msg.id)) {
      this.incoming = null;
      try {
        await inc.session.abort(message);
      } catch {
        // 半截文件没删干净也不能把取消原因吞掉；记录照常标成已取消。
      }
      this.handlers.onStatus?.({
        id: inc.meta.id,
        direction: 'in',
        status: 'error',
        message,
      });
    }
  }

  private async startIncoming(msg: Extract<ControlMessage, { t: 'meta' }>): Promise<void> {
    if (this.incoming) {
      await this.incoming.session.abort('对端开始了新的传输，前一个未完成');
      this.handlers.onStatus?.({
        id: this.incoming.meta.id,
        direction: 'in',
        status: 'error',
        message: '被新的传输打断',
      });
      this.incoming = null;
    }
    // 接收端放不下就早点说清楚。让它传到一半再崩，用户只会以为是网络问题。
    const limit = this.sink.maxBufferedBytes?.();
    if (limit !== undefined && msg.size > limit) {
      this.send({ t: 'error', id: msg.id, message: '对方这一次收不下这么大的文件' });
      this.handlers.onStatus?.({
        id: msg.id,
        direction: 'in',
        status: 'error',
        message: `这个浏览器只能先把文件收在内存里，最多约 ${Math.round(limit / 1e6)} MB，对方发的是 ${(msg.size / 1e6).toFixed(0)} MB`,
      });
      return;
    }

    const mime = msg.mime || 'application/octet-stream';
    const meta: FileMeta = {
      id: msg.id,
      name: ensureExtension(msg.name, mime),
      size: msg.size,
      mime,
    };
    const session = await this.sink.begin(meta);
    this.incoming = {
      meta,
      session,
      expected: 0,
      total: 0,
      bytes: 0,
      lastAckBytes: 0,
      cache: new Map(),
    };
    this.handlers.onStatus?.({ id: meta.id, direction: 'in', status: 'active', meta });
  }

  private async handleChunk(buf: ArrayBuffer): Promise<void> {
    const inc = this.incoming;
    if (!inc) return; // 没有 meta 的数据帧，按协议丢弃
    const { index, total, payload } = decodeChunk(buf);
    inc.total = total;
    if (index < inc.expected) return; // 重复分片
    if (index > inc.expected) {
      // 有序通道下不该出现，作为兜底先存着
      inc.cache.set(index, payload);
      return;
    }
    await this.writeChunk(inc, index, payload);
    for (;;) {
      const next = inc.cache.get(inc.expected);
      if (!next) break;
      inc.cache.delete(inc.expected);
      await this.writeChunk(inc, inc.expected, next);
    }
    // 不必每块都回一次确认。按字节数攒着回，控制帧能少一个数量级。
    if (inc.bytes - inc.lastAckBytes >= this.ackIntervalBytes) {
      inc.lastAckBytes = inc.bytes;
      this.send({ t: 'ack', id: inc.meta.id, received: inc.bytes });
    }
  }

  private async writeChunk(inc: Incoming, index: number, payload: Uint8Array): Promise<void> {
    await inc.session.write(payload);
    inc.expected = index + 1;
    inc.bytes += payload.byteLength;
    this.emitProgress(inc.meta.id, 'in', inc.bytes, inc.meta.size);
  }

  /**
   * 进度回调按时间节流。
   *
   * 每一块都回调一次界面，46 MB 的文件就是近三千次界面重绘，
   * 而重绘和收发抢的是同一个主线程，会把传输本身拖慢。
   * 最后一块一定回调，保证界面能走到 100%。
   */
  private emitProgress(id: string, direction: Direction, transferred: number, size: number): void {
    const now = Date.now();
    const finished = size > 0 && transferred >= size;
    if (!finished && now - (this.progressAt.get(id) ?? 0) < this.progressIntervalMs) return;
    this.progressAt.set(id, now);
    this.handlers.onProgress?.(id, direction, transferred, size);
  }

  private async finishIncoming(id: string, size: number): Promise<void> {
    const inc = this.incoming;
    if (!inc || inc.meta.id !== id) return;
    this.incoming = null;
    if (inc.bytes !== size || inc.bytes !== inc.meta.size) {
      await inc.session.abort('大小不一致');
      this.failIncoming(id, `大小不一致：收到 ${inc.bytes} 字节，声明 ${size} 字节`);
      return;
    }
    let artifact: ReceivedArtifact | undefined;
    try {
      artifact = await inc.session.commit();
    } catch (err) {
      // 收齐了字节不等于落盘成功。手机把整个文件攒在内存里，
      // 最后拼 Blob 那一步可能失败，也可能下载被系统拦掉。
      // 这一步以前只记在本地，发送端只能靠超时猜。
      const message = err instanceof Error ? err.message : String(err);
      this.failIncoming(id, `接收端收尾失败：${message}`);
      return;
    }
    this.send({ t: 'ack', id, received: inc.bytes });
    this.handlers.onStatus?.({ id, direction: 'in', status: 'done', meta: inc.meta });
    if (artifact) this.handlers.onArtifact?.(id, artifact);
  }

  /**
   * 接收端这一次没成。本地记一条，同时把原因原文回给对方。
   *
   * 回执是这里存在的理由：不发给对方的话，对方只会看到"没等到确认"，
   * 两端一边显示失败一边显示完成，谁也不知道对方到底怎么了。
   */
  private failIncoming(id: string, message: string): void {
    this.send({ t: 'error', id, message });
    this.handlers.onStatus?.({ id, direction: 'in', status: 'error', message });
  }

  /* ---------------------------------------------------------- 流控 */

  /**
   * 缓冲区超过高水位就暂停，降到低水位再继续。
   * 少了这一段，把几个 GB 丢进 send() 会把标签页直接拖死。
   */
  private async waitForDrain(): Promise<void> {
    const link = this.link;
    if (!link) throw new Error('还没有绑定链路');
    if (link.bufferedAmount() <= this.highWater) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let interval: ReturnType<typeof setInterval> | undefined;
      const waiter = {
        lowWater: this.lowWater,
        resolve: () => {
          if (timer) clearTimeout(timer);
          if (interval) clearInterval(interval);
          resolve();
        },
      };
      const giveUp = () => {
        this.drainWaiters = this.drainWaiters.filter((w) => w !== waiter);
        waiter.resolve();
      };
      timer = setTimeout(giveUp, this.drainTimeoutMs);
      interval = setInterval(() => this.checkDrain(), 50);
      this.drainWaiters.push(waiter);
      this.checkDrain();
    });
  }

  private checkDrain(): void {
    const link = this.link;
    if (!link) return;
    if (!this.drainWaiters.length) return;
    const amount = link.bufferedAmount();
    const remain: typeof this.drainWaiters = [];
    for (const w of this.drainWaiters) {
      if (amount <= w.lowWater) w.resolve();
      else remain.push(w);
    }
    this.drainWaiters = remain;
  }

  /* ---------------------------------------------------------- 收尾 */

  private send(msg: ControlMessage): void {
    const link = this.link;
    if (!link || link.state !== 'connected') return;
    link.send(encodeControl(msg));
  }

  private failAll(reason: string): void {
    while (this.queue.length) {
      const job = this.queue.shift()!;
      this.handlers.onStatus?.({ id: job.id, direction: 'out', status: 'error', message: reason });
    }
    for (const [id, waiter] of this.ackWaiters) {
      this.ackWaiters.delete(id);
      waiter(false);
    }
    for (const w of this.drainWaiters) w.resolve();
    this.drainWaiters = [];
    if (this.incoming) {
      const inc = this.incoming;
      this.incoming = null;
      void inc.session.abort(reason);
      this.handlers.onStatus?.({ id: inc.meta.id, direction: 'in', status: 'error', message: reason });
    }
  }
}
