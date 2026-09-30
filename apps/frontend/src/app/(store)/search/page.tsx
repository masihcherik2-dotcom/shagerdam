import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ProductBrowser } from '@/components/catalog/product-browser';
import { PageHeader } from '@/components/ui/misc';
import { SkeletonCards } from '@/components/ui/states';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans, loadProducts } from '@/lib/api/catalog.server';
import { REVALIDATE } from '@/lib/api/public.server';
import { parseListingParams, toProductQuery } from '@/lib/search-params';

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const params = parseListingParams(await searchParams);
  const filtered = Boolean(params.q || params.categorySlug || params.vendorSlug || params.minPrice || params.maxPrice || params.inStockOnly || params.onSaleOnly || params.page > 1);
  return {
    title: params.q ? `جست‌وجوی «${params.q}»` : 'همهٔ محصولات',
    // One canonical listing; filtered/paginated variants are crawlable but not indexed.
    alternates: { canonical: '/search' },
    ...(filtered ? { robots: { index: false, follow: true } } : {}),
  };
}

/**
 * Server-rendered search: q, category, vendor, minPrice, maxPrice, inStock,
 * onSale, colors, sizes, sort and page are read from the URL and the result
 * page is fetched on the server (paginated, 24 per page, from the indexed
 * catalogue query) — the HTML already contains the products.
 */
export default async function SearchPage({ searchParams }: Props) {
  const params = parseListingParams(await searchParams);
  const [tree, plans, results] = await Promise.all([
    loadCategoryTree(REVALIDATE.search),
    loadCreditPlans(REVALIDATE.search),
    loadProducts(toProductQuery(params), REVALIDATE.search),
  ]);
  return (
    <>
      <PageHeader title={params.q ? `نتایج جست‌وجوی «${params.q}»` : 'جست‌وجوی محصولات'} description="فیلترها در نشانی صفحه ذخیره می‌شوند؛ می‌توانید نتیجه را با دیگران به اشتراک بگذارید." />
      <Suspense fallback={<SkeletonCards />}>
        <ProductBrowser tree={tree.ok ? tree.data.items : []} bnplEnabled={isBnplEnabled(plans)} results={results} />
      </Suspense>
    </>
  );
}
