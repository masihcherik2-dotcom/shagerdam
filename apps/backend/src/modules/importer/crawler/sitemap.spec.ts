import {
  canonicalProductUrl,
  isNonProductSitemap,
  isProductSitemap,
  isProductUrl,
  normalizeStoreUrl,
  orderChildSitemaps,
  parseSitemap,
  sameSite,
  selectProductUrls,
  sitemapsFromRobots,
  urlsFromText,
} from './sitemap';

describe('parseSitemap', () => {
  it('reads a Yoast sitemap index', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?xml-stylesheet type="text/xsl" href="//shop.ir/main-sitemap.xsl"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>https://shop.ir/post-sitemap.xml</loc><lastmod>2026-09-01T10:00:00+00:00</lastmod></sitemap>
  <sitemap><loc>https://shop.ir/product-sitemap.xml</loc></sitemap>
  <sitemap><loc>https://shop.ir/product-sitemap2.xml</loc></sitemap>
</sitemapindex>`;
    expect(parseSitemap(xml)).toEqual({
      kind: 'index',
      locations: ['https://shop.ir/post-sitemap.xml', 'https://shop.ir/product-sitemap.xml', 'https://shop.ir/product-sitemap2.xml'],
    });
  });

  it('reads a urlset with image extensions, CDATA, entities and namespace prefixes', () => {
    const xml = `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
<url><loc>https://shop.ir/product/a/</loc><image:image><image:loc>https://shop.ir/a.jpg</image:loc></image:image></url>
<url><loc><![CDATA[https://shop.ir/product/b/?x=1&y=2]]></loc></url>
<url><loc>https://shop.ir/product/c/?x=1&amp;y=2</loc></url>
<ns:url><ns:loc> https://shop.ir/product/d/ </ns:loc></ns:url>
</urlset>`;
    const parsed = parseSitemap(xml);
    expect(parsed.kind).toBe('urlset');
    // image:loc entries are namespaced <loc> too; product selection drops them later (not product paths).
    expect(parsed.locations).toEqual([
      'https://shop.ir/product/a/',
      'https://shop.ir/a.jpg',
      'https://shop.ir/product/b/?x=1&y=2',
      'https://shop.ir/product/c/?x=1&y=2',
      'https://shop.ir/product/d/',
    ]);
  });

  it('reports documents that are not sitemaps', () => {
    expect(parseSitemap('<!doctype html><html><body>404</body></html>').kind).toBe('unknown');
  });
});

describe('robots and text input', () => {
  it('collects Sitemap lines of robots.txt', () => {
    const robots = 'User-agent: *\nDisallow: /wp-admin/\nSitemap: https://shop.ir/sitemap_index.xml\r\nsitemap:https://shop.ir/extra.xml\n# Sitemap: https://ignored';
    expect(sitemapsFromRobots(robots)).toEqual(['https://shop.ir/sitemap_index.xml', 'https://shop.ir/extra.xml']);
  });

  it('extracts links from a pasted list', () => {
    const text = 'https://shop.ir/product/a/\nhttps://shop.ir/محصول/ب/ , https://shop.ir/product/c/) و (https://shop.ir/product/d/);\nنه-لینک';
    expect(urlsFromText(text)).toEqual(['https://shop.ir/product/a/', 'https://shop.ir/محصول/ب/', 'https://shop.ir/product/c/', 'https://shop.ir/product/d/']);
  });
});

describe('product recognition', () => {
  it.each([
    ['https://shop.ir/product/redmi-note-13/', true],
    ['https://shop.myshopify.com/products/blue-shirt', true],
    ['https://www.digikala.com/product/dkp-13196935/', true],
    ['https://shop.ir/product/%DA%AF%D9%88%D8%B4%DB%8C/', true],
    ['https://shop.ir/product-category/mobile/', false],
    ['https://shop.ir/blog/how-to-buy/', false],
    ['https://shop.ir/product/', false],
  ])('%s → %s', (url, expected) => {
    expect(isProductUrl(url)).toBe(expected);
  });

  it('classifies child sitemaps', () => {
    expect(isProductSitemap('https://shop.ir/product-sitemap.xml')).toBe(true);
    expect(isProductSitemap('https://shop.ir/sitemap_products_1.xml?from=1&to=99')).toBe(true);
    expect(isProductSitemap('https://shop.ir/wp-sitemap-posts-product-1.xml')).toBe(true);
    expect(isProductSitemap('https://shop.ir/product_cat-sitemap.xml')).toBe(false);
    expect(isNonProductSitemap('https://shop.ir/post-sitemap.xml')).toBe(true);
    expect(isNonProductSitemap('https://shop.ir/page-sitemap.xml')).toBe(true);
    expect(isNonProductSitemap('https://shop.ir/product_cat-sitemap.xml')).toBe(true);
    expect(isNonProductSitemap('https://shop.ir/sitemap-1.xml')).toBe(false);
  });

  it('orders an index: product sitemaps only when present, else everything but known non-product ones', () => {
    expect(
      orderChildSitemaps([
        'https://shop.ir/post-sitemap.xml',
        'https://shop.ir/product_cat-sitemap.xml',
        'https://shop.ir/product-sitemap.xml',
        'https://shop.ir/page-sitemap.xml',
      ]),
    ).toEqual(['https://shop.ir/product-sitemap.xml']);
    expect(orderChildSitemaps(['https://shop.ir/post-sitemap.xml', 'https://shop.ir/sitemap-1.xml', 'https://shop.ir/sitemap-2.xml'])).toEqual([
      'https://shop.ir/sitemap-1.xml',
      'https://shop.ir/sitemap-2.xml',
    ]);
  });
});

describe('selectProductUrls', () => {
  const locations = [
    'https://shop.ir/',
    'https://shop.ir/shop/',
    'https://shop.ir/product/a/',
    'https://www.shop.ir/product/b/#reviews',
    'https://shop.ir/product/a/?utm_source=x',
    'https://other.ir/product/c/',
    'https://shop.ir/گوشی-سامسونگ/',
  ];

  it('keeps product paths of the same site, de-duplicated, without home/shop pages', () => {
    expect(selectProductUrls(locations, { trustAll: false, host: 'shop.ir' })).toEqual(['https://shop.ir/product/a/', 'https://www.shop.ir/product/b/']);
  });

  it('trusts every page of a product sitemap', () => {
    expect(selectProductUrls(locations, { trustAll: true, host: 'www.shop.ir' })).toEqual([
      'https://shop.ir/product/a/',
      'https://www.shop.ir/product/b/',
      `https://shop.ir/${encodeURI('گوشی-سامسونگ')}/`,
    ]);
  });

  it('has no host filter without a store address', () => {
    expect(selectProductUrls(locations, { trustAll: false })).toContain('https://other.ir/product/c/');
  });
});

describe('helpers', () => {
  it('normalises store addresses', () => {
    expect(normalizeStoreUrl(' zarrinmetal.ir ')).toBe('https://zarrinmetal.ir');
    expect(normalizeStoreUrl('http://shop.ir/sitemap.xml')).toBe('http://shop.ir/sitemap.xml');
  });

  it('compares sites ignoring www', () => {
    expect(sameSite('www.Shop.ir', 'shop.ir')).toBe(true);
    expect(sameSite('cdn.shop.ir', 'shop.ir')).toBe(false);
  });

  it('canonicalises product URLs', () => {
    expect(canonicalProductUrl('https://SHOP.ir/product/a/?utm_medium=x&color=red#tab')).toBe('https://shop.ir/product/a/?color=red');
    expect(canonicalProductUrl('ftp://shop.ir/a')).toBeNull();
  });
});
