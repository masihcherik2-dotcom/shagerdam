'use client';

import { Save, Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { apiPost } from '@/lib/api/client';
import type { AdminCreateVendorInput, AdminCreateVendorResult } from '@/lib/api/types';
import { EMPTY_ADMIN_VENDOR_FORM, validateAdminVendor, type AdminVendorForm } from '@/lib/admin-vendor-form';
import { useMutation } from '@/lib/hooks/use-api';

/**
 * Staff open a store on a seller's behalf (SUPER_ADMIN / ADMIN). The store is
 * approved immediately — the administrator vouches for the seller's identity
 * (audited as kycBy=ADMIN_CREATED). The seller signs in at /login with the
 * owner mobile and a one-time code; products can then be added by the seller
 * or by staff from the store page (link importer).
 */
export default function AdminCreateVendorPage() {
  const router = useRouter();
  const toast = useToast();
  const [form, setForm] = useState<AdminVendorForm>(EMPTY_ADMIN_VENDOR_FORM);
  const [errors, setErrors] = useState<Partial<Record<keyof AdminVendorForm, string>>>({});
  const create = useMutation((body: AdminCreateVendorInput) => apiPost<AdminCreateVendorResult>('/admin/vendors', body));

  const set = <K extends keyof AdminVendorForm>(key: K, value: AdminVendorForm[K]): void => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { errors: fieldErrors, payload } = validateAdminVendor(form);
    setErrors(fieldErrors);
    if (!payload) return;
    const result = await create.run(payload);
    if (result) {
      toast.success(result.ownerCreated ? 'فروشگاه و حساب فروشنده ساخته شد.' : 'فروشگاه ساخته شد و به حساب موجود این موبایل متصل شد.');
      router.push(`/admin/vendors/${result.profile.id}`);
    }
  }

  return (
    <>
      <PageHeader
        title="ایجاد فروشگاه"
        description="فروشگاه بلافاصله تأییدشده است؛ مسئولیت احراز هویت فروشنده با شماست و در گزارش ممیزی ثبت می‌شود."
        action={
          <LinkButton href="/admin/vendors" variant="secondary">
            انصراف
          </LinkButton>
        }
      />
      <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-6" data-testid="admin-create-vendor-form">
        <Card title="فروشگاه">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="نام فروشگاه" required error={errors.storeName}>
              {(id, described) => <Input id={id} aria-describedby={described} name="storeName" maxLength={120} value={form.storeName} onChange={(event) => set('storeName', event.target.value)} />}
            </Field>
            <Field label="شناسهٔ نشانی (slug)" required error={errors.storeSlug} hint="در نشانی فروشگاه: /stores/شناسه">
              {(id, described) => (
                <Input id={id} aria-describedby={described} name="storeSlug" dir="ltr" maxLength={140} value={form.storeSlug} onChange={(event) => set('storeSlug', event.target.value.toLowerCase())} />
              )}
            </Field>
            <Field label="کمیسیون اختصاصی (٪)" error={errors.commission} hint="خالی = نرخ دسته‌بندی هر کالا">
              {(id, described) => <Input id={id} aria-describedby={described} name="commission" dir="ltr" inputMode="decimal" value={form.commission} onChange={(event) => set('commission', event.target.value)} />}
            </Field>
            <Field label="اینستاگرام" error={errors.instagramHandle}>
              {(id, described) => (
                <Input id={id} aria-describedby={described} name="instagramHandle" dir="ltr" maxLength={61} placeholder="store.page" value={form.instagramHandle} onChange={(event) => set('instagramHandle', event.target.value)} />
              )}
            </Field>
            <Field label="معرفی فروشگاه" error={errors.bio} className="md:col-span-2">
              {(id, described) => <Textarea id={id} aria-describedby={described} name="bio" rows={3} maxLength={2000} value={form.bio} onChange={(event) => set('bio', event.target.value)} />}
            </Field>
          </div>
        </Card>
        <Card title="مالک و حساب تسویه">
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="موبایل فروشنده" required error={errors.ownerMobile} hint="ورود فروشنده با همین شماره و کد یک‌بارمصرف">
              {(id, described) => (
                <Input id={id} aria-describedby={described} name="ownerMobile" dir="ltr" inputMode="tel" maxLength={14} placeholder="09121234567" value={form.ownerMobile} onChange={(event) => set('ownerMobile', event.target.value)} />
              )}
            </Field>
            <Field label="نام و نام خانوادگی مالک" required error={errors.ownerFullName}>
              {(id, described) => <Input id={id} aria-describedby={described} name="ownerFullName" maxLength={120} value={form.ownerFullName} onChange={(event) => set('ownerFullName', event.target.value)} />}
            </Field>
            <Field label="شمارهٔ شبا" required error={errors.bankIban}>
              {(id, described) => (
                <Input id={id} aria-describedby={described} name="bankIban" dir="ltr" maxLength={34} placeholder="IR…" value={form.bankIban} onChange={(event) => set('bankIban', event.target.value)} />
              )}
            </Field>
            <Field label="نام صاحب حساب" error={errors.bankAccountHolder} hint="خالی = نام مالک">
              {(id, described) => <Input id={id} aria-describedby={described} name="bankAccountHolder" maxLength={120} value={form.bankAccountHolder} onChange={(event) => set('bankAccountHolder', event.target.value)} />}
            </Field>
          </div>
        </Card>
        <FormError message={create.error?.message} />
        <div className="flex justify-end">
          <Button type="submit" size="lg" loading={create.pending} icon={<Save className="size-5" />}>
            ایجاد فروشگاه
          </Button>
        </div>
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <Store className="size-4" aria-hidden="true" /> پس از ایجاد، از صفحهٔ فروشگاه می‌توانید با لینک دیجی‌کالا محصول اضافه و منتشر کنید.
        </p>
      </form>
    </>
  );
}
