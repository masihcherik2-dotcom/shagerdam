import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DigikalaExtractor,
  digikalaProductId,
  originalDigikalaImage,
  parseDigikalaProduct,
  type DigikalaApiResponse,
} from './digikala.extractor';
import type { ExtractedProduct } from './extracted-product';
import type { GenericSchemaOrgExtractor } from './generic-schema.extractor';
import { ImportError } from '../import-error';
import type { SafeFetchResult, SafeHttpClient } from '../net/safe-http-client';

const FIXTURES = join(__dirname, '../../../../test/fixtures/importer');
const fixture = (id: string): DigikalaApiResponse =>
  JSON.parse(readFileSync(join(FIXTURES, `digikala-dkp-${id}.json`), 'utf8')) as DigikalaApiResponse;

function product(document: DigikalaApiResponse, id: string): ExtractedProduct {
  const result = parseDigikalaProduct(document, id);
  if (result.kind !== 'product') throw new Error(`expected a product, got ${result.kind}`);
  return result.product;
}

describe('digikalaProductId', () => {
  it.each([
    ['https://www.digikala.com/product/dkp-13196935/', '13196935'],
    ['https://digikala.com/product/dkp-13196935/%D8%A8%D8%B1%DA%86%D8%B3%D8%A8', '13196935'],
    ['https://www.digikala.com/product/dkp-18010600/slug/?variant=1', '18010600'],
    ['https://m.digikala.com/product/dkp-42/', '42'],
  ])('reads %s', (url, id) => {
    expect(digikalaProductId(new URL(url))).toBe(id);
  });

  it.each([
    'https://www.digikala.com/search/category-mobile-phone/',
    'https://www.digikala.com/product/abc/',
    'https://digikala.com.evil.example/product/dkp-1/',
    'https://evil-digikala.com/product/dkp-1/',
    'https://example.com/product/dkp-13196935/',
  ])('ignores %s', (url) => {
    expect(digikalaProductId(new URL(url))).toBeNull();
  });
});

describe('originalDigikalaImage', () => {
  it('drops the resize query to get the original upload', () => {
    expect(
      originalDigikalaImage(
        'https://dkstatics-public.digikala.com/digikala-products/abc_1.jpg?x-oss-process=image/resize,m_lfit,h_800,w_800/quality,q_90',
      ),
    ).toBe('https://dkstatics-public.digikala.com/digikala-products/abc_1.jpg');
  });

  it('refuses non-Digikala or non-https hosts', () => {
    expect(originalDigikalaImage('https://evil.example/digikala-products/abc.jpg')).toBeNull();
    expect(originalDigikalaImage('http://dkstatics-public.digikala.com/a.jpg')).toBeNull();
    expect(originalDigikalaImage('')).toBeNull();
    expect(originalDigikalaImage(null)).toBeNull();
  });
});

describe('parseDigikalaProduct — captured response dkp-13196935 (cover sticker)', () => {
  const draft = product(fixture('13196935'), '13196935');

  it('maps identity, titles and brand', () => {
    expect(draft.source).toBe('DIGIKALA');
    expect(draft.strategies).toEqual(['DIGIKALA_API']);
    expect(draft.sourceProductId).toBe('dkp-13196935');
    expect(draft.sourceUrl).toBe('https://www.digikala.com/product/dkp-13196935/');
    expect(draft.title).toBe('برچسب پوششی ماهوت مدل Iran Tile 11 مناسب برای گوشی موبایل هوآوی Y5 Lite');
    expect(draft.titleEn).toBe('MAHOOT Iran Tile 11 Cover Sticker for Huawei Y5 Lite');
    expect(draft.brand).toBe('ماهوت');
    expect(draft.description).toBe('طرح کاشی 11 از سری طرح های محصولات ماهوت.');
  });

  it('uses the category and the breadcrumb (most specific first, without home and product)', () => {
    expect(draft.suggestedCategory).toBe('کیف و کاور گوشی');
    expect(draft.categoryCandidates).toEqual(['کیف و کاور گوشی', 'لوازم جانبی گوشی موبایل', 'لوازم جانبی کالای دیجیتال', 'کالای دیجیتال']);
  });

  it('extracts every specification, trimmed, with its group', () => {
    expect(draft.specifications).toHaveLength(7);
    expect(draft.specifications.slice(0, 6)).toEqual([
      { group: 'مشخصات', title: 'جنس', value: 'پلی کربنات' },
      { group: 'مشخصات', title: 'وزن', value: '5 گرم' },
      { group: 'مشخصات', title: 'سازگار با گوشی موبایل', value: 'سایر گوشی‌های موبایل' },
      { group: 'مشخصات', title: 'ساختار', value: 'مات' },
      { group: 'مشخصات', title: 'سطح پوشش', value: 'قاب پشتی' },
      { group: 'مشخصات', title: 'ویژگی‌های کیف و کاور', value: 'مقاوم در برابر آب' },
    ]);
  });

  it('keeps multi-line values as lines, normalising CRLF and Arabic letters', () => {
    const other = draft.specifications.find((spec) => spec.title === 'سایر توضیحات');
    const lines = other?.value.split('\n') ?? [];
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('ضخامت 0.2 میلیمتر');
    // The source writes «امكان» with an Arabic kaf (U+0643); it is stored with the Persian «ک».
    expect(lines[5]).toBe('امکان استفاده همزمان با گارد و بامپر');
    expect(other?.value).not.toMatch(/\r|\u0643|\s$/);
  });

  it('collects the gallery at original resolution without duplicates', () => {
    expect(draft.imageUrls).toEqual([
      'https://dkstatics-public.digikala.com/digikala-products/47ed1a2e4cc50360e929b6e8a1ca3f0696d69be8_1698777217.jpg',
      'https://dkstatics-public.digikala.com/digikala-products/c12f7a31bc4120ac140cbc4ea7af7feb153fe23c_1698777218.jpg',
      'https://dkstatics-public.digikala.com/digikala-products/2a77338a8ae4b75f5f1c8c33e697290058d69fb7_1698777219.jpg',
      'https://dkstatics-public.digikala.com/digikala-products/fb5a186a8e1ab7e1f76f9fae3eec7ba17c0541e6_1698777218.jpg',
    ]);
  });
});

describe('parseDigikalaProduct — captured response dkp-18010600 (Galaxy S24 Ultra)', () => {
  const draft = product(fixture('18010600'), '18010600');

  it('maps a phone with a grouped specification table', () => {
    expect(draft.title).toContain('Galaxy S24 Ultra');
    expect(draft.title).not.toContain('  '); // double space in the source title collapsed
    expect(draft.titleEn).toBe('Samsung Galaxy S24 Ultra Dual SIM 256GB And 12GB RAM Mobile Phone - Vietnam');
    expect(draft.brand).toBe('سامسونگ');
    expect(draft.suggestedCategory).toBe('گوشی موبایل');
    expect(new Set(draft.specifications.map((spec) => spec.group))).toEqual(new Set(['دوربین', 'ارتباطات']));
    expect(draft.specifications).toContainEqual({ group: 'دوربین', title: 'رزولوشن دوربین اصلی', value: '200 مگاپیکسل' });
  });

  it('joins several values of one attribute with a Persian comma', () => {
    expect(draft.specifications).toContainEqual({
      group: 'ارتباطات',
      title: 'فناوری مکان‌یابی (GPS)',
      value: 'GPS، GLONASS، GALILEO، BDS(Beidou)',
    });
    expect(draft.specifications).toContainEqual({ group: 'ارتباطات', title: 'شبکه‌های ارتباطی قابل پشتیبانی', value: 'Wi-Fi، بلوتوث' });
  });

  it('decodes HTML entities such as &zwnj; in the review text', () => {
    expect(draft.description).toContain('گوشی‌های پرچمدار');
    expect(draft.description).not.toContain('&zwnj;');
    expect(draft.description?.split('\n')).toHaveLength(2);
  });

  it('returns the full 10-image gallery', () => {
    expect(draft.imageUrls).toHaveLength(10);
    expect(draft.imageUrls.every((url) => url.startsWith('https://dkstatics-public.digikala.com/') && !url.includes('?'))).toBe(true);
  });
});

describe('parseDigikalaProduct — edge cases', () => {
  it('reports a missing product', () => {
    expect(parseDigikalaProduct({ status: 404 }, '1')).toEqual({ kind: 'not-found' });
    expect(parseDigikalaProduct({ status: 200, data: { product: null } }, '1')).toEqual({ kind: 'not-found' });
    expect(parseDigikalaProduct({ status: 200, data: { product: { id: 1, title_fa: '  ', title_en: '' } } }, '1')).toEqual({
      kind: 'not-found',
    });
  });

  it('follows the API redirect to a merged product', () => {
    expect(parseDigikalaProduct({ status: 302, redirect_url: { uri: '/product/dkp-777/' } }, '1')).toEqual({
      kind: 'redirect',
      productId: '777',
    });
  });

  it('drops placeholder brands', () => {
    const base = fixture('13196935');
    const misc = structuredClone(base);
    misc.data!.product!.brand = { title_fa: 'متفرقه', title_en: 'Miscellaneous' };
    expect(product(misc, '13196935').brand).toBeNull();
    const flagged = structuredClone(base);
    flagged.data!.product!.brand = { title_fa: 'برند', is_miscellaneous: true };
    expect(product(flagged, '13196935').brand).toBeNull();
  });

  it('skips attributes without a title or value and de-duplicates repeated ones', () => {
    const doc = structuredClone(fixture('13196935'));
    doc.data!.product!.specifications = [
      {
        title: 'کلی',
        attributes: [
          { title: 'وزن', values: ['5 گرم'] },
          { title: 'وزن', values: ['6 گرم'] },
          { title: '', values: ['x'] },
          { title: 'رنگ', values: ['  ', ''] },
        ],
      },
    ];
    expect(product(doc, '13196935').specifications).toEqual([{ group: 'کلی', title: 'وزن', value: '5 گرم' }]);
  });
});

describe('DigikalaExtractor', () => {
  const json = (body: unknown, status = 200): SafeFetchResult => ({
    url: new URL('https://api.digikala.com/v2/product/1/'),
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(body)),
  });

  interface Harness {
    extractor: DigikalaExtractor;
    calls: string[];
    fallbackCalls: jest.Mock;
  }

  function build(responses: Array<SafeFetchResult | ImportError>, fallback?: ExtractedProduct | ImportError): Harness {
    const calls: string[] = [];
    const http = {
      fetch: jest.fn((url: string | URL) => {
        calls.push(String(url));
        const next = responses.shift();
        if (!next) throw new Error('unexpected request');
        return next instanceof ImportError ? Promise.reject(next) : Promise.resolve(next);
      }),
    } as unknown as SafeHttpClient;
    const fallbackCalls = jest.fn(() =>
      fallback instanceof ImportError || fallback === undefined
        ? Promise.reject(fallback ?? new ImportError('NOT_A_PRODUCT', 'no fallback'))
        : Promise.resolve(fallback),
    );
    const generic = { extract: fallbackCalls } as unknown as GenericSchemaOrgExtractor;
    return { extractor: new DigikalaExtractor(http, generic, 'https://api.digikala.com'), calls, fallbackCalls };
  }

  const url = new URL('https://www.digikala.com/product/dkp-13196935/slug/');

  it('reads the product from the public API endpoint', async () => {
    const { extractor, calls } = build([json(fixture('13196935'))]);
    const result = await extractor.extract(url);
    expect(calls).toEqual(['https://api.digikala.com/v2/product/13196935/']);
    expect(result.title).toContain('Iran Tile 11');
    expect(result.specifications).toHaveLength(7);
  });

  it('follows one product redirect', async () => {
    const { extractor, calls } = build([json({ status: 302, redirect_url: { uri: '/product/dkp-18010600/' } }), json(fixture('18010600'))]);
    const result = await extractor.extract(url);
    expect(calls[1]).toBe('https://api.digikala.com/v2/product/18010600/');
    expect(result.sourceProductId).toBe('dkp-18010600');
  });

  it('reports an unknown product as NOT_FOUND without trying the page', async () => {
    const { extractor, fallbackCalls } = build([json({ status: 404 }, 404)]);
    await expect(extractor.extract(url)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fallbackCalls).not.toHaveBeenCalled();
  });

  it('falls back to the product page when the API is unavailable', async () => {
    const pageDraft: ExtractedProduct = {
      source: 'GENERIC',
      strategies: ['JSON_LD'],
      sourceUrl: url.toString(),
      sourceProductId: null,
      title: 'from page',
      titleEn: null,
      brand: null,
      description: null,
      suggestedCategory: null,
      categoryCandidates: [],
      specifications: [],
      imageUrls: [],
    };
    const { extractor } = build([new ImportError('TIMEOUT', 'slow')], pageDraft);
    await expect(extractor.extract(url)).resolves.toMatchObject({ title: 'from page', source: 'DIGIKALA', sourceProductId: 'dkp-13196935' });
  });

  it('surfaces the API error when the fallback also fails', async () => {
    const { extractor } = build([json({}, 503)], new ImportError('NOT_A_PRODUCT', 'client-rendered page'));
    await expect(extractor.extract(url)).rejects.toMatchObject({ code: 'UPSTREAM_STATUS' });
  });

  it('rejects a non-JSON API answer as unsupported content (then tries the page)', async () => {
    const { extractor, fallbackCalls } = build([{ ...json({}), body: Buffer.from('<html>captcha</html>') }]);
    await expect(extractor.extract(url)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    expect(fallbackCalls).toHaveBeenCalledTimes(1);
  });

  it('rejects URLs that are not Digikala product pages', async () => {
    const { extractor } = build([]);
    await expect(extractor.extract(new URL('https://www.digikala.com/search/'))).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
});
