import { VendorStatus, type Prisma } from '@prisma/client';
import { CategorySummaryDto } from '../categories/dto/category-response.dto';
import type {
  AdminProductDto,
  ColorOptionDto,
  ImageRefDto,
  PriceRangeDto,
  ProductMediaDto,
  PublicVariantDto,
  StockSummaryDto,
  VendorProductDetailDto,
  VendorProductSummaryDto,
  VendorVariantDto,
} from './dto/product-response.dto';
import { discountPercent } from './product-rules';

/**
 * Prisma selections and the pure mappers that turn their rows into response
 * DTOs. Keeping the `select` next to the mapper guarantees the mapper never
 * reads a field the query did not load.
 */

export const variantSelect = {
  id: true,
  sku: true,
  colorName: true,
  colorHex: true,
  size: true,
  guarantee: true,
  price: true,
  compareAtPrice: true,
  stockQuantity: true,
  reservedQuantity: true,
  weightGrams: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductVariantSelect;

export const mediaSelect = {
  id: true,
  mediaAssetId: true,
  url: true,
  thumbnailUrl: true,
  isPrimary: true,
  sortOrder: true,
} satisfies Prisma.ProductMediaSelect;

export const specificationSelect = {
  groupTitle: true,
  title: true,
  value: true,
} satisfies Prisma.ProductSpecificationSelect;

/** Display order of a product's specifications. */
export const specificationOrder = [{ sortOrder: 'asc' }, { createdAt: 'asc' }] satisfies Prisma.ProductSpecificationOrderByWithRelationInput[];

const categorySelect = { id: true, slug: true, titleFa: true, titleEn: true } satisfies Prisma.CategorySelect;

export const productSummarySelect = {
  id: true,
  slug: true,
  title: true,
  brand: true,
  basePrice: true,
  isPublished: true,
  isBlockedByAdmin: true,
  blockedReason: true,
  blockedAt: true,
  blockedByUserId: true,
  createdAt: true,
  updatedAt: true,
  category: { select: categorySelect },
  vendor: { select: { id: true, storeName: true, storeSlug: true, status: true } },
  variants: { select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 1 },
} satisfies Prisma.ProductSelect;

export const productDetailSelect = {
  ...productSummarySelect,
  description: true,
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  specifications: { select: specificationSelect, orderBy: specificationOrder },
} satisfies Prisma.ProductSelect;

export type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;
export type MediaRow = Prisma.ProductMediaGetPayload<{ select: typeof mediaSelect }>;
export type ProductSummaryRow = Prisma.ProductGetPayload<{ select: typeof productSummarySelect }>;
export type ProductDetailRow = Prisma.ProductGetPayload<{ select: typeof productDetailSelect }>;

type PricedVariant = Pick<VariantRow, 'price' | 'compareAtPrice' | 'isActive'>;
type StockedVariant = Pick<VariantRow, 'stockQuantity' | 'reservedQuantity' | 'isActive'>;
type OptionVariant = Pick<VariantRow, 'colorName' | 'colorHex' | 'size'>;

export function money(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export function priceRange(variants: readonly PricedVariant[]): PriceRangeDto | null {
  const prices = variants.filter((variant) => variant.isActive).map((variant) => variant.price);
  if (prices.length === 0) {
    return null;
  }
  const min = prices.reduce((lowest, price) => (price.lt(lowest) ? price : lowest));
  const max = prices.reduce((highest, price) => (price.gt(highest) ? price : highest));
  return { min: money(min), max: money(max) };
}

export function maxDiscountPercent(variants: readonly PricedVariant[]): number | null {
  let best: number | null = null;
  for (const variant of variants) {
    if (!variant.isActive) continue;
    const percent = discountPercent(variant.price, variant.compareAtPrice);
    if (percent !== null && (best === null || percent > best)) {
      best = percent;
    }
  }
  return best;
}

/**
 * Strike-through price that belongs to the listing's "from" price: the
 * compare-at price of the cheapest active variant, or null when that variant
 * is not discounted. (A product card shows `priceRange.min` next to it, so a
 * compare-at price of a different variant would misstate the discount.)
 */
export function startingCompareAtPrice(variants: readonly PricedVariant[]): string | null {
  let cheapest: PricedVariant | null = null;
  for (const variant of variants) {
    if (!variant.isActive) continue;
    if (cheapest === null || variant.price.lt(cheapest.price)) {
      cheapest = variant;
    }
  }
  if (cheapest === null || cheapest.compareAtPrice === null || !cheapest.compareAtPrice.greaterThan(cheapest.price)) {
    return null;
  }
  return money(cheapest.compareAtPrice);
}

export function stockSummary(variants: readonly StockedVariant[]): StockSummaryDto {
  const active = variants.filter((variant) => variant.isActive);
  const totalStock = active.reduce((sum, variant) => sum + variant.stockQuantity, 0);
  const totalReserved = active.reduce((sum, variant) => sum + variant.reservedQuantity, 0);
  return {
    variantCount: variants.length,
    activeVariantCount: active.length,
    totalStock,
    totalReserved,
    totalAvailable: totalStock - totalReserved,
  };
}

/** Distinct colours (by case-insensitive name, first hex wins) and sizes, in variant order. */
export function variantOptions(variants: readonly OptionVariant[]): { colors: ColorOptionDto[]; sizes: string[] } {
  const colors = new Map<string, ColorOptionDto>();
  const sizes = new Map<string, string>();
  for (const variant of variants) {
    if (variant.colorName) {
      const key = variant.colorName.toLocaleLowerCase('fa');
      if (!colors.has(key)) {
        colors.set(key, { name: variant.colorName, hex: variant.colorHex });
      }
    }
    if (variant.size) {
      const key = variant.size.toLocaleUpperCase('en');
      if (!sizes.has(key)) {
        sizes.set(key, variant.size);
      }
    }
  }
  return { colors: [...colors.values()], sizes: [...sizes.values()] };
}

export function imageRef(media: Pick<MediaRow, 'url' | 'thumbnailUrl'> | undefined): ImageRefDto | null {
  return media ? { url: media.url, thumbnailUrl: media.thumbnailUrl } : null;
}

export function toVendorVariant(variant: VariantRow): VendorVariantDto {
  return {
    id: variant.id,
    sku: variant.sku,
    colorName: variant.colorName,
    colorHex: variant.colorHex,
    size: variant.size,
    guarantee: variant.guarantee,
    price: money(variant.price),
    compareAtPrice: variant.compareAtPrice ? money(variant.compareAtPrice) : null,
    discountPercent: discountPercent(variant.price, variant.compareAtPrice),
    stockQuantity: variant.stockQuantity,
    reservedQuantity: variant.reservedQuantity,
    availableQuantity: variant.stockQuantity - variant.reservedQuantity,
    weightGrams: variant.weightGrams,
    isActive: variant.isActive,
    createdAt: variant.createdAt,
    updatedAt: variant.updatedAt,
  };
}

export function toPublicVariant(variant: VariantRow): PublicVariantDto {
  const available = Math.max(0, variant.stockQuantity - variant.reservedQuantity);
  return {
    id: variant.id,
    sku: variant.sku,
    colorName: variant.colorName,
    colorHex: variant.colorHex,
    size: variant.size,
    guarantee: variant.guarantee,
    price: money(variant.price),
    compareAtPrice: variant.compareAtPrice ? money(variant.compareAtPrice) : null,
    discountPercent: discountPercent(variant.price, variant.compareAtPrice),
    availableQuantity: available,
    inStock: available > 0,
    weightGrams: variant.weightGrams,
  };
}

export function toMediaDto(media: MediaRow): ProductMediaDto {
  return { ...media };
}

/** Sellable = what the storefront would list (category visibility is checked separately). */
export function isSellable(product: Pick<ProductSummaryRow, 'isPublished' | 'isBlockedByAdmin' | 'variants' | 'vendor'>): boolean {
  return (
    product.isPublished &&
    !product.isBlockedByAdmin &&
    product.vendor.status === VendorStatus.APPROVED &&
    product.variants.some((variant) => variant.isActive)
  );
}

export function toVendorSummary(product: ProductSummaryRow): VendorProductSummaryDto {
  return {
    id: product.id,
    slug: product.slug,
    title: product.title,
    brand: product.brand,
    basePrice: money(product.basePrice),
    isPublished: product.isPublished,
    isSellable: isSellable(product),
    moderation: {
      isBlockedByAdmin: product.isBlockedByAdmin,
      blockedReason: product.blockedReason,
      blockedAt: product.blockedAt,
    },
    category: CategorySummaryDto.from(product.category),
    primaryImage: imageRef(product.media[0]),
    priceRange: priceRange(product.variants),
    stock: stockSummary(product.variants),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export function toVendorDetail(product: ProductDetailRow): VendorProductDetailDto {
  return {
    ...toVendorSummary(product),
    description: product.description,
    media: product.media.map((media) => toMediaDto(media)),
    variants: product.variants.map((variant) => toVendorVariant(variant)),
    specifications: product.specifications.map((row) => ({ ...row })),
  };
}

export function toAdminProduct(product: ProductSummaryRow): AdminProductDto {
  return {
    ...toVendorSummary(product),
    vendor: { ...product.vendor },
    blockedByUserId: product.blockedByUserId,
  };
}
