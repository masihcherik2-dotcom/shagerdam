'use client';

import { ChevronLeft, Plus, Search, Store } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { PageHeader, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import type { Page, VendorAdminSummary, VendorStatus } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useDebounced } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime, formatMobile } from '@/lib/format';
import { VENDOR_STATUS } from '@/lib/labels';

const FILTERS: Array<VendorStatus | ''> = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', ''];

export default function AdminVendorsPage() {
  const { user } = useSession();
  const [status, setStatus] = useState<VendorStatus | ''>('PENDING');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const state = useApi<Page<VendorAdminSummary>>('/admin/vendors', { status: status || undefined, search: term || undefined, page, pageSize: 20 });

  return (
    <>
      <PageHeader
        title="فروشندگان و احراز هویت"
        description="بررسی درخواست‌های فروشندگی و مدارک KYC"
        action={
          can(user?.role, 'manageVendors') ? (
            <LinkButton href="/admin/vendors/create" icon={<Plus className="size-4" />} data-testid="admin-create-vendor-link">
              ایجاد فروشگاه
            </LinkButton>
          ) : undefined
        }
      />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((value) => (
            <button
              key={value || 'all'}
              type="button"
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${status === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
            >
              {value ? VENDOR_STATUS[value].label : 'همه'}
            </button>
          ))}
        </div>
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
          <Input
            placeholder="نام یا نامک فروشگاه"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="ps-9"
          />
        </div>
      </div>
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Store className="size-8" />} title="فروشنده‌ای با این شرایط نیست" />}>
        {(data) => (
          <>
            <Table head={['فروشگاه', 'مالک', 'محصولات', 'وضعیت', 'ثبت', '']}>
              {data.items.map((vendor) => (
                <tr key={vendor.id}>
                  <Td>
                    <div className="font-medium">{vendor.storeName}</div>
                    <div dir="ltr" className="text-end text-xs text-slate-500">
                      /{vendor.storeSlug}
                    </div>
                  </Td>
                  <Td>
                    <div>{vendor.owner.fullName || '—'}</div>
                    <div dir="ltr" className="text-end text-xs text-slate-500">
                      {formatMobile(vendor.owner.mobile)}
                    </div>
                  </Td>
                  <Td>{formatCount(vendor.productCount)}</Td>
                  <Td>
                    <StatusBadge value={vendor.status} map={VENDOR_STATUS} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(vendor.createdAt)}</Td>
                  <Td>
                    <Link href={`/admin/vendors/${vendor.id}`} className="flex items-center gap-1 text-sm text-brand-700 hover:underline">
                      بررسی <ChevronLeft className="size-4" />
                    </Link>
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
