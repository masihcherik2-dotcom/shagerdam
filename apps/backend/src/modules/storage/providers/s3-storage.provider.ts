import { Logger } from '@nestjs/common';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  StorageError,
  type StorageProvider,
  type StorageProviderKind,
  type UploadParams,
  type UploadResult,
} from '../storage-provider.interface';

export interface S3StorageConfig {
  /**
   * Service endpoint. For AWS this may be omitted (the SDK derives it from the
   * region); for ArvanCloud and Liara it is required, e.g.
   * `https://s3.ir-thr-at1.arvanstorage.ir` or `https://storage.iran.liara.ir`.
   */
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /**
   * Path-style addressing (`endpoint/bucket/key`) instead of virtual-hosted
   * (`bucket.endpoint/key`). Required by most S3-compatible providers, including
   * ArvanCloud and Liara with a custom domain; AWS itself deprecated it, so it
   * defaults to `false`.
   */
  forcePathStyle: boolean;
  /**
   * Public base URL used to build links. Set it when the bucket is fronted by a
   * CDN or a custom domain (`https://cdn.shopino.ir`). When omitted, links are
   * built from the endpoint and bucket.
   */
  publicBaseUrl?: string;
}

/**
 * S3-compatible provider: AWS S3, ArvanCloud Object Storage, Liara Object
 * Storage and MinIO all speak this API.
 *
 * Deliberate choices:
 *
 * - **No public-read ACL is set.** Bucket policy decides visibility; the SDK
 *   request contains no ACL header, so the implementation works both for
 *   providers that reject ACLs outright and for buckets configured for private
 *   objects. A private bucket is the correct default for KYC documents, and a
 *   public CDN should be configured in front of the public prefix instead.
 * - **Private objects are streamed through the API.** `read()` fetches the
 *   object with the server's credentials, so a document never needs a presigned
 *   URL that could be shared or logged.
 * - **Keys are validated before the request.** `assertSafeKey` refuses empty,
 *   absolute, traversal and control-character keys, and caps the length, so a
 *   malformed key fails before a network round-trip.
 */
export class S3StorageProvider implements StorageProvider {
  readonly kind: StorageProviderKind = 's3';
  readonly isLocal = false;

  private readonly logger = new Logger(S3StorageProvider.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly publicBaseUrl: string;

  constructor(config: S3StorageConfig) {
    this.bucket = config.bucket;
    this.client = new S3Client({
      region: config.region,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
    this.publicBaseUrl = (
      config.publicBaseUrl ?? `${config.endpoint ?? `https://s3.${config.region}.amazonaws.com`}/${config.bucket}`
    ).replace(/\/$/, '');
  }

  async upload(params: UploadParams): Promise<UploadResult> {
    this.assertSafeKey(params.path);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: params.path,
          Body: params.buffer,
          ContentType: params.mimeType,
          ContentLength: params.buffer.byteLength,
          CacheControl: 'public, max-age=31536000, immutable',
          Metadata: params.metadata ? { ...params.metadata } : undefined,
        }),
      );
      this.logger.debug(`PUT s3://${this.bucket}/${params.path} (${params.buffer.byteLength}B)`);
    } catch (error) {
      throw new StorageError(this.kind, `S3 upload failed for ${params.path}`, error);
    }

    return {
      provider: this.kind,
      path: params.path,
      url: this.getUrl(params.path),
      sizeBytes: params.buffer.byteLength,
    };
  }

  async delete(path: string): Promise<boolean> {
    this.assertSafeKey(path);

    try {
      // S3 `DeleteObject` is idempotent and reports success for a missing key, so
      // existence is checked first to return an honest boolean.
      const existed = await this.exists(path);
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: path }));
      return existed;
    } catch (error) {
      throw new StorageError(this.kind, `S3 delete failed for ${path}`, error);
    }
  }

  getUrl(path: string): string {
    return `${this.publicBaseUrl}/${path.replace(/^\/+/, '')}`;
  }

  async exists(path: string): Promise<boolean> {
    this.assertSafeKey(path);

    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: path }));
      return true;
    } catch (error) {
      if (isNotFound(error)) {
        return false;
      }
      throw new StorageError(this.kind, `S3 head failed for ${path}`, error);
    }
  }

  /** Streams the object into memory with the server's credentials. */
  async read(path: string): Promise<Buffer> {
    this.assertSafeKey(path);

    try {
      const response = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: path }));
      const body = response.Body;
      if (body === undefined) {
        throw new StorageError(this.kind, `S3 returned an empty body for ${path}`);
      }
      return Buffer.from(await body.transformToByteArray());
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(this.kind, `S3 read failed for ${path}`, error);
    }
  }

  private assertSafeKey(key: string): void {
    assertSafeObjectKey(key, this.kind);
  }
}

/** Longest object key the providers accept; mirrors `media_assets.path`. */
export const MAX_OBJECT_KEY_LENGTH = 512;

/**
 * Rejects keys that are structurally unusable, before any network round-trip.
 *
 * Unlike the local provider — which has a filesystem root to defend and therefore
 * re-resolves every path — an S3 key is a flat namespace where traversal has no
 * meaning. What still matters is refusing absolute keys (which would silently
 * address a different bucket prefix), control characters, over-long keys, and any
 * `..` segment, because a key is also used to build URLs and log lines.
 */
export function assertSafeObjectKey(key: string, kind: StorageProviderKind = 's3'): void {
  const invalid =
    key.length === 0 ||
    key.length > MAX_OBJECT_KEY_LENGTH ||
    key.startsWith('/') ||
    key.includes('..') ||
    // eslint-disable-next-line no-control-regex -- control characters in a key are the thing being rejected
    /[\u0000-\u001f\u007f]/.test(key);

  if (invalid) {
    throw new StorageError(kind, 'Invalid storage key');
  }
}

/** `NoSuchKey` / `NotFound` arrive as protocol errors, not as a typed response. */
function isNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const name = (error as { name?: string }).name;
  const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return name === 'NotFound' || name === 'NoSuchKey' || status === 404;
}
