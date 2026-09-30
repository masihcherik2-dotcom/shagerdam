import { Prisma, VendorStatus } from '@prisma/client';
import type { TorobPriceUnit } from '../../../config/env.validation';
import { quoteShipping, type ShippingPolicy, type VendorShippingSettings } from '../../shipping/shipping-fee';

/**
 * Pure mapping from a product variant to a Torob feed item. No I/O: the feed
 * service loads the rows and the context, this file decides what Torob sees.
 *
 * One feed item per **variant** — Torob compares an exact sellable offer (a
 * colour/size with its own price and stock), and the SKU is its identity.
 */

/** Maximum images per item; Torob shows a handful and the gallery holds 12. */
export const TOROB_MAX_IMAGES = 10;
export const TOROB_AVAILABILITY = { IN_STOCK: 'instock', OUT_OF_STOCK: 'outofstock' } as const;
export type TorobAvailability = (typeof TOROB_AVAILABILITY)[keyof typeof TOROB_AVAILABILITY];

/** Spec keys added from the variant/product itself (Persian, as shown on the product page). */
export const SPEC_KEYS = { brand: 'برند', color: 'رنگ', size: 'سایز', guarantee: 'گارانتی' } as const;

export interface TorobVariantRow {
  sku: string;
  colorName: string | null;
  size: string | null;
  guarantee: string | null;
  price: Prisma.Decimal;
  compareAtPrice: Prisma.Decimal | null;
  stockQuantity: number;
  reservedQuantity: number;
  isActive: boolean;
  product: {
    title: string;
    slug: string;
    brand: string | null;
    categoryId: string;
    isPublished: boolean;
    isBlockedByAdmin: boolean;
    vendor: VendorShippingSettings & { status: VendorStatus };
    media: ReadonlyArray<{ url: string; isPrimary: boolean; sortOrder: number }>;
    specifications: ReadonlyArray<{ groupTitle: string | null; title: string; value: string }>;
  };
}

export interface TorobMappingContext {
  /** Storefront origin for `page_url`, e.g. `https://shagerdam.ir`. */
  webOrigin: string;
  /** Origin that serves relative media URLs (`/api/v1/media/files/...`). */
  assetOrigin: string;
  priceUnit: TorobPriceUnit;
  shippingPolicy: Pick<ShippingPolicy, 'defaultFeePerVendor' | 'freeThresholdPerVendor'>;
  /** Visible categories: id → `"کالای دیجیتال > گوشی موبایل"`. Hidden categories are absent. */
  categoryPaths: ReadonlyMap<string, string>;
}

export interface TorobProductItem {
  page_unique: string;
  title: string;
  price: number;
  old_price: number | null;
  availability: TorobAvailability;
  page_url: string;
  image_links: string[];
  category_name: string | null;
  spec: Record<string, string>;
  guarantee: string | null;
  delivery_fee: number;
}

/** Units a customer can buy now: on-hand minus units held by unfinished checkouts. */
export function sellableQuantity(row: Pick<TorobVariantRow, 'stockQuantity' | 'reservedQuantity'>): number {
  return Math.max(0, row.stockQuantity - row.reservedQuantity);
}

/**
 * Whether the storefront lists this variant right now — the same rule as
 * `catalog-visibility.ts` (published, not blocked, approved store, active
 * variant, category reachable in the visible tree). A variant that exists but is
 * not listed is reported by the details endpoint as out of stock, so Torob stops
 * sending buyers to it.
 */
export function isListed(row: TorobVariantRow, context: Pick<TorobMappingContext, 'categoryPaths'>): boolean {
  return (
    row.isActive &&
    row.product.isPublished &&
    !row.product.isBlockedByAdmin &&
    row.product.vendor.status === VendorStatus.APPROVED &&
    context.categoryPaths.has(row.product.categoryId)
  );
}

/** Integer amount in the feed unit. Platform amounts are Rial; IRT divides by 10 (half-up). */
export function toFeedAmount(amount: Prisma.Decimal, unit: TorobPriceUnit): number {
  const value = unit === 'IRT' ? amount.dividedBy(10) : amount;
  return value.toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
}

/** Absolute URL for a stored media URL: S3/CDN URLs are kept, local `/api/...` paths get the origin. */
export function absoluteUrl(url: string, origin: string): string {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}

/** `"<title>، رنگ مشکی، سایز XL"` — the variant attributes a buyer compares on. */
export function variantTitle(title: string, colorName: string | null, size: string | null): string {
  const parts = [title.trim()];
  if (colorName !== null && colorName.trim() !== '') {
    parts.push(`رنگ ${colorName.trim()}`);
  }
  if (size !== null && size.trim() !== '') {
    parts.push(`سایز ${size.trim()}`);
  }
  return parts.join('، ');
}

/**
 * Flat key → value map: product specifications in their display order, then the
 * brand and the variant's own attributes (which win over a same-named product
 * spec, because they describe this exact offer). A title repeated in two groups
 * is disambiguated as `"<title> (<group>)"`.
 */
export function buildSpec(row: TorobVariantRow): Record<string, string> {
  const spec = new Map<string, string>();
  for (const item of row.product.specifications) {
    const title = item.title.trim();
    const value = item.value.trim();
    if (title === '' || value === '') {
      continue;
    }
    const key = spec.has(title) && item.groupTitle ? `${title} (${item.groupTitle.trim()})` : title;
    if (!spec.has(key)) {
      spec.set(key, value);
    }
  }
  const own: Array<[string, string | null]> = [
    [SPEC_KEYS.brand, row.product.brand],
    [SPEC_KEYS.color, row.colorName],
    [SPEC_KEYS.size, row.size],
    [SPEC_KEYS.guarantee, row.guarantee],
  ];
  for (const [key, value] of own) {
    if (value !== null && value.trim() !== '') {
      spec.set(key, value.trim());
    }
  }
  return Object.fromEntries(spec);
}

/** Canonical storefront link that pre-selects the variant (`?variant=<SKU>`). */
export function productPageUrl(webOrigin: string, slug: string, sku: string): string {
  return `${webOrigin}/products/${encodeURIComponent(slug)}?variant=${encodeURIComponent(sku)}`;
}

export function toTorobItem(row: TorobVariantRow, context: TorobMappingContext): TorobProductItem {
  const listed = isListed(row, context);
  const inStock = listed && sellableQuantity(row) > 0;
  const discounted = row.compareAtPrice !== null && row.compareAtPrice.greaterThan(row.price);
  // Delivery fee of a one-unit package of this offer, by the checkout formula
  // (store override → platform policy, free above the store/platform threshold).
  const shipping = quoteShipping(row.price, row.product.vendor, context.shippingPolicy);
  const images = [...row.product.media]
    .sort((a, b) => Number(b.isPrimary) - Number(a.isPrimary) || a.sortOrder - b.sortOrder)
    .slice(0, TOROB_MAX_IMAGES)
    .map((media) => absoluteUrl(media.url, context.assetOrigin));

  return {
    page_unique: row.sku,
    title: variantTitle(row.product.title, row.colorName, row.size),
    price: toFeedAmount(row.price, context.priceUnit),
    old_price: discounted && row.compareAtPrice !== null ? toFeedAmount(row.compareAtPrice, context.priceUnit) : null,
    availability: inStock ? TOROB_AVAILABILITY.IN_STOCK : TOROB_AVAILABILITY.OUT_OF_STOCK,
    page_url: productPageUrl(context.webOrigin, row.product.slug, row.sku),
    image_links: images,
    category_name: context.categoryPaths.get(row.product.categoryId) ?? null,
    spec: buildSpec(row),
    guarantee: row.guarantee?.trim() || null,
    delivery_fee: toFeedAmount(shipping.fee, context.priceUnit),
  };
}

/**
 * Parses a storefront product link (`<webOrigin>/products/<slug>[?variant=<SKU>]`).
 * The host must be the storefront's (with or without `www.`, either scheme);
 * anything else is `null`, so the endpoint never resolves foreign URLs.
 */
export function parseProductPageUrl(pageUrl: string, webOrigin: string): { slug: string; sku: string | null } | null {
  let url: URL;
  let origin: URL;
  try {
    url = new URL(pageUrl);
    origin = new URL(webOrigin);
  } catch {
    return null;
  }
  const bareHost = (host: string): string => host.toLowerCase().replace(/^www\./, '');
  if (!/^https?:$/.test(url.protocol) || bareHost(url.host) !== bareHost(origin.host)) {
    return null;
  }
  const match = /^\/products\/([^/]+)\/?$/.exec(url.pathname);
  if (match === null || match[1] === undefined) {
    return null;
  }
  let slug: string;
  try {
    slug = decodeURIComponent(match[1]);
  } catch {
    return null;
  }
  const sku = url.searchParams.get('variant');
  return { slug, sku: sku !== null && sku.trim() !== '' ? sku.trim().toUpperCase() : null };
}
