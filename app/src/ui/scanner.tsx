import { useCallback, useEffect, useRef, useState } from 'react';
import { loadZxing, qrDetector } from './qr';

/**
 * 扫码弹窗。
 *
 * 三件事决定它好不好用：
 *   1. 镜头要挑对。很多手机有三四个后置镜头，浏览器默认那个有时是长焦，
 *      对不上焦什么也扫不到。这里按设备名排序，把长焦排到最后，并且
 *      允许用户一键切换。
 *   2. 对焦要连续。`focusMode: 'continuous'` 在支持的浏览器上生效，
 *      iOS 不给这个开关，但它自己的对焦本来就够用。
 *   3. 解码要快。有 BarcodeDetector 就用原生（安卓 Chrome），没有就把帧
 *      缩到 640 宽再喂给 zxing 的 wasm——整帧解码在低端机上会卡。
 */

interface Props {
  onClose: () => void;
  onResult: (text: string) => void;
}

/** 镜头名字里带这些词的排到最后：长焦对二维码基本没用 */
function rankCamera(label: string): number {
  const l = label.toLowerCase();
  if (/(tele|长焦|潜望|periscope|depth|景深|mono|黑白)/.test(l)) return 3;
  if (/(front|user|前置)/.test(l)) return 2;
  if (/(back|rear|environment|后置|后摄|主摄|wide)/.test(l)) return 0;
  return 1;
}

export function ScannerModal({ onClose, onResult }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([]);
  const [activeId, setActiveId] = useState('');
  const [error, setError] = useState('');

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  /** 打开某一颗镜头。deviceId 为空时让浏览器自己挑后置。 */
  const start = useCallback(
    async (deviceId?: string) => {
      stop();
      setError('');
      const constraints: MediaStreamConstraints = {
        audio: false,
        video: deviceId
          ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
              // 非标准，Chrome 认；不认的浏览器会忽略
              advanced: [{ focusMode: 'continuous' } as unknown as MediaTrackConstraintSet],
            },
      };
      try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          video.setAttribute('playsinline', 'true');
          await video.play().catch(() => {});
        }

        const devices = (await navigator.mediaDevices.enumerateDevices()).filter(
          (d) => d.kind === 'videoinput',
        );
        devices.sort((a, b) => rankCamera(a.label) - rankCamera(b.label));
        setCameras(devices);
        const track = stream.getVideoTracks()[0];
        const settings = track?.getSettings() ?? {};
        const current = String(settings.deviceId ?? '');
        setActiveId(current);

        // 如果浏览器默认给的是长焦，自动换到排序第一的那颗
        const currentLabel = devices.find((d) => d.deviceId === current)?.label ?? '';
        if (rankCamera(currentLabel) >= 3) {
          const better = devices.find((d) => rankCamera(d.label) < 3 && d.deviceId !== current);
          if (better) await start(better.deviceId);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message.includes('Permission') ? '没有拿到摄像头权限' : `打不开摄像头：${message}`);
      }
    },
    [stop],
  );

  useEffect(() => {
    void start();
    return stop;
    // 只在打开时启动一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 解码循环
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const native = qrDetector();
    let zxing: Awaited<ReturnType<typeof loadZxing>> | null = null;

    const tick = async () => {
      if (stopped) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState >= 2 && video.videoWidth > 0) {
        const scale = Math.min(1, 640 / video.videoWidth);
        const w = Math.round(video.videoWidth * scale);
        const h = Math.round(video.videoHeight * scale);
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (ctx) {
          ctx.drawImage(video, 0, 0, w, h);
          try {
            let text: string | null = null;
            if (native) {
              const found = await new native({ formats: ['qr_code'] }).detect(canvas);
              text = found[0]?.rawValue ?? null;
            } else {
              if (!zxing) zxing = await loadZxing();
              const results = await zxing.readBarcodes(ctx.getImageData(0, 0, w, h), {
                formats: ['QRCode'],
                maxNumberOfSymbols: 1,
                tryHarder: false,
              });
              text = results[0]?.text ?? null;
            }
            if (text && !stopped) {
              stopped = true;
              navigator.vibrate?.(40);
              onResult(text);
              return;
            }
          } catch {
            /* 这一帧没认出来，继续 */
          }
        }
      }
      timer = window.setTimeout(() => void tick(), 200);
    };

    void tick();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [onResult]);

  const switchCamera = () => {
    if (cameras.length < 2) return;
    const index = cameras.findIndex((c) => c.deviceId === activeId);
    const next = cameras[(index + 1) % cameras.length];
    if (next) void start(next.deviceId);
  };

  return (
    <div className="scanner" data-testid="scanner" onClick={onClose}>
      <div className="scanner-card" onClick={(e) => e.stopPropagation()}>
        <div className="scanner-view">
          <video ref={videoRef} muted playsInline />
          <canvas ref={canvasRef} hidden />
          <div className="scanner-frame" aria-hidden="true" />
          {error ? <p className="scanner-error">{error}</p> : null}
        </div>
        <div className="scanner-bar">
          <button onClick={onClose}>取消</button>
          {cameras.length > 1 ? (
            <button data-testid="switch-camera" onClick={switchCamera}>
              切换镜头
            </button>
          ) : null}
        </div>
        <p className="hint center">把对方的二维码放进取景框，认出就会自己连上。</p>
      </div>
    </div>
  );
}
