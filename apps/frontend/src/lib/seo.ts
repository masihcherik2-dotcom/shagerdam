/**
 * Pure SEO helpers: Schema.org JSON-LD for product pages, sitemap entries and
 * safe serialisation. Unit-tested in `seo.test.ts`.
 */
import type { CategoryDetail, CategoryTreeNode, ProductDetail } from './api/types';

type JsonLd = Record<string, unknown>;

/** Money strings from the API ("8900000.00") → a plain decimal without trailing zeros. */
export function schemaPrice(value: string): string {
  const trimmed = value.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return '0';
  return trimmed.includes('.') ? trimmed.replace(/\.?0+$/, '') : trimmed;
}

/** Absolute URL for a path or an already absolute media URL. */
export function absoluteUrl(origin: string, pathOrUrl: string): string {
  if (/^https?:\/\//i.test(pathOrUrl)) return pathOrUrl;
  return `${origin}${pathOrUrl.startsWith('/') ? '' : '/'}${pathOrUrl}`;
}

/**
 * Meta description (≤ 160 chars): the product text when present, otherwise a
 * factual line from title, brand and store — never invented copy.
 */
export function productMetaDescription(product: Pick<ProductDetail, 'title' | 'description' | 'brand' | 'vendor'>): string {
  const text = product.description?.replace(/\s+/g, ' ').trim();
  if (text) return text.length > 160 ? `${text.slice(0, 157).trimEnd()}…` : text;
  const brand = product.brand ? ` ${product.brand}` : '';
  return `خرید${brand} ${product.title} از فروشگاه ${product.vendor.storeName}`.replace(/\s+/g, ' ').trim().slice(0, 160);
}

/**
 * `Product` with its `Offer` (one sellable variant) or `AggregateOffer`
 * (several). Prices are in Rial (`IRR`), exactly as charged at checkout.
 * Only facts from the API are emitted — no invented rating or review.
 */
export function productJsonLd(product: ProductDetail, origin: string): JsonLd {
  const url = `${origin}/products/${encodeURIComponent(product.slug)}`;
  const images = product.media.map((image) => absoluteUrl(origin, image.url));
  const variants = product.variants;
  const seller = { '@type': 'Organization', name: product.vendor.storeName };
  const availability = product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock';

  let offers: JsonLd | undefined;
  if (variants.length === 1) {
    const variant = variants[0]!;
    offers = {
      '@type': 'Offer',
      url,
      sku: variant.sku,
      price: schemaPrice(variant.price),
      priceCurrency: 'IRR',
      availability: variant.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
      itemCondition: 'https://schema.org/NewCondition',
      seller,
    };
  } else if (variants.length > 1) {
    offers = {
      '@type': 'AggregateOffer',
      url,
      lowPrice: schemaPrice(product.priceRange.min),
      highPrice: schemaPrice(product.priceRange.max),
      offerCount: variants.length,
      priceCurrency: 'IRR',
      availability,
      seller,
    };
  }

  const description = product.description?.replace(/\s+/g, ' ').trim();
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: product.title,
    url,
    ...(images.length > 0 ? { image: images } : {}),
    ...(description ? { description: description.slice(0, 5000) } : {}),
    ...(variants[0] ? { sku: variants[0].sku } : {}),
    ...(product.brand ? { brand: { '@type': 'Brand', name: product.brand } } : {}),
    ...(product.breadcrumbs.length > 0 ? { category: product.breadcrumbs.map((crumb) => crumb.titleFa).join(' > ') } : {}),
    ...(offers ? { offers } : {}),
  };
}

/** Home → categories → product. */
export function productBreadcrumbJsonLd(product: ProductDetail, origin: string, homeName: string): JsonLd {
  const items = [
    { name: homeName, item: `${origin}/` },
    ...product.breadcrumbs.map((crumb) => ({ name: crumb.titleFa, item: `${origin}/categories/${encodeURIComponent(crumb.slug)}` })),
    { name: product.title, item: `${origin}/products/${encodeURIComponent(product.slug)}` },
  ];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((entry, index) => ({ '@type': 'ListItem', position: index + 1, name: entry.name, item: entry.item })),
  };
}

/** Home → ancestors → category (category pages). */
export function categoryBreadcrumbJsonLd(category: Pick<CategoryDetail, 'breadcrumbs'>, origin: string, homeName: string): JsonLd {
  const items = [
    { name: homeName, item: `${origin}/` },
    ...category.breadcrumbs.map((crumb) => ({ name: crumb.titleFa, item: `${origin}/categories/${encodeURIComponent(crumb.slug)}` })),
  ];
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((entry, index) => ({ '@type': 'ListItem', position: index + 1, name: entry.name, item: entry.item })),
  };
}

/**
 * Organization (home page). Only facts the platform actually has: name, URL,
 * the admin-managed logo and the contact details from /admin/site-info —
 * absent values are omitted, never invented.
 */
export function organizationJsonLd(params: {
  origin: string;
  name: string;
  legalName?: string | null;
  logoUrl?: string | null;
  supportPhone?: string | null;
  supportEmail?: string | null;
}): JsonLd {
  const contact =
    params.supportPhone || params.supportEmail
      ? {
          contactPoint: [
            {
              '@type': 'ContactPoint',
              contactType: 'customer support',
              areaServed: 'IR',
              availableLanguage: ['fa'],
              ...(params.supportPhone ? { telephone: params.supportPhone } : {}),
              ...(params.supportEmail ? { email: params.supportEmail } : {}),
            },
          ],
        }
      : {};
  return {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    '@id': `${params.origin}/#organization`,
    name: params.name,
    url: `${params.origin}/`,
    ...(params.legalName ? { legalName: params.legalName } : {}),
    ...(params.logoUrl ? { logo: absoluteUrl(params.origin, params.logoUrl) } : {}),
    ...contact,
  };
}

/** WebSite with a SearchAction pointing at the real search page (`/search?q=`). */
export function websiteJsonLd(origin: string, name: string): JsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    '@id': `${origin}/#website`,
    name,
    url: `${origin}/`,
    inLanguage: 'fa-IR',
    publisher: { '@id': `${origin}/#organization` },
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${origin}/search?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
}

/**
 * JSON for a `<script type="application/ld+json">`: `<`, `>` and `&` are
 * escaped so a product title such as `</script><script>…` can never close the
 * element (data from vendors is untrusted).
 */
export function serializeJsonLd(data: JsonLd | JsonLd[]): string {
  return JSON.stringify(data).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

/** Depth-first list of every category slug in the tree. */
export function flattenCategorySlugs(nodes: readonly CategoryTreeNode[]): string[] {
  const slugs: string[] = [];
  const walk = (list: readonly CategoryTreeNode[]): void => {
    for (const node of list) {
      slugs.push(node.slug);
      walk(node.children);
    }
  };
  walk(nodes);
  return slugs;
}

/** Public, indexable pages that exist without data. */
export const STATIC_SITEMAP_PATHS: ReadonlyArray<{ path: string; changeFrequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; priority: number }> = [
  { path: '/', changeFrequency: 'daily', priority: 1 },
  { path: '/search', changeFrequency: 'daily', priority: 0.8 },
  { path: '/about', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/contact', changeFrequency: 'yearly', priority: 0.4 },
  { path: '/terms', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/privacy', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/returns', changeFrequency: 'yearly', priority: 0.3 },
  { path: '/vendor/landing', changeFrequency: 'monthly', priority: 0.6 },
];

/** Public pages inside disallowed areas (robots `Allow`, more specific than the Disallow). */
export const ROBOTS_ALLOW: readonly string[] = ['/', '/vendor/landing'];

/** Areas crawlers must not index (session-bound or API). */
export const ROBOTS_DISALLOW: readonly string[] = ['/admin/', '/customer/', '/vendor/', '/checkout/', '/checkout', '/cart', '/login', '/payment/', '/forbidden', '/api/'];
