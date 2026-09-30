'use client';

import { Inbox, MessageSquareText, Save } from 'lucide-react';
import { useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, Select, Textarea } from '@/components/ui/field';
import { DefinitionList, PageHeader, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AdminContactMessage, AdminContactMessagePage, ContactMessageStatus, ContactMessageTopic } from '@/lib/api/types';
import { CONTACT_TOPICS } from '@/lib/contact-form';
import { formatDateTime, formatMobile, toPersianDigits } from '@/lib/format';
import { useApi } from '@/lib/hooks/use-api';
import { CONTACT_STATUS, CONTACT_TOPIC_LABELS } from '@/lib/labels';

const STATUSES: readonly ContactMessageStatus[] = ['NEW', 'IN_PROGRESS', 'RESOLVED'];
const STAFF_NOTE_MAX = 2000;

function MessageDialog({ message, onClose, onSaved }: { message: AdminContactMessage; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState<ContactMessageStatus>(message.status);
  const [note, setNote] = useState(message.staffNote ?? '');
  const [saving, setSaving] = useState(false);
  const dirty = status !== message.status || note.trim() !== (message.staffNote ?? '');

  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await apiPatch<AdminContactMessage, { status?: ContactMessageStatus; staffNote?: string | null }>(`/admin/support/contact-messages/${message.id}`, {
        ...(status !== message.status ? { status } : {}),
        ...(note.trim() !== (message.staffNote ?? '') ? { staffNote: note.trim() || null } : {}),
      });
      toast.success('پیام به‌روزرسانی شد.');
      onSaved();
    } catch (error) {
      toast.error(toApiError(error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      size="lg"
      title={`پیام ${message.reference}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            بستن
          </Button>
          <Button loading={saving} disabled={!dirty} icon={<Save className="size-4" />} onClick={() => void save()}>
            ذخیره
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <DefinitionList
          items={[
            { label: 'فرستنده', value: `${message.fullName}${message.sender ? ' (کاربر ثبت‌نام‌شده)' : ''}` },
            {
              label: 'موبایل',
              value: (
                <a href={`tel:${message.mobile}`} dir="ltr" className="text-brand-700 hover:underline">
                  {formatMobile(message.mobile)}
                </a>
              ),
            },
            ...(message.email ? [{ label: 'ایمیل', value: <span dir="ltr">{message.email}</span> }] : []),
            { label: 'موضوع', value: CONTACT_TOPIC_LABELS[message.topic] },
            { label: 'زمان ارسال', value: formatDateTime(message.createdAt) },
            ...(message.handledBy ? [{ label: 'آخرین رسیدگی', value: `${message.handledBy.fullName} — ${formatDateTime(message.handledAt)}` }] : []),
          ]}
        />
        <div className="rounded-xl bg-slate-50 p-4">
          <p className="mb-2 font-bold text-slate-900">{message.subject}</p>
          <p className="whitespace-pre-line text-sm leading-7 text-slate-700">{message.message}</p>
        </div>
        <Field label="وضعیت">
          {(id) => (
            <Select id={id} value={status} onChange={(event) => setStatus(event.target.value as ContactMessageStatus)} className="h-11">
              {STATUSES.map((value) => (
                <option key={value} value={value}>
                  {CONTACT_STATUS[value].label}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="یادداشت داخلی پشتیبانی" hint={`فقط برای کارکنان — ${toPersianDigits(note.length)} از ${toPersianDigits(STAFF_NOTE_MAX)} نویسه`}>
          {(id, describedBy) => <Textarea id={id} aria-describedby={describedBy} rows={4} maxLength={STAFF_NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} />}
        </Field>
      </div>
    </Modal>
  );
}

export default function AdminSupportPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ContactMessageStatus | ''>('NEW');
  const [topic, setTopic] = useState<ContactMessageTopic | ''>('');
  const [open, setOpen] = useState<AdminContactMessage | null>(null);
  const state = useApi<AdminContactMessagePage>('/admin/support/contact-messages', { page, pageSize: 20, status: status || undefined, topic: topic || undefined });
  const counts = state.data?.counts;

  return (
    <>
      <PageHeader title="پیام‌های تماس" description="پیام‌های فرم «تماس با ما»؛ با فرستنده تماس بگیرید و وضعیت رسیدگی را ثبت کنید." />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {(['', ...STATUSES] as const).map((value) => (
          <button
            key={value || 'all'}
            type="button"
            aria-pressed={status === value}
            onClick={() => {
              setStatus(value);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-xs ${status === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
          >
            {value ? CONTACT_STATUS[value].label : 'همه'}
            {value && counts ? ` (${toPersianDigits(counts[value])})` : ''}
          </button>
        ))}
        <Select
          aria-label="فیلتر موضوع"
          value={topic}
          onChange={(event) => {
            setTopic(event.target.value as ContactMessageTopic | '');
            setPage(1);
          }}
          className="ms-auto h-9 w-auto min-w-44"
        >
          <option value="">همهٔ موضوع‌ها</option>
          {CONTACT_TOPICS.map((value) => (
            <option key={value} value={value}>
              {CONTACT_TOPIC_LABELS[value]}
            </option>
          ))}
        </Select>
      </div>

      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Inbox className="size-8" />} title="پیامی نیست" description="پیامی با این فیلتر وجود ندارد." />}>
        {(data) => (
          <>
            <Table head={['کد', 'فرستنده', 'موضوع', 'عنوان', 'وضعیت', 'زمان', '']}>
              {data.items.map((message) => (
                <tr key={message.id} className="hover:bg-slate-50">
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {message.reference}
                    </span>
                  </Td>
                  <Td>
                    <div>{message.fullName}</div>
                    <div dir="ltr" className="text-end text-xs text-slate-500">
                      {formatMobile(message.mobile)}
                    </div>
                  </Td>
                  <Td>{CONTACT_TOPIC_LABELS[message.topic]}</Td>
                  <Td className="max-w-64 truncate">{message.subject}</Td>
                  <Td>
                    <StatusBadge value={message.status} map={CONTACT_STATUS} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(message.createdAt)}</Td>
                  <Td>
                    <Button variant="ghost" size="sm" icon={<MessageSquareText className="size-4" />} onClick={() => setOpen(message)}>
                      مشاهده
                    </Button>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>

      {open ? (
        <MessageDialog
          message={open}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null);
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}
