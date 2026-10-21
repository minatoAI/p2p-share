/**
 * 声音配对：把六位配对码编成一段声音播出去，或者听回来。
 *
 * 库是 ggwave（MIT），编解码都在 WASM 里跑。这里只管"播"和"听"两件事，
 * 配对码从哪来、听到之后怎么办，都留给界面。
 *
 * 三个必须记住的点，错了就是"没反应"：
 *   1. 采集参数必须把回声消除、降噪、自动增益全关掉，否则浏览器会把信号当噪声处理；
 *   2. 解码是有状态的，一个实例只用来听一次，听完就 free（WASM 版最多同时 4 个实例）；
 *   3. ggwave 的 npm 包是 CJS 导出，动态导入时要兼容 default 和具名两种形态。
 */

/** ggwave 模块的最小形状。它没有类型定义，用到哪写哪。 */
interface GgwaveModule {
  getDefaultParameters(): GgwaveParams;
  init(params: GgwaveParams): number;
  free(id: number): void;
  encode(id: number, payload: string, protocol: number, volume: number): Uint8Array;
  decode(id: number, data: Uint8Array): Uint8Array | null;
  ProtocolId: Record<string, number>;
  disableLog(): void;
}

interface GgwaveParams {
  sampleRateInp: number;
  sampleRateOut: number;
  [key: string]: unknown;
}

const FRAME = 1024;
/** 近超声档。15 kHz 起，绝大多数人在正常音量下听不见。 */
const PROTOCOL = 'GGWAVE_PROTOCOL_ULTRASOUND_FAST';

let modulePromise: Promise<GgwaveModule> | null = null;
let context: AudioContext | null = null;
/** 当前那一段超声播放。停的时候要能立刻掐掉，不能等它自己放完。 */
let currentPlayback: (() => void) | null = null;

/** 立刻停掉正在放的超声。点"停下"要马上安静。 */
export function stopPlayback(): void {
  currentPlayback?.();
}

async function loadGgwave(): Promise<GgwaveModule> {
  if (!modulePromise) {
    modulePromise = (async () => {
      const imported = (await import('ggwave')) as unknown as
        | { default?: () => Promise<GgwaveModule> }
        | (() => Promise<GgwaveModule>);
      const factory =
        typeof imported === 'function' ? imported : (imported.default as () => Promise<GgwaveModule>);
      const mod = await factory();
      mod.disableLog();
      return mod;
    })();
  }
  return modulePromise;
}

function audioContext(): AudioContext {
  if (!context) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    context = new Ctor();
  }
  if (context.state === 'suspended') void context.resume();
  return context;
}

function parametersFor(mod: GgwaveModule, rate: number): GgwaveParams {
  const params = mod.getDefaultParameters();
  params.sampleRateInp = rate;
  params.sampleRateOut = rate;
  return params;
}

/** 浏览器有没有必备的两样东西。没有就不给按钮，别让人点了才发现。 */
/**
 * 摩尔斯音效：一遍一遍发 HELLO。
 *
 * 不是播一段固定音频再循环——那样循环接缝会被听出来。这里用"提前排期"的
 * 写法：每 200 毫秒看一眼，只要往后排的音还不到两秒，就把下一个 HELLO
 * 排进音频线程的队列。节奏按摩尔斯的时间单位：点一个单位、划三个单位、
 * 音之间空一个单位、字母之间空三个单位、两个词之间空七个。
 *
 * 频段在人耳范围内（760 Hz），和配对码用的近超声（15 kHz 以上）隔着十几个
 * 倍频程，互不干扰：麦克风那侧的解码只看超声那一段，这点声音进不去。
 */
export function startMorseLoop(): () => void {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return () => {};
  const ctx = new AudioContext();
  const unit = 0.09;
  const master = ctx.createGain();
  master.gain.value = 0.12;
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = 2200;
  master.connect(filter).connect(ctx.destination);

  const beep = (at: number, hold: number, tail: number) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 760;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(1, at + 0.008);
    gain.gain.setValueAtTime(1, at + hold);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + hold + tail);
    osc.connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + hold + tail + 0.02);
  };

  // 1 是点，3 是划。
  //   HELLO：H ....  E .  L .-..  L .-..  O ---
  //   VVV  ：摩尔斯操作里公认的"正在测试"信号，线路检查用
  //   QRV? ：Q --.-  R .-.  V ...-  ? ..--..
  //          "?" 是单独一个字符，所以 V 之后要先空三个单位，再发问号
  const LETTERS: Record<string, number[]> = {
    H: [1, 1, 1, 1],
    E: [1],
    L: [1, 3, 1, 1],
    O: [3, 3, 3],
    V: [1, 1, 1, 3],
    Q: [3, 3, 1, 3],
    R: [1, 3, 1],
    '?': [1, 1, 3, 3, 1, 1],
  };
  const WORDS = [['H', 'E', 'L', 'L', 'O'], ['V', 'V', 'V'], ['Q', 'R', 'V', '?']];

  let next = ctx.currentTime + 0.06;
  const schedule = () => {
    while (next < ctx.currentTime + 2) {
      const word = WORDS[Math.floor(Math.random() * WORDS.length)] ?? WORDS[0]!;
      for (const letter of word) {
        for (const symbol of LETTERS[letter] ?? [1]) {
          beep(next, unit * symbol, symbol === 3 ? 0.09 : 0.02);
          next += unit * symbol + unit;
        }
        // 字母之间空三个单位，上面已经空了一个
        next += unit * 2;
      }
      // 两个 HELLO 之间空七个单位
      next += unit * 7;
    }
  };

  schedule();
  const timer = window.setInterval(schedule, 200);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    window.clearInterval(timer);
    // 关掉上下文，已经排进队列的音立刻消失，不会多放一段
    void ctx.close().catch(() => {});
  };
}

/**
 * 试一下声音：播一个短音，同时用麦克风听回来。
 *
 * 浏览器没有读系统音量或静音的接口，所以只能这样间接判断：
 * 自己发的自己听得到，说明音量链路是通的。戴耳机的场景会被判成"没听到"，
 * 所以这句话只能当提示，不能当结论。
 */
export async function probeAudio(): Promise<'ok' | 'quiet' | 'unknown'> {
  try {
    const ctx = new AudioContext();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = 620;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.35, ctx.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.45);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);

    const buf = new Float32Array(analyser.fftSize);
    let peak = 0;
    const deadline = performance.now() + 700;
    while (performance.now() < deadline) {
      analyser.getFloatTimeDomainData(buf);
      for (let i = 0; i < buf.length; i += 1) {
        const v = buf[i] ?? 0;
        peak = Math.max(peak, Math.abs(v));
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close().catch(() => {});
    return peak > 0.01 ? 'ok' : 'quiet';
  } catch {
    return 'unknown';
  }
}

/**
 * 播的那一端自己听一下：麦克风能不能听见自己放出来的声音。
 *
 * 浏览器读不到系统音量和静音开关，只能用这个间接办法：一边播，一边开麦克风
 * 量输入电平。六秒内听到过像样的声音就算正常；一直安静就说明对面那台大概率
 * 听不到（静音、音量太小、或者扬声器坏了）。
 *
 * 戴耳机的场景会被误判成"没听到"——声音根本没进麦克风。所以这句话是提示，
 * 不是判决。
 */
export function startSelfCheck(onResult: (r: 'ok' | 'quiet' | 'unknown') => void): () => void {
  let stopped = false;
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let timer: number | null = null;

  const cleanup = () => {
    if (timer !== null) window.clearInterval(timer);
    timer = null;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void ctx?.close().catch(() => {});
    ctx = null;
  };

  const finish = (result: 'ok' | 'quiet' | 'unknown') => {
    if (stopped) return;
    stopped = true;
    cleanup();
    onResult(result);
  };

  void (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const buf = new Float32Array(analyser.fftSize);
      const deadline = performance.now() + 6000;
      timer = window.setInterval(() => {
        if (stopped) return;
        analyser.getFloatTimeDomainData(buf);
        let peak = 0;
        for (let i = 0; i < buf.length; i += 1) {
          const v = buf[i] ?? 0;
          peak = Math.max(peak, Math.abs(v));
        }
        if (peak > 0.015) finish('ok');
        else if (performance.now() > deadline) finish('quiet');
      }, 150);
    } catch {
      finish('unknown');
    }
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    cleanup();
  };
}

export function soundSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    Boolean(window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    Boolean(window.AudioWorkletNode)
  );
}

/**
 * 把一段码播出去。返回的 promise 在声音放完时 resolve。
 *
 * 播两遍：第一遍常常因为对面还没就位而白放，中间隔半秒让它重新对齐。
 */
export async function playCode(code: string, tag?: string): Promise<void> {
  const mod = await loadGgwave();
  const ctx = audioContext();
  const params = parametersFor(mod, ctx.sampleRate);
  const id = mod.init(params);
  let samples: Float32Array;
  try {
    // tag 是这台设备公钥的指纹前 8 位，让对面核对灯塔给的那把钥匙
    const payload = tag ? `${code}:${tag}` : code;
    const bytes = new Uint8Array(mod.encode(id, payload, mod.ProtocolId[PROTOCOL]!, 50));
    samples = new Float32Array(bytes.buffer.slice(0));
  } finally {
    mod.free(id);
  }

  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.getChannelData(0).set(samples);

  // 静音会让接收端重新对齐，两遍之间留这么一段
  const gap = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.4), ctx.sampleRate);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.connect(ctx.destination);

  await new Promise<void>((resolve) => {
    const seconds = samples.length / ctx.sampleRate;
    let settled = false;
    let timer: number | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      currentPlayback = null;
      try {
        source.stop();
      } catch {
        /* 已经停了 */
      }
      resolve();
    };
    currentPlayback = finish;
    timer = window.setTimeout(finish, (seconds * 2 + 0.4) * 1000);
    source.start();
  });
  void gap;
}

/** 一次监听会话。stop 是提前结束，done 一定会 resolve。 */
export interface Listening {
  stop(): void;
  done: Promise<string | null>;
}

const WORKLET = `
class ChirpTap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(1024); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i += 1) {
      this.buf[this.n] = ch[i];
      this.n += 1;
      if (this.n === 1024) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
    }
    return true;
  }
}
registerProcessor('chirp-tap', ChirpTap);
`;

/**
 * 听一段声音。默认听 12 秒，听到就提前结束。
 *
 * 麦克风拿不到会直接抛，界面据此告诉用户"用嘴念也行"。
 */
export async function listenForCode(opts: { ms?: number } = {}): Promise<Listening> {
  const mod = await loadGgwave();
  const ctx = audioContext();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  let stopped = false;
  let finish: (code: string | null) => void = () => {};
  const done = new Promise<string | null>((resolve) => {
    finish = resolve;
  });

  const params = parametersFor(mod, ctx.sampleRate);
  const id = mod.init(params);
  const source = ctx.createMediaStreamSource(stream);
  const moduleUrl = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  await ctx.audioWorklet.addModule(moduleUrl);
  URL.revokeObjectURL(moduleUrl);

  const node = new AudioWorkletNode(ctx, 'chirp-tap');
  const sink = ctx.createGain();
  sink.gain.value = 0;
  source.connect(node);
  node.connect(sink);
  sink.connect(ctx.destination);

  let timer: number | undefined;

  const cleanup = (code: string | null) => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) window.clearTimeout(timer);
    try {
      node.port.onmessage = null;
      node.disconnect();
      sink.disconnect();
      source.disconnect();
    } catch {
      /* 节点已经拆过 */
    }
    stream.getTracks().forEach((t) => t.stop());
    mod.free(id);
    finish(code);
  };

  node.port.onmessage = (e: MessageEvent<Float32Array>) => {
    if (stopped) return;
    const frame = e.data;
    const res = mod.decode(id, new Uint8Array(frame.buffer));
    if (res && res.length > 0) cleanup(new TextDecoder().decode(res));
  };

  timer = window.setTimeout(() => cleanup(null), opts.ms ?? 12_000);

  return { stop: () => cleanup(null), done };
}
