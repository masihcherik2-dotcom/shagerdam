import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { MAX_STOCK } from '../../products/product-rules';
import { MAX_BULK_URLS } from '../bulk/bulk-import.service';
import { BULK_ITEM_NOTES, type BulkItemNote, type BulkItemStatus, type BulkJobStatus } from '../bulk/bulk-job.types';
import { PRICE_UNIT_OPTIONS, type PriceUnitOption } from '../bulk/product-draft';
import { MAX_CRAWL_PRODUCTS } from '../crawler/sitemap';
import { MAX_IMPORT_URL_LENGTH } from '../net/import-url';

/** Pasted sitemap/link list: must fit the API's 1 MB request body. */
export const MAX_SITEMAP_CONTENT_LENGTH = 900_000;

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const trimEach = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value) ? (value as unknown[]).map((entry): unknown => (typeof entry === 'string' ? entry.trim() : entry)) : value;
const nullable = (_: object, value: unknown): boolean => value !== null;

// ─── Requests ───────────────────────────────────────────────────────────────

export class CrawlStoreDto {
  @ApiPropertyOptional({
    example: 'https://zarrinmetal.ir',
    maxLength: MAX_IMPORT_URL_LENGTH,
    description: 'Store address (a bare domain is accepted) or the URL of a sitemap. Optional when sitemapContent is sent.',
  })
  @IsOptionalNonNullable()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_IMPORT_URL_LENGTH)
  storeUrl?: string;

  @ApiPropertyOptional({
    maxLength: MAX_SITEMAP_CONTENT_LENGTH,
    description:
      'Geo-IP fallback: the text of a sitemap (XML) or a list of product links, pasted by the user. When present, the ' +
      'store is not fetched (child sitemaps of a pasted sitemap index are still fetched, best effort).',
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(MAX_SITEMAP_CONTENT_LENGTH)
  sitemapContent?: string;

  @ApiPropertyOptional({ example: 200, minimum: 1, maximum: MAX_CRAWL_PRODUCTS, default: MAX_CRAWL_PRODUCTS })
  @IsOptionalNonNullable()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_CRAWL_PRODUCTS)
  maxProducts?: number;
}

class BulkOptionsDto {
  @ApiPropertyOptional({
    default: true,
    description: 'Publish every created product at once (default). Send false to save them unpublished, as drafts. Created variants are always active.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  autoPublish?: boolean;

  @ApiPropertyOptional({
    enum: PRICE_UNIT_OPTIONS,
    default: 'AUTO',
    description:
      'Unit of the prices on the source site. AUTO = what the page declares (visible currency symbol first, then structured data); ' +
      'IRR/IRT override it (many Iranian shops declare IRR while pricing in toman).',
  })
  @IsOptionalNonNullable()
  @IsIn(PRICE_UNIT_OPTIONS)
  priceUnit?: PriceUnitOption;

  @ApiPropertyOptional({ default: 10, minimum: 0, maximum: MAX_STOCK, description: 'Stock of products the source shows as available (sources never publish quantities). Unavailable ones get 0.' })
  @IsOptionalNonNullable()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  defaultStock?: number;

  @ApiPropertyOptional({ format: 'uuid', nullable: true, type: String, description: 'Category for products whose source category matches no local category. Without it, such products end as NEEDS_REVIEW.' })
  @ValidateIf(nullable)
  @IsOptionalNonNullable()
  @IsUUID()
  defaultCategoryId?: string | null;
}

export class BulkExtractDto extends BulkOptionsDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_BULK_URLS,
    example: ['https://zarrinmetal.ir/product/sample-1/', 'https://zarrinmetal.ir/product/sample-2/'],
    description: 'Product pages to import (usually the productUrls of crawl-store). Duplicates are ignored; one invalid/internal URL rejects the request.',
  })
  @Transform(trimEach)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_URLS)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_IMPORT_URL_LENGTH, { each: true })
  urls!: string[];

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: MAX_IMPORT_URL_LENGTH, description: 'The crawled store address, shown with the job.' })
  @ValidateIf(nullable)
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(MAX_IMPORT_URL_LENGTH)
  storeUrl?: string | null;
}

export class RetryBulkJobDto extends BulkOptionsDto {
  @ApiPropertyOptional({
    type: [Number],
    maxItems: MAX_BULK_URLS,
    description: 'Items to retry (index). Default: every PENDING, interrupted, FAILED and NEEDS_REVIEW item. SUCCEEDED/SKIPPED items are never re-run.',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_BULK_URLS)
  @IsInt({ each: true })
  @Min(0, { each: true })
  itemIndexes?: number[];
}

// ─── Responses ──────────────────────────────────────────────────────────────

export class CrawlStoreResponseDto {
  @ApiProperty({ example: 'https://zarrinmetal.ir/', description: 'Normalised store address ("" for pasted content without an address).' })
  storeUrl!: string;

  @ApiProperty({ example: 184, description: 'Product URLs found in the scanned sitemaps.' })
  totalFound!: number;

  @ApiProperty({ type: [String], description: 'The first maxProducts product URLs, in sitemap order.' })
  productUrls!: string[];

  @ApiProperty({ type: [String], example: ['https://zarrinmetal.ir/product-sitemap.xml'] })
  sitemapsScanned!: string[];

  @ApiProperty({ type: [String], description: 'Non-fatal problems (unreachable sitemaps, truncated scan).' })
  warnings!: string[];
}

export class BulkExtractResponseDto {
  @ApiProperty({ format: 'uuid' })
  jobId!: string;

  @ApiProperty({ example: 184 })
  totalProducts!: number;
}

class BulkJobOptionsDto {
  @ApiProperty()
  autoPublish!: boolean;

  @ApiProperty({ enum: PRICE_UNIT_OPTIONS })
  priceUnit!: PriceUnitOption;

  @ApiProperty()
  defaultStock!: number;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  defaultCategoryId!: string | null;
}

class BulkJobCountsDto {
  @ApiProperty() pending!: number;
  @ApiProperty() processing!: number;
  @ApiProperty() succeeded!: number;
  @ApiProperty() skipped!: number;
  @ApiProperty() needsReview!: number;
  @ApiProperty() failed!: number;
}

class BulkItemProductDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() isPublished!: boolean;
}

export class BulkItemDto {
  @ApiProperty() index!: number;
  @ApiProperty() url!: string;

  @ApiProperty({ enum: ['PENDING', 'PROCESSING', 'SUCCEEDED', 'SKIPPED', 'NEEDS_REVIEW', 'FAILED'] })
  status!: BulkItemStatus;

  @ApiProperty() attempts!: number;

  @ApiProperty({ nullable: true, type: String, example: 'IMPORT_TIMEOUT', description: 'IMPORT_* importer codes, NO_PRICE, UNKNOWN_CURRENCY, FOREIGN_CURRENCY, NO_CATEGORY, ALREADY_IMPORTED, INVALID_DRAFT, INTERRUPTED, HTTP_<status>, INTERNAL.' })
  code!: string | null;

  @ApiProperty({ nullable: true, type: String }) message!: string | null;

  @ApiProperty({ enum: BULK_ITEM_NOTES, isArray: true, description: 'Remarks on a created product (empty for other statuses).' })
  notes!: BulkItemNote[];

  @ApiProperty({ nullable: true, type: String }) title!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Thumbnail of the first imported image.' }) imageUrl!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: 'Selling price (IRR).' }) price!: number | null;
  @ApiProperty({ nullable: true, type: () => BulkItemProductDto }) product!: BulkItemProductDto | null;
  @ApiProperty() updatedAt!: string;
}

export class BulkJobDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) vendorId!: string;
  @ApiProperty({ description: 'Started by staff on behalf of the store.' }) staff!: boolean;
  @ApiProperty({ nullable: true, type: String }) storeUrl!: string | null;
  @ApiProperty({ type: () => BulkJobOptionsDto }) options!: BulkJobOptionsDto;

  @ApiProperty({ enum: ['RUNNING', 'COMPLETED', 'CANCELLED', 'INTERRUPTED'] })
  status!: BulkJobStatus;

  @ApiProperty() total!: number;
  @ApiProperty() runs!: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
  @ApiProperty({ nullable: true, type: String }) finishedAt!: string | null;
  @ApiProperty({ type: () => BulkJobCountsDto }) counts!: BulkJobCountsDto;
  @ApiProperty() processed!: number;
  @ApiProperty({ minimum: 0, maximum: 100 }) progressPercent!: number;
  @ApiProperty({ type: () => [BulkItemDto] }) items!: BulkItemDto[];
}

export class LatestBulkJobDto {
  @ApiProperty({ type: () => BulkJobDto, nullable: true, description: 'The store’s most recent job (kept 7 days), or null.' })
  job!: BulkJobDto | null;
}
