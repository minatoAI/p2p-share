import { useCallback, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from 'react';
import { flushSync } from 'react-dom';
import QRCode from 'qrcode';
import { decodeImage } from './qr';
import { ScannerModal } from './scanner';
import {
  listenForCode,
  playCode,
  soundSupported,
  startMorseLoop,
  startSelfCheck,
  stopPlayback,
} from './sound';
import {
  BrowserSink,
  createIdentity,
  WebRtcTransport,
  WebSocketSignalLink,
} from '../adapters/browser';
import { FetchRegistry } from '../adapters/browser/registry';
import { MemoryStore } from '../adapters/memory/store';
import { describePath } from '../core/candidates';
import { CODE_DIGITS, CODE_ROTATE_MS, codeFromHash, formatCode, normalizeCode, pairingLink } from '../core/pairing';
import { synthesizeClipboardName } from '../core/naming';
import type {
  ContactRecord,
  DeviceIdentity,
  PeerLink,
  ReceivedArtifact,
  ReconnectInfo,
  SignalState,
} from '../core/ports';
import {
  CONNECT_PHASES,
  SessionManager,
  type ConnectPhase,
  type PairingPrompt,
  type PresenceEntry,
  type SessionState,
} from '../core/session';
import {
  ShareHub,
  parseShareToken,
  shareCode,
  type OutgoingShare,
  type VisitState,
} from '../core/share';
import { Timeline, describeEntry, formatBytes, type TimelineEntry } from '../core/timeline';
import type { FileLike, TransferUpdate } from '../core/transfer';
import type { PeerPlatform } from '../core/protocol';

/**
 * 原生客户端的下载地址。
 *
 * 还没有客户端，所以留空，界面会显示成"还在开发中"。
 * 等客户端做出来，把地址填这里，那个按钮就会变成可点的下载入口。
 */
const NATIVE_APP_URL = '';

function defaultName(): string {
  const ua = navigator.userAgent;
  const platform = /iPhone|iPad/i.test(ua)
    ? 'iPhone'
    : /Android/i.test(ua)
      ? '安卓'
      : /Macintosh/i.test(ua)
        ? 'Mac'
        : /Windows/i.test(ua)
          ? 'Windows'
          : '浏览器';
  const browser = /Edg\//i.test(ua)
    ? 'Edge'
    : /Firefox\//i.test(ua)
      ? 'Firefox'
      : /Chrome\//i.test(ua)
        ? 'Chrome'
        : /Safari\//i.test(ua)
          ? 'Safari'
          : '';
  return browser ? `${platform} · ${browser}` : platform;
}

/** 对方的端类型。旧版本配对没带这个字段，就如实说不知道。 */
function peerPlatformLabel(platform?: PeerPlatform): string {
  if (platform === 'web') return '网页端 · 一次性';
  if (platform === 'native') return '原生端 · 持续';
  return '端未标注';
}

function toFileLike(file: File): FileLike {
  return {
    name: file.name,
    size: file.size,
    type: file.type,
    slice: (start, end) => file.slice(start, end).arrayBuffer(),
  };
}

function isEditableTarget(node: EventTarget | null): boolean {
  const el = node as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName?.toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/** 传输记录里那个格式标签 */
function formatTag(mime: string, name?: string): string {
  const kind = previewKind(mime, name);
  if (kind === 'image') return '图片';
  if (kind === 'video') return '视频';
  if (kind === 'audio') return '音频';
  if (kind === 'pdf') return 'PDF';
  if (kind === 'text') return '文本';
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'xz'].includes(ext)) return '压缩包';
  return '文件';
}

/** 访客那边显示的名字。seeder 视角下 sending 是"我在发"，访客那头是在收。 */
function visitorPhaseText(phase: string): string {
  if (phase === 'connecting') return '连接中';
  if (phase === 'sending') return '传输中';
  if (phase === 'done') return '已取件';
  if (phase === 'left') return '已离开';
  if (phase === 'failed') return '失败';
  return phase;
}

/** 能不能在页面里直接看，能看的话用哪种元素 */
function previewKind(
  mime: string,
  name?: string,
): 'image' | 'video' | 'audio' | 'pdf' | 'text' | null {
  const m = (mime || '').toLowerCase();
  const ext = (name ?? '').split('.').pop()?.toLowerCase() ?? '';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) {
    return 'image';
  }
  if (m.startsWith('video/') || ['mp4', 'mov', 'm4v', 'webm', 'ogv'].includes(ext)) return 'video';
  if (m.startsWith('audio/') || ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac'].includes(ext)) {
    return 'audio';
  }
  if (m === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (m.startsWith('text/') || ['txt', 'md', 'json', 'csv', 'log', 'xml', 'yml', 'yaml'].includes(ext)) {
    return 'text';
  }
  return null;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-4)}` : id;
}

/** 退避时间给人看：不到一秒说「不到 1 秒」，别把 930 毫秒这种精度端给用户 */
function formatWait(ms: number): string {
  return ms < 1000 ? '不到 1 秒' : `${(ms / 1000).toFixed(1)} 秒`;
}

export default function App() {
  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [deviceName, setDeviceName] = useState(
    () => localStorage.getItem('deviceName') || defaultName(),
  );
  const [signalState, setSignalState] = useState<SignalState>('closed');
  /** 连不上服务从哪一刻开始。状态条靠它升级：先细条，超过 15 秒才补小卡片。 */
  const [signalDownSince, setSignalDownSince] = useState(0);
  /** 灯塔重连的实时进度。掉线遮罩靠它把"正在重连"变成看得见的倒计时和次数。 */
  const [reconnect, setReconnect] = useState<ReconnectInfo | null>(null);
  /** 设备本身有没有网。和"灯塔连不上"是两件事，要分开告诉用户。 */
  const [online, setOnline] = useState(true);
  /** 只有掉线遮罩显示期间才需要这个心跳，用来驱动倒计时。 */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [contacts, setContacts] = useState<ContactRecord[]>([]);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);
  const [prompt, setPrompt] = useState<PairingPrompt | null>(null);
  /** 用户主动点了"添加新设备"，这时即使已经有配对记录也要显示配对页 */
  /** 每个对端各自的连接状态。多设备并发时不能再只有一份。 */
  const [states, setStates] = useState<Record<string, SessionState>>({});
  /** 连接走到哪一步了，界面靠它显示进度 */
  const [phase, setPhase] = useState<ConnectPhase | null>(null);
  const [activePeer, setActivePeer] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [logs, setLogs] = useState<string[]>([]);
  const [pairCode, setPairCode] = useState('');
  const [codeIssuedAt, setCodeIssuedAt] = useState(0);
  /** 配对已确认、连接还没就绪。盖一层加载，别把人丢回扫码/输码页。 */
  const [pairingConnecting, setPairingConnecting] = useState<{ peerId: string; name: string } | null>(null);
  const [qr, setQr] = useState('');
  const [joinText, setJoinText] = useState('');
  /** 输码/查码失败时的就地提示，不再只写进日志。 */
  const [pairError, setPairError] = useState('');
  /** 灯塔说「暂时别再试」的截止时间。到点之前输入框锁住。 */
  const [cooldownUntil, setCooldownUntil] = useState(0);
  /**
   * 分步走，一屏只说一件事。
   *
   *   scene   先问是面对面还是隔着远
   *   nearby  面对面这一支：报码、输码、扫码
   *   remote  远距离这一支：生成一条链接，或者打开别人的链接
   *   test    配对成功之后先握个手，确认灯塔和对方都通
   *   live    真正在传的界面
   */
  const [step, setStep] = useState<'scene' | 'nearby' | 'remote' | 'test' | 'live'>('scene');
  const [scene, setScene] = useState<'nearby' | 'remote' | null>(null);
  /** 连通测试的结果。running 是正在问，ok 带上往返毫秒。 */
  const [probe, setProbe] = useState<{ status: 'idle' | 'running' | 'ok' | 'fail'; rtt?: number; note?: string }>({
    status: 'idle',
  });
  /** "再试一次"用它把 effect 顶一下 */
  const [probeNonce, setProbeNonce] = useState(0);
  /** 扫码认不出来时的提示。认出来就直接去连了，不留在界面上。 */
  const [scanError, setScanError] = useState('');
  const [scanOpen, setScanOpen] = useState(false);
  /** 首页"分享"：菜单、复制成功的提示、二维码弹窗 */
  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [shareQrImage, setShareQrImage] = useState('');
  /** 声音配对：播、听、以及"没听到"的提示。 */
  const [broadcasting, setBroadcasting] = useState(false);
  const [listening, setListening] = useState(false);
  const [soundError, setSoundError] = useState('');
  /** 麦克风权限拿不到。跟别的错误分开，因为它可以点一下重新申请。 */
  const [micBlocked, setMicBlocked] = useState(false);
  const listeningRef = useRef<{ stop(): void } | null>(null);
  /** 手动输入那一块默认收起来，点了才展开。 */
  const [manualOpen, setManualOpen] = useState(false);
  /** 手动配对分两屏：给人看我的码，或去扫/输对方的码。两屏都不掺对方那一半。 */
  const [manualMode, setManualMode] = useState<'show' | 'join'>('show');
  /** 进面对面之前先问一句：开不开麦克风。 */
  const [micGate, setMicGate] = useState<'ask' | 'granted' | 'declined'>('ask');
  /** 匹配久了对用户说句话，别让他干等。 */
  const [slowMatch, setSlowMatch] = useState(false);
  /** 摩尔斯音效开关。默认开，关掉之后这一整段都安静。 */
  const [morseOn, setMorseOn] = useState(() => {
    try {
      return localStorage.getItem('morse') !== 'off';
    } catch {
      return true;
    }
  });
  const [audioProbe, setAudioProbe] = useState<'ok' | 'quiet' | 'unknown' | null>(null);
  /** 播的时候自己听一下的结果 */
  const [selfCheck, setSelfCheck] = useState<'ok' | 'quiet' | 'unknown' | null>(null);
  const [headphones, setHeadphones] = useState(false);
  /** 主题：跟着系统，或者用户手动指定。默认跟着系统。 */
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
  );
  /** 打开这一页时是什么主题。回到它的时候用"收回"动画，其余用"扩散"。 */
  const initialThemeRef = useRef<'light' | 'dark'>('light');
  /** 转场进行中，别叠加第二个 */
  const vtBusyRef = useRef(false);
  const themeBtnRef = useRef<HTMLButtonElement | null>(null);
  /** 正在传的文件 id。传输期间通道被占满，心跳要避让，不然会误判成掉线。 */
  const activeTransferRef = useRef<Set<string>>(new Set());
  /** 有没有传输在跑。ref 不触发重渲染，标题栏那条另存一个状态 */
  const [transferring, setTransferring] = useState(false);
  /** 链路看着还连着、其实已经不通了。手机熄屏再亮屏最容易出现这一种。 */
  const [linkDead, setLinkDead] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  /** 心跳暂时没通，但还在忍：WebRTC 常常能自己恢复，不用惊动灯塔 */
  const [recovering, setRecovering] = useState(false);
  /** 二次核对那一步，对方一直没响应 */
  const [promptTimeout, setPromptTimeout] = useState(false);
  /** 每次重试加一，用来重新起计时 */
  const [codeRetry, setCodeRetry] = useState(0);
  /** 每加一次就让"听"重新开始，用来从失败里恢复。 */
  const [listenNonce, setListenNonce] = useState(0);
  const selfCheckRef = useRef<(() => void) | null>(null);
  const [probing, setProbing] = useState(false);
  const canSound = typeof window !== 'undefined' && soundSupported();
  const [tick, setTick] = useState(0);
  const [text, setText] = useState('');
  /** 发文件和发文字不同时占界面，切成两页。 */
  const [composeTab, setComposeTab] = useState<'file' | 'text'>('file');
  const [dragging, setDragging] = useState(false);
  /** 点「粘贴」但浏览器不给文件时，就地说明原因，别只写进日志 */
  const [pasteHint, setPasteHint] = useState('');
  const [busy, setBusy] = useState(false);
  const [pathText, setPathText] = useState('');
  const [managerReady, setManagerReady] = useState(false);
  /** 能打开的文件：传输 id → 产物。发送方向放原文件，接收方向由落盘交出。 */
  const artifactsRef = useRef(new Map<string, ReceivedArtifact>());
  const [, setArtifactsVersion] = useState(0);
  /** 预览里点开"详细查看"：图片按长边填满容器，另一边可滚动 */
  const [detailView, setDetailView] = useState(false);
  const [detailStyle, setDetailStyle] = useState<{ [k: string]: string }>({});
  const [preview, setPreview] = useState<{
    url: string;
    kind: string;
    name: string;
    direction: 'in' | 'out';
    text?: string;
  } | null>(null);
  const [chunkSize, setChunkSize] = useState(0);
  /** 我挂出去的公开链接，一条一个文件 */
  const [outgoing, setOutgoing] = useState<OutgoingShare[]>([]);
  /** 我作为访客取件时看到的状态，null 表示这条链接没在访问 */
  const [visit, setVisit] = useState<VisitState | null>(null);
  /** 发一条分享要选文件，和"发给某台设备"用的是两个入口，互不干扰 */
  const shareInputRef = useRef<HTMLInputElement | null>(null);

  const managerRef = useRef<SessionManager | null>(null);
  /** 手动重连按钮要直接指挥这条信令链路 */
  const signalLinkRef = useRef<WebSocketSignalLink | null>(null);
  const hubRef = useRef<ShareHub | null>(null);
  const sinkRef = useRef<BrowserSink | null>(null);
  const timelineRef = useRef<Timeline | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textIdsRef = useRef(new Set<string>());
  const peerNameRef = useRef('对端');
  const speedRef = useRef(new Map<string, { at: number; bytes: number }>());
  // 分享时要带上设备名，而这个名字用户可以随时改，所以取的时候再读
  const deviceNameRef = useRef(deviceName);

  const log = useCallback((line: string) => {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    setLogs((prev) => [...prev.slice(-200), `[${t}] ${line}`]);
  }, []);

  /* ---------------------------------------------------------- 时间线 */

  const applyUpdate = useCallback(async (u: TransferUpdate) => {
    const tl = timelineRef.current;
    if (!tl || !u.id) return;
    const list = await tl.list();
    const found = list.find((e) => e.id === u.id);
    if (textIdsRef.current.has(u.id)) {
      // 文字的送达状态也走这条更新：pending -> done / error
      if (found) {
        await tl.update(u.id, { ...found, status: u.status, note: u.message ?? found.note });
        setEntries(await tl.list());
      }
      return;
    }
    const next: TimelineEntry = {
      id: u.id,
      at: found?.at ?? Date.now(),
      direction: u.direction,
      kind: 'file',
      peerId: found?.peerId ?? '',
      peerName: found?.peerName ?? peerNameRef.current,
      name: u.meta?.name ?? found?.name,
      size: u.meta?.size ?? found?.size,
      mime: u.meta?.mime ?? found?.mime,
      status: u.status,
      note: u.message ?? found?.note,
    };
    if (found) await tl.update(u.id, next);
    else await tl.add(next);
    setEntries(await tl.list());
  }, []);

  const addTextEntry = useCallback(
    async (
      id: string,
      direction: 'in' | 'out',
      body: string,
      status: 'pending' | 'done' | 'error' = 'done',
      note?: string,
    ) => {
      const tl = timelineRef.current;
      if (!tl) return;
      textIdsRef.current.add(id);
      // 发送端可能已经被传输状态先写成了一条"文件"记录，这里把它顶掉
      await tl.remove(id);
      await tl.add({
        id,
        at: Date.now(),
        direction,
        kind: 'text',
        peerId: '',
        peerName: peerNameRef.current,
        text: body,
        status,
        note,
      });
      setEntries(await tl.list());
    },
    [],
  );

  /* ---------------------------------------------------------- 初始化 */

  useEffect(() => {
    let cancelled = false;
    let leaving: ((e: PageTransitionEvent) => void) | null = null;
    // 网页端一切都在内存里：刷新就消失，不刷新就一直在。
    // 身份、配对关系、传输时间线都不落盘，见 docs/20。
    const store = new MemoryStore();

    void (async () => {
      const id = await createIdentity();
      if (cancelled) return;
      setIdentity(id);

      const tl = new Timeline(store);
      timelineRef.current = tl;
      setEntries(await tl.list());

      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url =
        `${proto}//${location.host}/ws/presence` +
        `?deviceId=${encodeURIComponent(id.deviceId)}&name=${encodeURIComponent(deviceName)}`;

      const sink = new BrowserSink();
      sinkRef.current = sink;

      // 信令链路上任何处理失败都要看得见。会话里 messageHandler 是 async 的，
      // 抛出来的异常不接住就是静默的未处理 rejection——信令被吞掉，界面上毫无
      // 痕迹，这正是排查那个"offer 没到"时最难受的地方。
      const signalLink = new WebSocketSignalLink(url);
      signalLinkRef.current = signalLink;
      signalLink.onError((text) => log(`⚠ ${text}`));
      // 重连进度一边进遮罩、一边进日志：用户看遮罩，回头排查看日志。
      // 这两处以前都是空的，掉线之后就只剩一句"正在重连"，
      // 到底有没有在试、试了几次、还要等多久，全都看不见。
      signalLink.onReconnect((info) => {
        setReconnect(info);
        if (info.phase === 'trying') {
          log(`正在第 ${info.attempt} 次重连灯塔…`);
        } else {
          log(`灯塔断开，第 ${info.attempt} 次重连在 ${formatWait(info.delayMs)}后开始`);
        }
      });

      const manager = new SessionManager(
        {
          identity: id,
          deviceName,
          signal: signalLink,
          transport: new WebRtcTransport(),
          sink,
          store,
          transfer: {
            onStatus: (u) => {
              if (u.status === 'active') activeTransferRef.current.add(u.id);
              else activeTransferRef.current.delete(u.id);
              setTransferring(activeTransferRef.current.size > 0);
              void applyUpdate(u);
              // 分享那边要靠这条更新确认这一条链接空出来了
              hubRef.current?.onTransferStatus(u);
            },
            onProgress: (tid, dir, transferred, size) => {
              hubRef.current?.onProgress(dir, transferred, size);
              setProgress((p) => ({ ...p, [tid]: size > 0 ? transferred / size : 1 }));
              const now = Date.now();
              const prev = speedRef.current.get(tid);
              if (prev && now - prev.at >= 1000) {
                const rate = ((transferred - prev.bytes) / (now - prev.at)) * 1000;
                if (rate > 0) {
                  log(
                    `${dir === 'out' ? '发送' : '接收'} ${formatBytes(transferred)} / ${formatBytes(size)}` +
                      `，约 ${formatBytes(rate)}/s`,
                  );
                }
                speedRef.current.set(tid, { at: now, bytes: transferred });
              } else if (!prev) {
                speedRef.current.set(tid, { at: now, bytes: transferred });
              }
              if (size > 0 && transferred >= size) speedRef.current.delete(tid);
            },
            onText: (tid, body) => void addTextEntry(tid, 'in', body),
            onArtifact: (tid, art) => {
              artifactsRef.current.set(tid, art);
              setArtifactsVersion((v) => v + 1);
            },
          },
        },
        {
          log,
          contacts: (list) => {
            setContacts(list);
            setSelected((cur) => (cur && list.some((c) => c.peerId === cur) ? cur : (list[0]?.peerId ?? null)));
          },
          presence: setPresence,
          pairingPrompt: (p) => {
            setPrompt(p);
            peerNameRef.current = p.name;
            log(`收到配对请求：${p.name}，六位数字 ${p.sas}，请和对方屏幕核对`);
          },
          pairingDone: (peerId) => {
            setPrompt(null);
            // 配对确认后先盖一层"正在建立连接"，别让页面回落到扫码/输码页。
            // 遮罩在 ready 或 failed 时收起，见下面的 effect 和 state 回调。
            setPairingConnecting({
              peerId,
              name: peerNameRef.current || '对方',
            });
            // 不在这里清码：清空会让配对页在切走之前闪一下空白。
            // 页面一换，这块自然就没了。
            // 刚配好的这台多半就是要发的那台，直接选中，省一次点击
            setSelected(peerId);
            log(`和 ${peerId} 配对完成，以后不用再配`);
          },
          code: (code) => {
            setPairCode(code);
            setCodeIssuedAt(Date.now());
          },
          // 灯塔收回码的时候也别立刻清：留一点时间，避免界面闪一下空白
          codeCleared: () => window.setTimeout(() => setPairCode(''), 800),
          codeCooldown: (until) => setCooldownUntil(until),
          state: (state, peerId) => {
            if (peerId) setStates((m) => ({ ...m, [peerId]: state }));
            // 配对失败、对方刷新、或者链路没建起来：把界面收拾干净，
            // 回到"正在识别声波"，而不是停在一个连不上的状态
            if (state === 'failed' || state === 'idle') {
              setBusy(false);
              setJoinText('');
              setListenNonce((n) => n + 1);
            }
            // idle 是 connect 重置会话的正常一步，不能拿它收起连接遮罩，
            // 否则遮罩刚出现就被紧跟着的 connecting 事件之前的 idle 关掉了。
            if (state === 'failed') setPairingConnecting(null);
            setActivePeer(peerId);
            if (state === 'idle') {
              setPathText('');
              setChunkSize(0);
              setPhase(null);
            }
          },
          signal: setSignalState,
          phase: (_peerId, next) => setPhase(next),
          link: (peerId, link: PeerLink) => {
            setChunkSize(manager.chunkSizeOf(peerId));
            log(
              `通道就绪，分片 ${manager.chunkSizeOf(peerId)} 字节` +
                `（传输层上限 ${link.maxChunkSize()}）`,
            );
            void link.path().then((p) => {
              // 界面上只写人话，候选类型这种事留给日志
              setPathText(describePath(p.kind));
              log(`路径候选：本地 ${p.localType || '未知'} / 对端 ${p.remoteType || '未知'}`);
            });
          },
          // 资格、名额这些判断都在 ShareHub 里，会话层只负责把信令送到
          shareSignal: (msg) => void hubRef.current?.onSignal(msg),
          error: (message) => {
            log(`⚠ ${message}`);
            setPairError(
              message.includes('这个配对码没找到')
                ? `${message.replace(/^这个配对码没找到：/, '')}。让对方确认当前屏幕上的码，或点「换一个」后再试。`
                : message,
            );
          },
        },
      );
      managerRef.current = manager;
      const registry = new FetchRegistry();
      hubRef.current = new ShareHub(
        {
          identity: id,
          registry,
          manager,
          deviceName: () => deviceNameRef.current,
          origin: location.origin,
        },
        { log, shares: setOutgoing, visit: setVisit },
      );
      await manager.start();
      // 会话就绪本身也要当成依赖：下面那个"什么时候报码"的 effect
      // 依赖 contacts.length，而它从 0 到 0 是不变的，只靠它的话
      // effect 会在 manager 还没建好时跑一次就再也不跑，码永远不出现。
      setManagerReady(true);

      if (!id.canSign) {
        log('⚠ 当前页面不是安全上下文，crypto.subtle 不可用，配对认证无法进行。请走 HTTPS。');
      }

      // 页面真的要走的时候，把还挂着的链接撤掉。
      //
      // 这一步不是可选的整洁工作：身份只活在内存里，一刷新就换成另一台设备，
      // 注册表那一行绑的是旧设备号，新页面没有凭据去撤它。不撤的话，那条链接
      // 会在灯塔里挂着"对方暂时离线"整整二十四小时，而分享者以为关掉页面就没了。
      //
      // 进 bfcache 的情况除外：那种页面会带着原来的身份和文件句柄回来，
      // 链接其实还能服务，撤了反而是误伤。
      const hub = hubRef.current;
      if (hub) {
        leaving = (e) => {
          if (e.persisted) return;
          registry.revokeNow(hub.revokeAllForUnload(), id.deviceId);
        };
        window.addEventListener('pagehide', leaving);
      }

      // 链接里带了配对码就直接连。界面落在"我来和对方配对"这一屏，
      // 不和自己的码混在一起；声波这条路不参与链接配对。
      const fromLink = codeFromHash(location.hash);
      if (fromLink) {
        setStep('nearby');
        setManualOpen(true);
        setManualMode('join');
        setMicGate('declined');
        log(`链接里带了配对码 ${fromLink}，正在连`);
        try {
          await manager.joinWithCode(fromLink);
        } catch (err) {
          log(`⚠ 连接失败：${err instanceof Error ? err.message : String(err)}`);
        }
      }

      // 公开链接带的是 #s=，形状和配对链接一样但走的是另一套准入
      const shareToken = hub ? parseShareToken(location.hash) : null;
      if (shareToken && hub) {
        setStep('remote');
        log(`这是一条分享链接，正在找对方`);
        await hub.visit(shareToken);
      }
    })();

    return () => {
      cancelled = true;
      if (leaving) window.removeEventListener('pagehide', leaving);
      // 访客页可能正排着一次离线重查，页面拆掉就一起停掉
      hubRef.current?.dispose();
      managerRef.current?.close();
      managerRef.current = null;
      signalLinkRef.current = null;
      hubRef.current = null;
    };
    // 初始化只跑一次：deviceName 后续通过 setDeviceName 同步，不靠重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 掉线期间的心跳：倒计时要一格格走，用户才看得出"它在动"。
   * 只在遮罩显示时跑，连着的时候不额外占一个定时器。
   */
  useEffect(() => {
    if (signalState === 'open') return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [signalState]);

  /** 连上就清掉起点；下一次断线从零开始计时，状态条才会重新从小条起步。 */
  useEffect(() => {
    if (signalState === 'open') {
      setSignalDownSince(0);
      return;
    }
    setSignalDownSince((prev) => (prev === 0 ? Date.now() : prev));
  }, [signalState]);

  /** 设备自己的网络状态。它和"灯塔连不上"是两件事，混在一起说用户只能干等。 */
  useEffect(() => () => listeningRef.current?.stop(), []);

  useEffect(() => {
    const sync = (): void => setOnline(navigator.onLine !== false);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  /** 手动重连：退避还没走完也立刻试，不用等倒计时 */
  const retryNow = useCallback(() => {
    signalLinkRef.current?.reconnectNow('manual');
    log('手动重连灯塔');
  }, [log]);

  /**
   * 重新要一条配对码。
   *
   * 必须先确保当前处于报码状态：refreshCode 在 advertising 为 false 时
   * 是空操作，这就是以前"立即重试"点了没反应的原因。
   */
  const retryCode = useCallback(() => {
    setCodeRetry(0);
    const manager = managerRef.current;
    if (!manager) return;
    manager.startAdvertising();
    manager.refreshCode();
    log('重新向灯塔要配对码');
  }, [log]);

  /**
   * 什么时候对外报码。
   *
   * 以前按"有没有配对记录"判断：配过一台之后，再进配对页永远不会要新码，
   * 界面就一直停在"正在向灯塔要配对码"，点重试也没用（refreshCode 在
   * advertising 为 false 时直接返回）。现在跟着配对页走：进来就报，离开就停。
   */
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !managerReady) return;
    // 正在取件的这一页不该对外报配对码：它连的是别人的分享，不是来配对的人
    if (visit && visit.phase !== 'idle') {
      manager.stopAdvertising();
      return;
    }
    if (step === 'nearby') manager.startAdvertising();
    else manager.stopAdvertising();
  }, [managerReady, step, visit]);

  /**
   * 进"面对面"这一步的时候，先把已经连着的那几台记下来。
   *
   * 不然会出这个错：加第二台设备时点"添加新设备"，人还没开始对码，界面就被
   * 已有的那条连接自动顶到握手页去了。只有"这一步里新连上的"才该往前走。
   */
  const readyAtEntryRef = useRef<Set<string>>(new Set());

  /** 声波配对暂时下架：进来直接手动配对。要做"更无感"的版本时把它改回 true。 */
  const SOUND_PAIRING_ENABLED = false;

  const enterNearby = useCallback(
    (gate: 'granted' | 'declined') => {
      readyAtEntryRef.current = new Set(
        contacts.filter((c) => states[c.peerId] === 'ready').map((c) => c.peerId),
      );
      setCodeRetry(0);
      // 声波下线期间直接进手动配对；重新上线时按 gate 决定要不要麦克风
      setManualOpen(!SOUND_PAIRING_ENABLED || gate === 'declined');
      // 面对面进来先让对方扫：二维码和码都在这一屏，另一条路放在按钮后面
      setManualMode('show');
      if (!SOUND_PAIRING_ENABLED) setMicGate('declined');
      setStep('nearby');
    },
    [contacts, states],
  );

  /** 一配上就往前走一步：匹配完的下一件事是握手，不是让用户自己找。 */
  useEffect(() => {
    if (step !== 'nearby') return;
    const ready = contacts.find(
      (c) => states[c.peerId] === 'ready' && !readyAtEntryRef.current.has(c.peerId),
    );
    if (!ready) return;
    setSelected(ready.peerId);
    setProbe({ status: 'idle' });
    setStep('live');
    setPairingConnecting(null);
  }, [step, contacts, states]);

  /* ---------------------------------------------------------- 配对 */

  /** 够长的数字之外的东西不接受，界面上直接给提示 */
  const typedCode = normalizeCode(joinText);

  /**
   * 拿一条码去连。
   *
   * 同一条码正在连的时候直接忽略：输入框输满会自动连，用户再点一下"连接"
   * 不能变成第二次请求。报同一个码两次，灯塔那边会当成两个人来抢。
   */
  const joiningRef = useRef('');

  const join = useCallback(
    async (raw?: string, opts: { fingerprint?: string } = {}) => {
      const manager = managerRef.current;
      const value = normalizeCode(raw ?? joinText);
      if (!manager) return;
      if (!value) {
        log(`配对码是 ${CODE_DIGITS} 位数字，也可以直接粘整条链接`);
        return;
      }
      if (joiningRef.current === value) return;
      if (cooldownUntil > Date.now()) {
        log(`还在冷却，${Math.ceil((cooldownUntil - Date.now()) / 1000)} 秒后再试`);
        return;
      }
      joiningRef.current = value;
      setPairError('');
      setBusy(true);
      try {
        await manager.joinWithCode(value, opts);
      } catch (err) {
        log(`⚠ 连接失败：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        joiningRef.current = '';
        setBusy(false);
      }
    },
    [cooldownUntil, joinText, log],
  );

  /**
   * 声音是自动的：进来就听，点一下就播，播就一直播。
   *
   * 播和听不能同时做（自己的喇叭会把自己的麦克风灌满），所以播的时候
   * 监听循环会让开，停下之后再接着听。
   */
  const pairCodeRef = useRef('');
  useEffect(() => {
    pairCodeRef.current = pairCode;
  }, [pairCode]);

  const joinRef = useRef(join);
  useEffect(() => {
    joinRef.current = join;
  }, [join]);

  const broadcastRef = useRef(false);
  const sleep = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

  const startBroadcast = useCallback(async () => {
    if (broadcastRef.current) return;
    broadcastRef.current = true;
    setBroadcasting(true);
    setSoundError('');
    listeningRef.current?.stop();
    // 一边播，一边用麦克风听自己。听不到就说明对面多半也听不到。
    selfCheckRef.current?.();
    setSelfCheck(null);
    selfCheckRef.current = startSelfCheck(setSelfCheck);
    const manager = managerRef.current;
    manager?.setAutoAccept(true);
    const tag = await manager?.audioTag();
    let emptyRounds = 0;
    while (broadcastRef.current) {
      const code = pairCodeRef.current;
      if (!code) {
        emptyRounds += 1;
        if (emptyRounds > 10) {
          setSoundError('服务那边一直没给码，稍后再试，或者刷新这一页。');
          break;
        }
        await sleep(300);
        continue;
      }
      emptyRounds = 0;
      try {
        await playCode(code, tag);
      } catch (err) {
        setSoundError(
          `放不出声（${err instanceof Error ? err.message : String(err)}）。让对方手动输也行。`,
        );
        break;
      }
      await sleep(250);
    }
    broadcastRef.current = false;
    setBroadcasting(false);
    managerRef.current?.setAutoAccept(false);
  }, []);

  const stopBroadcast = useCallback(() => {
    broadcastRef.current = false;
    stopPlayback();
    selfCheckRef.current?.();
    selfCheckRef.current = null;
    setBroadcasting(false);
    managerRef.current?.setAutoAccept(false);
  }, []);

  /** 一直听，听到就停。听不到也不打扰用户，循环接着听。 */
  const autoListenRef = useRef(false);
  const listenLoop = useCallback(async () => {
    if (autoListenRef.current) return;
    autoListenRef.current = true;
    while (autoListenRef.current) {
      if (broadcastRef.current) {
        await sleep(400);
        continue;
      }
      setListening(true);
      try {
        const session = await listenForCode({ ms: 8000 });
        listeningRef.current = session;
        const heard = await session.done;
        listeningRef.current = null;
        setListening(false);
        if (heard) {
          const [code, fingerprint] = heard.split(':');
          log(`听到 ${heard}`);
          void joinRef.current(code ?? heard, fingerprint ? { fingerprint } : {});
          break;
        }
      } catch {
        setMicBlocked(true);
        setListening(false);
        break;
      }
    }
    autoListenRef.current = false;
  }, [log]);


  /**
   * 猜一下是不是插着耳机。
   *
   * 浏览器没有"你在用耳机吗"这种接口，只能看设备名字里有没有耳机、耳麦、
   * AirPods 这类词。名字可能读不到、也可能不准，所以这只是句提示。
   */
  useEffect(() => {
    if (step !== 'nearby' || micGate !== 'granted') return undefined;
    let cancelled = false;
    void navigator.mediaDevices
      ?.enumerateDevices?.()
      .then((devices) => {
        if (cancelled) return;
        const mine = devices.some(
          (d) =>
            d.kind === 'audiooutput' &&
            /耳机|耳麦|耳塞|headphone|headset|earphone|airpods|bluetooth/i.test(d.label),
        );
        setHeadphones(mine);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [step, micGate]);

  /**
   * 摩尔斯跟着"发出声波"走：点了才开始，停了就停。
   * 它和超声那一串同时开始，两段频段隔得很远，互不干扰。
   */
  useEffect(() => {
    if (!broadcasting) return undefined;
    const stop = startMorseLoop();
    return () => stop();
  }, [broadcasting]);

  // 进到"面对面"这一步就开始听；离开这一步就把麦克风和播放都收掉
  useEffect(() => {
    // 手输和声音是两种方式，开了手输就不再听，麦克风也放掉
    if (step !== 'nearby' || !canSound || micGate !== 'granted' || manualOpen) return undefined;
    setSoundError('');
    void listenLoop();
    return () => {
      autoListenRef.current = false;
      broadcastRef.current = false;
      managerRef.current?.setAutoAccept(false);
      listeningRef.current?.stop();
      listeningRef.current = null;
      setListening(false);
      setBroadcasting(false);
    };
  }, [step, canSound, micGate, manualOpen, listenNonce, listenLoop]);

  const showQr = useCallback(async () => {
    if (!pairCode) return;
    try {
      setQr(
        await QRCode.toDataURL(pairingLink(location.origin, pairCode), {
          margin: 2,
          // 320 是手机屏上"隔三十厘米还能扫到"的下限附近，再小就得凑近
          width: 320,
        }),
      );
    } catch (err) {
      log(`⚠ 生成二维码失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }, [log, pairCode]);

  // 二维码跟着码一起换，不然扫到的还是旧码。展示这一屏一出现就得生成，
  // 不能等用户点什么；从别的屏切回来也一样。
  useEffect(() => {
    if (step !== 'nearby' || !manualOpen || manualMode !== 'show') return;
    void showQr();
  }, [pairCode, step, manualOpen, manualMode, showQr]);

  // 倒计时用的心跳
  useEffect(() => {
    if (!pairCode) return;
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [pairCode]);

  const confirm = useCallback(
    async (accept: boolean) => {
      await managerRef.current?.confirmPairing(accept);
      setPrompt(null);
    },
    [],
  );

  /* ---------------------------------------------------------- 发送 */

  const target = selected ?? contacts[0]?.peerId ?? null;
  const targetContact = target ? contacts.find((c) => c.peerId === target) : undefined;
  const targetPlatform = targetContact?.peerPlatform;
  const targetOnline = target ? presence.some((p) => p.id === target && p.online) : false;

  /**
   * 连通测试：进到 test 这一步就问对方一句，量一次往返。
   *
   * 灯塔连没连上看 signalState，对方通不通用这条 ping。两件事分开看，
   * 因为"灯塔通、对方不通"是真实会发生的一种状态（打洞失败、对端刚断），
   * 混成一句"网络有问题"用户没法判断该重试还是该退回。
   */
  useEffect(() => {
    if (step !== 'live') return undefined;
    const manager = managerRef.current;
    if (!manager || !target) {
      setProbe({ status: 'fail', note: '还没挑出要连的那台设备' });
      return undefined;
    }
    let cancelled = false;
    setProbe({ status: 'running' });
    manager
      .ping(target, 4000)
      .then((rtt) => {
        if (!cancelled) setProbe({ status: 'ok', rtt });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProbe({ status: 'fail', note: err instanceof Error ? err.message : String(err) });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [step, target, probeNonce]);

  const sentFilesRef = useRef(new Map<string, File>());

  const sendFiles = useCallback(
    (files: File[]) => {
      const manager = managerRef.current;
      const peer = target;
      if (!manager || !peer) {
        log('还没有配对的设备，先扫码配一次');
        return;
      }
      const contact = contacts.find((c) => c.peerId === peer);
      peerNameRef.current = contact?.peerName ?? '对端';
      for (const f of files) {
        // 留一份，失败了可以重发
        sentFilesRef.current.set(`${f.name}:${f.size}`, f);
        void manager
          .sendFile(peer, toFileLike(f))
          .then((tid) => {
            // 发送方手里本来就有原文件，直接留着，自己传的东西自己也能点开看
            artifactsRef.current.set(tid, {
              name: f.name,
              mime: f.type,
              size: f.size,
              open: async () => f,
            });
            setArtifactsVersion((v) => v + 1);
          })
          .catch((err: unknown) =>
            log(`⚠ 发送失败：${err instanceof Error ? err.message : String(err)}`),
          );
      }
      log(`已加入发送队列：${files.map((f) => f.name).join('、')}`);
    },
    [contacts, log, target],
  );

  const sendTextBody = useCallback(
    async (raw: string) => {
      const manager = managerRef.current;
      const body = raw.trim();
      if (!manager || !target || !body) return false;
      try {
        const id = await manager.sendText(target, body);
        void addTextEntry(id, 'out', body, 'pending');
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log(`⚠ 发送失败：${message}`);
        // 失败也要在时间线留一条，用户才能点重试
        void addTextEntry(`failed-${Date.now().toString(36)}`, 'out', body, 'error', message);
        return false;
      }
    },
    [addTextEntry, log, target],
  );

  const sendText = useCallback(async () => {
    if (await sendTextBody(text)) setText('');
  }, [sendTextBody, text]);

  /** 输入框为空时，这个按钮直接把剪贴板文字发出去，省掉"点输入框再粘贴"。 */
  const pasteTextAndSend = useCallback(async () => {
    if (!target) return;
    if (text.trim()) {
      await sendText();
      return;
    }
    if (!navigator.clipboard?.readText) {
      log('这个浏览器不支持按钮读取剪贴板，请在输入框里按 Ctrl / ⌘ + V。');
      return;
    }
    try {
      const clip = await navigator.clipboard.readText();
      if (!clip.trim()) {
        log('剪贴板里没有文字');
        return;
      }
      if (await sendTextBody(clip)) setText('');
    } catch {
      log('读不到剪贴板：浏览器没给权限，可以点一下页面再按 Ctrl / ⌘ + V。');
    }
  }, [log, sendText, sendTextBody, target, text]);

  /* ---------------------------------------------------------- 公开链接 */

  /** 选中文件就挂一条分享。多个文件就是多条链接，一条链接只对应一个文件 */
  const publishFiles = useCallback(
    async (files: File[]) => {
      const hub = hubRef.current;
      if (!hub || !files.length) return;
      setBusy(true);
      try {
        for (const f of files) {
          const share = await hub.createShare(toFileLike(f));
          log(`链接已生成：${share.name}，把它发出去谁都能取`);
        }
      } catch (err) {
        log(`⚠ 挂不出链接：${err instanceof Error ? err.message : String(err)}`);
      } finally {
        setBusy(false);
      }
    },
    [log],
  );

  const revokeShare = useCallback(async (token: string) => {
    await hubRef.current?.revoke(token);
  }, []);

  const copyShareLink = useCallback(
    async (link: string) => {
      try {
        await navigator.clipboard.writeText(link);
        log('链接已复制');
      } catch {
        log('复制失败：浏览器没有给剪贴板权限，手动选上面的地址也一样');
      }
    },
    [log],
  );

  const copyShareCode = useCallback(
    async (token: string) => {
      try {
        await navigator.clipboard.writeText(shareCode(token));
        log('分享编号已复制');
      } catch {
        log('复制失败：浏览器没有给剪贴板权限，手动选中编号也一样');
      }
    },
    [log],
  );

  /* ---------------------------------------------------------- 粘贴与拖拽 */

  const receiveClipboardFiles = useCallback(
    (files: File[]) => {
      const named = files.map((f, i) =>
        f.name
          ? f
          : new File([f], synthesizeClipboardName(f.type, new Date(), i + 1), { type: f.type }),
      );
      const images = named.filter((f) => f.type.startsWith('image/'));
      if (images.length) {
        log(`从剪贴板收到 ${images.length} 张图：${images.map((f) => f.name).join('、')}`);
      }
      sendFiles(named);
    },
    [log, sendFiles],
  );

  useEffect(() => {
    const onPaste = (ev: ClipboardEvent) => {
      if (isEditableTarget(ev.target)) return; // 输入框里的粘贴留给浏览器
      const dt = ev.clipboardData;
      if (!dt) return;
      const picked: File[] = [];
      // items 比 files 可靠：部分浏览器里粘贴图片时 clipboardData.files 是空的
      for (const item of Array.from(dt.items)) {
        if (item.kind !== 'file') continue;
        const f = item.getAsFile();
        if (f) picked.push(f);
      }
      if (!picked.length) return; // 纯文本保持浏览器默认行为
      ev.preventDefault();
      receiveClipboardFiles(picked);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [receiveClipboardFiles]);

  /**
   * 点「粘贴」按钮。
   *
   * 浏览器只允许按钮读取剪贴板里"声明了类型"的内容：截图可以，文字可以，
   * 但从 Windows 资源管理器复制的文件，Edge 给出的 ClipboardItem.types 是空的，
   * 页面根本看不到那些文件。这不是权限弹窗的问题，申请也拿不到；只有页面上的
   * Ctrl/⌘+V 粘贴事件里，clipboardData.items 才会把文件交出来。
   *
   * 所以这里能读什么就读什么，读不到时把原因直接说清楚，并指到 Ctrl+V。
   */
  const pasteFromClipboard = useCallback(async () => {
    setPasteHint('');
    if (!navigator.clipboard?.read) {
      const text = '这个浏览器不支持按钮读取剪贴板。请在页面任意位置按 Ctrl / ⌘ + V。';
      setPasteHint(text);
      log(text);
      return;
    }
    const tryAgain = (text: string) => {
      setPasteHint(text);
      log(text);
    };
    try {
      const items = await navigator.clipboard.read();
      const files: File[] = [];
      let sawText = false;
      // 纯文本不是文件；真发文字请走「发文字」，不要把它当文件发出去
      const textTypes = new Set(['text/plain', 'text/html', 'text/rtf']);
      for (const item of items) {
        if (!item.types.length) continue;
        if (item.types.every((t) => textTypes.has(t))) {
          sawText = true;
          continue;
        }
        const type = item.types.find((t) => !textTypes.has(t));
        if (!type) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], '', { type }));
      }
      if (!files.length) {
        if (sawText) {
          tryAgain('剪贴板里是文字。要发文字请切到「发文字」；要发文件请在页面按 Ctrl / ⌘ + V。');
        } else {
          tryAgain(
            '浏览器把资源管理器里复制的文件保护起来了，按钮读不到。请在页面任意位置按 Ctrl / ⌘ + V，文件会直接发出去。',
          );
        }
        return;
      }
      receiveClipboardFiles(files);
    } catch {
      tryAgain('浏览器没有给剪贴板权限。请在页面任意位置按 Ctrl / ⌘ + V。');
    }
  }, [log, receiveClipboardFiles]);

  useEffect(() => {
    if (!pasteHint) return;
    const timer = window.setTimeout(() => setPasteHint(''), 9000);
    return () => window.clearTimeout(timer);
  }, [pasteHint]);

  useEffect(() => {
    const prevent = (ev: DragEvent) => ev.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  const onDrop = useCallback(
    (ev: ReactDragEvent) => {
      ev.preventDefault();
      setDragging(false);
      const files = Array.from(ev.dataTransfer?.files ?? []);
      if (files.length) sendFiles(files);
    },
    [sendFiles],
  );

  /* ---------------------------------------------------------- 时间线与杂项 */

  const copyEntry = useCallback(
    async (entry: TimelineEntry) => {
      try {
        await navigator.clipboard.writeText(describeEntry(entry));
        log(`已复制：${entry.kind === 'text' ? '文本' : entry.name}`);
      } catch {
        log('复制失败：浏览器没有给剪贴板权限');
      }
    },
    [log],
  );

  /** 这个站点的地址：复制给朋友，或者生成二维码让对方扫 */
  const siteUrl = () =>
    typeof location === 'undefined' ? '' : `${location.origin}${location.pathname}`;

  const shareLink = useCallback(async () => {
    setShareOpen(false);
    const url = siteUrl();
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // 老浏览器或没授权：退回选中一个临时输入框
      const input = document.createElement('textarea');
      input.value = url;
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      input.remove();
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  }, []);

  const shareQr = useCallback(async () => {
    setShareOpen(false);
    const dataUrl = await QRCode.toDataURL(siteUrl(), {
      width: 320,
      margin: 1,
      errorCorrectionLevel: 'M',
    });
    setShareQrImage(dataUrl);
  }, []);

  const toggleDetail = useCallback(() => {
    setDetailView((on) => {
      if (on) {
        setDetailStyle({});
        return false;
      }
      const img = document.querySelector<HTMLImageElement>('.preview-body img');
      const box = document.querySelector<HTMLElement>('.preview-body');
      if (!img || !box || !img.naturalWidth || !img.naturalHeight) return false;
      const rect = box.getBoundingClientRect();
      // 把图片的宽高比和窗口的宽高比一比，谁更长就沿哪个方向铺满
      const imageIsTall = img.naturalHeight / img.naturalWidth > rect.height / rect.width;
      setDetailStyle(
        imageIsTall
          ? { width: '100%', height: 'auto', maxWidth: 'none', maxHeight: 'none' }
          : { height: 'calc(90dvh - 96px)', width: 'auto', maxWidth: 'none', maxHeight: 'none' },
      );
      return true;
    });
  }, []);

  const openPreview = useCallback(
    async (entry: TimelineEntry) => {
      const art = artifactsRef.current.get(entry.id);
      if (!art) return;
      const kind = previewKind(art.mime || entry.mime || '', art.name || entry.name);
      if (!kind) {
        log('这个格式没发在页面里预览');
        return;
      }
      try {
        const blob = await art.open();
        setPreview({
          url: URL.createObjectURL(blob),
          kind,
          name: art.name,
          direction: entry.direction,
          // 文本类直接读出来显示，其他类型交给对应的元素按需读
          text: kind === 'text' ? await blob.text() : undefined,
        });
      } catch (err) {
        log(`⚠ 打不开：${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [log],
  );

  const closePreview = useCallback(() => {
    setDetailView(false);
    setDetailStyle({});
    setPreview((cur) => {
      if (cur) URL.revokeObjectURL(cur.url);
      return null;
    });
  }, []);

  /** 把这一条再存一份到本机。只有还留着产物的条目能下（大文件已经交给浏览器了） */
  const downloadEntry = useCallback(
    async (e: TimelineEntry) => {
      const art = artifactsRef.current.get(e.id);
      if (!art) {
        log('这一条没有可下载的副本');
        return;
      }
      try {
        const blob = await art.open();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = art.name || e.name || '文件';
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      } catch {
        log('这个文件已经拿不到了');
      }
    },
    [log],
  );

  const onNameChange = useCallback(
    (value: string) => {
      setDeviceName(value);
      deviceNameRef.current = value;
      localStorage.setItem('deviceName', value);
      managerRef.current?.setDeviceName(value);
    },
    [],
  );

  const onLocalhost =
    typeof location !== 'undefined' && ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
  const canPair = Boolean(identity?.canSign);
  // 看选中那台自己的状态。多设备并发时"最近连上的那台"和"要发的那台"可能不是同一台。
  /** 打开时看到的是哪个主题，记下来当"家"。 */
  useEffect(() => {
    initialThemeRef.current = theme;
    // 只在第一次挂载时记一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 把主题写到 <html> 上，CSS 用属性选择器切换 */
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.removeItem('theme');
    } catch {
      /* 忽略 */
    }
  }, [theme]);

  /**
   * 切换主题：从图标那里散开，或者收回图标里。
   *
   * 用 View Transitions：浏览器把前后两帧各拍一张快照，我们再给其中一张
   * 加一个圆形裁切动画。方向和"回不回到打开时的主题"绑定：
   *   换成别的主题 → 新的一层从图标往外扩散；
   *   换回打开时的主题 → 当前这层朝图标收回去。
   */
  const toggleTheme = useCallback(() => {
    const current = theme;
    const nextMode: 'light' | 'dark' = current === 'dark' ? 'light' : 'dark';
    const nextTheme = nextMode;
    const retract = nextTheme === initialThemeRef.current && nextTheme !== current;

    // 上一个转场还没结束就再点：直接换，不叠加第二个动画
    if (vtBusyRef.current || nextTheme === current) {
      if (nextTheme !== current) setTheme(nextMode);
      else setTheme(nextMode);
      return;
    }

    const doc = document as Document & {
      startViewTransition?: (cb: () => void) => {
        ready: Promise<void>;
        finished: Promise<void>;
      };
    };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!doc.startViewTransition || reduce) {
      setTheme(nextMode);
      return;
    }

    const rect = themeBtnRef.current?.getBoundingClientRect();
    const x = rect ? rect.left + rect.width / 2 : window.innerWidth - 44;
    const y = rect ? rect.top + rect.height / 2 : 44;
    const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));

    const root = document.documentElement;
    vtBusyRef.current = true;
    root.classList.add(retract ? 'vt-retract' : 'vt-spread');
    // 关键：必须让 React 在这一帧就把 data-theme 写进 DOM。
    // 不 flush 的话，浏览器拍"新快照"时页面上还是旧主题，
    // 动画看着就像先闪一下旧颜色再跳过去。
    const transition = doc.startViewTransition(() => {
      flushSync(() => setTheme(nextMode));
    });

    let animation: Animation | null = null;
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      animation?.cancel();
      animation = null;
      root.classList.remove('vt-retract', 'vt-spread');
      vtBusyRef.current = false;
    };

    transition.ready
      .then(() => {
        const pseudo = retract ? '::view-transition-old(root)' : '::view-transition-new(root)';
        const from = retract ? `circle(${radius}px at ${x}px ${y}px)` : `circle(0px at ${x}px ${y}px)`;
        const to = retract ? `circle(0px at ${x}px ${y}px)` : `circle(${radius}px at ${x}px ${y}px)`;
        animation = root.animate([{ clipPath: from }, { clipPath: to }], {
          duration: 520,
          // 收回用同一条曲线的时间反演，看起来就是扩散倒放
          easing: retract ? 'cubic-bezier(0.8, 0, 0.8, 0.2)' : 'cubic-bezier(0.2, 0.8, 0.2, 1)',
          pseudoElement: pseudo,
          // 留住最后一帧：动画结束到快照被移除之间还有一帧，
          // 不留住的话裁切会退回"没裁过"，也就是整页旧主题闪一下。
          fill: 'forwards',
        });
      })
      .catch(() => {
        /* 浏览器不支持就算了，主题已经切过去了 */
      });

    // 转场真正结束后才收尾，避免和下一次点击抢
    void transition.finished.finally(cleanup);
    // 兜底：万一 finished 一直不来，别让按钮永久卡住
    window.setTimeout(cleanup, 1500);
  }, [theme]);

  /**
   * 心跳：数据通道在"对方页面被系统冻住"时不会报错，两边都以为还连着。
   *
   * 但它在两件事上必须让路，否则会报假警：
   *   1. 正在传文件的时候，通道里塞满了分片，ping 排在后面，四秒根本轮不上；
   *   2. 一次不回不算数，隔一秒半再问一次，两次都不回才判"断了"。
   */
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !target || states[target] !== 'ready') {
      setLinkDead(false);
      return undefined;
    }
    let alive = true;
    const busy = () => activeTransferRef.current.size > 0;

    let inFlight = false;

    const probe = async () => {
      if (busy() || inFlight) return;
      inFlight = true;
      try {
        try {
          await manager.ping(target, 5000);
          if (alive) {
            setLinkDead(false);
            setRecovering(false);
          }
          return;
        } catch {
          /* 可能是通道正忙，也可能只是抖了一下 */
        }
        await new Promise((r) => setTimeout(r, 1500));
        if (!alive || busy()) return;
        try {
          await manager.ping(target, 5000);
          if (alive) {
            setLinkDead(false);
            setRecovering(false);
          }
          return;
        } catch {
          /* 真的没回话了，进入恢复期 */
        }

        // 局域网的抖动、Wi-Fi 切换、休眠唤醒，经常几十秒内自己就好。
        // 这段时间里 ICE 会自己重试，不需要任何信令，所以先别惊动灯塔。
        if (alive) setRecovering(true);
        const deadline = Date.now() + 45_000;
        while (alive && Date.now() < deadline && !busy()) {
          await new Promise((r) => setTimeout(r, 2500));
          if (!alive || busy()) return;
          try {
            await manager.ping(target, 4000);
            if (alive) {
              setLinkDead(false);
              setRecovering(false);
            }
            return;
          } catch {
            /* 还没好，接着等 */
          }
        }
        if (alive) {
          setRecovering(false);
          setLinkDead(true);
          // 旧的路径和延迟不能留着冒充现状
          setPathText('');
        }
      } finally {
        inFlight = false;
      }
    };

    const timer = window.setInterval(() => void probe(), 12_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [target, states]);

  /** 重新可见时先确认链路，不通就自动重连一次。 */
  useEffect(() => {
    const manager = managerRef.current;
    if (!manager || !target) return undefined;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      if (activeTransferRef.current.size > 0) return;
      void manager
        .ping(target, 4000)
        .then(() => {
          setLinkDead(false);
          setRecovering(false);
        })
        .catch(() => {
          // 刚唤醒时链路常常要缓一两秒，给一次机会再决定
          window.setTimeout(() => {
            void manager
              .ping(target, 5000)
              .then(() => {
                setLinkDead(false);
                setRecovering(false);
              })
              .catch(() => {
                setLinkDead(true);
                void manager.connect(target).catch(() => {});
              });
          }, 2000);
        });
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [target]);

  /** 重新申请麦克风权限：再要一次流，成功了就重启"听" */
  const retryMic = useCallback(async () => {
    setMicBlocked(false);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      stream.getTracks().forEach((t) => t.stop());
      log('麦克风权限拿到了，重新开始听');
      setListenNonce((n) => n + 1);
    } catch {
      setMicBlocked(true);
      log('麦克风权限还是没给到。如果浏览器不再弹窗，去站点设置里把麦克风改成允许');
    }
  }, [log]);

  const reconnectPeer = useCallback(async () => {
    const manager = managerRef.current;
    if (!manager || !target) return;
    setReconnecting(true);
    setPathText('');
    try {
      await manager.connect(target);
    } catch {
      /* 失败原因会走会话层的事件，界面上那一行会变 */
    }
  }, [target]);

  /** 回首页：对方已经不在线了，留在这页也没意义 */
  /**
   * 正在传东西时，关页面先问一句。
   *
   * 两条路都断不起：发送方一关，对端立刻收到"连接已关闭"；
   * 接收大文件时数据是经过这个页面流进下载管理器的，页面没了流就断，
   * 浏览器那边会留下一个残缺的下载。提示文案由浏览器决定，我们只能拦。
   */
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (activeTransferRef.current.size === 0) return;
      event.preventDefault();
      // 老浏览器靠 returnValue 判断，新浏览器看 preventDefault
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  /** 灯塔迟迟不给配对码时，自动重试几次就停，别让用户一直盯着"正在要码" */
  useEffect(() => {
    if (step !== 'nearby' || pairCode || codeRetry >= 3) return undefined;
    const timer = window.setTimeout(() => {
      managerRef.current?.refreshCode();
      setCodeRetry((n) => n + 1);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [step, pairCode, codeRetry]);

  /** 二次核对等对方确认，10 秒没动静就当成无响应，给一条退路 */
  useEffect(() => {
    if (!prompt || prompt.role !== 'joiner') {
      setPromptTimeout(false);
      return undefined;
    }
    const timer = window.setTimeout(() => setPromptTimeout(true), 10_000);
    return () => window.clearTimeout(timer);
  }, [prompt]);

  /** 连接遮罩兜底：底层 20 秒连不上会报 failed，这里再多留一点就收起。 */
  useEffect(() => {
    if (!pairingConnecting) return undefined;
    const timer = window.setTimeout(() => setPairingConnecting(null), 25_000);
    return () => window.clearTimeout(timer);
  }, [pairingConnecting]);

  const goHome = useCallback(() => {
    setReconnecting(false);
    setLinkDead(false);
    setPrompt(null);
    setPromptTimeout(false);
    setPairingConnecting(null);
    setStep('scene');
    setScene(null);
    setMicGate('ask');
    setSelected(null);
  }, []);

  // 真的连上了才把"正在重连"收掉
  useEffect(() => {
    if (target && states[target] === 'ready') setReconnecting(false);
  }, [states, target]);

  const targetState = (target ? states[target] : undefined) ?? 'idle';
  const connected = targetState === 'ready' && targetOnline;
  const connecting = targetState === 'connecting' || targetState === 'authenticating';

  // 标签页标题跟着状态走：传输中优先，其次已连接
  useEffect(() => {
    const base = '在线互传';
    document.title = transferring ? `${base}（传输中）` : connected ? `${base}（已连接）` : base;
  }, [transferring, connected]);

  /* ---------------------------------------------------------- 渲染 */

  // 倒计时：码每 30 秒换一次，进度条走完就换
  const codeElapsed = pairCode ? Date.now() - codeIssuedAt : 0;
  const codeLeft = Math.max(0, Math.ceil((CODE_ROTATE_MS - codeElapsed) / 1000));
  const codeProgress = pairCode
    ? Math.max(0, Math.min(100, 100 - (codeElapsed / CODE_ROTATE_MS) * 100))
    : 0;
  const codeLink = pairCode ? pairingLink(location.origin, pairCode) : '';
  /** 冷却剩下的秒数。上面那个 250 毫秒的心跳会带着它一起重算，所以数字会走。 */
  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const cooling = cooldownLeft > 0;
  // 扫码只有一条路：拉起系统相机拍一张，照片拿回来自己认。
  // 不做页面内的取景框，也不挑镜头，那些都交给系统相机。
  const canScan = typeof window !== 'undefined';
  /** 触屏设备上扫描是主入口；桌面端最自然的是输码，扫描退到次要位置 */
  const isTouch =
    typeof window !== 'undefined' && Boolean(window.matchMedia?.('(pointer: coarse)').matches);

  const pairingPanel = (
    <div className="panel pair" data-testid="pair-panel">

      <h2 className="pair-title">
        {manualOpen
          ? manualMode === 'show'
            ? '让对方连我'
            : '输入对方的码'
          : broadcasting
            ? '正在发出声波'
            : '正在识别声波'}
        {(broadcasting || listening) && !manualOpen ? <span className="live-dot" /> : null}
      </h2>
      {headphones && !manualOpen ? (
        <p className="warn" data-testid="headphone-warn">
          看着像在用耳机。这个功能要外放，耳机里听不到那串声波。
        </p>
      ) : null}
      {selfCheck === 'quiet' && broadcasting ? (
        <p className="warn" data-testid="self-check-quiet">
          没听到自己的声音。可能是静音或者音量太小，戴耳机时可以忽略。
        </p>
      ) : null}
      {!pairCode && step === 'nearby' ? (
        <p className="warn" data-testid="no-code-hint">
          {codeRetry >= 3
            ? '服务一直没有给码。检查网络后再试一次。'
            : '正在向服务要配对码，还没拿到。会自动重试。'}
          <button
            className="link"
            onClick={retryCode}
          >
            立即重试
          </button>
        </p>
      ) : null}
      {manualOpen ? (
        <div className="manual" data-testid="manual-panel" key={manualMode}>
          {manualMode === 'show' ? (
            <>
              {qr ? (
                <img className="qr" data-testid="pair-qr" src={qr} alt="配对二维码" />
              ) : pairCode ? (
                <p className="hint">正在生成…</p>
              ) : null}
              {pairCode ? (
                <>
                  <div className="code-line">
                    <p className="code" data-testid="pair-code">
                      {formatCode(pairCode)}
                    </p>
                    <span className="code-left" data-testid="code-left">
                      {codeLeft} 秒后换
                    </span>
                  </div>
                  <div className="countdown">
                    <i style={{ width: `${codeProgress}%` }} />
                  </div>
                </>
              ) : null}
              <button
                className="primary big pair-active"
                data-testid="pair-active"
                onClick={() => setManualMode('join')}
                disabled={!pairCode}
              >
                我来连对方
              </button>
            </>
          ) : null}

          {manualMode === 'join' ? (
            <>
              {/* 桌面端输码优先，扫描收成一行文字入口；手机上有摄像头，
                  扫描保持主按钮。顺序用 CSS 的 order 调，不改 DOM 结构。 */}
              <div className={`join-stack${isTouch ? ' touch' : ''}`}>
                {canScan ? (
                  <div className="row center scan-row">
                    <button
                      className={isTouch ? 'primary' : 'link'}
                      data-testid="scan-button"
                      disabled={busy || cooling}
                      onClick={() => setScanOpen(true)}
                    >
                      {isTouch ? '直接扫' : '用摄像头扫'}
                    </button>
                    <label
                      className={`${isTouch ? 'button' : 'scan-link'}${busy || cooling ? ' disabled' : ''}`}
                      data-testid="scan-file"
                    >
                      {isTouch ? '拍一张' : '拍一张二维码'}
                      <input
                        data-testid="scan-input"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        hidden
                        disabled={busy || cooling}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          setScanError('');
                          void decodeImage(file)
                            .then((text) => {
                              if (text) void join(text);
                              else setScanError('这张里没看到二维码，靠近一点再拍一张');
                            })
                            .catch((err: unknown) => {
                              setScanError(
                                `认不出来（${err instanceof Error ? err.message : String(err)}）。也可以手动输对方的六位数字`,
                              );
                            });
                        }}
                      />
                    </label>
                  </div>
                ) : null}
                <div className="code-entry">
                  <input
                    data-testid="join-input"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="对方的六位数字"
                    value={joinText}
                    disabled={cooling}
                    onChange={(e) => {
                      const next = e.target.value;
                      if (broadcasting) stopBroadcast();
                      setPairError('');
                      setJoinText(next);
                      const value = normalizeCode(next);
                      if (value && !busy) void join(value);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void join();
                    }}
                  />
                  <div className="row center">
                    <button
                      data-testid="join-button"
                      onClick={() => void join()}
                      disabled={busy || cooling || !typedCode || !canPair}
                    >
                      {cooling ? `${cooldownLeft} 秒后可以再试` : '连接'}
                    </button>
                  </div>
                </div>
              </div>
              {scanError ? <p className="warn">{scanError}</p> : null}
              {pairError ? (
                <p className="warn" data-testid="pair-error">
                  {pairError}
                </p>
              ) : null}
              {cooling ? (
                <p className="hint" data-testid="join-cooldown">
                  这个码不对，先歇 {cooldownLeft} 秒。也可以看一眼对方屏幕上的六位数字。
                </p>
              ) : null}
              <button
                className="link manual-toggle"
                data-testid="pair-show-mine"
                onClick={() => setManualMode('show')}
              >
                让对方连我
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {canSound && micGate !== 'declined' && !manualOpen ? (
        <button
          className={broadcasting ? 'big' : 'primary big'}
          data-testid="play-code"
          onClick={() => (broadcasting ? stopBroadcast() : void startBroadcast())}
          disabled={!pairCode}
        >
          {broadcasting ? '停下' : '发出声波'}
        </button>
      ) : null}

      {micBlocked && !manualOpen ? (
        <p className="warn" data-testid="mic-blocked">
          <button className="link" data-testid="retry-mic" onClick={() => void retryMic()}>
            权限失效，需要重新获取
          </button>
        </p>
      ) : null}
      {soundError && !manualOpen ? (
        <p className="warn" data-testid="sound-error">{soundError}</p>
      ) : null}

      {micGate === 'declined' ? null : (
        <button
          className="link manual-toggle"
          data-testid="toggle-manual"
          onClick={() => setManualOpen((v) => !v)}
        >
          {manualOpen ? '用声波配对' : '手动输入配对码'}
        </button>
      )}

    </div>
  );

  const confirmPanel = prompt ? (
    <div className="panel" data-testid="confirm-panel">
      <h2>核对六位数字</h2>
      {prompt.peerPlatform ? (
        <p
          className={`platform-badge${prompt.peerPlatform === 'web' ? ' web' : ''}`}
          data-testid="prompt-platform"
        >
          {peerPlatformLabel(prompt.peerPlatform)}
        </p>
      ) : null}
      <p className="sas" data-testid="sas">
        {prompt.sas}
      </p>
      {prompt.role === 'inviter' ? (
        <div className="row center">
          <button className="primary big" onClick={() => void confirm(true)}>
            一致
          </button>
          <button onClick={() => void confirm(false)}>不一致</button>
        </div>
      ) : promptTimeout ? (
        <>
          <p className="hint center" data-testid="prompt-timeout">
            对方无响应
          </p>
          <div className="row center">
            <button className="back-home" data-testid="prompt-home" onClick={goHome}>
              回到首页
            </button>
          </div>
        </>
      ) : (
        <p className="hint center">等对方确认…</p>
      )}
    </div>
  ) : null;

  const sendPanel = (
    <div className="panel" data-testid="send-panel">
      {targetContact ? (
        <p className="platform-line" data-testid="peer-platform">
          {/* 用户要能确认自己连的是哪台设备，所以设备名和端类型放在同一行。
              名字可能很长，窄屏时省略，不把徽标挤到下一行外面。 */}
          <span className="peer-name" data-testid="peer-name">
            已连上 {targetContact.peerName}
          </span>
          <span className={`platform-badge${targetPlatform === 'web' ? ' web' : ''}`}>
            {peerPlatformLabel(targetPlatform)}
          </span>
        </p>
      ) : null}

      {connecting && phase ? (
        <div className="connect" data-testid="connect-progress">
          <div className="connect-bar">
            <i
              style={{
                width: `${Math.round(((CONNECT_PHASES.indexOf(phase) + 1) / CONNECT_PHASES.length) * 100)}%`,
              }}
            />
          </div>
          <p className="hint">
            {phase === 'signaling'
              ? '第 1 步（共 3 步）· 正在和对方交换连接信息'
              : phase === 'ice'
                ? '第 2 步（共 3 步）· 正在打通网络路径'
                : phase === 'auth'
                  ? '第 3 步（共 3 步）· 正在验证对方身份'
                  : '就绪'}
          </p>
        </div>
      ) : null}

      <div className="tabs" data-testid="compose-tabs" data-active={composeTab}>
        <span className="thumb" aria-hidden="true" />
        <button
          className={`tab${composeTab === 'file' ? ' on' : ''}`}
          data-testid="tab-file"
          onClick={() => setComposeTab('file')}
        >
          发文件
        </button>
        <button
          className={`tab${composeTab === 'text' ? ' on' : ''}`}
          data-testid="tab-text"
          onClick={() => setComposeTab('text')}
        >
          发文字
        </button>
      </div>

      {composeTab === 'file' ? (
      <div
        className={`drop ${dragging ? 'over' : ''} ${connected ? '' : 'dim'}`}
        data-testid="drop-zone"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <p className="bigline">
          {connected
            ? isTouch
              ? '选好文件就发过去'
              : '把文件拖到这里'
            : targetOnline
              ? '正在和对方建立连接…'
              : '等对方打开页面就能直接发'}
        </p>
        <div className="row center">
          <button className="primary" onClick={() => fileInputRef.current?.click()} disabled={!target}>
            选择文件
          </button>
          {isTouch ? null : (
            <button onClick={() => void pasteFromClipboard()} disabled={!target}>
              粘贴
            </button>
          )}
        </div>
        {isTouch ? null : pasteHint ? (
          <p className="warn paste-hint" data-testid="paste-hint">
            {pasteHint}
          </p>
        ) : (
          <p className="hint">
            可以把文件拖进来，或在页面任意位置按 Ctrl / ⌘ + V；点「粘贴」只能读取截图。
          </p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          data-testid="send-file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) sendFiles(files);
            e.target.value = '';
          }}
        />
      </div>
      ) : (
      <div className="text-compose" data-testid="text-compose">
        <textarea
          placeholder="点击右边的按钮直接粘贴给对方，或者在这里输入文字"
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={5}
        />
        <div className="row center">
          <button
            className="primary send-text-btn"
            data-testid="send-text"
            onClick={() => void pasteTextAndSend()}
            disabled={!target}
          >
            {text.trim() ? '发送' : '粘贴'}
          </button>
        </div>
      </div>
      )}

      {/* 多开是次要动作：连上之后先看“连的是谁、要发什么”，
          再开一台设备放在卡片最下面。 */}
      <p className="hint one-pair-hint" data-testid="one-pair-hint">
        <button
          className="link"
          onClick={() => window.open(location.href, '_blank', 'noopener')}
        >
          再连一台设备
        </button>
      </p>
    </div>
  );

  const visitPanel = visit ? (
    <div className="panel" data-testid="visit-panel">
      <h2>取件</h2>
      {visit.name ? (
        <p className="hint">
          <strong>{visit.name}</strong>
          {visit.size !== undefined ? `　${formatBytes(visit.size)}` : ''}
          {visit.deviceName ? `　来自「${visit.deviceName}」` : ''}
        </p>
      ) : null}

      {visit.phase === 'checking' ? <p className="bigline">正在查这条分享还在不在…</p> : null}
      {visit.phase === 'offline' ? (
        <>
          <p className="bigline">对方此刻不在线</p>
          <p className="hint">
            链接没有失效。等它上线后会自动继续：每十秒重查一次，最多六十秒；
            也可以点「重试」立刻查。
          </p>
          <div className="row center">
            <button
              data-testid="visit-retry"
              onClick={() => void hubRef.current?.retryVisit()}
            >
              重试
            </button>
          </div>
        </>
      ) : null}
      {visit.phase === 'connecting' ? (
        <p className="bigline">正在建立点对点连接…{pathText ? `　${pathText}` : ''}</p>
      ) : null}
      {visit.phase === 'busy' ? (
        <p className="bigline">
          对方一次只给一个人发文件，现在正给别的访客发。
          等它那边传完，刷新这一页就能接着取。
        </p>
      ) : null}
      {visit.phase === 'downloading' ? (
        <>
          <p className="bigline">正在收，别关掉这一页</p>
          <p className="bar" style={{ display: 'block' }}>
            <i style={{ width: `${Math.round((visit.progress ?? 0) * 100)}%` }} />
          </p>
          <p className="hint">
            {Math.round((visit.progress ?? 0) * 100)}%　
            {visit.size !== undefined ? formatBytes((visit.progress ?? 0) * visit.size) : ''} /{' '}
            {visit.size !== undefined ? formatBytes(visit.size) : ''}
          </p>
        </>
      ) : null}
      {visit.phase === 'done' ? (
        <p className="bigline">收好了，文件已经交给浏览器的下载</p>
      ) : null}
      {visit.phase === 'revoked' ? <p className="bigline">对方已经撤销这条链接</p> : null}
      {visit.phase === 'expired' ? <p className="bigline">这条链接到期了</p> : null}
      {visit.phase === 'not-here' ? (
        <p className="bigline">对方那一页已经不认得这条链接了，多半是它刷新过页面</p>
      ) : null}
      {visit.phase === 'not-found' ? <p className="bigline">没有找到这条链接</p> : null}
      {visit.phase === 'needs-https' ? (
        <p className="warn">
          当前不是安全上下文，签名用不了，验不了对方身份，所以不取。
          请用 HTTPS 地址打开这条链接。
        </p>
      ) : null}
      {visit.phase === 'unanchored' ? (
        <p className="warn">
          这条分享没有登记公钥，或者公钥和它的设备号对不上。
          没有锚点就没办法确认连过去的是不是它，所以不取。
        </p>
      ) : null}
      {visit.phase === 'failed' ? <p className="warn">取件失败：{visit.note ?? '未知原因'}</p> : null}

      {visit.note && visit.phase !== 'failed' ? <p className="hint">{visit.note}</p> : null}

      <div className="row center">
        <button
          data-testid="visit-leave"
          onClick={() => {
            // 已经取完就不用再通知对方"我不取了"：那会把分享者那边刚记下的
            // 「已取件」改写成「已离开」。没取完才需要告诉对方名额放开了。
            if (visit.phase !== 'done') hubRef.current?.leave();
            setVisit(null);
            setStep('scene');
            setScene(null);
          }}
        >
          {visit.phase === 'done' ? '完成' : '不取了'}
        </button>
      </div>
    </div>
  ) : null;

  const sharePanel = (
    <div className="panel" data-testid="share-panel">
      <div
        className={`drop ${connected ? '' : 'dim'} ${dragging ? 'over' : ''}`}
        data-testid="share-drop"
        onClick={() => shareInputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files ?? []);
          if (files.length) void publishFiles(files);
        }}
      >
        <p className="bigline">{isTouch ? '选一个文件挂出去' : '选一个文件，或者拖到这里挂出去'}</p>
        <div className="row center">
          <button className="primary" disabled={busy || !canPair}>
            选一个文件
          </button>
        </div>
        <input
          ref={shareInputRef}
          type="file"
          multiple
          hidden
          data-testid="share-file-input"
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length) void publishFiles(files);
            e.target.value = '';
          }}
        />
      </div>

      {outgoing.length === 0 ? null : (
        <div className="tl" data-testid="share-list">
          {outgoing.map((s) => (
            <div className="item" key={s.token} data-testid={`share-${s.token}`}>
              <span className="tag out">分享</span>
              <span className="name">{s.name}</span>
              <span className="meta">
                {formatBytes(s.size)} ·{' '}
                {s.visitors.length ? `${s.visitors.length} 个访客 · ` : ''}
                {new Date(s.expiresAt).toLocaleString('zh-CN', { hour12: false })} 到期
              </span>
              <code className="invite" data-testid="share-link">
                {s.link}
              </code>
              <code className="invite" data-testid="share-code">
                编号 {shareCode(s.token)}
              </code>
              <button onClick={() => void copyShareLink(s.link)}>复制链接</button>
              <button onClick={() => void copyShareCode(s.token)}>复制编号</button>
              <button onClick={() => void revokeShare(s.token)}>撤销</button>
              {s.visitors.length ? (
                <span className="hint">
                  {s.visitors
                    .map((v) =>
                      v.phase === 'failed'
                        ? `${v.name}（失败）`
                        : `${v.name}（${visitorPhaseText(v.phase)}）`,
                    )
                    .join('、')}
                </span>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  /* ---------------------------------------------------------- 分步的几屏 */

  const peerReady = Boolean(target && states[target] === 'ready');
  const peerName = target ? (contacts.find((c) => c.peerId === target)?.peerName ?? '对方') : '';
  /** 顶栏那句话只认这个：有人真的连着。 */
  const linkedPeer = peerReady ? peerName : null;

  /** 第一步：选一次怎么传，选完自己往下走，不再要求点"下一步"。 */
  const scenePanel = (
    <div className="panel bare" data-testid="scene-panel">
      <h2 className="scene-title">请选择您的使用方式</h2>
      <div className="scenes">
        <button
          type="button"
          data-testid="scene-nearby"
          className="scene"
          onClick={() => {
            setScene('nearby');
            if (SOUND_PAIRING_ENABLED) setMicGate('ask');
            else enterNearby('declined');
          }}
        >
          <strong>双方先匹配再发文件</strong>
          <span>配好之后直接传。</span>
          <i className="scene-go" aria-hidden="true">
            ›
          </i>
        </button>
        <button
          type="button"
          data-testid="scene-remote"
          className="scene"
          onClick={() => {
            setScene('remote');
            setStep('remote');
          }}
        >
          <strong>直接生成一条链接</strong>
          <span>把链接发送给对方，对方打开就能取。</span>
          <i className="scene-go" aria-hidden="true">
            ›
          </i>
        </button>
      </div>
      <div className="scene-foot">
        <p className="scene-kicker" data-testid="scene-kicker">数据直连不走服务器</p>
        <p className="scene-note" data-testid="scene-note">需要双方同时在线</p>
        <div className="share-wrap">
          {copied ? (
            <span className="share-toast" data-testid="copy-toast">
              已复制到剪贴板
            </span>
          ) : null}
          <button
            className="share-btn"
            data-testid="share-site"
            onClick={() => setShareOpen((v) => !v)}
          >
            分享本站
          </button>
          {shareOpen ? (
            <div className="share-menu" data-testid="share-menu">
              <button onClick={() => void shareLink()}>复制链接</button>
              <button onClick={() => void shareQr()}>二维码</button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );

  /** 选面对面之后先问一句：麦克风开不开。 */
  const micPanel = (
    <div className="panel mic-gate" data-testid="mic-gate">
      <h2>推荐使用自动配对功能</h2>
      <p className="hint">
        自动配对功能使用声波识别技术，需要麦克风和扬声器（不能插着耳机），需要批准相关权限。
      </p>
      <div className="row center">
        <button
          className="primary"
          data-testid="mic-allow"
          onClick={() => {
            setMicGate('granted');
            enterNearby('granted');
          }}
        >
          自动配对
        </button>
        <button
          data-testid="mic-deny"
          onClick={() => {
            setMicGate('declined');
            enterNearby('declined');
          }}
        >
          手动配对
        </button>
      </div>
    </div>
  );

  /** 第二步之一：面对面。自动听，随时可以播放。 */
  const nearbyPanel = (
    <>
      {pairingPanel}
      {phase === 'failed' ? (
        <p className="warn" data-testid="nearby-error">
          这次没连上。会自己再试，也可以回上一步换一种方式。
        </p>
      ) : null}
    </>
  );

  /** 第二步之二：远距离，生成链接或者打开别人的链接。 */
  const remotePanel = visit && visit.phase !== 'idle' ? visitPanel : sharePanel;

  /** 第三步：连上之后的界面。连接信息就写在最上面，不再单独占一页。 */
  const livePanel = (
    <>
      {recovering && !linkDead ? (
        <p className="link-line" data-testid="link-recovering">
          <span className="dot" />
          <span>信号弱了一下，正在自己恢复…</span>
        </p>
      ) : linkDead || reconnecting || targetState !== 'ready' ? (
        <p className="link-line dead" data-testid="link-lost">
          <span className="dot" />
          <span>
            {reconnecting
              ? '正在重新连接…'
              : targetOnline
                ? '连接断了，两边都点一下重新连接'
                : '对方已经离线'}
          </span>
          {reconnecting ? null : targetOnline ? (
            <button className="link" data-testid="reconnect-peer" onClick={() => void reconnectPeer()}>
              重新连接
            </button>
          ) : (
            <button className="link" data-testid="back-home" onClick={goHome}>
              回首页
            </button>
          )}
        </p>
      ) : (
      <p className="link-line" data-testid="connected-panel">
        <span className="dot on" />
        <span className="link-detail" data-testid="link-detail">
          <span data-testid="path">{pathText || '直连'}</span>
          {probe.status === 'ok'
            ? ` · 来回 ${probe.rtt} 毫秒`
            : probe.status === 'fail'
              ? ' · 对方暂时没回应'
              : ' · 正在确认这条路'}
        </span>
        {probe.status === 'fail' ? (
          <button className="link" onClick={() => setProbeNonce((n) => n + 1)}>
            再试一次
          </button>
        ) : null}
      </p>
      )}
      {sendPanel}
    </>
  );

  // 两步：选方式 / 对上并开传。真正连上之后底部那条就收起来。
  const stepIndex = step === 'scene' ? 1 : 2;
  const gateOpen = step === 'scene' && micGate === 'ask' && scene === 'nearby';
  const canBack = gateOpen || step === 'nearby' || step === 'remote';
  const goBack = () => {
    if (prompt) {
      // 核对面板是浮在流程上的一层，退出去要一起收掉
      setPrompt(null);
      setPromptTimeout(false);
      return;
    }
    // 主动配对是一层，先退回"让对方扫我的码"
    if (step === 'nearby' && manualOpen && manualMode === 'join') {
      setManualMode('show');
      return;
    }
    if (gateOpen) {
      setScene(null);
      return;
    }
    if (step === 'nearby' || step === 'remote') setStep('scene');
  };

  const offline = signalState !== 'open';
  /** 访客页是别人分享的一条链接，不显示"和谁配对"这类全局状态 */
  const visitorMode = Boolean(visit && visit.phase !== 'idle');
  /**
   * 运行日志默认不显示。普通用户不需要，排障的人加 `?debug=1` 就能拿到，
   * e2e 也可以按需要打开。见 docs/35 的 WEB-4。
   */
  const debugMode =
    typeof window !== 'undefined' && new URLSearchParams(location.search).has('debug');

  // 掉线遮罩上的进度：走到第几次、还要等多久。
  // 手机冻结之后用户唯一能判断"系统还在动"的就靠这两项，
  // 以前这里只有一句"正在重连"，看起来和卡死没有区别。
  const waitRemainMs = reconnect?.nextAt != null ? Math.max(0, reconnect.nextAt - nowMs) : 0;
  const waitRatio =
    reconnect && reconnect.delayMs > 0 && reconnect.nextAt != null
      ? 1 - Math.min(1, waitRemainMs / reconnect.delayMs)
      : 0;
  const reconnectText = !online
    ? '设备没有网络，等网络恢复会自动连'
    : !reconnect
      ? '正在连接服务…'
      : reconnect.phase === 'trying'
        ? `第 ${reconnect.attempt} 次重连，正在握手…`
        : `第 ${reconnect.attempt} 次重连，${formatWait(waitRemainMs)}后开始`;
  /**
   * 状态条的三档。刚断开不值得打断用户，先只显示一条细条；
   * 五秒之后补上重连次数，十五秒之后才认为"真的连不上"，出一张小卡片。
   */
  const downMs = signalDownSince ? Math.max(0, nowMs - signalDownSince) : 0;
  const signalStage: 'first' | 'waiting' | 'failed' =
    downMs >= 15_000 ? 'failed' : downMs >= 5_000 ? 'waiting' : 'first';

  /**
   * 顶栏主状态只取 X-2 词表里的一个：在线 / 配对中 / 已连接 / 对方离线 / 连接失败。
   * 正在首次连接时先不显示——那一刻既不是「在线」也还不是「失败」，
   * 状态交给那条细状态条说。以前这里说的是「还没有连上对方」，和别处不是一套。
   */
  const pairingStatus = Boolean(prompt) || Boolean(pairingConnecting);
  const headStatus: string | null = linkedPeer
    ? '已连接'
    : pairingStatus
      ? '配对中'
      : signalState !== 'open'
        ? signalStage === 'failed'
          ? '连接失败'
          : null
        : step === 'live' && target && !targetOnline
          ? '对方离线'
          : '在线';
  const headDot =
    headStatus === '已连接' ? ' on' : headStatus === '在线' || headStatus === '配对中' ? '' : ' warn';

  return (
    <div className="app">
      <header>
        <div className="brand">
          <strong>在线互传</strong>
        </div>
        {/* 顶栏只说一件事：现在通不通。灯塔、设备号这些用户不需要知道 */}
        <div className="head-right">
        <button
          className="theme-toggle"
          data-testid="theme-toggle"
          title="切换深浅色"
          aria-label="切换深浅色"
          ref={themeBtnRef}
          onClick={toggleTheme}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <circle className="sun" cx="12" cy="12" r="4.2" />
            <g className="rays">
              <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M18.8 5.2l-1.6 1.6M6.8 17.2l-1.6 1.6" />
            </g>
            <path className="moon" d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z" />
          </svg>
        </button>
        {visitorMode || !headStatus ? null : (
          <div className="me" data-testid="link-status" data-status={headStatus}>
            <span className={`dot${headDot}`} />
            <span className="hint">{headStatus}</span>
          </div>
        )}
        </div>
      </header>

      <main>
        <div className="stage" key={prompt ? 'prompt' : gateOpen ? 'gate' : step}>
          {prompt
            ? confirmPanel
            : step === 'scene'
              ? micGate === 'ask' && scene === 'nearby'
                ? micPanel
                : scenePanel
              : step === 'nearby'
                ? nearbyPanel
                : step === 'remote'
                  ? remotePanel
                  : livePanel}
        </div>
        {step !== 'live' && canBack ? (
          <nav className="stepbar" data-testid="stepbar">
            <button data-testid="back-step" onClick={goBack}>
              ← 上一步
            </button>
          </nav>
        ) : null}
      </main>

      {(step === 'live' || step === 'remote') && entries.length > 0 ? (
        <>
      <section className="timeline">
        <div className="row between">
          <strong>传输记录</strong>
        </div>
        <div className="tl" data-testid="timeline">
          {entries.length === 0 ? <span className="hint">还没有传输记录</span> : null}
          {entries.map((e) => {
            const ratio = progress[e.id];
            const art = artifactsRef.current.get(e.id);
            const kind = art
              ? previewKind(art.mime || e.mime || '', art.name || e.name)
              : null;
            return (
              <div className="item" key={e.id}>
                <span className={`tag ${e.direction === 'in' ? 'in' : 'out'}`}>
                  {e.direction === 'in' ? '收到' : '发出'}
                </span>
                <span className="tag fmt">
                  {e.kind === 'text' ? '文字' : formatTag(e.mime ?? '', e.name)}
                </span>
                <span className="name">{e.kind === 'text' ? e.text : e.name}</span>
                <span className="meta">
                  {e.kind === 'file' && e.size !== undefined ? `${formatBytes(e.size)} · ` : ''}
                  {e.status === 'done'
                    ? e.kind === 'text'
                      ? '已送达'
                      : '已完成'
                    : e.status === 'error'
                      ? `失败：${e.note ?? ''}`
                      : '进行中'}
                  {e.status === 'error' && (e.note ?? '').includes('内存')
                    ? '　这个浏览器不支持边收边写，换 Chrome / Edge / Firefox 可以'
                    : ''}
                </span>
                {e.status !== 'done' && e.status !== 'error' ? (
                  <span className="meta" data-testid={`progress-${e.id}`}>
                    {e.size
                      ? `${formatBytes(Math.round((ratio ?? 0) * e.size))} / ${formatBytes(e.size)} · ${Math.round((ratio ?? 0) * 100)}%`
                      : ''}
                  </span>
                ) : null}
                {e.status !== 'done' && e.status !== 'error' ? (
                  <span className="bar">
                    <i style={{ width: `${Math.round((ratio ?? 0) * 100)}%` }} />
                  </span>
                ) : null}
                {/* 动作统一靠右：同一条放得下就贴右，放不下就整组换到下一行 */}
                <span className="item-actions">
                {/* 文件不提供复制，只有文字才需要复制 */}
                {e.kind === 'text' ? (
                  <button onClick={() => void copyEntry(e)}>复制</button>
                ) : null}
                {e.status === 'error' && e.direction === 'out' ? (
                  <button
                    data-testid={`retry-${e.id}`}
                    onClick={() => {
                      if (e.kind === 'text') {
                        void sendTextBody(e.text ?? '');
                        return;
                      }
                      const file = e.name ? sentFilesRef.current.get(`${e.name}:${e.size ?? 0}`) : undefined;
                      if (file) sendFiles([file]);
                      else log('这份文件已经不在了，重新选一次吧');
                    }}
                  >
                    重试
                  </button>
                ) : kind ? (
                  <>
                    <button data-testid={`open-${e.id}`} onClick={() => void openPreview(e)}>
                      预览
                    </button>
                    {/* 自己发出去的东西不用再下载一遍 */}
                    {e.direction === 'in' ? (
                      <button data-testid={`download-${e.id}`} onClick={() => void downloadEntry(e)}>
                        下载
                      </button>
                    ) : null}
                  </>
                ) : null}
                </span>
              </div>
            );
          })}
        </div>
      </section>

        </>
      ) : null}




      {/* 访客页不显示调试日志；普通页面也只在 ?debug=1 时出现 */}
      {visitorMode || !debugMode ? null : (
        <details className="logs">
          <summary>运行日志（{logs.length}）</summary>
          <div className="log">{logs.join('\n')}</div>
        </details>
      )}

      {shareQrImage ? (
        <div className="share-modal" data-testid="share-qr" onClick={() => setShareQrImage('')}>
          <div className="share-modal-card" onClick={(e) => e.stopPropagation()}>
            <h3>扫码打开本站</h3>
            <img src={shareQrImage} alt="站点二维码" />
            <p className="hint center">{siteUrl()}</p>
            <button onClick={() => setShareQrImage('')}>关闭</button>
          </div>
        </div>
      ) : null}

      {scanOpen ? (
        <ScannerModal
          onClose={() => setScanOpen(false)}
          onResult={(text) => {
            setScanOpen(false);
            void join(text);
          }}
        />
      ) : null}

      {preview ? (
        <div className="preview" onClick={closePreview}>
          <div
            className={`preview-body${detailView ? ' detail' : ''}`}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row between">
              <strong>{preview.name}</strong>
              {/* 预览只负责看，下载在记录那一行已经有了 */}
              <div className="preview-actions">
                {preview.kind === 'image' ? (
                  <button data-testid="toggle-detail" onClick={toggleDetail}>
                    {detailView ? '适应窗口' : '详细查看'}
                  </button>
                ) : null}
                <button onClick={closePreview}>关闭</button>
              </div>
            </div>
            {preview.kind === 'image' ? (
              <img
                src={preview.url}
                alt={preview.name}
                style={detailView ? detailStyle : undefined}
              />
            ) : null}
            {preview.kind === 'video' ? <video src={preview.url} controls autoPlay /> : null}
            {preview.kind === 'audio' ? <audio src={preview.url} controls autoPlay /> : null}
            {preview.kind === 'pdf' ? <iframe src={preview.url} title={preview.name} /> : null}
            {preview.kind === 'text' ? (
              <pre className="preview-text">{preview.text ?? ''}</pre>
            ) : null}
          </div>
        </div>
      ) : null}

      {/* 配对确认后到连接就绪之间的过渡。盖住配对页，避免看起来像被退回扫码。 */}
      {pairingConnecting ? (
        <div className="pairing-connecting" data-testid="pairing-connecting">
          <div className="pairing-connecting-card">
            <span className="spinner pairing-spinner" />
            <p className="pairing-connecting-title">
              正在和 {pairingConnecting.name} 建立连接…
            </p>
            <p className="pairing-connecting-line">
              配对已确认，正在交换连接信息。请保持这一页开着。
            </p>
          </div>
        </div>
      ) : null}

      {/* 连不上服务时不再铺满整页：先出一条细状态条，页面照常可读可点。
          超过 15 秒才补一张小卡片说明情况，仍然不铺满、不挡操作。
          见 docs/35 的 WEB-3 样例；这里只改呈现，没动 signalState 和重连状态机。 */}
      {signalState !== 'open' ? (
        <div
          className="signal-bar"
          data-testid="offline"
          data-stage={signalStage}
          role="status"
          aria-live="polite"
        >
          <span className={`signal-dot${online ? '' : ' off'}`} aria-hidden="true" />
          <span className="signal-text" data-testid="reconnect-status">
            {reconnectText}
          </span>
          {/* 进度条只是让人看见"在等，而且快到了"，具体秒数上面写着 */}
          {reconnect && reconnect.phase === 'waiting' && reconnect.nextAt != null ? (
            <span className="signal-progress" data-testid="reconnect-bar">
              <i style={{ width: `${Math.round(waitRatio * 100)}%` }} />
            </span>
          ) : null}
          <button className="link signal-retry" data-testid="reconnect-now" onClick={retryNow}>
            立即重连
          </button>
        </div>
      ) : null}

      {signalState !== 'open' && signalStage === 'failed' ? (
        <div className="signal-card" data-testid="offline-card">
          <strong>暂时连不上服务</strong>
          <p>
            {online
              ? '已经试了几次。点「立即重连」再试一次，或者检查一下网络，稍后再来。'
              : '这台设备没有网络。等网络恢复会自动连上。'}
          </p>
          {isTouch ? <p className="hint">切到后台再回来会立刻重试。</p> : null}
        </div>
      ) : null}
    </div>
  );
}


