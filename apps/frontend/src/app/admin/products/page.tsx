'use client';

import { Ban, ExternalLink, Package, Search, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { PublishDraftsButton } from '@/components/products/publish-drafts-button';
import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Money, PageHeader, Pagination, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { ProductStatusBadge } from '@/components/vendor/product-status-badge';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AdminProduct, Page } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useDebounced, useMutation } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime } from '@/lib/format';

type Filter = 'all' | 'published' | 'draft' | 'blocked';

export default function AdminProductsPage() {
  const { user } = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [vendorSlug, setVendorSlug] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const vendorTerm = useDebounced(vendorSlug.trim().toLowerCase(), 400);
  const state = useApi<Page<AdminProduct>>('/admin/products', {
    search: term || undefined,
    vendorSlug: vendorTerm || undefined,
    isBlockedByAdmin: filter === 'blocked' ? true : filter === 'draft' ? false : undefined,
    isPublished: filter === 'published' ? true : filter === 'draft' ? false : undefined,
    page,
    pageSize: 20,
  });
  const [blocking, setBlocking] = useState<AdminProduct | null>(null);
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const moderate = useMutation((args: { id: string; body: Record<string, unknown> }) => apiPatch<AdminProduct>(`/admin/products/${args.id}/status`, args.body));
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const mayModerate = can(user?.role, 'moderateProducts');

  async function block() {
    if (!blocking) return;
    if (reason.trim().length < 10) return setLocalError('علت مسدودسازی را دست‌کم در ۱۰ نویسه بنویسید؛ برای فروشنده نمایش داده می‌شود.');
    setLocalError(null);
    const result = await moderate.run({ id: blocking.id, body: { isBlockedByAdmin: true, blockedReason: reason.trim() } });
    if (result) {
      toast.success('محصول مسدود و از فروشگاه برداشته شد.');
      setBlocking(null);
      setReason('');
      await state.reload();
    }
  }

  async function unblock(product: AdminProduct) {
    setUnblockingId(product.id);
    try {
      await apiPatch<AdminProduct>(`/admin/products/${product.id}/status`, { isBlockedByAdmin: false });
      toast.success('مسدودی برداشته شد؛ انتشار دوباره با فروشنده است.');
      await state.reload();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setUnblockingId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="نظارت بر محصولات"
        description="مسدودسازی محصولات ناقض قوانین با ذکر علت"
        action={
          mayModerate ? (
            <PublishDraftsButton
              endpoint="/admin/products/publish-drafts"
              vendorSlug={vendorTerm || undefined}
              scopeLabel={vendorTerm ? `فروشگاه «${vendorTerm}»` : 'همهٔ فروشگاه‌ها'}
              onPublished={state.reload}
            />
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['all', 'همه'],
              ['published', 'منتشرشده'],
              ['draft', 'پیش‌نویس'],
              ['blocked', 'مسدود'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${filter === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
            <Input
              placeholder="عنوان یا SKU"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              className="ps-9"
            />
          </div>
          <Input
            dir="ltr"
            placeholder="vendor slug"
            aria-label="نامک فروشگاه"
            value={vendorSlug}
            onChange={(event) => {
              setVendorSlug(event.target.value);
              setPage(1);
            }}
            className="sm:w-44"
          />
        </div>
      </div>
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Package className="size-8" />} title="محصولی یافت نشد" />}>
        {(data) => (
          <>
            <Table head={['محصول', 'فروشگاه', 'قیمت پایه', 'موجودی', 'وضعیت', 'به‌روزرسانی', '']}>
              {data.items.map((product) => (
                <tr key={product.id}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border bg-slate-50">
                        {product.primaryImage ? <Image src={product.primaryImage.thumbnailUrl ?? product.primaryImage.url} alt="" fill sizes="48px" className="object-cover" unoptimized /> : null}
                      </span>
                      <div>
                        <div className="line-clamp-2 font-medium">{product.title}</div>
                        <div className="text-xs text-slate-500">{product.category.titleFa}</div>
                      </div>
                    </div>
                    {product.moderation.blockedReason ? <div className="mt-1 text-xs text-rose-700">علت: {product.moderation.blockedReason}</div> : null}
                  </Td>
                  <Td>
                    <div>{product.vendor.storeName}</div>
                    <div dir="ltr" className="text-end text-xs text-slate-500">
                      {product.vendor.storeSlug}
                    </div>
                  </Td>
                  <Td>
                    <Money rials={product.basePrice} />
                  </Td>
                  <Td>{formatCount(product.stock.totalAvailable)}</Td>
                  <Td>
                    <ProductStatusBadge product={product} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(product.updatedAt)}</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      {product.isPublished && !product.moderation.isBlockedByAdmin ? (
                        <Link href={`/products/${product.slug}`} target="_blank" aria-label="مشاهده در فروشگاه" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
                          <ExternalLink className="size-4" />
                        </Link>
                      ) : null}
                      {mayModerate ? (
                        product.moderation.isBlockedByAdmin ? (
                          <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} loading={unblockingId === product.id} onClick={() => void unblock(product)}>
                            رفع مسدودی
                          </Button>
                        ) : (
                          <Button size="sm" variant="danger" icon={<Ban className="size-4" />} onClick={() => setBlocking(product)}>
                            مسدود
                          </Button>
                        )
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

      <Modal
        open={blocking !== null}
        onClose={() => setBlocking(null)}
        title={`مسدودسازی «${blocking?.title ?? ''}»`}
        footer={
          <>
            <Button variant="danger" loading={moderate.pending} onClick={() => void block()}>
              مسدود شود
            </Button>
            <Button variant="secondary" onClick={() => setBlocking(null)}>
              انصراف
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="علت" required hint="۱۰ تا ۵۰۰ نویسه؛ به فروشنده نمایش داده می‌شود.">
            {(id, described) => <Textarea id={id} aria-describedby={described} rows={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </Field>
          <FormError message={localError ?? moderate.error?.message} />
        </div>
      </Modal>
    </>
  );
}
