'use client';

import { BadgeCheck, FileCheck2, Save, Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Card, DefinitionList, PageHeader, StatusBadge } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPatch, apiPost } from '@/lib/api/client';
import type { RegisterVendorInput, VendorProfile } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { isValidSheba } from '@/lib/iran';
import { VENDOR_STATUS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOC_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

function normaliseIban(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Vendor onboarding and store settings:
 *  1. no store yet → POST /vendors/register;
 *  2. store exists → KYC documents (POST /vendors/verification/documents) and
 *     profile editing (PATCH /vendors/me). Staff review the documents in /admin/vendors.
 */
export default function VendorRegisterPage() {
  const { me } = useSession();
  const hasStore = Boolean(me?.vendor);
  return hasStore ? <StoreSettings /> : <RegisterForm />;
}

function RegisterForm() {
  const toast = useToast();
  const { refresh } = useSession();
  const router = useRouter();
  const [form, setForm] = useState<RegisterVendorInput>({ storeName: '', storeSlug: '', instagramHandle: '', bio: '', bankIban: 'IR', bankAccountHolder: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const register = useMutation((body: RegisterVendorInput) => apiPost<VendorProfile>('/vendors/register', body));
  const set = (key: keyof RegisterVendorInput) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const iban = normaliseIban(form.bankIban);
    const next: Record<string, string> = {};
    if (form.storeName.trim().length < 2) next.storeName = 'نام فروشگاه دست‌کم ۲ نویسه است.';
    if (!SLUG.test(form.storeSlug) || form.storeSlug.length < 3) next.storeSlug = 'فقط حروف کوچک لاتین، رقم و خط تیره (دست‌کم ۳ نویسه).';
    if (!isValidSheba(iban)) next.bankIban = 'شمارهٔ شبا معتبر نیست.';
    if (form.bankAccountHolder.trim().length < 3) next.bankAccountHolder = 'نام صاحب حساب را وارد کنید.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const body: RegisterVendorInput = {
      storeName: form.storeName.trim(),
      storeSlug: form.storeSlug,
      bankIban: iban,
      bankAccountHolder: form.bankAccountHolder.trim(),
      ...(form.instagramHandle?.trim() ? { instagramHandle: form.instagramHandle.trim().replace(/^@/, '') } : {}),
      ...(form.bio?.trim() ? { bio: form.bio.trim() } : {}),
    };
    const vendor = await register.run(body);
    if (vendor) {
      toast.success('فروشگاه ساخته شد. اکنون مدارک احراز هویت را بارگذاری کنید.');
      await refresh();
      router.refresh();
    }
  }

  return (
    <>
      <PageHeader title="فروشنده شوید" description={`ثبت فروشگاه در ${PLATFORM_NAME} — پس از بارگذاری مدارک و تأیید کارشناسان، پنل فروشنده فعال می‌شود.`} />
      <Card title="اطلاعات فروشگاه">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4 md:grid-cols-2" noValidate>
          <Field label="نام فروشگاه" required error={errors.storeName}>
            {(id, described) => <Input id={id} aria-describedby={described} maxLength={120} value={form.storeName} onChange={(event) => set('storeName')(event.target.value)} />}
          </Field>
          <Field label="نامک (آدرس فروشگاه)" required error={errors.storeSlug} hint="مثال: pars-digital">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={140} value={form.storeSlug} onChange={(event) => set('storeSlug')(event.target.value.toLowerCase())} />}
          </Field>
          <Field label="شمارهٔ شبا" required error={errors.bankIban} hint="تسویه‌ها فقط به این حساب واریز می‌شود.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={34} value={form.bankIban} onChange={(event) => set('bankIban')(event.target.value)} />}
          </Field>
          <Field label="نام صاحب حساب" required error={errors.bankAccountHolder}>
            {(id, described) => <Input id={id} aria-describedby={described} maxLength={120} value={form.bankAccountHolder} onChange={(event) => set('bankAccountHolder')(event.target.value)} />}
          </Field>
          <Field label="اینستاگرام (اختیاری)">{(id) => <Input id={id} dir="ltr" maxLength={60} placeholder="@store" value={form.instagramHandle} onChange={(event) => set('instagramHandle')(event.target.value)} />}</Field>
          <Field label="معرفی فروشگاه (اختیاری)" className="md:col-span-2">
            {(id) => <Textarea id={id} rows={3} maxLength={2000} value={form.bio} onChange={(event) => set('bio')(event.target.value)} />}
          </Field>
          <div className="md:col-span-2">
            <FormError message={register.error?.message} />
          </div>
          <div className="md:col-span-2">
            <Button type="submit" size="lg" loading={register.pending} icon={<Store className="size-5" />}>
              ساخت فروشگاه
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function StoreSettings() {
  const state = useApi<VendorProfile>('/vendors/me');
  return (
    <>
      <PageHeader title="فروشگاه و مدارک" description="وضعیت احراز هویت، مدارک و مشخصات فروشگاه" />
      <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
        {(vendor) => (
          <div className="grid gap-6 lg:grid-cols-2">
            <VerificationCard vendor={vendor} onChange={state.setData} />
            <ProfileCard vendor={vendor} onChange={state.setData} />
          </div>
        )}
      </AsyncView>
    </>
  );
}

function VerificationCard({ vendor, onChange }: { vendor: VendorProfile; onChange: (vendor: VendorProfile) => void }) {
  const toast = useToast();
  const [nationalId, setNationalId] = useState<UploadedFile[]>([]);
  const [license, setLicense] = useState<UploadedFile[]>([]);
  const [bankProof, setBankProof] = useState<UploadedFile[]>([]);
  const submit = useMutation((body: Record<string, string>) => apiPost<VendorProfile>('/vendors/verification/documents', body));
  const verification = vendor.verification;
  const awaitingReview = verification !== null && verification.reviewedAt === null;

  async function send() {
    const [id] = nationalId;
    if (!id) {
      toast.error('تصویر کارت ملی الزامی است.');
      return;
    }
    const body: Record<string, string> = { nationalIdCardUrl: id.url };
    if (license[0]) body.businessLicenseUrl = license[0].url;
    if (bankProof[0]) body.bankAccountProofUrl = bankProof[0].url;
    const result = await submit.run(body);
    if (result) {
      onChange(result);
      setNationalId([]);
      setLicense([]);
      setBankProof([]);
      toast.success('مدارک ارسال شد و در صف بررسی قرار گرفت.');
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <BadgeCheck className="size-5 text-brand-600" /> احراز هویت
        </span>
      }
      action={<StatusBadge value={vendor.status} map={VENDOR_STATUS} />}
    >
      <div className="flex flex-col gap-4">
        {vendor.status === 'APPROVED' ? <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">فروشگاه در {vendor.verifiedAt ? formatDateTime(vendor.verifiedAt) : '—'} تأیید شد.</p> : null}
        {verification?.rejectionReason ? <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">علت رد: {verification.rejectionReason}</p> : null}
        {verification ? (
          <DefinitionList
            items={[
              { label: 'آخرین ارسال', value: formatDateTime(verification.createdAt) },
              { label: 'بررسی', value: verification.reviewedAt ? `${formatDateTime(verification.reviewedAt)}${verification.reviewedByName ? ` — ${verification.reviewedByName}` : ''}` : 'در انتظار بررسی' },
              {
                label: 'مدارک',
                value: (
                  <span className="flex flex-wrap gap-2">
                    <a className="text-brand-700 underline" href={verification.nationalIdCardUrl} target="_blank" rel="noopener noreferrer">
                      کارت ملی
                    </a>
                    {verification.businessLicenseUrl ? (
                      <a className="text-brand-700 underline" href={verification.businessLicenseUrl} target="_blank" rel="noopener noreferrer">
                        جواز کسب
                      </a>
                    ) : null}
                    {verification.bankAccountProofUrl ? (
                      <a className="text-brand-700 underline" href={verification.bankAccountProofUrl} target="_blank" rel="noopener noreferrer">
                        مالکیت حساب
                      </a>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <p className="text-sm text-slate-600">برای فعال شدن فروشگاه، مدارک زیر را بارگذاری کنید.</p>
        )}
        {vendor.status !== 'APPROVED' && !awaitingReview ? (
          <>
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_national_id' }} value={nationalId} onChange={setNationalId} max={1} accept={DOC_ACCEPT} label="کارت ملی (الزامی)" />
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_business_license' }} value={license} onChange={setLicense} max={1} accept={DOC_ACCEPT} label="جواز کسب (اختیاری)" />
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_bank_proof' }} value={bankProof} onChange={setBankProof} max={1} accept={DOC_ACCEPT} label="گواهی مالکیت حساب (اختیاری)" />
            <FormError message={submit.error?.message} />
            <Button loading={submit.pending} icon={<FileCheck2 className="size-4" />} onClick={() => void send()}>
              ارسال مدارک برای بررسی
            </Button>
          </>
        ) : null}
        {awaitingReview && vendor.status !== 'APPROVED' ? <p className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">مدارک شما دریافت شده و در صف بررسی کارشناسان است.</p> : null}
      </div>
    </Card>
  );
}

function ProfileCard({ vendor, onChange }: { vendor: VendorProfile; onChange: (vendor: VendorProfile) => void }) {
  const toast = useToast();
  const { refresh } = useSession();
  const [storeName, setStoreName] = useState(vendor.storeName);
  const [bio, setBio] = useState(vendor.bio ?? '');
  const [instagram, setInstagram] = useState(vendor.instagramHandle ?? '');
  const [logo, setLogo] = useState<UploadedFile[]>([]);
  const [iban, setIban] = useState(vendor.bankIban);
  const [ibanProof, setIbanProof] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation((body: Record<string, string>) => apiPatch<VendorProfile>('/vendors/me', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, string> = {};
    if (storeName.trim() !== vendor.storeName) body.storeName = storeName.trim();
    if (bio.trim() !== (vendor.bio ?? '')) body.bio = bio.trim();
    const handle = instagram.trim().replace(/^@/, '');
    if (handle !== (vendor.instagramHandle ?? '')) body.instagramHandle = handle;
    if (logo[0]) body.logoUrl = logo[0].url;
    const nextIban = normaliseIban(iban);
    if (nextIban !== vendor.bankIban) {
      if (!isValidSheba(nextIban)) return setError('شمارهٔ شبا معتبر نیست.');
      if (!ibanProof[0]) return setError('برای تغییر شبا، گواهی مالکیت حساب جدید را بارگذاری کنید.');
      body.bankIban = nextIban;
      body.bankAccountProofUrl = ibanProof[0].url;
    }
    setError(null);
    if (Object.keys(body).length === 0) {
      toast.info('تغییری برای ذخیره وجود ندارد.');
      return;
    }
    const result = await save.run(body);
    if (result) {
      onChange(result);
      setLogo([]);
      setIbanProof([]);
      await refresh();
      toast.success(body.bankIban ? 'ذخیره شد. تا تأیید شبای جدید، فروشگاه در وضعیت بررسی است.' : 'مشخصات فروشگاه ذخیره شد.');
    }
  }

  const ibanChanged = normaliseIban(iban) !== vendor.bankIban;

  return (
    <Card title="مشخصات فروشگاه">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          {vendor.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- media URL from the API
            <img src={vendor.logoUrl} alt="" className="size-14 rounded-xl border object-cover" />
          ) : null}
          <span dir="ltr">/{vendor.storeSlug}</span>
        </div>
        <Field label="نام فروشگاه">{(id) => <Input id={id} maxLength={120} value={storeName} onChange={(event) => setStoreName(event.target.value)} />}</Field>
        <Field label="اینستاگرام">{(id) => <Input id={id} dir="ltr" maxLength={60} value={instagram} onChange={(event) => setInstagram(event.target.value)} />}</Field>
        <Field label="معرفی">{(id) => <Textarea id={id} rows={3} maxLength={2000} value={bio} onChange={(event) => setBio(event.target.value)} />}</Field>
        <FileDrop upload={{ kind: 'image', purpose: 'store_logo' }} value={logo} onChange={setLogo} max={1} accept="image/jpeg,image/png,image/webp" label="لوگوی جدید" />
        <Field label="شمارهٔ شبا" hint="تغییر شبا نیازمند گواهی مالکیت و تأیید دوباره است.">
          {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={34} value={iban} onChange={(event) => setIban(event.target.value)} />}
        </Field>
        {ibanChanged ? <FileDrop upload={{ kind: 'document', purpose: 'kyc_bank_proof' }} value={ibanProof} onChange={setIbanProof} max={1} accept={DOC_ACCEPT} label="گواهی مالکیت حساب جدید" /> : null}
        <FormError message={error ?? save.error?.message} />
        <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
          ذخیره
        </Button>
      </form>
    </Card>
  );
}
