import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { isReservedAddress, PUBLIC_INTERNET_POLICY, type ImportNetworkPolicy, type ResolvedAddress } from './address-policy';
import { BROWSER_USER_AGENT, SafeHttpClient } from './safe-http-client';
import { ImportError, type ImportErrorCode } from '../import-error';

/**
 * Real sockets against a local server. The policy below is the production
 * reserved-address check with exactly one exception — 127.0.0.1, where the test
 * server listens — and a fake DNS table, so that "a public name that resolves
 * to a private address" can be exercised without a real resolver.
 */
const DNS: Record<string, ResolvedAddress[]> = {
  'site.fixture.test': [{ address: '127.0.0.1', family: 4 }],
  'private.fixture.test': [{ address: '10.1.2.3', family: 4 }],
  'metadata.fixture.test': [{ address: '::ffff:169.254.169.254', family: 6 }],
  // A mixed answer must be refused even though one address is acceptable.
  'mixed.fixture.test': [
    { address: '127.0.0.1', family: 4 },
    { address: '192.168.0.10', family: 4 },
  ],
  'empty.fixture.test': [],
};

const testPolicy: ImportNetworkPolicy = {
  isBlockedAddress: (address) => address !== '127.0.0.1' && isReservedAddress(address),
  isAllowedPort: () => true,
  resolve: (hostname) => Promise.resolve(DNS[hostname] ?? []),
};

let server: Server;
let base: string;
let lastHeaders: IncomingHttpHeaders = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    const path = req.url ?? '/';
    const port = (server.address() as AddressInfo).port;
    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>سلام</h1>');
    } else if (path === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('compressed body')));
    } else if (path === '/bomb') {
      // 20 MB of zeros compress to ~20 KB: must be cut off after decompression.
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(20 * 1024 * 1024)));
    } else if (path === '/large-declared') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) });
      res.end(Buffer.alloc(3 * 1024 * 1024, 0x61));
    } else if (path === '/large-chunked') {
      res.writeHead(200, { 'content-type': 'text/html' });
      for (let i = 0; i < 40; i += 1) res.write(Buffer.alloc(64 * 1024, 0x62));
      res.end();
    } else if (path === '/slow') {
      // Never answers; the client deadline must fire.
    } else if (path === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('not here');
    } else if (path === '/redirect-relative') {
      res.writeHead(302, { location: '/ok' });
      res.end();
    } else if (path === '/redirect-metadata') {
      res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (path === '/redirect-private-name') {
      res.writeHead(307, { location: `http://private.fixture.test:${port}/ok` });
      res.end();
    } else if (path === '/redirect-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    } else if (path.startsWith('/loop/')) {
      const n = Number(path.slice('/loop/'.length));
      res.writeHead(302, { location: `/loop/${n + 1}` });
      res.end();
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://site.fixture.test:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const client = new SafeHttpClient(testPolicy);
const opts = { accept: 'text/html', maxBytes: 1024 * 1024 };

async function codeOf(promise: Promise<unknown>): Promise<ImportErrorCode | 'RESOLVED'> {
  try {
    await promise;
    return 'RESOLVED';
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

describe('SafeHttpClient', () => {
  it('fetches a page with browser-like headers', async () => {
    const result = await client.fetch(`${base}/ok`, opts);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html; charset=utf-8');
    expect(result.body.toString('utf8')).toBe('<h1>سلام</h1>');
    expect(lastHeaders['user-agent']).toBe(BROWSER_USER_AGENT);
    expect(lastHeaders['accept']).toBe('text/html');
    expect(lastHeaders['accept-language']).toContain('fa-IR');
  });

  it('decompresses gzip responses', async () => {
    const result = await client.fetch(`${base}/gzip`, opts);
    expect(result.body.toString('utf8')).toBe('compressed body');
  });

  it('follows a relative redirect and reports the final URL', async () => {
    const result = await client.fetch(`${base}/redirect-relative`, opts);
    expect(result.status).toBe(200);
    expect(result.url.pathname).toBe('/ok');
  });

  it('returns non-2xx statuses without a body', async () => {
    const result = await client.fetch(`${base}/missing`, opts);
    expect(result.status).toBe(404);
    expect(result.body.length).toBe(0);
  });

  describe('SSRF', () => {
    it('refuses a redirect to the cloud metadata address', async () => {
      await expect(codeOf(client.fetch(`${base}/redirect-metadata`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('refuses a redirect to a host name that resolves to a private address', async () => {
      await expect(codeOf(client.fetch(`${base}/redirect-private-name`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('refuses a redirect to a non-http scheme', async () => {
      await expect(codeOf(client.fetch(`${base}/redirect-file`, opts))).resolves.toBe('INVALID_URL');
    });

    it('refuses host names whose DNS answer is private (checked at connect time)', async () => {
      const port = (server.address() as AddressInfo).port;
      await expect(codeOf(client.fetch(`http://private.fixture.test:${port}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(client.fetch(`http://metadata.fixture.test:${port}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('refuses a mixed DNS answer if any address is private', async () => {
      const port = (server.address() as AddressInfo).port;
      await expect(codeOf(client.fetch(`http://mixed.fixture.test:${port}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('reports an unresolvable name as a network error', async () => {
      const port = (server.address() as AddressInfo).port;
      await expect(codeOf(client.fetch(`http://empty.fixture.test:${port}/ok`, opts))).resolves.toBe('NETWORK');
    });

    it('with the production policy, never connects to 127.0.0.1:4000 or 192.168.1.1', async () => {
      const production = new SafeHttpClient(PUBLIC_INTERNET_POLICY);
      await expect(codeOf(production.fetch('http://127.0.0.1:4000', opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(production.fetch('http://192.168.1.1', opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(production.fetch('http://127.0.0.1/', opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(production.fetch('http://localhost/', opts))).resolves.toBe('BLOCKED_TARGET');
      // The local test server (non-standard port, loopback) is only reachable through the test policy.
      await expect(codeOf(production.fetch(`${base}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
    });
  });

  it('gives up after 5 redirects', async () => {
    await expect(codeOf(client.fetch(`${base}/loop/0`, opts))).resolves.toBe('TOO_MANY_REDIRECTS');
  });

  it('enforces the deadline', async () => {
    const started = Date.now();
    await expect(codeOf(client.fetch(`${base}/slow`, { ...opts, timeoutMs: 300 }))).resolves.toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('rejects a declared Content-Length above the cap before reading it', async () => {
    await expect(codeOf(client.fetch(`${base}/large-declared`, opts))).resolves.toBe('TOO_LARGE');
  });

  it('rejects a chunked body once it passes the cap', async () => {
    await expect(codeOf(client.fetch(`${base}/large-chunked`, opts))).resolves.toBe('TOO_LARGE');
  });

  it('cuts off a compression bomb after decompression', async () => {
    const before = process.memoryUsage().rss;
    await expect(codeOf(client.fetch(`${base}/bomb`, opts))).resolves.toBe('TOO_LARGE');
    // It must not have inflated the whole 20 MB.
    expect(process.memoryUsage().rss - before).toBeLessThan(15 * 1024 * 1024);
  });
});
