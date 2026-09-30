import { describe, expect, it } from 'vitest';

import { EMPTY_CONTACT_FORM, toContactPayload, validateContactForm, type ContactFormValues } from './contact-form';

const valid: ContactFormValues = { fullName: 'علی رضایی', mobile: '۰۹۱۲ ۱۲۳ ۴۵۶۷', email: '', topic: 'ORDER', subject: 'پیگیری سفارش', message: 'سفارش من هنوز ارسال نشده است.', website: '' };

describe('contact form', () => {
  it('accepts a complete form with Persian digits', () => {
    expect(validateContactForm(valid)).toEqual({});
  });

  it('reports every missing field on an empty form', () => {
    expect(Object.keys(validateContactForm(EMPTY_CONTACT_FORM)).sort()).toEqual(['fullName', 'message', 'mobile', 'subject', 'topic']);
  });

  it('checks mobile, email and lengths', () => {
    expect(validateContactForm({ ...valid, mobile: '021-91000000' }).mobile).toBeDefined();
    expect(validateContactForm({ ...valid, email: 'bad@' }).email).toBeDefined();
    expect(validateContactForm({ ...valid, message: 'کوتاه' }).message).toBeDefined();
    expect(validateContactForm({ ...valid, message: 'x'.repeat(2001) }).message).toBeDefined();
    expect(validateContactForm({ ...valid, subject: 'x'.repeat(151) }).subject).toBeDefined();
  });

  it('builds the payload: trimmed, Latin digits, optional fields omitted', () => {
    expect(toContactPayload({ ...valid, fullName: '  علی رضایی ' })).toEqual({ fullName: 'علی رضایی', mobile: '09121234567', topic: 'ORDER', subject: 'پیگیری سفارش', message: 'سفارش من هنوز ارسال نشده است.' });
    expect(toContactPayload({ ...valid, email: ' a@b.ir ', website: 'x' })).toMatchObject({ email: 'a@b.ir', website: 'x' });
  });
});
