import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolve } from 'node:path';
import type { EnvironmentVariables } from '../../config/env.validation';
import { LocalStorageProvider, type LocalStorageConfig } from './providers/local-storage.provider';
import { S3StorageProvider, type S3StorageConfig } from './providers/s3-storage.provider';
import { STORAGE_PROVIDER, type StorageProvider, type StorageProviderKind } from './storage-provider.interface';
import { StorageService } from './storage.service';

/**
 * Chooses the storage provider from configuration at boot.
 *
 * Selection happens once, inside the Nest DI container, so no business code ever
 * branches on the environment. Swapping `STORAGE_PROVIDER=local` for
 * `STORAGE_PROVIDER=s3` (plus credentials) changes the provider with no code
 * change.
 *
 * Misconfiguration fails here, at startup, not at the first upload:
 *  - `s3` without credentials is rejected by the environment validator;
 *  - the local provider creates its root directory eagerly, so a bad path or a
 *    permissions problem surfaces at boot rather than on the first request.
 */
const storageProviderFactory: Provider = {
  provide: STORAGE_PROVIDER,
  inject: [ConfigService],
  useFactory: async (config: ConfigService<EnvironmentVariables, true>): Promise<StorageProvider> => {
    const logger = new Logger('StorageModule');
    const kind = config.getOrThrow<StorageProviderKind>('STORAGE_PROVIDER');

    if (kind === 's3') {
      const s3Config: S3StorageConfig = {
        endpoint: config.get<string>('S3_ENDPOINT'),
        region: config.getOrThrow<string>('S3_REGION'),
        bucket: config.getOrThrow<string>('S3_BUCKET'),
        accessKeyId: config.getOrThrow<string>('S3_ACCESS_KEY_ID'),
        secretAccessKey: config.getOrThrow<string>('S3_SECRET_ACCESS_KEY'),
        forcePathStyle: config.getOrThrow<boolean>('S3_FORCE_PATH_STYLE'),
        publicBaseUrl: config.get<string>('S3_PUBLIC_BASE_URL'),
      };
      logger.log(`Storage provider: s3 (bucket "${s3Config.bucket}", region ${s3Config.region})`);
      return new S3StorageProvider(s3Config);
    }

    const localConfig: LocalStorageConfig = {
      // Relative roots resolve against `process.cwd()`, which is `apps/backend`
      // for both `pnpm run start` and the Jest suites, so the same files are
      // reused instead of scattering uploads across the repository.
      root: resolve(config.getOrThrow<string>('STORAGE_LOCAL_ROOT')),
      publicBaseUrl: config.getOrThrow<string>('STORAGE_PUBLIC_BASE_URL'),
    };
    const provider = new LocalStorageProvider(localConfig);
    await provider.ensureRoot();
    logger.log(`Storage provider: local (root ${provider.rootDirectory})`);
    return provider;
  },
};

@Module({
  providers: [storageProviderFactory, StorageService],
  exports: [STORAGE_PROVIDER, StorageService],
})
export class StorageModule {}
