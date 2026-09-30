import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { PRODUCT_SLUG_MAX_LENGTH, PRODUCT_SLUG_PATTERN } from '../catalog-text';
import {
  COLOR_HEX_PATTERN,
  MAX_MEDIA_PER_PRODUCT,
  MAX_MONEY,
  MAX_SPECIFICATIONS_PER_PRODUCT,
  SPECIFICATION_GROUP_MAX_LENGTH,
  SPECIFICATION_TITLE_MAX_LENGTH,
  SPECIFICATION_VALUE_MAX_LENGTH,
  MAX_STOCK,
  MAX_VARIANTS_PER_PRODUCT,
  SKU_PATTERN,
  normalizeColorHex,
  normalizeSku,
} from '../product-rules';

const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const toSku = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? normalizeSku(value) : value);
const toHex = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? normalizeColorHex(value) : value);
const toSlug = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const nullable = (_object: object, value: unknown): boolean => value !== null && value !== undefined;

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export class CreateVariantDto {
  @ApiProperty({
    example: 'SHP-A55-256-BLK',
    maxLength: 64,
    description: 'Globally unique stock-keeping unit. Upper-cased on input; letters, digits, ".", "_" and "-".',
  })
  @Transform(toSku)
  @IsString()
  @Matches(SKU_PATTERN, {
    message: 'sku must be 1–64 characters of A–Z, 0–9, ".", "_" or "-", starting and ending with a letter or digit',
  })
  sku!: string;

  @ApiPropertyOptional({ example: 'مشکی', maxLength: 40, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  colorName?: string | null;

  @ApiPropertyOptional({ example: '#111827', pattern: COLOR_HEX_PATTERN.source, nullable: true, type: String })
  @Transform(toHex)
  @ValidateIf(nullable)
  @IsString()
  @Matches(COLOR_HEX_PATTERN, { message: 'colorHex must be a 6-digit hex colour such as #1D4ED8' })
  colorHex?: string | null;

  @ApiPropertyOptional({ example: 'XL', maxLength: 20, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  size?: string | null;

  @ApiPropertyOptional({ example: '۱۸ ماه گارانتی شرکتی', maxLength: 60, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  guarantee?: string | null;

  @ApiProperty({ example: 42500000, description: 'Selling price the buyer pays (IRR, two decimals, > 0).' })
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  price!: number;

  @ApiPropertyOptional({
    example: 45000000,
    nullable: true,
    type: Number,
    description: 'Original (strike-through) price. When present it must be strictly greater than price.',
  })
  @ValidateIf(nullable)
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  compareAtPrice?: number | null;

  @ApiProperty({ example: 12, minimum: 0, maximum: MAX_STOCK })
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  stockQuantity!: number;

  @ApiPropertyOptional({ example: 202, minimum: 1, maximum: MAX_STOCK, nullable: true, type: Number })
  @ValidateIf(nullable)
  @IsInt()
  @Min(1)
  @Max(MAX_STOCK)
  weightGrams?: number | null;

  @ApiPropertyOptional({ default: true, description: 'Inactive variants are kept but never sold or listed.' })
  @IsOptionalNonNullable()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Quick update of one variant. `stockQuantity` sets an absolute value;
 * `stockDelta` adjusts atomically relative to the current value (e.g. `-3`
 * after a manual sale). They are mutually exclusive.
 */
export class UpdateVariantDto {
  @ApiPropertyOptional({ example: 41900000, description: 'New selling price (> 0).' })
  @IsOptionalNonNullable()
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  price?: number;

  @ApiPropertyOptional({
    example: 45000000,
    nullable: true,
    type: Number,
    description: 'New strike-through price; null removes the discount. Must stay greater than the (new) price.',
  })
  @ValidateIf(nullable)
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  compareAtPrice?: number | null;

  @ApiPropertyOptional({ example: 20, minimum: 0, maximum: MAX_STOCK, description: 'Absolute on-hand stock.' })
  @IsOptionalNonNullable()
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  stockQuantity?: number;

  @ApiPropertyOptional({
    example: -3,
    minimum: -MAX_STOCK,
    maximum: MAX_STOCK,
    description: 'Relative, atomic stock change. Refused when it would take stock below the reserved quantity.',
  })
  @IsOptionalNonNullable()
  @IsInt()
  @Min(-MAX_STOCK)
  @Max(MAX_STOCK)
  @NotEquals(0, { message: 'stockDelta must not be 0' })
  stockDelta?: number;

  @ApiPropertyOptional({ description: 'Deactivating the last active variant of a published product is refused.' })
  @IsOptionalNonNullable()
  @IsBoolean()
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Technical specifications
// ---------------------------------------------------------------------------

export class ProductSpecificationInputDto {
  @ApiPropertyOptional({ example: 'حافظه', maxLength: SPECIFICATION_GROUP_MAX_LENGTH, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(SPECIFICATION_GROUP_MAX_LENGTH)
  groupTitle?: string | null;

  @ApiProperty({ example: 'حافظه داخلی', minLength: 1, maxLength: SPECIFICATION_TITLE_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(SPECIFICATION_TITLE_MAX_LENGTH)
  title!: string;

  @ApiProperty({ example: '256 گیگابایت', minLength: 1, maxLength: SPECIFICATION_VALUE_MAX_LENGTH, description: 'May contain line breaks.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(SPECIFICATION_VALUE_MAX_LENGTH)
  value!: string;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export class CreateProductDto {
  @ApiProperty({ example: 'گوشی موبایل سامسونگ Galaxy A55 ظرفیت ۲۵۶ گیگابایت', minLength: 3, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({
    example: 'galaxy-a55-256',
    maxLength: PRODUCT_SLUG_MAX_LENGTH,
    description:
      'Custom unique slug (lowercase letters of any script, digits, single hyphens). ' +
      'Omit it to generate one from the title; a numeric suffix is added when the generated slug is taken.',
  })
  @Transform(toSlug)
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(PRODUCT_SLUG_MAX_LENGTH)
  @Matches(PRODUCT_SLUG_PATTERN, { message: 'slug must contain lowercase letters, digits and single hyphens only' })
  slug?: string;

  @ApiPropertyOptional({ example: 'نمایشگر ۶٫۶ اینچی Super AMOLED…', maxLength: 20000, nullable: true, type: String })
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(20000)
  description?: string | null;

  @ApiProperty({ format: 'uuid', description: 'An active category.' })
  @IsUUID('4', { message: 'categoryId must be a UUID' })
  categoryId!: string;

  @ApiPropertyOptional({ example: 'Samsung', maxLength: 80, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brand?: string | null;

  @ApiProperty({ example: 42500000, description: 'Reference price of the product (IRR, > 0). Variants carry the selling prices.' })
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  basePrice!: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_MEDIA_PER_PRODUCT,
    description:
      'Ordered gallery: ids returned by POST /media/upload/image with purpose "product_image", uploaded by this account. ' +
      'The first image is the primary one.',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_PER_PRODUCT)
  @ArrayUnique({ message: 'mediaIds must not contain the same image twice' })
  @IsUUID('4', { each: true, message: 'each mediaIds entry must be a UUID' })
  mediaIds?: string[];

  @ApiPropertyOptional({
    type: () => [ProductSpecificationInputDto],
    maxItems: MAX_SPECIFICATIONS_PER_PRODUCT,
    description: 'Technical specifications in display order (typed, or pre-filled by the product importer).',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_SPECIFICATIONS_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => ProductSpecificationInputDto)
  specifications?: ProductSpecificationInputDto[];

  @ApiProperty({ type: () => [CreateVariantDto], minItems: 1, maxItems: MAX_VARIANTS_PER_PRODUCT })
  @IsArray()
  @ArrayMinSize(1, { message: 'a product needs at least one variant' })
  @ArrayMaxSize(MAX_VARIANTS_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants!: CreateVariantDto[];

  @ApiPropertyOptional({
    default: false,
    description: 'Publish immediately. Requires at least one active variant; otherwise the product is saved as a draft.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 200 })
  @Transform(trim)
  @IsOptionalNonNullable()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: PRODUCT_SLUG_MAX_LENGTH })
  @Transform(toSlug)
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(PRODUCT_SLUG_MAX_LENGTH)
  @Matches(PRODUCT_SLUG_PATTERN, { message: 'slug must contain lowercase letters, digits and single hyphens only' })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 20000, nullable: true, type: String, description: 'null clears the description.' })
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(20000)
  description?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptionalNonNullable()
  @IsUUID('4', { message: 'categoryId must be a UUID' })
  categoryId?: string;

  @ApiPropertyOptional({ maxLength: 80, nullable: true, type: String, description: 'null clears the brand.' })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brand?: string | null;

  @ApiPropertyOptional({ example: 41900000 })
  @IsOptionalNonNullable()
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  basePrice?: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_MEDIA_PER_PRODUCT,
    description: 'Replaces the whole gallery in the given order (use it to re-order, add or remove images). [] clears it.',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_PER_PRODUCT)
  @ArrayUnique({ message: 'mediaIds must not contain the same image twice' })
  @IsUUID('4', { each: true, message: 'each mediaIds entry must be a UUID' })
  mediaIds?: string[];

  @ApiPropertyOptional({
    type: () => [ProductSpecificationInputDto],
    maxItems: MAX_SPECIFICATIONS_PER_PRODUCT,
    description: 'Replaces the whole specification list in the given order. [] clears it.',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_SPECIFICATIONS_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => ProductSpecificationInputDto)
  specifications?: ProductSpecificationInputDto[];

  @ApiPropertyOptional({
    description:
      'Publish or unpublish. Publishing needs at least one active variant and is refused while the product is blocked by staff.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isPublished?: boolean;
}

/** Staff moderation of one product. */
export class AdminProductStatusDto {
  @ApiPropertyOptional({
    description:
      'true blocks the product (it disappears from the storefront and is unpublished); false lifts the block. ' +
      'Lifting a block does not re-publish: the vendor decides when to publish again.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isBlockedByAdmin?: boolean;

  @ApiPropertyOptional({
    example: 'تصاویر محصول با مشخصات درج‌شده مطابقت ندارد.',
    minLength: 10,
    maxLength: 500,
    nullable: true,
    type: String,
    description: 'Required when blocking; shown to the vendor. Must be omitted or null otherwise.',
  })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  blockedReason?: string | null;

  @ApiPropertyOptional({
    description: 'Staff may unpublish any product; publishing is only possible for an unblocked product with an active variant.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isPublished?: boolean;
}
