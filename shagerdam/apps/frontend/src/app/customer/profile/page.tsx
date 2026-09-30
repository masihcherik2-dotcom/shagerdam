'use client';

import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { Card, DefinitionList, PageHeader, StatusBadge } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import type { Me, UpdateProfileInput } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDate, formatMobile, toLatinDigits } from '@/lib/format';
import { isValidNationalCode } from '@/lib/iran';
import { ROLE_LABELS, VENDOR_STATUS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CustomerProfilePage() {
  const state = useApi<Me>('/auth/me');
  return (
    <>
      <PageHeader title="پروفایل من" description="اطلاعات حساب کاربری و هویتی" />
      <AsyncView state={state} skeleton={<Skeleton className="h-96" />}>
        {(me) => <ProfileForm me={me} onSaved={state.setData} />}
      </AsyncView>
    </>
  );
}

function ProfileForm({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const toast = useToast();
  const { refresh } = useSession();
  const router = useRouter();

  // The BFF rotates the session when the account's role changed (store approved → VENDOR).
  async function enterVendorPanel() {
    await refresh();
    router.push('/vendor/dashboard');
    router.refresh();
  }
  const [fullName, setFullName] = useState(me.user.fullName);
  const [email, setEmail] = useState(me.user.email ?? '');
  const [nationalCode, setNationalCode] = useState('');
  const [birthDate, setBirthDate] = useState(me.customerProfile?.birthDate?.slice(0, 10) ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation((body: UpdateProfileInput) => apiPatch<Me & { updated: boolean }>('/auth/profile', body));

  useEffect(() => {
    setFullName(me.user.fullName);
    setEmail(me.user.email ?? '');
  }, [me]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: UpdateProfileInput = {};
    const nextErrors: Record<string, string> = {};
    const name = fullName.trim();
    if (name !== me.user.fullName) {
      if (name.length < 2 || name.length > 120) nextErrors.fullName = 'نام باید بین ۲ تا ۱۲۰ نویسه باشد.';
      body.fullName = name;
    }
    const mail = email.trim();
    if (mail && mail !== (me.user.email ?? '')) {
      if (!EMAIL.test(mail)) nextErrors.email = 'ایمیل معتبر نیست.';
      body.email = mail;
    }
    const code = toLatinDigits(nationalCode.trim());
    if (code) {
      if (!isValidNationalCode(code)) nextErrors.nationalCode = 'کد ملی معتبر نیست.';
      body.nationalCode = code;
    }
    if (birthDate && birthDate !== (me.customerProfile?.birthDate?.slice(0, 10) ?? '')) body.birthDate = birthDate;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (Object.keys(body).length === 0) {
      toast.info('تغییری برای ذخیره وجود ندارد.');
      return;
    }
    const result = await save.run(body);
    if (result) {
      onSaved({ user: result.user, customerProfile: result.customerProfile, vendor: result.vendor });
      setNationalCode('');
      await refresh();
      toast.success('پروفایل ذخیره شد.');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card title="ویرایش اطلاعات">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="نام و نام خانوادگی" error={errors.fullName} required>
            {(id, described) => <Input id={id} aria-describedby={described} value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} />}
          </Field>
          <Field label="ایمیل" error={errors.email}>
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} />}
          </Field>
          <Field label="کد ملی" error={errors.nationalCode} hint="برای درخواست اعتبار خرید اقساطی لازم است. کد ثبت‌شده قابل تغییر نیست.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="numeric" maxLength={10} value={nationalCode} onChange={(event) => setNationalCode(event.target.value)} placeholder="۱۰ رقم" />}
          </Field>
          <Field label="تاریخ تولد (میلادی)">
            {(id) => <Input id={id} type="date" dir="ltr" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} max={new Date().toISOString().slice(0, 10)} />}
          </Field>
          <div className="sm:col-span-2">
            <FormError message={save.error?.message} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
              ذخیرهٔ تغییرات
            </Button>
          </div>
        </form>
      </Card>
      <div className="flex flex-col gap-6">
        <Card title="حساب کاربری">
          <DefinitionList
            items={[
              { label: 'موبایل', value: <span dir="ltr">{formatMobile(me.user.mobile)}</span> },
              { label: 'نقش', value: ROLE_LABELS[me.user.role] },
              { label: 'تاریخ تولد', value: me.customerProfile?.birthDate ? formatDate(me.customerProfile.birthDate) : '—' },
            ]}
          />
        </Card>
        <Card title="فروشگاه">
          {me.vendor ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <b>{me.vendor.storeName}</b>
                <StatusBadge value={me.vendor.status} map={VENDOR_STATUS} />
              </div>
              {me.vendor.status === 'APPROVED' ? (
                <Button variant="secondary" onClick={() => void enterVendorPanel()}>
                  ورود به پنل فروشنده
                </Button>
              ) : (
                <p className="text-slate-600">درخواست فروشندگی شما در حال بررسی توسط تیم {PLATFORM_NAME} است.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-sm text-slate-600">
              <p>محصولات خود را در {PLATFORM_NAME} بفروشید.</p>
              <LinkButton href="/vendor/register" variant="secondary">
                درخواست فروشندگی
              </LinkButton>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
