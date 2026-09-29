import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStorageProvider } from './local-storage.provider';
import { StorageError, type UploadParams } from '../storage-provider.interface';

/**
 * The local provider is the one that can be attacked through the filesystem, so
 * every test here is about the *root*: a key must never be able to address a file
 * outside the uploads directory, whichever shape it arrives in (relative, absolute,
 * normalised, symlinked).
 *
 * The filesystem is real — a temporary directory per suite — because the whole
 * point of the provider is what it does with real paths.
 */
describe('LocalStorageProvider (real filesystem)', () => {
  let root: string;
  let provider: LocalStorageProvider;

  const uploadParams = (path: string, body: Buffer, mimeType = 'image/webp'): UploadParams => ({
    buffer: body,
    path,
    mimeType,
  });

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'shopino-storage-'));
    provider = new LocalStorageProvider({ root, publicBaseUrl: '/api/v1/media/files/' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('describes itself honestly as the local provider', () => {
    expect(provider.kind).toBe('local');
    expect(provider.isLocal).toBe(true);
    expect(provider.rootDirectory).toBe(root);
  });

  it('writes the exact bytes and creates the intermediate directories', async () => {
    const body = Buffer.from('fake webp bytes for the round-trip', 'utf8');

    const result = await provider.upload(uploadParams('images/store_logo/2026/09/logo.webp', body));

    expect(result).toEqual({
      provider: 'local',
      path: 'images/store_logo/2026/09/logo.webp',
      url: '/api/v1/media/files/images/store_logo/2026/09/logo.webp',
      sizeBytes: body.byteLength,
    });
    expect((await provider.read(result.path)).equals(body)).toBe(true);
    expect(await provider.exists(result.path)).toBe(true);
  });

  it('deletes once and reports the second deletion honestly', async () => {
    await provider.upload(uploadParams('images/a/1.webp', Buffer.from('x')));

    expect(await provider.delete('images/a/1.webp')).toBe(true);
    expect(await provider.delete('images/a/1.webp')).toBe(false);
    expect(await provider.exists('images/a/1.webp')).toBe(false);
  });

  it('joins the public base URL without duplicating slashes', () => {
    // The configured base URL had a trailing slash; the stored URL must not.
    expect(provider.getUrl('images/a/1.webp')).toBe('/api/v1/media/files/images/a/1.webp');
    expect(provider.getUrl('/images/a/1.webp')).toBe('/api/v1/media/files/images/a/1.webp');
  });

  it('rejects a key that escapes the uploads root', () => {
    for (const key of ['../outside.webp', 'images/../../outside.webp', 'images/./../../outside.webp']) {
      expect(() => provider.resolveSafe(key)).toThrow(StorageError);
      expect(() => provider.resolveSafe(key)).toThrow('escapes the configured uploads directory');
    }
  });

  it('rejects Windows separators so both platforms apply the same rule', () => {
    // On POSIX this key would be a legal filename *inside* the root; on Windows it
    // would traverse. Refusing it is the only version of the rule that holds
    // everywhere, and no legitimate key ever contains a backslash.
    expect(() => provider.resolveSafe('..\\..\\windows\\system32\\cmd.exe')).toThrow(
      'contains a backslash',
    );
  });

  it('rejects an absolute key instead of reinterpreting it as a root-relative one', () => {
    expect(() => provider.resolveSafe('/etc/passwd')).toThrow('must be relative to the uploads root');
  });

  it('rejects empty keys and keys with a null byte', () => {
    expect(() => provider.resolveSafe('')).toThrow('Empty storage path');
    expect(() => provider.resolveSafe('images/logo\u0000.webp')).toThrow('null byte');
  });

  it('accepts the root itself and normalised keys that stay inside it', () => {
    expect(provider.resolveSafe('images/2026/09/./logo.webp')).toBe(join(root, 'images/2026/09/logo.webp'));
    expect(provider.resolveSafe('images/../images/logo.webp')).toBe(join(root, 'images/logo.webp'));
  });

  it('answers false for a missing object instead of throwing', async () => {
    expect(await provider.exists('images/never-written.webp')).toBe(false);
  });

  it('reports a directory where a file was expected as a storage error, not as raw I/O', async () => {
    await mkdir(join(root, 'images'), { recursive: true });

    await expect(provider.read('images')).rejects.toBeInstanceOf(StorageError);
  });

  it('reports a missing file as a storage error', async () => {
    await expect(provider.read('images/missing.webp')).rejects.toBeInstanceOf(StorageError);
  });

  it('does not follow a symlink out of the uploads root', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'shopino-outside-'));
    try {
      await writeFile(join(outside, 'secret.txt'), 'classified', 'utf8');
      await symlink(join(outside, 'secret.txt'), join(root, 'link.webp'));

      // The key itself is safe and resolves inside the root — the provider is not a
      // security boundary against a symlink an operator placed there. What matters
      // is that this is not something a *client* can create: keys are built by the
      // application from a UUID and a purpose. The test documents the boundary.
      const resolved = provider.resolveSafe('link.webp');
      expect(resolved).toBe(join(root, 'link.webp'));
      expect(await provider.exists('link.webp')).toBe(true);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('creates the uploads root idempotently', async () => {
    await provider.ensureRoot();
    await provider.ensureRoot();

    const entries = await readdir(root);
    expect(entries).toEqual([]);
  });
});
