'use client';

import { CheckCircle2, Landmark, XCircle } from 'lucide-react';
import { useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Money, PageHeader, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import type { Page, SettlementRequest, SettlementStatus } from '@/lib/api/types';
import { SETTLEMENT_STATUSES } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { SETTLEMENT_STATUS } from '@/lib/labels';

const PAYA_REFERENCE = /^[A-Za-z0-9-]{4,60}$/;
type Decision = { kind: 'APPROVE' | 'REJECT'; item: SettlementRequest };

export default function AdminSettlementsPage() {
  const { user } = useSession();
  const [status, setStatus] = useState<SettlementStatus | ''>('REQUESTED');
  const [page, setPage] = useState(1);
  const state = useApi<Page<SettlementRequest>>('/admin/settlements', { status: status || undefined, page, pageSize: 20 });
  const [decision, setDecision] = useState<Decision | null>(null);
  const mayProcess = can(user?.role, 'processSettlements');

  return (
    <>
      <PageHeader title="تسویه‌ها" description="پرداخت درخواست‌های تسویهٔ فروشندگان از طریق پایا و ثبت شمارهٔ پیگیری" />
      <div className="mb-4 flex flex-wrap gap-2">
        {(['', ...SETTLEMENT_STATUSES] as const).map((value) => (
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
            {value ? SETTLEMENT_STATUS[value].label : 'همه'}
          </button>
        ))}
      </div>
      {!mayProcess ? <p className="mb-4 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">نقش شما فقط امکان مشاهده دارد؛ پرداخت تسویه با مسئول مالی یا مدیر ارشد است.</p> : null}
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Landmark className="size-8" />} title="درخواستی با این وضعیت نیست" />}>
        {(data) => (
          <>
            <Table head={['فروشگاه', 'مبلغ', 'شبای مقصد', 'وضعیت', 'پیگیری پایا', 'ثبت', 'رسیدگی', '']}>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <Td className="font-medium">{item.storeName}</Td>
                  <Td className="font-bold">
                    <Money rials={item.amount} />
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.targetIban}
                    </span>
                  </Td>
                  <Td>
                    <StatusBadge value={item.status} map={SETTLEMENT_STATUS} />
                    {item.rejectionReason ? <div className="mt-1 max-w-48 text-xs text-rose-700">{item.rejectionReason}</div> : null}
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.bankPayaReference ?? '—'}
                    </span>
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(item.createdAt)}</Td>
                  <Td className="text-xs text-slate-500">
                    {item.processedAt ? formatDateTime(item.processedAt) : '—'}
                    {item.processedBy?.fullName ? <div>{item.processedBy.fullName}</div> : null}
                  </Td>
                  <Td>
                    {mayProcess && (item.status === 'REQUESTED' || item.status === 'PROCESSING') ? (
                      <div className="flex gap-1">
                        <Button size="sm" variant="success" icon={<CheckCircle2 className="size-4" />} onClick={() => setDecision({ kind: 'APPROVE', item })}>
                          پرداخت
                        </Button>
                        <Button size="sm" variant="ghost" className="text-rose-600" icon={<XCircle className="size-4" />} onClick={() => setDecision({ kind: 'REJECT', item })}>
                          رد
                        </Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
      {decision ? (
        <DecisionModal
          decision={decision}
          onClose={() => setDecision(null)}
          onDone={() => {
            setDecision(null);
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

function DecisionModal({ decision, onClose, onDone }: { decision: Decision; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const process = useMutation((body: Record<string, string>) => apiPatch<SettlementRequest>(`/admin/settlements/${decision.item.id}/process`, body));
  const approve = decision.kind === 'APPROVE';

  async function submit() {
    let body: Record<string, string>;
    if (approve) {
      if (!PAYA_REFERENCE.test(reference.trim())) return setLocalError('شمارهٔ پیگیری پایا ۴ تا ۶۰ نویسه و فقط حروف لاتین، رقم و خط تیره است.');
      body = { action: 'APPROVE', payaReferenceNumber: reference.trim() };
    } else {
      if (reason.trim().length < 5) return setLocalError('علت رد را دست‌کم در ۵ نویسه بنویسید.');
      body = { action: 'REJECT', rejectionReason: reason.trim() };
    }
    setLocalError(null);
    const result = await process.run(body);
    if (result) {
      toast.success(approve ? 'پرداخت تسویه ثبت شد.' : 'درخواست رد شد و مبلغ به موجودی قابل برداشت فروشنده بازگشت.');
      onDone();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={approve ? 'ثبت پرداخت پایا' : 'رد درخواست تسویه'}
      footer={
        <>
          <Button variant={approve ? 'success' : 'danger'} loading={process.pending} onClick={() => void submit()}>
            {approve ? 'ثبت پرداخت' : 'رد درخواست'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="rounded-xl bg-slate-50 px-3 py-2 leading-7">
          {decision.item.storeName} — <Money rials={decision.item.amount} className="font-bold" />
          <br />
          شبا: <span dir="ltr" className="font-mono text-xs">{decision.item.targetIban}</span>
        </p>
        {approve ? (
          <>
            <p className="text-xs leading-6 text-amber-800">ابتدا مبلغ را از سامانهٔ بانک به شبای بالا (پایا) واریز کنید، سپس شمارهٔ پیگیری را ثبت کنید. این ثبت برگشت‌ناپذیر است.</p>
            <Field label="شمارهٔ پیگیری پایا" required>
              {(id) => <Input id={id} dir="ltr" maxLength={60} value={reference} onChange={(event) => setReference(event.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label="علت رد" required hint="برای فروشنده نمایش داده می‌شود.">
            {(id, described) => <Textarea id={id} aria-describedby={described} rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </Field>
        )}
        <FormError message={localError ?? process.error?.message} />
      </div>
    </Modal>
  );
}
