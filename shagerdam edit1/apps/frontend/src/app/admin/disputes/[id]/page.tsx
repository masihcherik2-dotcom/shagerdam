'use client';

import { Gavel, ShieldCheck, UserRound } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DisputeView } from '@/components/disputes/dispute-view';
import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormError, Textarea } from '@/components/ui/field';
import { Card, DefinitionList, Money, PageHeader, StatusBadge, Table, Td } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { AdminDisputeDossier, ArbitrationDecision, DisputeActionResult } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, toPersianDigits } from '@/lib/format';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS, SUB_ORDER_STATUS, WALLET_BUCKET_LABELS } from '@/lib/labels';

const ACTIVE = ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION'];

export default function AdminDisputeDossierPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const state = useApi<AdminDisputeDossier>(`/admin/disputes/${id}`);
  const mayArbitrate = can(user?.role, 'arbitrateDisputes');

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[600px]" />}>
      {(dossier) => (
        <>
          <PageHeader
            title="پروندهٔ اختلاف"
            description={`سفارش ${dossier.order.orderNumber} — مرسولهٔ ${dossier.package.subOrderNumber}`}
            action={
              <LinkButton href="/admin/disputes" variant="secondary">
                بازگشت
              </LinkButton>
            }
          />
          <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
            <DisputeView
              dispute={dossier}
              extra={
                <>
                  <Card title="اقلام مرسوله">
                    <Table head={['کالا', 'SKU', 'تعداد', 'قیمت واحد', 'جمع']}>
                      {dossier.items.map((item) => (
                        <tr key={item.sku}>
                          <Td>{item.productTitle}</Td>
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
                            <Money rials={item.totalLineAmount} />
                          </Td>
                        </tr>
                      ))}
                    </Table>
                  </Card>
                  <Card title="تاریخچهٔ مرسوله">
                    <ol className="flex flex-col gap-2 text-xs">
                      {dossier.packageHistory.map((entry, index) => (
                        <li key={`${entry.createdAt}-${index}`} className="flex flex-wrap items-center gap-2">
                          <span className="text-slate-500">{formatDateTime(entry.createdAt)}</span>
                          <StatusBadge value={entry.toStatus} map={SUB_ORDER_STATUS} />
                          <span className="text-slate-500">{entry.actorRole}</span>
                          {entry.note ? <span>{entry.note}</span> : null}
                        </li>
                      ))}
                    </ol>
                  </Card>
                  <Card title="پرداخت‌ها">
                    <Table head={['درگاه', 'روش', 'وضعیت', 'نقدی', 'اعتباری', 'RRN', 'زمان']}>
                      {dossier.payments.map((payment) => (
                        <tr key={payment.id}>
                          <Td className="text-xs">{payment.gatewayName}</Td>
                          <Td className="text-xs">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</Td>
                          <Td className="text-xs">{payment.status}</Td>
                          <Td>
                            <Money rials={payment.cashAmount} />
                          </Td>
                          <Td>
                            <Money rials={payment.creditAmount} />
                          </Td>
                          <Td>
                            <span dir="ltr" className="font-mono text-xs">
                              {payment.bankRrn ?? '—'}
                            </span>
                          </Td>
                          <Td className="text-xs text-slate-500">{payment.paidAt ? formatDateTime(payment.paidAt) : '—'}</Td>
                        </tr>
                      ))}
                    </Table>
                  </Card>
                </>
              }
            />
            <aside className="flex flex-col gap-6">
              {mayArbitrate && ACTIVE.includes(dossier.status) ? <ArbitrationForm dossier={dossier} onDone={() => void state.reload()} /> : null}
              <Card title={<span className="flex items-center gap-2"><UserRound className="size-4" /> خریدار</span>}>
                <DefinitionList
                  items={[
                    { label: 'نام', value: dossier.customer.name },
                    { label: 'موبایل', value: <span dir="ltr">{formatMobile(dossier.customer.mobile)}</span> },
                  ]}
                />
              </Card>
              <Card title="سفارش">
                <DefinitionList
                  items={[
                    { label: 'وضعیت پرداخت', value: <StatusBadge value={dossier.order.paymentStatus} map={PAYMENT_STATUS} /> },
                    { label: 'روش پرداخت', value: PAYMENT_METHOD_LABELS[dossier.order.paymentMethod] },
                    { label: 'مبلغ کل', value: <Money rials={dossier.order.finalPayableAmount} /> },
                    { label: 'سهم فروشنده از مرسوله', value: <Money rials={dossier.vendorEarningsAmount} /> },
                  ]}
                />
              </Card>
              <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> وجه مسدود و کیف پول فروشنده</span>}>
                <DefinitionList
                  items={[
                    { label: 'مبلغ مسدود', value: <Money rials={dossier.hold.amount} /> },
                    { label: 'منبع', value: dossier.hold.source ? WALLET_BUCKET_LABELS[dossier.hold.source] : '—' },
                    { label: 'کسری', value: <Money rials={dossier.hold.shortfall} /> },
                    { label: 'امانی', value: <Money rials={dossier.vendorWallet.pendingBalance} /> },
                    { label: 'قابل برداشت', value: <Money rials={dossier.vendorWallet.withdrawableBalance} /> },
                    { label: 'مسدود (اختلاف)', value: <Money rials={dossier.vendorWallet.disputeHoldBalance} /> },
                  ]}
                />
              </Card>
            </aside>
          </div>
        </>
      )}
    </AsyncView>
  );
}

function ArbitrationForm({ dossier, onDone }: { dossier: AdminDisputeDossier; onDone: () => void }) {
  const toast = useToast();
  const [decision, setDecision] = useState<ArbitrationDecision | ''>('');
  const [notes, setNotes] = useState('');
  const [itemReturned, setItemReturned] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const arbitrate = useMutation((body: Record<string, unknown>) => apiPost<DisputeActionResult>(`/admin/disputes/${dossier.id}/arbitrate`, body));
  const creditOrder = dossier.order.paymentMethod !== 'CASH_IPG';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!decision) return setLocalError('رأی را انتخاب کنید.');
    if (notes.trim().length < 10) return setLocalError('استدلال رأی را دست‌کم در ۱۰ نویسه بنویسید؛ برای هر دو طرف نمایش داده می‌شود.');
    setLocalError(null);
    const body: Record<string, unknown> = { decision, resolutionNotes: notes.trim() };
    if (decision === 'BUYER_FAVOR') body.itemReturned = itemReturned;
    const result = await arbitrate.run(body);
    if (result) {
      toast.success('رأی نهایی ثبت شد.');
      onDone();
    }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Gavel className="size-5 text-brand-600" /> رأی نهایی</span>}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="رأی">
          {(
            [
              ['BUYER_FAVOR', 'به نفع خریدار', 'مرسوله مرجوع و مبلغ بازپرداخت می‌شود.'],
              ['VENDOR_FAVOR', 'به نفع فروشنده', 'مرسوله تحویل‌شده و مبلغ آزاد می‌شود.'],
            ] as const
          ).map(([value, title, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={decision === value}
              disabled={value === 'BUYER_FAVOR' && creditOrder}
              onClick={() => setDecision(value)}
              className={`rounded-xl border p-3 text-start disabled:cursor-not-allowed disabled:opacity-50 ${decision === value ? (value === 'BUYER_FAVOR' ? 'border-rose-400 bg-rose-50' : 'border-emerald-400 bg-emerald-50') : 'border-slate-200'}`}
            >
              <span className="block text-sm font-bold">{title}</span>
              <span className="text-xs text-slate-600">{text}</span>
            </button>
          ))}
        </div>
        {creditOrder ? (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">
            این سفارش با اعتبار بانکی/ترکیبی پرداخت شده است. سرور بازپرداخت یا لغو مرسوله‌های چنین سفارش‌هایی را نمی‌پذیرد (CREDIT_ORDER_REFUND_UNSUPPORTED)، بنابراین رأی به نفع خریدار در اینجا ممکن نیست؛ استرداد باید با بانک اعتباردهنده به‌صورت دستی پیگیری شود.
          </p>
        ) : null}
        <Field label="استدلال رأی" required hint="۱۰ تا ۲۰۰۰ نویسه">
          {(id, described) => <Textarea id={id} aria-describedby={described} rows={5} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />}
        </Field>
        {decision === 'BUYER_FAVOR' ? <Checkbox label="کالا به فروشنده بازگشته است (موجودی افزوده شود)" checked={itemReturned} onChange={(event) => setItemReturned(event.target.checked)} /> : null}
        <FormError message={localError ?? arbitrate.error?.message} />
        <Button type="submit" loading={arbitrate.pending} icon={<Gavel className="size-4" />}>
          ثبت رأی نهایی
        </Button>
      </form>
    </Card>
  );
}
