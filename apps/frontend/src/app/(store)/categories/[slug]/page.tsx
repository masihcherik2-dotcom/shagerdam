import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { ProductBrowser } from '@/components/catalog/product-browser';
import { SkeletonCards } from '@/components/ui/states';
import { isBnplEnabled, loadCreditPlans } from '@/lib/api/catalog.server';
import { serverApiOrNull } from '@/lib/api/server';
import type { CategoryDetail, CategoryTree, CategoryTreeNode } from '@/lib/api/types';
import { formatCount } from '@/lib/format';
import { PLATFORM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const category = await serverApiOrNull<CategoryDetail>(`categories/${encodeURIComponent(slug)}`).catch(() => null);
  return { title: category ? category.titleFa : 'دسته‌بندی' };
}

function findNode(nodes: CategoryTreeNode[], id: string): CategoryTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const [category, tree, plans] = await Promise.all([
    serverApiOrNull<CategoryDetail>(`categories/${encodeURIComponent(slug)}`),
    serverApiOrNull<CategoryTree>('categories/tree'),
    loadCreditPlans(),
  ]);
  if (!category) {
    notFound();
  }
  // Sidebar tree: the root this category belongs to, so siblings and children are one click away.
  const rootId = category.breadcrumbs[0]?.id ?? category.id;
  const root = tree ? findNode(tree.items, rootId) : null;

  return (
    <>
      <nav aria-label="مسیر" className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          {PLATFORM_NAME}
        </Link>
        {category.breadcrumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronLeft className="size-3" />
            {crumb.id === category.id ? (
              <span className="font-medium text-slate-800">{crumb.titleFa}</span>
            ) : (
              <Link href={`/categories/${crumb.slug}`} className="hover:text-brand-700">
                {crumb.titleFa}
              </Link>
            )}
          </span>
        ))}
      </nav>
      <div className="mb-6 flex flex-col gap-3">
        <h1 className="text-2xl font-black text-slate-900">{category.titleFa}</h1>
        <p className="text-sm text-slate-500">{formatCount(category.totalProductCount)} محصول</p>
        {category.children.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {category.children.map((child) => (
              <Link key={child.id} href={`/categories/${child.slug}`} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:border-brand-400 hover:text-brand-700">
                {child.titleFa} <span className="text-xs text-slate-400">({formatCount(child.totalProductCount)})</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      <Suspense fallback={<SkeletonCards />}>
        <ProductBrowser fixedCategorySlug={category.slug} tree={root ? [root] : []} bnplEnabled={isBnplEnabled(plans)} />
      </Suspense>
    </>
  );
}
