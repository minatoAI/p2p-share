/**
 * 候选地址判定：这条路径到底走的是局域网、公网直连，还是中继。
 *
 * 三件事容易搞错，都在这一个文件里收口：
 *   1. 直连不等于本地。两台手机都在 4G 上也能打洞成直连，但照样扣流量。
 *   2. 全局 IPv6 地址既可能在同一条链路上，也可能是一条走公网的路径，
 *      光看地址分不出来，必须比 /64 前缀。
 *   3. 判不出来的时候要按"不是本地"处理。宁可连不上，不静默花用户的流量。
 *
 * 术语和取舍见 docs/07、docs/10 第 9 节。
 */

export type PathKind = 'lan' | 'direct' | 'relay' | 'unknown';

export function isPrivateAddress(addr: string): boolean {
  if (!addr) return false;
  // IPv4-mapped（::ffff:192.168.1.5）本质是 IPv4，按内嵌地址判断
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (mapped) return isPrivateAddress(mapped[1]!);
  if (/^10\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;
  const m = /^172\.(\d+)\./.exec(addr);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^169\.254\./.test(addr)) return true;
  if (/^127\./.test(addr)) return true;
  if (/^::1$/.test(addr)) return true;
  if (/^fe80:/i.test(addr)) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(addr)) return true;
  return false;
}

/** 这个地址是不是"出了这台机器就到不了"的那一类之外，也就是公网地址。 */
export function isGlobalAddress(addr: string): boolean {
  if (!addr) return false;
  if (isMdnsName(addr)) return false;
  return !isPrivateAddress(addr);
}

/** mDNS 候选：浏览器把真实内网 IP 换成了随机名字，靠组播在局域网内解析。 */
export function isMdnsName(addr: string): boolean {
  return !!addr && /\.local$/i.test(addr);
}

/**
 * 把 IPv6 展开成 8 组数字。要处理三种写法：
 * :: 压缩、% 作用域后缀（fe80::1%en0）、以点分 IPv4 结尾（::ffff:192.168.1.5）。
 * 返回 null 表示这不是一个合法的 IPv6 地址。
 */
export function ipv6Groups(addr: string): number[] | null {
  if (!addr || !addr.includes(':')) return null;
  let a = String(addr).trim().toLowerCase();
  const zone = a.indexOf('%');
  if (zone !== -1) a = a.slice(0, zone);

  const dbl = a.indexOf('::');
  const split = (s: string): string[] => (s ? s.split(':').filter((x) => x !== '') : []);

  const fixV4 = (arr: string[]): string[] | null => {
    if (!arr.length) return arr;
    const last = arr[arr.length - 1]!;
    if (!last.includes('.')) return arr;
    const q = last.split('.').map(Number);
    if (q.length !== 4 || q.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((q[0]! << 8) | q[1]!).toString(16);
    const lo = ((q[2]! << 8) | q[3]!).toString(16);
    return arr.slice(0, -1).concat([hi, lo]);
  };

  const head = fixV4(dbl === -1 ? split(a) : split(a.slice(0, dbl)));
  const tail = dbl === -1 ? [] : fixV4(split(a.slice(dbl + 2)));
  if (!head || !tail) return null;
  // 没有 :: 的写法必须正好 8 组，否则是非法地址（例如 1:2:3）
  if (dbl === -1 && head.length !== 8) return null;

  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const groups = head.concat(new Array<string>(fill).fill('0'), tail);
  if (groups.length !== 8) return null;

  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/**
 * /64 前缀。IPv6 里一个 /64 就是一条链路，路由器不会在 /64 内部转发，
 * 所以两端前缀相同意味着包没有离开局域网。
 */
export function ipv6Prefix64(addr: string): string | null {
  const groups = ipv6Groups(addr);
  if (!groups) return null;
  return groups
    .slice(0, 4)
    .map((n) => n.toString(16))
    .join(':');
}

export function isGlobalIpv6(addr: string): boolean {
  if (!addr || /^::ffff:/i.test(addr)) return false;
  return ipv6Groups(addr) !== null && !isPrivateAddress(addr);
}

export function sameIpv6Prefix64(a: string, b: string): boolean {
  const pa = ipv6Prefix64(a);
  const pb = ipv6Prefix64(b);
  return !!pa && !!pb && pa === pb;
}

/**
 * 自己的候选要不要发给对方。
 * 只有 host 类型才是本机网卡地址；全局 IPv6 也算，因为它的确是本机地址，
 * 而且可能对端就在同一个 /64 里。本机没有配 ICE 服务器时也不会产生 srflx。
 */
export function isOwnLocalCandidate(
  cand: { type: string; address: string },
  ownPrefixes: ReadonlySet<string>,
): boolean {
  if (cand.type !== 'host') return false;
  if (isMdnsName(cand.address) || isPrivateAddress(cand.address)) return true;
  const prefix = ipv6Prefix64(cand.address);
  return !!prefix && ownPrefixes.has(prefix);
}

/**
 * 对端候选要不要接受。全局 IPv6 必须与自己在同一个 /64 才认，
 * 否则那是一条走公网的路径，与"仅局域网"不花流量的承诺冲突。
 */
export function isPeerLocalCandidate(
  cand: { type: string; address: string },
  ownPrefixes: ReadonlySet<string>,
): boolean {
  if (cand.type !== 'host') return false;
  if (isMdnsName(cand.address) || isPrivateAddress(cand.address)) return true;
  const prefix = ipv6Prefix64(cand.address);
  return !!prefix && ownPrefixes.has(prefix);
}

/** 从 getStats() 读到的候选对，判断这条路径的性质。 */
export function classifyPath(
  localType: string,
  localAddress: string,
  remoteType: string,
  remoteAddress: string,
): PathKind {
  if (localType === 'relay' || remoteType === 'relay') return 'relay';
  // 两端都是 host 候选时，通常就是同一条局域网。但 host 候选也可能是全局地址：
  // 移动网络普遍下发公网 IPv6，两台手机在同一张 4G 上的 host 候选其实是公网 IPv6，
  // 这种直连照样走流量。所以先看地址：读到全局地址就不是局域网。
  if (localType === 'host' && remoteType === 'host') {
    const global = isGlobalAddress(localAddress) || isGlobalAddress(remoteAddress);
    if (!global) return 'lan';
    // 同一个 /64 前缀仍然算局域网
    return sameIpv6Prefix64(localAddress, remoteAddress) ? 'lan' : 'direct';
  }
  if (localType !== 'host') return 'direct';
  if (isMdnsName(localAddress) || isPrivateAddress(localAddress)) return 'lan';
  // 全局 IPv6：两端同前缀才算局域网
  if (sameIpv6Prefix64(localAddress, remoteAddress)) return 'lan';
  return 'direct';
}

export function describePath(kind: PathKind): string {
  switch (kind) {
    case 'lan':
      return '局域网直连，不花流量';
    case 'direct':
      return '公网直连，仍然花流量';
    case 'relay':
      return '经 TURN 中转，双方都花流量';
    default:
      return '路径未知';
  }
}
