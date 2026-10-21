/** 二维码解码：原生 BarcodeDetector 优先，没有就用 zxing 的 wasm。 */

/** BarcodeDetector 的最小形状。它不在标准 lib 里，只能自己写一份。 */
export type QrDetector = {
  new (opts: { formats: string[] }): {
    detect: (src: unknown) => Promise<Array<{ rawValue: string }>>;
  };
  getSupportedFormats: () => Promise<string[]>;
};

export function qrDetector(): QrDetector | null {
  return (window as unknown as { BarcodeDetector?: QrDetector }).BarcodeDetector ?? null;
}

/**
 * 兜底的二维码解码器。
 *
 * iOS Safari 没有 BarcodeDetector，Firefox 和 Windows 上的 Chrome 也没有。
 * 所以这里懒加载一份 zxing 的 wasm，只在用户真的拍完一张照片之后才去下载那一兆。
 */
let zxingReady: Promise<typeof import('zxing-wasm/reader')> | null = null;

export function loadZxing(): Promise<typeof import('zxing-wasm/reader')> {
  if (!zxingReady) {
    zxingReady = (async () => {
      const [mod, wasm] = await Promise.all([
        import('zxing-wasm/reader'),
        import('zxing-wasm/reader/zxing_reader.wasm?url'),
      ]);
      // 不让它去 CDN 取：这个 app 的静态资源都从自己的域名出
      mod.prepareZXingModule({
        overrides: {
          locateFile: (path: string, prefix: string) =>
            path.endsWith('.wasm') ? wasm.default : `${prefix}${path}`,
        },
      });
      return mod;
    })();
  }
  return zxingReady;
}

/** 从一张图里认出二维码。浏览器自带优先，没有就走 wasm。 */
export async function decodeImage(file: Blob): Promise<string | null> {
  const native = qrDetector();
  if (native) {
    const bitmap = await createImageBitmap(file);
    try {
      const found = await new native({ formats: ['qr_code'] }).detect(bitmap);
      return found[0]?.rawValue ?? null;
    } finally {
      bitmap.close();
    }
  }
  const { readBarcodes } = await loadZxing();
  const results = await readBarcodes(file, {
    formats: ['QRCode'],
    tryHarder: true,
    maxNumberOfSymbols: 1,
  });
  return results[0]?.text ?? null;
}
