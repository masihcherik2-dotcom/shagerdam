'use client';

import { ArrowDownLeft, ArrowUpRight, Banknote, Landmark } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, TomanInput } from '@/components/ui/field';
import { Card, Money, PageHeader, Pagination, StatCard, StatusBadge, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, ErrorState, Skeleton, SkeletonRows } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { Page, SettlementRequest, VendorProfile, WalletBalanceBucket, WalletSummary, WalletTransaction } from '@/lib/api/types';
import { WALLET_BUCKETS } from '@/lib/api/types';
import { formatToman, rialsToToman, tomanToRials } from '@/lib/currency';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { compareRials } from '@/lib/money';
import { SETTLEMENT_STATUS, WALLET_BUCKET_LABELS, WALLET_TX_LABELS } from '@/lib/labels';

export default function VendorWalletPage() {
  const wallet = useApi<WalletSummary>('/vendor/wallet');
  const [requestOpen, setRequestOpen] = useState(false);
  const [settlementsKey, setSettlementsKey] = useState(0);

  return (
    <>
      <PageHeader
        title="کیف پول و تسویه"
        description="درآمد هر مرسوله پس از تأیید تحویل از «امانی» به «قابل برداشت» منتقل می‌شود."
        action={
          <Button icon={<Banknote className="size-4" />} disabled={!wallet.data || compareRials(wallet.data.withdrawableBalance, 0) <= 0} onClick={() => setRequestOpen(true)}>
            درخواست تسویه
          </Button>
        }
      />
      {wallet.loading && !wallet.data ? (
        <Skeleton className="h-28" />
      ) : wallet.error && !wallet.data ? (
        <ErrorState error={wallet.error} onRetry={() => void wallet.reload()} />
      ) : wallet.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="قابل برداشت" value={<Money rials={wallet.data.withdrawableBalance} />} tone="success" />
          <StatCard label="امانی (در انتظار تحویل)" value={<Money rials={wallet.data.pendingBalance} />} tone="warning" />
          <StatCard label="در حال تسویه" value={<Money rials={wallet.data.settlementHoldBalance} />} tone="info" />
          <StatCard label="مسدود به‌دلیل اختلاف" value={<Money rials={wallet.data.disputeHoldBalance} />} tone="danger" />
          <StatCard label="کل درآمد" value={<Money rials={wallet.data.totalEarnedBalance} />} />
          <StatCard label="کل برداشت‌شده" value={<Money rials={wallet.data.totalWithdrawnAmount} />} />
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-6">
        <Settlements key={settlementsKey} />
        <Ledger />
      </div>

      {requestOpen && wallet.data ? (
        <SettlementModal
          withdrawable={wallet.data.withdrawableBalance}
          onClose={() => setRequestOpen(false)}
          onDone={() => {
            setRequestOpen(false);
            void wallet.reload();
            setSettlementsKey((key) => key + 1);
          }}
        />
      ) : null}
    </>
  );
}

function Settlements() {
  const [page, setPage] = useState(1);
  const state = useApi<Page<SettlementRequest>>('/vendor/wallet/settlements', { page, pageSize: 10 });
  return (
    <Card title="درخواست‌های تسویه">
      <AsyncView state={state} skeleton={<SkeletonRows rows={3} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Landmark className="size-8" />} title="هنوز درخواست تسویه‌ای ثبت نکرده‌اید" />}>
        {(data) => (
          <>
            <Table head={['مبلغ', 'شبا', 'وضعیت', 'پیگیری پایا', 'ثبت', 'رسیدگی']}>
              {data.items.map((item) => (
                <tr key={item.id}>
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
                    {item.rejectionReason ? <div className="mt-1 text-xs text-rose-700">{item.rejectionReason}</div> : null}
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.bankPayaReference ?? '—'}
                    </span>
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(item.createdAt)}</Td>
                  <Td className="text-xs text-slate-500">{item.processedAt ? formatDateTime(item.processedAt) : '—'}</Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </Card>
  );
}

function Ledger() {
  const [page, setPage] = useState(1);
  const [bucket, setBucket] = useState<WalletBalanceBucket | ''>('');
  const state = useApi<Page<WalletTransaction>>('/vendor/wallet/transactions', { page, pageSize: 20, bucket: bucket || undefined });
  return (
    <Card
      title="گردش حساب"
      action={
        <Select
          aria-label="صندوق"
          value={bucket}
          onChange={(event) => {
            setBucket(event.target.value as WalletBalanceBucket | '');
            setPage(1);
          }}
          className="h-9 w-44 text-xs"
        >
          <option value="">همهٔ صندوق‌ها</option>
          {WALLET_BUCKETS.map((value) => (
            <option key={value} value={value}>
              {WALLET_BUCKET_LABELS[value]}
            </option>
          ))}
        </Select>
      }
    >
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} className="h-10" />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState title="تراکنشی ثبت نشده است" />}>
        {(data) => (
          <>
            <Table head={['نوع', 'صندوق', 'مبلغ', 'مانده پس از تراکنش', 'مرسوله', 'زمان']}>
              {data.items.map((tx) => {
                const incoming = compareRials(tx.amount, 0) >= 0;
                return (
                  <tr key={tx.id}>
                    <Td>
                      <span className="flex items-center gap-1.5">
                        {incoming ? <ArrowDownLeft className="size-4 text-emerald-600" /> : <ArrowUpRight className="size-4 text-rose-600" />}
                        {WALLET_TX_LABELS[tx.type]}
                      </span>
                      {tx.description ? <div className="text-xs text-slate-500">{tx.description}</div> : null}
                    </Td>
                    <Td className="text-xs">{WALLET_BUCKET_LABELS[tx.bucket]}</Td>
                    <Td className={incoming ? 'text-emerald-700' : 'text-rose-700'}>
                      <Money rials={tx.amount} />
                    </Td>
                    <Td>
                      <Money rials={tx.balanceAfter} />
                    </Td>
                    <Td>
                      <span dir="ltr" className="font-mono text-xs">
                        {tx.subOrderNumber ?? '—'}
                      </span>
                    </Td>
                    <Td className="text-xs text-slate-500">{formatDateTime(tx.createdAt)}</Td>
                  </tr>
                );
              })}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </Card>
  );
}

function SettlementModal({ withdrawable, onClose, onDone }: { withdrawable: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const profile = useApi<VendorProfile>('/vendors/me');
  const [amount, setAmount] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const request = useMutation((body: { amount: number; targetIban: string }) => apiPost<SettlementRequest>('/vendor/wallet/settlements', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!profile.data) return;
    let rials: number;
    try {
      rials = tomanToRials(amount);
    } catch (caught) {
      return setLocalError(caught instanceof Error ? caught.message : 'مبلغ معتبر نیست.');
    }
    if (rials <= 0) return setLocalError('مبلغ باید بیشتر از صفر باشد.');
    if (compareRials(rials, withdrawable) > 0) return setLocalError(`حداکثر مبلغ قابل برداشت ${formatToman(withdrawable)} است.`);
    setLocalError(null);
    const result = await request.run({ amount: rials, targetIban: profile.data.bankIban });
    if (result) {
      toast.success('درخواست تسویه ثبت شد و پس از تأیید واحد مالی از طریق پایا واریز می‌شود.');
      onDone();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="درخواست تسویه"
      footer={
        <>
          <Button type="submit" form="settlement-form" loading={request.pending} disabled={!profile.data}>
            ثبت درخواست
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <form id="settlement-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          قابل برداشت: <Money rials={withdrawable} className="font-bold" />
        </p>
        <Field label="مبلغ (تومان)" required>
          {(id) => (
            <div className="flex gap-2">
              <div className="flex-1">
                <TomanInput id={id} value={amount} onChange={(event) => setAmount(event.target.value)} />
              </div>
              <Button variant="secondary" size="sm" onClick={() => setAmount(rialsToToman(withdrawable))}>
                کل مبلغ
              </Button>
            </div>
          )}
        </Field>
        <Field label="واریز به شبا" hint="تسویه فقط به شبای تأییدشدهٔ فروشگاه انجام می‌شود؛ برای تغییر آن به «فروشگاه و مدارک» بروید.">
          {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" readOnly value={profile.data?.bankIban ?? (profile.loading ? '…' : '')} />}
        </Field>
        <FormError message={localError ?? request.error?.message ?? profile.error?.message} />
      </form>
    </Modal>
  );
}
