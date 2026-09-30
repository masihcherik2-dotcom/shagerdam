import { Injectable } from '@nestjs/common';
import { parse, type HTMLElement } from 'node-html-parser';
import { ImportError } from '../import-error';
import { SafeHttpClient } from '../net/safe-http-client';
import {
  absoluteHttpUrl,
  cleanLine,
  finalizeProduct,
  htmlToText,
  unique,
  type ExtractedProduct,
  type ExtractedSpecification,
  type ExtractionStrategy,
} from './extracted-product';

/** Product pages rarely exceed 1–2 MB of HTML; anything above 5 MB is not worth parsing. */
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const PRODUCT_TYPES = new Set(['product', 'productgroup', 'productmodel', 'individualproduct', 'someproducts', 'vehicle', 'car']);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface PartialDraft {
  strategy?: ExtractionStrategy;
  title?: string;
  description?: string;
  brand?: string;
  category?: string;
  images: string[];
  specifications: ExtractedSpecification[];
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decodes an HTML body using the charset from the `Content-Type` header, else
 * from `<meta charset>` / `http-equiv`, else UTF-8. Older Iranian shops still
 * serve `windows-1256`, which Node's ICU-enabled `TextDecoder` understands.
 */
export function decodeHtml(body: Buffer, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const head = body.subarray(0, 4096).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typesOf(node: JsonObject): string[] {
  const raw = node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/^.*[/#:]/, '').toLowerCase());
}

/** Every object node of a JSON-LD document (arrays, `@graph`, nested values). */
function* walk(value: JsonValue | undefined, depth = 0): Generator<JsonObject> {
  if (depth > 12 || value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) yield* walk(entry, depth + 1);
    return;
  }
  if (isObject(value)) {
    yield value;
    for (const [key, entry] of Object.entries(value)) {
      if (key !== '@context') yield* walk(entry, depth + 1);
    }
  }
}

/** Parses a JSON-LD script tolerantly (CDATA wrappers, HTML comments, raw control characters, trailing commas). */
export function parseJsonLd(text: string): JsonValue | undefined {
  const cleaned = text
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .trim();
  if (cleaned.length === 0) return undefined;
  // eslint-disable-next-line no-control-regex -- raw control characters inside JSON strings are exactly what is being repaired
  const repaired = cleaned.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  for (const candidate of [cleaned, repaired]) {
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

function textValue(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = textValue(entry);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  if (isObject(value)) {
    return textValue(value['name']) ?? textValue(value['@value']);
  }
  return undefined;
}

function imageValues(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => imageValues(entry));
  if (isObject(value)) {
    const direct = [value['contentUrl'], value['url']].find((entry) => typeof entry === 'string');
    return typeof direct === 'string' ? [direct] : [];
  }
  return [];
}

function quantitativeValue(value: JsonValue | undefined): string | undefined {
  if (isObject(value)) {
    const amount = textValue(value['value']);
    const unit = textValue(value['unitText']) ?? textValue(value['unitCode']);
    return amount === undefined ? undefined : unit ? `${amount} ${unit}` : amount;
  }
  return textValue(value);
}

/** Labels for schema.org properties that are genuine specifications. */
const SCHEMA_SPEC_FIELDS: ReadonlyArray<[string, string]> = [
  ['model', 'مدل'],
  ['color', 'رنگ'],
  ['material', 'جنس'],
  ['size', 'اندازه'],
  ['weight', 'وزن'],
  ['width', 'عرض'],
  ['height', 'ارتفاع'],
  ['depth', 'عمق'],
  ['mpn', 'شماره قطعه سازنده (MPN)'],
  ['gtin13', 'بارکد (GTIN-13)'],
  ['gtin', 'بارکد (GTIN)'],
];

function fromJsonLdProduct(node: JsonObject, base: URL): PartialDraft {
  const images = imageValues(node['image']);
  // Shopify: a ProductGroup lists per-variant images under hasVariant.
  const variants = node['hasVariant'];
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (isObject(variant)) images.push(...imageValues(variant['image']));
    }
  }

  const specifications: ExtractedSpecification[] = [];
  const properties = node['additionalProperty'];
  for (const property of Array.isArray(properties) ? properties : properties ? [properties] : []) {
    if (!isObject(property)) continue;
    const title = textValue(property['name']);
    const raw = property['value'];
    const value = Array.isArray(raw) ? raw.map((entry) => textValue(entry)).filter(Boolean).join('، ') : textValue(raw);
    const unit = textValue(property['unitText']);
    if (title && value) specifications.push({ group: null, title, value: unit ? `${value} ${unit}` : value });
  }
  for (const [field, label] of SCHEMA_SPEC_FIELDS) {
    const value = quantitativeValue(node[field]);
    if (value !== undefined && !/^https?:\/\//i.test(value)) specifications.push({ group: null, title: label, value });
  }

  const category = textValue(node['category']);
  return {
    title: textValue(node['name']),
    description: textValue(node['description']),
    brand: textValue(node['brand']) ?? textValue(node['manufacturer']),
    category: category?.split(/\s*[>/|›»]\s*/).filter(Boolean).pop(),
    images: images.map((image) => absoluteHttpUrl(image, base)).filter((url): url is string => url !== null),
    specifications,
  };
}

/** Category names from a BreadcrumbList, most specific first (the product itself excluded). */
function breadcrumbCategories(nodes: JsonObject[], productName: string | undefined): string[] {
  for (const node of nodes) {
    if (!typesOf(node).includes('breadcrumblist')) continue;
    const items = Array.isArray(node['itemListElement']) ? node['itemListElement'] : [];
    const names = items
      .filter(isObject)
      .sort((a, b) => Number(a['position'] ?? 0) - Number(b['position'] ?? 0))
      .map((item) => textValue(item['name']) ?? (isObject(item['item']) ? textValue(item['item']['name']) : undefined))
      .filter((name): name is string => name !== undefined);
    const categories = names.slice(1).filter((name) => cleanLine(name) !== cleanLine(productName ?? ''));
    if (categories.length > 0) return categories.reverse();
  }
  return [];
}

// ---------------------------------------------------------------------------
// Microdata
// ---------------------------------------------------------------------------

function itemPropValue(element: HTMLElement): string | undefined {
  const tag = element.tagName?.toLowerCase();
  const value =
    element.getAttribute('content') ??
    (tag === 'img' || tag === 'source' ? element.getAttribute('src') ?? element.getAttribute('data-src') : undefined) ??
    (tag === 'a' || tag === 'link' ? element.getAttribute('href') : undefined) ??
    (tag === 'meta' ? undefined : element.innerHTML);
  const text = value === undefined ? '' : tag === 'meta' || tag === 'img' || tag === 'link' || tag === 'a' ? value : htmlToText(value);
  return text.trim().length > 0 ? text.trim() : undefined;
}

function fromMicrodata(root: HTMLElement, base: URL): PartialDraft | null {
  const scope = root
    .querySelectorAll('[itemscope][itemtype]')
    .find((element) => /schema\.org\/(Product|ProductGroup|IndividualProduct)\b/i.test(element.getAttribute('itemtype') ?? ''));
  if (!scope) return null;

  const first = (prop: string): HTMLElement | undefined => scope.querySelector(`[itemprop="${prop}"]`) ?? undefined;
  const brandElement = first('brand');
  const brand = brandElement
    ? brandElement.hasAttribute('itemscope')
      ? (brandElement.querySelector('[itemprop="name"]') ? itemPropValue(brandElement.querySelector('[itemprop="name"]')!) : undefined)
      : itemPropValue(brandElement)
    : undefined;

  const specifications: ExtractedSpecification[] = [];
  for (const property of scope.querySelectorAll('[itemprop="additionalProperty"]')) {
    const name = property.querySelector('[itemprop="name"]');
    const value = property.querySelector('[itemprop="value"]');
    const title = name ? itemPropValue(name) : undefined;
    const text = value ? itemPropValue(value) : undefined;
    if (title && text) specifications.push({ group: null, title, value: text });
  }

  // The product's own name: the first `name` that is not inside a nested item (brand, offer, review…).
  const name = scope
    .querySelectorAll('[itemprop="name"]')
    .find((element) => {
      let parent = element.parentNode;
      while (parent && parent !== scope) {
        if (parent.hasAttribute?.('itemscope')) return false;
        parent = parent.parentNode;
      }
      return true;
    });
  const descriptionElement = first('description');

  return {
    title: name ? itemPropValue(name) : undefined,
    description: descriptionElement ? itemPropValue(descriptionElement) : undefined,
    brand,
    category: first('category') ? itemPropValue(first('category')!) : undefined,
    images: scope
      .querySelectorAll('[itemprop="image"]')
      .map((element) => absoluteHttpUrl(itemPropValue(element), base))
      .filter((url): url is string => url !== null),
    specifications,
  };
}

// ---------------------------------------------------------------------------
// OpenGraph / HTML meta
// ---------------------------------------------------------------------------

interface MetaData {
  ogTitle?: string;
  ogDescription?: string;
  ogType?: string;
  ogSiteName?: string;
  ogImages: string[];
  productBrand?: string;
  hasPrice: boolean;
  metaDescription?: string;
  documentTitle?: string;
  canonical?: string;
}

function readMeta(root: HTMLElement, base: URL): MetaData {
  const meta: MetaData = { ogImages: [], hasPrice: false };
  for (const element of root.querySelectorAll('meta')) {
    const key = (element.getAttribute('property') ?? element.getAttribute('name') ?? '').trim().toLowerCase();
    const content = element.getAttribute('content')?.trim();
    if (!key || !content) continue;
    switch (key) {
      case 'og:title':
        meta.ogTitle ??= content;
        break;
      case 'twitter:title':
        meta.ogTitle ??= content;
        break;
      case 'og:description':
      case 'twitter:description':
        meta.ogDescription ??= content;
        break;
      case 'og:type':
        meta.ogType = content.toLowerCase();
        break;
      case 'og:site_name':
        meta.ogSiteName = content;
        break;
      case 'og:image':
      case 'og:image:url':
      case 'og:image:secure_url':
      case 'twitter:image':
      case 'twitter:image:src': {
        const url = absoluteHttpUrl(content, base);
        if (url) meta.ogImages.push(url);
        break;
      }
      case 'product:brand':
      case 'og:brand':
        meta.productBrand ??= content;
        break;
      case 'product:price:amount':
      case 'og:price:amount':
        meta.hasPrice = true;
        break;
      case 'description':
        meta.metaDescription ??= content;
        break;
      default:
        break;
    }
  }
  meta.documentTitle = root.querySelector('title')?.text.trim() || undefined;
  meta.canonical = absoluteHttpUrl(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), base) ?? undefined;
  return meta;
}

/** "Product name | Shop" → "Product name" when the suffix is the site's name. */
function stripSiteSuffix(title: string, siteName: string | undefined): string {
  if (!siteName) return title;
  const parts = title.split(/\s+[|\-–—:]\s+/);
  if (parts.length > 1 && cleanLine(parts[parts.length - 1]!) === cleanLine(siteName)) {
    return parts.slice(0, -1).join(' - ');
  }
  return title;
}

// ---------------------------------------------------------------------------
// WooCommerce (very common among Iranian shops)
// ---------------------------------------------------------------------------

function fromWooCommerce(root: HTMLElement, base: URL): { specifications: ExtractedSpecification[]; images: string[] } {
  const specifications: ExtractedSpecification[] = [];
  for (const row of root.querySelectorAll('table.woocommerce-product-attributes tr, table.shop_attributes tr')) {
    const label = row.querySelector('th');
    const value = row.querySelector('td');
    if (label && value) {
      // Term lists are rendered as `<a>4G</a>, <a>3G</a>`; drop the space the tags leave before the comma.
      specifications.push({ group: null, title: label.text, value: htmlToText(value.innerHTML).replace(/[ \t]+([,،])/g, '$1') });
    }
  }
  const images: string[] = [];
  for (const element of root.querySelectorAll('.woocommerce-product-gallery__image')) {
    const link = element.querySelector('a')?.getAttribute('href');
    const image = element.querySelector('img');
    const candidate = image?.getAttribute('data-large_image') ?? link ?? image?.getAttribute('data-src') ?? image?.getAttribute('src');
    const url = absoluteHttpUrl(candidate, base);
    if (url) images.push(url);
  }
  return { specifications, images };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Pure HTML → draft mapping (no I/O), unit-tested against real-world page
 * shapes. Sources are merged by reliability: JSON-LD, then microdata, then the
 * WooCommerce attribute table, then OpenGraph and plain HTML metadata.
 *
 * Throws `NOT_A_PRODUCT` for pages that carry no product signal at all — a
 * blog post's OpenGraph title is not a product.
 */
export function parseProductHtml(html: string, pageUrl: URL): ExtractedProduct {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: false, noscript: false, pre: true } });

  const jsonLdNodes: JsonObject[] = [];
  for (const script of root.querySelectorAll('script')) {
    if (!/application\/ld\+json/i.test(script.getAttribute('type') ?? '')) continue;
    jsonLdNodes.push(...walk(parseJsonLd(script.rawText)));
  }
  const productNodes = jsonLdNodes.filter((node) => typesOf(node).some((type) => PRODUCT_TYPES.has(type)));
  // Prefer a top-level product with a name; a ProductGroup over its own variants.
  const productNode =
    productNodes.find((node) => typesOf(node).includes('productgroup') && textValue(node['name'])) ??
    productNodes.find((node) => textValue(node['name']));

  const parts: PartialDraft[] = [];
  if (productNode) {
    parts.push({ ...fromJsonLdProduct(productNode, pageUrl), strategy: 'JSON_LD' });
  }

  const microdata = fromMicrodata(root, pageUrl);
  if (microdata && (microdata.title || microdata.images.length > 0 || microdata.specifications.length > 0)) {
    parts.push({ ...microdata, strategy: 'MICRODATA' });
  }

  const woo = fromWooCommerce(root, pageUrl);
  if (woo.specifications.length > 0 || woo.images.length > 0) {
    parts.push({ images: woo.images, specifications: woo.specifications, strategy: 'WOOCOMMERCE_ATTRIBUTES' });
  }

  const meta = readMeta(root, pageUrl);
  const ogIsProduct = meta.ogType?.includes('product') === true || meta.hasPrice || meta.productBrand !== undefined;
  if (meta.ogTitle || meta.ogImages.length > 0) {
    parts.push({
      title: meta.ogTitle ? stripSiteSuffix(meta.ogTitle, meta.ogSiteName) : undefined,
      description: meta.ogDescription,
      brand: meta.productBrand,
      images: meta.ogImages,
      specifications: [],
      strategy: 'OPEN_GRAPH',
    });
  }
  if (meta.documentTitle || meta.metaDescription) {
    parts.push({
      title: meta.documentTitle ? stripSiteSuffix(meta.documentTitle, meta.ogSiteName) : undefined,
      description: meta.metaDescription,
      images: [],
      specifications: [],
      strategy: 'HTML_META',
    });
  }

  const hasProductSignal = productNode !== undefined || microdata !== null || woo.specifications.length > 0 || ogIsProduct;
  const pick = (field: 'title' | 'description' | 'brand' | 'category'): PartialDraft | undefined =>
    parts.find((part) => {
      const value = part[field];
      return value !== undefined && cleanLine(value).length > 0;
    });
  const titlePart = pick('title');
  const title = titlePart?.title;
  if (!hasProductSignal || !title) {
    throw new ImportError(
      'NOT_A_PRODUCT',
      'No product information was found on this page (no schema.org Product, product microdata, WooCommerce attributes or OpenGraph product tags)',
    );
  }

  const descriptionPart = pick('description');
  const brandPart = pick('brand');
  const categoryPart = pick('category');
  const description = descriptionPart?.description;
  const category = categoryPart?.category;
  const breadcrumbs = breadcrumbCategories(jsonLdNodes, title);

  // Report only the strategies whose data actually ended up in the draft.
  const contributing = new Set<PartialDraft>([titlePart, ...[descriptionPart, brandPart, categoryPart].filter((part): part is PartialDraft => part !== undefined)]);
  for (const part of parts) {
    if (part.images.length > 0 || part.specifications.length > 0) contributing.add(part);
  }
  const strategies = parts.filter((part) => contributing.has(part)).map((part) => part.strategy!);

  return finalizeProduct({
    source: 'GENERIC',
    strategies,
    sourceUrl: meta.canonical ?? pageUrl.toString(),
    sourceProductId: productNode
      ? (textValue(productNode['sku']) ?? textValue(productNode['productID']) ?? textValue(productNode['productGroupID']) ?? null)
      : null,
    title,
    titleEn: null,
    brand: brandPart?.brand ?? null,
    description: description ? htmlToText(description) : null,
    suggestedCategory: category ?? breadcrumbs[0] ?? null,
    categoryCandidates: unique([...(category ? [category] : []), ...breadcrumbs]),
    specifications: parts.flatMap((part) => part.specifications),
    imageUrls: unique(parts.flatMap((part) => part.images)),
  });
}

/**
 * Strategy B — any storefront that publishes structured data (WooCommerce,
 * Shopify, Magento, custom shops with schema.org/OpenGraph tags).
 */
@Injectable()
export class GenericSchemaOrgExtractor {
  constructor(private readonly http: SafeHttpClient) {}

  async extract(url: URL): Promise<ExtractedProduct> {
    const response = await this.http.fetch(url, {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      maxBytes: MAX_HTML_BYTES,
    });
    if (response.status === 404 || response.status === 410) {
      throw new ImportError('NOT_FOUND', `The page does not exist (HTTP ${response.status})`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ImportError('UPSTREAM_STATUS', `The site answered HTTP ${response.status}`);
    }
    const type = (response.contentType ?? '').toLowerCase();
    if (type !== '' && !type.includes('html') && !type.includes('xml')) {
      throw new ImportError('UNSUPPORTED_CONTENT', `The URL is not a web page (content type ${type.split(';')[0]})`);
    }
    return parseProductHtml(decodeHtml(response.body, response.contentType), response.url);
  }
}
