import { Prisma, VendorStatus } from '@prisma/client';
import {
  TOROB_MAX_IMAGES,
  absoluteUrl,
  buildSpec,
  isListed,
  parseProductPageUrl,
  productPageUrl,
  sellableQuantity,
  toFeedAmount,
  toTorobItem,
  variantTitle,
  type TorobMappingContext,
  type TorobVariantRow,
} from './torob-item.mapper';

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function row(overrides: Partial<TorobVariantRow> = {}, product: Partial<TorobVariantRow['product']> = {}): TorobVariantRow {
  return {
    sku: 'SHP-VAR-10023',
    colorName: 'مشکی تیتانیوم',
    size: null,
    guarantee: 'گارانتی ۱۸ ماهه شرکتی',
    price: D('620000000'),
    compareAtPrice: D('650000000'),
    stockQuantity: 5,
    reservedQuantity: 2,
    isActive: true,
    ...overrides,
    product: {
      title: 'گوشی موبایل سامسونگ مدل Galaxy S24 Ultra',
      slug: 'samsung-s24-ultra',
      brand: 'سامسونگ',
      categoryId: 'cat-mobile',
      isPublished: true,
      isBlockedByAdmin: false,
      vendor: { status: VendorStatus.APPROVED, shippingFeeOverride: null, freeShippingThreshold: null },
      media: [
        { url: '/api/v1/media/files/images/product_image/2026/09/b.webp', isPrimary: false, sortOrder: 1 },
        { url: '/api/v1/media/files/images/product_image/2026/09/a.webp', isPrimary: true, sortOrder: 0 },
      ],
      specifications: [
        { groupTitle: 'حافظه', title: 'حافظه داخلی', value: '256 گیگابایت' },
        { groupTitle: 'حافظه', title: 'مقدار RAM', value: '12 گیگابایت' },
      ],
      ...product,
    },
  };
}

function context(overrides: Partial<TorobMappingContext> = {}): TorobMappingContext {
  return {
    webOrigin: 'https://shagerdam.ir',
    assetOrigin: 'https://shagerdam.ir',
    priceUnit: 'IRR',
    shippingPolicy: { defaultFeePerVendor: D('500000'), freeThresholdPerVendor: D('0') },
    categoryPaths: new Map([['cat-mobile', 'کالای دیجیتال > گوشی موبایل']]),
    ...overrides,
  };
}

describe('Torob item mapper', () => {
  describe('toTorobItem', () => {
    it('maps a listed, discounted, in-stock variant to the feed schema', () => {
      expect(toTorobItem(row(), context())).toEqual({
        page_unique: 'SHP-VAR-10023',
        title: 'گوشی موبایل سامسونگ مدل Galaxy S24 Ultra، رنگ مشکی تیتانیوم',
        price: 620000000,
        old_price: 650000000,
        availability: 'instock',
        page_url: 'https://shagerdam.ir/products/samsung-s24-ultra?variant=SHP-VAR-10023',
        image_links: [
          'https://shagerdam.ir/api/v1/media/files/images/product_image/2026/09/a.webp',
          'https://shagerdam.ir/api/v1/media/files/images/product_image/2026/09/b.webp',
        ],
        category_name: 'کالای دیجیتال > گوشی موبایل',
        spec: {
          'حافظه داخلی': '256 گیگابایت',
          'مقدار RAM': '12 گیگابایت',
          برند: 'سامسونگ',
          رنگ: 'مشکی تیتانیوم',
          گارانتی: 'گارانتی ۱۸ ماهه شرکتی',
        },
        guarantee: 'گارانتی ۱۸ ماهه شرکتی',
        delivery_fee: 500000,
      });
    });

    it('uses stock minus reservations: fully reserved stock is out of stock', () => {
      expect(toTorobItem(row({ stockQuantity: 3, reservedQuantity: 3 }), context()).availability).toBe('outofstock');
      expect(toTorobItem(row({ stockQuantity: 3, reservedQuantity: 2 }), context()).availability).toBe('instock');
      expect(toTorobItem(row({ stockQuantity: 0, reservedQuantity: 0 }), context()).availability).toBe('outofstock');
    });

    it.each([
      ['unpublished', row({}, { isPublished: false })],
      ['blocked by staff', row({}, { isBlockedByAdmin: true })],
      ['store suspended', row({}, { vendor: { status: VendorStatus.SUSPENDED, shippingFeeOverride: null, freeShippingThreshold: null } })],
      ['variant deactivated', row({ isActive: false })],
      ['category hidden', row({}, { categoryId: 'cat-hidden' })],
    ])('reports an existing but unlisted offer (%s) as out of stock', (_label, unlisted) => {
      expect(isListed(unlisted, context())).toBe(false);
      expect(toTorobItem(unlisted, context()).availability).toBe('outofstock');
    });

    it('omits old_price unless the compare-at price is higher', () => {
      expect(toTorobItem(row({ compareAtPrice: null }), context()).old_price).toBeNull();
      expect(toTorobItem(row({ compareAtPrice: D('620000000') }), context()).old_price).toBeNull();
      expect(toTorobItem(row({ compareAtPrice: D('600000000') }), context()).old_price).toBeNull();
    });

    it('publishes Toman when configured (Rial ÷ 10, half-up), for prices and the delivery fee', () => {
      const item = toTorobItem(row({ price: D('620000005'), compareAtPrice: D('650000000') }), context({ priceUnit: 'IRT' }));
      expect(item.price).toBe(62000001);
      expect(item.old_price).toBe(65000000);
      expect(item.delivery_fee).toBe(50000);
    });

    it('prices delivery with the checkout formula: store override, then free above the threshold', () => {
      const vendor = { status: VendorStatus.APPROVED, shippingFeeOverride: D('300000'), freeShippingThreshold: null };
      expect(toTorobItem(row({}, { vendor }), context()).delivery_fee).toBe(300000);
      const freeAbove = { ...vendor, freeShippingThreshold: D('100000000') };
      expect(toTorobItem(row({}, { vendor: freeAbove }), context()).delivery_fee).toBe(0);
      expect(toTorobItem(row({ price: D('90000000') }, { vendor: freeAbove }), context()).delivery_fee).toBe(300000);
    });

    it('keeps absolute storage URLs, orders the primary image first and caps the gallery', () => {
      const media = Array.from({ length: 12 }, (_, index) => ({
        url: `https://cdn.example.ir/images/${index}.webp`,
        isPrimary: index === 7,
        sortOrder: index,
      }));
      const links = toTorobItem(row({}, { media }), context()).image_links;
      expect(links).toHaveLength(TOROB_MAX_IMAGES);
      expect(links[0]).toBe('https://cdn.example.ir/images/7.webp');
      expect(links[1]).toBe('https://cdn.example.ir/images/0.webp');
    });

    it('has a null category and guarantee when unknown', () => {
      const item = toTorobItem(row({ guarantee: '  ' }, { categoryId: 'cat-hidden' }), context());
      expect(item.category_name).toBeNull();
      expect(item.guarantee).toBeNull();
    });
  });

  describe('helpers', () => {
    it('sellableQuantity never goes negative', () => {
      expect(sellableQuantity({ stockQuantity: 5, reservedQuantity: 2 })).toBe(3);
      expect(sellableQuantity({ stockQuantity: 1, reservedQuantity: 4 })).toBe(0);
    });

    it('toFeedAmount returns integers in the requested unit', () => {
      expect(toFeedAmount(D('1250000.00'), 'IRR')).toBe(1250000);
      expect(toFeedAmount(D('1250004'), 'IRT')).toBe(125000);
      expect(toFeedAmount(D('1250005'), 'IRT')).toBe(125001);
    });

    it('absoluteUrl prefixes only relative URLs', () => {
      expect(absoluteUrl('/api/v1/media/files/x.webp', 'https://shagerdam.ir')).toBe('https://shagerdam.ir/api/v1/media/files/x.webp');
      expect(absoluteUrl('api/x.webp', 'https://shagerdam.ir')).toBe('https://shagerdam.ir/api/x.webp');
      expect(absoluteUrl('https://s3.ir-thr-at1.arvanstorage.ir/b/x.webp', 'https://shagerdam.ir')).toBe('https://s3.ir-thr-at1.arvanstorage.ir/b/x.webp');
    });

    it('variantTitle appends colour and size when present', () => {
      expect(variantTitle('تیشرت نخی', 'سفید', 'XL')).toBe('تیشرت نخی، رنگ سفید، سایز XL');
      expect(variantTitle('تیشرت نخی', null, '  ')).toBe('تیشرت نخی');
    });

    it('buildSpec disambiguates a title repeated in two groups and lets variant attributes win', () => {
      const spec = buildSpec(
        row({ colorName: 'آبی' }, {
          brand: null,
          specifications: [
            { groupTitle: 'دوربین اصلی', title: 'رزولوشن', value: '200 مگاپیکسل' },
            { groupTitle: 'دوربین سلفی', title: 'رزولوشن', value: '12 مگاپیکسل' },
            { groupTitle: null, title: 'رنگ', value: 'چندرنگ' },
            { groupTitle: null, title: 'خالی', value: '  ' },
          ],
        }),
      );
      expect(spec).toEqual({
        رزولوشن: '200 مگاپیکسل',
        'رزولوشن (دوربین سلفی)': '12 مگاپیکسل',
        رنگ: 'آبی',
        گارانتی: 'گارانتی ۱۸ ماهه شرکتی',
      });
    });

    it('productPageUrl encodes Persian slugs and the SKU', () => {
      expect(productPageUrl('https://shagerdam.ir', 'کفش-ورزشی', 'A.B-1')).toBe(
        'https://shagerdam.ir/products/%DA%A9%D9%81%D8%B4-%D9%88%D8%B1%D8%B2%D8%B4%DB%8C?variant=A.B-1',
      );
    });
  });

  describe('parseProductPageUrl', () => {
    const origin = 'https://shagerdam.ir';

    it('parses the canonical link, with or without www and trailing slash', () => {
      expect(parseProductPageUrl('https://shagerdam.ir/products/samsung-s24-ultra?variant=shp-var-1', origin)).toEqual({ slug: 'samsung-s24-ultra', sku: 'SHP-VAR-1' });
      expect(parseProductPageUrl('http://www.shagerdam.ir/products/samsung-s24-ultra/', origin)).toEqual({ slug: 'samsung-s24-ultra', sku: null });
    });

    it('decodes Persian slugs (round trip with productPageUrl)', () => {
      const url = productPageUrl(origin, 'کفش-ورزشی', 'SKU-1');
      expect(parseProductPageUrl(url, origin)).toEqual({ slug: 'کفش-ورزشی', sku: 'SKU-1' });
    });

    it.each([
      'https://evil.example/products/samsung-s24-ultra',
      'https://shagerdam.ir.evil.example/products/x',
      'https://shagerdam.ir/categories/mobile',
      'https://shagerdam.ir/products/a/b',
      'ftp://shagerdam.ir/products/x',
      'https://shagerdam.ir/products/%E0%A4%A',
      'not a url',
    ])('rejects %s', (url) => {
      expect(parseProductPageUrl(url, origin)).toBeNull();
    });
  });
});
