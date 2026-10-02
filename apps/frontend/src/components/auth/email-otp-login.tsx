'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { sessionClient } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AuthUser, OtpRequestResponse } from '@/lib/api/types';
import { formatMobile, toLatinDigits, toPersianDigits } from '@/lib/format';
import { IRAN_MOBILE_PATTERN } from '@/lib/iran';

type Step = 'email' | 'code' | 'mobile' | 'mobileCode';

/** Same shape check the backend applies (it re-validates and normalises). */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Sign-in / sign-up with a code sent by e-mail.
 *
 * 1. e-mail → code by e-mail;
 * 2. the code signs in directly when the address is verified on an account;
 * 3. otherwise (new address, or one only typed into a profile) the visitor
 *    confirms a mobile number once by SMS: the e-mail is attached to the
 *    account of that number, or a customer account is created.
 *
 * The signup ticket of step 3 lives in an httpOnly cookie set by the BFF.
 */
export function EmailOtpLogin({ onSignedIn }: { onSignedIn: (user: AuthUser) => Promise<void> }) {
  const [step, setStep] = useState<Step>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [mobile, setMobile] = useState('');
  const [mobileCode, setMobileCode] = useState('');
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const normalisedEmail = (): string => email.trim().toLowerCase();
  const normalisedMobile = (): string => toLatinDigits(mobile).replace(/[\s-]/g, '');

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      setBusy(false);
    } catch (caught) {
      const apiError = toApiError(caught);
      setError(apiError.message);
      setBusy(false);
      // The mobile step outlived its ticket: start over from the e-mail.
      if (apiError.code === 'EMAIL_OTP_SIGNUP_EXPIRED') {
        setStep('email');
        setCode('');
        setMobileCode('');
      }
    }
  }

  function requestEmailCode(event?: FormEvent) {
    event?.preventDefault();
    if (!EMAIL_PATTERN.test(normalisedEmail())) {
      setError('ایمیل معتبر نیست (مثال: name@gmail.com).');
      return;
    }
    void run(async () => {
      const { data } = await sessionClient.post<OtpRequestResponse>('/email-otp/request', { email: normalisedEmail() });
      setSecondsLeft(Math.min(data.expiresInSeconds, 120));
      setCode('');
      setStep('code');
    });
  }

  function verifyEmailCode(event: FormEvent) {
    event.preventDefault();
    const value = toLatinDigits(code).trim();
    if (!/^\d{4,8}$/.test(value)) {
      setError('کد ایمیل‌شده را کامل وارد کنید.');
      return;
    }
    void run(async () => {
      const { data } = await sessionClient.post<{ status: 'signed_in'; user: AuthUser } | { status: 'mobile_required'; email: string }>('/email-otp/verify', { email: normalisedEmail(), code: value });
      if (data.status === 'signed_in') {
        setBusy(true);
        await onSignedIn(data.user);
        return;
      }
      setSecondsLeft(0);
      setStep('mobile');
    });
  }

  function requestMobileCode(event?: FormEvent) {
    event?.preventDefault();
    if (!IRAN_MOBILE_PATTERN.test(normalisedMobile())) {
      setError('شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷).');
      return;
    }
    void run(async () => {
      const { data } = await sessionClient.post<OtpRequestResponse>('/email-otp/signup/otp', { mobile: normalisedMobile() });
      setSecondsLeft(Math.min(data.expiresInSeconds, 120));
      setMobileCode('');
      setStep('mobileCode');
    });
  }

  function verifyMobileCode(event: FormEvent) {
    event.preventDefault();
    const value = toLatinDigits(mobileCode).trim();
    if (!/^\d{4,8}$/.test(value)) {
      setError('کد پیامک‌شده را کامل وارد کنید.');
      return;
    }
    void run(async () => {
      const { data } = await sessionClient.post<{ user: AuthUser }>('/email-otp/signup/verify', { mobile: normalisedMobile(), code: value });
      setBusy(true);
      await onSignedIn(data.user);
    });
  }

  const resend = (onClick: () => void) => (
    <button type="button" disabled={secondsLeft > 0 || busy} onClick={onClick} className="text-sm text-brand-700 disabled:text-slate-400">
      {secondsLeft > 0 ? `ارسال دوباره تا ${toPersianDigits(secondsLeft)} ثانیهٔ دیگر` : 'ارسال دوبارهٔ کد'}
    </button>
  );

  if (step === 'email') {
    return (
      <form onSubmit={requestEmailCode} className="flex flex-col gap-4" noValidate data-testid="email-otp-form">
        <Field label="ایمیل" hint="کد ورود به این ایمیل فرستاده می‌شود. اگر حساب ندارید، پس از تأیید شمارهٔ موبایل ساخته می‌شود.">
          {(id, described) => <Input id={id} aria-describedby={described} type="email" dir="ltr" inputMode="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@gmail.com" autoFocus />}
        </Field>
        <FormError message={error} />
        <Button type="submit" size="lg" loading={busy}>
          ارسال کد به ایمیل
        </Button>
      </form>
    );
  }

  if (step === 'code') {
    return (
      <form onSubmit={verifyEmailCode} className="flex flex-col gap-4" noValidate>
        <p className="text-sm text-slate-600">
          کد ارسال‌شده به <b dir="ltr">{normalisedEmail()}</b> را وارد کنید. اگر ایمیل را نمی‌بینید، پوشهٔ Spam را هم بررسی کنید.{' '}
          <button type="button" className="text-brand-700 hover:underline" onClick={() => { setStep('email'); setError(null); }}>
            تغییر ایمیل
          </button>
        </p>
        <Field label="کد ایمیل‌شده">
          {(id) => <Input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} className="text-center text-lg tracking-[0.5em]" autoFocus />}
        </Field>
        <FormError message={error} />
        <Button type="submit" size="lg" loading={busy}>
          ادامه
        </Button>
        {resend(() => requestEmailCode())}
      </form>
    );
  }

  if (step === 'mobile') {
    return (
      <form onSubmit={requestMobileCode} className="flex flex-col gap-4" noValidate data-testid="email-otp-mobile">
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm leading-6 text-emerald-900">
          ایمیل <b dir="ltr">{normalisedEmail()}</b> تأیید شد. برای تکمیل ورود، یک بار شمارهٔ موبایل خود را تأیید کنید. اگر با این شماره حساب دارید، ایمیل به همان حساب اضافه می‌شود.
        </p>
        <Field label="شمارهٔ موبایل">
          {(id) => <Input id={id} dir="ltr" inputMode="tel" autoComplete="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="09121234567" autoFocus />}
        </Field>
        <FormError message={error} />
        <Button type="submit" size="lg" loading={busy}>
          دریافت کد پیامکی
        </Button>
      </form>
    );
  }

  return (
    <form onSubmit={verifyMobileCode} className="flex flex-col gap-4" noValidate>
      <p className="text-sm text-slate-600">
        کد پیامک‌شده به <b dir="ltr">{formatMobile(normalisedMobile())}</b> را وارد کنید.{' '}
        <button type="button" className="text-brand-700 hover:underline" onClick={() => { setStep('mobile'); setError(null); }}>
          تغییر شماره
        </button>
      </p>
      <Field label="کد پیامک‌شده">
        {(id) => <Input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={mobileCode} onChange={(event) => setMobileCode(event.target.value)} maxLength={8} className="text-center text-lg tracking-[0.5em]" autoFocus />}
      </Field>
      <FormError message={error} />
      <Button type="submit" size="lg" loading={busy}>
        ورود
      </Button>
      {resend(() => requestMobileCode())}
    </form>
  );
}
