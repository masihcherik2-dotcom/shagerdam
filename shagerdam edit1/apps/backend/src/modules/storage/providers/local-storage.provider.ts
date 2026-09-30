import { Logger } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import {
  StorageError,
  type StorageProvider,
  type StorageProviderKind,
  type StoredObject,
  type UploadParams,
  type UploadResult,
} from '../storage-provider.interface';

export interface LocalStorageConfig {
  /** Absolute path of the uploads root, e.g. `<repo>/apps/backend/uploads`. */
  root: string;
  /**
   * Base URL the files are published under. Defaults to the API itself
   * (`/api/v1/media/files`), which is what the streaming controller serves.
   */
  publicBaseUrl: string;
}

/**
 * Filesystem-backed provider, used in development and in single-node
 * deployments.
 *
 * Two properties matter more than the code itself:
 *
 * 1. **Everything stays inside the root.** Every incoming path is normalized and
 *    then resolved, and the result must still start with the root directory. A
 *    key such as `../../etc/passwd` is rejected instead of escaping — the check
 *    is on the *resolved* path, not on the string, so encodings and `..`
 *    combinations are all covered by the same rule.
 * 2. **Writes are durable before they are reported.** `writeFile` is awaited; a
 *    caller never gets a URL for a file that is not on disk.
 *
 * The directory layout mirrors the object key (`images/2026/09/<uuid>.webp`), so
 * moving to S3 later is a copy, not a re-modelling.
 */
export class LocalStorageProvider implements StorageProvider {
  readonly kind: StorageProviderKind = 'local';
  readonly isLocal = true;

  private readonly logger = new Logger(LocalStorageProvider.name);
  private readonly root: string;
  private readonly publicBaseUrl: string;

  constructor(config: LocalStorageConfig) {
    this.root = resolve(config.root);
    this.publicBaseUrl = config.publicBaseUrl.replace(/\/$/, '');
  }

  get rootDirectory(): string {
    return this.root;
  }

  async upload(params: UploadParams): Promise<UploadResult> {
    const absolutePath = this.resolveSafe(params.path);

    try {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, params.buffer);
    } catch (error) {
      throw new StorageError(this.kind, `Could not write ${params.path}`, error);
    }

    return {
      provider: this.kind,
      path: params.path,
      url: this.getUrl(params.path),
      sizeBytes: params.buffer.byteLength,
    };
  }

  async delete(path: string): Promise<boolean> {
    const absolutePath = this.resolveSafe(path);

    try {
      await stat(absolutePath);
    } catch {
      return false;
    }

    try {
      await rm(absolutePath, { force: true });
      return true;
    } catch (error) {
      throw new StorageError(this.kind, `Could not delete ${path}`, error);
    }
  }

  getUrl(path: string): string {
    // The path is not validated here on purpose: `getUrl` is pure and may be
    // called with a value that came out of the database. `resolveSafe` guards
    // every operation that actually touches the disk.
    return `${this.publicBaseUrl}/${path.replace(/^\/+/, '')}`;
  }

  async exists(path: string): Promise<boolean> {
    try {
      const stats = await stat(this.resolveSafe(path));
      return stats.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Reads a file back into memory. Deliberately capped by the caller (the media
   * service only serves files it wrote and sized itself), because this is not a
   * streaming API.
   */
  async read(path: string): Promise<Buffer> {
    try {
      return await readFile(this.resolveSafe(path));
    } catch (error) {
      throw new StorageError(this.kind, `Could not read ${path}`, error);
    }
  }

  /** Read stream for the download controller; avoids buffering large files twice. */
  createReadStream(path: string): ReturnType<typeof createReadStream> {
    return createReadStream(this.resolveSafe(path));
  }

  /** Absolute path of a stored object. Throws when the key escapes the root. */
  resolveSafe(path: string): string {
    if (path.length === 0) {
      throw new StorageError(this.kind, 'Empty storage path');
    }
    if (path.startsWith('/')) {
      // `join(root, '/etc/passwd')` would quietly become `<root>/etc/passwd`. That
      // stays inside the root, but it also means a client-supplied absolute path
      // silently changes meaning — so it is refused and the two providers behave
      // alike instead of one rejecting what the other reinterprets.
      throw new StorageError(this.kind, 'Storage path must be relative to the uploads root');
    }
    // eslint-disable-next-line no-control-regex -- detecting the null byte is the point
    if (/[\u0000]/.test(path)) {
      throw new StorageError(this.kind, 'Storage path contains a null byte');
    }
    if (path.includes('\\')) {
      // On POSIX a backslash is a legal filename character, so this key would
      // silently become a file called `..\\..\\etc\\passwd` *inside* the root: safe
      // here, a traversal on Windows. Refusing it keeps the two platforms
      // equivalent instead of shipping a rule that only holds on Linux.
      throw new StorageError(this.kind, 'Storage path contains a backslash');
    }

    const absolutePath = resolve(join(this.root, normalize(path)));
    const rootWithSeparator = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`;

    if (absolutePath !== this.root && !absolutePath.startsWith(rootWithSeparator)) {
      this.logger.warn(`Rejected a storage path that escapes the uploads root: ${path}`);
      throw new StorageError(this.kind, 'Storage path escapes the configured uploads directory');
    }
    return absolutePath;
  }

  /** Exposed for diagnostics: confirms the root is usable at boot. */
  async ensureRoot(): Promise<StoredObject[]> {
    await mkdir(this.root, { recursive: true });
    return [];
  }
}
