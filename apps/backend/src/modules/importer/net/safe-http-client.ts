import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { ImportError } from '../import-error';
import { IMPORT_NETWORK_POLICY, type ImportNetworkPolicy } from './address-policy';
import { parseImportUrl, socketHostname } from './import-url';

/** Hard ceiling for one fetch, redirects included (TM requirement: max 10 s). */
export const IMPORT_FETCH_TIMEOUT_MS = 10_000;
export const IMPORT_MAX_REDIRECTS = 5;

/**
 * A current desktop Chrome identity. Many storefronts (and their CDNs/WAFs)
 * answer non-browser user agents with a bot wall or a stripped page, which
 * would make extraction fail for reasons unrelated to the page itself.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export interface SafeFetchOptions {
  /** `Accept` header, e.g. `text/html` or `application/json`. */
  accept: string;
  /** Largest (decompressed) body accepted; larger responses are aborted. */
  maxBytes: number;
  /** Defaults to {@link IMPORT_FETCH_TIMEOUT_MS}; can only be shorter. */
  timeoutMs?: number;
  /** Extra request headers (never overriding the security-relevant ones). */
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  /** URL of the final response after redirects. */
  url: URL;
  status: number;
  contentType: string | null;
  body: Buffer;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * HTTP(S) GET for user-supplied URLs, hardened against SSRF and abuse.
 *
 * - every URL (including each redirect target) passes `parseImportUrl`;
 * - host names are resolved by the socket's own `lookup`, which rejects the
 *   connection if *any* resolved address is private/reserved — the validated
 *   address is the connected address, so DNS rebinding cannot bypass the check;
 * - redirects are followed manually (max 5) so each hop is re-validated;
 * - one deadline (≤ 10 s) covers the whole chain; bodies are size-capped *after*
 *   decompression, so a compression bomb is cut off as early as a large file;
 * - no connection pooling (`agent: false`): a socket is never reused for a
 *   different, unvalidated request.
 */
@Injectable()
export class SafeHttpClient {
  private readonly logger = new Logger(SafeHttpClient.name);

  constructor(@Inject(IMPORT_NETWORK_POLICY) private readonly policy: ImportNetworkPolicy) {}

  /** Validates a URL without fetching it (same rules as {@link fetch}). */
  validate(raw: string): URL {
    return parseImportUrl(raw, this.policy);
  }

  async fetch(raw: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
    const timeoutMs = Math.min(options.timeoutMs ?? IMPORT_FETCH_TIMEOUT_MS, IMPORT_FETCH_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    let url = parseImportUrl(typeof raw === 'string' ? raw : raw.toString(), this.policy);

    for (let hop = 0; ; hop += 1) {
      const response = await this.requestOnce(url, options, deadline);
      if (REDIRECT_STATUSES.has(response.status) && response.location !== null) {
        if (hop >= IMPORT_MAX_REDIRECTS) {
          throw new ImportError('TOO_MANY_REDIRECTS', `The site redirected more than ${IMPORT_MAX_REDIRECTS} times`);
        }
        let next: URL;
        try {
          next = new URL(response.location, url);
        } catch {
          throw new ImportError('NETWORK', 'The site answered with an invalid redirect');
        }
        url = parseImportUrl(next.toString(), this.policy);
        continue;
      }
      return { url, status: response.status, contentType: response.contentType, body: response.body };
    }
  }

  private requestOnce(
    url: URL,
    options: SafeFetchOptions,
    deadline: number,
  ): Promise<{ status: number; location: string | null; contentType: string | null; body: Buffer }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new ImportError('TIMEOUT', `The site did not answer within ${IMPORT_FETCH_TIMEOUT_MS / 1000} seconds`));
    }

    const host = socketHostname(url);
    const isHttps = url.protocol === 'https:';
    const requestOptions: RequestOptions = {
      method: 'GET',
      host,
      port: url.port === '' ? (isHttps ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: {
        ...options.headers,
        host: url.host,
        'user-agent': BROWSER_USER_AGENT,
        accept: options.accept,
        'accept-language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
        'accept-encoding': 'gzip, deflate, br',
        connection: 'close',
      },
      // IP literals never reach `lookup`; `parseImportUrl` has already checked them.
      ...(isIP(host) === 0 ? { lookup: this.guardedLookup } : {}),
      ...(isHttps && isIP(host) === 0 ? { servername: host } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof ImportError ? error : this.translate(error));
      };

      const req = (isHttps ? httpsRequest : httpRequest)(requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null;

        // Redirects and errors: the body is irrelevant, drop the connection.
        if (REDIRECT_STATUSES.has(status) || status < 200 || status >= 300) {
          res.resume();
          settled = true;
          clearTimeout(timer);
          req.destroy();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }

        const declaredLength = Number(res.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes && !res.headers['content-encoding']) {
          fail(new ImportError('TOO_LARGE', `The response is larger than ${formatBytes(options.maxBytes)}`));
          req.destroy();
          return;
        }

        let stream: Readable;
        try {
          stream = decode(res);
        } catch (error) {
          fail(error);
          req.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            fail(new ImportError('TOO_LARGE', `The response is larger than ${formatBytes(options.maxBytes)}`));
            stream.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', fail);
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status, location, contentType, body: Buffer.concat(chunks, total) });
        });
      });

      const timer = setTimeout(() => {
        fail(new ImportError('TIMEOUT', `The site did not answer within ${IMPORT_FETCH_TIMEOUT_MS / 1000} seconds`));
        req.destroy();
      }, remaining);

      req.on('error', fail);
      req.end();
    });
  }

  /**
   * `lookup` for the socket: resolve all addresses, refuse the connection if any
   * of them is reserved. Refusing on *any* (not just the chosen one) keeps a
   * mixed answer from being used to reach an internal address on a retry or a
   * Happy-Eyeballs fallback.
   */
  private readonly guardedLookup = (
    hostname: string,
    options: LookupOneOptions | LookupAllOptions | number,
    callback: LookupCallback,
  ): void => {
    const wantsAll = typeof options === 'object' && options.all === true;
    this.policy
      .resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`No address found for ${hostname}`), { code: 'ENOTFOUND' }), '');
          return;
        }
        const blocked = addresses.find((entry) => this.policy.isBlockedAddress(entry.address));
        if (blocked !== undefined) {
          this.logger.warn(`Blocked importer connection to ${hostname} (${blocked.address})`);
          callback(new ImportError('BLOCKED_TARGET', 'The URL resolves to a private, loopback or reserved network address'), '');
          return;
        }
        if (wantsAll) {
          callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      })
      .catch((error: unknown) => {
        callback(Object.assign(new Error(`DNS lookup failed for ${hostname}`), { code: errorCode(error) ?? 'ENOTFOUND' }), '');
      });
  };

  private translate(error: unknown): ImportError {
    const code = errorCode(error);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new ImportError('NETWORK', 'The site’s domain name could not be resolved');
    }
    if (code === 'ECONNREFUSED') {
      return new ImportError('NETWORK', 'The site refused the connection');
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return new ImportError('NETWORK', 'The site closed the connection unexpectedly');
    }
    if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT')) {
      return new ImportError('NETWORK', 'The site’s TLS certificate could not be verified');
    }
    if (code === 'Z_DATA_ERROR' || code === 'ERR__ERROR_FORMAT_PADDING_1') {
      return new ImportError('NETWORK', 'The site sent a corrupt compressed response');
    }
    return new ImportError('NETWORK', 'The site could not be reached');
  }
}

function decode(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  switch (encoding) {
    case '':
    case 'identity':
      return res;
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      throw new ImportError('UNSUPPORTED_CONTENT', `Unsupported content encoding "${encoding}"`);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}
