'use client';

import { CheckCircle2, FileText, XCircle } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Card, DefinitionList, Money, PageHeader, StatusBadge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { VendorAdminDetail, VendorVerification } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, formatPercent, toLatinDigits, toPersianDigits } from '@/lib/format';
import { ROLE_LABELS, VENDOR_STATUS } from '@/lib/labels';

function DocLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return <span className="text-xs text-slate-400">{label}: ارسال نشده</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:border-brand-300 hover:bg-brand-50">
      <FileText className="size-4 text-brand-600" /> {label}
    </a>
  );
}

export default function AdminVendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const toast = useToast();
  const state = useApi<VendorAdminDetail>(`/admin/vendors/${id}`);
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [reason, setReason] = useState('');
  const [commission, setCommission] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const verify = useMutation((body: Record<string, unknown>) => apiPost<VendorAdminDetail>(`/admin/vendors/${id}/verify`, body));
  const mayReview = can(user?.role, 'reviewVendors');

  async function submit() {
    if (!decision) return;
    const body: Record<string, unknown> = { status: decision };
    if (decision === 'REJECTED') {
      if (reason.trim().length < 10) return setLocalError('علت رد را دست‌کم در ۱۰ نویسه بنویسید؛ برای فروشنده نمایش داده می‌شود.');
      body.rejectionReason = reason.trim();
    }
    if (commission.trim()) {
      const rate = Number(toLatinDigits(commission.trim()));
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) return setLocalError('نرخ کارمزد باید بین ۰ تا ۱۰۰ درصد باشد.');
      body.commissionRateOverride = rate;
    }
    setLocalError(null);
    const result = await verify.run(body);
    if (result) {
      toast.success(decision === 'APPROVED' ? 'فروشگاه تأیید شد.' : 'درخواست رد شد.');
      setDecision(null);
      setReason('');
      await state.reload();
    }
  }

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(vendor) => {
        const latest: VendorVerification | undefined = vendor.verifications[0];
        const pendingReview = latest !== undefined && latest.reviewedAt === null;
        return (
          <>
            <PageHeader
              title={vendor.storeName}
              description={<span dir="ltr">/{vendor.storeSlug}</span>}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={vendor.status} map={VENDOR_STATUS} />
                  <LinkButton href="/admin/vendors" variant="secondary">
                    بازگشت
                  </LinkButton>
                </div>
              }
            />
            <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
              <div className="flex flex-col gap-6">
                <Card title="مدارک احراز هویت (KYC)">
                  {vendor.verifications.length === 0 ? (
                    <p className="text-sm text-slate-500">فروشنده هنوز مدرکی ارسال نکرده است؛ تأیید بدون مدرک ممکن نیست.</p>
                  ) : (
                    <ol className="flex flex-col gap-4">
                      {vendor.verifications.map((item, index) => (
                        <li key={item.id} className={`rounded-xl border p-4 ${index === 0 ? 'border-brand-200' : 'border-slate-100 opacity-80'}`}>
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                            <span className="font-medium">
                              {index === 0 ? 'آخرین ارسال' : `ارسال قبلی ${toPersianDigits(index)}`} — {formatDateTime(item.createdAt)}
                            </span>
                            <span className="text-xs text-slate-500">
                              {item.reviewedAt ? `بررسی: ${formatDateTime(item.reviewedAt)}${item.reviewedByName ? ` (${item.reviewedByName})` : ''}` : 'بررسی‌نشده'}
                            </span>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-3">
                            <DocLink href={item.nationalIdCardUrl} label="کارت ملی" />
                            <DocLink href={item.businessLicenseUrl} label="جواز کسب" />
                            <DocLink href={item.bankAccountProofUrl} label="مالکیت حساب" />
                          </div>
                          {item.rejectionReason ? <p className="mt-2 text-xs text-rose-700">علت رد: {item.rejectionReason}</p> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>
                <Card title="سابقهٔ تغییرات">
                  {vendor.auditTrail.length === 0 ? (
                    <p className="text-sm text-slate-500">رویدادی ثبت نشده است.</p>
                  ) : (
                    <ul className="flex flex-col gap-2 text-xs">
                      {vendor.auditTrail.map((entry) => (
                        <li key={entry.id} className="flex flex-wrap gap-2 border-b border-slate-50 pb-2">
                          <span className="text-slate-500">{formatDateTime(entry.createdAt)}</span>
                          <span className="font-mono" dir="ltr">
                            {entry.action}
                          </span>
                          <span>{entry.actorName ?? 'سیستم'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
              <div className="flex flex-col gap-6">
                {mayReview && vendor.status !== 'APPROVED' ? (
                  <Card title="تصمیم">
                    <div className="flex flex-col gap-3">
                      {!pendingReview && vendor.status === 'REJECTED' ? <p className="text-xs text-slate-500">برای تأیید دوباره، فروشنده باید مدارک جدید ارسال کند.</p> : null}
                      <Button variant="success" icon={<CheckCircle2 className="size-4" />} disabled={!latest} onClick={() => setDecision('APPROVED')}>
                        تأیید فروشگاه
                      </Button>
                      <Button variant="danger" icon={<XCircle className="size-4" />} disabled={!pendingReview} onClick={() => setDecision('REJECTED')}>
                        رد درخواست
                      </Button>
                    </div>
                  </Card>
                ) : null}
                <Card title="مالک حساب">
                  <DefinitionList
                    items={[
                      { label: 'نام', value: vendor.owner.fullName || '—' },
                      { label: 'موبایل', value: <span dir="ltr">{formatMobile(vendor.owner.mobile)}</span> },
                      { label: 'ایمیل', value: vendor.owner.email ?? '—' },
                      { label: 'نقش', value: ROLE_LABELS[vendor.owner.role] },
                    ]}
                  />
                </Card>
                <Card title="حساب بانکی و مالی">
                  <DefinitionList
                    items={[
                      { label: 'شبا', value: <span dir="ltr" className="font-mono text-xs">{vendor.bankIban}</span> },
                      { label: 'صاحب حساب', value: vendor.bankAccountHolder ?? '—' },
                      { label: 'کارمزد اختصاصی', value: vendor.commissionRateOverride ? formatPercent(vendor.commissionRateOverride) : 'پیش‌فرض دسته' },
                      { label: 'قابل برداشت', value: vendor.wallet ? <Money rials={vendor.wallet.withdrawableBalance} /> : '—' },
                    ]}
                  />
                </Card>
                {vendor.bio ? (
                  <Card title="معرفی">
                    <p className="whitespace-pre-line text-sm leading-7">{vendor.bio}</p>
                  </Card>
                ) : null}
              </div>
            </div>

            <Modal
              open={decision !== null}
              onClose={() => setDecision(null)}
              title={decision === 'APPROVED' ? 'تأیید فروشگاه' : 'رد درخواست فروشندگی'}
              footer={
                <>
                  <Button variant={decision === 'APPROVED' ? 'success' : 'danger'} loading={verify.pending} onClick={() => void submit()}>
                    {decision === 'APPROVED' ? 'تأیید' : 'رد'}
                  </Button>
                  <Button variant="secondary" onClick={() => setDecision(null)}>
                    انصراف
                  </Button>
                </>
              }
            >
              <div className="flex flex-col gap-3">
                {decision === 'REJECTED' ? (
                  <Field label="علت رد" required hint="۱۰ تا ۱۰۰۰ نویسه؛ برای فروشنده نمایش داده می‌شود.">
                    {(fieldId, described) => <Textarea id={fieldId} aria-describedby={described} rows={4} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />}
                  </Field>
                ) : (
                  <p className="text-sm leading-7">با تأیید، نقش مالک به «فروشنده» تغییر می‌کند و کیف پول فروشگاه فعال می‌شود.</p>
                )}
                <Field label="کارمزد اختصاصی (درصد، اختیاری)" hint="خالی = کارمزد پیش‌فرض دسته‌بندی">
                  {(fieldId, described) => <Input id={fieldId} aria-describedby={described} dir="ltr" inputMode="decimal" value={commission} onChange={(event) => setCommission(event.target.value)} className="w-32" />}
                </Field>
                <FormError message={localError ?? verify.error?.message} />
              </div>
            </Modal>
          </>
        );
      }}
    </AsyncView>
  );
}
