import { StorageError } from '../storage-provider.interface';
import { MAX_OBJECT_KEY_LENGTH, S3StorageProvider, assertSafeObjectKey } from './s3-storage.provider';

/**
 * The S3 provider talks to a remote service, so these tests cover the parts that
 * must be right *before* the network is involved: key validation and URL building.
 * Everything past that point is the AWS SDK's job, and asserting it would only
 * assert the SDK.
 */
const CONFIG = {
  endpoint: 'https://s3.ir-thr-at1.arvanstorage.ir',
  region: 'ir-thr-at1',
  bucket: 'shopino-media',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
  forcePathStyle: true,
};

describe('assertSafeObjectKey', () => {
  it('accepts the keys the media pipeline produces', () => {
    expect(() => assertSafeObjectKey('images/store_logo/2026/09/8f0c.webp')).not.toThrow();
  });

  it.each([
    ['empty key', ''],
    ['absolute key', '/images/a.webp'],
    ['traversal segment', 'images/../../secret.webp'],
    ['control character', 'images/a\u0000.webp'],
    ['over-long key', 'a'.repeat(MAX_OBJECT_KEY_LENGTH + 1)],
  ])('rejects %s', (_label, key) => {
    expect(() => assertSafeObjectKey(key)).toThrow(StorageError);
  });
});

describe('S3StorageProvider', () => {
  it('reports itself as remote', () => {
    const provider = new S3StorageProvider(CONFIG);

    expect(provider.kind).toBe('s3');
    expect(provider.isLocal).toBe(false);
  });

  it('builds path-style URLs from the endpoint and bucket', () => {
    const provider = new S3StorageProvider(CONFIG);

    expect(provider.getUrl('images/a.webp')).toBe(
      'https://s3.ir-thr-at1.arvanstorage.ir/shopino-media/images/a.webp',
    );
  });

  it('prefers an explicit public base URL (CDN) and normalizes the trailing slash', () => {
    const withCdn = new S3StorageProvider({ ...CONFIG, publicBaseUrl: 'https://cdn.shopino.ir/media/' });

    expect(withCdn.getUrl('images/a.webp')).toBe('https://cdn.shopino.ir/media/images/a.webp');
  });

  it('falls back to the AWS regional host when no endpoint is configured', () => {
    const aws = new S3StorageProvider({
      region: 'eu-central-1',
      bucket: 'shopino-media',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: false,
    });

    expect(aws.getUrl('documents/a.pdf')).toBe(
      'https://s3.eu-central-1.amazonaws.com/shopino-media/documents/a.pdf',
    );
  });

  it('refuses an unsafe key before attempting a network call', async () => {
    const provider = new S3StorageProvider(CONFIG);

    await expect(provider.exists('../etc/passwd')).rejects.toThrow(/Invalid storage key/);
    await expect(provider.read('/absolute.pdf')).rejects.toThrow(/Invalid storage key/);
    await expect(provider.delete('images/../../x')).rejects.toThrow(/Invalid storage key/);
  });
});
