const HEX = '0123456789abcdef';

export function randomHex(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let out = '';
  for (const b of buf) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

export function newDeviceId(): string {
  return randomHex(8);
}

export function newToken(bytes = 16): string {
  return randomHex(bytes);
}

/**
 * 传输 ID 必须带发起方前缀。
 *
 * 反例（demo 里的写法）：`f${Date.now().toString(36)}-${seq++}`。
 * 两端同一毫秒各自发出第一个文件时，会生成一模一样的 ID，接收端按 ID 归档就会串。
 * 带上设备前缀之后，ID 在全局唯一，不需要任何协调。
 */
export function createTransferIdFactory(deviceId: string) {
  const prefix = deviceId.slice(0, 6);
  let seq = 0;
  return (): string => `${prefix}-${(++seq).toString(36)}-${randomHex(2)}`;
}

/** 六位数字短码，供没有相机的设备手动输入。 */
export function newShortCode(): string {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return String(buf[0]! % 1_000_000).padStart(6, '0');
}
