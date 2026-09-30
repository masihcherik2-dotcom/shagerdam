'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Select, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Modal } from '@/components/ui/modal';
import { apiPost } from '@/lib/api/client';
import type { Dispute, DisputeActionResult, DisputeReason } from '@/lib/api/types';
import { DISPUTE_REASONS } from '@/lib/api/types';
import { useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { DISPUTE_REASON_LABELS } from '@/lib/labels';

/** Mirrors the backend limits (CreateDisputeDto): description 20–2000 chars, ≤ 10 evidence files. */
export const DISPUTE_DESCRIPTION_MIN = 20;
export const DISPUTE_DESCRIPTION_MAX = 2000;
export const MAX_EVIDENCE = 10;

interface Props {
  open: boolean;
  onClose: () => void;
  onFiled: (dispute: Dispute) => void;
  subOrderId: string;
  packageLabel: string;
}

/**
 * Opens a dispute on one package (POST /customer/disputes). Photos are
 * uploaded first as private `dispute_evidence` documents; their download
 * URLs are sent as evidence. Filing freezes the vendor's earnings for the package.
 */
export function DisputeFormModal({ open, onClose, onFiled, subOrderId, packageLabel }: Props) {
  const toast = useToast();
  const [reason, setReason] = useState<DisputeReason | ''>('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const file = useMutation((body: { subOrderId: string; reason: DisputeReason; description: string; evidenceUrls: string[] }) => apiPost<DisputeActionResult>('/customer/disputes', body));

  useEffect(() => {
    if (open) {
      setReason('');
      setDescription('');
      setFiles([]);
      setLocalError(null);
      file.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = description.trim();
    if (!reason) return setLocalError('علت اختلاف را انتخاب کنید.');
    if (text.length < DISPUTE_DESCRIPTION_MIN) return setLocalError(`شرح مشکل باید دست‌کم ${toPersianDigits(DISPUTE_DESCRIPTION_MIN)} نویسه باشد.`);
    setLocalError(null);
    const result = await file.run({ subOrderId, reason, description: text, evidenceUrls: files.map((item) => item.url) });
    if (result) {
      toast.success('درخواست شما ثبت شد و برای فروشنده ارسال شد.');
      onFiled(result.dispute);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`ثبت اختلاف / مرجوعی — ${packageLabel}`}
      size="lg"
      footer={
        <>
          <Button type="submit" form="dispute-form" variant="danger" loading={file.pending}>
            ثبت اختلاف
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <form id="dispute-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <Field label="علت" required>
          {(id) => (
            <Select id={id} value={reason} onChange={(event) => setReason(event.target.value as DisputeReason)}>
              <option value="">انتخاب کنید…</option>
              {DISPUTE_REASONS.map((value) => (
                <option key={value} value={value}>
                  {DISPUTE_REASON_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="شرح مشکل" required hint={`${toPersianDigits(description.trim().length)} / ${toPersianDigits(DISPUTE_DESCRIPTION_MAX)} نویسه — دست‌کم ${toPersianDigits(DISPUTE_DESCRIPTION_MIN)}`}>
          {(id, described) => <Textarea id={id} aria-describedby={described} rows={5} maxLength={DISPUTE_DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="چه مشکلی پیش آمده است؟ جزئیات را بنویسید." />}
        </Field>
        <FileDrop
          upload={{ kind: 'document', purpose: 'dispute_evidence' }}
          value={files}
          onChange={setFiles}
          max={MAX_EVIDENCE}
          accept="image/jpeg,image/png,image/webp,application/pdf"
          label="تصاویر و مستندات"
          hint={`حداکثر ${toPersianDigits(MAX_EVIDENCE)} فایل (JPG، PNG، WebP یا PDF). فقط شما، فروشنده و داور می‌توانند آن‌ها را ببینند.`}
        />
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">با ثبت اختلاف، مبلغ این مرسوله در کیف پول فروشنده مسدود می‌شود تا فروشنده پاسخ دهد یا داور تصمیم بگیرد.</p>
        <FormError message={localError ?? file.error?.message} />
      </form>
    </Modal>
  );
}
