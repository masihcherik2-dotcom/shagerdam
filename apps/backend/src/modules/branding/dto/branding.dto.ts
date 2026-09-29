import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { MAX_BANNER_TITLE_LENGTH, MAX_HERO_BANNERS, MAX_LINK_URL_LENGTH } from '../branding-rules';

// ─── Public ──────────────────────────────────────────────────────────────────

export class PublicHeroBannerDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'https://api.example.ir/api/v1/media/files/images/branding_hero_banner/2026/10/….webp' })
  imageUrl!: string;

  @ApiProperty({ type: String, nullable: true, example: 'حراج پاییزه' })
  title!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '/search?categorySlug=fashion' })
  linkUrl!: string | null;

  @ApiProperty({ example: 1 })
  sortOrder!: number;
}

export class PublicBrandingDto {
  @ApiProperty({ type: String, nullable: true, description: 'null → نمایش لوگوی پیش‌فرض (مونوگرام «ش»)' })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'null → همان logoUrl یا مونوگرام' })
  mobileLogoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  faviconUrl!: string | null;

  @ApiProperty({ type: [PublicHeroBannerDto], description: 'فقط بنرهای فعال، به ترتیب sortOrder' })
  heroBanners!: PublicHeroBannerDto[];
}

// ─── Admin ───────────────────────────────────────────────────────────────────

export class AdminHeroBannerDto extends PublicHeroBannerDto {
  @ApiProperty()
  isActive!: boolean;
}

export class BrandingUpdatedAtDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  mobileLogoUrl!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  faviconUrl!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  heroBanners!: string | null;
}

export class BrandingHistoryActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  fullName!: string;
}

export class BrandingHistoryEntryDto {
  @ApiProperty({ format: 'uuid', description: 'شناسهٔ ردیف AuditLog' })
  id!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: string;

  @ApiProperty({ type: BrandingHistoryActorDto, nullable: true })
  actor!: BrandingHistoryActorDto | null;

  @ApiProperty({ type: [String], example: ['logoUrl', 'heroBanners'] })
  changedFields!: string[];
}

export class AdminBrandingDto {
  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  mobileLogoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  faviconUrl!: string | null;

  @ApiProperty({ type: [AdminHeroBannerDto], description: 'همهٔ بنرها (فعال و غیرفعال)' })
  heroBanners!: AdminHeroBannerDto[];

  @ApiProperty({ type: BrandingUpdatedAtDto, description: 'زمان آخرین تغییر هر کلید (null = هرگز تنظیم نشده)' })
  updatedAt!: BrandingUpdatedAtDto;

  @ApiProperty({ type: [BrandingHistoryEntryDto], description: 'آخرین تغییرات (از AuditLog)' })
  history!: BrandingHistoryEntryDto[];

  @ApiPropertyOptional({ format: 'uuid', description: 'فقط در پاسخ PATCH: شناسهٔ ردیف AuditLog این تغییر' })
  auditLogId?: string;
}

export class HeroBannerInputDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'برای بنر موجود ارسال شود؛ بنر جدید بدون id (سرور می‌سازد)' })
  @IsOptional()
  @IsUUID()
  id?: string;

  @ApiProperty({ description: 'آدرس تصویری که با slot=hero_banner بارگذاری شده است' })
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  imageUrl!: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: MAX_BANNER_TITLE_LENGTH })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_BANNER_TITLE_LENGTH)
  title?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    maxLength: MAX_LINK_URL_LENGTH,
    description: 'مسیر داخلی (/search?categorySlug=fashion) یا آدرس https://',
  })
  @IsOptional()
  @IsString()
  @MaxLength(MAX_LINK_URL_LENGTH)
  linkUrl?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 1000, description: 'پیش‌فرض: جایگاه در آرایه' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Partial update: omitted fields are left unchanged; `null` clears a logo
 * (back to the default monogram); `heroBanners` replaces the whole list.
 */
export class UpdateBrandingDto {
  @ApiPropertyOptional({ type: String, nullable: true, description: 'null = حذف و بازگشت به لوگوی پیش‌فرض' })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  logoUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  mobileLogoUrl?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf((_, value) => value !== null && value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(1024)
  faviconUrl?: string | null;

  @ApiPropertyOptional({ type: [HeroBannerInputDto], maxItems: MAX_HERO_BANNERS, description: 'فهرست کامل بنرها (جایگزین فهرست قبلی)' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_HERO_BANNERS)
  @ValidateNested({ each: true })
  @Type(() => HeroBannerInputDto)
  heroBanners?: HeroBannerInputDto[];
}

export class BrandingAssetUploadResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: ['logo', 'mobile_logo', 'favicon', 'hero_banner'] })
  slot!: string;

  @ApiProperty()
  url!: string;

  @ApiProperty()
  thumbnailUrl!: string;

  @ApiProperty({ example: 'image/webp' })
  mimeType!: string;

  @ApiProperty()
  width!: number;

  @ApiProperty()
  height!: number;

  @ApiProperty()
  sizeBytes!: number;

  @ApiProperty()
  originalSizeBytes!: number;
}
