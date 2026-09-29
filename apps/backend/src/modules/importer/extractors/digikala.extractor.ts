import { Inject, Injectable, Logger } from '@nestjs/common';
import { ImportError } from '../import-error';
import { SafeHttpClient } from '../net/safe-http-client';
import {
  finalizeProduct,
  htmlToText,
  type ExtractedProduct,
  type ExtractedSpecification,
} from './extracted-product';
import { GenericSchemaOrgExtractor } from './generic-schema.extractor';

/**
 * Origin of Digikala's public product API. A provider token (not configuration)
 * so only the automated test suite can point it at a local fixture server.
 */
export const DIGIKALA_API_ORIGIN = Symbol('DIGIKALA_API_ORIGIN');
export const DIGIKALA_PUBLIC_API_ORIGIN = 'https://api.digikala.com';

const DIGIKALA_HOSTS = new Set(['digikala.com', 'www.digikala.com', 'm.digikala.com']);
const PRODUCT_PATH = /\/product\/dkp-(\d{1,12})(?:[/?#]|$)/i;
/** Digikala's CDN; gallery URLs outside it are ignored. */
const IMAGE_HOST_SUFFIX = '.digikala.com';
/** The API JSON of a product is ~50–400 KB; 4 MB leaves ample headroom. */
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Brands Digikala uses for "no brand" — not a brand a vendor should inherit. */
const PLACEHOLDER_BRANDS = new Set(['متفرقه', 'miscellaneous', 'نامشخص', 'غیره']);

/** `dkp-…` id of a Digikala product URL, or `null` when the URL is not one. */
export function digikalaProductId(url: URL): string | null {
  if (!DIGIKALA_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''))) {
    return null;
  }
  const match = PRODUCT_PATH.exec(url.pathname);
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------------------
// Response shape (only the fields we read; everything is optional because the
// API is not a contract we control)
// ---------------------------------------------------------------------------

interface DkImage {
  url?: Array<string | null> | null;
}

interface DkProduct {
  id?: number;
  title_fa?: string | null;
  title_en?: string | null;
  is_inactive?: boolean;
  brand?: { title_fa?: string | null; title_en?: string | null; is_miscellaneous?: boolean } | null;
  category?: { title_fa?: string | null } | null;
  breadcrumb?: Array<{ title?: string | null; url?: { uri?: string | null } | null }> | null;
  images?: { main?: DkImage | null; list?: DkImage[] | null } | null;
  review?: { description?: string | null } | null;
  expert_reviews?: { description?: string | null; short_review?: string | null } | null;
  specifications?: Array<{
    title?: string | null;
    attributes?: Array<{ title?: string | null; values?: Array<string | null> | null }> | null;
  }> | null;
}

export interface DigikalaApiResponse {
  status?: number;
  data?: { product?: DkProduct | null } | null;
  redirect_url?: { uri?: string | null } | null;
}

/** Outcome of reading one API document: a product, a redirect to another id, or nothing. */
export type DigikalaParseResult =
  | { kind: 'product'; product: ExtractedProduct }
  | { kind: 'redirect'; productId: string }
  | { kind: 'not-found' };

/**
 * Original-resolution URL of a CDN image. Digikala serves resized variants
 * through an `x-oss-process` query; dropping the query yields the original
 * upload, which our own pipeline then resizes to 1600 px and a 300 px thumbnail.
 */
export function originalDigikalaImage(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname.endsWith(IMAGE_HOST_SUFFIX)) {
      return null;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Pure mapping of a Digikala `v2/product/{id}` document to a product draft.
 * Kept free of I/O so it is unit-tested against captured API responses.
 */
export function parseDigikalaProduct(document: DigikalaApiResponse, productId: string): DigikalaParseResult {
  if (document.status === 302) {
    const target = document.redirect_url?.uri ? PRODUCT_PATH.exec(document.redirect_url.uri) : null;
    return target ? { kind: 'redirect', productId: target[1]! } : { kind: 'not-found' };
  }
  const product = document.data?.product;
  if (document.status !== 200 || !product) {
    return { kind: 'not-found' };
  }
  const titleFa = product.title_fa?.trim() ?? '';
  const titleEn = product.title_en?.trim() ?? '';
  if (titleFa.length === 0 && titleEn.length === 0) {
    return { kind: 'not-found' };
  }

  const specifications: ExtractedSpecification[] = [];
  for (const group of product.specifications ?? []) {
    for (const attribute of group.attributes ?? []) {
      const values = (attribute.values ?? []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!attribute.title || values.length === 0) continue;
      // Several values of one attribute ("5G", "4G", "3G") are one comma list;
      // a single multi-line value keeps its own line breaks.
      specifications.push({ group: group.title ?? null, title: attribute.title, value: values.map((value) => value.trim()).join('، ') });
    }
  }

  const imageUrls = [product.images?.main, ...(product.images?.list ?? [])]
    .map((image) => originalDigikalaImage(image?.url?.[0]))
    .filter((url): url is string => url !== null);

  const brandTitle = product.brand?.title_fa?.trim() || product.brand?.title_en?.trim() || '';
  const brand =
    product.brand?.is_miscellaneous === true || PLACEHOLDER_BRANDS.has(brandTitle.toLowerCase()) ? null : brandTitle || null;

  const descriptionHtml =
    product.expert_reviews?.description?.trim() || product.review?.description?.trim() || product.expert_reviews?.short_review?.trim() || '';

  // Breadcrumb: [Digikala home, …categories…, the product itself] → categories, most specific first.
  const crumbs = (product.breadcrumb ?? [])
    .filter((crumb) => crumb.url?.uri && !crumb.url.uri.startsWith('/product/') && crumb.url.uri !== '/')
    .map((crumb) => crumb.title ?? '')
    .reverse();
  const category = product.category?.title_fa?.trim() || null;

  return {
    kind: 'product',
    product: finalizeProduct({
      source: 'DIGIKALA',
      strategies: ['DIGIKALA_API'],
      sourceUrl: `https://www.digikala.com/product/dkp-${product.id ?? productId}/`,
      sourceProductId: `dkp-${product.id ?? productId}`,
      title: titleFa || titleEn,
      titleEn: titleEn || null,
      brand,
      description: descriptionHtml ? htmlToText(descriptionHtml) : null,
      suggestedCategory: category,
      categoryCandidates: [...(category ? [category] : []), ...crumbs],
      specifications,
      imageUrls,
    }),
  };
}

/**
 * Strategy A — Digikala.
 *
 * Reads the product through Digikala's public JSON API (`/v2/product/{id}/`),
 * which carries the full specification table and gallery that the
 * client-rendered HTML page does not. If the API is unreachable or answers with
 * an error, the product *page* is tried with the generic Schema.org/OpenGraph
 * parser before giving up.
 */
@Injectable()
export class DigikalaExtractor {
  private readonly logger = new Logger(DigikalaExtractor.name);

  constructor(
    private readonly http: SafeHttpClient,
    private readonly generic: GenericSchemaOrgExtractor,
    @Inject(DIGIKALA_API_ORIGIN) private readonly apiOrigin: string,
  ) {}

  matches(url: URL): boolean {
    return digikalaProductId(url) !== null;
  }

  async extract(url: URL): Promise<ExtractedProduct> {
    let productId = digikalaProductId(url);
    if (productId === null) {
      throw new ImportError('INVALID_URL', 'Not a Digikala product URL (expected …/product/dkp-<number>/…)');
    }

    try {
      // One redirect (a merged/renumbered product) is followed; more means a loop.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = parseDigikalaProduct(await this.fetchApi(productId), productId);
        if (result.kind === 'product') return result.product;
        if (result.kind === 'not-found') {
          throw new ImportError('NOT_FOUND', `Digikala has no active product dkp-${productId}`);
        }
        productId = result.productId;
      }
      throw new ImportError('NOT_FOUND', 'Digikala redirected this product more than once');
    } catch (error) {
      if (!(error instanceof ImportError) || error.code === 'NOT_FOUND' || error.code === 'BLOCKED_TARGET') {
        throw error;
      }
      this.logger.warn(`Digikala API failed for dkp-${productId} (${error.code}: ${error.message}); trying the product page`);
      try {
        const fallback = await this.generic.extract(url);
        return { ...fallback, source: 'DIGIKALA', sourceProductId: `dkp-${productId}` };
      } catch (fallbackError) {
        this.logger.warn(`Digikala page fallback failed: ${String(fallbackError)}`);
        throw error;
      }
    }
  }

  private async fetchApi(productId: string): Promise<DigikalaApiResponse> {
    const response = await this.http.fetch(`${this.apiOrigin}/v2/product/${productId}/`, {
      accept: 'application/json',
      maxBytes: MAX_API_RESPONSE_BYTES,
      headers: { referer: 'https://www.digikala.com/', origin: 'https://www.digikala.com' },
    });
    // The API answers unknown ids with an HTTP error *or* a JSON `status`; both are handled.
    if (response.status === 404) {
      return { status: 404 };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ImportError('UPSTREAM_STATUS', `Digikala answered HTTP ${response.status}`);
    }
    try {
      return JSON.parse(response.body.toString('utf8')) as DigikalaApiResponse;
    } catch {
      throw new ImportError('UNSUPPORTED_CONTENT', 'Digikala returned a response that is not JSON');
    }
  }
}
