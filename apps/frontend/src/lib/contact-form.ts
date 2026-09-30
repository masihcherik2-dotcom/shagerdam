import type { ContactMessageInput, ContactMessageTopic } from './api/types';
import { toLatinDigits } from './format';
import { IRAN_MOBILE_PATTERN } from './iran';

/** Same bounds as the backend (`contact-rules.ts` / DTO). */
export const CONTACT_FORM_LIMITS = {
  fullName: { min: 2, max: 120 },
  subject: { min: 3, max: 150 },
  message: { min: 10, max: 2000 },
} as const;

export const CONTACT_TOPICS: readonly ContactMessageTopic[] = ['ORDER', 'PAYMENT', 'BNPL', 'RETURN', 'VENDOR', 'TECHNICAL', 'OTHER'];

export interface ContactFormValues {
  fullName: string;
  mobile: string;
  email: string;
  topic: ContactMessageTopic | '';
  subject: string;
  message: string;
  /** Honeypot: hidden from people; bots fill it. */
  website: string;
}

export type ContactFormErrors = Partial<Record<keyof ContactFormValues, string>>;

export const EMPTY_CONTACT_FORM: ContactFormValues = { fullName: '', mobile: '', email: '', topic: '', subject: '', message: '', website: '' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateContactForm(values: ContactFormValues): ContactFormErrors {
  const errors: ContactFormErrors = {};
  const fullName = values.fullName.trim();
  const subject = values.subject.trim();
  const message = values.message.trim();
  const mobile = toLatinDigits(values.mobile).replace(/[\s()-]/g, '');

  if (fullName.length < CONTACT_FORM_LIMITS.fullName.min) errors.fullName = 'نام و نام خانوادگی را وارد کنید.';
  else if (fullName.length > CONTACT_FORM_LIMITS.fullName.max) errors.fullName = 'نام طولانی‌تر از حد مجاز است.';
  if (!IRAN_MOBILE_PATTERN.test(mobile)) errors.mobile = 'شمارهٔ موبایل معتبر وارد کنید (مثلاً ۰۹۱۲۱۲۳۴۵۶۷).';
  if (values.email.trim() !== '' && !EMAIL.test(values.email.trim())) errors.email = 'ایمیل معتبر نیست.';
  if (values.topic === '') errors.topic = 'موضوع را انتخاب کنید.';
  if (subject.length < CONTACT_FORM_LIMITS.subject.min) errors.subject = 'عنوان پیام را بنویسید.';
  else if (subject.length > CONTACT_FORM_LIMITS.subject.max) errors.subject = `عنوان حداکثر ${CONTACT_FORM_LIMITS.subject.max.toLocaleString('fa-IR')} نویسه است.`;
  if (message.length < CONTACT_FORM_LIMITS.message.min) errors.message = `متن پیام حداقل ${CONTACT_FORM_LIMITS.message.min.toLocaleString('fa-IR')} نویسه باشد.`;
  else if (message.length > CONTACT_FORM_LIMITS.message.max) errors.message = `متن پیام حداکثر ${CONTACT_FORM_LIMITS.message.max.toLocaleString('fa-IR')} نویسه است.`;
  return errors;
}

/** Request body; only called after validation passed. */
export function toContactPayload(values: ContactFormValues): ContactMessageInput {
  return {
    fullName: values.fullName.trim(),
    mobile: toLatinDigits(values.mobile).replace(/[\s()-]/g, ''),
    ...(values.email.trim() ? { email: values.email.trim() } : {}),
    topic: values.topic as ContactMessageTopic,
    subject: values.subject.trim(),
    message: values.message.trim(),
    ...(values.website ? { website: values.website } : {}),
  };
}
