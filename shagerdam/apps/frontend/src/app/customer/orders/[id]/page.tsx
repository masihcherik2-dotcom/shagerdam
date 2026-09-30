'use client';

import { CalendarClock, CircleCheck, CircleSlash, MapPin, Package, Scale, Truck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { DisputeFormModal } from '@/components/customer/dispute-form';
import { RetryPaymentButton } from '@/components/customer/retry-payment-button';
import { PackageStepper } from '@/components/orders/package-stepper';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Textarea } from '@/components/ui/field';
import { Badge, Card, Money, PageHeader, StatusBadge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { CustomerDeliveryConfirmation, CustomerOrderDetail, CustomerSubOrder, Dispute, Page, SubOrderStatus } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, toPersianDigits } from '@/lib/format';
import { DISPUTE_STATUS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS, SUB_ORDER_STATUS, TIMELINE_EVENT_LABELS } from '@/lib/labels';

const DISPUTABLE: readonly SubOrderStatus[] = ['PROCESSING', 'SHIPPED', 'DELIVERED'];

export default function CustomerOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<CustomerOrderDetail>(`/customer/orders/${id}`);
  const disputes = useApi<Page<Dispute>>('/customer/disputes', { pageSize: 100 });

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(order) => <OrderDetail order={order} disputes={disputes.data?.items ?? []} onChange={state.setData} reloadDisputes={disputes.reload} />}
    </AsyncView>
  );
}

function OrderDetail({ order, disputes, onChange, reloadDisputes }: { order: CustomerOrderDetail; disputes: Dispute[]; onChange: (order: CustomerOrderDetail) => void; reloadDisputes: () => Promise<void> }) {
  const toast = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [confirming, setConfirming] = useState<CustomerSubOrder | null>(null);
  const [disputing, setDisputing] = useState<CustomerSubOrder | null>(null);
  const cancel = useMutation((reason: string) => apiPost<CustomerOrderDetail>(`/customer/orders/${order.id}/cancel`, reason ? { reason } : {}));
  const confirm = useMutation((subOrderId: string) => apiPost<CustomerDeliveryConfirmation>(`/customer/orders/${order.id}/sub-orders/${subOrderId}/confirm-delivery`));

  // The latest dispute per package (list is newest first).
  const disputeBySub = useMemo(() => {
    const map = new Map<string, Dispute>();
    for (const dispute of disputes) if (!map.has(dispute.package.subOrderId)) map.set(dispute.package.subOrderId, dispute);
    return map;
  }, [disputes]);

  async function doCancel() {
    const result = await cancel.run(cancelReason.trim());
    if (result) {
      onChange(result);
      setCancelOpen(false);
      toast.success('سفارش لغو شد.');
    }
  }

  async function doConfirm() {
    if (!confirming) return;
    const result = await confirm.run(confirming.id);
    if (result) {
      onChange(result.order);
      setConfirming(null);
      toast.success('تحویل مرسوله تأیید شد. سپاس از خرید شما!');
    }
  }

  const isCredit = order.paymentMethod !== 'CASH_IPG';

  return (
    <>
      <PageHeader
        title={`سفارش ${order.orderNumber}`}
        description={`ثبت‌شده در ${formatDateTime(order.createdAt)}`}
        action={
          <div className="flex flex-wrap gap-2">
            {order.paymentStatus === 'PENDING' && order.paymentMethod === 'CASH_IPG' ? <RetryPaymentButton parentOrderId={order.id} label="پرداخت سفارش" /> : null}
            {order.canCancel ? (
              <Button variant="danger" icon={<CircleSlash className="size-4" />} onClick={() => setCancelOpen(true)}>
                لغو سفارش
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {order.cancellationReason ? <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">علت لغو: {order.cancellationReason}</p> : null}
          {order.subOrders.map((sub) => {
            const dispute = disputeBySub.get(sub.id);
            const activeDispute = dispute && ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION'].includes(dispute.status);
            const canDispute = order.paymentStatus === 'PAID' && DISPUTABLE.includes(sub.status) && (!dispute || dispute.status === 'CANCELLED');
            return (
              <Card
                key={sub.id}
                title={
                  <span className="flex items-center gap-2">
                    <Package className="size-4 text-slate-400" />
                    {sub.store.storeName}
                    <span className="text-xs font-normal text-slate-500" dir="ltr">
                      {sub.subOrderNumber}
                    </span>
                  </span>
                }
                action={<StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />}
              >
                <div className="flex flex-col gap-4">
                  <PackageStepper status={sub.status} />
                  {sub.trackingCode ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">
                      <Truck className="size-4" />
                      {sub.carrierName ?? 'حمل‌کننده'} — کد رهگیری: <b dir="ltr">{sub.trackingCode}</b>
                      {sub.shippedAt ? <span className="text-xs text-sky-700">(ارسال: {formatDateTime(sub.shippedAt)})</span> : null}
                    </div>
                  ) : null}
                  {sub.cancellationReason ? <p className="text-sm text-rose-700">علت لغو مرسوله: {sub.cancellationReason}</p> : null}
                  <ul className="divide-y divide-slate-100 text-sm">
                    {sub.items.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div>
                          <div className="font-medium">{item.productTitle}</div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            {item.variantDetails.colorHex ? <span className="size-3 rounded-full border" style={{ background: item.variantDetails.colorHex }} /> : null}
                            {[item.variantDetails.colorName, item.variantDetails.size, item.variantDetails.guarantee].filter(Boolean).join(' · ')}
                            <span dir="ltr">{item.sku}</span>
                          </div>
                        </div>
                        <div className="text-end">
                          <div>
                            {toPersianDigits(item.quantity)} × <Money rials={item.unitPrice} />
                          </div>
                          <div className="font-bold">
                            <Money rials={item.lineTotal} />
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-sm">
                    <span className="text-slate-600">
                      کالاها <Money rials={sub.itemsSubtotal} /> + ارسال <Money rials={sub.shippingFee} />
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {dispute ? (
                        <Link href={`/customer/disputes/${dispute.id}`} className="flex items-center gap-1">
                          <Scale className="size-4 text-slate-500" /> <StatusBadge value={dispute.status} map={DISPUTE_STATUS} />
                        </Link>
                      ) : null}
                      {sub.status === 'SHIPPED' && order.paymentStatus === 'PAID' && !activeDispute ? (
                        <Button size="sm" variant="success" icon={<CircleCheck className="size-4" />} onClick={() => setConfirming(sub)}>
                          تأیید تحویل
                        </Button>
                      ) : null}
                      {canDispute ? (
                        <Button size="sm" variant="secondary" icon={<Scale className="size-4" />} onClick={() => setDisputing(sub)}>
                          ثبت اختلاف / مرجوعی
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}

          <Card title="تاریخچهٔ سفارش">
            <ol className="relative flex flex-col gap-4 border-s-2 border-slate-100 ps-5">
              {order.timeline.map((event, index) => (
                <li key={`${event.at}-${index}`} className="relative text-sm">
                  <span className="absolute -start-[27px] top-1 size-3 rounded-full border-2 border-white bg-brand-500" />
                  <div className="font-medium">
                    {event.type === 'SUB_ORDER_STATUS' && event.toStatus ? `مرسولهٔ ${event.subOrderNumber ?? ''}: ${SUB_ORDER_STATUS[event.toStatus].label}` : (TIMELINE_EVENT_LABELS[event.type] ?? event.type)}
                  </div>
                  <div className="text-xs text-slate-500">{formatDateTime(event.at)}</div>
                  {event.note ? <div className="mt-1 text-xs text-slate-600">{event.note}</div> : null}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <aside className="flex flex-col gap-4">
          <Card title="پرداخت">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">وضعیت</dt>
                <dd>
                  <StatusBadge value={order.paymentStatus} map={PAYMENT_STATUS} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">روش</dt>
                <dd>{PAYMENT_METHOD_LABELS[order.paymentMethod]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">جمع کالاها</dt>
                <dd>
                  <Money rials={order.totalItemsAmount} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">هزینهٔ ارسال</dt>
                <dd>
                  <Money rials={order.totalShippingFee} />
                </dd>
              </div>
              {order.totalDiscountAmount !== '0' && order.totalDiscountAmount !== '0.00' ? (
                <div className="flex justify-between text-emerald-700">
                  <dt>تخفیف</dt>
                  <dd>
                    <Money rials={order.totalDiscountAmount} />
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-slate-100 pt-2 font-bold">
                <dt>مبلغ نهایی</dt>
                <dd>
                  <Money rials={order.finalPayableAmount} />
                </dd>
              </div>
              {order.paidAt ? <div className="text-xs text-slate-500">پرداخت: {formatDateTime(order.paidAt)}</div> : null}
              {order.paymentStatus === 'PENDING' && order.paymentExpiresAt ? (
                <Badge tone="warning">
                  <CalendarClock className="size-3" /> مهلت پرداخت تا {formatDateTime(order.paymentExpiresAt)}
                </Badge>
              ) : null}
            </dl>
            {isCredit && order.paymentStatus === 'PAID' ? (
              <LinkButton href="/customer/credit" variant="secondary" size="sm" className="mt-3 w-full">
                مشاهدهٔ اقساط
              </LinkButton>
            ) : null}
          </Card>
          <Card title="نشانی تحویل">
            <div className="flex flex-col gap-1 text-sm leading-7">
              <span className="flex items-center gap-1 font-medium">
                <MapPin className="size-4 text-brand-600" /> {order.shippingAddress.province}، {order.shippingAddress.city}
              </span>
              <span className="text-slate-700">{order.shippingAddress.postalAddress}</span>
              <span className="text-xs text-slate-500">کد پستی {toPersianDigits(order.shippingAddress.postalCode)}</span>
              <span className="text-xs text-slate-500">
                {order.shippingAddress.recipientName} — <span dir="ltr">{formatMobile(order.shippingAddress.recipientMobile)}</span>
              </span>
            </div>
          </Card>
          {order.customerNote ? (
            <Card title="یادداشت شما">
              <p className="text-sm text-slate-700">{order.customerNote}</p>
            </Card>
          ) : null}
        </aside>
      </div>

      <Modal
        open={cancelOpen}
        title="لغو سفارش"
        onClose={() => setCancelOpen(false)}
        footer={
          <>
            <Button variant="danger" loading={cancel.pending} onClick={() => void doCancel()}>
              لغو سفارش
            </Button>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              منصرف شدم
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-7">موجودی کالاها آزاد می‌شود{order.paymentStatus === 'PAID' ? ' و مبلغ پرداختی طبق روش پرداخت بازگردانده می‌شود' : ''}.</p>
          <Field label="علت (اختیاری)">{(fieldId) => <Textarea id={fieldId} rows={3} maxLength={500} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />}</Field>
          <FormError message={cancel.error?.message} />
        </div>
      </Modal>

      <Modal
        open={confirming !== null}
        title="تأیید تحویل مرسوله"
        onClose={() => setConfirming(null)}
        footer={
          <>
            <Button variant="success" loading={confirm.pending} onClick={() => void doConfirm()}>
              کالا را سالم تحویل گرفتم
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              انصراف
            </Button>
          </>
        }
      >
        <p className="text-sm leading-7">با تأیید تحویل مرسولهٔ «{confirming?.store.storeName}»، مبلغ آن برای فروشنده قابل برداشت می‌شود. اگر مشکلی دارید، به‌جای تأیید، اختلاف ثبت کنید.</p>
        <FormError message={confirm.error?.message} />
      </Modal>

      {disputing ? (
        <DisputeFormModal
          open
          subOrderId={disputing.id}
          packageLabel={disputing.store.storeName}
          onClose={() => setDisputing(null)}
          onFiled={() => {
            setDisputing(null);
            void reloadDisputes();
          }}
        />
      ) : null}
    </>
  );
}
