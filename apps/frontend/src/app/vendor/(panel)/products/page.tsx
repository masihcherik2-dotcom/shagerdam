'use client';

import { Eye, EyeOff, Package, Pencil, Plus, Rocket, Search } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { PublishDraftsButton } from '@/components/products/publish-drafts-button';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Money, PageHeader, Pagination, Table, Td } from '@/components/ui/misc';
import { ProductStatusBadge } from '@/components/vendor/product-status-badge';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Page, VendorProductStatus, VendorProductSummary } from '@/lib/api/types';
import { useApi, useDebounced } from '@/lib/hooks/use-api';
import { formatCount, formatDate } from '@/lib/format';

const STATUS_FILTERS: Array<{ value: VendorProductStatus | ''; label: string }> = [
  { value: '', label: 'همه' },
  { value: 'published', label: 'منتشرشده' },
  { value: 'draft', label: 'پیش‌نویس' },
  { value: 'blocked', label: 'مسدود توسط مدیریت' },
];

export default function VendorProductsPage() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<VendorProductStatus | ''>('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const state = useApi<Page<VendorProductSummary>>('/vendor/products', { search: term || undefined, status: status || undefined, page, pageSize: 20 });
  const [busyId, setBusyId] = useState<string | null>(null);

  async function togglePublish(product: VendorProductSummary) {
    setBusyId(product.id);
    try {
      await apiPatch(`/vendor/products/${product.id}`, { isPublished: !product.isPublished });
      toast.success(product.isPublished ? 'محصول از فروشگاه برداشته شد.' : 'محصول منتشر شد.');
      await state.reload();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="محصولات"
        action={
          <div className="flex flex-wrap gap-2">
            <PublishDraftsButton endpoint="/vendor/products/publish-drafts" scopeLabel="فروشگاه شما" onPublished={state.reload} />
            <LinkButton href="/vendor/products/new?tab=bulk" variant="success" icon={<Rocket className="size-4" />} data-testid="vendor-bulk-import">
              درون‌ریزی کل فروشگاه
            </LinkButton>
            <LinkButton href="/vendor/products/new" icon={<Plus className="size-4" />}>
              افزودن محصول
            </LinkButton>
          </div>
        }
      />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={status === filter.value}
              onClick={() => {
                setStatus(filter.value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${status === filter.value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
          <Input
            placeholder="جست‌وجوی عنوان یا SKU"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="ps-9"
          />
        </div>
      </div>
      <AsyncView
        state={state}
        skeleton={<SkeletonRows rows={6} />}
        isEmpty={(data) => data.items.length === 0}
        empty={<EmptyState icon={<Package className="size-8" />} title="محصولی یافت نشد" action={<LinkButton href="/vendor/products/new">افزودن اولین محصول</LinkButton>} />}
      >
        {(data) => (
          <>
            <Table head={['محصول', 'دسته', 'قیمت', 'موجودی', 'وضعیت', 'به‌روزرسانی', '']}>
              {data.items.map((product) => (
                <tr key={product.id}>
                  <Td>
                    <Link href={`/vendor/products/${product.id}`} className="flex items-center gap-3 hover:text-brand-700">
                      <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border bg-slate-50">
                        {product.primaryImage ? <Image src={product.primaryImage.thumbnailUrl ?? product.primaryImage.url} alt="" fill sizes="48px" className="object-cover" unoptimized /> : null}
                      </span>
                      <span className="line-clamp-2 font-medium">{product.title}</span>
                    </Link>
                    {product.moderation.blockedReason ? <div className="mt-1 text-xs text-rose-700">علت مسدودی: {product.moderation.blockedReason}</div> : null}
                  </Td>
                  <Td className="text-xs">{product.category.titleFa}</Td>
                  <Td>
                    {product.priceRange ? (
                      product.priceRange.min === product.priceRange.max ? (
                        <Money rials={product.priceRange.min} />
                      ) : (
                        <span className="text-xs">
                          <Money rials={product.priceRange.min} /> تا <Money rials={product.priceRange.max} />
                        </span>
                      )
                    ) : (
                      <Money rials={product.basePrice} />
                    )}
                  </Td>
                  <Td>
                    <span className={product.stock.totalAvailable === 0 ? 'text-rose-600' : ''}>{formatCount(product.stock.totalAvailable)}</span>
                    <div className="text-xs text-slate-500">{formatCount(product.stock.activeVariantCount)} تنوع فعال</div>
                  </Td>
                  <Td>
                    <ProductStatusBadge product={product} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDate(product.updatedAt)}</Td>
                  <Td>
                    <div className="flex gap-1">
                      <LinkButton href={`/vendor/products/${product.id}`} size="sm" variant="ghost" icon={<Pencil className="size-4" />} aria-label="ویرایش" />
                      {!product.moderation.isBlockedByAdmin ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyId === product.id}
                          icon={product.isPublished ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          onClick={() => void togglePublish(product)}
                          aria-label={product.isPublished ? 'لغو انتشار' : 'انتشار'}
                          title={product.isPublished ? 'لغو انتشار' : 'انتشار'}
                        />
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </>
  );
}
