import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bestQualityImageUrl } from './extracted-product';
import { decodeHtml, GenericSchemaOrgExtractor, parseJsonLd, parseProductHtml } from './generic-schema.extractor';
import { ImportError } from '../import-error';
import type { SafeFetchResult, SafeHttpClient } from '../net/safe-http-client';

const FIXTURES = join(__dirname, '../../../../test/fixtures/importer');
const html = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('parseProductHtml — WooCommerce page', () => {
  const draft = parseProductHtml(html('woocommerce-product.html'), new URL('https://shop.fixture.test/product/redmi-note-13/?utm=x'));

  it('reads the product from the WooCommerce JSON-LD graph', () => {
    expect(draft.source).toBe('GENERIC');
    expect(draft.title).toBe('گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت');
    expect(draft.brand).toBe('شیائومی');
    expect(draft.sourceProductId).toBe('RN13-256');
    expect(draft.sourceUrl).toBe('https://shop.fixture.test/product/redmi-note-13/');
  });

  it('turns the HTML description into plain text and drops scripts', () => {
    expect(draft.description).toBe('صفحه نمایش AMOLED & باتری 5000 میلی‌آمپر.\n\nگارانتی 18 ماهه');
    expect(draft.description).not.toMatch(/<|alert/);
  });

  it('suggests the category from the Yoast breadcrumb', () => {
    expect(draft.suggestedCategory).toBe('گوشی موبایل');
    expect(draft.categoryCandidates).toEqual(['گوشی موبایل', 'موبایل']);
  });

  it('reads the additional-information attribute table', () => {
    expect(draft.specifications).toEqual([
      { group: null, title: 'وزن', value: '188 گرم' },
      { group: null, title: 'حافظه RAM', value: '8 گیگابایت' },
      { group: null, title: 'شبکه ارتباطی', value: '4G, 3G' },
      { group: null, title: 'رنگ', value: 'مشکی، آبی' },
    ]);
  });

  it('takes full-size gallery images and resolves relative URLs', () => {
    expect(draft.imageUrls).toEqual([
      'https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front.jpg',
      'https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-back.jpg',
    ]);
  });

  it('reports only the strategies that contributed', () => {
    expect(draft.strategies).toEqual(['JSON_LD', 'WOOCOMMERCE_ATTRIBUTES', 'OPEN_GRAPH']);
  });
});

describe('parseProductHtml — Shopify ProductGroup', () => {
  const draft = parseProductHtml(html('shopify-product.html'), new URL('https://outfitters.fixture.test/products/trail-runner-wool'));

  it('tolerates a trailing comma in the JSON-LD and reads the group', () => {
    expect(draft.title).toBe('Trail Runner Wool');
    expect(draft.brand).toBe('Fixture Outfitters');
    expect(draft.sourceProductId).toBe('7421');
    expect(draft.description).toBe('A breathable\nwool runner, with a sugarcane sole.');
    expect(draft.specifications).toEqual([{ group: null, title: 'جنس', value: 'Merino wool' }]);
  });

  it('collects variant images at full size, once each', () => {
    expect(draft.imageUrls).toEqual([
      'https://cdn.shopify.com/s/files/1/0001/files/trail-runner-side.png?v=1751165486',
      'https://cdn.shopify.com/s/files/1/0001/files/trail-runner-grey.png?v=1751165490',
      'http://outfitters.fixture.test/cdn/shop/files/trail-runner-side.png?v=1751165486',
    ]);
  });
});

describe('parseProductHtml — microdata only', () => {
  const draft = parseProductHtml(html('microdata-product.html'), new URL('https://micro.fixture.test/p/x14'));

  it('reads name, brand, description, properties and images', () => {
    expect(draft.strategies).toEqual(['MICRODATA']);
    expect(draft.title).toBe('لپ‌تاپ ۱۴ اینچی مدل X14');
    expect(draft.brand).toBe('نمونه‌تک');
    expect(draft.description).toBe('پردازنده هشت‌هسته‌ای و باتری ۱۲ ساعته.');
    expect(draft.specifications).toEqual([
      { group: null, title: 'پردازنده', value: 'Core i7-1360P' },
      { group: null, title: 'حافظه', value: '16 گیگابایت' },
    ]);
    expect(draft.imageUrls).toEqual(['https://micro.fixture.test/images/x14-front.jpg', 'https://micro.fixture.test/images/x14-open.jpg']);
  });
});

describe('parseProductHtml — OpenGraph and rejection', () => {
  const page = (head: string): string => `<!doctype html><html><head>${head}</head><body><p>text</p></body></html>`;

  it('accepts an OpenGraph product page and strips the site-name suffix', () => {
    const draft = parseProductHtml(
      page(`<meta property="og:type" content="og:product">
            <meta property="og:site_name" content="دیجی‌استور">
            <meta property="og:title" content="هدفون بی‌سیم مدل Q30 | دیجی‌استور">
            <meta property="og:description" content="هدفون با نویزگیر فعال">
            <meta property="og:image" content="/img/q30.jpg">
            <meta property="product:brand" content="Anker">`),
      new URL('https://store.fixture.test/p/q30'),
    );
    expect(draft.title).toBe('هدفون بی‌سیم مدل Q30');
    expect(draft.brand).toBe('Anker');
    expect(draft.description).toBe('هدفون با نویزگیر فعال');
    expect(draft.imageUrls).toEqual(['https://store.fixture.test/img/q30.jpg']);
    expect(draft.strategies).toEqual(['OPEN_GRAPH']);
  });

  it('rejects an ordinary article page (og:type=article, no product data)', () => {
    const run = (): unknown =>
      parseProductHtml(
        page(`<title>News</title><meta property="og:type" content="article"><meta property="og:title" content="Story"><meta property="og:image" content="https://news.fixture.test/a.jpg">`),
        new URL('https://news.fixture.test/story'),
      );
    expect(run).toThrow(ImportError);
    expect(run).toThrow(expect.objectContaining({ code: 'NOT_A_PRODUCT' }) as Error);
  });

  it('rejects a page with only a <title>', () => {
    expect(() => parseProductHtml(page('<title>Example Domain</title>'), new URL('https://example.com/'))).toThrow(
      expect.objectContaining({ code: 'NOT_A_PRODUCT' }) as Error,
    );
  });

  it('ignores unsafe image URLs', () => {
    const draft = parseProductHtml(
      page(`<script type="application/ld+json">{"@type":"Product","name":"X","image":["javascript:alert(1)","data:image/png;base64,AAA","ftp://h/a.jpg","https://ok.fixture.test/a.jpg"]}</script>`),
      new URL('https://ok.fixture.test/p'),
    );
    expect(draft.imageUrls).toEqual(['https://ok.fixture.test/a.jpg']);
  });

  it('caps the number of specifications at the product limit', () => {
    const properties = Array.from({ length: 200 }, (_, i) => ({ '@type': 'PropertyValue', name: `ویژگی ${i}`, value: `${i}` }));
    const draft = parseProductHtml(
      page(`<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'X', additionalProperty: properties })}</script>`),
      new URL('https://ok.fixture.test/p'),
    );
    expect(draft.specifications).toHaveLength(150);
  });
});

describe('parseJsonLd', () => {
  it('repairs common real-world defects', () => {
    expect(parseJsonLd('<![CDATA[{"@type":"Product","name":"A"}]]>')).toEqual({ '@type': 'Product', name: 'A' });
    expect(parseJsonLd('<!-- {"name":"B"} -->')).toEqual({ name: 'B' });
    expect(parseJsonLd('{"name":"C\nD",}')).toEqual({ name: 'C D' });
    expect(parseJsonLd('{"list":[1,2,],}')).toEqual({ list: [1, 2] });
  });

  it('returns undefined for hopeless input', () => {
    expect(parseJsonLd('')).toBeUndefined();
    expect(parseJsonLd('{not json')).toBeUndefined();
  });
});

describe('decodeHtml', () => {
  // «سلام» in windows-1256, as still served by some older Iranian shops.
  const salaamCp1256 = Buffer.from([0xd3, 0xe1, 0xc7, 0xe3]);

  it('uses the Content-Type charset', () => {
    expect(decodeHtml(salaamCp1256, 'text/html; charset=windows-1256')).toBe('سلام');
  });

  it('falls back to <meta charset>', () => {
    const body = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1256"></head><body>'), salaamCp1256]);
    expect(decodeHtml(body, 'text/html')).toContain('سلام');
  });

  it('defaults to UTF-8 and survives an unknown charset', () => {
    expect(decodeHtml(Buffer.from('سلام'), null)).toBe('سلام');
    expect(decodeHtml(Buffer.from('سلام'), 'text/html; charset=x-bogus')).toBe('سلام');
  });
});

describe('bestQualityImageUrl', () => {
  it('removes Shopify resize parameters but keeps the version', () => {
    expect(bestQualityImageUrl('https://cdn.shopify.com/s/files/1/a.png?v=12&width=100&height=100&crop=center')).toBe(
      'https://cdn.shopify.com/s/files/1/a.png?v=12',
    );
    expect(bestQualityImageUrl('https://www.allbirds.com/cdn/shop/files/a.png?v=1&width=100')).toBe('https://www.allbirds.com/cdn/shop/files/a.png?v=1');
  });

  it('leaves other hosts untouched', () => {
    expect(bestQualityImageUrl('https://img.fixture.test/a.jpg?width=100')).toBe('https://img.fixture.test/a.jpg?width=100');
  });
});

describe('GenericSchemaOrgExtractor', () => {
  const respond = (partial: Partial<SafeFetchResult>): SafeHttpClient =>
    ({
      fetch: () =>
        Promise.resolve({
          url: new URL('https://shop.fixture.test/product/redmi-note-13/'),
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: Buffer.from(html('woocommerce-product.html')),
          ...partial,
        }),
    }) as unknown as SafeHttpClient;
  const url = new URL('https://shop.fixture.test/product/redmi-note-13/');

  it('parses a fetched page', async () => {
    await expect(new GenericSchemaOrgExtractor(respond({})).extract(url)).resolves.toMatchObject({ title: expect.stringContaining('Redmi') as string });
  });

  it.each([
    [{ status: 404 }, 'NOT_FOUND'],
    [{ status: 410 }, 'NOT_FOUND'],
    [{ status: 403 }, 'UPSTREAM_STATUS'],
    [{ status: 500 }, 'UPSTREAM_STATUS'],
    [{ contentType: 'application/pdf' }, 'UNSUPPORTED_CONTENT'],
    [{ contentType: 'image/jpeg' }, 'UNSUPPORTED_CONTENT'],
  ])('maps %p to %s', async (partial, code) => {
    await expect(new GenericSchemaOrgExtractor(respond(partial)).extract(url)).rejects.toMatchObject({ code });
  });
});
