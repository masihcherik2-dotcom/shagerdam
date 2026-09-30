import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { Metadata } from 'next';

import { RetryPaymentButton } from '@/components/customer/retry-payment-button';
import { LinkButton } from '@/components/ui/button';
import { Badge, Money, StatusBadge } from '@/components/ui/misc';
import { EmptyState } from '@/components/ui/states';
import { ApiError } from '@/lib/api/errors';
import { serverApi } from '@/lib/api/server';
import type { CustomerOrderDetail, PaymentOutcome } from '@/lib/api/types';
import { formatDateTime, toPersianDigits } from '@/lib/format';
import { PAYMENT_METHOD_LABELS, PAYMENT_OUTCOME, PAYMENT_STATUS } from '@/lib/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'نتیجهٔ پرداخت', robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const OUTCOMES = Object.keys(PAYMENT_OUTCOME) as PaymentOutcome[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Landing page of the bank round-trip (backend PAYMENT_RESULT_REDIRECT_URL).
 * The query string (outcome, order number, RRN) is only a hint: when the
 * order id is present, the order is re-read from the API and its real payment
 * status is what the page trusts.
 */
export default async function PaymentResultPage({ searchParams }: Props) {
  const params = await searchParams;
  const outcomeParam = one(params.outcome);
  const outcome = OUTCOMES.includes(outcomeParam as PaymentOutcome) ? (outcomeParam as PaymentOutcome) : null;
  const orderNumber = one(params.orderNumber);
  const rrn = one(params.rrn);
  const parentOrderId = one(params.parentOrderId);
  const isInstallment = one(params.purpose) === 'INSTALLMENT_REPAYMENT';

  if (!outcome || !orderNumber) {
    return <EmptyState title="اطلاعات پرداخت یافت نشد" description="این صفحه پس از بازگشت از درگاه بانکی نمایش داده می‌شود." action={<LinkButton href="/customer/orders">سفارش‌های من</LinkButton>} />;
  }

  let order: CustomerOrderDetail | null = null;
  let orderError: string | null = null;
  if (!isInstallment && parentOrderId && UUID.test(parentOrderId)) {
    try {
      order = await serverApi<CustomerOrderDetail>(`customer/orders/${parentOrderId}`);
    } catch (error) {
      orderError = error instanceof ApiError && error.status === 401 ? 'برای مشاهدهٔ جزئیات سفارش وارد حساب خود شوید.' : error instanceof Error ? error.message : null;
    }
  }

  // The order's own status wins over the redirect hint — except for an
  // instalment repayment, whose order was paid long ago (the instalment page
  // shows the instalment's own status).
  const effective: PaymentOutcome = order && !isInstallment ? (order.paymentStatus === 'PAID' ? (outcome === 'PAID_REQUIRES_REFUND' ? outcome : 'PAID') : outcome === 'PAID' ? 'VERIFICATION_PENDING' : outcome) : outcome;
  const meta = PAYMENT_OUTCOME[effective];
  const Icon = effective === 'PAID' ? CheckCircle2 : effective === 'FAILED' ? XCircle : Clock;
  const iconColor = effective === 'PAID' ? 'text-emerald-600 bg-emerald-50' : effective === 'FAILED' ? 'text-rose-600 bg-rose-50' : 'text-amber-600 bg-amber-50';

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <span className={`flex size-20 items-center justify-center rounded-full ${iconColor}`}>
        <Icon className="size-10" />
      </span>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-black text-slate-900">
          {isInstallment ? 'پرداخت قسط: ' : ''}
          {meta.label}
        </h1>
        <p className="text-sm leading-7 text-slate-600">{meta.description}</p>
      </div>

      <dl className="grid w-full grid-cols-1 gap-3 rounded-2xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5 text-start">
          <dt className="text-slate-500">شمارهٔ سفارش</dt>
          <dd dir="ltr" className="text-end font-mono font-bold text-slate-900 sm:text-start">
            {orderNumber}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 text-start">
          <dt className="text-slate-500">کد پیگیری بانکی (RRN)</dt>
          <dd dir="ltr" className="text-end font-mono font-bold text-slate-900 sm:text-start">
            {rrn ?? '—'}
          </dd>
        </div>
        {order && !isInstallment ? (
          <>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">وضعیت پرداخت سفارش</dt>
              <dd>
                <StatusBadge value={order.paymentStatus} map={PAYMENT_STATUS} />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">مبلغ سفارش</dt>
              <dd className="font-bold">
                <Money rials={order.finalPayableAmount} />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">شیوهٔ پرداخت</dt>
              <dd>{PAYMENT_METHOD_LABELS[order.paymentMethod]}</dd>
            </div>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">مرسوله‌ها</dt>
              <dd>{toPersianDigits(order.subOrders.length)} مرسوله</dd>
            </div>
            {order.paidAt ? (
              <div className="flex flex-col gap-0.5 text-start sm:col-span-2">
                <dt className="text-slate-500">زمان پرداخت</dt>
                <dd>{formatDateTime(order.paidAt)}</dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>
      {orderError ? <Badge tone="warning">{orderError}</Badge> : null}

      <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
        {isInstallment ? (
          <LinkButton href="/customer/credit" size="lg">
            مشاهدهٔ اقساط
          </LinkButton>
        ) : parentOrderId && UUID.test(parentOrderId) ? (
          <LinkButton href={`/customer/orders/${parentOrderId}`} size="lg">
            پیگیری سفارش
          </LinkButton>
        ) : (
          <LinkButton href="/customer/orders" size="lg">
            سفارش‌های من
          </LinkButton>
        )}
        {order && !isInstallment && order.paymentStatus === 'PENDING' && effective === 'FAILED' ? <RetryPaymentButton parentOrderId={order.id} /> : null}
        <LinkButton href="/" variant="secondary" size="lg">
          بازگشت به فروشگاه
        </LinkButton>
      </div>
    </div>
  );
}
