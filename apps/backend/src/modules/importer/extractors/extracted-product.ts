import {
  MAX_SPECIFICATIONS_PER_PRODUCT,
  SPECIFICATION_GROUP_MAX_LENGTH,
  SPECIFICATION_TITLE_MAX_LENGTH,
  SPECIFICATION_VALUE_MAX_LENGTH,
} from '../../products/product-rules';
import { normalizePersianParagraphs, normalizePersianText } from '../../products/catalog-text';
import type { ExtractedOffer } from './offer';

export type ImportSource = 'DIGIKALA' | 'GENERIC';

/** Which parser produced (part of) the draft; reported so a vendor can judge its reliability. */
export type ExtractionStrategy =
  | 'DIGIKALA_API'
  | 'JSON_LD'
  | 'MICRODATA'
  | 'OPEN_GRAPH'
  | 'HTML_META'
  | 'WOOCOMMERCE_ATTRIBUTES';

export interface ExtractedSpecification {
  group: string | null;
  title: string;
  value: string;
}

/**
 * Draft product data taken from a remote page. It is only a *suggestion*: the
 * vendor reviews it in the form, and nothing is persisted until they save the
 * product through the normal (validated) product endpoint.
 */
export interface ExtractedProduct {
  source: ImportSource;
  strategies: ExtractionStrategy[];
  /** Canonical URL of the product page. */
  sourceUrl: string;
  /** The source's own product id when it has one (e.g. `dkp-13196935`). */
  sourceProductId: string | null;
  title: string;
  titleEn: string | null;
  brand: string | null;
  description: string | null;
  /** Most specific category name the source uses. */
  suggestedCategory: string | null;
  /** Category names from most to least specific, used to match the local tree. */
  categoryCandidates: string[];
  specifications: ExtractedSpecification[];
  /** Absolute http(s) image URLs, best quality available, primary first. */
  imageUrls: string[];
  /** Price/availability as published by the page, or null when it shows none. */
  offer: ExtractedOffer | null;
}

// Limits mirror the product DTO so a draft can always be saved as-is.
export const MAX_TITLE_LENGTH = 200;
export const MAX_BRAND_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 20_000;
export const MAX_EXTRACTED_IMAGES = 24;

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  zwnj: '\u200c',
  zwj: '\u200d',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Decodes the HTML entities that occur in real product text (named subset + numeric). */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

/**
 * Turns an HTML fragment into plain paragraphs: block tags become line breaks,
 * every other tag is dropped, entities are decoded. Nothing of the markup
 * survives, so the result is safe to store and render as text.
 */
export function htmlToText(value: string): string {
  const withBreaks = value
    .replace(/<\s*(script|style|noscript|template)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*(p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return normalizePersianParagraphs(decodeEntities(withBreaks).replace(/\u00a0/g, ' '));
}

/** Single-line clean text (titles, brands, spec labels). */
export function cleanLine(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  return normalizePersianText(decodeEntities(String(value)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

/** Multi-line value (spec values keep their line structure). */
export function cleanMultiline(value: string): string {
  return decodeEntities(value)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => normalizePersianText(line))
    .filter((line) => line.length > 0)
    .join('\n');
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Resolves a (possibly relative / protocol-relative) image reference to an absolute http(s) URL. */
export function absoluteHttpUrl(reference: unknown, base: URL | string): string | null {
  if (typeof reference !== 'string') {
    return null;
  }
  const text = decodeEntities(reference.trim());
  if (text.length === 0 || text.startsWith('data:') || text.length > 2048) {
    return null;
  }
  try {
    const url = new URL(text, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Best-quality form of a known CDN image URL. Shopify (`cdn.shopify.com`,
 * `/cdn/shop/…`) serves resized copies through `width`/`height`/`crop` query
 * parameters, and structured data often references a 100–300 px copy; without
 * them the CDN returns the original upload. Other hosts are left untouched,
 * because their query strings may be part of the file's identity.
 */
export function bestQualityImageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const isShopify = url.hostname === 'cdn.shopify.com' || url.pathname.includes('/cdn/shop/');
    if (isShopify) {
      for (const key of ['width', 'height', 'crop', 'pad_color']) url.searchParams.delete(key);
      return url.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Order-preserving de-duplication. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * Final shaping shared by every strategy: clean text, DTO-compatible lengths,
 * de-duplicated specifications (first occurrence of a group/title wins) and
 * images, and a bounded number of each.
 */
export function finalizeProduct(draft: ExtractedProduct): ExtractedProduct {
  const seenSpecs = new Set<string>();
  const specifications: ExtractedSpecification[] = [];
  for (const spec of draft.specifications) {
    const title = truncate(cleanLine(spec.title), SPECIFICATION_TITLE_MAX_LENGTH);
    const value = truncate(cleanMultiline(spec.value), SPECIFICATION_VALUE_MAX_LENGTH);
    const group = spec.group ? truncate(cleanLine(spec.group), SPECIFICATION_GROUP_MAX_LENGTH) : '';
    if (title.length === 0 || value.length === 0) continue;
    const key = `${group}\u0000${title}`.toLocaleLowerCase('fa');
    if (seenSpecs.has(key)) continue;
    seenSpecs.add(key);
    specifications.push({ group: group.length > 0 ? group : null, title, value });
    if (specifications.length >= MAX_SPECIFICATIONS_PER_PRODUCT) break;
  }

  const brand = draft.brand ? truncate(cleanLine(draft.brand), MAX_BRAND_LENGTH) : '';
  const description = draft.description ? truncate(draft.description, MAX_DESCRIPTION_LENGTH) : '';
  const titleEn = draft.titleEn ? truncate(cleanLine(draft.titleEn), MAX_TITLE_LENGTH) : '';
  const suggestedCategory = draft.suggestedCategory ? cleanLine(draft.suggestedCategory) : '';

  return {
    ...draft,
    title: truncate(cleanLine(draft.title), MAX_TITLE_LENGTH),
    titleEn: titleEn.length > 0 ? titleEn : null,
    brand: brand.length > 0 ? brand : null,
    description: description.length > 0 ? description : null,
    suggestedCategory: suggestedCategory.length > 0 ? suggestedCategory : null,
    categoryCandidates: unique(draft.categoryCandidates.map((name) => cleanLine(name)).filter((name) => name.length > 0)),
    specifications,
    imageUrls: unique(draft.imageUrls.map((url) => bestQualityImageUrl(url))).slice(0, MAX_EXTRACTED_IMAGES),
    strategies: unique(draft.strategies),
  };
}
