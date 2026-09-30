import { gzipSync } from 'node:zlib';
import { ImportError } from '../import-error';
import { PUBLIC_INTERNET_POLICY } from '../net/address-policy';
import { parseImportUrl } from '../net/import-url';
import type { SafeFetchOptions, SafeFetchResult, SafeHttpClient } from '../net/safe-http-client';
import { MAX_SITEMAP_FETCHES, StoreCrawlerService } from './store-crawler.service';

type Route = { status?: number; body: string | Buffer; type?: string; redirectTo?: string } | Error;

/** A fake of SafeHttpClient: real URL validation, canned responses, call log. */
function fakeHttp(routes: Record<string, Route>): { http: SafeHttpClient; calls: string[] } {
  const calls: string[] = [];
  const http = {
    validate: (raw: string): URL => parseImportUrl(raw, PUBLIC_INTERNET_POLICY),
    fetch: (raw: string | URL, _options: SafeFetchOptions): Promise<SafeFetchResult> => {
      const url = raw.toString();
      calls.push(url);
      const route = routes[url];
      if (route instanceof Error) return Promise.reject(route);
      if (route === undefined) return Promise.resolve({ url: new URL(url), status: 404, contentType: 'text/html', body: Buffer.alloc(0) });
      const finalUrl = new URL(route.redirectTo ?? url);
      return Promise.resolve({
        url: finalUrl,
        status: route.status ?? 200,
        contentType: route.type ?? 'application/xml; charset=UTF-8',
        body: Buffer.isBuffer(route.body) ? route.body : Buffer.from(route.body, 'utf8'),
      });
    },
  } as unknown as SafeHttpClient;
  return { http, calls };
}

const index = (...locs: string[]): string =>
  `<?xml version="1.0"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<sitemap><loc>${loc}</loc></sitemap>`).join('')}</sitemapindex>`;
const urlset = (...locs: string[]): string =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locs.map((loc) => `<url><loc>${loc}</loc></url>`).join('')}</urlset>`;

describe('StoreCrawlerService', () => {
  it('follows robots.txt → index → product sitemap, skipping post/category sitemaps', async () => {
    const { http, calls } = fakeHttp({
      'https://shop.ir/robots.txt': { body: 'User-agent: *\nSitemap: https://shop.ir/sitemap_index.xml', type: 'text/plain' },
      'https://shop.ir/sitemap_index.xml': {
        body: index('https://shop.ir/post-sitemap.xml', 'https://shop.ir/product-sitemap.xml', 'https://shop.ir/product_cat-sitemap.xml'),
      },
      'https://shop.ir/product-sitemap.xml': {
        body: urlset('https://shop.ir/shop/', 'https://shop.ir/product/a/', 'https://shop.ir/قابلمه-استیل/', 'https://shop.ir/product/a/#x'),
      },
    });
    const result = await new StoreCrawlerService(http).discover({ storeUrl: 'shop.ir' });
    expect(result).toEqual({
      storeUrl: 'https://shop.ir/',
      totalFound: 2,
      productUrls: ['https://shop.ir/product/a/', `https://shop.ir/${encodeURI('قابلمه-استیل')}/`],
      sitemapsScanned: ['https://shop.ir/sitemap_index.xml', 'https://shop.ir/product-sitemap.xml'],
      warnings: [],
    });
    expect(calls).not.toContain('https://shop.ir/post-sitemap.xml');
    expect(calls).not.toContain('https://shop.ir/product_cat-sitemap.xml');
  });

  it('falls back to well-known paths, reads gzip sitemaps and filters a general urlset by product path', async () => {
    const { http } = fakeHttp({
      'https://shop.ir/sitemap.xml': { body: index('https://shop.ir/sitemap-1.xml.gz') },
      'https://shop.ir/sitemap-1.xml.gz': {
        body: gzipSync(urlset('https://shop.ir/about/', 'https://shop.ir/products/x', 'https://shop.ir/product/y/', 'https://cdn.other.ir/product/z/')),
        type: 'application/x-gzip',
      },
    });
    const result = await new StoreCrawlerService(http).discover({ storeUrl: 'https://shop.ir' });
    expect(result.productUrls).toEqual(['https://shop.ir/products/x', 'https://shop.ir/product/y/']);
    expect(result.sitemapsScanned).toEqual(['https://shop.ir/sitemap.xml', 'https://shop.ir/sitemap-1.xml.gz']);
  });

  it('does not read the same sitemap twice when /sitemap.xml redirects to the index', async () => {
    const { http, calls } = fakeHttp({
      'https://shop.ir/sitemap_index.xml': { body: index('https://shop.ir/product-sitemap.xml') },
      'https://shop.ir/sitemap.xml': { body: index('https://shop.ir/product-sitemap.xml'), redirectTo: 'https://shop.ir/sitemap_index.xml' },
      'https://shop.ir/product-sitemap.xml': { body: urlset('https://shop.ir/product/a/') },
    });
    const result = await new StoreCrawlerService(http).discover({ storeUrl: 'https://shop.ir/' });
    expect(result.productUrls).toEqual(['https://shop.ir/product/a/']);
    expect(calls.filter((url) => url === 'https://shop.ir/product-sitemap.xml')).toHaveLength(1);
  });

  it('caps the result at maxProducts but reports the total found', async () => {
    const products = Array.from({ length: 30 }, (_, i) => `https://shop.ir/product/p-${i}/`);
    const { http } = fakeHttp({ 'https://shop.ir/product-sitemap.xml': { body: urlset(...products) } });
    const result = await new StoreCrawlerService(http).discover({ storeUrl: 'https://shop.ir/product-sitemap.xml', maxProducts: 10 });
    expect(result.totalFound).toBe(30);
    expect(result.productUrls).toEqual(products.slice(0, 10));
  });

  it('stops after the document budget', async () => {
    const routes: Record<string, Route> = {};
    const children = Array.from({ length: 40 }, (_, i) => `https://shop.ir/sitemap-${i}.xml`);
    routes['https://shop.ir/sitemap_index.xml'] = { body: index(...children) };
    for (const child of children) routes[child] = { body: urlset('https://shop.ir/about/') };
    const { http, calls } = fakeHttp(routes);
    await expect(new StoreCrawlerService(http).discover({ storeUrl: 'https://shop.ir' })).rejects.toMatchObject({ code: 'NO_PRODUCTS_FOUND' });
    expect(calls.length).toBeLessThanOrEqual(MAX_SITEMAP_FETCHES);
  });

  it('explains that nothing could be read (the Geo-IP case) and suggests pasting', async () => {
    const { http } = fakeHttp({ 'https://shop.ir/robots.txt': new ImportError('TIMEOUT', 'slow') });
    const error = await new StoreCrawlerService(http).discover({ storeUrl: 'https://shop.ir' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportError);
    expect((error as ImportError).code).toBe('NO_PRODUCTS_FOUND');
    expect((error as ImportError).message).toContain('paste');
  });

  it('refuses internal targets before any request', async () => {
    const { http, calls } = fakeHttp({});
    await expect(new StoreCrawlerService(http).discover({ storeUrl: 'http://127.0.0.1/' })).rejects.toMatchObject({ code: 'BLOCKED_TARGET' });
    await expect(new StoreCrawlerService(http).discover({ storeUrl: 'http://redis/' })).rejects.toMatchObject({ code: 'BLOCKED_TARGET' });
    expect(calls).toEqual([]);
  });

  describe('pasted content (no request to the store)', () => {
    it('reads a pasted product urlset whose URLs have no product path', async () => {
      const { http, calls } = fakeHttp({});
      const result = await new StoreCrawlerService(http).discover({
        storeUrl: 'https://shop.ir',
        sitemapContent: urlset('https://shop.ir/قابلمه/', 'https://shop.ir/ماهیتابه/', 'https://other.ir/x/'),
      });
      expect(result.productUrls).toEqual([`https://shop.ir/${encodeURI('قابلمه')}/`, `https://shop.ir/${encodeURI('ماهیتابه')}/`]);
      expect(result.sitemapsScanned).toEqual(['(pasted)']);
      expect(calls).toEqual([]);
    });

    it('accepts a plain list of links without a store address', async () => {
      const { http } = fakeHttp({});
      const result = await new StoreCrawlerService(http).discover({ sitemapContent: 'https://a.ir/x/\nhttps://a.ir/y/\nhttps://a.ir/x/' });
      expect(result).toMatchObject({ storeUrl: '', totalFound: 2, productUrls: ['https://a.ir/x/', 'https://a.ir/y/'] });
    });

    it('fetches the children of a pasted sitemap index', async () => {
      const { http } = fakeHttp({ 'https://shop.ir/product-sitemap.xml': { body: urlset('https://shop.ir/product/a/') } });
      const result = await new StoreCrawlerService(http).discover({ sitemapContent: index('https://shop.ir/product-sitemap.xml') });
      expect(result.productUrls).toEqual(['https://shop.ir/product/a/']);
    });

    it('rejects a request with neither address nor content', async () => {
      const { http } = fakeHttp({});
      await expect(new StoreCrawlerService(http).discover({ sitemapContent: '   ' })).rejects.toMatchObject({ code: 'INVALID_URL' });
    });
  });
});
