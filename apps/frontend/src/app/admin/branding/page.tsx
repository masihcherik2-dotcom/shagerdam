'use client';

import { ArrowDown, ArrowUp, GripVertical, History, ImagePlus, Images, Palette, RotateCcw, Save, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input } from '@/components/ui/field';
import { Badge, Card, PageHeader } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { apiPatch, apiUploadWithFields } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import { PLATFORM_MONOGRAM, PLATFORM_NAME } from '@/lib/brand';
import { BRANDING_FIELD_LABELS, isValidBannerLink, type AdminBranding, type BrandingAsset, type BrandingSlot } from '@/lib/branding';
import { formatDateTime, toPersianDigits } from '@/lib/format';
import { useApi } from '@/lib/hooks/use-api';

const MAX_BANNERS = 10;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_SVG_BYTES = 512 * 1024;
const RASTER_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';
const LOGO_ACCEPT = `${RASTER_ACCEPT},image/svg+xml,.svg`;

type LogoField = 'logoUrl' | 'mobileLogoUrl' | 'faviconUrl';
type BrandingPatch = Partial<Record<LogoField, string | null>> & { heroBanners?: BannerPayload[] };
interface BannerPayload {
  id?: string;
  imageUrl: string;
  title: string | null;
  linkUrl: string | null;
  sortOrder: number;
  isActive: boolean;
}
interface DraftBanner {
  key: string;
  id?: string;
  imageUrl: string;
  title: string;
  linkUrl: string;
  isActive: boolean;
}

const checkerboard = 'bg-[conic-gradient(#e2e8f0_25%,#fff_0_50%,#e2e8f0_0_75%,#fff_0)] bg-[length:16px_16px]';

/** Client-side pre-check (the server enforces the same rules and more). */
function fileProblem(file: File, slot: BrandingSlot): string | null {
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg');
  if (isSvg && slot === 'hero_banner') return 'SVG فقط برای لوگو و فاوآیکن پذیرفته می‌شود.';
  if (isSvg && file.size > MAX_SVG_BYTES) return 'حجم فایل SVG نباید بیش از ۵۱۲ کیلوبایت باشد.';
  if (file.size > MAX_IMAGE_BYTES) return 'حجم تصویر نباید بیش از ۵ مگابایت باشد.';
  return null;
}

function toDraft(banners: AdminBranding['heroBanners']): DraftBanner[] {
  return banners.map((banner) => ({
    key: banner.id,
    id: banner.id,
    imageUrl: banner.imageUrl,
    title: banner.title ?? '',
    linkUrl: banner.linkUrl ?? '',
    isActive: banner.isActive,
  }));
}

function toPayload(drafts: DraftBanner[]): BannerPayload[] {
  return drafts.map((banner, index) => ({
    ...(banner.id ? { id: banner.id } : {}),
    imageUrl: banner.imageUrl,
    title: banner.title.trim() || null,
    linkUrl: banner.linkUrl.trim() || null,
    sortOrder: index,
    isActive: banner.isActive,
  }));
}

export default function AdminBrandingPage() {
  const state = useApi<AdminBranding>('/admin/branding');
  const [latest, setLatest] = useState<AdminBranding | null>(null);
  const data = latest ?? state.data;
  const toast = useToast();

  async function save(patch: BrandingPatch, success: string): Promise<boolean> {
    try {
      const next = await apiPatch<AdminBranding, BrandingPatch>('/admin/branding', patch);
      setLatest(next);
      toast.success(success);
      return true;
    } catch (error) {
      toast.error(toApiError(error).message);
      return false;
    }
  }

  return (
    <>
      <PageHeader
        title="مدیریت هویت بصری و بنرها"
        description="لوگو، لوگوی موبایل، فاوآیکن و بنرهای صفحهٔ اصلی فروشگاه. تغییرات بلافاصله پس از ذخیره در سایت نمایش داده می‌شوند."
      />
      {state.loading && !data ? (
        <div className="grid gap-6">
          <Skeleton className="h-64" />
          <Skeleton className="h-80" />
        </div>
      ) : state.error && !data ? (
        <ErrorState error={state.error} onRetry={() => void state.reload()} />
      ) : data ? (
        <div className="grid gap-6">
          <IdentityCard data={data} save={save} />
          <BannersCard data={data} save={save} />
          <HistoryCard data={data} />
        </div>
      ) : null}
    </>
  );
}

// ─── Logo, mobile logo, favicon ──────────────────────────────────────────────

function IdentityCard({ data, save }: { data: AdminBranding; save: (patch: BrandingPatch, success: string) => Promise<boolean> }) {
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  const hasLogo = data.logoUrl !== null || data.mobileLogoUrl !== null;

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Palette className="size-5 text-brand-600" /> لوگو و آیکن‌ها
        </span>
      }
      action={
        <Button variant="secondary" size="sm" icon={<RotateCcw className="size-4" />} disabled={!hasLogo} onClick={() => setConfirmReset(true)}>
          حذف لوگو و بازگشت به لوگوی پیش‌فرض
        </Button>
      }
    >
      <div className="grid gap-4 md:grid-cols-3">
        <LogoSlot
          label="لوگوی اصلی (سربرگ و پابرگ)"
          hint="PNG شفاف، SVG یا WEBP — افقی؛ حداکثر در ۸۰۰×۲۴۰ جا می‌گیرد."
          slot="logo"
          field="logoUrl"
          url={data.logoUrl}
          updatedAt={data.updatedAt.logoUrl}
          save={save}
          wide
        />
        <LogoSlot
          label="لوگوی موبایل / آیکن اپ"
          hint="مربعی یا فشرده؛ در نمایشگر کوچک و آیکن صفحهٔ اصلی گوشی. خالی = همان لوگوی اصلی."
          slot="mobile_logo"
          field="mobileLogoUrl"
          url={data.mobileLogoUrl}
          updatedAt={data.updatedAt.mobileLogoUrl}
          save={save}
        />
        <LogoSlot
          label="فاوآیکن (آیکن تب مرورگر)"
          hint="مربعی؛ به ۵۱۲×۵۱۲ شفاف تبدیل می‌شود. خالی = آیکن پیش‌فرض مرورگر."
          slot="favicon"
          field="faviconUrl"
          url={data.faviconUrl}
          updatedAt={data.updatedAt.faviconUrl}
          save={save}
        />
      </div>

      <Modal
        open={confirmReset}
        title="بازگشت به لوگوی پیش‌فرض"
        onClose={() => setConfirmReset(false)}
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmReset(false)}>
              انصراف
            </Button>
            <Button
              variant="danger"
              loading={resetting}
              onClick={async () => {
                setResetting(true);
                const ok = await save({ logoUrl: null, mobileLogoUrl: null }, 'لوگو حذف شد؛ لوگوی پیش‌فرض نمایش داده می‌شود.');
                setResetting(false);
                if (ok) setConfirmReset(false);
              }}
            >
              حذف لوگو
            </Button>
          </>
        }
      >
        <p className="text-sm leading-7 text-slate-600">
          لوگوی اصلی و لوگوی موبایل حذف می‌شوند و سایت دوباره نشان پیش‌فرض «{PLATFORM_MONOGRAM}» و نام «{PLATFORM_NAME}» را نمایش می‌دهد. فاوآیکن تغییر نمی‌کند.
        </p>
      </Modal>
    </Card>
  );
}

function LogoSlot({
  label,
  hint,
  slot,
  field,
  url,
  updatedAt,
  save,
  wide = false,
}: {
  label: string;
  hint: string;
  slot: BrandingSlot;
  field: LogoField;
  url: string | null;
  updatedAt: string | null;
  save: (patch: BrandingPatch, success: string) => Promise<boolean>;
  wide?: boolean;
}) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);

  async function onFile(file: File | undefined) {
    if (!file) return;
    const problem = fileProblem(file, slot);
    if (problem) {
      toast.error(problem);
      return;
    }
    setBusy(true);
    setProgress(0);
    try {
      const asset = await apiUploadWithFields<BrandingAsset>('/admin/branding/assets', file, { slot }, setProgress);
      await save({ [field]: asset.url }, `${label} به‌روزرسانی شد.`);
    } catch (error) {
      toast.error(toApiError(error).message);
    } finally {
      setBusy(false);
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-slate-200 p-4" data-testid={`branding-slot-${slot}`}>
      <div>
        <p className="text-sm font-bold text-slate-800">{label}</p>
        <p className="mt-1 text-xs leading-6 text-slate-500">{hint}</p>
      </div>
      <div className={`flex h-28 items-center justify-center overflow-hidden rounded-xl border border-slate-200 ${checkerboard}`}>
        {url && !broken ? (
          // eslint-disable-next-line @next/next/no-img-element -- admin preview of an uploaded asset.
          <img src={url} alt={label} className={`${wide ? 'max-h-20 max-w-[90%]' : 'size-20'} object-contain`} onError={() => setBroken(true)} data-testid={`branding-preview-${slot}`} />
        ) : (
          <div className="flex items-center gap-2 text-brand-700" data-testid={`branding-default-${slot}`}>
            <span className="flex size-10 items-center justify-center rounded-xl bg-brand-600 text-lg font-black text-white">{PLATFORM_MONOGRAM}</span>
            <span className="text-xs text-slate-500">{broken ? 'تصویر بارگذاری نشد' : 'پیش‌فرض'}</span>
          </div>
        )}
      </div>
      <p className="text-xs text-slate-400">{updatedAt ? `آخرین تغییر: ${formatDateTime(updatedAt)}` : 'تاکنون تنظیم نشده'}</p>
      <input
        ref={inputRef}
        type="file"
        accept={slot === 'hero_banner' ? RASTER_ACCEPT : LOGO_ACCEPT}
        className="hidden"
        aria-label={`انتخاب فایل ${label}`}
        onChange={(event) => void onFile(event.target.files?.[0])}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" loading={busy} icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>
          {busy && progress !== null ? `در حال بارگذاری ${toPersianDigits(Math.round(progress * 100))}٪` : url ? 'تعویض تصویر' : 'بارگذاری تصویر'}
        </Button>
        {url && field !== 'logoUrl' ? (
          <Button size="sm" variant="ghost" icon={<Trash2 className="size-4" />} disabled={busy} onClick={() => void save({ [field]: null }, `${label} حذف شد.`)}>
            حذف
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ─── Hero banners ────────────────────────────────────────────────────────────

function BannersCard({ data, save }: { data: AdminBranding; save: (patch: BrandingPatch, success: string) => Promise<boolean> }) {
  const [draft, setDraft] = useState<DraftBanner[]>(() => toDraft(data.heroBanners));
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const serverDraft = useMemo(() => toDraft(data.heroBanners), [data.heroBanners]);
  const dirty = JSON.stringify(toPayload(draft)) !== JSON.stringify(toPayload(serverDraft));

  // A save (here or elsewhere on the page) returns the new server state.
  useEffect(() => setDraft(serverDraft), [serverDraft]);

  const invalidLinks = draft.filter((banner) => banner.linkUrl.trim() !== '' && !isValidBannerLink(banner.linkUrl.trim()));
  const activeCount = draft.filter((banner) => banner.isActive).length;

  const update = (key: string, change: Partial<DraftBanner>) => setDraft((list) => list.map((banner) => (banner.key === key ? { ...banner, ...change } : banner)));
  const move = (from: number, to: number) =>
    setDraft((list) => {
      if (to < 0 || to >= list.length) return list;
      const next = [...list];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item!);
      return next;
    });

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Images className="size-5 text-brand-600" /> بنرهای صفحهٔ اصلی
          <Badge tone="info">
            {toPersianDigits(activeCount)} فعال از {toPersianDigits(draft.length)}
          </Badge>
        </span>
      }
      action={
        <Button size="sm" icon={<ImagePlus className="size-4" />} disabled={draft.length >= MAX_BANNERS} onClick={() => setAdding(true)}>
          افزودن بنر جدید
        </Button>
      }
    >
      <p className="mb-4 text-xs leading-6 text-slate-500">
        اندازهٔ پیشنهادی ۱۹۲۰×۶۴۰ پیکسل (نسبت ۳ به ۱؛ در موبایل ۲ به ۱ برش می‌خورد). حداکثر {toPersianDigits(MAX_BANNERS)} بنر. ترتیب را با کشیدن یا دکمه‌های بالا/پایین تغییر دهید و در پایان «ذخیرهٔ تغییرات بنرها» را بزنید. اگر هیچ بنر فعالی نباشد، بخش معرفی پیش‌فرض نمایش داده می‌شود.
      </p>

      {draft.length === 0 ? (
        <EmptyState icon={<Images className="size-8" />} title="هنوز بنری اضافه نشده است" description="صفحهٔ اصلی بخش معرفی پیش‌فرض را نمایش می‌دهد." />
      ) : (
        <ol className="flex flex-col gap-3" data-testid="banner-list">
          {draft.map((banner, index) => {
            const linkInvalid = banner.linkUrl.trim() !== '' && !isValidBannerLink(banner.linkUrl.trim());
            return (
              <li
                key={banner.key}
                draggable
                onDragStart={() => setDragKey(banner.key)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => {
                  const from = draft.findIndex((item) => item.key === dragKey);
                  if (from >= 0) move(from, index);
                  setDragKey(null);
                }}
                onDragEnd={() => setDragKey(null)}
                className={`flex flex-col gap-3 rounded-2xl border p-3 md:flex-row md:items-start ${dragKey === banner.key ? 'border-brand-400 bg-brand-50' : 'border-slate-200'} ${banner.isActive ? '' : 'opacity-70'}`}
                data-testid="banner-row"
              >
                <div className="flex items-center gap-2 md:pt-6">
                  <GripVertical className="size-5 cursor-grab text-slate-400" aria-hidden />
                  <span className="w-5 text-center text-sm font-bold text-slate-500">{toPersianDigits(index + 1)}</span>
                </div>
                {/* eslint-disable-next-line @next/next/no-img-element -- admin preview of an uploaded banner. */}
                <img src={banner.imageUrl} alt="" loading="lazy" className="aspect-[3/1] w-full rounded-xl border border-slate-200 object-cover md:w-60" />
                <div className="grid flex-1 gap-2 sm:grid-cols-2">
                  <Field label="عنوان (اختیاری)">
                    {(id, describedBy) => <Input id={id} aria-describedby={describedBy} value={banner.title} maxLength={120} onChange={(event) => update(banner.key, { title: event.target.value })} placeholder="مثلاً حراج پاییزه" />}
                  </Field>
                  <Field label="لینک (اختیاری)" error={linkInvalid ? 'مسیر داخلی (/…) یا نشانی https://' : undefined}>
                    {(id, describedBy) => <Input id={id} aria-describedby={describedBy} dir="ltr" value={banner.linkUrl} maxLength={500} onChange={(event) => update(banner.key, { linkUrl: event.target.value })} placeholder="/search?categorySlug=fashion" />}
                  </Field>
                  <Checkbox label="فعال (نمایش در سایت)" checked={banner.isActive} onChange={(event) => update(banner.key, { isActive: event.target.checked })} />
                </div>
                <div className="flex gap-1 md:flex-col">
                  <Button size="sm" variant="ghost" aria-label="انتقال به بالا" disabled={index === 0} onClick={() => move(index, index - 1)} icon={<ArrowUp className="size-4" />} />
                  <Button size="sm" variant="ghost" aria-label="انتقال به پایین" disabled={index === draft.length - 1} onClick={() => move(index, index + 1)} icon={<ArrowDown className="size-4" />} />
                  <Button size="sm" variant="ghost" aria-label="حذف بنر" onClick={() => setDraft((list) => list.filter((item) => item.key !== banner.key))} icon={<Trash2 className="size-4 text-rose-600" />} />
                </div>
              </li>
            );
          })}
        </ol>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-4">
        <Button
          icon={<Save className="size-4" />}
          loading={saving}
          disabled={!dirty || invalidLinks.length > 0}
          onClick={async () => {
            setSaving(true);
            await save({ heroBanners: toPayload(draft) }, 'بنرها ذخیره شدند.');
            setSaving(false);
          }}
        >
          ذخیرهٔ تغییرات بنرها
        </Button>
        <Button variant="secondary" disabled={!dirty || saving} onClick={() => setDraft(serverDraft)}>
          لغو تغییرات
        </Button>
        {dirty ? <span className="text-xs text-amber-700">تغییرات ذخیره‌نشده دارید.</span> : null}
        {invalidLinks.length > 0 ? <span className="text-xs text-rose-600">لینک برخی بنرها معتبر نیست.</span> : null}
      </div>

      <AddBannerModal
        open={adding}
        onClose={() => setAdding(false)}
        onAdd={(banner) => {
          setDraft((list) => [...list, banner]);
          setAdding(false);
        }}
      />
    </Card>
  );
}

function AddBannerModal({ open, onClose, onAdd }: { open: boolean; onClose: () => void; onAdd: (banner: DraftBanner) => void }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [asset, setAsset] = useState<BrandingAsset | null>(null);
  const [title, setTitle] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    if (open) {
      setAsset(null);
      setTitle('');
      setLinkUrl('');
      setIsActive(true);
      setProgress(null);
    }
  }, [open]);

  const linkInvalid = linkUrl.trim() !== '' && !isValidBannerLink(linkUrl.trim());

  async function onFile(file: File | undefined) {
    if (!file) return;
    const problem = fileProblem(file, 'hero_banner');
    if (problem) {
      toast.error(problem);
      return;
    }
    setProgress(0);
    try {
      setAsset(await apiUploadWithFields<BrandingAsset>('/admin/branding/assets', file, { slot: 'hero_banner' }, setProgress));
    } catch (error) {
      toast.error(toApiError(error).message);
    } finally {
      setProgress(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  }

  return (
    <Modal
      open={open}
      title="افزودن بنر جدید"
      onClose={onClose}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button
            disabled={!asset || linkInvalid}
            onClick={() =>
              asset &&
              onAdd({ key: `new-${asset.id}`, imageUrl: asset.url, title: title.trim(), linkUrl: linkUrl.trim(), isActive })
            }
          >
            افزودن به فهرست
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <div className={`flex aspect-[3/1] items-center justify-center overflow-hidden rounded-xl border border-dashed border-slate-300 ${asset ? '' : 'bg-slate-50'}`}>
          {asset ? (
            // eslint-disable-next-line @next/next/no-img-element -- preview of the uploaded banner.
            <img src={asset.url} alt="" className="size-full object-cover" data-testid="new-banner-preview" />
          ) : (
            <Button variant="secondary" loading={progress !== null} icon={<Upload className="size-4" />} onClick={() => inputRef.current?.click()}>
              {progress !== null ? `در حال بارگذاری ${toPersianDigits(Math.round(progress * 100))}٪` : 'انتخاب تصویر بنر'}
            </Button>
          )}
        </div>
        {asset ? (
          <p className="text-xs text-slate-500">
            {toPersianDigits(asset.width)}×{toPersianDigits(asset.height)} پیکسل، WebP — {toPersianDigits(Math.round(asset.sizeBytes / 1024))} کیلوبایت{' '}
            <button type="button" className="text-brand-700 hover:underline" onClick={() => inputRef.current?.click()}>
              تعویض تصویر
            </button>
          </p>
        ) : (
          <p className="text-xs text-slate-500">PNG، JPEG یا WEBP؛ حداقل عرض ۸۰۰ پیکسل، حداکثر ۵ مگابایت. پیشنهاد: ۱۹۲۰×۶۴۰.</p>
        )}
        <input ref={inputRef} type="file" accept={RASTER_ACCEPT} className="hidden" aria-label="انتخاب فایل بنر" onChange={(event) => void onFile(event.target.files?.[0])} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="عنوان (اختیاری)">
            {(id, describedBy) => <Input id={id} aria-describedby={describedBy} value={title} maxLength={120} onChange={(event) => setTitle(event.target.value)} placeholder="مثلاً حراج پاییزه" />}
          </Field>
          <Field label="لینک (اختیاری)" hint="مثال: /search?categorySlug=fashion" error={linkInvalid ? 'مسیر داخلی (/…) یا نشانی https://' : undefined}>
            {(id, describedBy) => <Input id={id} aria-describedby={describedBy} dir="ltr" value={linkUrl} maxLength={500} onChange={(event) => setLinkUrl(event.target.value)} placeholder="/search?categorySlug=fashion" />}
          </Field>
        </div>
        <Checkbox label="فعال (نمایش در سایت پس از ذخیره)" checked={isActive} onChange={(event) => setIsActive(event.target.checked)} />
      </div>
    </Modal>
  );
}

// ─── History ─────────────────────────────────────────────────────────────────

function HistoryCard({ data }: { data: AdminBranding }) {
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <History className="size-5 text-brand-600" /> تاریخچهٔ تغییرات
        </span>
      }
    >
      {data.history.length === 0 ? (
        <p className="text-sm text-slate-500">هنوز تغییری ثبت نشده است.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm" data-testid="branding-history">
          {data.history.map((entry) => (
            <li key={entry.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="text-slate-700">
                {entry.actor?.fullName || 'کاربر حذف‌شده'} — {entry.changedFields.map((field) => BRANDING_FIELD_LABELS[field] ?? field).join('، ') || 'بدون تغییر'}
              </span>
              <span className="text-xs text-slate-400">{formatDateTime(entry.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
