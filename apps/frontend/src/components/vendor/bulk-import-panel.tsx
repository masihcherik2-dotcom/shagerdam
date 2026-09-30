'use client';

import { CircleAlert, ClipboardPaste, ExternalLink, ImageOff, Link2, PauseCircle, PlayCircle, RefreshCw, Rocket, ScanSearch, Store } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { Badge, Money, ProgressBar, StatusBadge } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/states';
import { apiGet, apiPost } from '@/lib/api/client';
import { toApiError, type ApiError } from '@/lib/api/errors';
import type { BulkExtractResponse, BulkItem, BulkItemStatus, BulkJob, BulkOptions, BulkPriceUnit, CategoryTree, CrawlStoreResponse } from '@/lib/api/types';
import {
  BULK_DAILY_LIMIT,
  BULK_MAX_PRODUCT_OPTIONS,
  BULK_MAX_URLS,
  BULK_POLL_INTERVAL_MS,
  MAX_SITEMAP_PASTE_LENGTH,
  bulkErrorMessage,
  bulkItemStatusLabels,
  bulkJobStatusLabels,
  describeBulkItem,
  isRetryableItem,
  normalizeStoreUrl,
  priceUnitLabels,
  productUrlLabel,
  retryableCount,
} from '@/lib/bulk-import';
import { formatDate, toLatinDigits, toPersianDigits } from '@/lib/format';
import { useApi } from '@/lib/hooks/use-api';
import { flattenCategories } from '@/lib/product-form';

/** Crawling reads up to 25 sitemap documents on the server (≤ 40 s). */
const CRAWL_TIMEOUT_MS = 60_000;

/** Base route of the whole-store importer (vendor routes by default; staff use the per-store admin routes). */
export interface BulkImportEndpoints {
  base: string;
}

export const VENDOR_BULK_ENDPOINTS: BulkImportEndpoints = { base: '/vendor/products/import' };

export function adminBulkEndpoints(vendorId: string): BulkImportEndpoints {
  return { base: `/admin/vendors/${encodeURIComponent(vendorId)}/products/import` };
}

interface BulkImportPanelProps {
  endpoints?: BulkImportEndpoints;
  /** Staff import without the vendors' daily cap. */
  staff?: boolean;
  /** Link of a created product (vendor: the editor; staff: the storefront page once published), or null. */
  productLink: (product: NonNullable<BulkItem['product']>) => { href: string; label: string } | null;
  /** Opens a page in the single-product importer (for items that need the vendor's input). */
  onOpenInSingleImporter?: (url: string) => void;
}

type ItemFilter = 'ALL' | BulkItemStatus;

const FILTERS: Array<{ value: ItemFilter; label: string }> = [
  { value: 'ALL', label: 'همه' },
  { value: 'SUCCEEDED', label: 'ساخته شد' },
  { value: 'NEEDS_REVIEW', label: 'نیاز به بررسی' },
  { value: 'FAILED', label: 'ناموفق' },
  { value: 'SKIPPED', label: 'تکراری' },
  { value: 'PENDING', label: 'در صف' },
];

/**
 * «Import the whole store»: scan a store's sitemaps for product pages
 * (POST …/crawl-store — or parse a pasted sitemap / list of links when the
 * store cannot be reached from our server), then import them all as a
 * background job (POST …/bulk-extract). The job runs on the server; this
 * panel polls GET …/bulk-jobs/:id every 2 s, and on return shows the store's
 * latest job (GET …/bulk-jobs/latest) so closing the window loses nothing.
 */
export function BulkImportPanel({ endpoints = VENDOR_BULK_ENDPOINTS, staff = false, productLink, onOpenInSingleImporter }: BulkImportPanelProps) {
  const base = endpoints.base;
  const tree = useApi<CategoryTree>('/categories/tree');
  const categories = useMemo(() => (tree.data ? flattenCategories(tree.data.items) : []), [tree.data]);

  // Scan
  const [storeUrl, setStoreUrl] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  const [maxProducts, setMaxProducts] = useState<number>(BULK_MAX_URLS);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scan, setScan] = useState<CrawlStoreResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Options (used by a new job and by retries)
  const [priceUnit, setPriceUnit] = useState<BulkPriceUnit>('AUTO');
  const [defaultStock, setDefaultStock] = useState('10');
  const [defaultCategoryId, setDefaultCategoryId] = useState('');
  const [autoPublish, setAutoPublish] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  // Job
  const [job, setJob] = useState<BulkJob | null>(null);
  const [loadingLatest, setLoadingLatest] = useState(true);
  const [latestError, setLatestError] = useState<ApiError | null>(null);
  const [view, setView] = useState<'setup' | 'job'>('setup');
  const [busy, setBusy] = useState<'start' | 'retry' | 'cancel' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pollTrouble, setPollTrouble] = useState(false);
  const [filter, setFilter] = useState<ItemFilter>('ALL');
  const startedRef = useRef(false);

  const showJob = useCallback((next: BulkJob) => {
    setJob(next);
    setView('job');
  }, []);

  // A retry defaults to the options the job ran with (also after a reload); the vendor can change them before retrying.
  const loadedJobId = job?.id;
  const jobOptions = job?.options;
  const optionsSourceRef = useRef<string | null>(null);
  useEffect(() => {
    if (!loadedJobId || !jobOptions || optionsSourceRef.current === loadedJobId) return;
    optionsSourceRef.current = loadedJobId;
    setPriceUnit(jobOptions.priceUnit);
    setDefaultStock(String(jobOptions.defaultStock));
    setDefaultCategoryId(jobOptions.defaultCategoryId ?? '');
    setAutoPublish(jobOptions.autoPublish);
  }, [loadedJobId, jobOptions]);

  const loadLatest = useCallback(async () => {
    setLoadingLatest(true);
    setLatestError(null);
    try {
      const latest = await apiGet<{ job: BulkJob | null }>(`${base}/bulk-jobs/latest`);
      if (latest.job && !startedRef.current) showJob(latest.job);
    } catch (error) {
      setLatestError(toApiError(error));
    } finally {
      setLoadingLatest(false);
    }
  }, [base, showJob]);

  useEffect(() => {
    void loadLatest();
  }, [loadLatest]);

  // Poll the running job every 2 s; transient errors keep polling (slower) and show a notice.
  const jobId = job?.id;
  const running = job?.status === 'RUNNING';
  useEffect(() => {
    if (!jobId || !running) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const tick = async () => {
      try {
        const next = await apiGet<BulkJob>(`${base}/bulk-jobs/${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        failures = 0;
        setPollTrouble(false);
        setJob(next);
        if (next.status !== 'RUNNING') return;
      } catch {
        if (cancelled) return;
        failures += 1;
        setPollTrouble(true);
      }
      timer = setTimeout(() => void tick(), BULK_POLL_INTERVAL_MS * Math.min(1 + failures, 5));
    };
    timer = setTimeout(() => void tick(), BULK_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [base, jobId, running]);

  function readOptions(): BulkOptions | null {
    const stock = Number(toLatinDigits(defaultStock.trim()));
    if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) {
      setOptionsError('موجودی پیش‌فرض باید عددی صحیح و نامنفی باشد.');
      return null;
    }
    setOptionsError(null);
    return { priceUnit, defaultStock: stock, defaultCategoryId: defaultCategoryId || null, autoPublish };
  }

  async function runScan(event: FormEvent) {
    event.preventDefault();
    const pasted = pasteOpen ? pasteText.trim() : '';
    const address = storeUrl.trim() === '' ? null : normalizeStoreUrl(storeUrl);
    if (storeUrl.trim() !== '' && address === null) {
      setScanError('نشانی فروشگاه معتبر نیست؛ مانند https://zarrinmetal.ir وارد کنید.');
      return;
    }
    if (address === null && pasted === '') {
      setScanError(pasteOpen ? 'نشانی فروشگاه را وارد کنید یا متن نقشهٔ سایت / فهرست لینک‌ها را بچسبانید.' : 'نشانی فروشگاه را وارد کنید.');
      return;
    }
    if (pasted.length > MAX_SITEMAP_PASTE_LENGTH) {
      setScanError(`متن چسبانده‌شده بیش از ${toPersianDigits(Math.round(MAX_SITEMAP_PASTE_LENGTH / 1000))} هزار نویسه است؛ فقط نقشهٔ محصولات را بچسبانید.`);
      return;
    }
    setScanError(null);
    setScanning(true);
    try {
      const body = { ...(address ? { storeUrl: address } : {}), ...(pasted ? { sitemapContent: pasted } : {}), maxProducts };
      const result = await apiPost<CrawlStoreResponse>(`${base}/crawl-store`, body, { timeout: CRAWL_TIMEOUT_MS });
      setScan(result);
      setSelected(new Set(result.productUrls));
      if (address) setStoreUrl(address);
    } catch (error) {
      setScan(null);
      setScanError(bulkErrorMessage(toApiError(error), 'crawl'));
    } finally {
      setScanning(false);
    }
  }

  async function startImport() {
    if (!scan) return;
    const urls = scan.productUrls.filter((url) => selected.has(url));
    if (urls.length === 0) {
      setActionError('دست‌کم یک محصول را انتخاب کنید.');
      return;
    }
    const options = readOptions();
    if (!options) return;
    setBusy('start');
    setActionError(null);
    try {
      const started = await apiPost<BulkExtractResponse>(`${base}/bulk-extract`, { urls, storeUrl: scan.storeUrl || null, ...options });
      startedRef.current = true;
      const fresh = await apiGet<BulkJob>(`${base}/bulk-jobs/${encodeURIComponent(started.jobId)}`);
      setScan(null);
      setFilter('ALL');
      showJob(fresh);
    } catch (error) {
      const apiError = toApiError(error);
      const details = (apiError.details ?? {}) as { jobId?: unknown };
      if (apiError.code === 'BULK_JOB_RUNNING' && typeof details.jobId === 'string') {
        // Another tab (or colleague) already runs an import of this store: show it.
        try {
          showJob(await apiGet<BulkJob>(`${base}/bulk-jobs/${encodeURIComponent(details.jobId)}`));
        } catch {
          /* the message below still explains the conflict */
        }
      }
      setActionError(bulkErrorMessage(apiError, 'start'));
    } finally {
      setBusy(null);
    }
  }

  async function retry(itemIndexes?: number[]) {
    if (!job) return;
    const options = readOptions();
    if (!options) return;
    setBusy('retry');
    setActionError(null);
    try {
      showJob(await apiPost<BulkJob>(`${base}/bulk-jobs/${encodeURIComponent(job.id)}/retry`, { ...options, ...(itemIndexes ? { itemIndexes } : {}) }));
    } catch (error) {
      setActionError(bulkErrorMessage(toApiError(error), 'start'));
    } finally {
      setBusy(null);
    }
  }

  async function cancel() {
    if (!job) return;
    setBusy('cancel');
    setActionError(null);
    try {
      showJob(await apiPost<BulkJob>(`${base}/bulk-jobs/${encodeURIComponent(job.id)}/cancel`, {}));
    } catch (error) {
      setActionError(toApiError(error).message);
    } finally {
      setBusy(null);
    }
  }

  function toggle(url: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  const optionsFields = (
    <div className="grid gap-4 md:grid-cols-2" data-testid="bulk-options">
      <Field label="واحد قیمت در سایت مبدأ" hint="اگر سایت واحد را کنار قیمت ننوشته، تومان یا ریال را مشخص کنید. قیمت‌های دیجی‌کالا همیشه درست تبدیل می‌شوند.">
        {(id, described) => (
          <Select id={id} aria-describedby={described} value={priceUnit} onChange={(event) => setPriceUnit(event.target.value as BulkPriceUnit)}>
            {(Object.keys(priceUnitLabels) as BulkPriceUnit[]).map((unit) => (
              <option key={unit} value={unit}>
                {priceUnitLabels[unit]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      <Field label="موجودی پیش‌فرض کالاهای موجود" hint="سایت‌ها تعداد موجودی را اعلام نمی‌کنند؛ کالاهای ناموجود با موجودی صفر ساخته می‌شوند." error={optionsError}>
        {(id, described) => <Input id={id} aria-describedby={described} inputMode="numeric" dir="ltr" value={defaultStock} onChange={(event) => setDefaultStock(event.target.value)} />}
      </Field>
      <Field label="دستهٔ پیش‌فرض" hint="برای محصولاتی که دسته‌شان با دسته‌های شاگردم منطبق نیست؛ بدون آن، این محصولات «نیاز به بررسی» می‌شوند.">
        {(id, described) =>
          tree.loading && !tree.data ? (
            <Skeleton className="h-10" />
          ) : (
            <Select id={id} aria-describedby={described} value={defaultCategoryId} onChange={(event) => setDefaultCategoryId(event.target.value)}>
              <option value="">بدون دستهٔ پیش‌فرض</option>
              {categories.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          )
        }
      </Field>
      <div className="flex items-end pb-2">
        <Checkbox label="محصولات بلافاصله در فروشگاه منتشر شوند" checked={autoPublish} onChange={(event) => setAutoPublish(event.target.checked)} />
      </div>
    </div>
  );

  if (loadingLatest && !job) {
    return <Skeleton className="h-48" />;
  }

  // ── Job view ──────────────────────────────────────────────────────────────
  if (view === 'job' && job) {
    const retryable = retryableCount(job);
    const items = filter === 'ALL' ? job.items : job.items.filter((item) => item.status === filter);
    const reviewAndFailed = job.items.filter((item) => item.status === 'FAILED' || item.status === 'NEEDS_REVIEW').map((item) => item.index);
    return (
      <div className="flex flex-col gap-5" data-testid="bulk-job">
        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Store className="size-5 shrink-0 text-brand-600" />
              <span className="truncate font-bold text-slate-900" dir="ltr">
                {job.storeUrl || 'لینک‌های چسبانده‌شده'}
              </span>
              <StatusBadge value={job.status} map={bulkJobStatusLabels} />
            </div>
            <span className="text-xs text-slate-500">شروع: {formatDate(job.createdAt)}</span>
          </div>
          <div className="mt-4 flex items-center gap-3">
            <div className="flex-1">
              <ProgressBar value={job.progressPercent / 100} tone={job.status === 'INTERRUPTED' ? 'danger' : job.status === 'RUNNING' ? 'brand' : 'success'} label="پیشرفت درون‌ریزی" />
            </div>
            <span className="w-24 text-left text-sm font-bold text-slate-800" data-testid="bulk-progress">
              {toPersianDigits(job.processed)} از {toPersianDigits(job.total)}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <Badge tone="success">ساخته شد: {toPersianDigits(job.counts.succeeded)}</Badge>
            <Badge tone="warning">نیاز به بررسی: {toPersianDigits(job.counts.needsReview)}</Badge>
            <Badge tone="danger">ناموفق: {toPersianDigits(job.counts.failed)}</Badge>
            <Badge tone="neutral">تکراری: {toPersianDigits(job.counts.skipped)}</Badge>
            <Badge tone="info">در صف: {toPersianDigits(job.counts.pending + job.counts.processing)}</Badge>
          </div>
          {job.status === 'RUNNING' ? (
            <p className="mt-3 text-xs text-slate-600">درون‌ریزی روی سرور انجام می‌شود؛ می‌توانید این صفحه را ببندید و بعداً برگردید.</p>
          ) : null}
          {job.status === 'INTERRUPTED' ? (
            <p className="mt-3 text-sm text-rose-700">اجرای این درون‌ریزی روی سرور قطع شد (مثلاً با راه‌اندازی دوبارهٔ سرور). با «ادامهٔ درون‌ریزی» موارد باقی‌مانده بدون تکرار انجام می‌شوند.</p>
          ) : null}
          {pollTrouble ? <p className="mt-3 text-xs text-amber-700">ارتباط با سرور برای به‌روزرسانی وضعیت برقرار نشد؛ دوباره تلاش می‌کنیم…</p> : null}
        </div>

        {job.status !== 'RUNNING' && retryable > 0 ? (
          <details className="rounded-2xl border border-slate-200 p-4" open={job.counts.needsReview > 0}>
            <summary className="cursor-pointer text-sm font-medium text-slate-800">تنظیمات تلاش دوباره (واحد قیمت، دستهٔ پیش‌فرض، …)</summary>
            <div className="mt-4">{optionsFields}</div>
          </details>
        ) : null}

        <div className="flex flex-wrap gap-2">
          {job.status === 'RUNNING' ? (
            <Button variant="secondary" loading={busy === 'cancel'} icon={<PauseCircle className="size-4" />} onClick={() => void cancel()} data-testid="bulk-cancel">
              توقف درون‌ریزی
            </Button>
          ) : null}
          {job.status !== 'RUNNING' && (job.counts.pending > 0 || job.counts.processing > 0) ? (
            <Button loading={busy === 'retry'} icon={<PlayCircle className="size-4" />} onClick={() => void retry(job.items.filter((item) => item.status === 'PENDING' || item.status === 'PROCESSING').map((item) => item.index))} data-testid="bulk-resume">
              ادامهٔ درون‌ریزی ({toPersianDigits(job.counts.pending + job.counts.processing)} مورد)
            </Button>
          ) : null}
          {job.status !== 'RUNNING' && reviewAndFailed.length > 0 ? (
            <Button variant="secondary" loading={busy === 'retry'} icon={<RefreshCw className="size-4" />} onClick={() => void retry(reviewAndFailed)} data-testid="bulk-retry">
              تلاش دوباره برای ناموفق‌ها و موارد نیازمند بررسی ({toPersianDigits(reviewAndFailed.length)})
            </Button>
          ) : null}
          {job.status !== 'RUNNING' ? (
            <Button
              variant="ghost"
              icon={<ScanSearch className="size-4" />}
              onClick={() => {
                setView('setup');
                setActionError(null);
              }}
              data-testid="bulk-new"
            >
              درون‌ریزی تازه
            </Button>
          ) : null}
        </div>
        <FormError message={actionError} />

        <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="صافی وضعیت">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={filter === option.value}
              onClick={() => setFilter(option.value)}
              className={`rounded-full px-3 py-1 text-xs font-medium ${filter === option.value ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'}`}
            >
              {option.label}
            </button>
          ))}
        </div>

        {items.length === 0 ? (
          <p className="rounded-xl bg-slate-50 p-4 text-center text-sm text-slate-500">موردی با این وضعیت نیست.</p>
        ) : (
          <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" data-testid="bulk-items">
            {items.map((item) => (
              <BulkItemCard
                key={item.index}
                item={item}
                productLink={productLink}
                onOpenInSingleImporter={onOpenInSingleImporter}
                onRetry={job.status !== 'RUNNING' && isRetryableItem(item) && item.status !== 'PENDING' ? () => void retry([item.index]) : undefined}
                retrying={busy === 'retry'}
              />
            ))}
          </ul>
        )}
      </div>
    );
  }

  // ── Setup: scan + choose + start ───────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5" data-testid="bulk-setup">
      {latestError ? <FormError message={`آخرین درون‌ریزی بارگیری نشد: ${latestError.message}`} /> : null}
      {job ? (
        <button type="button" className="self-start text-sm text-brand-700 underline" onClick={() => setView('job')}>
          بازگشت به آخرین درون‌ریزی ({bulkJobStatusLabels[job.status].label})
        </button>
      ) : null}
      <p className="text-sm leading-7 text-slate-600">
        نشانی فروشگاه اینترنتی خود (ووکامرس، شاپیفای یا سایت اختصاصی) را وارد کنید تا صفحه‌های محصول از نقشهٔ سایت (sitemap) پیدا شوند؛ سپس همه را یک‌جا با عنوان، مشخصات، قیمت،
        دسته‌بندی و تصاویر به فروشگاه شاگردم بیاورید. محصولاتی که قیمت یا دسته‌شان مشخص نیست ساخته نمی‌شوند و برای بررسی علامت می‌خورند.
      </p>
      <form onSubmit={(event) => void runScan(event)} noValidate className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <Field label="نشانی فروشگاه" className="flex-1">
            {(id, described) => (
              <div className="relative">
                <Link2 className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" />
                <Input id={id} aria-describedby={described} dir="ltr" inputMode="url" placeholder="https://zarrinmetal.ir" className="pl-9" value={storeUrl} onChange={(event) => setStoreUrl(event.target.value)} data-testid="bulk-store-url" />
              </div>
            )}
          </Field>
          <Field label="حداکثر محصول" className="md:w-40">
            {(id) => (
              <Select id={id} value={maxProducts} onChange={(event) => setMaxProducts(Number(event.target.value))}>
                {BULK_MAX_PRODUCT_OPTIONS.map((count) => (
                  <option key={count} value={count}>
                    {toPersianDigits(count)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Button type="submit" loading={scanning} icon={<ScanSearch className="size-4" />} data-testid="bulk-scan">
            اسکن و شناسایی محصولات
          </Button>
        </div>
        <button type="button" className="flex items-center gap-1.5 self-start text-sm text-slate-600 hover:text-brand-700" onClick={() => setPasteOpen((open) => !open)} aria-expanded={pasteOpen}>
          <ClipboardPaste className="size-4" />
          سایت از سرور ما باز نمی‌شود (مثلاً محدودیت IP)؟ متن نقشهٔ سایت یا فهرست لینک‌ها را بچسبانید
        </button>
        {pasteOpen ? (
          <Field label="متن نقشهٔ سایت یا فهرست لینک‌ها" hint="در مرورگر خود نشانی …/product-sitemap.xml را باز کنید، همهٔ متن را کپی و اینجا بچسبانید؛ یا لینک صفحه‌های محصول را هر کدام در یک خط بنویسید. نشانی فروشگاه اختیاری است.">
            {(id, described) => (
              <Textarea id={id} aria-describedby={described} dir="ltr" rows={7} maxLength={MAX_SITEMAP_PASTE_LENGTH} className="font-mono text-xs" value={pasteText} onChange={(event) => setPasteText(event.target.value)} data-testid="bulk-paste" />
            )}
          </Field>
        ) : null}
        <FormError message={scanError} />
      </form>

      {scanning ? (
        <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 p-4 text-sm text-slate-600">
          در حال خواندن نقشهٔ سایت… (ممکن است تا یک دقیقه طول بکشد)
          <ProgressBar value={0.35} label="در حال اسکن" />
        </div>
      ) : null}

      {scan ? (
        <div className="flex flex-col gap-4 rounded-2xl border border-emerald-200 bg-emerald-50/40 p-4" data-testid="bulk-scan-result">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-bold text-slate-900">
              {toPersianDigits(scan.totalFound)} صفحهٔ محصول پیدا شد
              {scan.totalFound > scan.productUrls.length ? <span className="font-normal text-slate-600"> — {toPersianDigits(scan.productUrls.length)} مورد اول برای درون‌ریزی آماده است</span> : null}
            </p>
            <div className="flex gap-2 text-xs">
              <button type="button" className="text-brand-700 underline" onClick={() => setSelected(new Set(scan.productUrls))}>
                انتخاب همه
              </button>
              <button type="button" className="text-slate-600 underline" onClick={() => setSelected(new Set())}>
                هیچ‌کدام
              </button>
            </div>
          </div>
          {scan.warnings.length > 0 ? (
            <details className="text-xs text-amber-800">
              <summary className="cursor-pointer">
                <CircleAlert className="me-1 inline size-3.5" />
                {toPersianDigits(scan.warnings.length)} هشدار هنگام خواندن نقشهٔ سایت (جزئیات فنی)
              </summary>
              <ul className="mt-2 list-inside list-disc" dir="ltr">
                {scan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </details>
          ) : null}
          <ul className="grid max-h-80 gap-1.5 overflow-y-auto rounded-xl bg-white p-2 sm:grid-cols-2" data-testid="bulk-found-urls">
            {scan.productUrls.map((url) => (
              <li key={url}>
                <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                  <input type="checkbox" className="size-4 accent-brand-600" checked={selected.has(url)} onChange={() => toggle(url)} />
                  <span className="min-w-0 flex-1 truncate" title={url}>
                    {productUrlLabel(url)}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {optionsFields}
          <p className="text-xs text-slate-500">
            {staff
              ? 'درون‌ریزی به‌نام فروشگاه انجام می‌شود؛ تصاویر در کتابخانهٔ مالک فروشگاه ذخیره می‌شوند.'
              : `سقف درون‌ریزی گروهی ${toPersianDigits(BULK_DAILY_LIMIT)} محصول در ۲۴ ساعت است؛ برای هر محصول حداکثر ۶ تصویر دریافت می‌شود.`}
          </p>
          <Button variant="success" size="lg" loading={busy === 'start'} icon={<Rocket className="size-5" />} onClick={() => void startImport()} data-testid="bulk-start">
            درون‌ریزی همه محصولات در فروشگاه ({toPersianDigits(selected.size)})
          </Button>
          <FormError message={actionError} />
        </div>
      ) : null}
    </div>
  );
}

function BulkItemCard({
  item,
  productLink,
  onOpenInSingleImporter,
  onRetry,
  retrying,
}: {
  item: BulkItem;
  productLink: BulkImportPanelProps['productLink'];
  onOpenInSingleImporter?: (url: string) => void;
  onRetry?: () => void;
  retrying: boolean;
}) {
  const note = describeBulkItem(item);
  const link = item.product ? productLink(item.product) : null;
  const tone = item.status === 'FAILED' ? 'border-rose-200' : item.status === 'NEEDS_REVIEW' ? 'border-amber-200' : item.status === 'SUCCEEDED' ? 'border-emerald-200' : 'border-slate-200';
  return (
    <li className={`flex gap-3 rounded-2xl border bg-white p-3 ${tone}`} data-testid="bulk-item" data-status={item.status}>
      {item.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- our media URL; next/image needs configured hosts
        <img src={item.imageUrl} alt="" className="size-16 shrink-0 rounded-xl border border-slate-100 object-cover" />
      ) : (
        <div className={`flex size-16 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-400 ${item.status === 'PROCESSING' ? 'animate-pulse' : ''}`}>
          <ImageOff className="size-6" />
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex items-start justify-between gap-2">
          <p className="line-clamp-2 text-sm font-medium text-slate-900" title={item.url}>
            {item.title ?? productUrlLabel(item.url)}
          </p>
          <StatusBadge value={item.status} map={bulkItemStatusLabels} />
        </div>
        {item.price !== null ? <Money rials={item.price} className="text-sm font-bold text-slate-800" /> : null}
        {note ? <p className={`text-xs leading-5 ${item.status === 'FAILED' ? 'text-rose-700' : item.status === 'SUCCEEDED' ? 'text-slate-500' : 'text-amber-800'}`}>{note}</p> : null}
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs">
          {item.product && !item.product.isPublished ? <Badge tone="neutral">پیش‌نویس (منتشرنشده)</Badge> : null}
          {link ? (
            <Link href={link.href} className="font-medium text-brand-700 underline">
              {link.label}
            </Link>
          ) : null}
          {item.status === 'NEEDS_REVIEW' && onOpenInSingleImporter ? (
            <button type="button" className="font-medium text-amber-800 underline" onClick={() => onOpenInSingleImporter(item.url)}>
              باز کردن در واردکنندهٔ تکی
            </button>
          ) : null}
          {onRetry ? (
            <button type="button" className="text-slate-600 underline disabled:opacity-50" disabled={retrying} onClick={onRetry}>
              تلاش دوباره
            </button>
          ) : null}
          <a href={item.url} target="_blank" rel="noopener noreferrer nofollow" className="flex items-center gap-1 text-slate-400 hover:text-slate-600">
            صفحهٔ مبدأ <ExternalLink className="size-3" />
          </a>
        </div>
      </div>
    </li>
  );
}
