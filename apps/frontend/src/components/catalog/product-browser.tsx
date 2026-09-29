'use client';

import { Filter, PackageSearch, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Pagination } from '@/components/ui/misc';
import { EmptyState, ErrorState, SkeletonCards } from '@/components/ui/states';
import type { CategoryTreeNode, ColorOption, Page, ProductListItem, ProductSort } from '@/lib/api/types';
import { PRODUCT_SORTS } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatCount } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks/use-api';
import { SORT_LABELS } from '@/lib/labels';
import { compareRials, toRialCents } from '@/lib/money';

import { ProductGrid } from './product-card';

const PAGE_SIZE = 24;
/** Facets (colours, sizes, price ceiling) are derived from up to this many matching products. */
const FACET_SAMPLE = 100;

interface ProductBrowserProps {
  /** Category page: the category is fixed by the route. */
  fixedCategorySlug?: string;
  tree: CategoryTreeNode[];
  bnplEnabled: boolean;
}

function splitList(value: string | null): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function parseSort(value: string | null): ProductSort {
  return (PRODUCT_SORTS as readonly string[]).includes(value ?? '') ? (value as ProductSort) : 'newest';
}

/** Whole Rials from a URL value, or undefined. */
function parseRials(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * Search/category listing. Filters live in the URL (shareable, back-button
 * friendly) and every change queries GET /products live. The text box is
 * debounced (instant search) — no submit needed.
 */
export function ProductBrowser({ fixedCategorySlug, tree, bnplEnabled }: ProductBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const q = params.get('q') ?? '';
  const sort = parseSort(params.get('sort'));
  const categorySlug = fixedCategorySlug ?? params.get('category') ?? undefined;
  const vendorSlug = params.get('vendor') ?? undefined;
  const minPrice = parseRials(params.get('minPrice'));
  const maxPrice = parseRials(params.get('maxPrice'));
  const inStockOnly = params.get('inStock') === '1';
  const colors = splitList(params.get('colors'));
  const sizes = splitList(params.get('sizes'));
  const page = Math.max(1, Number(params.get('page')) || 1);

  const [term, setTerm] = useState(q);
  const debouncedTerm = useDebounced(term.trim(), 350);
  const [filtersOpen, setFiltersOpen] = useState(false);

  function update(changes: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete('page');
    const text = next.toString();
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
  }

  // Instant search: push the debounced term into the URL.
  useEffect(() => {
    if (debouncedTerm !== q.trim()) update({ q: debouncedTerm || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the debounced term drives this
  }, [debouncedTerm]);
  // Keep the box in sync when the URL changes from elsewhere (header search, back button).
  useEffect(() => setTerm(q), [q]);

  const results = useApi<Page<ProductListItem>>('/products', {
    search: q || undefined,
    categorySlug,
    vendorSlug,
    minPrice,
    maxPrice,
    inStockOnly: inStockOnly || undefined,
    colors,
    sizes,
    sortBy: sort,
    page,
    pageSize: PAGE_SIZE,
  });

  // Facet sample: same text/category scope, without the facet filters themselves.
  const facetSample = useApi<Page<ProductListItem>>('/products', { search: q || undefined, categorySlug, vendorSlug, pageSize: FACET_SAMPLE, sortBy: 'price_desc' });
  const facets = useMemo(() => {
    const colorMap = new Map<string, ColorOption>();
    const sizeSet = new Set<string>();
    let ceiling = '0';
    for (const item of facetSample.data?.items ?? []) {
      for (const color of item.colors) if (!colorMap.has(color.name)) colorMap.set(color.name, color);
      for (const size of item.sizes) sizeSet.add(size);
      if (compareRials(item.priceRange.max, ceiling) > 0) ceiling = item.priceRange.max;
    }
    return { colors: [...colorMap.values()], sizes: [...sizeSet], ceiling: Number(toRialCents(ceiling) / 100n) };
  }, [facetSample.data]);

  const activeFilterCount = (minPrice !== undefined || maxPrice !== undefined ? 1 : 0) + (inStockOnly ? 1 : 0) + colors.length + sizes.length + (!fixedCategorySlug && categorySlug ? 1 : 0);

  const toggleInList = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]).join(',') || null;

  const sidebar = (
    <div className="flex flex-col gap-6">
      <FilterSection title="دسته‌بندی">
        <CategoryTreeFilter
          nodes={tree}
          activeSlug={categorySlug}
          hrefFor={(slug) => {
            if (fixedCategorySlug) {
              const keep = new URLSearchParams(params.toString());
              keep.delete('page');
              const text = keep.toString();
              return `/categories/${slug}${text ? `?${text}` : ''}`;
            }
            const next = new URLSearchParams(params.toString());
            next.delete('page');
            if (slug) next.set('category', slug);
            else next.delete('category');
            const text = next.toString();
            return `${pathname}${text ? `?${text}` : ''}`;
          }}
          allowAll={!fixedCategorySlug}
        />
      </FilterSection>

      <FilterSection title="محدودهٔ قیمت">
        {facetSample.loading && facetSample.data === undefined ? (
          <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
        ) : facets.ceiling > 0 ? (
          <PriceRangeSlider
            key={`${categorySlug ?? ''}-${facets.ceiling}`}
            ceiling={facets.ceiling}
            min={minPrice}
            max={maxPrice}
            onCommit={(nextMin, nextMax) => update({ minPrice: nextMin === undefined ? null : String(nextMin), maxPrice: nextMax === undefined ? null : String(nextMax) })}
          />
        ) : (
          <p className="text-xs text-slate-500">محصولی برای تعیین بازهٔ قیمت نیست.</p>
        )}
      </FilterSection>

      <FilterSection title="موجودی">
        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-slate-700">
          فقط کالاهای موجود
          <button
            type="button"
            role="switch"
            aria-checked={inStockOnly}
            onClick={() => update({ inStock: inStockOnly ? null : '1' })}
            className={`relative h-6 w-11 rounded-full transition ${inStockOnly ? 'bg-brand-600' : 'bg-slate-300'}`}
          >
            <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${inStockOnly ? 'start-[1.375rem]' : 'start-0.5'}`} />
          </button>
        </label>
      </FilterSection>

      {facets.colors.length > 0 ? (
        <FilterSection title="رنگ">
          <div className="flex flex-wrap gap-2">
            {facets.colors.map((color) => {
              const active = colors.includes(color.name);
              return (
                <button
                  key={color.name}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ colors: toggleInList(colors, color.name) })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${active ? 'border-brand-600 bg-brand-50 font-bold text-brand-700' : 'border-slate-300 text-slate-700'}`}
                >
                  <span className="size-3.5 rounded-full border border-slate-300" style={{ backgroundColor: color.hex ?? '#e2e8f0' }} />
                  {color.name}
                </button>
              );
            })}
          </div>
        </FilterSection>
      ) : null}

      {facets.sizes.length > 0 ? (
        <FilterSection title="سایز">
          <div className="flex flex-wrap gap-2">
            {facets.sizes.map((size) => {
              const active = sizes.includes(size);
              return (
                <button
                  key={size}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ sizes: toggleInList(sizes, size) })}
                  className={`min-w-10 rounded-lg border px-2.5 py-1 text-xs ${active ? 'border-brand-600 bg-brand-50 font-bold text-brand-700' : 'border-slate-300 text-slate-700'}`}
                >
                  {size}
                </button>
              );
            })}
          </div>
        </FilterSection>
      ) : null}

      {activeFilterCount > 0 ? (
        <button
          type="button"
          onClick={() => update({ minPrice: null, maxPrice: null, inStock: null, colors: null, sizes: null, ...(fixedCategorySlug ? {} : { category: null }) })}
          className="inline-flex items-center justify-center gap-1 rounded-xl border border-slate-300 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          <X className="size-4" /> حذف همهٔ فیلترها
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <aside className="hidden w-72 shrink-0 rounded-2xl border border-slate-200 bg-white p-4 lg:sticky lg:top-20 lg:block">{sidebar}</aside>

      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
            <input
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="جست‌وجوی فوری در نتایج…"
              aria-label="جست‌وجو"
              className="h-10 w-full rounded-xl border border-slate-300 bg-white pe-3 ps-9 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            مرتب‌سازی:
            <select value={sort} onChange={(event) => update({ sort: event.target.value })} className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm">
              {PRODUCT_SORTS.map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setFiltersOpen(true)} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-sm lg:hidden">
            <Filter className="size-4" /> فیلترها {activeFilterCount > 0 ? `(${formatCount(activeFilterCount)})` : ''}
          </button>
        </div>

        {vendorSlug ? (
          <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-800">
            فقط محصولات فروشگاه «{results.data?.items[0]?.vendor.storeName ?? vendorSlug}»
            <button type="button" onClick={() => update({ vendor: null })} aria-label="حذف فیلتر فروشگاه">
              <X className="size-3.5" />
            </button>
          </p>
        ) : null}
        {results.data ? (
          <p className="mb-3 text-xs text-slate-500" aria-live="polite">
            {formatCount(results.data.total)} محصول{q ? ` برای «${q}»` : ''}
            {results.refreshing || results.loading ? ' — در حال به‌روزرسانی…' : ''}
          </p>
        ) : null}

        {results.loading && results.data === undefined ? (
          <SkeletonCards count={8} />
        ) : results.error && results.data === undefined ? (
          <ErrorState error={results.error} onRetry={() => void results.reload()} />
        ) : results.data && results.data.items.length === 0 ? (
          <EmptyState
            icon={<PackageSearch className="size-6" />}
            title="محصولی با این مشخصات پیدا نشد"
            description="عبارت دیگری را امتحان کنید یا برخی فیلترها را بردارید."
          />
        ) : results.data ? (
          <div className={results.loading ? 'opacity-60 transition-opacity' : ''}>
            <ProductGrid products={results.data.items} bnplEnabled={bnplEnabled} />
            <Pagination page={results.data.page} totalPages={results.data.totalPages} total={results.data.total} onChange={(next) => update({ page: String(next) }, false)} />
          </div>
        ) : null}
      </div>

      {filtersOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="فیلترها">
          <button type="button" className="flex-1 bg-slate-900/40" onClick={() => setFiltersOpen(false)} aria-label="بستن فیلترها" />
          <div className="h-full w-80 max-w-[85vw] overflow-y-auto bg-white p-4">
            <div className="mb-4 flex items-center justify-between">
              <p className="font-bold">فیلترها</p>
              <button type="button" onClick={() => setFiltersOpen(false)} aria-label="بستن">
                <X className="size-5" />
              </button>
            </div>
            {sidebar}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      {children}
    </section>
  );
}

function CategoryTreeFilter({ nodes, activeSlug, hrefFor, allowAll }: { nodes: CategoryTreeNode[]; activeSlug: string | undefined; hrefFor: (slug: string | null) => string; allowAll: boolean }) {
  if (nodes.length === 0) {
    return <p className="text-xs text-slate-500">دسته‌بندی‌ای موجود نیست.</p>;
  }
  const renderNodes = (list: CategoryTreeNode[], depth: number) => (
    <ul className={depth > 0 ? 'ms-3 border-s border-slate-100 ps-2' : ''}>
      {list.map((node) => (
        <li key={node.id}>
          <Link
            href={hrefFor(node.slug)}
            scroll={false}
            className={`flex items-center justify-between rounded-lg px-2 py-1 text-sm ${node.slug === activeSlug ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
          >
            {node.titleFa}
            <span className="text-xs text-slate-400">{formatCount(node.totalProductCount)}</span>
          </Link>
          {node.children.length > 0 ? renderNodes(node.children, depth + 1) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="max-h-72 overflow-y-auto">
      {allowAll ? (
        <Link href={hrefFor(null)} scroll={false} className={`block rounded-lg px-2 py-1 text-sm ${!activeSlug ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}>
          همهٔ دسته‌ها
        </Link>
      ) : null}
      {renderNodes(nodes, 0)}
    </div>
  );
}

/**
 * Dual-thumb price slider over whole Rials (the API unit); labels are shown
 * in Toman via formatToman. Commits on release, not on every pixel.
 */
function PriceRangeSlider({ ceiling, min, max, onCommit }: { ceiling: number; min: number | undefined; max: number | undefined; onCommit: (min: number | undefined, max: number | undefined) => void }) {
  const step = Math.max(10, Math.ceil(ceiling / 100 / 10) * 10);
  const top = Math.ceil(ceiling / step) * step;
  const [low, setLow] = useState(Math.min(min ?? 0, top));
  const [high, setHigh] = useState(Math.min(max ?? top, top));

  const commit = () => onCommit(low > 0 ? low : undefined, high < top ? high : undefined);
  const lowPercent = (low / top) * 100;
  const highPercent = (high / top) * 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
        <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-brand-600" style={{ insetInlineStart: `${lowPercent}%`, insetInlineEnd: `${100 - highPercent}%` }} />
        <input
          type="range"
          min={0}
          max={top}
          step={step}
          value={low}
          aria-label="حداقل قیمت"
          onChange={(event) => setLow(Math.min(Number(event.target.value), high - step))}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          className="range-thumb absolute inset-0 w-full"
        />
        <input
          type="range"
          min={0}
          max={top}
          step={step}
          value={high}
          aria-label="حداکثر قیمت"
          onChange={(event) => setHigh(Math.max(Number(event.target.value), low + step))}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          className="range-thumb absolute inset-0 w-full"
        />
      </div>
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>از {formatToman(low)}</span>
        <span>تا {formatToman(high)}</span>
      </div>
    </div>
  );
}
