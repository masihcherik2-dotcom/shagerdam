import type { Prisma} from '@prisma/client';
import { VendorStatus } from '@prisma/client';

/**
 * The single definition of "this variant can be bought right now", shared by
 * the cart (to flag lines) and checkout (to refuse them). It mirrors the public
 * visibility rule of the catalogue (`catalog-visibility.ts`) at variant level:
 * the variant is active, its product is published and not blocked, its store is
 * APPROVED and its category is reachable in the active tree.
 */
export const purchasableVariantSelect = {
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
  isActive: true,
  product: {
    select: {
      id: true,
      slug: true,
      title: true,
      isPublished: true,
      isBlockedByAdmin: true,
      categoryId: true,
      category: { select: { defaultCommissionRate: true } },
      vendor: {
        select: {
          id: true,
          storeName: true,
          storeSlug: true,
          status: true,
          commissionRateOverride: true,
          shippingFeeOverride: true,
          freeShippingThreshold: true,
        },
      },
      media: {
        select: { url: true, thumbnailUrl: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 1,
      },
    },
  },
} satisfies Prisma.ProductVariantSelect;

export type PurchasableVariant = Prisma.ProductVariantGetPayload<{ select: typeof purchasableVariantSelect }>;

export type UnavailableReason =
  | 'VARIANT_INACTIVE'
  | 'PRODUCT_UNPUBLISHED'
  | 'PRODUCT_BLOCKED'
  | 'STORE_UNAVAILABLE'
  | 'CATEGORY_UNAVAILABLE';

export const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  VARIANT_INACTIVE: 'This option is no longer offered by the store',
  PRODUCT_UNPUBLISHED: 'This product is not on sale at the moment',
  PRODUCT_BLOCKED: 'This product is not on sale at the moment',
  STORE_UNAVAILABLE: 'The store selling this product is not accepting orders',
  CATEGORY_UNAVAILABLE: 'This product is not on sale at the moment',
};

/** Why the variant cannot be bought, or `null` when it can. */
export function unavailableReason(variant: PurchasableVariant, visibleCategoryIds: ReadonlySet<string>): UnavailableReason | null {
  if (!variant.isActive) return 'VARIANT_INACTIVE';
  if (variant.product.isBlockedByAdmin) return 'PRODUCT_BLOCKED';
  if (!variant.product.isPublished) return 'PRODUCT_UNPUBLISHED';
  if (variant.product.vendor.status !== VendorStatus.APPROVED) return 'STORE_UNAVAILABLE';
  if (!visibleCategoryIds.has(variant.product.categoryId)) return 'CATEGORY_UNAVAILABLE';
  return null;
}

/** Units that can still be sold: on hand minus held by open checkouts. */
export function availableQuantity(variant: Pick<PurchasableVariant, 'stockQuantity' | 'reservedQuantity'>): number {
  return Math.max(0, variant.stockQuantity - variant.reservedQuantity);
}
