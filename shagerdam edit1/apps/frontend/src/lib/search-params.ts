/**
 * Storefront listing URL ⇄ catalogue API query. One parser for both sides:
 * the server page (SSR of `/search` and `/categories/[slug]`) and the client
 * filter UI read the same URL the same way.
 *
 * URL params (storefront names): q, category, vendor, minPrice, maxPrice
 * (whole Rials), inStock=1, onSale=1, colors, sizes (comma lists), sort, page.
 * API names differ (search, categorySlug, vendorSlug, inStockOnly, onSaleOnly,
 * sortBy) — see `toProductQuery`.
 */
import { PRODUCT_SORTS, type ProductQuery, type ProductSort } from './api/types';

export const LISTING_PAGE_SIZE = 24;
/** Deepest page served (2500 × 24 = 60k rows); deeper OFFSETs are clamped — narrow with filters instead. */
export const MAX_LISTING_PAGE = 2500;

export interface ListingParams {
  q: string;
  sort: ProductSort;
  categorySlug: string | undefined;
  vendorSlug: string | undefined;
  minPrice: number | undefined;
  maxPrice: number | undefined;
  inStockOnly: boolean;
  onSaleOnly: boolean;
  colors: string[];
  sizes: string[];
  page: number;
}

type RawParams = Record<string, string | string[] | undefined> | URLSearchParams;

function read(raw: RawParams, key: string): string | null {
  if (raw instanceof URLSearchParams) return raw.get(key);
  const value = raw[key];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function splitList(value: string | null): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean).slice(0, 20) : [];
}

export function parseSort(value: string | null): ProductSort {
  return (PRODUCT_SORTS as readonly string[]).includes(value ?? '') ? (value as ProductSort) : 'newest';
}

/** Whole Rials from a URL value, or undefined. */
export function parseRials(value: string | null): number | undefined {
  if (!value || !/^\d{1,15}$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parseSlug(value: string | null): string | undefined {
  const slug = value?.trim().toLowerCase();
  return slug && slug.length <= 220 ? slug : undefined;
}

export function parsePage(value: string | null): number {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_LISTING_PAGE) : 1;
}

export function parseListingParams(raw: RawParams, fixedCategorySlug?: string): ListingParams {
  return {
    q: (read(raw, 'q') ?? '').trim().slice(0, 100),
    sort: parseSort(read(raw, 'sort')),
    categorySlug: fixedCategorySlug ?? parseSlug(read(raw, 'category')),
    vendorSlug: parseSlug(read(raw, 'vendor')),
    minPrice: parseRials(read(raw, 'minPrice')),
    maxPrice: parseRials(read(raw, 'maxPrice')),
    inStockOnly: read(raw, 'inStock') === '1',
    onSaleOnly: read(raw, 'onSale') === '1',
    colors: splitList(read(raw, 'colors')),
    sizes: splitList(read(raw, 'sizes')),
    page: parsePage(read(raw, 'page')),
  };
}

/** Listing params → GET /products query (empty filters are dropped by the API client). */
export function toProductQuery(params: ListingParams, pageSize: number = LISTING_PAGE_SIZE): ProductQuery {
  const swapped = params.minPrice !== undefined && params.maxPrice !== undefined && params.minPrice > params.maxPrice;
  return {
    search: params.q || undefined,
    categorySlug: params.categorySlug,
    vendorSlug: params.vendorSlug,
    minPrice: swapped ? params.maxPrice : params.minPrice,
    maxPrice: swapped ? params.minPrice : params.maxPrice,
    inStockOnly: params.inStockOnly || undefined,
    onSaleOnly: params.onSaleOnly || undefined,
    colors: params.colors,
    sizes: params.sizes,
    sortBy: params.sort,
    page: params.page,
    pageSize,
  };
}
