import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { errorMessage } from '../../common/utils';
import {
  STORAGE_PROVIDER,
  StorageError,
  type StorageProvider,
  type UploadParams,
  type UploadResult,
} from './storage-provider.interface';

/**
 * Application-facing facade over the active storage provider.
 *
 * Its job is to keep business code free of provider detail and to translate
 * provider failures into something HTTP-meaningful: a storage outage is not the
 * client's fault, so it surfaces as `503` rather than `400`/`500`.
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);

  constructor(@Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider) {}

  get kind(): StorageProvider['kind'] {
    return this.provider.kind;
  }

  get isLocal(): boolean {
    return this.provider.isLocal;
  }

  /** Honest capability report; surfaced by `GET /media/storage-provider`. */
  describe(): { provider: string; isLocal: boolean } {
    return { provider: this.provider.kind, isLocal: this.provider.isLocal };
  }

  async upload(params: UploadParams): Promise<UploadResult> {
    try {
      return await this.provider.upload(params);
    } catch (error) {
      throw this.toHttpError(error, 'File storage');
    }
  }

  async delete(path: string): Promise<boolean> {
    try {
      return await this.provider.delete(path);
    } catch (error) {
      throw this.toHttpError(error, 'File deletion');
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      return await this.provider.exists(path);
    } catch (error) {
      throw this.toHttpError(error, 'File lookup');
    }
  }

  async read(path: string): Promise<Buffer> {
    try {
      return await this.provider.read(path);
    } catch (error) {
      throw this.toHttpError(error, 'File read');
    }
  }

  getUrl(path: string): string {
    return this.provider.getUrl(path);
  }

  private toHttpError(error: unknown, stage: string): ServiceUnavailableException {
    const detail = error instanceof StorageError ? error.message : errorMessage(error);
    this.logger.error(`${stage} failed via ${this.provider.kind}: ${detail}`);
    return new ServiceUnavailableException(
      `${stage} is temporarily unavailable (provider: ${this.provider.kind}). Please retry shortly.`,
    );
  }
}
