import { describe, expect, it } from 'vitest';

import type { CategoryTreeNode } from '@/lib/api/types';

import { SKU_PATTERN, buildVariantMatrix, duplicateSkus, emptyVariantRow, flattenCategories, suggestSku, variantRowToInput } from './product-form';

const defaults = { priceToman: '1200000', compareToman: '', stock: '5', skuPrefix: 'tshirt' };

describe('buildVariantMatrix', () => {
  it('builds colour × size rows with SKUs that pass the backend pattern', () => {
    const rows = buildVariantMatrix(
      [
        { name: 'Black', hex: '#111111' },
        { name: 'آبی', hex: '#1d4ed8' },
      ],
      ['M', 'L'],
      defaults,
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.sku)).toEqual(['TSHIRT-BLACK-M', 'TSHIRT-BLACK-L', 'TSHIRT-C2-M', 'TSHIRT-C2-L']);
    expect(rows[2]?.colorHex).toBe('#1D4ED8');
    for (const row of rows) expect(SKU_PATTERN.test(row.sku)).toBe(true);
  });

  it('collapses missing dimensions', () => {
    expect(buildVariantMatrix([], ['S', 'M', 'L'], defaults)).toHaveLength(3);
    expect(buildVariantMatrix([], [], defaults)).toHaveLength(1);
  });
});

describe('suggestSku', () => {
  it('falls back for non-Latin prefixes', () => {
    expect(suggestSku('تیشرت', 0, '', '')).toBe('SKU');
  });
});

describe('variantRowToInput', () => {
  it('converts Toman to Rials and normalises SKU/hex', () => {
    const result = variantRowToInput(emptyVariantRow({ sku: 'ab-1', colorName: 'Red', colorHex: '#ff0000', size: 'XL', priceToman: '۱۲۰٬۰۰۰', compareToman: '150000', stock: '3' }));
    expect(result).toEqual({ ok: true, value: { sku: 'AB-1', colorName: 'Red', colorHex: '#FF0000', size: 'XL', price: 1_200_000, compareAtPrice: 1_500_000, stockQuantity: 3 } });
  });

  it('rejects a compare price that is not above the price', () => {
    const result = variantRowToInput(emptyVariantRow({ sku: 'A1', priceToman: '100', compareToman: '100', stock: '1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects invalid SKUs and stock', () => {
    expect(variantRowToInput(emptyVariantRow({ sku: '-bad', priceToman: '100', stock: '1' })).ok).toBe(false);
    expect(variantRowToInput(emptyVariantRow({ sku: 'OK1', priceToman: '100', stock: '1.5' })).ok).toBe(false);
  });
});

describe('duplicateSkus', () => {
  it('is case-insensitive', () => {
    expect(duplicateSkus([emptyVariantRow({ sku: 'a1' }), emptyVariantRow({ sku: 'A1' }), emptyVariantRow({ sku: 'B' })])).toEqual(['A1']);
  });
});

describe('flattenCategories', () => {
  it('indents children', () => {
    const node = (id: string, children: CategoryTreeNode[] = []): CategoryTreeNode => ({ id, slug: id, titleFa: id, titleEn: null, parentId: null, defaultCommissionRate: '0', sortOrder: 0, depth: 0, productCount: 0, totalProductCount: 0, children });
    expect(flattenCategories([node('a', [node('b')])]).map((option) => option.label)).toEqual(['a', '— b']);
  });
});
