import { serverApi } from './server';
import type { CategoryTree, CreditPlans, Page, ProductListItem, ProductQuery } from './types';

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

async function load<T>(promise: Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'خطای نامشخص' };
  }
}

export function loadProducts(query: ProductQuery): Promise<Loaded<Page<ProductListItem>>> {
  return load(serverApi<Page<ProductListItem>>('products', { query: { ...query } }));
}

export function loadCategoryTree(): Promise<Loaded<CategoryTree>> {
  return load(serverApi<CategoryTree>('categories/tree'));
}

/** Installment plans of the active credit provider (public). */
export function loadCreditPlans(): Promise<Loaded<CreditPlans>> {
  return load(serverApi<CreditPlans>('credit/plans'));
}

/** BNPL badges are shown only when the credit programme is live and has plans. */
export function isBnplEnabled(plans: Loaded<CreditPlans>): boolean {
  return plans.ok && plans.data.creditEnabled && plans.data.items.length > 0;
}
