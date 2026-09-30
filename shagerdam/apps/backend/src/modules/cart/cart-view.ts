import { Prisma } from '@prisma/client';
import { quoteShipping, type ShippingPolicy } from '../shipping/shipping-fee';
import type { CartDto, CartIssueDto, CartLineDto, CartVendorGroupDto } from './dto/cart-response.dto';
import {
  availableQuantity,
  purchasableVariantSelect,
  unavailableReason,
  UNAVAILABLE_MESSAGES,
  type PurchasableVariant,
} from './purchasable';

export const cartLineSelect = {
  id: true,
  quantity: true,
  unitPriceSnapshot: true,
  createdAt: true,
  productVariant: { select: purchasableVariantSelect },
} satisfies Prisma.CartItemSelect;

export type CartLineRow = Prisma.CartItemGetPayload<{ select: typeof cartLineSelect }>;

const ZERO = new Prisma.Decimal(0);
const money = (value: Prisma.Decimal): string => value.toFixed(2);

/** Evaluated state of one cart line against live catalogue data. */
export interface EvaluatedLine {
  row: CartLineRow;
  variant: PurchasableVariant;
  available: number;
  isPurchasable: boolean;
  priceChanged: boolean;
  issues: CartIssueDto[];
}

export function evaluateLine(row: CartLineRow, visibleCategoryIds: ReadonlySet<string>): EvaluatedLine {
  const variant = row.productVariant;
  const issues: CartIssueDto[] = [];
  const reason = unavailableReason(variant, visibleCategoryIds);
  const available = availableQuantity(variant);

  if (reason !== null) {
    issues.push({ code: reason, message: UNAVAILABLE_MESSAGES[reason] });
  } else if (available === 0) {
    issues.push({ code: 'OUT_OF_STOCK', message: 'Out of stock' });
  } else if (available < row.quantity) {
    issues.push({ code: 'INSUFFICIENT_STOCK', message: `Only ${available} left in stock` });
  }

  const priceChanged = !variant.price.eq(row.unitPriceSnapshot);
  if (priceChanged) {
    issues.push({
      code: 'PRICE_CHANGED',
      message: `Price changed from ${money(row.unitPriceSnapshot)} to ${money(variant.price)}`,
    });
  }

  return { row, variant, available, isPurchasable: reason === null, priceChanged, issues };
}

/**
 * Builds the cart response: lines grouped by store (in the order the store's
 * first line was added), per-store subtotal and shipping estimate, and totals.
 * Only purchasable lines count toward subtotals and shipping.
 */
export function buildCartView(
  rows: CartLineRow[],
  visibleCategoryIds: ReadonlySet<string>,
  policy: ShippingPolicy,
  meta: { owner: CartDto['owner']; cartToken: string | null },
): CartDto {
  const groups = new Map<string, { vendor: PurchasableVariant['product']['vendor']; lines: EvaluatedLine[] }>();
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

  for (const row of ordered) {
    const line = evaluateLine(row, visibleCategoryIds);
    const vendor = line.variant.product.vendor;
    const group = groups.get(vendor.id) ?? { vendor, lines: [] };
    group.lines.push(line);
    groups.set(vendor.id, group);
  }

  let itemsSubtotal = ZERO;
  let shippingTotal = ZERO;
  let itemCount = 0;
  let hasIssues = false;
  let hasPriceChanges = false;

  const groupDtos: CartVendorGroupDto[] = [...groups.values()].map(({ vendor, lines }) => {
    const subtotal = lines
      .filter((line) => line.isPurchasable)
      .reduce((sum, line) => sum.add(line.variant.price.mul(line.row.quantity)), ZERO);
    const quote = subtotal.gt(ZERO)
      ? quoteShipping(subtotal, vendor, policy)
      : { fee: ZERO, isFree: false, freeThreshold: vendor.freeShippingThreshold ?? policy.freeThresholdPerVendor, remainingForFreeShipping: null };

    itemsSubtotal = itemsSubtotal.add(subtotal);
    shippingTotal = shippingTotal.add(quote.fee);

    return {
      vendor: { storeName: vendor.storeName, storeSlug: vendor.storeSlug },
      lines: lines.map((line): CartLineDto => {
        itemCount += line.row.quantity;
        hasIssues ||= line.issues.length > 0;
        hasPriceChanges ||= line.priceChanged;
        const media = line.variant.product.media[0];
        return {
          id: line.row.id,
          productVariantId: line.variant.id,
          sku: line.variant.sku,
          productId: line.variant.product.id,
          productSlug: line.variant.product.slug,
          productTitle: line.variant.product.title,
          colorName: line.variant.colorName,
          colorHex: line.variant.colorHex,
          size: line.variant.size,
          guarantee: line.variant.guarantee,
          image: media ? { url: media.url, thumbnailUrl: media.thumbnailUrl } : null,
          quantity: line.row.quantity,
          unitPrice: money(line.variant.price),
          priceWhenAdded: money(line.row.unitPriceSnapshot),
          compareAtPrice: line.variant.compareAtPrice === null ? null : money(line.variant.compareAtPrice),
          lineTotal: money(line.variant.price.mul(line.row.quantity)),
          availableQuantity: line.available,
          isPurchasable: line.isPurchasable,
          issues: line.issues,
          addedAt: line.row.createdAt,
        };
      }),
      itemsSubtotal: money(subtotal),
      shipping: {
        fee: money(quote.fee),
        isFree: quote.isFree,
        freeThreshold: money(quote.freeThreshold),
        remainingForFreeShipping: quote.remainingForFreeShipping === null ? null : money(quote.remainingForFreeShipping),
      },
      packageTotal: money(subtotal.add(quote.fee)),
    };
  });

  return {
    cartToken: meta.cartToken,
    owner: meta.owner,
    groups: groupDtos,
    itemCount,
    lineCount: rows.length,
    itemsSubtotal: money(itemsSubtotal),
    shippingTotal: money(shippingTotal),
    payableAmount: money(itemsSubtotal.add(shippingTotal)),
    hasPriceChanges,
    canCheckout: rows.length > 0 && !hasIssues,
  };
}
