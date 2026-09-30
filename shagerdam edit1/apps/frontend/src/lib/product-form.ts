import type { CategoryTreeNode, CreateVariantInput } from '@/lib/api/types';
import { tomanToRials } from '@/lib/currency';
import { toLatinDigits } from '@/lib/format';

/** Mirrors backend product-rules.ts. */
export const SKU_PATTERN = /^[A-Z0-9](?:[A-Z0-9._-]{0,62}[A-Z0-9])?$/;
export const COLOR_HEX_PATTERN = /^#[0-9A-F]{6}$/;
export const MAX_VARIANTS_PER_PRODUCT = 100;
export const MAX_MEDIA_PER_PRODUCT = 12;
export const MAX_STOCK = 1_000_000;
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Editable variant row: money fields are Toman text as typed. */
export interface VariantRow {
  key: string;
  colorName: string;
  colorHex: string;
  size: string;
  priceToman: string;
  compareToman: string;
  stock: string;
  sku: string;
}

export interface ColorChoice {
  name: string;
  hex: string;
}

let rowCounter = 0;
export function newRowKey(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

export function emptyVariantRow(defaults: Partial<VariantRow> = {}): VariantRow {
  return { key: newRowKey(), colorName: '', colorHex: '', size: '', priceToman: '', compareToman: '', stock: '0', sku: '', ...defaults };
}

/** Upper-case Latin token for SKUs ("Navy Blue" → "NAVY-BLUE"; non-Latin text → fallback). */
function skuToken(value: string, fallback: string): string {
  const token = toLatinDigits(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16);
  return token || fallback;
}

/** Suggested SKU: PREFIX-COLOR-SIZE, always matching SKU_PATTERN. */
export function suggestSku(prefix: string, colorIndex: number, color: string, size: string): string {
  const parts = [skuToken(prefix, 'SKU').slice(0, 20)];
  if (color) parts.push(skuToken(color, `C${colorIndex + 1}`));
  if (size) parts.push(skuToken(size, 'S'));
  return parts.join('-').slice(0, 64).replace(/[-._]+$/g, '');
}

/**
 * Colour × size matrix. Empty colour or size lists collapse that dimension, so
 * sizes only, colours only and both all work. Price/stock defaults fill every row.
 */
export function buildVariantMatrix(colors: ColorChoice[], sizes: string[], defaults: { priceToman: string; compareToman: string; stock: string; skuPrefix: string }): VariantRow[] {
  const colorList: Array<ColorChoice | null> = colors.length ? colors : [null];
  const sizeList: Array<string | null> = sizes.length ? sizes : [null];
  const rows: VariantRow[] = [];
  colorList.forEach((color, colorIndex) => {
    for (const size of sizeList) {
      rows.push(
        emptyVariantRow({
          colorName: color?.name ?? '',
          colorHex: color?.hex.toUpperCase() ?? '',
          size: size ?? '',
          priceToman: defaults.priceToman,
          compareToman: defaults.compareToman,
          stock: defaults.stock,
          sku: suggestSku(defaults.skuPrefix, colorIndex, color?.name ?? '', size ?? ''),
        }),
      );
    }
  });
  return rows;
}

export type RowResult = { ok: true; value: CreateVariantInput } | { ok: false; error: string };

/** Validates one row and converts it to the API payload (Rials, upper-case SKU/hex). */
export function variantRowToInput(row: VariantRow): RowResult {
  const sku = row.sku.trim().toUpperCase();
  if (!SKU_PATTERN.test(sku)) return { ok: false, error: `SKU «${row.sku || '—'}» معتبر نیست (حروف لاتین بزرگ، رقم، . _ -).` };
  const hex = row.colorHex.trim().toUpperCase();
  if (hex && !COLOR_HEX_PATTERN.test(hex)) return { ok: false, error: `کد رنگ ${sku} باید به شکل ‎#RRGGBB باشد.` };
  if (hex && !row.colorName.trim()) return { ok: false, error: `برای رنگ ${sku} نام رنگ را وارد کنید.` };
  if (row.colorName.trim().length > 40) return { ok: false, error: `نام رنگ ${sku} حداکثر ۴۰ نویسه است.` };
  if (row.size.trim().length > 20) return { ok: false, error: `سایز ${sku} حداکثر ۲۰ نویسه است.` };
  let price: number;
  let compareAtPrice: number | null = null;
  try {
    price = tomanToRials(row.priceToman);
    if (row.compareToman.trim()) compareAtPrice = tomanToRials(row.compareToman);
  } catch (caught) {
    return { ok: false, error: `${sku}: ${caught instanceof Error ? caught.message : 'مبلغ نامعتبر'}` };
  }
  if (price <= 0) return { ok: false, error: `قیمت ${sku} باید بیشتر از صفر باشد.` };
  if (compareAtPrice !== null && compareAtPrice <= price) return { ok: false, error: `قیمت قبل از تخفیف ${sku} باید بیشتر از قیمت فروش باشد.` };
  const stockText = toLatinDigits(row.stock.trim());
  const stock = Number(stockText);
  if (!/^\d+$/.test(stockText) || stock > MAX_STOCK) return { ok: false, error: `موجودی ${sku} باید عدد صحیح بین ۰ و ۱٬۰۰۰٬۰۰۰ باشد.` };
  return {
    ok: true,
    value: {
      sku,
      colorName: row.colorName.trim() || null,
      colorHex: hex || null,
      size: row.size.trim() || null,
      price,
      compareAtPrice,
      stockQuantity: stock,
    },
  };
}

/** Duplicate SKUs inside the form (the backend also rejects duplicates across the store). */
export function duplicateSkus(rows: VariantRow[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const sku = row.sku.trim().toUpperCase();
    if (!sku) continue;
    if (seen.has(sku)) duplicates.add(sku);
    seen.add(sku);
  }
  return [...duplicates];
}

export interface CategoryOption {
  id: string;
  label: string;
  depth: number;
}

/** Depth-first flattening of the category tree for a <select>, indented by depth. */
export function flattenCategories(nodes: CategoryTreeNode[], depth = 0): CategoryOption[] {
  return nodes.flatMap((node) => [{ id: node.id, label: `${'— '.repeat(depth)}${node.titleFa}`, depth }, ...flattenCategories(node.children, depth + 1)]);
}
