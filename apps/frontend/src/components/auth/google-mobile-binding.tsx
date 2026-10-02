'use client';

import { CheckCircle2, ShieldCheck, Smartphone } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { GoogleIcon } from '@/components/auth/google-sign-in-button';
import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/states';
import { sessionClient } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AuthUser, OtpRequestResponse } from '@/lib/api/types';
import { homeForRole, safeNextPath } from '@/lib/auth/access';
import { loginErrorPath } from '@/lib/auth/google-session';
import { formatMobile, toLatinDigits, toPersianDigits } from '@/lib/format';
import { IRAN_MOBILE_PATTERN } from '@/lib/iran';

interface SignupState {
  name: string | null;
  email: string | null;
  picture: string | null;
  next: string | null;
  mobile: string | null;
  expiresInSeconds: number;
}

type Phase = 'loading' | 'expired' | 'mobile' | 'code';

/**
 * Second step of "Sign in with Google" for an identity that is not linked yet
 * (architect's decision: the mobile number is verified by SMS after Google).
 * The Google profile is held server-side behind an httpOnly ticket cookie;
 * after the code is verified the backend links Google to the account of that
 * number — or creates the account — and the user continues to the page they
 * came from.
 */
export function GoogleMobileBinding() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useSession();
  const [phase, setPhase] = useState<Phase>('loading');
  const [profile, setProfile] = useState<SignupState | null>(null);
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<OtpRequestResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [avatarBroken, setAvatarBroken] = useState(false);

  useEffect(() => {
    sessionClient
      .get<SignupState>('/google/signup')
      .then(({ data }) => {
        setProfile(data);
        setPhase('mobile');
      })
      .catch(() => setPhase('expired'));
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  const next = safeNextPath(profile?.next ?? params.get('next'));
  const normalisedMobile = toLatinDigits(mobile).replace(/[\s-]/g, '');

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    if (!IRAN_MOBILE_PATTERN.test(normalisedMobile)) {
      setError('شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<OtpRequestResponse>('/google/signup/otp', { mobile: normalisedMobile });
      setSent(data);
      setSecondsLeft(Math.min(data.expiresInSeconds, 120));
      setCode('');
      setPhase('code');
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.code === 'GOOGLE_SIGNUP_EXPIRED') setPhase('expired');
      setError(apiError.message);
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
      const { data } = await sessionClient.post<{ user: AuthUser; next: string | null }>('/google/signup/verify', { mobile: normalisedMobile, code: normalisedCode });
      await refresh();
      router.replace(safeNextPath(data.next) ?? next ?? homeForRole(data.user.role));
      router.refresh();
    } catch (caught) {
      const apiError = toApiError(caught);
      if (apiError.code === 'GOOGLE_SIGNUP_EXPIRED') setPhase('expired');
      setError(apiError.message);
      setBusy(false);
    }
  }

  if (phase === 'loading') {
    return <Skeleton className="h-96" />;
  }

  if (phase === 'expired' || profile === null) {
    return (
      <div className="rounded-3xl border border-slate-200 bg-white p-6 text-center shadow-sm md:p-8" data-testid="google-binding-expired">
        <GoogleIcon className="mx-auto mb-4 size-10" />
        <h1 className="mb-2 text-lg font-black text-slate-900">مهلت تکمیل ورود با گوگل تمام شده است</h1>
        <p className="mb-6 text-sm leading-7 text-slate-500">برای امنیت حساب شما، این مرحله فقط ۱۵ دقیقه معتبر است. دوباره از صفحهٔ ورود روی دکمهٔ گوگل بزنید.</p>
        <Link href={loginErrorPath('GOOGLE_SIGNUP_EXPIRED', next)} className="inline-flex h-11 items-center justify-center rounded-xl bg-brand-600 px-6 text-sm font-bold text-white hover:bg-brand-700">
          بازگشت به صفحهٔ ورود
        </Link>
      </div>
    );
  }

  const initial = (profile.name ?? profile.email ?? '؟').trim().charAt(0);

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8" data-testid="google-binding">
      <ol className="mb-6 flex items-center gap-2 text-xs font-medium" aria-label="مراحل ورود با گوگل">
        <li className="flex items-center gap-1.5 text-emerald-700">
          <CheckCircle2 className="size-4" aria-hidden="true" /> حساب گوگل
        </li>
        <li className="h-px flex-1 bg-slate-200" aria-hidden="true" />
        <li className="flex items-center gap-1.5 text-brand-700" aria-current="step">
          <Smartphone className="size-4" aria-hidden="true" /> تأیید موبایل
        </li>
        <li className="h-px flex-1 bg-slate-200" aria-hidden="true" />
        <li className="flex items-center gap-1.5 text-slate-400">
          <ShieldCheck className="size-4" aria-hidden="true" /> ورود
        </li>
      </ol>

      <div className="mb-6 flex items-center gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        {profile.picture && !avatarBroken ? (
          // eslint-disable-next-line @next/next/no-img-element -- Google profile picture (external host, shown once).
          <img src={profile.picture} alt="" referrerPolicy="no-referrer" className="size-14 shrink-0 rounded-full border border-white object-cover shadow" onError={() => setAvatarBroken(true)} />
        ) : (
          <span className="flex size-14 shrink-0 items-center justify-center rounded-full bg-brand-100 text-xl font-black text-brand-700" aria-hidden="true">
            {initial}
          </span>
        )}
        <div className="min-w-0">
          <p className="truncate text-base font-bold text-slate-900" data-testid="google-binding-name">{profile.name ?? 'کاربر گوگل'}</p>
          {profile.email ? (
            <p className="truncate text-sm text-slate-500" dir="ltr">
              {profile.email}
            </p>
          ) : null}
          <p className="mt-1 flex items-center gap-1 text-xs text-emerald-700">
            <GoogleIcon className="size-3.5" /> حساب گوگل تأیید شد
          </p>
        </div>
      </div>

      <h1 className="mb-1 text-lg font-black text-slate-900">یک قدم تا پایان: تأیید شمارهٔ موبایل</h1>
      <p className="mb-6 text-sm leading-7 text-slate-500">
        برای ارسال اطلاعات سفارش و امنیت حساب، شمارهٔ موبایل خود را تأیید کنید. اگر قبلاً با این شماره حساب ساخته‌اید، حساب گوگل به همان حساب متصل می‌شود.
      </p>

      {phase === 'mobile' ? (
        <form onSubmit={(event) => void requestCode(event)} className="flex flex-col gap-4" noValidate>
          <Field label="شمارهٔ موبایل">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="tel" autoComplete="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="09121234567" autoFocus />}
          </Field>
          <FormError message={error} />
          <Button type="submit" size="lg" loading={busy}>
            ارسال کد تأیید
          </Button>
        </form>
      ) : (
        <form onSubmit={(event) => void verify(event)} className="flex flex-col gap-4" noValidate>
          <p className="text-sm text-slate-600">
            کد ارسال‌شده به <b dir="ltr">{formatMobile(normalisedMobile)}</b> را وارد کنید.{' '}
            <button
              type="button"
              className="text-brand-700 hover:underline"
              onClick={() => {
                setPhase('mobile');
                setSent(null);
                setError(null);
              }}
            >
              تغییر شماره
            </button>
          </p>
          <Field label="کد تأیید">
            {(id) => <Input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} className="text-center text-lg tracking-[0.5em]" autoFocus />}
          </Field>
          <FormError message={error} />
          <Button type="submit" size="lg" loading={busy}>
            تأیید و ورود
          </Button>
          <button type="button" disabled={secondsLeft > 0 || busy || sent === null} onClick={() => void requestCode()} className="text-sm text-brand-700 disabled:text-slate-400">
            {secondsLeft > 0 ? `ارسال دوباره تا ${toPersianDigits(secondsLeft)} ثانیهٔ دیگر` : 'ارسال دوبارهٔ کد'}
          </button>
        </form>
      )}

      <p className="mt-6 text-center text-xs text-slate-400">
        <Link href={next ? `/login?next=${encodeURIComponent(next)}` : '/login'} className="hover:text-slate-600 hover:underline">
          انصراف و ورود به روش دیگر
        </Link>
      </p>
    </div>
  );
}
