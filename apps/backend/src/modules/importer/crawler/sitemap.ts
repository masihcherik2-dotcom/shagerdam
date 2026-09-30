import { decodeEntities } from '../extractors/extracted-product';

/**
 * Pure helpers of the store crawler: sitemap parsing and product-URL
 * recognition. No I/O here — everything is unit-tested against the shapes
 * produced by WooCommerce/Yoast/Rank Math, WordPress core, Shopify and
 * hand-written sitemaps.
 */

/** Hard ceiling on URLs discovered per crawl (TM: "50 to 200 product links"). */
export const MAX_CRAWL_PRODUCTS = 200;
export const DEFAULT_CRAWL_PRODUCTS = 200;

/** Well-known sitemap locations, tried after the `Sitemap:` lines of robots.txt. */
export const SITEMAP_PATHS = ['/sitemap_index.xml', '/sitemap.xml', '/product-sitemap.xml', '/wp-sitemap.xml'] as const;

export type SitemapKind = 'index' | 'urlset' | 'unknown';

export interface ParsedSitemap {
  kind: SitemapKind;
  /** `<loc>` values in document order: child sitemaps for an index, pages for a urlset. */
  locations: string[];
}

/**
 * Reads a sitemap document. Tolerates namespaces/prefixes (`<ns:loc>`),
 * CDATA sections and entity-encoded URLs; the XML is scanned, not built into a
 * tree, so a 10 MB sitemap costs one string, not a DOM.
 */
export function parseSitemap(xml: string): ParsedSitemap {
  const head = xml.slice(0, 4096).toLowerCase();
  const kind: SitemapKind = /<(?:\w+:)?sitemapindex[\s>]/.test(head)
    ? 'index'
    : /<(?:\w+:)?urlset[\s>]/.test(head)
      ? 'urlset'
      : /<(?:\w+:)?sitemapindex[\s>]/i.test(xml)
        ? 'index'
        : /<(?:\w+:)?urlset[\s>]/i.test(xml)
          ? 'urlset'
          : 'unknown';
  const locations: string[] = [];
  const pattern = /<(?:\w+:)?loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/(?:\w+:)?loc>/gi;
  for (let match = pattern.exec(xml); match !== null; match = pattern.exec(xml)) {
    const value = decodeEntities(match[1]!.trim());
    if (value.length > 0) locations.push(value);
  }
  return { kind, locations };
}

/** `Sitemap:` declarations of a robots.txt file. */
export function sitemapsFromRobots(robots: string): string[] {
  const found: string[] = [];
  for (const line of robots.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (match) found.push(match[1]!);
  }
  return found;
}

/**
 * Every absolute http(s) URL in free text — the "paste a list of links" input.
 * Accepts one URL per line, comma/space separated lists, or text copied from a
 * browser; Persian characters in paths are kept (they are percent-encoded by URL parsing).
 */
export function urlsFromText(text: string): string[] {
  const found: string[] = [];
  const pattern = /https?:\/\/[^\s<>"'`,،]+/gi;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push(match[0].replace(/[).;\]]+$/, ''));
  }
  return found;
}

/** Path fragments that identify a product page on common platforms (TM list + Shopify/Magento forms). */
const PRODUCT_PATH = /\/(?:product|products|shop\/product)\/[^/]+|\/dkp-\d+|\/p\/\d+/i;
/** Sitemap-file names that list only products (Yoast/Rank Math, WP core, Shopify, custom). */
const PRODUCT_SITEMAP = /product/i;
/** Child sitemaps that never list products; skipped whenever the index has a product sitemap. */
const NON_PRODUCT_SITEMAP = /(?:^|[/_-])(?:post|page|category|categories|tag|tags|author|users?|attachment|blog|news|article|brand|collection|taxonom|product[_-]?cat|product[_-]?tag|video|image|local|geo|pages)(?:[_-]?sitemap|\d|[._-]|$)/i;

export function isProductUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return PRODUCT_PATH.test(decodeURI(url.pathname));
  } catch {
    return false;
  }
}

/** A child sitemap that lists products, e.g. `product-sitemap.xml`, `sitemap_products_1.xml`, `wp-sitemap-posts-product-1.xml`. */
export function isProductSitemap(value: string): boolean {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return PRODUCT_SITEMAP.test(path) && !/product[_-]?(?:cat|tag|brand)/.test(path);
  } catch {
    return false;
  }
}

export function isNonProductSitemap(value: string): boolean {
  try {
    const path = new URL(value).pathname.toLowerCase();
    return !isProductSitemap(value) && NON_PRODUCT_SITEMAP.test(path.split('/').pop() ?? '');
  } catch {
    return true;
  }
}

/** Child sitemaps in crawl order: product sitemaps first; non-product ones dropped when a product sitemap exists. */
export function orderChildSitemaps(children: string[]): string[] {
  const products = children.filter((child) => isProductSitemap(child));
  if (products.length > 0) return products;
  return children.filter((child) => !isNonProductSitemap(child));
}

/** `www.shop.ir` and `shop.ir` are the same store. */
export function sameSite(a: string, b: string): boolean {
  const strip = (host: string): string => host.toLowerCase().replace(/^www\./, '');
  return strip(a) === strip(b);
}

/** Canonical form for de-duplication: no fragment, no tracking parameters, lower-case host. */
export function canonicalProductUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|srsltid)/i.test(key)) url.searchParams.delete(key);
    }
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Picks the product pages of a list of page URLs.
 *
 * `trustAll` is set when the list comes from a product-only sitemap (or is a
 * pasted plain list of links): every URL is a product, whatever its shape —
 * many Iranian shops use Persian slugs at the site root. Otherwise only URLs
 * with a product path qualify; if none does, the list is returned as-is when it
 * came from a product sitemap, else empty.
 */
export function selectProductUrls(locations: string[], options: { trustAll: boolean; host?: string }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const location of locations) {
    const canonical = canonicalProductUrl(location);
    if (canonical === null || seen.has(canonical)) continue;
    const url = new URL(canonical);
    if (options.host !== undefined && !sameSite(url.hostname, options.host)) continue;
    // The shop/home page itself is listed in most product sitemaps.
    if (url.pathname === '/' || /^\/(?:shop|store|products?)\/?$/i.test(url.pathname)) continue;
    if (!options.trustAll && !isProductUrl(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

/**
 * Normalises what the user typed as the store address: a bare domain
 * (`zarrinmetal.ir`) becomes `https://zarrinmetal.ir/`.
 */
export function normalizeStoreUrl(raw: string): string {
  const text = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`;
}
