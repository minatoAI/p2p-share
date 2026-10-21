import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECT_TIMEOUT_MS,
  RECONNECT_DELAYS_MS,
  WebSocketSignalLink,
} from '../../src/adapters/browser';
import type { ReconnectInfo } from '../../src/core/ports';

/**
 * 假的 WebSocket，按建连顺序留档。
 *
 * 重连要验的是"断了一条之后会不会再建一条、隔多久建、建了几次"，
 * 这几件事只有把每条 socket 都留下来才看得见。真实连接做不出
 * "服务器在冻结期间悄悄把连接丢掉"这个时序。
 */
class FakeSocket {
  static all: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.all.push(this);
  }

  send(data: string): void {
    if (this.closed) throw new Error('这条连接已经关了');
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.onclose?.();
  }

  /* ---- 测试动作 ---- */

  /** 握手成功 */
  open(): void {
    if (this.closed) return;
    this.onopen?.();
  }

  /** 连接断掉（浏览器关的、或者灯塔那边关的） */
  drop(): void {
    this.close();
  }

  /** 底层出错，拿不到 close 事件的那一路 */
  fail(): void {
    this.onerror?.();
  }
}

let infos: ReconnectInfo[] = [];
let errors: string[] = [];
let link: WebSocketSignalLink | null = null;
let realWebSocket: typeof WebSocket;
let realDocument: unknown;

/** 让 link 能看到一个假的 document，用来触发"页面回到前台" */
function installDocument(): { resume: () => void; hide: () => void } {
  const listeners: Array<() => void> = [];
  const doc = {
    visibilityState: 'hidden',
    addEventListener: (type: string, cb: () => void): void => {
      if (type === 'visibilitychange') listeners.push(cb);
    },
    removeEventListener: (type: string, cb: () => void): void => {
      if (type !== 'visibilitychange') return;
      const at = listeners.indexOf(cb);
      if (at >= 0) listeners.splice(at, 1);
    },
  };
  (globalThis as { document?: unknown }).document = doc;
  return {
    resume: () => {
      doc.visibilityState = 'visible';
      for (const cb of [...listeners]) cb();
    },
    hide: () => {
      doc.visibilityState = 'hidden';
      for (const cb of [...listeners]) cb();
    },
  };
}

function newLink(): WebSocketSignalLink {
  const created = new WebSocketSignalLink('wss://lighthouse.test/ws/presence');
  created.onReconnect((info) => infos.push(info));
  created.onError((text) => errors.push(text));
  return created;
}

const sockets = (): FakeSocket[] => FakeSocket.all;
/** 最近建的那条 */
const current = (): FakeSocket => {
  const last = FakeSocket.all[FakeSocket.all.length - 1];
  if (!last) throw new Error('还没有建过 socket');
  return last;
};

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.all = [];
  infos = [];
  errors = [];
  realWebSocket = globalThis.WebSocket;
  realDocument = (globalThis as { document?: unknown }).document;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  link?.close();
  link = null;
  globalThis.WebSocket = realWebSocket;
  if (realDocument === undefined) {
    delete (globalThis as { document?: unknown }).document;
  } else {
    (globalThis as { document?: unknown }).document = realDocument;
  }
  vi.useRealTimers();
});

describe('灯塔掉线之后的重连', () => {
  it('掉线后会自己再建一条，并把"第几次、还有多久"报给界面', () => {
    link = newLink();
    current().open();
    expect(link.state).toBe('open');

    infos = [];
    current().drop();
    expect(link.state).toBe('closed');

    // 界面上要能立刻看到进度，而不是干等
    expect(infos).toHaveLength(1);
    expect(infos[0]).toMatchObject({ attempt: 1, phase: 'waiting', resumed: true });
    expect(infos[0]?.nextAt).not.toBeNull();

    // 退避走完就该真的去连
    vi.advanceTimersByTime(1_000);
    expect(sockets()).toHaveLength(2);
    expect(infos.at(-1)).toMatchObject({ attempt: 1, phase: 'trying' });
  });

  it('退避逐次变长，但封顶在最后一档', () => {
    link = newLink();
    current().open();

    const waits: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      infos = [];
      current().drop();
      const waiting = infos.find((info) => info.phase === 'waiting');
      waits.push(waiting?.delayMs ?? 0);
      // 只走过这一次退避，别再往后推——后面那条连接的握手时限（8 秒）
      // 要是也被推过去，就会多出一次连接，次数就对不上了
      vi.advanceTimersByTime((waiting?.delayMs ?? 0) + 1);
    }

    // 允许 ±15% 的抖动，只验证阶梯方向
    expect(waits[0]).toBeLessThan(waits[1] as number);
    expect(waits[1]).toBeLessThan(waits[2] as number);
    expect(waits[2]).toBeLessThan(waits[3] as number);
    const cap = RECONNECT_DELAYS_MS.at(-1) as number;
    expect(waits[3]).toBeLessThanOrEqual(Math.round(cap * 1.15));
  });

  it('连上之后次数归零，下次掉线又从第 1 次算', () => {
    link = newLink();
    current().open();
    current().drop();
    vi.advanceTimersByTime(1_000);
    current().open();

    infos = [];
    current().drop();
    expect(infos[0]).toMatchObject({ attempt: 1, phase: 'waiting' });
  });

  it('点了"立即重连"就不等退避，马上建新连接', () => {
    link = newLink();
    current().open();
    current().drop();
    expect(sockets()).toHaveLength(1);

    link.reconnectNow();
    expect(sockets()).toHaveLength(2);
    // 立刻重连不能再叠一条：已经在握手了就别重复建
    link.reconnectNow();
    expect(sockets()).toHaveLength(2);
  });

  it('已经连着的时候点重连不会把好连接拆掉', () => {
    link = newLink();
    current().open();
    link.reconnectNow();
    link.reconnectNow('manual');
    expect(sockets()).toHaveLength(1);
    expect(link.state).toBe('open');
  });
});

describe('手机切后台再回来', () => {
  it('页面回到前台立刻重连，而且不沿用冻结前拉长的退避', () => {
    const doc = installDocument();
    link = newLink();
    current().open();

    // 冻结期间连接被浏览器关掉，退避定时器也一并冻住了
    current().drop();
    // 连着掉几次，退避已经拉长到好几秒
    vi.advanceTimersByTime(600);
    current().drop();
    vi.advanceTimersByTime(1_200);
    current().drop();

    const before = sockets().length;
    doc.resume();
    expect(sockets()).toHaveLength(before + 1);
    // 恢复之后重新从最短的一档算，不该继承冻结前的长等待
    expect(infos.at(-1)).toMatchObject({ attempt: 1, phase: 'trying' });
  });

  it('页面回到前台时连接还活着，就只是重新播报，不重连', () => {
    const doc = installDocument();
    link = newLink();
    const opened: string[] = [];
    link.onStateChange((s) => opened.push(s));
    current().open();

    const before = sockets().length;
    doc.resume();
    expect(sockets()).toHaveLength(before);
    // 重新播报一次，让灯塔那边刷新在线状态
    expect(opened.at(-1)).toBe('open');
  });

  it('切回后台本身不触发重连', () => {
    const doc = installDocument();
    link = newLink();
    current().open();
    doc.hide();
    expect(sockets()).toHaveLength(1);
  });
});

describe('连接半死的情况', () => {
  it('握手卡住超过时限就算一次失败，换一条再试', () => {
    link = newLink();
    expect(sockets()).toHaveLength(1);
    // 既不成功也不失败：onclose 永远不会来
    expect(link.state).toBe('connecting');

    vi.advanceTimersByTime(CONNECT_TIMEOUT_MS);
    expect(errors.join('\n')).toContain('没连上');
    expect(infos.at(-1)).toMatchObject({ phase: 'waiting' });

    vi.advanceTimersByTime(1_000);
    expect(sockets()).toHaveLength(2);
  });

  it('底层报错和随后的 close 只算一次失败', () => {
    link = newLink();
    current().open();
    infos = [];
    current().fail();
    current().drop();
    expect(infos.filter((info) => info.phase === 'waiting')).toHaveLength(1);
  });

  it('断线期间攒下的信令，重连之后补发出去', () => {
    link = newLink();
    current().open();
    current().drop();

    link.send({ t: 'watch', ids: ['peer-1'] });
    vi.advanceTimersByTime(1_000);
    current().open();

    expect(current().sent.join('\n')).toContain('peer-1');
  });
});

describe('收尾', () => {
  it('主动 close() 之后不再重连，别在关掉的页面上一直重试', () => {
    link = newLink();
    current().open();
    current().drop();
    link.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });

  it('页面恢复之后也不会再动用已经关掉的链路', () => {
    const doc = installDocument();
    link = newLink();
    current().open();
    link.close();
    doc.resume();
    vi.advanceTimersByTime(60_000);
    expect(sockets()).toHaveLength(1);
  });
});
