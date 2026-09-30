import { Injectable, Logger } from '@nestjs/common';
import { gunzipSync } from 'node:zlib';
import { decodeHtml } from '../extractors/generic-schema.extractor';
import { ImportError } from '../import-error';
import { SafeHttpClient } from '../net/safe-http-client';
import {
  DEFAULT_CRAWL_PRODUCTS,
  MAX_CRAWL_PRODUCTS,
  isProductSitemap,
  SITEMAP_PATHS,
  normalizeStoreUrl,
  orderChildSitemaps,
  parseSitemap,
  selectProductUrls,
  sitemapsFromRobots,
  urlsFromText,
} from './sitemap';

/** Sitemaps may be up to 50 MB by the protocol; real shop sitemaps are far below 10 MB. */
export const MAX_SITEMAP_BYTES = 10 * 1024 * 1024;
/** Documents fetched per crawl (robots.txt + sitemaps). */
export const MAX_SITEMAP_FETCHES = 25;
/** Whole-crawl budget: stays inside the reverse proxy's read timeout (60 s). */
export const CRAWL_DEADLINE_MS = 40_000;

const XML_ACCEPT = 'application/xml,text/xml;q=0.9,application/x-gzip;q=0.8,*/*;q=0.5';

export interface CrawlStoreInput {
  /** Store address (`https://shop.ir`, `shop.ir`) or a sitemap URL. Optional when `sitemapContent` is given. */
  storeUrl?: string;
  /** Pasted sitemap XML or a plain list of product links (Geo-IP fallback). */
  sitemapContent?: string;
  maxProducts?: number;
}

export interface CrawlStoreResult {
  storeUrl: string;
  /** Product URLs found in the scanned sitemaps (may exceed `productUrls.length`). */
  totalFound: number;
  /** First `maxProducts` product URLs, in sitemap order. */
  productUrls: string[];
  /** Sitemaps that were read successfully, in crawl order. */
  sitemapsScanned: string[];
  /** Non-fatal problems (unreachable sitemaps, truncated scans), for the UI. */
  warnings: string[];
}

interface QueueEntry {
  url: string;
  /** Well-known guesses fail silently; declared sitemaps (robots/index) produce a warning. */
  declared: boolean;
}

/**
 * Discovers the product pages of a store from its sitemaps.
 *
 * Order: `Sitemap:` lines of robots.txt, then the well-known locations
 * (`/sitemap_index.xml`, `/sitemap.xml`, `/product-sitemap.xml`,
 * `/wp-sitemap.xml`). Sitemap indexes are expanded depth-first with product
 * sitemaps first (post/page/category sitemaps are skipped when a product
 * sitemap exists). Only pages of the store's own site are returned.
 *
 * Every request goes through {@link SafeHttpClient} (SSRF guard, 10 s per
 * document, size cap) and the whole crawl is bounded in documents and time.
 *
 * When the store blocks the server (foreign-IP filters, WAF), the user pastes
 * the sitemap XML or a list of links instead; that text is parsed without any
 * request (child sitemaps of a pasted index are still fetched, best effort).
 */
@Injectable()
export class StoreCrawlerService {
  private readonly logger = new Logger(StoreCrawlerService.name);

  constructor(private readonly http: SafeHttpClient) {}

  async discover(input: CrawlStoreInput): Promise<CrawlStoreResult> {
    const maxProducts = Math.min(Math.max(1, Math.floor(input.maxProducts ?? DEFAULT_CRAWL_PRODUCTS)), MAX_CRAWL_PRODUCTS);
    const deadline = Date.now() + CRAWL_DEADLINE_MS;
    const store = input.storeUrl ? this.http.validate(normalizeStoreUrl(input.storeUrl)) : null;
    const host = store?.hostname;

    const found: string[] = [];
    const seenProducts = new Set<string>();
    const scanned: string[] = [];
    const warnings: string[] = [];
    const visited = new Set<string>();
    const queue: QueueEntry[] = [];
    let fetches = 0;

    const addProducts = (urls: string[]): void => {
      for (const url of urls) {
        if (!seenProducts.has(url)) {
          seenProducts.add(url);
          found.push(url);
        }
      }
    };

    /** Reads a sitemap document already in memory; returns false when it is not a sitemap. */
    const consume = (xml: string, sourceUrl: string | null): boolean => {
      const sitemap = parseSitemap(xml);
      if (sitemap.kind === 'unknown') return false;
      if (sitemap.kind === 'index') {
        const children = orderChildSitemaps(sitemap.locations).filter((child) => !visited.has(child));
        queue.unshift(...children.map((url) => ({ url, declared: true })));
        return true;
      }
      const trustAll = sourceUrl === null ? false : isProductSitemap(sourceUrl);
      let selected = selectProductUrls(sitemap.locations, { trustAll, host });
      // A pasted urlset carries no file name: if no URL has a product path, it was the product sitemap itself.
      if (selected.length === 0 && sourceUrl === null) {
        selected = selectProductUrls(sitemap.locations, { trustAll: true, host });
      }
      addProducts(selected);
      return true;
    };

    // ── Pasted content ────────────────────────────────────────────────────
    if (input.sitemapContent !== undefined && input.sitemapContent.trim().length > 0) {
      const text = input.sitemapContent;
      if (/<(?:\w+:)?loc>/i.test(text)) {
        if (!consume(text, null)) {
          addProducts(selectProductUrls(urlsFromText(text), { trustAll: true, host }));
        }
      } else {
        addProducts(selectProductUrls(urlsFromText(text), { trustAll: true, host }));
      }
      scanned.push('(pasted)');
    } else if (store !== null) {
      // ── Live crawl ──────────────────────────────────────────────────────
      if (/\.xml(?:\.gz)?$/i.test(store.pathname)) {
        queue.push({ url: store.toString(), declared: true });
      } else {
        const robots = await this.fetchText(new URL('/robots.txt', store), deadline).catch(() => null);
        fetches += 1;
        for (const url of sitemapsFromRobots(robots ?? '')) queue.push({ url, declared: true });
        for (const path of SITEMAP_PATHS) queue.push({ url: new URL(path, store).toString(), declared: false });
      }
    } else {
      throw new ImportError('INVALID_URL', 'Send the store address or paste the sitemap / product links');
    }

    // ── Sitemap traversal (live crawl, and children of a pasted index) ────
    let stopReason: string | null = null;
    while (queue.length > 0 && found.length < maxProducts) {
      if (fetches >= MAX_SITEMAP_FETCHES) {
        stopReason = `Stopped after ${MAX_SITEMAP_FETCHES} sitemap files`;
        break;
      }
      if (Date.now() >= deadline) {
        stopReason = `Stopped after ${CRAWL_DEADLINE_MS / 1000} seconds`;
        break;
      }
      const entry = queue.shift()!;
      if (visited.has(entry.url)) continue;
      visited.add(entry.url);
      fetches += 1;
      try {
        const { text, finalUrl } = await this.fetchSitemap(entry.url, deadline);
        if (visited.has(finalUrl) && finalUrl !== entry.url) continue; // /sitemap.xml → /sitemap_index.xml already read
        visited.add(finalUrl);
        if (consume(text, finalUrl)) {
          scanned.push(finalUrl);
        } else if (entry.declared) {
          warnings.push(`Not a sitemap: ${entry.url}`);
        }
      } catch (error) {
        if (error instanceof ImportError && error.code === 'BLOCKED_TARGET') throw error;
        if (entry.declared) {
          warnings.push(`Could not read ${entry.url}: ${error instanceof Error ? error.message : 'unknown error'}`);
        }
      }
    }
    if (stopReason !== null) warnings.push(stopReason);

    if (found.length === 0) {
      const reason =
        scanned.length === 0
          ? 'No sitemap could be read from this site. If the site blocks our server, paste its sitemap XML or a list of product links instead.'
          : 'The sitemaps were read, but none of their pages looks like a product page. Paste the product sitemap or a list of product links instead.';
      throw new ImportError('NO_PRODUCTS_FOUND', reason);
    }

    this.logger.log(`Crawled ${host ?? 'pasted content'}: ${found.length} product URLs from ${scanned.length} sitemap(s), ${fetches} request(s)`);
    return {
      storeUrl: store?.toString() ?? '',
      totalFound: found.length,
      productUrls: found.slice(0, maxProducts),
      sitemapsScanned: scanned,
      warnings,
    };
  }

  private async fetchText(url: URL, deadline: number): Promise<string | null> {
    const response = await this.http.fetch(url, { accept: 'text/plain,*/*;q=0.5', maxBytes: 512 * 1024, timeoutMs: remaining(deadline) });
    return response.status >= 200 && response.status < 300 ? decodeHtml(response.body, response.contentType) : null;
  }

  private async fetchSitemap(url: string, deadline: number): Promise<{ text: string; finalUrl: string }> {
    const response = await this.http.fetch(url, { accept: XML_ACCEPT, maxBytes: MAX_SITEMAP_BYTES, timeoutMs: remaining(deadline) });
    if (response.status < 200 || response.status >= 300) {
      throw new ImportError(response.status === 404 ? 'NOT_FOUND' : 'UPSTREAM_STATUS', `HTTP ${response.status}`);
    }
    let body = response.body;
    // `.xml.gz` files arrive compressed as the payload itself (not as Content-Encoding).
    if (body.length > 2 && body[0] === 0x1f && body[1] === 0x8b) {
      try {
        body = gunzipSync(body, { maxOutputLength: MAX_SITEMAP_BYTES });
      } catch {
        throw new ImportError('TOO_LARGE', 'The compressed sitemap is invalid or larger than 10 MB');
      }
    }
    return { text: decodeHtml(body, response.contentType), finalUrl: response.url.toString() };
  }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}
