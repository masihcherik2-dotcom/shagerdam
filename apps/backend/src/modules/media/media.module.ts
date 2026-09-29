import { Module } from '@nestjs/common';
import { StorageModule } from '../storage/storage.module';
import { MediaController } from './media.controller';
import { MediaService } from './media.service';

/**
 * Media module: the Sharp pipeline plus the file-serving routes on top of the
 * pluggable storage engine.
 *
 * `MediaService` is exported because the vendor workflow (logo, KYC documents)
 * validates that a referenced document really belongs to the caller before it is
 * attached to a profile.
 */
@Module({
  imports: [StorageModule],
  controllers: [MediaController],
  providers: [MediaService],
  exports: [MediaService],
})
export class MediaModule {}
