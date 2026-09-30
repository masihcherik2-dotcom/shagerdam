import { ServiceUnavailableException } from '@nestjs/common';
import { StorageError, type StorageProvider } from './storage-provider.interface';
import { StorageService } from './storage.service';

/**
 * The facade's only job is to hide provider detail and to translate provider
 * failures into HTTP meaning. Both halves are pinned here with a recording stub,
 * so the tests describe the contract every provider must satisfy rather than the
 * behaviour of one implementation.
 */

interface ProviderSpy {
  provider: StorageProvider;
  calls: Array<{ method: string; args: unknown[] }>;
  /** When set, every provider call rejects with this error object. */
  failWith?: Error;
}

const createProviderSpy = (overrides: Partial<StorageProvider> = {}): ProviderSpy => {
  const spy: ProviderSpy = { calls: [], provider: undefined as unknown as StorageProvider };

  const provider: StorageProvider = {
    kind: 'local',
    isLocal: true,
    upload: (params) => {
      spy.calls.push({ method: 'upload', args: [params] });
      if (spy.failWith !== undefined) {
        return Promise.reject(spy.failWith);
      }
      return Promise.resolve({
        provider: 'local' as const,
        path: params.path,
        url: `/files/${params.path}`,
        sizeBytes: params.buffer.byteLength,
      });
    },
    delete: (path) => {
      spy.calls.push({ method: 'delete', args: [path] });
      return spy.failWith === undefined ? Promise.resolve(true) : Promise.reject(spy.failWith);
    },
    exists: (path) => {
      spy.calls.push({ method: 'exists', args: [path] });
      return spy.failWith === undefined ? Promise.resolve(true) : Promise.reject(spy.failWith);
    },
    read: (path) => {
      spy.calls.push({ method: 'read', args: [path] });
      return spy.failWith === undefined
        ? Promise.resolve(Buffer.from(`contents of ${path}`))
        : Promise.reject(spy.failWith);
    },
    // Deliberately not recorded: building a URL is a pure string operation and
    // must not look like an I/O call in the assertions below.
    getUrl: (path) => `/files/${path}`,
    ...overrides,
  };

  spy.provider = provider;
  return spy;
};

describe('StorageService', () => {
  it('reports which provider is active, without decorating the answer', () => {
    const spy = createProviderSpy();

    expect(new StorageService(spy.provider).describe()).toEqual({ provider: 'local', isLocal: true });
  });

  it('delegates upload, delete, exists and read to the provider unchanged', async () => {
    const spy = createProviderSpy();
    const service = new StorageService(spy.provider);

    const params = { buffer: Buffer.from('abc'), path: 'images/a.webp', mimeType: 'image/webp' };
    const uploaded = await service.upload(params);

    expect(uploaded.sizeBytes).toBe(3);
    expect(spy.calls[0]).toEqual({ method: 'upload', args: [params] });
    expect(await service.delete('images/a.webp')).toBe(true);
    expect(await service.exists('images/a.webp')).toBe(true);
    expect((await service.read('images/a.webp')).toString()).toBe('contents of images/a.webp');
    expect(spy.calls.map((call) => call.method)).toEqual(['upload', 'delete', 'exists', 'read']);
  });

  it('builds URLs purely, with no provider round-trip', () => {
    const spy = createProviderSpy();

    new StorageService(spy.provider).getUrl('images/a.webp');

    // Building a URL must stay a pure string operation — no read, no exists, no
    // upload — because it happens while constructing API responses.
    expect(spy.calls).toEqual([]);
  });

  it('propagates an honest false from delete instead of inventing success', async () => {
    const spy = createProviderSpy({ delete: (): Promise<boolean> => Promise.resolve(false) });

    expect(await new StorageService(spy.provider).delete('images/missing.webp')).toBe(false);
  });

  it('turns a provider failure into 503 and names the provider, whatever stage failed', async () => {
    const failure = new StorageError('local', 'ENOSPC: no space left on device');
    const stages: Array<[string, () => Promise<unknown>]> = [];

    for (const method of ['upload', 'delete', 'exists', 'read'] as const) {
      const spy = createProviderSpy();
      spy.failWith = failure;
      const service = new StorageService(spy.provider);
      const run: () => Promise<unknown> = () =>
        method === 'upload'
          ? service.upload({ buffer: Buffer.from('x'), path: 'images/a.webp', mimeType: 'image/webp' })
          : method === 'delete'
            ? service.delete('images/a.webp')
            : method === 'exists'
              ? service.exists('images/a.webp')
              : service.read('images/a.webp');
      stages.push([method, run]);
    }

    for (const [stage, call] of stages) {
      const rejection = await call().catch((error: unknown) => error);

      expect(rejection).toBeInstanceOf(ServiceUnavailableException);
      expect((rejection as ServiceUnavailableException).getStatus()).toBe(503);
      expect((rejection as ServiceUnavailableException).message).toContain('provider: local');
      // The message says what failed, without leaking the filesystem path or SDK internals.
      expect((rejection as ServiceUnavailableException).message).not.toContain('ENOSPC');
      expect(stage.length).toBeGreaterThan(0);
    }
  });

  it('translates a raw infrastructure error too, not only the typed one', async () => {
    const spy = createProviderSpy();
    spy.failWith = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });

    const rejection = await new StorageService(spy.provider)
      .read('images/a.webp')
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    expect((rejection as ServiceUnavailableException).message).toContain('File read is temporarily unavailable');
  });
});
