import { SKU_PATTERN } from '../../products/product-rules';
import type { ExtractedProduct } from '../extractors/extracted-product';
import { buildProductDraft, draftProblems, importSku, resolveUnit, type DraftOptions } from './product-draft';

const CATEGORY = '0b6f5f7e-1d8c-4a55-9f30-1c7c1e0c2a11';
const VENDOR = '7d1e2c3b-4a59-4b6c-8d7e-9f0a1b2c3d4e';

function product(overrides: Partial<ExtractedProduct> = {}): ExtractedProduct {
  return {
    source: 'GENERIC',
    strategies: ['JSON_LD'],
    sourceUrl: 'https://shop.ir/product/a/',
    sourceProductId: null,
    title: 'قابلمه استیل ۲۴ سانتی',
    titleEn: null,
    brand: 'زرین',
    description: 'قابلمه استیل ضدزنگ',
    suggestedCategory: 'قابلمه',
    categoryCandidates: ['قابلمه'],
    specifications: [{ group: null, title: 'جنس', value: 'استیل' }],
    imageUrls: [],
    offer: { amount: 1850000, oldAmount: 2100000, currency: 'IRT', inStock: true },
    ...overrides,
  };
}

const options: DraftOptions = { autoPublish: true, priceUnit: 'AUTO', defaultStock: 7, defaultCategoryId: null };

describe('importSku', () => {
  it('is deterministic per store and page, ignores www/scheme/fragment, and is a valid SKU', () => {
    const a = importSku(VENDOR, 'https://www.shop.ir/product/a/#tab');
    expect(a).toBe(importSku(VENDOR, 'http://shop.ir/product/a'));
    expect(a).toMatch(/^IMP-[0-9A-F]{16}$/);
    expect(SKU_PATTERN.test(a)).toBe(true);
    expect(importSku('another-store', 'https://shop.ir/product/a/')).not.toBe(a);
    expect(importSku(VENDOR, 'https://shop.ir/product/b/')).not.toBe(a);
  });
});

describe('resolveUnit', () => {
  it('uses the override, else the declared Iranian unit', () => {
    expect(resolveUnit('IRT', 'IRR')).toBe('IRT');
    expect(resolveUnit('AUTO', 'IRHT')).toBe('IRHT');
    expect(resolveUnit('AUTO', 'USD')).toBeNull();
    expect(resolveUnit('AUTO', null)).toBeNull();
    expect(resolveUnit('IRR', null)).toBe('IRR');
  });

  it('never relabels a foreign currency as rials or tomans', () => {
    expect(resolveUnit('IRT', 'USD')).toBeNull();
    expect(resolveUnit('IRR', 'EUR')).toBeNull();
  });
});

describe('buildProductDraft', () => {
  it('builds a valid product in rials with the discount, stock and publish flag', async () => {
    const result = buildProductDraft({ product: product(), sku: 'IMP-0123456789ABCDEF', categoryId: CATEGORY, options });
    expect(result.kind).toBe('ready');
    if (result.kind !== 'ready') return;
    expect(result.priceIrr).toBe(18_500_000);
    expect(result.dto.basePrice).toBe(18_500_000);
    expect(result.dto.variants).toEqual([
      expect.objectContaining({ sku: 'IMP-0123456789ABCDEF', price: 18_500_000, compareAtPrice: 21_000_000, stockQuantity: 7, isActive: true }),
    ]);
    expect(result.dto.isPublished).toBe(true);
    expect(result.dto.specifications).toEqual([expect.objectContaining({ groupTitle: null, title: 'جنس', value: 'استیل' })]);
    expect(await draftProblems(result.dto)).toEqual([]);
  });

  it('gives out-of-stock products zero stock', () => {
    const result = buildProductDraft({
      product: product({ offer: { amount: 100, oldAmount: null, currency: 'IRR', inStock: false } }),
      sku: 'IMP-1',
      categoryId: CATEGORY,
      options,
    });
    expect(result.kind === 'ready' && result.dto.variants[0]!.stockQuantity).toBe(0);
    expect(result.kind === 'ready' && result.inStock).toBe(false);
  });

  it('lets the user override the unit the page declares', () => {
    const result = buildProductDraft({
      product: product({ offer: { amount: 1850000, oldAmount: null, currency: 'IRR', inStock: true } }),
      sku: 'IMP-1',
      categoryId: CATEGORY,
      options: { ...options, priceUnit: 'IRT' },
    });
    expect(result.kind === 'ready' && result.priceIrr).toBe(18_500_000);
  });

  it.each([
    ['no price', product({ offer: null }), CATEGORY, 'NO_PRICE'],
    ['unknown unit', product({ offer: { amount: 5, oldAmount: null, currency: null, inStock: true } }), CATEGORY, 'UNKNOWN_CURRENCY'],
    ['foreign currency', product({ offer: { amount: 98, oldAmount: null, currency: 'USD', inStock: true } }), CATEGORY, 'FOREIGN_CURRENCY'],
    ['no category', product(), null, 'NO_CATEGORY'],
  ])('asks for review on %s instead of guessing', (_label, extracted, categoryId, code) => {
    const result = buildProductDraft({ product: extracted, sku: 'IMP-1', categoryId, options });
    expect(result).toEqual({ kind: 'review', code, message: expect.any(String) as string });
  });

  it('surfaces DTO violations (e.g. a title that is too short)', async () => {
    const result = buildProductDraft({ product: product({ title: 'ab' }), sku: 'IMP-1', categoryId: CATEGORY, options });
    expect(result.kind).toBe('ready');
    if (result.kind === 'ready') {
      expect((await draftProblems(result.dto)).join(' ')).toContain('title');
    }
  });
});
