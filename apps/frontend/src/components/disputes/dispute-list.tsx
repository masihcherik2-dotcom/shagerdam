'use client';

import { ChevronLeft, Scale } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Money, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import type { Dispute, DisputeStatus, Page } from '@/lib/api/types';
import { DISPUTE_STATUSES } from '@/lib/api/types';
import type { Query } from '@/lib/api/client';
import { useApi } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { DISPUTE_REASON_LABELS, DISPUTE_STATUS } from '@/lib/labels';

/** Paged dispute table with a status filter, for /customer, /vendor and /admin disputes. */
export function DisputeList<T extends Dispute>({ endpoint, hrefBase, extraQuery, partyColumn, emptyText }: { endpoint: string; hrefBase: string; extraQuery?: Query; partyColumn?: { head: string; cell: (dispute: T) => ReactNode }; emptyText: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<DisputeStatus | ''>('');
  const state = useApi<Page<T>>(endpoint, { page, pageSize: 20, status: status || undefined, ...extraQuery });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {(['', ...DISPUTE_STATUSES] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => {
              setStatus(value);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-xs ${status === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
          >
            {value ? DISPUTE_STATUS[value].label : 'همه'}
          </button>
        ))}
      </div>
      <AsyncView state={state} skeleton={<SkeletonRows rows={5} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Scale className="size-8" />} title="اختلافی یافت نشد" description={emptyText} />}>
        {(data) => (
          <>
            <Table head={['مرسوله', 'علت', ...(partyColumn ? [partyColumn.head] : []), 'مبلغ', 'وضعیت', 'تاریخ', '']}>
              {data.items.map((dispute) => (
                <tr key={dispute.id} className="hover:bg-slate-50">
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {dispute.package.subOrderNumber}
                    </span>
                    <div className="text-xs text-slate-500">{dispute.package.storeName}</div>
                  </Td>
                  <Td>{DISPUTE_REASON_LABELS[dispute.reason]}</Td>
                  {partyColumn ? <Td>{partyColumn.cell(dispute)}</Td> : null}
                  <Td>
                    <Money rials={dispute.package.itemsSubtotal} />
                  </Td>
                  <Td>
                    <StatusBadge value={dispute.status} map={DISPUTE_STATUS} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(dispute.createdAt)}</Td>
                  <Td>
                    <Link href={`${hrefBase}/${dispute.id}`} className="flex items-center gap-1 text-sm text-brand-700 hover:underline">
                      مشاهده <ChevronLeft className="size-4" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </div>
  );
}
