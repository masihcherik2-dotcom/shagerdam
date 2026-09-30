'use client';

import { CalendarClock, Check, CreditCard, Layers, MapPin, Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { AddressFormModal } from '@/components/customer/address-form';
import { useCart } from '@/components/providers/cart-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError, Textarea } from '@/components/ui/field';
import { Card, Money, PageHeader } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AddressList, CheckoutResponse, CreditAccount, CreditPaymentInitiateResponse, CreditPlans, InitiatePaymentResponse, PaymentMethod } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatMobile, formatPercent, toPersianDigits } from '@/lib/format';
import { previewInstallments, splitCreditPayment } from '@/lib/installments';
import { useApi } from '@/lib/hooks/use-api';
import { PAYMENT_METHOD_LABELS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

type Stage = 'idle' | 'placing' | 'redirecting';

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, loading: cartLoading, error: cartError, reload: reloadCart } = useCart();
  const addresses = useApi<AddressList>('/customer/addresses');
  const account = useApi<CreditAccount>('/credit/account');
  const plans = useApi<CreditPlans>('/credit/plans');

  const [addressId, setAddressId] = useState<string | null>(null);
  const [addressModal, setAddressModal] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('CASH_IPG');
  const [planId, setPlanId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [placedOrder, setPlacedOrder] = useState<CheckoutResponse | null>(null);

  // Preselect the default address.
  useEffect(() => {
    if (addressId === null && addresses.data && addresses.data.items.length > 0) {
      setAddressId((addresses.data.items.find((item) => item.isDefault) ?? addresses.data.items[0])!.id);
    }
  }, [addresses.data, addressId]);

  useEffect(() => {
    if (planId === null && plans.data && plans.data.items.length > 0) {
      setPlanId([...plans.data.items].sort((a, b) => a.durationMonths - b.durationMonths)[0]!.id);
    }
  }, [plans.data, planId]);

  // 404 CREDIT_ACCOUNT_NOT_FOUND simply means "no credit line yet".
  const creditAccount = account.data && account.data.status === 'ACTIVE' ? account.data : null;
  const creditEnabled = Boolean(plans.data?.creditEnabled && plans.data.items.length > 0);
  const payable = cart?.payableAmount ?? '0';

  const creditSplit = useMemo(() => (creditAccount ? splitCreditPayment('BANK_CREDIT', payable, creditAccount.availableAmount) : null), [creditAccount, payable]);
  const hybridSplit = useMemo(() => (creditAccount ? splitCreditPayment('HYBRID', payable, creditAccount.availableAmount) : null), [creditAccount, payable]);
  const selectedPlan = plans.data?.items.find((plan) => plan.id === planId) ?? null;

  const creditPortion = method === 'BANK_CREDIT' && creditSplit?.ok ? creditSplit.creditAmount : method === 'HYBRID' && hybridSplit?.ok ? hybridSplit.creditAmount : null;
  const schedulePreview = creditPortion && selectedPlan ? previewInstallments(creditPortion, selectedPlan.interestRatePercent, selectedPlan.durationMonths) : null;

  async function pay(order: { parentOrderId: string; orderNumber: string }) {
    if (method === 'CASH_IPG') {
      const payment = await apiPost<InitiatePaymentResponse>('/payments/initiate', { parentOrderId: order.parentOrderId });
      setStage('redirecting');
      window.location.assign(payment.redirectUrl);
      return;
    }
    const result = await apiPost<CreditPaymentInitiateResponse>('/payments/credit/initiate', { parentOrderId: order.parentOrderId, planId, paymentMethod: method });
    if (result.status === 'IPG_REQUIRED' && result.redirectUrl) {
      setStage('redirecting');
      window.location.assign(result.redirectUrl);
      return;
    }
    const query = new URLSearchParams({ orderNumber: result.orderNumber, outcome: 'PAID', paymentId: result.paymentId, parentOrderId: result.parentOrderId });
    router.push(`/payment/result?${query.toString()}`);
  }

  async function submit() {
    if (!addressId) {
      setError('یک نشانی برای ارسال انتخاب یا اضافه کنید.');
      return;
    }
    if (method !== 'CASH_IPG' && !planId) {
      setError('طرح اقساط را انتخاب کنید.');
      return;
    }
    setError(null);
    setStage('placing');
    let order = placedOrder;
    try {
      if (!order) {
        order = await apiPost<CheckoutResponse>('/orders/checkout', { addressId, customerNote: note.trim() || undefined });
        setPlacedOrder(order);
        void reloadCart();
      }
      await pay(order);
    } catch (caught) {
      setStage('idle');
      const apiError = toApiError(caught);
      setError(order ? `سفارش ${order.orderNumber} ثبت شد اما شروع پرداخت ممکن نشد: ${apiError.message}` : apiError.message);
    }
  }

  if (cartLoading && !cart) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]" role="status" aria-label="در حال بارگذاری">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (cartError && !cart) {
    return <ErrorState error={cartError} onRetry={() => void reloadCart()} />;
  }
  if (!placedOrder && (!cart || cart.lineCount === 0)) {
    return <EmptyState title="سبد خرید خالی است" description="برای ثبت سفارش ابتدا کالایی به سبد اضافه کنید." action={<LinkButton href="/search">مشاهدهٔ محصولات</LinkButton>} />;
  }
  if (!placedOrder && cart && !cart.canCheckout) {
    return <EmptyState title="سبد خرید نیاز به اصلاح دارد" description="برخی کالاها ناموجود یا غیرفعال شده‌اند." action={<LinkButton href="/cart">بازگشت به سبد خرید</LinkButton>} />;
  }

  const totals = placedOrder
    ? { items: placedOrder.totalItemsAmount, shipping: placedOrder.totalShippingFee, payable: placedOrder.finalPayableAmount, packages: placedOrder.subOrders.length }
    : { items: cart!.itemsSubtotal, shipping: cart!.shippingTotal, payable: cart!.payableAmount, packages: cart!.groups.length };

  return (
    <>
      <PageHeader title="تکمیل خرید" description="نشانی ارسال و شیوهٔ پرداخت را انتخاب کنید." />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <Card
            title={
              <span className="flex items-center gap-2">
                <MapPin className="size-5 text-brand-600" /> نشانی ارسال
              </span>
            }
            action={
              !placedOrder ? (
                <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} onClick={() => setAddressModal(true)}>
                  نشانی جدید
                </Button>
              ) : null
            }
          >
            {addresses.loading && !addresses.data ? (
              <Skeleton className="h-24" />
            ) : addresses.error && !addresses.data ? (
              <ErrorState error={addresses.error} onRetry={() => void addresses.reload()} />
            ) : addresses.data && addresses.data.items.length === 0 ? (
              <EmptyState title="هنوز نشانی ثبت نکرده‌اید" action={<Button onClick={() => setAddressModal(true)}>افزودن نشانی</Button>} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="نشانی ارسال">
                {addresses.data?.items.map((address) => {
                  const active = address.id === addressId;
                  return (
                    <button
                      key={address.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={Boolean(placedOrder)}
                      onClick={() => setAddressId(address.id)}
                      className={`flex flex-col gap-1 rounded-2xl border p-4 text-start text-sm ${active ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300'}`}
                    >
                      <span className="flex items-center justify-between font-bold text-slate-900">
                        {address.province}، {address.city}
                        {active ? <Check className="size-4 text-brand-600" /> : null}
                      </span>
                      <span className="line-clamp-2 leading-6 text-slate-600">{address.postalAddress}</span>
                      <span className="text-xs text-slate-500">
                        {address.recipientName} · {formatMobile(address.recipientMobile)} · کد پستی {toPersianDigits(address.postalCode)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-2">
                <CreditCard className="size-5 text-brand-600" /> شیوهٔ پرداخت
              </span>
            }
          >
            <div className="flex flex-col gap-3" role="radiogroup" aria-label="شیوهٔ پرداخت">
              <MethodOption
                active={method === 'CASH_IPG'}
                disabled={Boolean(placedOrder)}
                onSelect={() => setMethod('CASH_IPG')}
                icon={<CreditCard className="size-5" />}
                title={PAYMENT_METHOD_LABELS.CASH_IPG}
                description="پرداخت کامل با کارت‌های عضو شتاب از طریق درگاه بانکی."
              />
              {account.loading || plans.loading ? (
                <Skeleton className="h-20" />
              ) : !creditEnabled ? (
                <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">خرید اعتباری در حال حاضر فعال نیست.</p>
              ) : !creditAccount ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/50 px-4 py-3 text-sm">
                  <span className="text-emerald-900">{account.data ? 'حساب اعتباری شما فعال نیست.' : 'برای خرید اقساطی ابتدا اعتبار دریافت کنید.'}</span>
                  <Link href="/customer/credit" className="font-bold text-emerald-700 hover:underline">
                    درخواست اعتبار ←
                  </Link>
                </div>
              ) : (
                <>
                  <MethodOption
                    active={method === 'BANK_CREDIT'}
                    disabled={Boolean(placedOrder) || !creditSplit?.ok}
                    onSelect={() => setMethod('BANK_CREDIT')}
                    icon={<CalendarClock className="size-5" />}
                    title={PAYMENT_METHOD_LABELS.BANK_CREDIT}
                    description={
                      creditSplit?.ok
                        ? `کل مبلغ از اعتبار شما (${formatToman(creditAccount.availableAmount)} در دسترس) کسر و اقساطی پرداخت می‌شود.`
                        : `اعتبار در دسترس (${formatToman(creditAccount.availableAmount)}) برای کل مبلغ کافی نیست؛ پرداخت ترکیبی را انتخاب کنید.`
                    }
                  />
                  <MethodOption
                    active={method === 'HYBRID'}
                    disabled={Boolean(placedOrder) || !hybridSplit?.ok}
                    onSelect={() => setMethod('HYBRID')}
                    icon={<Layers className="size-5" />}
                    title={PAYMENT_METHOD_LABELS.HYBRID}
                    description={
                      hybridSplit?.ok
                        ? `${formatToman(hybridSplit.creditAmount)} از اعتبار کسر و ${formatToman(hybridSplit.cashAmount)} باقی‌مانده با درگاه بانکی پرداخت می‌شود.`
                        : 'اعتبار شما کل مبلغ را پوشش می‌دهد؛ پرداخت ترکیبی لازم نیست.'
                    }
                  />
                </>
              )}
            </div>

            {method !== 'CASH_IPG' && plans.data ? (
              <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4">
                <p className="text-sm font-bold text-slate-800">طرح اقساط</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="طرح اقساط">
                  {[...plans.data.items]
                    .sort((a, b) => a.durationMonths - b.durationMonths)
                    .map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        role="radio"
                        aria-checked={plan.id === planId}
                        disabled={Boolean(placedOrder)}
                        onClick={() => setPlanId(plan.id)}
                        className={`rounded-xl border px-3 py-2 text-sm ${plan.id === planId ? 'border-emerald-600 bg-emerald-50 font-bold ring-2 ring-emerald-100' : 'border-slate-200'}`}
                      >
                        {plan.title}
                        <span className="block text-xs font-normal text-slate-500">
                          {toPersianDigits(plan.durationMonths)} قسط · {Number(plan.interestRatePercent) === 0 ? 'بدون سود' : `سود ${formatPercent(plan.interestRatePercent)}`}
                        </span>
                      </button>
                    ))}
                </div>
                {schedulePreview ? (
                  <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs leading-6 text-emerald-900">
                    {toPersianDigits(schedulePreview.lines.length)} قسط حدوداً {formatToman(schedulePreview.regularInstallment)}؛ مجموع بازپرداخت اعتبار {formatToman(schedulePreview.totalPayable)}
                    {Number(selectedPlan?.interestRatePercent) === 0 ? ' (بدون سود)' : ` (شامل ${formatToman(schedulePreview.totalInterest)} سود)`}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>

          {!placedOrder ? (
            <Card title="توضیحات سفارش (اختیاری)">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="مثلاً: قبل از ارسال تماس بگیرید." aria-label="توضیحات سفارش" />
            </Card>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-20">
          <h2 className="text-base font-bold">{placedOrder ? `سفارش ${placedOrder.orderNumber}` : 'خلاصهٔ پرداخت'}</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">مبلغ کالاها</dt>
              <dd><Money rials={totals.items} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">ارسال ({toPersianDigits(totals.packages)} مرسوله)</dt>
              <dd><Money rials={totals.shipping} /></dd>
            </div>
            {creditPortion ? (
              <div className="flex justify-between text-emerald-800">
                <dt>از اعتبار</dt>
                <dd><Money rials={creditPortion} /></dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-black">
              <dt>{method === 'HYBRID' ? 'پرداخت با درگاه' : method === 'BANK_CREDIT' ? 'پرداخت نقدی' : 'مبلغ قابل پرداخت'}</dt>
              <dd>
                <Money rials={method === 'HYBRID' && hybridSplit?.ok ? hybridSplit.cashAmount : method === 'BANK_CREDIT' ? '0' : totals.payable} />
              </dd>
            </div>
          </dl>
          <FormError message={error} />
          <Button size="lg" onClick={() => void submit()} loading={stage !== 'idle'} disabled={!addressId || (method !== 'CASH_IPG' && !creditPortion)}>
            {stage === 'redirecting' ? 'در حال انتقال به درگاه…' : method === 'BANK_CREDIT' ? 'ثبت سفارش و پرداخت اعتباری' : 'ثبت سفارش و پرداخت'}
          </Button>
          {placedOrder ? (
            <Link href={`/customer/orders/${placedOrder.parentOrderId}`} className="text-center text-sm text-brand-700 hover:underline">
              مشاهدهٔ سفارش ثبت‌شده
            </Link>
          ) : null}
          <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            مبلغ تا تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند و سپس به فروشنده پرداخت می‌شود.
          </p>
        </aside>
      </div>

      {addressModal ? (
        <AddressFormModal
          open
          onClose={() => setAddressModal(false)}
          onSaved={(saved) => {
            setAddressModal(false);
            setAddressId(saved.id);
            void addresses.reload();
          }}
        />
      ) : null}
    </>
  );
}

function MethodOption({ active, disabled, onSelect, icon, title, description }: { active: boolean; disabled: boolean; onSelect: () => void; icon: React.ReactNode; title: string; description: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-2xl border p-4 text-start disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300'}`}
    >
      <span className={`mt-0.5 ${active ? 'text-brand-600' : 'text-slate-500'}`}>{icon}</span>
      <span className="flex flex-col gap-1">
        <span className="text-sm font-bold text-slate-900">{title}</span>
        <span className="text-xs leading-5 text-slate-600">{description}</span>
      </span>
    </button>
  );
}
