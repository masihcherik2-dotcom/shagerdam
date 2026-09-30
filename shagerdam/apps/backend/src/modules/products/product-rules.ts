import { Prisma } from '@prisma/client';
import { normalizePersianText } from './catalog-text';

/**
 * Business rules of the variant matrix that do not need the database. The
 * service applies them before any write; the database CHECK constraints
 * (`product_variants_price_check`, `product_variants_inventory_check`) are the
 * backstop for any path that bypasses the service.
 */

/** Upper-case letters, digits, dot, underscore and hyphen; 1–64 characters, alphanumeric at both ends. */
export const SKU_PATTERN = /^[A-Z0-9](?:[A-Z0-9._-]{0,62}[A-Z0-9])?$/;
export const COLOR_HEX_PATTERN = /^#[0-9A-F]{6}$/;

export const MAX_VARIANTS_PER_PRODUCT = 100;
export const MAX_MEDIA_PER_PRODUCT = 12;
/** Largest amount a `Decimal(15,2)` column can hold. */
export const MAX_MONEY = 9_999_999_999_999.99;
export const MAX_STOCK = 1_000_000;

/** Technical-specification limits (mirrored by the `product_specifications` columns). */
export const MAX_SPECIFICATIONS_PER_PRODUCT = 150;
export const SPECIFICATION_GROUP_MAX_LENGTH = 100;
export const SPECIFICATION_TITLE_MAX_LENGTH = 150;
export const SPECIFICATION_VALUE_MAX_LENGTH = 2000;

export interface SpecificationInput {
  groupTitle?: string | null;
  title: string;
  value: string;
}

export interface NormalizedSpecification {
  groupTitle: string | null;
  title: string;
  value: string;
  sortOrder: number;
}

/**
 * Canonical form of a specification list: Persian-normalised text (values keep
 * their line breaks), blank groups become `null`, exact duplicates (same group,
 * title and value) are dropped, and the order the vendor sent is kept through
 * `sortOrder` (steps of 10 so a later insert never needs a renumbering).
 */
export function normalizeSpecifications(list: readonly SpecificationInput[]): NormalizedSpecification[] {
  const seen = new Set<string>();
  const result: NormalizedSpecification[] = [];
  for (const entry of list) {
    const groupTitle = entry.groupTitle ? normalizePersianText(entry.groupTitle) : '';
    const title = normalizePersianText(entry.title);
    const value = entry.value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => normalizePersianText(line))
      .filter((line) => line.length > 0)
      .join('\n');
    if (title.length === 0 || value.length === 0) {
      continue;
    }
    const key = `${groupTitle}\u0000${title}\u0000${value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ groupTitle: groupTitle.length > 0 ? groupTitle : null, title, value, sortOrder: (result.length + 1) * 10 });
  }
  return result;
}

export function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeColorHex(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Discount shown to the buyer, rounded **down** to a whole percent so the badge
 * never promises more than the real reduction:
 * `floor((compareAtPrice - price) / compareAtPrice * 100)`.
 * `null` when there is no strike-through price or it is not above the price.
 */
export function discountPercent(
  price: Prisma.Decimal | string | number,
  compareAtPrice: Prisma.Decimal | string | number | null | undefined,
): number | null {
  if (compareAtPrice === null || compareAtPrice === undefined) {
    return null;
  }
  const selling = new Prisma.Decimal(price);
  const original = new Prisma.Decimal(compareAtPrice);
  if (original.lte(selling) || original.lte(0)) {
    return null;
  }
  return original.minus(selling).div(original).mul(100).floor().toNumber();
}

/** Converts a validated JS number to a two-decimal `Decimal` without float noise. */
export function toMoney(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(2));
}

export interface VariantShape {
  sku: string;
  colorName?: string | null;
  colorHex?: string | null;
  size?: string | null;
  guarantee?: string | null;
  price: number | Prisma.Decimal;
  compareAtPrice?: number | Prisma.Decimal | null;
}

/**
 * Identity of a cell in the variant matrix. Two variants with the same colour,
 * size and guarantee would be indistinguishable to the buyer, so the pair is
 * rejected. Comparison is case- and keyboard-insensitive.
 */
export function variantMatrixKey(variant: Pick<VariantShape, 'colorName' | 'size' | 'guarantee'>): string {
  const part = (value: string | null | undefined): string =>
    value ? normalizePersianText(value).toLocaleLowerCase('fa') : '';
  return `${part(variant.colorName)}|${part(variant.size)}|${part(variant.guarantee)}`;
}

/** Values that occur more than once, in first-seen order. */
export function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    }
    seen.add(value);
  }
  return [...repeated];
}

/**
 * Human-readable problems with one variant's own fields (no cross-variant
 * checks). Empty when the variant is valid.
 */
export function variantFieldProblems(variant: VariantShape): string[] {
  const problems: string[] = [];
  const price = new Prisma.Decimal(variant.price);

  if (price.lte(0)) {
    problems.push(`${variant.sku}: price must be greater than 0`);
  }
  if (variant.compareAtPrice !== null && variant.compareAtPrice !== undefined) {
    const original = new Prisma.Decimal(variant.compareAtPrice);
    if (original.lte(price)) {
      problems.push(
        `${variant.sku}: compareAtPrice (${original.toFixed(2)}) must be greater than price (${price.toFixed(2)})`,
      );
    }
  }
  if (variant.colorHex && !variant.colorName) {
    problems.push(`${variant.sku}: colorHex requires colorName`);
  }
  return problems;
}

/**
 * Validates a whole matrix submitted in one request: field rules on every
 * variant, unique SKUs and unique colour/size/guarantee cells.
 */
export function matrixProblems(variants: readonly VariantShape[]): string[] {
  const problems = variants.flatMap((variant) => variantFieldProblems(variant));

  const repeatedSkus = duplicates(variants.map((variant) => variant.sku));
  if (repeatedSkus.length > 0) {
    problems.push(`Duplicate SKU in request: ${repeatedSkus.join(', ')}`);
  }

  const repeatedCells = duplicates(variants.map((variant) => variantMatrixKey(variant)));
  if (repeatedCells.length > 0) {
    problems.push(
      `Two variants share the same colour/size/guarantee: ${repeatedCells
        .map((key) => key.split('|').map((part) => part || '—').join(' / '))
        .join('; ')}`,
    );
  }
  return problems;
}
