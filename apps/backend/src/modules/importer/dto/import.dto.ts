import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_MEDIA_PER_PRODUCT } from '../../products/product-rules';
import { MAX_IMPORT_URL_LENGTH } from '../net/import-url';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const trimEach = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value) ? (value as unknown[]).map((entry): unknown => (typeof entry === 'string' ? entry.trim() : entry)) : value;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export class ExtractSpecDto {
  @ApiProperty({
    example: 'https://www.digikala.com/product/dkp-13196935/',
    maxLength: MAX_IMPORT_URL_LENGTH,
    description:
      'Product page to read: a Digikala product URL (…/product/dkp-<id>/…) or any storefront page publishing ' +
      'schema.org Product (JSON-LD / microdata), WooCommerce attributes or OpenGraph product tags. http(s) on ports 80/443 only; ' +
      'private, loopback and reserved network targets are refused.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_IMPORT_URL_LENGTH)
  url!: string;
}

export class IngestImagesDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_MEDIA_PER_PRODUCT,
    example: ['https://dkstatics-public.digikala.com/digikala-products/47ed1a2e4cc50360e929b6e8a1ca3f0696d69be8_1698777217.jpg'],
    description: `Remote images to download into the media pipeline (at most ${MAX_MEDIA_PER_PRODUCT}, the size of a product gallery). Duplicates are ignored.`,
  })
  @Transform(trimEach)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MEDIA_PER_PRODUCT)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_IMPORT_URL_LENGTH, { each: true })
  imageUrls!: string[];
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class ExtractedSpecificationDto {
  @ApiProperty({ example: 'حافظه', nullable: true, type: String, description: 'Specification group on the source page.' })
  group!: string | null;

  @ApiProperty({ example: 'حافظه داخلی' })
  title!: string;

  @ApiProperty({ example: '256 گیگابایت' })
  value!: string;
}

export class ExtractedOfferDto {
  @ApiProperty({ example: 18500000, description: 'Selling price in the source unit (see currency).' })
  amount!: number;

  @ApiProperty({ example: 21000000, nullable: true, type: Number, description: 'Original (strike-through) price, same unit.' })
  oldAmount!: number | null;

  @ApiProperty({
    example: 'IRT',
    nullable: true,
    type: String,
    description: 'IRR (rial), IRT (toman), IRHT (thousand toman), another ISO code as published, or null when the page names none.',
  })
  currency!: string | null;

  @ApiProperty({ example: true, nullable: true, type: Boolean })
  inStock!: boolean | null;
}

export class ExtractSpecResponseDto {
  @ApiProperty({ enum: ['DIGIKALA', 'GENERIC'], example: 'DIGIKALA' })
  source!: 'DIGIKALA' | 'GENERIC';

  @ApiProperty({
    type: [String],
    example: ['DIGIKALA_API'],
    description: 'Parsers whose data is in this draft: DIGIKALA_API, JSON_LD, MICRODATA, WOOCOMMERCE_ATTRIBUTES, OPEN_GRAPH, HTML_META.',
  })
  strategies!: string[];

  @ApiProperty({ example: 'https://www.digikala.com/product/dkp-13196935/' })
  sourceUrl!: string;

  @ApiProperty({ example: 'dkp-13196935', nullable: true, type: String })
  sourceProductId!: string | null;

  @ApiProperty({ example: 'گوشی موبایل سامسونگ مدل Galaxy S24 Ultra' })
  title!: string;

  @ApiProperty({ example: 'Samsung Galaxy S24 Ultra', nullable: true, type: String })
  titleEn!: string | null;

  @ApiProperty({ example: 'سامسونگ', nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ example: 'توضیحات و نقد و بررسی محصول…', nullable: true, type: String, description: 'Plain text; paragraphs separated by line breaks.' })
  description!: string | null;

  @ApiProperty({ example: 'گوشی موبایل', nullable: true, type: String })
  suggestedCategory!: string | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Active local category whose name matches the source category (or one of its breadcrumb parents), if any.',
  })
  suggestedCategoryId!: string | null;

  @ApiProperty({ type: () => [ExtractedSpecificationDto] })
  specifications!: ExtractedSpecificationDto[];

  @ApiProperty({ type: [String], description: 'Absolute image URLs, best available resolution, primary image first.' })
  imageUrls!: string[];

  @ApiProperty({ type: () => ExtractedOfferDto, nullable: true, description: 'Price and availability as published by the page (source unit), or null.' })
  offer!: ExtractedOfferDto | null;
}

export class IngestedImageDto {
  @ApiProperty({ description: 'The remote URL this asset was created from.' })
  sourceUrl!: string;

  @ApiProperty({ format: 'uuid', description: 'Media asset id — usable in mediaIds of POST /vendor/products.' })
  id!: string;

  @ApiProperty({ example: '/api/v1/media/files/images/product_image/2026/10/….webp' })
  url!: string;

  @ApiProperty({ example: '/api/v1/media/files/images/product_image/2026/10/…_thumb.webp' })
  thumbnailUrl!: string;

  @ApiProperty({ example: 1200 })
  width!: number;

  @ApiProperty({ example: 1200 })
  height!: number;

  @ApiProperty({ example: 84210, description: 'Stored WebP size in bytes.' })
  sizeBytes!: number;
}

export class FailedImageDto {
  @ApiProperty()
  sourceUrl!: string;

  @ApiProperty({ example: 'TOO_LARGE', description: 'Importer error code, or INVALID_IMAGE when the media pipeline rejected the file.' })
  code!: string;

  @ApiProperty({ example: 'The response is larger than 5 MB' })
  message!: string;
}

export class IngestImagesResponseDto {
  @ApiProperty({ type: () => [IngestedImageDto], description: 'Stored assets, in the order requested.' })
  items!: IngestedImageDto[];

  @ApiProperty({ type: () => [FailedImageDto], description: 'Images that could not be imported, with the reason. The others are still stored.' })
  failures!: FailedImageDto[];
}
