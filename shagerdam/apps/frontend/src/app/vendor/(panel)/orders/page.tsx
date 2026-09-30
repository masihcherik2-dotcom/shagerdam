'use client';

import { CheckCircle2, Eye, PackageCheck, Search, Truck, XCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Money, PageHeader, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, Skeleton, SkeletonRows } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Page, SubOrderStatus, VendorSubOrderDetail, VendorSubOrderSummary, VendorSubOrderTransition } from '@/lib/api/types';
import { SUB_ORDER_STATUSES } from '@/lib/api/types';
import { useApi, useDebounced, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, toPersianDigits } from '@/lib/format';
import { SUB_ORDER_STATUS } from '@/lib/labels';

const TRACKING = /^[A-Za-z0-9-]{4,40}$/;

type Action = { kind: 'ship' | 'cancel'; sub: VendorSubOrderSummary };

export default function VendorOrdersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <VendorOrders />
    </Suspense>
  );
}

function VendorOrders() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<SubOrderStatus | ''>('PENDING_APPROVAL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const state = useApi<Page<VendorSubOrderSummary>>('/vendor/orders', { status: status || undefined, search: term || undefined, page, pageSize: 20 });
  const [action, setAction] = useState<Action | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const focus = params.get('focus');

  async function accept(sub: VendorSubOrderSummary) {
    setBusyId(sub.id);
    try {
      await apiPatch<VendorSubOrderTransition>(`/vendor/orders/${sub.id}/status`, { status: 'PROCESSING' });
      toast.success(`مرسولهٔ ${sub.subOrderNumber} پذیرفته شد و در حال پردازش است.`);
      await state.reload();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  function openDetail(id: string | null) {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('focus', id);
    else next.delete('focus');
    router.replace(`/vendor/orders${next.size ? `?${next.toString()}` : ''}`, { scroll: false });
  }

  return (
    <>
      <PageHeader title="مرسوله‌ها" description="پذیرش، ارسال و پیگیری مرسوله‌های فروشگاه" />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          {(['', ...SUB_ORDER_STATUSES] as const).map((value) => (
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
              {value ? SUB_ORDER_STATUS[value].label : 'همه'}
            </button>
          ))}
        </div>
        <div className="relative md:w-64">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
          <Input
            dir="ltr"
            placeholder="شمارهٔ سفارش یا مرسوله"
            value={search}
            maxLength={24}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="ps-9"
          />
        </div>
      </div>

      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<PackageCheck className="size-8" />} title="مرسوله‌ای یافت نشد" />}>
        {(data) => (
          <>
            <Table head={['مرسوله', 'اقلام', 'مبلغ کالا', 'کارمزد', 'سهم شما', 'زمان', 'وضعیت', 'عملیات']}>
              {data.items.map((sub) => (
                <tr key={sub.id} className="align-top">
                  <Td>
                    <div dir="ltr" className="text-end font-mono text-xs">
                      {sub.subOrderNumber}
                    </div>
                    {sub.trackingCode ? (
                      <div className="text-xs text-slate-500">
                        {sub.carrierName}: <span dir="ltr">{sub.trackingCode}</span>
                      </div>
                    ) : null}
                  </Td>
                  <Td>{toPersianDigits(sub.itemCount)}</Td>
                  <Td>
                    <Money rials={sub.itemsSubtotal} />
                  </Td>
                  <Td className="text-slate-500">
                    <Money rials={sub.platformCommissionAmount} />
                  </Td>
                  <Td className="font-bold">
                    <Money rials={sub.vendorEarningsAmount} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(sub.paidAt ?? sub.placedAt)}</Td>
                  <Td>
                    <StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => openDetail(sub.id)} aria-label="جزئیات" />
                      {sub.allowedTransitions.includes('PROCESSING') && sub.status === 'PENDING_APPROVAL' ? (
                        <Button size="sm" variant="success" loading={busyId === sub.id} icon={<CheckCircle2 className="size-4" />} onClick={() => void accept(sub)}>
                          پذیرش و پردازش
                        </Button>
                      ) : null}
                      {sub.allowedTransitions.includes('SHIPPED') && sub.status === 'PROCESSING' ? (
                        <Button size="sm" icon={<Truck className="size-4" />} onClick={() => setAction({ kind: 'ship', sub })}>
                          ثبت ارسال
                        </Button>
                      ) : null}
                      {sub.allowedTransitions.includes('CANCELLED') ? (
                        <Button size="sm" variant="ghost" className="text-rose-600" icon={<XCircle className="size-4" />} onClick={() => setAction({ kind: 'cancel', sub })}>
                          لغو
                        </Button>
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

      {action ? (
        <TransitionModal
          action={action}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            void state.reload();
          }}
        />
      ) : null}
      {focus ? <DetailModal id={focus} onClose={() => openDetail(null)} /> : null}
    </>
  );
}

function TransitionModal({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const run = useMutation((body: Record<string, string>) => apiPatch<VendorSubOrderTransition>(`/vendor/orders/${action.sub.id}/status`, body));
  const ship = action.kind === 'ship';

  async function submit(event: FormEvent) {
    event.preventDefault();
    let body: Record<string, string>;
    if (ship) {
      if (carrier.trim().length < 2) return setLocalError('نام شرکت حمل را وارد کنید.');
      if (!TRACKING.test(tracking.trim())) return setLocalError('کد رهگیری ۴ تا ۴۰ نویسه و فقط حروف لاتین، رقم و خط تیره است.');
      body = { status: 'SHIPPED', shippingCarrier: carrier.trim(), trackingCode: tracking.trim() };
    } else {
      if (reason.trim().length < 5) return setLocalError('علت لغو را (دست‌کم ۵ نویسه) بنویسید؛ برای خریدار نمایش داده می‌شود.');
      body = { status: 'CANCELLED', reason: reason.trim() };
    }
    setLocalError(null);
    const result = await run.run(body);
    if (result) {
      toast.success(ship ? 'ارسال مرسوله ثبت شد.' : 'مرسوله لغو شد و موجودی بازگشت.');
      onDone();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={ship ? `ثبت ارسال — ${action.sub.subOrderNumber}` : `لغو مرسوله — ${action.sub.subOrderNumber}`}
      footer={
        <>
          <Button type="submit" form="transition-form" variant={ship ? 'primary' : 'danger'} loading={run.pending}>
            {ship ? 'ثبت ارسال' : 'لغو مرسوله'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <form id="transition-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {ship ? (
          <>
            <Field label="شرکت حمل" required>
              {(id) => <Input id={id} maxLength={80} list="carriers" value={carrier} onChange={(event) => setCarrier(event.target.value)} placeholder="مثلاً پست پیشتاز" />}
            </Field>
            <datalist id="carriers">
              <option value="پست پیشتاز" />
              <option value="تیپاکس" />
              <option value="چاپار" />
              <option value="پیک اختصاصی" />
            </datalist>
            <Field label="کد رهگیری" required>
              {(id) => <Input id={id} dir="ltr" maxLength={40} value={tracking} onChange={(event) => setTracking(event.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label="علت لغو" required hint="برای خریدار نمایش داده می‌شود. مبلغ به خریدار بازگردانده می‌شود.">
            {(id, described) => <Textarea id={id} aria-describedby={described} rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </Field>
        )}
        <FormError message={localError ?? run.error?.message} />
      </form>
    </Modal>
  );
}

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi<VendorSubOrderDetail>(`/vendor/orders/${id}`);
  return (
    <Modal open size="lg" onClose={onClose} title={state.data ? `مرسولهٔ ${state.data.subOrderNumber}` : 'جزئیات مرسوله'}>
      <AsyncView state={state} skeleton={<Skeleton className="h-72" />}>
        {(sub) => (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />
              <span className="text-slate-500">
                سفارش <span dir="ltr">{sub.orderNumber}</span>
              </span>
              {sub.trackingCode ? (
                <span>
                  {sub.carrierName}: <b dir="ltr">{sub.trackingCode}</b>
                </span>
              ) : null}
            </div>
            <div className="rounded-xl bg-slate-50 p-3 leading-7">
              <b>{sub.shippingAddress.recipientName}</b> — <span dir="ltr">{formatMobile(sub.shippingAddress.recipientMobile)}</span>
              <br />
              {sub.shippingAddress.province}، {sub.shippingAddress.city}، {sub.shippingAddress.postalAddress}
              {sub.shippingAddress.buildingNumber ? `، پلاک ${toPersianDigits(sub.shippingAddress.buildingNumber)}` : ''}
              {sub.shippingAddress.unitNumber ? `، واحد ${toPersianDigits(sub.shippingAddress.unitNumber)}` : ''}
              <br />
              کد پستی: {toPersianDigits(sub.shippingAddress.postalCode)}
            </div>
            {sub.customerNote ? <p className="rounded-xl bg-amber-50 p-3">یادداشت خریدار: {sub.customerNote}</p> : null}
            <Table head={['کالا', 'SKU', 'تعداد', 'قیمت واحد', 'جمع', 'کارمزد']}>
              {sub.items.map((item) => (
                <tr key={item.id}>
                  <Td>
                    {item.productTitle}
                    <div className="text-xs text-slate-500">{[item.variantDetails.colorName, item.variantDetails.size].filter(Boolean).join(' · ')}</div>
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.sku}
                    </span>
                  </Td>
                  <Td>{toPersianDigits(item.quantity)}</Td>
                  <Td>
                    <Money rials={item.unitPrice} />
                  </Td>
                  <Td>
                    <Money rials={item.lineTotal} />
                  </Td>
                  <Td className="text-slate-500">
                    <Money rials={item.commissionAmount} />
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="flex flex-wrap justify-end gap-4">
              <span>
                هزینهٔ ارسال: <Money rials={sub.shippingFee} />
              </span>
              <span className="font-bold">
                سهم شما: <Money rials={sub.vendorEarningsAmount} />
              </span>
            </div>
            <div>
              <h3 className="mb-2 font-bold">تاریخچه</h3>
              <ol className="flex flex-col gap-2">
                {sub.history.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className="flex flex-wrap gap-2 text-xs">
                    <span className="text-slate-500">{formatDateTime(entry.at)}</span>
                    <StatusBadge value={entry.toStatus} map={SUB_ORDER_STATUS} />
                    {entry.note ? <span className="text-slate-600">{entry.note}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </AsyncView>
    </Modal>
  );
}
