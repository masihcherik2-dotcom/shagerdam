'use client';

import { BadgeCheck, Building2, ExternalLink, History, Phone, Save, SearchCheck } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';
import { Badge, Card, PageHeader } from '@/components/ui/misc';
import { ErrorState, Skeleton } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AdminSiteInfo, SiteInfo, SiteInfoField } from '@/lib/api/types';
import { formatDateTime, toPersianDigits } from '@/lib/format';
import { useApi } from '@/lib/hooks/use-api';
import { SITE_INFO_FIELD_LABELS } from '@/lib/site-info';

type FormValues = Record<SiteInfoField, string>;
type Patch = Partial<Record<SiteInfoField, string | null>>;

interface FieldSpec {
  field: SiteInfoField;
  maxLength: number;
  ltr?: boolean;
  multiline?: boolean;
  placeholder?: string;
  hint?: string;
}

const GROUPS: ReadonlyArray<{ title: string; icon: typeof Building2; description: string; fields: readonly FieldSpec[] }> = [
  {
    title: 'هویت حقوقی',
    icon: Building2,
    description: 'همان اطلاعات ثبت‌شده در اداره ثبت شرکت‌ها؛ در فوتر و صفحهٔ قوانین نمایش داده می‌شود.',
    fields: [
      { field: 'legalName', maxLength: 150, placeholder: 'شرکت … (سهامی خاص)' },
      { field: 'nationalId', maxLength: 11, ltr: true, placeholder: '10xxxxxxxxx', hint: 'شناسهٔ ملی ۱۱ رقمی شخص حقوقی' },
      { field: 'registrationNumber', maxLength: 20, ltr: true, hint: 'فقط رقم' },
    ],
  },
  {
    title: 'راه‌های تماس',
    icon: Phone,
    description: 'در صفحهٔ «تماس با ما» و فوتر؛ هر فیلد خالی نمایش داده نمی‌شود.',
    fields: [
      { field: 'supportPhone', maxLength: 20, ltr: true, placeholder: '021-91000000', hint: 'تلفن ثابت با پیش‌شماره یا موبایل' },
      { field: 'supportEmail', maxLength: 254, ltr: true, placeholder: 'support@example.ir' },
      { field: 'workingHours', maxLength: 200, placeholder: 'شنبه تا چهارشنبه ۹ تا ۱۷' },
      { field: 'officeAddress', maxLength: 300, multiline: true },
      { field: 'postalCode', maxLength: 10, ltr: true, hint: '۱۰ رقم، بدون صفر در ابتدا' },
    ],
  },
  {
    title: 'نمادهای اعتماد',
    icon: BadgeCheck,
    description:
      'کد نماد را از پنل enamad.ir و samandehi.ir برای همین دامنه بردارید: نشانی لینک (href) و نشانی تصویر (src). فقط دامنه‌های رسمی صادرکننده پذیرفته می‌شود و هر نماد تنها وقتی هر دو نشانی‌اش ثبت شده باشد نمایش داده می‌شود.',
    fields: [
      { field: 'enamadLinkUrl', maxLength: 500, ltr: true, placeholder: 'https://trustseal.enamad.ir/?id=…&Code=…' },
      { field: 'enamadImageUrl', maxLength: 500, ltr: true, placeholder: 'https://trustseal.enamad.ir/logo.aspx?id=…&Code=…' },
      { field: 'samandehiLinkUrl', maxLength: 500, ltr: true, placeholder: 'https://logo.samandehi.ir/Verify.aspx?id=…&p=…' },
      { field: 'samandehiImageUrl', maxLength: 500, ltr: true, placeholder: 'https://logo.samandehi.ir/logo.aspx?id=…&p=…' },
    ],
  },
  {
    title: 'موتورهای جست‌وجو',
    icon: SearchCheck,
    description:
      'در Google Search Console روش تأیید «HTML tag» را انتخاب کنید و کل تگ meta یا فقط مقدار content آن را اینجا بچسبانید. پس از ذخیره، تگ در <head> همهٔ صفحات درج می‌شود و می‌توانید در Search Console دکمهٔ Verify را بزنید.',
    fields: [
      {
        field: 'googleVerificationTag',
        maxLength: 300,
        ltr: true,
        placeholder: '<meta name="google-site-verification" content="…" />',
        hint: 'فقط مقدار content ذخیره می‌شود (حروف، رقم، - و _).',
      },
    ],
  },
];

const ALL_FIELDS: SiteInfoField[] = GROUPS.flatMap((group) => group.fields.map((spec) => spec.field));

function toForm(info: SiteInfo): FormValues {
  return Object.fromEntries(ALL_FIELDS.map((field) => [field, info[field] ?? ''])) as FormValues;
}

/** Changed fields only; an emptied field is sent as null (= clear). */
function diff(form: FormValues, saved: SiteInfo): Patch {
  const patch: Patch = {};
  for (const field of ALL_FIELDS) {
    const next = form[field].trim();
    if (next !== (saved[field] ?? '')) patch[field] = next === '' ? null : next;
  }
  return patch;
}

function SealPreview({ link, image, label }: { link: string; image: string; label: string }) {
  if (!link || !image) return <p className="text-xs text-slate-500">{label}: برای نمایش، هر دو نشانی لازم است.</p>;
  return (
    <a href={link} target="_blank" rel="noopener" referrerPolicy="origin" className="inline-flex items-center gap-3 rounded-xl border border-slate-200 p-2 text-xs text-slate-600 hover:border-brand-300">
      {/* eslint-disable-next-line @next/next/no-img-element -- preview of the issuer's seal image. */}
      <img src={image} alt={label} referrerPolicy="origin" width={64} height={64} className="size-16 object-contain" />
      <span className="flex items-center gap-1">
        پیش‌نمایش {label} <ExternalLink className="size-3.5" aria-hidden="true" />
      </span>
    </a>
  );
}

export default function AdminSiteInfoPage() {
  const toast = useToast();
  const state = useApi<AdminSiteInfo>('/admin/site-info');
  const [form, setForm] = useState<FormValues | null>(null);
  const [fieldError, setFieldError] = useState<{ field: SiteInfoField; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (state.data && form === null) setForm(toForm(state.data));
  }, [state.data, form]);

  const patch = useMemo(() => (form && state.data ? diff(form, state.data) : {}), [form, state.data]);
  const dirty = Object.keys(patch).length > 0;

  const save = async (): Promise<void> => {
    if (!dirty) return;
    setSaving(true);
    setFieldError(null);
    try {
      const next = await apiPatch<AdminSiteInfo, Patch>('/admin/site-info', patch);
      state.setData(next);
      setForm(toForm(next));
      toast.success('اطلاعات سایت ذخیره شد و در فروشگاه اعمال می‌شود.');
    } catch (error) {
      const apiError = toApiError(error);
      const details = apiError.details as { field?: unknown } | undefined;
      if (apiError.code === 'SITE_INFO_INVALID_FIELD' && typeof details?.field === 'string' && ALL_FIELDS.includes(details.field as SiteInfoField)) {
        setFieldError({ field: details.field as SiteInfoField, message: apiError.message });
      }
      toast.error(apiError.message);
    } finally {
      setSaving(false);
    }
  };

  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={() => void state.reload()} />;
  if (!state.data || !form) return <Skeleton className="h-96" />;
  const data = state.data;

  return (
    <>
      <PageHeader
        title="اطلاعات سایت و نمادها"
        description="هویت حقوقی، راه‌های تماس و نمادهای اینماد و ساماندهی؛ فقط فیلدهای پرشده در فروشگاه نمایش داده می‌شوند."
        action={
          <Button loading={saving} disabled={!dirty} icon={<Save className="size-4" />} onClick={() => void save()}>
            ذخیره تغییرات
          </Button>
        }
      />
      <form
        className="flex flex-col gap-6"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        {GROUPS.map((group) => {
          const Icon = group.icon;
          return (
            <Card
              key={group.title}
              title={
                <span className="flex items-center gap-2">
                  <Icon className="size-5 text-brand-600" aria-hidden="true" /> {group.title}
                </span>
              }
            >
              <p className="mb-4 text-sm leading-6 text-slate-500">{group.description}</p>
              <div className="grid gap-4 md:grid-cols-2">
                {group.fields.map((spec) => {
                  const error = fieldError?.field === spec.field ? fieldError.message : null;
                  const updatedAt = data.updatedAt[spec.field];
                  const hint = [spec.hint, updatedAt ? `آخرین تغییر: ${formatDateTime(updatedAt)}` : null].filter(Boolean).join(' — ') || undefined;
                  const common = {
                    value: form[spec.field],
                    maxLength: spec.maxLength,
                    placeholder: spec.placeholder,
                    dir: spec.ltr ? ('ltr' as const) : undefined,
                    onChange: (event: { target: { value: string } }) => {
                      setForm({ ...form, [spec.field]: event.target.value });
                      if (fieldError?.field === spec.field) setFieldError(null);
                    },
                  };
                  return (
                    <Field key={spec.field} label={SITE_INFO_FIELD_LABELS[spec.field] ?? spec.field} hint={hint} error={error} className={spec.multiline || (spec.ltr && spec.maxLength === 500) ? 'md:col-span-2' : ''}>
                      {(id, describedBy) =>
                        spec.multiline ? (
                          <Textarea id={id} aria-describedby={describedBy} aria-invalid={Boolean(error)} rows={3} {...common} />
                        ) : (
                          <Input id={id} aria-describedby={describedBy} aria-invalid={Boolean(error)} className={`h-11 ${spec.ltr ? 'text-left' : ''}`} {...common} />
                        )
                      }
                    </Field>
                  );
                })}
              </div>
              {group.icon === BadgeCheck ? (
                <div className="mt-4 flex flex-wrap gap-4">
                  <SealPreview link={data.enamadLinkUrl ?? ''} image={data.enamadImageUrl ?? ''} label="اینماد" />
                  <SealPreview link={data.samandehiLinkUrl ?? ''} image={data.samandehiImageUrl ?? ''} label="ساماندهی" />
                </div>
              ) : null}
            </Card>
          );
        })}
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>

      <Card
        className="mt-6"
        title={
          <span className="flex items-center gap-2">
            <History className="size-5 text-slate-500" aria-hidden="true" /> تاریخچهٔ تغییرات
          </span>
        }
      >
        {data.history.length === 0 ? (
          <p className="text-sm text-slate-500">هنوز تغییری ثبت نشده است.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm">
            {data.history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="text-xs text-slate-500">{formatDateTime(entry.createdAt)}</span>
                <span className="font-medium text-slate-800">{entry.actor?.fullName ?? 'سیستم'}</span>
                <span className="text-slate-500">— {toPersianDigits(entry.changedFields.length)} فیلد:</span>
                {entry.changedFields.map((field) => (
                  <Badge key={field}>{SITE_INFO_FIELD_LABELS[field] ?? field}</Badge>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
