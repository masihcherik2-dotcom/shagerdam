import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard: which network targets the importer may contact.
 *
 * The importer fetches URLs chosen by a user, from inside the platform's private
 * network (the backend container sits next to PostgreSQL, Redis and the cloud
 * metadata endpoint). Every address the client would connect to is therefore
 * checked against the reserved ranges below — the literal IP of the URL, every
 * address DNS returns for its host, and again for every redirect hop.
 *
 * The check runs inside the socket's own `lookup`, so the address that was
 * validated is the address that is connected to: a DNS answer that changes
 * between "check" and "connect" (DNS rebinding) cannot slip through.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Network policy injected into the HTTP client. Production always uses
 * {@link PUBLIC_INTERNET_POLICY}; only the automated E2E suite substitutes a
 * policy (through Nest's `overrideProvider`, never through configuration) so it
 * can serve fixture pages from a local HTTP server.
 */
export interface ImportNetworkPolicy {
  /** `true` when the address must never be contacted. */
  isBlockedAddress(address: string): boolean;
  /** Ports a URL may name explicitly. */
  isAllowedPort(port: number): boolean;
  /** Resolves every address of a host (A and AAAA). */
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export const IMPORT_NETWORK_POLICY = Symbol('IMPORT_NETWORK_POLICY');

/** IPv4 ranges that are not the public internet (RFC 6890 special-purpose registry). */
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918 private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918 private (Docker's default bridge networks live here)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
];

/** IPv6 ranges that are not the public internet. Embedded-IPv4 forms are unwrapped separately. */
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 — tunnels to an arbitrary embedded IPv4
  ['fc00::', 7], // unique local (the IPv6 "private" range)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

const blockList = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) blockList.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) blockList.addSubnet(network, prefix, 'ipv6');

/**
 * Expands an IPv6 literal into its eight 16-bit groups (handles `::` and a
 * trailing dotted-quad). Returns `null` for anything that is not IPv6.
 */
export function expandIPv6(address: string): number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // A trailing IPv4 (e.g. ::ffff:127.0.0.1) becomes two hex groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const headGroups = head ? head.split(':').filter((part) => part.length > 0) : [];
  const tailGroups = tail ? tail.split(':').filter((part) => part.length > 0) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) {
    return null;
  }
  const groups = [...headGroups, ...new Array<string>(missing).fill('0'), ...tailGroups].map((part) => parseInt(part, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address hidden inside an IPv6 one, if any: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`).
 * Connecting to any of these reaches the embedded IPv4, so that is what must be
 * checked.
 */
export function embeddedIPv4(address: string): string | null {
  const groups = expandIPv6(address);
  if (groups === null) {
    return null;
  }
  const high = groups.slice(0, 6);
  const isMapped = high.slice(0, 5).every((group) => group === 0) && high[5] === 0xffff;
  const isCompatible = high.every((group) => group === 0) && (groups[6] !== 0 || groups[7]! > 1);
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (!isMapped && !isCompatible && !isNat64) {
    return null;
  }
  const g6 = groups[6]!;
  const g7 = groups[7]!;
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

/** `true` for every address the importer must not connect to (and for anything unparseable). */
export function isReservedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return blockList.check(address, 'ipv4');
  }
  if (version === 6) {
    const inner = embeddedIPv4(address);
    if (inner !== null) {
      return blockList.check(inner, 'ipv4');
    }
    const zone = address.indexOf('%');
    return blockList.check(zone >= 0 ? address.slice(0, zone) : address, 'ipv6');
  }
  return true;
}

/** Default policy: public internet on the standard web ports only. */
export const PUBLIC_INTERNET_POLICY: ImportNetworkPolicy = {
  isBlockedAddress: isReservedAddress,
  isAllowedPort: (port) => port === 80 || port === 443,
  async resolve(hostname) {
    const answers = await dnsLookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
  },
};
