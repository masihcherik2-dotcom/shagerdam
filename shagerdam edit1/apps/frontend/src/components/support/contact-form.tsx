'use client';

import { CheckCircle2, Send } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { apiPost } from '@/lib/api/client';
import { ApiError } from '@/lib/api/errors';
import type { ContactMessageInput, ContactMessageReceipt } from '@/lib/api/types';
import { CONTACT_FORM_LIMITS, CONTACT_TOPICS, EMPTY_CONTACT_FORM, toContactPayload, validateContactForm, type ContactFormErrors, type ContactFormValues } from '@/lib/contact-form';
import { toPersianDigits } from '@/lib/format';
import { CONTACT_TOPIC_LABELS } from '@/lib/labels';

/**
 * Public contact form → `POST /support/contact-messages` (stored in the
 * database and worked by the support team in /admin/support). A signed-in
 * user's name and mobile are prefilled and the message is linked to the account.
 */
export function ContactForm() {
  const { user } = useSession();
  const [values, setValues] = useState<ContactFormValues>(() => ({
    ...EMPTY_CONTACT_FORM,
    fullName: user?.fullName ?? '',
    mobile: user?.mobile ? user.mobile.replace(/^\+98/, '0') : '',
    email: user?.email ?? '',
  }));
  const [errors, setErrors] = useState<ContactFormErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [receipt, setReceipt] = useState<ContactMessageReceipt | null>(null);

  const set = <K extends keyof ContactFormValues>(key: K, value: ContactFormValues[K]): void => {
    setValues((current) => ({ ...current, [key]: value }));
    if (errors[key]) setErrors((current) => ({ ...current, [key]: undefined }));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const found = validateContactForm(values);
    setErrors(found);
    setSubmitError(null);
    if (Object.keys(found).length > 0) return;
    setSubmitting(true);
    try {
      setReceipt(await apiPost<ContactMessageReceipt, ContactMessageInput>('/support/contact-messages', toContactPayload(values)));
      setValues({ ...EMPTY_CONTACT_FORM, fullName: values.fullName, mobile: values.mobile, email: values.email });
    } catch (error) {
      setSubmitError(error instanceof ApiError ? error.message : 'ارسال پیام ممکن نشد؛ دوباره تلاش کنید.');
    } finally {
      setSubmitting(false);
    }
  };

  if (receipt) {
    return (
      <div role="status" className="flex flex-col items-center gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 text-center">
        <CheckCircle2 className="size-10 text-emerald-600" aria-hidden="true" />
        <p className="font-bold text-emerald-900">پیام شما ثبت شد</p>
        <p className="text-sm leading-7 text-emerald-800">
          کد پیگیری: <strong dir="ltr" className="font-mono">{receipt.reference}</strong>
          <br />
          کارشناسان پشتیبانی از طریق شمارهٔ موبایل واردشده با شما تماس می‌گیرند.
        </p>
        <Button variant="secondary" onClick={() => setReceipt(null)}>
          ارسال پیام دیگر
        </Button>
      </div>
    );
  }

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4" aria-label="فرم تماس با پشتیبانی">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="نام و نام خانوادگی" required error={errors.fullName}>
          {(id, describedBy) => <Input id={id} aria-describedby={describedBy} aria-invalid={Boolean(errors.fullName)} autoComplete="name" maxLength={CONTACT_FORM_LIMITS.fullName.max} value={values.fullName} onChange={(e) => set('fullName', e.target.value)} className="h-11" />}
        </Field>
        <Field label="شمارهٔ موبایل" required error={errors.mobile}>
          {(id, describedBy) => <Input id={id} aria-describedby={describedBy} aria-invalid={Boolean(errors.mobile)} inputMode="tel" autoComplete="tel" dir="ltr" placeholder="09121234567" value={values.mobile} onChange={(e) => set('mobile', e.target.value)} className="h-11 text-left" />}
        </Field>
        <Field label="ایمیل" hint="اختیاری" error={errors.email}>
          {(id, describedBy) => <Input id={id} aria-describedby={describedBy} aria-invalid={Boolean(errors.email)} type="email" autoComplete="email" dir="ltr" value={values.email} onChange={(e) => set('email', e.target.value)} className="h-11 text-left" />}
        </Field>
        <Field label="موضوع" required error={errors.topic}>
          {(id, describedBy) => (
            <Select id={id} aria-describedby={describedBy} aria-invalid={Boolean(errors.topic)} value={values.topic} onChange={(e) => set('topic', e.target.value as ContactFormValues['topic'])} className="h-11">
              <option value="">انتخاب کنید…</option>
              {CONTACT_TOPICS.map((topic) => (
                <option key={topic} value={topic}>
                  {CONTACT_TOPIC_LABELS[topic]}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>
      <Field label="عنوان" required error={errors.subject}>
        {(id, describedBy) => <Input id={id} aria-describedby={describedBy} aria-invalid={Boolean(errors.subject)} maxLength={CONTACT_FORM_LIMITS.subject.max} placeholder="مثلاً: پیگیری سفارش ۱۴۰۵۰۷…" value={values.subject} onChange={(e) => set('subject', e.target.value)} className="h-11" />}
      </Field>
      <Field label="متن پیام" required error={errors.message} hint={`${toPersianDigits(values.message.trim().length)} از ${toPersianDigits(CONTACT_FORM_LIMITS.message.max)} نویسه — شمارهٔ سفارش را در صورت وجود ذکر کنید.`}>
        {(id, describedBy) => <Textarea id={id} aria-describedby={describedBy} aria-invalid={Boolean(errors.message)} rows={6} maxLength={CONTACT_FORM_LIMITS.message.max} value={values.message} onChange={(e) => set('message', e.target.value)} />}
      </Field>
      {/* Honeypot: invisible to people and screen readers, tempting to bots. */}
      <div aria-hidden="true" className="pointer-events-none fixed -left-[10000px] top-0 size-px overflow-hidden opacity-0">
        <label htmlFor="contact-website">وب‌سایت</label>
        <input id="contact-website" name="website" tabIndex={-1} autoComplete="off" value={values.website} onChange={(e) => set('website', e.target.value)} />
      </div>
      <FormError message={submitError} />
      <Button type="submit" loading={submitting} icon={<Send className="size-4" />} className="self-start">
        ارسال پیام
      </Button>
    </form>
  );
}
