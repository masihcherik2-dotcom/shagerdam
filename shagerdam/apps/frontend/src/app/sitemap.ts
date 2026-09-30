import type { MetadataRoute } from 'next';

import { backendApiUrl } from '@/lib/auth/session-core';
import type { CategoryTree, Page, ProductListItem } from '@/lib/api/types';
import { resolveSiteOrigin } from '@/lib/env';
import { flattenCategorySlugs, STATIC_SITEMAP_PATHS } from '@/lib/seo';

// Built per request from the live catalogue (never at build time, when no API is reachable).
export const dynamic = 'force-dynamic';

const PAGE_SIZE = 100;
/** 50 × 100 = 5 000 products; far below the 50 000-URL sitemap limit. */
const MAX_PRODUCT_PAGES = 50;
const FETCH_TIMEOUT_MS = 8_000;

async function publicGet<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(backendApiUrl(path), { headers: { Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    return response.ok ? ((await response.json()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Static pages, every category and every published product (the public
 * catalogue API returns only active, non-blocked products of approved
 * vendors). If the API is unreachable the static part is still served.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const origin = resolveSiteOrigin();
  const now = new Date();
  const entries: MetadataRoute.Sitemap = STATIC_SITEMAP_PATHS.map((entry) => ({
    url: `${origin}${entry.path}`,
    lastModified: now,
    changeFrequency: entry.changeFrequency,
    priority: entry.priority,
  }));

  const tree = await publicGet<CategoryTree>('categories/tree');
  for (const slug of tree ? flattenCategorySlugs(tree.items) : []) {
    entries.push({ url: `${origin}/categories/${encodeURIComponent(slug)}`, changeFrequency: 'daily', priority: 0.7 });
  }

  for (let page = 1; page <= MAX_PRODUCT_PAGES; page += 1) {
    const result = await publicGet<Page<ProductListItem>>(`products?page=${page}&pageSize=${PAGE_SIZE}`);
    if (!result) break;
    for (const product of result.items) {
      entries.push({ url: `${origin}/products/${encodeURIComponent(product.slug)}`, lastModified: new Date(product.createdAt), changeFrequency: 'weekly', priority: 0.6 });
    }
    if (page >= result.totalPages) break;
  }
  return entries;
}
