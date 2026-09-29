import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ProductBrowser } from '@/components/catalog/product-browser';
import { PageHeader } from '@/components/ui/misc';
import { SkeletonCards } from '@/components/ui/states';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans } from '@/lib/api/catalog.server';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `جست‌وجوی «${q}»` : 'همهٔ محصولات' };
}

export default async function SearchPage() {
  const [tree, plans] = await Promise.all([loadCategoryTree(), loadCreditPlans()]);
  return (
    <>
      <PageHeader title="جست‌وجوی محصولات" description="نتایج با هر تغییر عبارت یا فیلتر، بلافاصله از فهرست زندهٔ محصولات به‌روز می‌شوند." />
      <Suspense fallback={<SkeletonCards />}>
        <ProductBrowser tree={tree.ok ? tree.data.items : []} bnplEnabled={isBnplEnabled(plans)} />
      </Suspense>
    </>
  );
}
