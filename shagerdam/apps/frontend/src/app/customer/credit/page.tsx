'use client';

import { CalendarDays, CreditCard, FlaskConical, Landmark, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input, TomanInput } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Badge, Card, Money, PageHeader, StatCard, StatusBadge } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { CreditAccount, CreditApplication, CreditPlans, Installment, InstallmentPaymentResponse, InstallmentsOverview, OrderInstallments } from '@/lib/api/types';
import { tomanToRials } from '@/lib/currency';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDate, formatPercent, toLatinDigits, toPersianDigits } from '@/lib/format';
import { isValidNationalCode } from '@/lib/iran';
import { shareOf } from '@/lib/money';
import { CREDIT_ACCOUNT_STATUS, CREDIT_APPLICATION_STATUS, INSTALLMENT_STATUS, creditDecisionReason } from '@/lib/labels';

export default function CustomerCreditPage() {
  const plans = useApi<CreditPlans>('/credit/plans');
  const account = useApi<CreditAccount>('/credit/account');
  const noAccount = account.error?.status === 404;

  const loading = (plans.loading && !plans.data) || (account.loading && !account.data && !account.error);
  if (loading) return <Skeleton className="h-[480px]" />;
  if (plans.error && !plans.data) return <ErrorState error={plans.error} onRetry={() => void plans.reload()} />;
  if (account.error && !noAccount) return <ErrorState error={account.error} onRetry={() => void account.reload()} />;

  return (
    <>
      <PageHeader title="اعتبار خرید و اقساط" description={plans.data?.provider ? `تأمین‌کنندهٔ اعتبار: ${plans.data.provider.name}` : undefined} />
      {plans.data?.provider?.isSandbox ? (
        <p className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" /> محیط توسعه: بانک آزمایشی (Sandbox) فعال است؛ اعتبارسنجی و تخصیص اعتبار واقعی نیست.
        </p>
      ) : null}
      {account.data ? (
        <AccountView account={account.data} plans={plans.data} />
      ) : plans.data && !plans.data.creditEnabled ? (
        <EmptyState icon={<Landmark className="size-8" />} title="خرید اقساطی فعلاً فعال نیست" description="در حال حاضر امکان درخواست اعتبار وجود ندارد. لطفاً بعداً دوباره سر بزنید." />
      ) : plans.data ? (
        <ApplyView plans={plans.data} onApproved={() => void account.reload()} />
      ) : null}
    </>
  );
}

/* ─── Apply ─────────────────────────────────────────────────────────────── */

function ApplyView({ plans, onApproved }: { plans: CreditPlans; onApproved: () => void }) {
  const [limitToman, setLimitToman] = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [docs, setDocs] = useState<UploadedFile[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CreditApplication | null>(null);
  const apply = useMutation((body: { requestedLimit: number; nationalCode: string; providerCode: string; documentIds?: string[] }) => apiPost<CreditApplication>('/credit/applications', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    let requestedLimit = 0;
    try {
      requestedLimit = tomanToRials(limitToman);
      if (requestedLimit <= 0) nextErrors.limit = 'مبلغ اعتبار درخواستی را وارد کنید.';
    } catch (caught) {
      nextErrors.limit = caught instanceof Error ? caught.message : 'مبلغ معتبر نیست.';
    }
    const code = toLatinDigits(nationalCode.trim());
    if (!isValidNationalCode(code)) nextErrors.nationalCode = 'کد ملی معتبر نیست.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !plans.provider) return;
    const application = await apply.run({ requestedLimit, nationalCode: code, providerCode: plans.provider.code, ...(docs.length ? { documentIds: docs.map((doc) => doc.id) } : {}) });
    if (application) {
      setResult(application);
      if (application.status === 'APPROVED') onApproved();
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card title="درخواست اعتبار خرید اقساطی">
        {result && result.status !== 'APPROVED' ? (
          <div className="mb-4 flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="flex items-center gap-2">
              نتیجهٔ درخواست: <StatusBadge value={result.status} map={CREDIT_APPLICATION_STATUS} />
            </div>
            {result.decisionReason ? <p className="text-slate-700">{creditDecisionReason(result.decisionReason)}</p> : null}
            {result.trackingCode ? (
              <p className="text-xs text-slate-500">
                کد پیگیری: <span dir="ltr">{result.trackingCode}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="مبلغ اعتبار درخواستی (تومان)" error={errors.limit} required>
            {(id, described) => <TomanInput id={id} aria-describedby={described} value={limitToman} onChange={(event) => setLimitToman(event.target.value)} />}
          </Field>
          <Field label="کد ملی" error={errors.nationalCode} required hint="باید با کد ملی پروفایل شما یکی باشد.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="numeric" maxLength={10} value={nationalCode} onChange={(event) => setNationalCode(event.target.value)} />}
          </Field>
          <FileDrop upload={{ kind: 'document', purpose: 'other' }} value={docs} onChange={setDocs} max={10} accept="image/jpeg,image/png,image/webp,application/pdf" label="مدارک تکمیلی (اختیاری)" hint="مانند فیش حقوقی یا گردش حساب؛ برای بانک ارسال می‌شود." />
          <FormError message={apply.error?.message} />
          <Button type="submit" size="lg" loading={apply.pending} icon={<ShieldCheck className="size-5" />}>
            ارسال درخواست و اعتبارسنجی
          </Button>
        </form>
      </Card>
      <Card title="طرح‌های اقساطی">
        {plans.items.length === 0 ? (
          <p className="text-sm text-slate-500">طرحی تعریف نشده است.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {plans.items.map((plan) => (
              <li key={plan.id} className="flex items-center justify-between rounded-xl border border-slate-100 px-3 py-2">
                <span className="font-medium">{plan.title}</span>
                <Badge tone={Number(plan.interestRatePercent) === 0 ? 'success' : 'neutral'}>{Number(plan.interestRatePercent) === 0 ? 'بدون کارمزد' : `کارمزد ${formatPercent(plan.interestRatePercent)}`}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ─── Account + instalments ─────────────────────────────────────────────── */

function AccountView({ account, plans }: { account: CreditAccount; plans: CreditPlans | undefined }) {
  const installments = useApi<InstallmentsOverview>('/credit/installments');
  const usedShare = shareOf(account.usedAmount, account.totalLimit);
  const reservedShare = shareOf(account.reservedAmount, account.totalLimit);

  return (
    <div className="flex flex-col gap-6">
      <Card
        title={
          <span className="flex items-center gap-2">
            <CreditCard className="size-5 text-brand-600" /> حساب اعتباری
          </span>
        }
        action={<StatusBadge value={account.status} map={CREDIT_ACCOUNT_STATUS} />}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <div className="text-xs text-slate-500">اعتبار قابل استفاده</div>
              <div className="text-2xl font-black text-emerald-700">
                <Money rials={account.availableAmount} />
              </div>
            </div>
            <div className="text-end text-sm text-slate-600">
              سقف کل: <Money rials={account.totalLimit} className="font-bold" />
              {account.expiresAt ? <div className="text-xs text-slate-500">اعتبار تا {formatDate(account.expiresAt)}</div> : null}
            </div>
          </div>
          <div className="flex h-4 w-full overflow-hidden rounded-full bg-emerald-100" role="img" aria-label="وضعیت مصرف اعتبار">
            <span className="h-full bg-brand-600" style={{ width: `${usedShare * 100}%` }} />
            <span className="h-full bg-amber-400" style={{ width: `${reservedShare * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-4 text-xs">
            <Legend color="bg-emerald-300" label="آزاد" value={account.availableAmount} />
            <Legend color="bg-brand-600" label="مصرف‌شده" value={account.usedAmount} />
            <Legend color="bg-amber-400" label="رزروشده (در انتظار پرداخت)" value={account.reservedAmount} />
          </div>
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/" size="sm">
              خرید اقساطی
            </LinkButton>
            {plans?.items.length ? <span className="self-center text-xs text-slate-500">{plans.items.map((plan) => plan.title).join('، ')}</span> : null}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="اقساط باقی‌مانده" value={toPersianDigits(account.outstanding.count)} icon={<CalendarDays className="size-5" />} />
        <StatCard label="اقساط معوق" value={toPersianDigits(account.outstanding.overdueCount)} tone={account.outstanding.overdueCount > 0 ? 'danger' : 'neutral'} />
        <StatCard label="سررسید بعدی" value={account.outstanding.nextDueDate ? formatDate(account.outstanding.nextDueDate) : '—'} />
      </div>

      {installments.loading && !installments.data ? (
        <Skeleton className="h-64" />
      ) : installments.error && !installments.data ? (
        <ErrorState error={installments.error} onRetry={() => void installments.reload()} />
      ) : installments.data && installments.data.orders.length === 0 ? (
        <EmptyState icon={<CalendarDays className="size-8" />} title="قسطی ندارید" description="پس از خرید اقساطی، تقویم اقساط اینجا نمایش داده می‌شود." />
      ) : installments.data ? (
        <InstallmentCalendar overview={installments.data} />
      ) : null}
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-3 rounded-sm ${color}`} /> {label}: <Money rials={value} className="font-medium" />
    </span>
  );
}

const MONTH_FORMAT = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', timeZone: 'Asia/Tehran' });

function InstallmentCalendar({ overview }: { overview: InstallmentsOverview }) {
  const toast = useToast();
  const [payingId, setPayingId] = useState<string | null>(null);

  // Unpaid instalments of all orders grouped by (Persian) due month.
  const months = useMemo(() => {
    const groups = new Map<string, Array<{ installment: Installment; order: OrderInstallments }>>();
    for (const order of overview.orders) {
      for (const installment of order.installments) {
        if (installment.status !== 'PENDING' && installment.status !== 'OVERDUE') continue;
        const key = MONTH_FORMAT.format(new Date(installment.dueDate));
        const list = groups.get(key) ?? [];
        list.push({ installment, order });
        groups.set(key, list);
      }
    }
    return [...groups.entries()];
  }, [overview]);

  async function pay(installment: Installment) {
    setPayingId(installment.id);
    try {
      const payment = await apiPost<InstallmentPaymentResponse>(`/credit/installments/${installment.id}/pay`);
      window.location.assign(payment.redirectUrl);
    } catch (caught) {
      toast.error(toApiError(caught).message);
      setPayingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="تقویم اقساط" action={<span className="text-sm">باقی‌ماندهٔ کل: <Money rials={overview.totalRemaining} className="font-bold" /></span>}>
        {months.length === 0 ? (
          <p className="text-sm text-emerald-700">همهٔ اقساط پرداخت شده‌اند.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {months.map(([month, entries]) => (
              <section key={month} className="rounded-2xl border border-slate-200 p-4">
                <h3 className="mb-3 flex items-center gap-2 font-bold">
                  <CalendarDays className="size-4 text-brand-600" /> {month}
                </h3>
                <ul className="flex flex-col gap-3">
                  {entries.map(({ installment, order }) => (
                    <li key={installment.id} className={`flex flex-col gap-2 rounded-xl p-3 text-sm ${installment.status === 'OVERDUE' ? 'bg-rose-50' : 'bg-slate-50'}`}>
                      <div className="flex items-center justify-between">
                        <span>
                          قسط {toPersianDigits(installment.installmentNumber)} از {toPersianDigits(installment.totalInstallments)}
                        </span>
                        <StatusBadge value={installment.status} map={INSTALLMENT_STATUS} />
                      </div>
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span dir="ltr">{order.orderNumber}</span>
                        <span>سررسید {formatDate(installment.dueDate)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <Money rials={installment.amountDue} className="font-bold" />
                        <Button size="sm" loading={payingId === installment.id} disabled={payingId !== null && payingId !== installment.id} onClick={() => void pay(installment)}>
                          پرداخت قسط
                        </Button>
                      </div>
                      {installment.penaltyAmount !== '0.00' && installment.penaltyAmount !== '0' ? (
                        <span className="text-xs text-rose-700">
                          شامل جریمهٔ دیرکرد <Money rials={installment.penaltyAmount} />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {overview.orders.map((order) => (
        <Card
          key={order.parentOrderId}
          title={
            <span>
              سفارش <span dir="ltr">{order.orderNumber}</span>
              {order.plan ? <span className="ms-2 text-xs font-normal text-slate-500">{order.plan.title}</span> : null}
            </span>
          }
          action={
            <span className="text-xs text-slate-500">
              {toPersianDigits(order.paidCount)} از {toPersianDigits(order.installments.length)} پرداخت‌شده
            </span>
          }
        >
          <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-4">
            <span>
              مبلغ اعتبار: <Money rials={order.creditAmount} />
            </span>
            <span>
              کارمزد: <Money rials={order.totalInterest} />
            </span>
            <span>
              پرداخت‌شده: <Money rials={order.paidAmount} />
            </span>
            <span>
              باقی‌مانده: <Money rials={order.remainingAmount} className="font-bold" />
            </span>
          </div>
          <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
            {order.installments.map((installment) => (
              <li
                key={installment.id}
                title={`${formatDate(installment.dueDate)} — ${INSTALLMENT_STATUS[installment.status].label}`}
                className={`flex flex-col items-center rounded-lg border px-1 py-2 text-[11px] ${
                  installment.status === 'PAID' || installment.status === 'WAIVED' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : installment.status === 'OVERDUE' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                <b>{toPersianDigits(installment.installmentNumber)}</b>
                <span>{formatDate(installment.dueDate)}</span>
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
