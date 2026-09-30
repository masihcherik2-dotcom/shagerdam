import { publicApi, REVALIDATE } from './public.server';
import type { CategoryTree, CreditPlans, Page, ProductListItem, ProductQuery } from './types';

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

async function load<T>(promise: Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'خطای نامشخص' };
  }
}

/** Public product listing, cached in the Data Cache for `revalidate` seconds (default: home window). */
export function loadProducts(query: ProductQuery, revalidate: number = REVALIDATE.home): Promise<Loaded<Page<ProductListItem>>> {
  return load(publicApi<Page<ProductListItem>>('products', { query: { ...query }, revalidate, tags: ['catalog'] }));
}

export function loadCategoryTree(revalidate: number = REVALIDATE.home): Promise<Loaded<CategoryTree>> {
  return load(publicApi<CategoryTree>('categories/tree', { revalidate, tags: ['catalog'] }));
}

/** Installment plans of the active credit provider (public). */
export function loadCreditPlans(revalidate: number = REVALIDATE.home): Promise<Loaded<CreditPlans>> {
  return load(publicApi<CreditPlans>('credit/plans', { revalidate, tags: ['credit'] }));
}

/** BNPL badges are shown only when the credit programme is live and has plans. */
export function isBnplEnabled(plans: Loaded<CreditPlans>): boolean {
  return plans.ok && plans.data.creditEnabled && plans.data.items.length > 0;
}
