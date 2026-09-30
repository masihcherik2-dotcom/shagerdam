import { isIP } from 'node:net';
import type { ImportNetworkPolicy } from './address-policy';
import { ImportError } from '../import-error';

/** Longest URL accepted from a client (typical browser/CDN limits sit around 2–8 KB). */
export const MAX_IMPORT_URL_LENGTH = 2048;

/**
 * Host names that only make sense inside a private network. They are refused by
 * name before any DNS query, so an internal resolver is never even asked about
 * them (`localhost` and `*.localhost` always mean loopback — RFC 6761).
 */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];

/** Hostname as the socket layer wants it: lower-case, no trailing dot, IPv6 without brackets. */
export function socketHostname(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Validates a user-supplied URL for the importer and returns it parsed.
 *
 * Checks, in order: length; WHATWG parsing (which also canonicalises numeric
 * host tricks such as `http://2130706433/` or `http://0x7f.1/` into
 * `127.0.0.1`); `http:`/`https:` only; no embedded credentials; the port;
 * internal host names; and — when the host is an IP literal — the address
 * itself. Host names are resolved and checked later, at connect time, by the
 * HTTP client (see `SafeHttpClient`), because only that check is immune to DNS
 * rebinding.
 */
export function parseImportUrl(raw: string, policy: ImportNetworkPolicy): URL {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_IMPORT_URL_LENGTH) {
    throw new ImportError('INVALID_URL', `The URL must be 1–${MAX_IMPORT_URL_LENGTH} characters long`);
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ImportError('INVALID_URL', 'The URL is not valid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImportError('INVALID_URL', 'Only http:// and https:// URLs can be imported');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ImportError('INVALID_URL', 'URLs with embedded credentials are not accepted');
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!policy.isAllowedPort(port)) {
    throw new ImportError('BLOCKED_TARGET', `Port ${port} is not allowed; only standard web ports (80, 443) can be imported`);
  }

  const host = socketHostname(url);
  if (host.length === 0) {
    throw new ImportError('INVALID_URL', 'The URL has no host');
  }

  if (isIP(host) !== 0) {
    if (policy.isBlockedAddress(host)) {
      throw new ImportError('BLOCKED_TARGET', 'The URL points to a private, loopback or reserved network address');
    }
    return url;
  }

  if (host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new ImportError('BLOCKED_TARGET', 'The URL points to an internal host name');
  }
  // A single-label name ("backend", "postgres", "redis") is an intranet or
  // container service name, never a public web site.
  if (!host.includes('.')) {
    throw new ImportError('BLOCKED_TARGET', 'The URL must use a fully qualified public domain name');
  }
  return url;
}
