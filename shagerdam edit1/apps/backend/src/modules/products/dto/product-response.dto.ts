import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorStatus } from '@prisma/client';
import { CategorySummaryDto } from '../../categories/dto/category-response.dto';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export class PriceRangeDto {
  @ApiProperty({ example: '42500000.00', description: 'Lowest selling price among the variants considered.' })
  min!: string;

  @ApiProperty({ example: '42900000.00', description: 'Highest selling price among the variants considered.' })
  max!: string;
}

export class StockSummaryDto {
  @ApiProperty({ example: 3 })
  variantCount!: number;

  @ApiProperty({ example: 2 })
  activeVariantCount!: number;

  @ApiProperty({ example: 19, description: 'On-hand units across active variants.' })
  totalStock!: number;

  @ApiProperty({ example: 1, description: 'Units reserved by open checkouts across active variants.' })
  totalReserved!: number;

  @ApiProperty({ example: 18, description: 'Sellable units: totalStock - totalReserved.' })
  totalAvailable!: number;
}

export class ColorOptionDto {
  @ApiProperty({ example: 'مشکی' })
  name!: string;

  @ApiProperty({ example: '#111827', nullable: true, type: String })
  hex!: string | null;
}

export class ImageRefDto {
  @ApiProperty({ example: '/api/v1/media/files/images/product_image/2026/09/0f2c….webp' })
  url!: string;

  @ApiProperty({ nullable: true, type: String, example: '/api/v1/media/files/images/product_image/2026/09/0f2c…_thumb.webp' })
  thumbnailUrl!: string | null;
}

export class ProductSpecificationDto {
  @ApiProperty({ example: 'حافظه', nullable: true, type: String })
  groupTitle!: string | null;

  @ApiProperty({ example: 'حافظه داخلی' })
  title!: string;

  @ApiProperty({ example: '256 گیگابایت', description: 'May contain line breaks.' })
  value!: string;
}

export class ProductMediaDto extends ImageRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Uploaded file this entry was created from.' })
  mediaAssetId!: string | null;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty({ example: 10 })
  sortOrder!: number;
}

export class ProductModerationDto {
  @ApiProperty()
  isBlockedByAdmin!: boolean;

  @ApiProperty({ nullable: true, type: String, description: 'Reason given by staff; visible to the vendor.' })
  blockedReason!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  blockedAt!: Date | null;
}

// ---------------------------------------------------------------------------
// Vendor views
// ---------------------------------------------------------------------------

export class VendorVariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'SHP-A55-256-BLK' })
  sku!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ example: '42500000.00' })
  price!: string;

  @ApiProperty({ example: '45000000.00', nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ example: 5, nullable: true, type: Number, description: 'floor((compareAtPrice - price) / compareAtPrice × 100)' })
  discountPercent!: number | null;

  @ApiProperty({ example: 12 })
  stockQuantity!: number;

  @ApiProperty({ example: 1 })
  reservedQuantity!: number;

  @ApiProperty({ example: 11 })
  availableQuantity!: number;

  @ApiProperty({ nullable: true, type: Number })
  weightGrams!: number | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class VendorProductSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ example: '42500000.00' })
  basePrice!: string;

  @ApiProperty()
  isPublished!: boolean;

  @ApiProperty({ description: 'Published, not blocked, store approved and at least one active variant.' })
  isSellable!: boolean;

  @ApiProperty({ type: () => ProductModerationDto })
  moderation!: ProductModerationDto;

  @ApiProperty({ type: () => CategorySummaryDto })
  category!: CategorySummaryDto;

  @ApiProperty({ type: () => ImageRefDto, nullable: true })
  primaryImage!: ImageRefDto | null;

  @ApiProperty({ type: () => PriceRangeDto, nullable: true, description: 'Across active variants; null when none is active.' })
  priceRange!: PriceRangeDto | null;

  @ApiProperty({ type: () => StockSummaryDto })
  stock!: StockSummaryDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class VendorProductDetailDto extends VendorProductSummaryDto {
  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ type: () => [ProductMediaDto] })
  media!: ProductMediaDto[];

  @ApiProperty({ type: () => [VendorVariantDto], description: 'All variants, active or not.' })
  variants!: VendorVariantDto[];

  @ApiProperty({ type: () => [ProductSpecificationDto], description: 'Technical specifications in display order.' })
  specifications!: ProductSpecificationDto[];
}

export class PaginatedVendorProductsDto {
  @ApiProperty({ type: () => [VendorProductSummaryDto] })
  items!: VendorProductSummaryDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class ArchiveProductResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ example: false })
  isPublished!: boolean;

  @ApiProperty({ description: 'Whether the product was live before this call (false: the call was a no-op).' })
  wasPublished!: boolean;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Audit row, when the state changed.' })
  auditLogId!: string | null;
}

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

export class PublicVendorSummaryDto {
  @ApiProperty({ example: 'فروشگاه نمونهٔ شاگردم' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;

  @ApiProperty({ nullable: true, type: String })
  logoUrl!: string | null;
}

export class PublicVendorDetailDto extends PublicVendorSummaryDto {
  @ApiProperty({ nullable: true, type: String })
  bio!: string | null;

  @ApiProperty({ nullable: true, type: String })
  instagramHandle!: string | null;

  @ApiProperty({ nullable: true, type: Date, description: 'When the store was approved.' })
  verifiedAt!: Date | null;
}

export class PublicProductListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ type: () => ImageRefDto, nullable: true, description: 'Primary image (use thumbnailUrl in listings).' })
  primaryImage!: ImageRefDto | null;

  @ApiProperty({ type: () => PriceRangeDto, description: 'Across all active variants.' })
  priceRange!: PriceRangeDto;

  @ApiProperty({ nullable: true, type: Number, example: 22, description: 'Largest discount among active variants.' })
  maxDiscountPercent!: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '52000000.00',
    description: 'Compare-at (strike-through) price of the cheapest active variant — the one priceRange.min comes from; null when that variant has no discount.',
  })
  startingCompareAtPrice!: string | null;

  @ApiProperty({ type: () => [ColorOptionDto] })
  colors!: ColorOptionDto[];

  @ApiProperty({ type: [String], example: ['L', 'XL'] })
  sizes!: string[];

  @ApiProperty({ description: 'At least one active variant has sellable stock.' })
  inStock!: boolean;

  @ApiProperty({ type: () => PublicVendorSummaryDto })
  vendor!: PublicVendorSummaryDto;

  @ApiProperty({ type: () => CategorySummaryDto })
  category!: CategorySummaryDto;

  @ApiProperty()
  createdAt!: Date;
}

export class PaginatedPublicProductsDto {
  @ApiProperty({ type: () => [PublicProductListItemDto] })
  items!: PublicProductListItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 42, description: 'Total number of matching products.' })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class PublicVariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ example: '42500000.00' })
  price!: string;

  @ApiProperty({ nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  discountPercent!: number | null;

  @ApiProperty({ example: 11, description: 'Real-time sellable units (stock minus open reservations).' })
  availableQuantity!: number;

  @ApiProperty()
  inStock!: boolean;

  @ApiProperty({ nullable: true, type: Number })
  weightGrams!: number | null;
}

export class PublicProductDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ type: () => [CategorySummaryDto], description: 'Root → product category.' })
  breadcrumbs!: CategorySummaryDto[];

  @ApiProperty({ type: () => PublicVendorDetailDto })
  vendor!: PublicVendorDetailDto;

  @ApiProperty({ type: () => [ImageRefDto], description: 'Full gallery in display order; the first image is the primary one.' })
  media!: ImageRefDto[];

  @ApiProperty({ type: () => [PublicVariantDto], description: 'Active variants only.' })
  variants!: PublicVariantDto[];

  @ApiProperty({ type: () => [ProductSpecificationDto], description: 'Technical specifications in display order.' })
  specifications!: ProductSpecificationDto[];

  @ApiProperty({ type: () => PriceRangeDto })
  priceRange!: PriceRangeDto;

  @ApiProperty({ nullable: true, type: Number })
  maxDiscountPercent!: number | null;

  @ApiProperty({ type: () => [ColorOptionDto] })
  colors!: ColorOptionDto[];

  @ApiProperty({ type: [String] })
  sizes!: string[];

  @ApiProperty()
  inStock!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

// ---------------------------------------------------------------------------
// Staff views
// ---------------------------------------------------------------------------

export class AdminProductVendorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  storeName!: string;

  @ApiProperty()
  storeSlug!: string;

  @ApiProperty({ enum: VendorStatus })
  status!: VendorStatus;
}

export class AdminProductDto extends VendorProductSummaryDto {
  @ApiProperty({ type: () => AdminProductVendorDto })
  vendor!: AdminProductVendorDto;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Staff member who blocked the product.' })
  blockedByUserId!: string | null;
}

export class PaginatedAdminProductsDto {
  @ApiProperty({ type: () => [AdminProductDto] })
  items!: AdminProductDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class AdminProductStatusResponseDto {
  @ApiProperty({ type: () => AdminProductDto })
  product!: AdminProductDto;

  @ApiProperty({ format: 'uuid' })
  auditLogId!: string;

  @ApiPropertyOptional({ type: [String], example: ['isBlockedByAdmin', 'isPublished'], description: 'Fields that changed.' })
  changed!: string[];
}
