import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { cache, Suspense } from 'react';

import { ProductBrowser } from '@/components/catalog/product-browser';
import { SkeletonCards } from '@/components/ui/states';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans, loadProducts } from '@/lib/api/catalog.server';
import { publicApiOrNull, REVALIDATE } from '@/lib/api/public.server';
import type { CategoryDetail, CategoryTreeNode } from '@/lib/api/types';
import { resolveSiteOrigin } from '@/lib/env';
import { formatCount } from '@/lib/format';
import { PLATFORM_NAME } from '@/lib/brand';
import { parseListingParams, toProductQuery } from '@/lib/search-params';
import { categoryBreadcrumbJsonLd, serializeJsonLd } from '@/lib/seo';

/** ISR window of the category data (Data Cache); the HTML is rendered per request (session-aware header). */
export const revalidate = 120;

type Props = { params: Promise<{ slug: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const loadCategory = cache((slug: string) =>
  publicApiOrNull<CategoryDetail>(`categories/${encodeURIComponent(slug)}`, { revalidate: REVALIDATE.category, tags: ['catalog'] }),
);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const category = await loadCategory(slug).catch(() => null);
  if (!category) return { title: 'دسته‌بندی', robots: { index: false } };
  const path = `/categories/${encodeURIComponent(category.slug)}`;
  return {
    title: category.titleFa,
    description: `خرید نقدی و اقساطی ${category.titleFa} از فروشگاه‌های تأییدشدهٔ ${PLATFORM_NAME} — ${formatCount(category.totalProductCount)} محصول.`,
    alternates: { canonical: path },
  };
}

function findNode(nodes: CategoryTreeNode[], id: string): CategoryTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const listing = parseListingParams(await searchParams, slug.toLowerCase());
  const [category, tree, plans, results] = await Promise.all([
    loadCategory(slug),
    loadCategoryTree(REVALIDATE.category),
    loadCreditPlans(REVALIDATE.category),
    loadProducts(toProductQuery(listing), REVALIDATE.category),
  ]);
  if (!category) {
    notFound();
  }
  const origin = resolveSiteOrigin();
  const jsonLd = serializeJsonLd(categoryBreadcrumbJsonLd(category, origin, PLATFORM_NAME));
  // Sidebar tree: the root this category belongs to, so siblings and children are one click away.
  const rootId = category.breadcrumbs[0]?.id ?? category.id;
  const root = tree.ok ? findNode(tree.data.items, rootId) : null;

  return (
    <>
      {/* Schema.org BreadcrumbList; serializeJsonLd escapes `<` so the payload cannot close the script tag. */}
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
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
        <ProductBrowser fixedCategorySlug={category.slug} tree={root ? [root] : []} bnplEnabled={isBnplEnabled(plans)} results={results} />
      </Suspense>
    </>
  );
}
