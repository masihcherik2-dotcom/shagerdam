/**
 * The storage contract every provider must satisfy.
 *
 * The media module never talks to a filesystem or an object store directly: it
 * injects the `STORAGE_PROVIDER` token and calls these three methods. That is
 * what makes local development and S3-compatible production swappable by
 * configuration alone, with no branch inside business logic.
 */

/** Which provider implementation is running. Mirrors the `STORAGE_PROVIDER` env value. */
export type StorageProviderKind = 'local' | 's3';

/** Injection token for the active provider. */
export const STORAGE_PROVIDER = 'SHOPINO_STORAGE_PROVIDER';

export interface UploadParams {
  /** File content. Buffers, not streams: the Sharp pipeline already produced them in memory. */
  buffer: Buffer;
  /**
   * Provider-relative object key, e.g. `images/2026/09/<uuid>.webp`.
   * Always produced by the application (never by a client) and validated by the
   * providers before use.
   */
  path: string;
  /** Content type the object is stored and served as. */
  mimeType: string;
  /** Object metadata; only keys the provider understands are forwarded. */
  metadata?: Readonly<Record<string, string>>;
}

export interface UploadResult {
  provider: StorageProviderKind;
  path: string;
  /** Absolute URL a browser can fetch (public objects) or the API can stream. */
  url: string;
  sizeBytes: number;
}

export interface StoredObject {
  path: string;
  /** Absolute URL, built the same way as in {@link UploadResult}. */
  url: string;
}

/**
 * Raised when a provider cannot complete an operation. Carries the provider name
 * so the API can map it to a 502/503 without leaking filesystem or SDK internals.
 */
export class StorageError extends Error {
  constructor(
    readonly provider: StorageProviderKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

export interface StorageProvider {
  readonly kind: StorageProviderKind;
  /**
   * `true` for providers that keep bytes on the local disk. The API uses this to
   * decide whether it must stream the file itself (local) or can hand out a
   * direct object-store URL (s3).
   */
  readonly isLocal: boolean;

  /** Writes an object. Overwrites an existing key with the same path. */
  upload(params: UploadParams): Promise<UploadResult>;

  /** Removes an object. Returns `true` when something was actually deleted. */
  delete(path: string): Promise<boolean>;

  /** Absolute URL for an object path. Pure: no I/O, no existence check. */
  getUrl(path: string): string;

  /** `true` when the object exists. Used by the guarded download route. */
  exists(path: string): Promise<boolean>;

  /** Reads an object back. Only the local provider supports this today. */
  read(path: string): Promise<Buffer>;
}
