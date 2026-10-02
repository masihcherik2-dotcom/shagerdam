import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { MAX_MONEY } from '../product-rules';

/** Query-string booleans arrive as text. Anything else is left for the validator to reject. */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' || value === '1' ? true : value === 'false' || value === '0' ? false : value;

/**
 * Accepts `?colors=a&colors=b`, `?colors=a,b` or a mix of both; trims entries and
 * drops empty ones.
 */
const toList = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null) {
    return undefined;
  }
  const raw: unknown[] = Array.isArray(value) ? (value as unknown[]) : [value];
  if (!raw.every((entry): entry is string => typeof entry === 'string')) {
    return value;
  }
  return raw
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
};

export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'popular'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

export const VENDOR_PRODUCT_STATUSES = ['published', 'draft', 'blocked'] as const;
export type VendorProductStatus = (typeof VENDOR_PRODUCT_STATUSES)[number];

/** Public catalogue search. */
export class PublicProductQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'سامسونگ',
    maxLength: 100,
    description: 'Substring match on title, brand and description (Persian keyboard variants and digit scripts are normalised).',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ example: 'digital-goods', description: 'Includes products of this category and all its descendants.' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  categorySlug?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Alternative to categorySlug (same descendant semantics).' })
  @IsOptional()
  @IsUUID('4', { message: 'categoryId must be a UUID' })
  categoryId?: string;

  @ApiPropertyOptional({ example: 'shopino-sample-store' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  vendorSlug?: string;

  @ApiPropertyOptional({ example: 1000000, minimum: 0, description: 'Lowest selling price of a matching variant (IRR).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  minPrice?: number;

  @ApiPropertyOptional({ example: 50000000, minimum: 0, description: 'Highest selling price of a matching variant (IRR).' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0)
  @Max(MAX_MONEY)
  maxPrice?: number;

  @ApiPropertyOptional({ description: 'Only products with at least one matching variant that has sellable stock.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  inStockOnly?: boolean;

  @ApiPropertyOptional({ description: 'Only products with at least one discounted variant (compareAtPrice > price); combined with the other variant filters on the same variant.' })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  onSaleOnly?: boolean;

  @ApiPropertyOptional({
    type: [String],
    example: ['مشکی', '#1D4ED8'],
    description: 'Colour names (case-insensitive) or #RRGGBB codes. Repeat the parameter or separate with commas.',
  })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  colors?: string[];

  @ApiPropertyOptional({ type: [String], example: ['L', 'XL'], description: 'Sizes (case-insensitive).' })
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(20, { each: true })
  sizes?: string[];

  @ApiPropertyOptional({
    enum: PRODUCT_SORTS,
    default: 'newest',
    description:
      'newest: creation time. price_asc / price_desc: lowest matching variant price. ' +
      'popular: units sold (cancelled and refunded orders excluded), newest first on ties.',
  })
  @IsOptional()
  @IsIn(PRODUCT_SORTS, { message: `sortBy must be one of: ${PRODUCT_SORTS.join(', ')}` })
  sortBy: ProductSort = 'newest';
}

/** The vendor's own catalogue. */
export class VendorProductQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 100, description: 'Matches title, slug or a variant SKU.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({
    enum: VENDOR_PRODUCT_STATUSES,
    description: 'published: live (unless hidden by store/category state); draft: not published; blocked: blocked by staff.',
  })
  @IsOptional()
  @IsIn(VENDOR_PRODUCT_STATUSES, { message: `status must be one of: ${VENDOR_PRODUCT_STATUSES.join(', ')}` })
  status?: VendorProductStatus;
}

/** Staff review listing. */
export class AdminProductQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ maxLength: 100, description: 'Matches title, slug or a variant SKU.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  search?: string;

  @ApiPropertyOptional({ example: 'shopino-sample-store' })
  @IsOptional()
  @IsString()
  @MaxLength(140)
  vendorSlug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isBlockedByAdmin?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isPublished?: boolean;
}
