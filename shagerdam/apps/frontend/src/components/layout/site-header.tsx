import { loadBranding } from '@/lib/api/branding.server';
import { serverApi } from '@/lib/api/server';
import type { CategoryTreeNode, CategoryTree } from '@/lib/api/types';

import { HeaderBar } from './header-bar';

/** Server part of the sticky header: loads the live category tree and the branding once per render. */
export async function SiteHeader() {
  const brandingPromise = loadBranding();
  let categories: CategoryTreeNode[] = [];
  let categoriesError = false;
  try {
    categories = (await serverApi<CategoryTree>('categories/tree')).items;
  } catch {
    categoriesError = true;
  }
  const branding = await brandingPromise;
  return <HeaderBar categories={categories} categoriesError={categoriesError} logoUrl={branding.logoUrl} mobileLogoUrl={branding.mobileLogoUrl} />;
}
