import { describe, expect, it } from 'vitest';

import type { CategoryTreeNode, ProductDetail } from './api/types';
import { absoluteUrl, flattenCategorySlugs, productBreadcrumbJsonLd, productJsonLd, productMetaDescription, ROBOTS_DISALLOW, schemaPrice, serializeJsonLd } from './seo';

const ORIGIN = 'https://shagerdam.ir';

function product(overrides: Partial<ProductDetail> = {}): ProductDetail {
  return {
    id: 'p1',
    slug: 'تیشرت-نخی',
    title: 'تیشرت نخی',
    description: 'پارچهٔ نخی\n\nدوخت مرغوب',
    brand: 'شاگردم',
    breadcrumbs: [
      { id: 'c1', slug: 'fashion', titleFa: 'مد و پوشاک', titleEn: null },
      { id: 'c2', slug: 'men', titleFa: 'پوشاک مردانه', titleEn: null },
    ],
    vendor: { id: 'v1', storeName: 'فروشگاه نمونه', storeSlug: 'sample', logoUrl: null, bio: null, instagramHandle: null, verifiedAt: null } as unknown as ProductDetail['vendor'],
    media: [{ url: '/api/v1/media/files/a.webp', thumbnailUrl: null }, { url: 'https://cdn.example/b.webp', thumbnailUrl: null }],
    variants: [
      { id: 'x1', sku: 'SHP-TSHIRT-WHT-L', colorName: null, colorHex: null, size: 'L', guarantee: null, price: '8900000.00', compareAtPrice: null, discountPercent: null, availableQuantity: 3, inStock: true, weightGrams: null },
      { id: 'x2', sku: 'SHP-TSHIRT-BLK-L', colorName: null, colorHex: null, size: 'L', guarantee: null, price: '9500000.50', compareAtPrice: null, discountPercent: null, availableQuantity: 0, inStock: false, weightGrams: null },
    ],
    priceRange: { min: '8900000.00', max: '9500000.50' },
    maxDiscountPercent: null,
    colors: [],
    sizes: [],
    inStock: true,
    specifications: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('seo helpers', () => {
  it('formats schema prices', () => {
    expect(schemaPrice('8900000.00')).toBe('8900000');
    expect(schemaPrice('9500000.50')).toBe('9500000.5');
    expect(schemaPrice('120')).toBe('120');
    expect(schemaPrice('abc')).toBe('0');
  });

  it('builds absolute URLs', () => {
    expect(absoluteUrl(ORIGIN, '/a.webp')).toBe('https://shagerdam.ir/a.webp');
    expect(absoluteUrl(ORIGIN, 'a.webp')).toBe('https://shagerdam.ir/a.webp');
    expect(absoluteUrl(ORIGIN, 'https://cdn.example/b.webp')).toBe('https://cdn.example/b.webp');
  });

  it('emits an AggregateOffer for several variants', () => {
    const data = productJsonLd(product(), ORIGIN);
    expect(data).toMatchObject({
      '@type': 'Product',
      name: 'تیشرت نخی',
      url: `${ORIGIN}/products/${encodeURIComponent('تیشرت-نخی')}`,
      image: [`${ORIGIN}/api/v1/media/files/a.webp`, 'https://cdn.example/b.webp'],
      description: 'پارچهٔ نخی دوخت مرغوب',
      sku: 'SHP-TSHIRT-WHT-L',
      brand: { '@type': 'Brand', name: 'شاگردم' },
      category: 'مد و پوشاک > پوشاک مردانه',
      offers: { '@type': 'AggregateOffer', lowPrice: '8900000', highPrice: '9500000.5', offerCount: 2, priceCurrency: 'IRR', availability: 'https://schema.org/InStock', seller: { name: 'فروشگاه نمونه' } },
    });
    expect(JSON.stringify(data)).not.toMatch(/aggregateRating|review/);
  });

  it('emits a single Offer for one variant, and none without variants', () => {
    const single = productJsonLd(product({ variants: [product().variants[1]!], inStock: false }), ORIGIN);
    expect(single.offers).toMatchObject({ '@type': 'Offer', sku: 'SHP-TSHIRT-BLK-L', price: '9500000.5', availability: 'https://schema.org/OutOfStock' });
    const none = productJsonLd(product({ variants: [], media: [], brand: null, description: null }), ORIGIN);
    expect(none).not.toHaveProperty('offers');
    expect(none).not.toHaveProperty('image');
    expect(none).not.toHaveProperty('brand');
  });

  it('builds the breadcrumb list from home to product', () => {
    const data = productBreadcrumbJsonLd(product(), ORIGIN, 'شاگردم') as { itemListElement: Array<{ position: number; name: string; item: string }> };
    expect(data.itemListElement.map((entry) => [entry.position, entry.name])).toEqual([
      [1, 'شاگردم'],
      [2, 'مد و پوشاک'],
      [3, 'پوشاک مردانه'],
      [4, 'تیشرت نخی'],
    ]);
    expect(data.itemListElement[1]!.item).toBe(`${ORIGIN}/categories/fashion`);
  });

  it('serialises JSON-LD so untrusted text cannot close the script element', () => {
    const json = serializeJsonLd({ name: '</script><script>alert(1)</script> & co' });
    expect(json).not.toContain('<');
    expect(json).not.toContain('>');
    expect(JSON.parse(json)).toEqual({ name: '</script><script>alert(1)</script> & co' });
  });

  it('flattens the category tree depth-first', () => {
    const node = (slug: string, children: CategoryTreeNode[] = []): CategoryTreeNode => ({ id: slug, slug, titleFa: slug, titleEn: null, parentId: null, defaultCommissionRate: '0', sortOrder: 0, depth: 0, productCount: 0, totalProductCount: 0, children });
    expect(flattenCategorySlugs([node('a', [node('a1'), node('a2', [node('a2x')])]), node('b')])).toEqual(['a', 'a1', 'a2', 'a2x', 'b']);
  });

  it('keeps panels, checkout and the API out of the index', () => {
    expect(ROBOTS_DISALLOW).toEqual(expect.arrayContaining(['/admin/', '/customer/', '/vendor/', '/checkout/', '/api/']));
  });

  it('builds a bounded meta description from real product text only', () => {
    const base = { title: 'تی‌شرت نخی', brand: null, vendor: { storeName: 'فروشگاه نمونه' } } as unknown as Parameters<typeof productMetaDescription>[0];
    expect(productMetaDescription({ ...base, description: '  پارچهٔ   نخی\nخنک ' })).toBe('پارچهٔ نخی خنک');
    const long = productMetaDescription({ ...base, description: 'الف '.repeat(100) });
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith('…')).toBe(true);
    expect(productMetaDescription({ ...base, description: null, brand: 'شاپینو' })).toBe('خرید شاپینو تی‌شرت نخی از فروشگاه فروشگاه نمونه');
  });
});
