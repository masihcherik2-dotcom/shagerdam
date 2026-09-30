'use client';

import { Shield, Undo2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DisputeView } from '@/components/disputes/dispute-view';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormError, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Card, Money, PageHeader } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { DisputeActionResult, DisputeVendorAction, VendorDispute } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { WALLET_BUCKET_LABELS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const NOTES_MIN = 10;
const NOTES_MAX = 2000;

export default function VendorDisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<VendorDispute>(`/vendor/disputes/${id}`);
  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(dispute) => (
        <>
          <PageHeader
            title="رسیدگی به اختلاف"
            description={`خریدار: ${dispute.customerName} (${dispute.customerMobileMasked})`}
            action={
              <LinkButton href="/vendor/disputes" variant="secondary">
                بازگشت
              </LinkButton>
            }
          />
          <DisputeView
            dispute={dispute}
            extra={
              <>
                <Card title="مبلغ مسدودشده">
                  <p className="text-sm">
                    <Money rials={dispute.hold.amount} className="font-bold" />
                    {dispute.hold.source ? <span className="text-slate-500"> — از صندوق «{WALLET_BUCKET_LABELS[dispute.hold.source]}»</span> : null}
                  </p>
                </Card>
                {dispute.status === 'OPEN' ? <RespondForm disputeId={dispute.id} onDone={() => void state.reload()} /> : null}
              </>
            }
          />
        </>
      )}
    </AsyncView>
  );
}

function RespondForm({ disputeId, onDone }: { disputeId: string; onDone: () => void }) {
  const toast = useToast();
  const [action, setAction] = useState<DisputeVendorAction>('REJECT_WITH_DEFENSE');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [itemReturned, setItemReturned] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const respond = useMutation((body: Record<string, unknown>) => apiPost<DisputeActionResult>(`/vendor/disputes/${disputeId}/respond`, body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = notes.trim();
    if (text.length < NOTES_MIN) return setLocalError(`توضیحات باید دست‌کم ${toPersianDigits(NOTES_MIN)} نویسه باشد.`);
    setLocalError(null);
    const body: Record<string, unknown> = { action, defenseNotes: text };
    if (files.length) body.evidenceUrls = files.map((file) => file.url);
    if (action === 'ACCEPT_RETURN') body.itemReturned = itemReturned;
    const result = await respond.run(body);
    if (result) {
      toast.success(action === 'ACCEPT_RETURN' ? 'مرجوعی پذیرفته شد و مبلغ به خریدار بازگردانده می‌شود.' : 'دفاعیه ثبت شد و پرونده برای داوری ارسال شد.');
      onDone();
    }
  }

  return (
    <Card title="پاسخ شما">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="نوع پاسخ">
          {(
            [
              { value: 'REJECT_WITH_DEFENSE', title: 'دفاع و ارجاع به داوری', text: `مستندات خود را ارسال کنید؛ کارشناس ${PLATFORM_NAME} رأی می‌دهد.`, icon: Shield },
              { value: 'ACCEPT_RETURN', title: 'پذیرش مرجوعی', text: 'اختلاف به نفع خریدار بسته و مبلغ مرسوله بازگردانده می‌شود.', icon: Undo2 },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={action === option.value}
              onClick={() => setAction(option.value)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-start ${action === option.value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-300' : 'border-slate-200'}`}
            >
              <option.icon className="mt-0.5 size-5 text-brand-600" />
              <span>
                <span className="block text-sm font-bold">{option.title}</span>
                <span className="text-xs text-slate-600">{option.text}</span>
              </span>
            </button>
          ))}
        </div>
        <Field label={action === 'ACCEPT_RETURN' ? 'توضیح برای خریدار' : 'دفاعیه'} required hint={`${toPersianDigits(notes.trim().length)} / ${toPersianDigits(NOTES_MAX)}`}>
          {(id, described) => <Textarea id={id} aria-describedby={described} rows={5} maxLength={NOTES_MAX} value={notes} onChange={(event) => setNotes(event.target.value)} />}
        </Field>
        <FileDrop upload={{ kind: 'document', purpose: 'dispute_evidence' }} value={files} onChange={setFiles} max={10} accept="image/jpeg,image/png,image/webp,application/pdf" label="تصاویر و مستندات" hint="مثلاً عکس بسته‌بندی پیش از ارسال یا رسید حمل." />
        {action === 'ACCEPT_RETURN' ? <Checkbox label="کالا به فروشگاه بازگشته است (موجودی دوباره افزوده شود)" checked={itemReturned} onChange={(event) => setItemReturned(event.target.checked)} /> : null}
        <FormError message={localError ?? respond.error?.message} />
        <Button type="submit" variant={action === 'ACCEPT_RETURN' ? 'danger' : 'primary'} loading={respond.pending}>
          {action === 'ACCEPT_RETURN' ? 'پذیرش مرجوعی' : 'ارسال دفاعیه'}
        </Button>
      </form>
    </Card>
  );
}
