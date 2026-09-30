import { createHash } from 'node:crypto';
import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import { CreateProductDto } from '../../products/dto/product-input.dto';
import { MAX_MONEY } from '../../products/product-rules';
import type { ExtractedProduct } from '../extractors/extracted-product';
import { isIranianUnit, toRial, type IranianUnit } from '../extractors/offer';

/**
 * Unit of the prices on the source site:
 * - `AUTO`: what the page declares (visible currency symbol first, then structured data);
 * - `IRR` / `IRT`: the user's statement, overriding the page (many Iranian
 *   shops declare `IRR` in structured data while their prices are in toman).
 */
export const PRICE_UNIT_OPTIONS = ['AUTO', 'IRR', 'IRT'] as const;
export type PriceUnitOption = (typeof PRICE_UNIT_OPTIONS)[number];

export interface DraftOptions {
  autoPublish: boolean;
  priceUnit: PriceUnitOption;
  /** Stock given to products the source shows as available (the source never publishes quantities). */
  defaultStock: number;
  /** Category for products whose source category matches nothing in the local tree. */
  defaultCategoryId: string | null;
}

/** Why a product page could not become a product without the vendor's input. */
export type ReviewReason = 'NO_PRICE' | 'UNKNOWN_CURRENCY' | 'FOREIGN_CURRENCY' | 'NO_CATEGORY';

export type DraftResult =
  | { kind: 'ready'; dto: CreateProductDto; priceIrr: number; inStock: boolean }
  | { kind: 'review'; code: ReviewReason; message: string };

/**
 * Deterministic SKU of an imported page, per store: `IMP-` + 16 hex of
 * SHA-256(storeId + canonical URL). Importing the same page twice into the
 * same store finds this SKU and skips; two stores importing the same page get
 * different SKUs (SKUs are globally unique).
 */
export function importSku(vendorId: string, sourceUrl: string): string {
  const digest = createHash('sha256').update(`${vendorId}\n${canonicalForSku(sourceUrl)}`).digest('hex');
  return `IMP-${digest.slice(0, 16).toUpperCase()}`;
}

function canonicalForSku(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    url.protocol = 'https:';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value;
  }
}

/**
 * Resolves the unit of the page's price. The vendor's choice (rial/toman) wins
 * over what the page declares — many WooCommerce stores declare `IRR` in their
 * schema while pricing in tomans — but a page priced in a foreign currency
 * (USD, EUR, …) is never "converted" by relabelling its numbers.
 */
export function resolveUnit(option: PriceUnitOption, declared: string | null): IranianUnit | null {
  if (declared !== null && !isIranianUnit(declared)) return null;
  if (option !== 'AUTO') return option;
  return declared;
}

/**
 * Turns an extracted page into a `CreateProductDto`, or explains what is
 * missing. Nothing is invented: a page without a usable price or category is
 * reported for review instead of being stored with a guessed value.
 */
export function buildProductDraft(input: {
  product: ExtractedProduct;
  sku: string;
  categoryId: string | null;
  options: DraftOptions;
}): DraftResult {
  const { product, sku, categoryId, options } = input;
  const offer = product.offer;
  if (offer === null) {
    return { kind: 'review', code: 'NO_PRICE', message: 'The page shows no price' };
  }
  const unit = resolveUnit(options.priceUnit, offer.currency);
  if (unit === null) {
    return offer.currency !== null
      ? { kind: 'review', code: 'FOREIGN_CURRENCY', message: `The page prices in ${offer.currency}, which is not converted to rials` }
      : { kind: 'review', code: 'UNKNOWN_CURRENCY', message: 'The page does not say whether its prices are in rials or tomans; choose the unit and retry' };
  }
  if (categoryId === null) {
    return {
      kind: 'review',
      code: 'NO_CATEGORY',
      message: product.suggestedCategory
        ? `No local category matches «${product.suggestedCategory}»; choose a default category and retry`
        : 'The page names no category; choose a default category and retry',
    };
  }

  const priceIrr = toRial(offer.amount, unit);
  const oldIrr = offer.oldAmount !== null ? toRial(offer.oldAmount, unit) : null;
  const inStock = offer.inStock !== false;

  const dto = plainToInstance(CreateProductDto, {
    title: product.title,
    description: product.description,
    categoryId,
    brand: product.brand,
    basePrice: priceIrr,
    mediaIds: [],
    specifications: product.specifications.map((spec) => ({ groupTitle: spec.group, title: spec.title, value: spec.value })),
    variants: [
      {
        sku,
        price: priceIrr,
        compareAtPrice: oldIrr !== null && oldIrr > priceIrr && oldIrr <= MAX_MONEY ? oldIrr : null,
        stockQuantity: inStock ? options.defaultStock : 0,
        isActive: true,
      },
    ],
    isPublished: options.autoPublish,
  });
  return { kind: 'ready', dto, priceIrr, inStock };
}

/** Runs the product DTO's own validation rules; returns readable messages (empty = valid). */
export async function draftProblems(dto: CreateProductDto): Promise<string[]> {
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return flatten(errors);
}

function flatten(errors: ValidationError[], prefix = ''): string[] {
  return errors.flatMap((error) => {
    const path = prefix ? `${prefix}.${error.property}` : error.property;
    const own = Object.values(error.constraints ?? {}).map((message) => (message.startsWith(error.property) ? `${prefix ? `${prefix}.` : ''}${message}` : `${path}: ${message}`));
    return [...own, ...flatten(error.children ?? [], path)];
  });
}
