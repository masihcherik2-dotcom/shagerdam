import { FileText, Paperclip } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card, Money, StatusBadge } from '@/components/ui/misc';
import type { Dispute, DisputeEvidence } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { DISPUTE_EVENT_LABELS, DISPUTE_REASON_LABELS, DISPUTE_STATUS, SUB_ORDER_STATUS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const UPLOADER_LABEL: Record<DisputeEvidence['uploadedBy'], string> = { CUSTOMER: 'خریدار', VENDOR: 'فروشنده', STAFF: 'داور' };
const ACTOR_LABEL: Record<string, string> = { CUSTOMER: 'خریدار', VENDOR: 'فروشنده', SYSTEM: 'سیستم' };

/** Private evidence files are served by /api/v1/media/documents/:id/download through the BFF (session cookie). */
export function EvidenceList({ evidence }: { evidence: DisputeEvidence[] }) {
  if (evidence.length === 0) return <p className="text-sm text-slate-500">مستندی بارگذاری نشده است.</p>;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {evidence.map((item) => (
        <li key={item.id}>
          <a href={item.fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:border-brand-300 hover:bg-brand-50">
            {item.fileType?.startsWith('image/') ? <Paperclip className="size-4 text-brand-600" /> : <FileText className="size-4 text-brand-600" />}
            <span className="flex-1 truncate">{item.caption ?? (item.fileType?.startsWith('image/') ? 'تصویر' : 'فایل')}</span>
            <span className="text-xs text-slate-500">
              {UPLOADER_LABEL[item.uploadedBy]} · {formatDateTime(item.createdAt)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Case summary, both sides' statements, evidence and timeline — shared by customer, vendor and admin views. */
export function DisputeView({ dispute, extra }: { dispute: Dispute; extra?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="شرح اختلاف" action={<StatusBadge value={dispute.status} map={DISPUTE_STATUS} />}>
        <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-slate-500">علت</dt>
            <dd className="font-medium">{DISPUTE_REASON_LABELS[dispute.reason]}</dd>
          </div>
          <div>
            <dt className="text-slate-500">مرسوله</dt>
            <dd dir="ltr" className="text-end font-mono sm:text-start">
              {dispute.package.subOrderNumber}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">فروشگاه</dt>
            <dd>{dispute.package.storeName}</dd>
          </div>
          <div>
            <dt className="text-slate-500">مبلغ مرسوله</dt>
            <dd>
              <Money rials={dispute.package.itemsSubtotal} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">وضعیت مرسوله</dt>
            <dd>
              <StatusBadge value={dispute.package.status} map={SUB_ORDER_STATUS} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">ثبت</dt>
            <dd>{formatDateTime(dispute.createdAt)}</dd>
          </div>
        </dl>
        <p className="whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm leading-7">{dispute.description}</p>
      </Card>

      {dispute.vendorResponse ? (
        <Card title={dispute.vendorResponse.action === 'ACCEPT_RETURN' ? 'پاسخ فروشنده: پذیرش مرجوعی' : 'دفاعیهٔ فروشنده'}>
          <p className="whitespace-pre-line text-sm leading-7">{dispute.vendorResponse.defenseNotes}</p>
          <p className="mt-2 text-xs text-slate-500">{formatDateTime(dispute.vendorResponse.respondedAt)}</p>
        </Card>
      ) : null}

      {dispute.resolution ? (
        <Card title="نتیجه">
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge value={dispute.resolution.outcome} map={DISPUTE_STATUS} />
              <span className="text-slate-500">
                {dispute.resolution.decidedBy === 'STAFF' ? 'رأی داور' : 'پذیرش فروشنده'} — {formatDateTime(dispute.resolution.resolvedAt)}
              </span>
            </div>
            {dispute.resolution.refundAmount ? (
              <span>
                مبلغ بازپرداخت: <Money rials={dispute.resolution.refundAmount} className="font-bold" />
              </span>
            ) : null}
            {dispute.resolution.notes ? <p className="whitespace-pre-line leading-7">{dispute.resolution.notes}</p> : null}
          </div>
        </Card>
      ) : null}

      {extra}

      <Card title="مستندات">
        <EvidenceList evidence={dispute.evidence} />
      </Card>

      <Card title="روند رسیدگی">
        <ol className="relative flex flex-col gap-4 border-s-2 border-slate-100 ps-5">
          {dispute.timeline.map((event, index) => (
            <li key={`${event.createdAt}-${index}`} className="relative text-sm">
              <span className="absolute -start-[27px] top-1 size-3 rounded-full border-2 border-white bg-brand-500" />
              <div className="font-medium">{DISPUTE_EVENT_LABELS[event.type]}</div>
              <div className="text-xs text-slate-500">
                {ACTOR_LABEL[event.actorRole] ?? `کارشناس ${PLATFORM_NAME}`} · {formatDateTime(event.createdAt)}
              </div>
              {event.note ? <div className="mt-1 whitespace-pre-line text-xs text-slate-600">{event.note}</div> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
