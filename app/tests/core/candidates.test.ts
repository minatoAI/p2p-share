import { describe, expect, it } from 'vitest';
import {
  classifyPath,
  ipv6Groups,
  ipv6Prefix64,
  isGlobalIpv6,
  isMdnsName,
  isOwnLocalCandidate,
  isPeerLocalCandidate,
  isPrivateAddress,
  sameIpv6Prefix64,
} from '../../src/core/candidates';

describe('私有地址判定', () => {
  it('认 IPv4 私有段和链路本地', () => {
    for (const a of ['10.0.0.1', '192.168.1.9', '172.16.0.1', '172.31.255.255', '169.254.1.1', '127.0.0.1']) {
      expect(isPrivateAddress(a), a).toBe(true);
    }
  });

  it('172.32 和公网地址不算私有', () => {
    expect(isPrivateAddress('172.32.0.1')).toBe(false);
    expect(isPrivateAddress('172.15.0.1')).toBe(false);
    expect(isPrivateAddress('203.0.113.7')).toBe(false);
  });

  it('认 IPv6 的回环、链路本地和 ULA', () => {
    expect(isPrivateAddress('::1')).toBe(true);
    expect(isPrivateAddress('fe80::1')).toBe(true);
    expect(isPrivateAddress('FE80::1%en0')).toBe(true);
    expect(isPrivateAddress('fd00::1')).toBe(true);
    expect(isPrivateAddress('fc00::1')).toBe(true);
  });

  it('IPv4-mapped 按内嵌的 IPv4 判断', () => {
    expect(isPrivateAddress('::ffff:192.168.1.5')).toBe(true);
    expect(isPrivateAddress('::ffff:8.8.8.8')).toBe(false);
  });
});

describe('IPv6 展开', () => {
  it('展开压缩写法', () => {
    expect(ipv6Groups('2408:8207:1234:5678::a')).toEqual([
      0x2408, 0x8207, 0x1234, 0x5678, 0, 0, 0, 0xa,
    ]);
    expect(ipv6Groups('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
  });

  it('压到前四组时前缀仍然是正确的', () => {
    // 2408:0:0:0:abcd:0:0:1 的最长零段在第二到第四组，压缩后会写成 2408::abcd:0:0:1
    expect(ipv6Prefix64('2408::abcd:0:0:1')).toBe('2408:0:0:0');
  });

  it('带作用域和点分结尾都能处理', () => {
    expect(ipv6Prefix64('fe80::1%eth0')).toBe('fe80:0:0:0');
    expect(ipv6Prefix64('::ffff:192.168.1.5')).toBe('0:0:0:0');
  });

  it('非法地址返回 null', () => {
    expect(ipv6Groups('not:an:address')).toBeNull();
    expect(ipv6Groups('1:2:3')).toBeNull();
    expect(ipv6Groups('192.168.1.1')).toBeNull();
    expect(ipv6Groups('')).toBeNull();
  });

  it('全局 IPv6 的判定', () => {
    expect(isGlobalIpv6('2408:8207:1234:5678::a')).toBe(true);
    expect(isGlobalIpv6('fe80::1')).toBe(false);
    expect(isGlobalIpv6('fd00::1')).toBe(false);
    expect(isGlobalIpv6('::ffff:8.8.8.8')).toBe(false);
    expect(isGlobalIpv6('192.168.1.1')).toBe(false);
  });
});

describe('/64 前缀比较', () => {
  it('同前缀为真，不同前缀为假', () => {
    expect(sameIpv6Prefix64('2408:8207:1234:5678::a', '2408:8207:1234:5678::b')).toBe(true);
    expect(sameIpv6Prefix64('2408:8207:1234:5678::a', '2606:4700:1:2::b')).toBe(false);
  });

  it('写法不同但前缀相同也算同一条链路', () => {
    expect(sameIpv6Prefix64('2408:8207:1234:5678::a', '2408:8207:1234:5678:ffff:ffff:ffff:ffff')).toBe(
      true,
    );
  });

  it('mDNS 名字和 IPv4 不参与前缀比较', () => {
    expect(isMdnsName('a1b2-c3d4.local')).toBe(true);
    expect(isMdnsName('192.168.1.1')).toBe(false);
    expect(ipv6Prefix64('a1b2.local')).toBeNull();
  });
});

describe('候选过滤', () => {
  const prefixes = new Set(['2408:8207:1234:5678']);

  it('自己的候选：私有地址和 mDNS 放行，srflx 一律不放行', () => {
    expect(isOwnLocalCandidate({ type: 'host', address: '192.168.1.9' }, prefixes)).toBe(true);
    expect(isOwnLocalCandidate({ type: 'host', address: 'a1b2.local' }, prefixes)).toBe(true);
    expect(isOwnLocalCandidate({ type: 'host', address: '2408:8207:1234:5678::a' }, prefixes)).toBe(true);
    expect(isOwnLocalCandidate({ type: 'srflx', address: '203.0.113.7' }, prefixes)).toBe(false);
    expect(isOwnLocalCandidate({ type: 'relay', address: '203.0.113.7' }, prefixes)).toBe(false);
  });

  it('对端候选：全局 IPv6 必须同 /64 才认', () => {
    expect(isPeerLocalCandidate({ type: 'host', address: '192.168.1.8' }, prefixes)).toBe(true);
    expect(isPeerLocalCandidate({ type: 'host', address: '2408:8207:1234:5678::b' }, prefixes)).toBe(true);
    expect(isPeerLocalCandidate({ type: 'host', address: '2606:4700:1:2::b' }, prefixes)).toBe(false);
  });

  it('判不出来时按不是本地处理', () => {
    expect(isPeerLocalCandidate({ type: 'host', address: '2408:8207:1234:5678::b' }, new Set())).toBe(
      false,
    );
  });
});

describe('路径性质判定', () => {
  it('relay 就是中转', () => {
    expect(classifyPath('relay', '203.0.113.7', 'relay', '203.0.113.8')).toBe('relay');
  });

  it('srflx 是公网直连，不是本地', () => {
    expect(classifyPath('srflx', '203.0.113.7', 'srflx', '203.0.113.8')).toBe('direct');
  });

  it('私有地址和 mDNS 是局域网', () => {
    expect(classifyPath('host', '192.168.1.9', 'srflx', '203.0.113.8')).toBe('lan');
    expect(classifyPath('host', 'a1b2.local', 'srflx', '203.0.113.8')).toBe('lan');
  });

  it('两端都是 host 候选就是局域网，读不到地址也算', () => {
    // 浏览器在 getStats 里可能不给出 address。只靠地址判断的话，
    // 这里会被误判成公网直连，而两个 host 候选本身就说明是同一条链路。
    expect(classifyPath('host', '', 'host', '')).toBe('lan');
    expect(classifyPath('host', '192.168.1.9', 'host', '192.168.1.8')).toBe('lan');
  });

  it('全局 IPv6 看两端前缀是否相同', () => {
    expect(classifyPath('host', '2408:8207:1234:5678::a', 'host', '2408:8207:1234:5678::b')).toBe(
      'lan',
    );
    // 一端是 srflx 才需要靠前缀判断
    expect(
      classifyPath('host', '2408:8207:1234:5678::a', 'srflx', '2606:4700:1:2::b'),
    ).toBe('direct');
    expect(
      classifyPath('host', '2408:8207:1234:5678::a', 'srflx', '2408:8207:1234:5678::b'),
    ).toBe('lan');
  });
});

describe('host 候选不一定是局域网', () => {
  it('两台手机在移动网络上的公网 IPv6 host 候选算直连，不是局域网', () => {
    // 2026-10 线上真实出现过：两台手机都用移动数据，界面却写"局域网直连，不花流量"
    expect(
      classifyPath('host', '2408:8207:1234:5678::1', 'host', '2409:8a00:9876:5432::2'),
    ).toBe('direct');
  });

  it('同一个 /64 前缀下的 IPv6 host 候选仍然是局域网', () => {
    expect(
      classifyPath('host', '2408:8207:1234:5678::1', 'host', '2408:8207:1234:5678::9'),
    ).toBe('lan');
  });

  it('内网 IPv4 的 host 候选照旧算局域网', () => {
    expect(classifyPath('host', '192.168.1.5', 'host', '192.168.1.9')).toBe('lan');
  });
});
