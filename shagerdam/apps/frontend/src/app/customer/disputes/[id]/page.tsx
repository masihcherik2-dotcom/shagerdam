'use client';

import { CircleSlash } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { DisputeView } from '@/components/disputes/dispute-view';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Textarea } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { Dispute, DisputeActionResult } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';

const CANCELLABLE = ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION'];

export default function CustomerDisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const state = useApi<Dispute>(`/customer/disputes/${id}`);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useMutation((body: { reason?: string }) => apiPost<DisputeActionResult>(`/customer/disputes/${id}/cancel`, body));

  async function doCancel() {
    const text = reason.trim();
    const result = await cancel.run(text ? { reason: text } : {});
    if (result) {
      state.setData(result.dispute);
      setOpen(false);
      toast.success('اختلاف پس گرفته شد.');
    }
  }

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(dispute) => (
        <>
          <PageHeader
            title="جزئیات اختلاف"
            description={`سفارش ${dispute.package.orderNumber}`}
            action={
              <div className="flex gap-2">
                <LinkButton href="/customer/disputes" variant="secondary">
                  بازگشت
                </LinkButton>
                {CANCELLABLE.includes(dispute.status) ? (
                  <Button variant="danger" icon={<CircleSlash className="size-4" />} onClick={() => setOpen(true)}>
                    پس گرفتن اختلاف
                  </Button>
                ) : null}
              </div>
            }
          />
          <DisputeView dispute={dispute} />
          <Modal
            open={open}
            title="پس گرفتن اختلاف"
            onClose={() => setOpen(false)}
            footer={
              <>
                <Button variant="danger" loading={cancel.pending} onClick={() => void doCancel()}>
                  پس گرفته شود
                </Button>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  انصراف
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <p className="text-sm leading-7">با پس گرفتن اختلاف، مبلغ مسدودشدهٔ فروشنده آزاد می‌شود. در صورت نیاز می‌توانید بعداً دوباره اختلاف ثبت کنید.</p>
              <Field label="توضیح (اختیاری)">{(fieldId) => <Textarea id={fieldId} rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
              <FormError message={cancel.error?.message} />
            </div>
          </Modal>
        </>
      )}
    </AsyncView>
  );
}
