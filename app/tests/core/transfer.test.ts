import { describe, expect, it } from 'vitest';
import { TransferEngine, type FileLike, type TransferUpdate } from '../../src/core/transfer';
import type { FileMeta, ReceivedArtifact, WriteSession } from '../../src/core/ports';
import {
  cancelReasonText,
  decodeControl,
  encodeChunk,
  encodeControl,
  type ControlMessage,
} from '../../src/core/protocol';
import { MemorySink } from '../../src/adapters/memory/sink';
import { memoryLinkPair } from '../../src/adapters/memory/link';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, label: string, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (cond()) return;
    await sleep(5);
  }
  throw new Error(`等待超时：${label}`);
}

function pattern(n: number): Uint8Array {
  const b = new Uint8Array(n);
  for (let i = 0; i < n; i++) b[i] = i % 251;
  return b;
}

function fileLike(name: string, bytes: Uint8Array, type = 'application/octet-stream'): FileLike {
  return {
    name,
    size: bytes.byteLength,
    type,
    slice: async (start, end) => bytes.slice(start, end).buffer as ArrayBuffer,
  };
}

/** 会数读取次数的文件，用来验证预读确实生效。 */
function countingFile(name: string, bytes: Uint8Array) {
  let reads = 0;
  const file: FileLike = {
    name,
    size: bytes.byteLength,
    type: 'application/octet-stream',
    slice: async (start, end) => {
      reads += 1;
      return bytes.slice(start, end).buffer as ArrayBuffer;
    },
  };
  return { file, reads: () => reads };
}

function engine(sink: MemorySink, id: () => string, updates: TransferUpdate[] = [], opts = {}) {
  return new TransferEngine(
    sink,
    { onStatus: (u) => updates.push(u) },
    { newTransferId: id, ...opts },
  );
}

describe('单向文件传输', () => {
  it('分块发送，接收端拼出完全一致的字节', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1');
    aEngine.attach(aLink);

    // 故意不用 16KB 的整数倍，边界那一块最容易错
    const bytes = pattern(300 * 1024 + 12345);
    aEngine.enqueue(fileLike('相片.jpg', bytes, 'image/jpeg'));

    await waitFor(() => sinkB.files[0]?.committed === true, 'B 收完并提交');
    const got = sinkB.files[0]!;
    expect(got.meta.name).toBe('相片.jpg');
    expect(got.meta.mime).toBe('image/jpeg');
    expect(got.meta.size).toBe(bytes.byteLength);
    expect(got.bytes).toEqual(bytes);
  });

  it('分块数等于 ceil(size / 16KB)，每块不超过 16KB', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);

    const sentSizes: number[] = [];
    const aEngine = engine(new MemorySink(), () => 'a1');
    aEngine.attach(aLink);

    // 直接观察对端收到的二进制帧
    bLink.onMessage((data) => {
      if (typeof data !== 'string') sentSizes.push(data.byteLength);
    });

    const size = 100_000;
    aEngine.enqueue(fileLike('a.bin', pattern(size)));
    await waitFor(() => sinkB.files[0]?.committed === true, '传完');
    expect(sentSizes.length).toBe(Math.ceil(size / (16 * 1024)));
    expect(Math.max(...sentSizes)).toBeLessThanOrEqual(16 * 1024 + 8);
  });

  it('接收端把危险文件名净化掉', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);

    aLink.send(
      encodeControl({
        t: 'meta',
        id: 'evil',
        name: '../../../../Windows/System32/evil.dll',
        size: 4,
        mime: '',
      }),
    );
    aLink.send(encodeChunk(0, 1, new Uint8Array([1, 2, 3, 4])));
    aLink.send(encodeControl({ t: 'done', id: 'evil', size: 4 }));

    await waitFor(() => sinkB.files[0]?.committed === true, '收完');
    expect(sinkB.files[0]!.meta.name).toBe('evil.dll');
  });
});

describe('预读边界', () => {
  it('分片横跨预读缓冲末尾时不会被截断', async () => {
    // 这是真机上踩到过的 bug：预读缓冲是 4 MiB，分片是 65528 字节，
    // 除不尽，于是总有一块横跨缓冲末尾。原来的重读条件只看 start 在不在
    // 缓冲里，横跨的那一块就被 subarray 悄悄截断，中间一段字节丢掉，
    // 而分片计数完全正确，只有最后的总字节数对不上。
    //
    // 之前没抓到是因为测试用的分片大小（16 KiB）刚好能整除预读大小。
    // 这里故意选一个除不尽、而且文件要跨过缓冲边界的组合。
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1', [], {
      chunkSize: 65_528,
      readAheadBytes: 1024 * 1024,
    });
    aEngine.attach(aLink);

    // 2.5 MiB 会跨过两个 1 MiB 的缓冲边界
    const bytes = pattern(2 * 1024 * 1024 + 512 * 1024 + 77);
    aEngine.enqueue(fileLike('跨越边界.bin', bytes));

    await waitFor(() => sinkB.files[0]?.committed === true, 'B 收完并提交');
    const got = sinkB.files[0]!;
    expect(got.bytes.byteLength).toBe(bytes.byteLength);
    expect(got.bytes).toEqual(bytes);
  });

  it('分片大小能整除预读大小时也一致', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1', [], {
      chunkSize: 16 * 1024,
      readAheadBytes: 256 * 1024,
    });
    aEngine.attach(aLink);

    const bytes = pattern(1024 * 1024 + 999);
    aEngine.enqueue(fileLike('整除.bin', bytes));
    await waitFor(() => sinkB.files[0]?.committed === true, 'B 收完并提交');
    expect(sinkB.files[0]!.bytes).toEqual(bytes);
  });
});

describe('双向同时传输', () => {
  it('两个方向互不干扰，各自拿到正确的字节', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkA = new MemorySink();
    const sinkB = new MemorySink();
    const aEngine = engine(sinkA, () => 'a1');
    const bEngine = engine(sinkB, () => 'b1');
    aEngine.attach(aLink);
    bEngine.attach(bLink);

    const bytesA = pattern(120_000);
    const bytesB = pattern(78_999);
    aEngine.enqueue(fileLike('from-a.bin', bytesA));
    bEngine.enqueue(fileLike('from-b.bin', bytesB));

    await waitFor(
      () => sinkA.files[0]?.committed === true && sinkB.files[0]?.committed === true,
      '两个方向都传完',
    );
    expect(sinkA.files[0]!.meta.name).toBe('from-b.bin');
    expect(sinkA.files[0]!.bytes).toEqual(bytesB);
    expect(sinkB.files[0]!.meta.name).toBe('from-a.bin');
    expect(sinkB.files[0]!.bytes).toEqual(bytesA);
  });
});

describe('背压', () => {
  it('缓冲区超过高水位就停手，排水后自动继续', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1', [], {
      highWater: 1024,
      lowWater: 512,
      drainTimeoutMs: 30_000,
    });
    aEngine.attach(aLink);

    aLink.congested = true;
    aEngine.enqueue(fileLike('big.bin', pattern(200 * 1024)));

    await waitFor(() => aLink.bufferedAmount() > 1024, '缓冲区涨过水位');
    // 堵住期间一个字节都不该到达对端
    expect(sinkB.files.length).toBe(0);

    // 停手之后缓冲区不该继续增长
    const frozen = aLink.bufferedAmount();
    await sleep(200);
    expect(aLink.bufferedAmount()).toBe(frozen);

    aLink.uncongest();
    await waitFor(() => sinkB.files[0]?.committed === true, '排水后传完');
    expect(sinkB.files[0]!.bytes.byteLength).toBe(200 * 1024);
  });
});

describe('乱序兜底', () => {
  it('先到的后续分片被缓存，前一块到了之后按序接上', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);

    const payload = new Uint8Array(100);
    for (let i = 0; i < 100; i++) payload[i] = i;

    aLink.send(encodeControl({ t: 'meta', id: 'T1', name: 'a.bin', size: 100, mime: '' }));
    aLink.send(encodeChunk(1, 2, payload.slice(50)));
    aLink.send(encodeChunk(0, 2, payload.slice(0, 50)));
    aLink.send(encodeControl({ t: 'done', id: 'T1', size: 100 }));

    await waitFor(() => sinkB.files[0]?.committed === true, '收完');
    expect(sinkB.files[0]!.bytes).toEqual(payload);
  });

  it('重复分片被忽略，不会让字节翻倍', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);

    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    aLink.send(encodeControl({ t: 'meta', id: 'T1', name: 'a.bin', size: 8, mime: '' }));
    aLink.send(encodeChunk(0, 1, payload));
    aLink.send(encodeChunk(0, 1, payload));
    aLink.send(encodeControl({ t: 'done', id: 'T1', size: 8 }));

    await waitFor(() => sinkB.files[0]?.committed === true, '收完');
    expect(sinkB.files[0]!.bytes).toEqual(payload);
  });
});

describe('大小不一致', () => {
  it('收到的字节和声明不符时中止写入并报错', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const updates: TransferUpdate[] = [];
    const bEngine = engine(sinkB, () => 'b1', updates);
    bEngine.attach(bLink);

    aLink.send(encodeControl({ t: 'meta', id: 'T1', name: 'a.bin', size: 100, mime: '' }));
    aLink.send(encodeChunk(0, 1, new Uint8Array(50)));
    aLink.send(encodeControl({ t: 'done', id: 'T1', size: 100 }));

    await waitFor(() => updates.some((u) => u.status === 'error'), '报错');
    expect(sinkB.files[0]!.aborted).toBe(true);
    expect(sinkB.files[0]!.committed).toBe(false);
  });
});

describe('收完交出可预览的产物', () => {
  it('commit 之后回调里能拿到产物，open() 给出完整字节', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = new TransferEngine(
      sinkB,
      {
        onArtifact: (id, art) => {
          got = { id, art };
        },
      },
      { newTransferId: () => 'b1' },
    );
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1');
    aEngine.attach(aLink);

    let got: { id: string; art: ReceivedArtifact } | null = null;
    const bytes = pattern(70_000);
    aEngine.enqueue(fileLike('图.png', bytes, 'image/png'));
    await waitFor(() => got !== null, '拿到产物');

    expect(got!.art.name).toBe('图.png');
    expect(got!.art.mime).toBe('image/png');
    expect(got!.art.size).toBe(bytes.byteLength);
    const blob = await got!.art.open();
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });
});

describe('接收容量', () => {
  it('超过接收端声明的容量就在 meta 阶段拒绝，不等到一半再崩', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    (sinkB as { maxBufferedBytes?: () => number }).maxBufferedBytes = () => 100_000;
    const updates: TransferUpdate[] = [];
    const bEngine = engine(sinkB, () => 'b1', updates);
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1');
    aEngine.attach(aLink);

    aEngine.enqueue(fileLike('太大.bin', pattern(200_000)));

    await waitFor(() => updates.some((u) => u.status === 'error'), '接收端报错');
    const err = updates.find((u) => u.status === 'error')!;
    expect(err.message).toContain('内存');
    expect(sinkB.files).toEqual([]);
  });

  it('没声明容量就不限制', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    delete (sinkB as { maxBufferedBytes?: unknown }).maxBufferedBytes;
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1');
    aEngine.attach(aLink);

    const bytes = pattern(300_000);
    aEngine.enqueue(fileLike('随便.bin', bytes));
    await waitFor(() => sinkB.files[0]?.committed === true, '照常收完');
    expect(sinkB.files[0]!.bytes).toEqual(bytes);
  });
});

describe('文本', () => {
  it('文本走同一条通道，不进文件系统', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const texts: string[] = [];
    const bEngine = new TransferEngine(
      sinkB,
      { onText: (_id, text) => texts.push(text) },
      { newTransferId: () => 'b1' },
    );
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1');
    aEngine.attach(aLink);

    aEngine.sendText('取件码 483920');
    await waitFor(() => texts.length === 1, '收到文本');
    expect(texts[0]).toBe('取件码 483920');
    expect(sinkB.files.length).toBe(0);
  });
});

describe('分片大小', () => {
  it('按传输层上报的单条消息上限推导，而不是写死 16KB', async () => {
    const [aLink, bLink] = memoryLinkPair();
    aLink.maxMessageSize = 64 * 1024;
    bLink.maxMessageSize = 64 * 1024;

    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1');
    aEngine.attach(aLink);
    expect(aEngine.activeChunkSize).toBe(64 * 1024 - 8);
    expect(bEngine.activeChunkSize).toBe(64 * 1024 - 8);

    const frameSizes: number[] = [];
    bLink.onMessage((d) => {
      if (typeof d !== 'string') frameSizes.push(d.byteLength);
    });
    const size = 200_000;
    aEngine.enqueue(fileLike('a.bin', pattern(size)));
    await waitFor(() => sinkB.files[0]?.committed === true, '传完');
    expect(frameSizes.length).toBe(Math.ceil(size / (64 * 1024 - 8)));
    expect(sinkB.files[0]!.bytes.byteLength).toBe(size);
  });

  it('上限异常时的收敛：报 0 当作 16KB，报得过大压回 256KB', () => {
    const cases: Array<[number, number]> = [
      [0, 16 * 1024], // 某些 Safari 版本会报 0，按 16KB 兜底
      [8000, 16 * 1024],
      [16 * 1024 + 8, 16 * 1024],
      [64 * 1024, 64 * 1024 - 8],
      // Chromium 实测报 262144，用满它
      [262144, 262144 - 8],
      [1024 * 1024, 256 * 1024],
    ];
    for (const [reported, expected] of cases) {
      const [link] = memoryLinkPair();
      link.maxMessageSize = reported;
      const e = engine(new MemorySink(), () => 'x');
      e.attach(link);
      expect(e.activeChunkSize, `上报 ${reported}`).toBe(expected);
    }
  });
});

describe('发送时的读取次数', () => {
  it('一次读一大块再切片，1 MiB 的文件只读 1 次而不是 64 次', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1', [], { readAheadBytes: 4 * 1024 * 1024 });
    aEngine.attach(aLink);

    const size = 1024 * 1024; // 按 16 KiB 分片是 64 块
    const { file, reads } = countingFile('a.bin', pattern(size));
    aEngine.enqueue(file);
    await waitFor(() => sinkB.files[0]?.committed === true, '传完');
    expect(sinkB.files[0]!.bytes.byteLength).toBe(size);
    expect(reads()).toBe(1);
  });

  it('预读窗口小的时候会多次读，但拼出来的字节仍然正确', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const aEngine = engine(new MemorySink(), () => 'a1', [], { readAheadBytes: 64 * 1024 });
    aEngine.attach(aLink);

    const size = 300 * 1024; // 不是 64 KiB 的整数倍，边界那一块最容易错
    const bytes = pattern(size);
    const { file, reads } = countingFile('a.bin', bytes);
    aEngine.enqueue(file);
    await waitFor(() => sinkB.files[0]?.committed === true, '传完');
    expect(sinkB.files[0]!.bytes).toEqual(bytes);
    expect(reads()).toBe(Math.ceil(size / (64 * 1024)));
  });
});

describe('链路中断', () => {
  it('连接关闭时排队中的任务全部失败，不会静默卡住', async () => {
    const [aLink] = memoryLinkPair();
    const updates: TransferUpdate[] = [];
    const aEngine = engine(new MemorySink(), () => 'a1', updates, { drainTimeoutMs: 30_000 });
    aEngine.attach(aLink);

    aLink.congested = true;
    aEngine.enqueue(fileLike('big.bin', pattern(300 * 1024)));
    await waitFor(() => aLink.bufferedAmount() > 0, '开始发送');
    aEngine.enqueue(fileLike('second.bin', pattern(1000)));

    aLink.close();
    await waitFor(() => updates.some((u) => u.status === 'error'), '报错');
    expect(updates.some((u) => u.status === 'error')).toBe(true);
  });
});

describe('收尾确认', () => {
  /** 收得到字节、最后一步炸掉的接收端，用来模拟手机上拼 Blob / 触发下载失败 */
  class ExplodingSink extends MemorySink {
    override async begin(meta: FileMeta): Promise<WriteSession> {
      const session = await super.begin(meta);
      return {
        ...session,
        commit: async () => {
          throw new Error('内存不够，拼不出文件');
        },
      };
    }
  }

  it('对方没有回执收完时不算完成，哪怕链路一直好好连着', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const updates: TransferUpdate[] = [];
    const aEngine = engine(new MemorySink(), () => 'a1', updates, { ackTimeoutMs: 120 });
    aEngine.attach(aLink);
    // 对面没有引擎：done 发出去没人回，但链路本身没断
    aEngine.enqueue(fileLike('a.bin', pattern(4096)));

    await waitFor(() => updates.some((u) => u.direction === 'out' && u.status === 'error'), '发送端报错');
    expect(bLink.state).toBe('connected');
    const err = updates.find((u) => u.direction === 'out' && u.status === 'error')!;
    expect(err.message).toContain('没有确认收完');
    expect(updates.some((u) => u.direction === 'out' && u.status === 'done')).toBe(false);
  });

  it('对方只确认到一半时也不算完成', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const updates: TransferUpdate[] = [];
    const aEngine = engine(new MemorySink(), () => 'a1', updates, { ackTimeoutMs: 120 });
    aEngine.attach(aLink);

    aEngine.enqueue(fileLike('a.bin', pattern(4096)));
    bLink.send(encodeControl({ t: 'ack', id: 'a1', received: 10 }));

    await waitFor(() => updates.some((u) => u.direction === 'out' && u.status === 'error'), '发送端报错');
    const err = updates.find((u) => u.direction === 'out' && u.status === 'error')!;
    expect(err.message).toContain('已确认 10 / 4096');
  });

  it('对方反复回同一个确认数字时，等待仍然有尽头', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const updates: TransferUpdate[] = [];
    const aEngine = engine(new MemorySink(), () => 'a1', updates, { ackTimeoutMs: 120 });
    aEngine.attach(aLink);

    aEngine.enqueue(fileLike('a.bin', pattern(4096)));
    // 每 10 毫秒重复同一个进度，确认一次也没往前走。等待要照样收敛。
    const repeat = setInterval(() => {
      bLink.send(encodeControl({ t: 'ack', id: 'a1', received: 10 }));
    }, 10);
    try {
      await waitFor(() => updates.some((u) => u.direction === 'out' && u.status === 'error'), '发送端报错');
    } finally {
      clearInterval(repeat);
    }
    const err = updates.find((u) => u.direction === 'out' && u.status === 'error')!;
    expect(err.message).toContain('已确认 10 / 4096');
  });

  it('接收端收尾失败时，发送端立刻用同一句话失败，不空等到超时', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const out: TransferUpdate[] = [];
    const inc: TransferUpdate[] = [];
    const bEngine = new TransferEngine(new ExplodingSink(), { onStatus: (u) => inc.push(u) }, {
      newTransferId: () => 'b1',
    });
    bEngine.attach(bLink);
    // 确认超时给得很长：这里要靠对方主动发回来的失败原因提前结束
    const aEngine = engine(new MemorySink(), () => 'a1', out, { ackTimeoutMs: 60_000 });
    aEngine.attach(aLink);

    const started = Date.now();
    aEngine.enqueue(fileLike('a.bin', pattern(4096)));
    await waitFor(() => out.some((u) => u.direction === 'out' && u.status === 'error'), '发送端报错');
    const elapsed = Date.now() - started;

    const err = out.find((u) => u.direction === 'out' && u.status === 'error')!;
    expect(err.message).toContain('内存不够，拼不出文件');
    expect(elapsed).toBeLessThan(10_000);
    expect(inc.some((u) => u.direction === 'in' && u.status === 'error')).toBe(true);
    expect(out.some((u) => u.direction === 'out' && u.status === 'done')).toBe(false);
  });

  it('大小不一致的原因会回给发送端', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const bEngine = engine(sinkB, () => 'b1');
    bEngine.attach(bLink);
    const back: ControlMessage[] = [];
    aLink.onMessage((data) => {
      if (typeof data === 'string') {
        const msg = decodeControl(data);
        if (msg) back.push(msg);
      }
    });

    aLink.send(encodeControl({ t: 'meta', id: 'T1', name: 'a.bin', size: 100, mime: '' }));
    aLink.send(encodeChunk(0, 1, new Uint8Array(50)));
    aLink.send(encodeControl({ t: 'done', id: 'T1', size: 100 }));

    await waitFor(() => back.some((m) => m.t === 'error'), '发送端收到原因');
    const msg = back.find((m): m is Extract<ControlMessage, { t: 'error' }> => m.t === 'error')!;
    expect(msg.id).toBe('T1');
    expect(msg.message).toContain('大小不一致');
    // 半途失败不能顺便给出一个确认
    expect(back.some((m) => m.t === 'ack')).toBe(false);
  });
});

describe('取消原因', () => {
  it('文案映射和 docs/36 第 3 节一致', () => {
    expect(cancelReasonText('screen-off')).toBe('已取消（屏幕关闭）');
    expect(cancelReasonText('user')).toBe('已取消');
    expect(cancelReasonText()).toBe('已取消');
    expect(cancelReasonText('peer-offline')).toBe('已取消（对方离线）');
    // 不认识的 reason 不能把原始字段名漏给用户
    expect(cancelReasonText('some-future-reason')).toBe('已取消');
  });

  it('接收中收到屏幕关闭的取消，接收行显示原因并清掉半截文件', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const sinkB = new MemorySink();
    const updates: TransferUpdate[] = [];
    const bEngine = engine(sinkB, () => 'b1', updates);
    bEngine.attach(bLink);

    aLink.send(encodeControl({ t: 'meta', id: 'T1', name: 'half.bin', size: 100, mime: '' }));
    aLink.send(encodeChunk(0, 1, new Uint8Array(50)));
    await waitFor(() => sinkB.files.length === 1, '开始接收');
    aLink.send(encodeControl({ t: 'cancel', id: 'T1', reason: 'screen-off' }));

    await waitFor(() => sinkB.files[0]!.aborted, '半截文件被清理');
    const row = updates.find(
      (u) => u.id === 'T1' && u.direction === 'in' && u.status === 'error',
    );
    expect(row?.message).toBe('已取消（屏幕关闭）');
    expect(sinkB.files[0]!.committed).toBe(false);
    expect(bEngine.hasIncoming).toBe(false);
  });

  it('发送等待收尾确认时收到取消，等待立刻结束并标 error', async () => {
    const [aLink, bLink] = memoryLinkPair();
    const updates: TransferUpdate[] = [];
    const aEngine = engine(new MemorySink(), () => 'a1', updates, { ackTimeoutMs: 60_000 });
    aEngine.attach(aLink);

    const seen: ControlMessage[] = [];
    bLink.onMessage((data) => {
      if (typeof data !== 'string') return;
      const msg = decodeControl(data);
      if (msg) seen.push(msg);
    });

    const started = Date.now();
    aEngine.enqueue(fileLike('a.bin', pattern(4096)));
    await waitFor(() => seen.some((m) => m.t === 'done'), '发送端进入等确认');
    bLink.send(encodeControl({ t: 'cancel', id: 'a1', reason: 'user' }));

    await waitFor(
      () => updates.some((u) => u.direction === 'out' && u.status === 'error'),
      '发送端报错',
    );
    const err = updates.find((u) => u.direction === 'out' && u.status === 'error')!;
    expect(err.message).toBe('已取消');
    // 确认超时给了 60 秒，能在 5 秒内失败说明是被 cancel 唤醒的
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(updates.some((u) => u.direction === 'out' && u.status === 'done')).toBe(false);
  });
});
