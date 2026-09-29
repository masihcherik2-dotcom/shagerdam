import { ApiProperty } from '@nestjs/swagger';
import { MediaKind } from '@prisma/client';
import type { MediaAssetView } from '../media.service';

export class ImageUploadResponseDto {
  @ApiProperty({ format: 'uuid', example: '9f1c2e34-…' })
  id!: string;

  @ApiProperty({ example: '/api/v1/media/files/images/store_logo/2026/09/9f1c2e34….webp' })
  url!: string;

  @ApiProperty({ example: '/api/v1/media/files/images/store_logo/2026/09/9f1c2e34…_thumb.webp' })
  thumbnailUrl!: string;

  @ApiProperty({ example: 'image/webp', enum: ['image/webp'] })
  mimeType!: 'image/webp';

  @ApiProperty({ example: 48_213, description: 'حجم فایل ذخیره‌شده (پس از تبدیل به WebP)' })
  sizeBytes!: number;

  @ApiProperty({ example: 1_284_331, description: 'حجم فایل ارسالی کاربر' })
  originalSizeBytes!: number;

  @ApiProperty({ example: 1600 })
  width!: number;

  @ApiProperty({ example: 1200 })
  height!: number;

  @ApiProperty({ example: 0.0375, description: 'نسبت حجم خروجی به ورودی' })
  compressionRatio!: number;
}

export class DocumentUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '/api/v1/media/documents/9f1c2e34…/download' })
  url!: string;

  @ApiProperty({ example: 'national-card.jpg' })
  originalName!: string;

  @ApiProperty({ example: 842_331 })
  sizeBytes!: number;

  @ApiProperty({ example: 'image/jpeg' })
  mimeType!: string;

  @ApiProperty({
    example: false,
    description: 'مدارک همیشه خصوصی هستند و فقط برای مالک یا کارکنان قابل دانلوداند',
  })
  isPublic!: false;
}

export class MediaAssetDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: MediaKind })
  kind!: MediaKind;

  @ApiProperty({ example: 'store_logo' })
  purpose!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty({ nullable: true })
  thumbnailUrl!: string | null;

  @ApiProperty({ example: 'image/webp' })
  mimeType!: string;

  @ApiProperty({ example: 48_213 })
  sizeBytes!: number;

  @ApiProperty({ nullable: true })
  width!: number | null;

  @ApiProperty({ nullable: true })
  height!: number | null;

  @ApiProperty({ nullable: true })
  originalName!: string | null;

  @ApiProperty({ description: 'آیا بدون احراز هویت قابل دریافت است؟' })
  isPublic!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

/**
 * Maps the internal view to the public representation, dropping the storage key.
 * Used by every endpoint that returns an asset so the omission is enforced in one
 * place rather than by remembering to omit a field.
 */
export function toMediaAssetDto(view: MediaAssetView): MediaAssetDto {
  return {
    id: view.id,
    kind: view.kind,
    purpose: view.purpose,
    url: view.url,
    thumbnailUrl: view.thumbnailUrl,
    mimeType: view.mimeType,
    sizeBytes: view.sizeBytes,
    width: view.width,
    height: view.height,
    originalName: view.originalName,
    isPublic: view.isPublic,
    createdAt: view.createdAt,
  };
}

export class StorageProviderInfoDto {
  @ApiProperty({ example: 'local', enum: ['local', 's3'] })
  provider!: string;

  @ApiProperty({ example: true, description: 'فایل روی دیسک همین سرور ذخیره می‌شود (محیط توسعه)' })
  isLocal!: boolean;

  @ApiProperty({ example: 5_242_880, description: 'سقف حجم تصویر به بایت' })
  maxImageBytes!: number;

  @ApiProperty({ example: 10_485_760, description: 'سقف حجم مدرک به بایت' })
  maxDocumentBytes!: number;
}
