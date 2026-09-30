'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { apiPatch, apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Address, AddressInput } from '@/lib/api/types';
import { toLatinDigits } from '@/lib/format';
import { IRAN_MOBILE_PATTERN, IRAN_PROVINCES, POSTAL_CODE_PATTERN } from '@/lib/iran';

type Errors = Partial<Record<keyof AddressInput, string>>;

function validate(input: AddressInput): Errors {
  const errors: Errors = {};
  if (!input.province) errors.province = 'استان را انتخاب کنید.';
  if (input.city.trim().length < 2) errors.city = 'نام شهر را وارد کنید.';
  if (input.postalAddress.trim().length < 10) errors.postalAddress = 'نشانی کامل (حداقل ۱۰ حرف) را وارد کنید.';
  if (!POSTAL_CODE_PATTERN.test(input.postalCode)) errors.postalCode = 'کد پستی ۱۰ رقمی و بدون خط تیره است (با صفر شروع نمی‌شود).';
  if (input.recipientName.trim().length < 2) errors.recipientName = 'نام گیرنده را وارد کنید.';
  if (!IRAN_MOBILE_PATTERN.test(input.recipientMobile)) errors.recipientMobile = 'شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷).';
  return errors;
}

/**
 * Add/edit address modal (province, city, full address, postal code,
 * recipient). Validates like the backend, then POST/PATCH customer/addresses.
 */
export function AddressFormModal({
  open,
  onClose,
  onSaved,
  address,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (address: Address) => void;
  address?: Address | null;
}) {
  const [form, setForm] = useState<AddressInput>(() => ({
    province: address?.province ?? '',
    city: address?.city ?? '',
    postalAddress: address?.postalAddress ?? '',
    postalCode: address?.postalCode ?? '',
    buildingNumber: address?.buildingNumber ?? '',
    unitNumber: address?.unitNumber ?? '',
    recipientName: address?.recipientName ?? '',
    recipientMobile: address?.recipientMobile.replace(/^\+98/, '0') ?? '',
    isDefault: address?.isDefault ?? false,
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof AddressInput>(key: K, value: AddressInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalised: AddressInput = {
      ...form,
      city: form.city.trim(),
      postalAddress: form.postalAddress.trim(),
      postalCode: toLatinDigits(form.postalCode).replace(/\D/g, ''),
      recipientName: form.recipientName.trim(),
      recipientMobile: toLatinDigits(form.recipientMobile).replace(/[\s-]/g, ''),
      buildingNumber: form.buildingNumber?.trim() ? toLatinDigits(form.buildingNumber.trim()) : null,
      unitNumber: form.unitNumber?.trim() ? toLatinDigits(form.unitNumber.trim()) : null,
    };
    const found = validate(normalised);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setServerError(null);
    try {
      const body = { ...normalised, isDefault: normalised.isDefault ? true : undefined };
      const saved = address ? await apiPatch<Address>(`/customer/addresses/${address.id}`, body) : await apiPost<Address>('/customer/addresses', body);
      onSaved(saved);
    } catch (caught) {
      setServerError(toApiError(caught).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={address ? 'ویرایش نشانی' : 'افزودن نشانی جدید'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button type="submit" form="address-form" loading={saving}>
            ذخیرهٔ نشانی
          </Button>
        </>
      }
    >
      <form id="address-form" onSubmit={(event) => void submit(event)} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="استان" required error={errors.province}>
          {(id, described) => (
            <Select id={id} aria-describedby={described} aria-invalid={Boolean(errors.province)} value={form.province} onChange={(event) => set('province', event.target.value)}>
              <option value="">انتخاب استان…</option>
              {IRAN_PROVINCES.map((province) => (
                <option key={province} value={province}>
                  {province}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="شهر" required error={errors.city}>
          {(id, described) => <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.city)} value={form.city} onChange={(event) => set('city', event.target.value)} maxLength={60} />}
        </Field>
        <Field label="نشانی پستی کامل" required error={errors.postalAddress} className="sm:col-span-2">
          {(id, described) => (
            <Textarea id={id} aria-describedby={described} aria-invalid={Boolean(errors.postalAddress)} value={form.postalAddress} onChange={(event) => set('postalAddress', event.target.value)} maxLength={500} placeholder="خیابان، کوچه، …" />
          )}
        </Field>
        <Field label="کد پستی" required error={errors.postalCode} hint="۱۰ رقم، بدون خط تیره">
          {(id, described) => (
            <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.postalCode)} dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(event) => set('postalCode', event.target.value)} maxLength={12} />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="پلاک">
            {(id) => <Input id={id} value={form.buildingNumber ?? ''} onChange={(event) => set('buildingNumber', event.target.value)} maxLength={20} />}
          </Field>
          <Field label="واحد">
            {(id) => <Input id={id} value={form.unitNumber ?? ''} onChange={(event) => set('unitNumber', event.target.value)} maxLength={20} />}
          </Field>
        </div>
        <Field label="نام و نام خانوادگی گیرنده" required error={errors.recipientName}>
          {(id, described) => <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.recipientName)} value={form.recipientName} onChange={(event) => set('recipientName', event.target.value)} maxLength={120} />}
        </Field>
        <Field label="موبایل گیرنده" required error={errors.recipientMobile}>
          {(id, described) => (
            <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.recipientMobile)} dir="ltr" inputMode="tel" value={form.recipientMobile} onChange={(event) => set('recipientMobile', event.target.value)} placeholder="09121234567" />
          )}
        </Field>
        {!address?.isDefault ? <Checkbox className="sm:col-span-2" label="نشانی پیش‌فرض من باشد" checked={Boolean(form.isDefault)} onChange={(event) => set('isDefault', event.target.checked)} /> : null}
        <div className="sm:col-span-2">
          <FormError message={serverError} />
        </div>
      </form>
    </Modal>
  );
}
