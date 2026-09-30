import { embeddedIPv4, expandIPv6, isReservedAddress, PUBLIC_INTERNET_POLICY } from './address-policy';

describe('isReservedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback /8'],
    ['10.0.0.1', 'RFC 1918 10/8'],
    ['10.255.255.255', 'RFC 1918 10/8 upper edge'],
    ['172.16.0.1', 'RFC 1918 172.16/12 lower edge'],
    ['172.20.0.5', 'Docker bridge network'],
    ['172.31.255.255', 'RFC 1918 172.16/12 upper edge'],
    ['192.168.1.1', 'RFC 1918 192.168/16'],
    ['169.254.169.254', 'cloud metadata (link-local)'],
    ['169.254.0.1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.2.10', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks IPv4 %s (%s)', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone id'],
    ['fc00::1', 'unique local'],
    ['fd12:3456:789a::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::', '6to4 (tunnels to an embedded IPv4)'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
    ['::ffff:192.168.1.1', 'IPv4-mapped private'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata endpoint, hex form'],
    ['::10.0.0.1', 'IPv4-compatible private'],
    ['64:ff9b::10.0.0.1', 'NAT64 to a private address'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 to the metadata endpoint'],
  ])('blocks IPv6 %s (%s)', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['93.184.215.14'],
    ['172.15.255.255'], // just below 172.16/12
    ['172.32.0.1'], // just above 172.16/12
    ['192.169.0.1'], // just above 192.168/16
    ['169.255.0.1'], // just above 169.254/16
    ['2606:4700:4700::1111'], // public IPv6
    ['::ffff:8.8.8.8'], // IPv4-mapped public
    ['64:ff9b::808:808'], // NAT64 to a public address
  ])('allows public address %s', (address) => {
    expect(isReservedAddress(address)).toBe(false);
  });

  it.each([['not-an-ip'], [''], ['999.1.1.1'], ['example.com']])('treats unparseable input %p as blocked', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });
});

describe('IPv6 helpers', () => {
  it('expands compressed and dotted-quad forms', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    expect(expandIPv6('2001:db8::8a2e:370:7334')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
    expect(expandIPv6('127.0.0.1')).toBeNull();
  });

  it('extracts the IPv4 hidden in mapped, compatible and NAT64 addresses', () => {
    expect(embeddedIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIPv4('::10.1.2.3')).toBe('10.1.2.3');
    expect(embeddedIPv4('64:ff9b::c0a8:101')).toBe('192.168.1.1');
    expect(embeddedIPv4('2606:4700::1111')).toBeNull();
    expect(embeddedIPv4('::1')).toBeNull();
  });
});

describe('PUBLIC_INTERNET_POLICY', () => {
  it('only allows the standard web ports', () => {
    expect(PUBLIC_INTERNET_POLICY.isAllowedPort(80)).toBe(true);
    expect(PUBLIC_INTERNET_POLICY.isAllowedPort(443)).toBe(true);
    for (const port of [22, 25, 3000, 4000, 5432, 6379, 8080, 9000]) {
      expect(PUBLIC_INTERNET_POLICY.isAllowedPort(port)).toBe(false);
    }
  });

  it('uses the reserved-address check', () => {
    expect(PUBLIC_INTERNET_POLICY.isBlockedAddress('192.168.1.1')).toBe(true);
    expect(PUBLIC_INTERNET_POLICY.isBlockedAddress('8.8.8.8')).toBe(false);
  });
});
