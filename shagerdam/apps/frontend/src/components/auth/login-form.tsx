'use client';

import { FlaskConical, KeyRound, Smartphone } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { apiGet, sessionClient } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AuthUser, OtpRequestResponse } from '@/lib/api/types';
import { homeForRole, safeNextPath } from '@/lib/auth/access';
import { formatMobile, toLatinDigits, toPersianDigits } from '@/lib/format';
import { IRAN_MOBILE_PATTERN } from '@/lib/iran';
import { PLATFORM_NAME } from '@/lib/brand';

type Mode = 'otp' | 'password';

/**
 * Sign-in: mobile + one-time code (customers, sign-up on first login) or
 * email/mobile + password (staff and vendors). Both post to the BFF, which
 * stores the tokens in httpOnly cookies and merges the guest cart.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useSession();
  const next = safeNextPath(params.get('next'));

  const [mode, setMode] = useState<Mode>('otp');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<OtpRequestResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSms, setTestSms] = useState(false);

  useEffect(() => {
    apiGet<{ provider: string; isTestProvider: boolean }>('/auth/sms-provider')
      .then((info) => setTestSms(info.isTestProvider))
      .catch(() => setTestSms(false));
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function finish(user: AuthUser) {
    await refresh();
    router.replace(next ?? homeForRole(user.role));
    router.refresh();
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    const normalised = toLatinDigits(mobile).replace(/[\s-]/g, '');
    if (!IRAN_MOBILE_PATTERN.test(normalised)) {
      setError('شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<OtpRequestResponse>('/otp', { mobile: normalised });
      setSent(data);
      setSecondsLeft(Math.min(data.expiresInSeconds, 120));
      setCode('');
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    const normalisedCode = toLatinDigits(code).trim();
    if (!/^\d{4,8}$/.test(normalisedCode)) {
      setError('کد تأیید را کامل وارد کنید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<{ user: AuthUser }>('/verify', { mobile: toLatinDigits(mobile).replace(/[\s-]/g, ''), code: normalisedCode });
      await finish(data.user);
    } catch (caught) {
      setError(toApiError(caught).message);
      setBusy(false);
    }
  }

  async function passwordLogin(event: FormEvent) {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError('شناسه و رمز عبور را وارد کنید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<{ user: AuthUser }>('/password', { identifier: toLatinDigits(identifier.trim()), password });
      await finish(data.user);
    } catch (caught) {
      setError(toApiError(caught).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      <h1 className="mb-1 text-xl font-black text-slate-900">ورود به {PLATFORM_NAME}</h1>
      <p className="mb-6 text-sm text-slate-500">{next ? 'برای ادامه وارد حساب خود شوید.' : 'خرید، پیگیری سفارش و مدیریت فروشگاه'}</p>

      <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
        {(
          [
            { id: 'otp', label: 'ورود با کد یکبارمصرف', icon: Smartphone },
            { id: 'password', label: 'ورود با رمز عبور', icon: KeyRound },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            onClick={() => {
              setMode(tab.id);
              setError(null);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium sm:text-sm ${mode === tab.id ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}
          >
            <tab.icon className="size-4" /> {tab.label}
          </button>
        ))}
      </div>

      {mode === 'otp' ? (
        !sent ? (
          <form onSubmit={(event) => void requestCode(event)} className="flex flex-col gap-4" noValidate>
            <Field label="شمارهٔ موبایل" hint="اگر حساب ندارید، با همین شماره ساخته می‌شود.">
              {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="tel" autoComplete="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="09121234567" autoFocus />}
            </Field>
            <FormError message={error} />
            <Button type="submit" size="lg" loading={busy}>
              دریافت کد تأیید
            </Button>
          </form>
        ) : (
          <form onSubmit={(event) => void verify(event)} className="flex flex-col gap-4" noValidate>
            <p className="text-sm text-slate-600">
              کد ارسال‌شده به <b dir="ltr">{formatMobile(toLatinDigits(mobile))}</b> را وارد کنید.{' '}
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setSent(null)}>
                تغییر شماره
              </button>
            </p>
            <Field label="کد تأیید">
              {(id) => <Input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} className="text-center text-lg tracking-[0.5em]" autoFocus />}
            </Field>
            <FormError message={error} />
            <Button type="submit" size="lg" loading={busy}>
              ورود
            </Button>
            <button type="button" disabled={secondsLeft > 0 || busy} onClick={() => void requestCode()} className="text-sm text-brand-700 disabled:text-slate-400">
              {secondsLeft > 0 ? `ارسال دوباره تا ${toPersianDigits(secondsLeft)} ثانیهٔ دیگر` : 'ارسال دوبارهٔ کد'}
            </button>
          </form>
        )
      ) : (
        <form onSubmit={(event) => void passwordLogin(event)} className="flex flex-col gap-4" noValidate>
          <Field label="ایمیل یا شمارهٔ موبایل">
            {(id) => <Input id={id} dir="ltr" autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoFocus />}
          </Field>
          <Field label="رمز عبور">
            {(id) => <Input id={id} type="password" dir="ltr" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />}
          </Field>
          <FormError message={error} />
          <Button type="submit" size="lg" loading={busy}>
            ورود
          </Button>
          <p className="text-xs leading-5 text-slate-500">ورود با رمز برای کارکنان و فروشندگانی است که رمز عبور تعیین کرده‌اند.</p>
        </form>
      )}

      {testSms && mode === 'otp' ? (
        <p className="mt-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          محیط توسعه: سرویس پیامک آزمایشی (Sandbox) فعال است و پیامک واقعی ارسال نمی‌شود؛ کد در لاگ سرور ثبت می‌شود.
        </p>
      ) : null}
    </div>
  );
}
