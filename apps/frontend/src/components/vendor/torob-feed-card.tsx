'use client';

import { Check, Copy, ExternalLink, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/misc';
import { Skeleton } from '@/components/ui/states';
import type { TorobFeedPage } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatCount } from '@/lib/format';
import { torobFeedPath } from '@/lib/torob';

/**
 * "Connect to Torob": the store's dedicated feed link, a copy button and a short
 * guide. The product count is read from the live feed itself (pageSize=1), so
 * the vendor sees exactly what Torob will see.
 */
export function TorobFeedCard({ storeSlug }: { storeSlug: string }) {
  const toast = useToast();
  const inputRef = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState(false);
  // The link is absolute on the site's own origin (nginx → BFF → API). The
  // origin is only known in the browser; render the path until it is.
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);

  const path = torobFeedPath(storeSlug);
  const feedUrl = `${origin}${path}`;
  const feed = useApi<TorobFeedPage>('/integrations/torob/products', { vendorSlug: storeSlug, pageSize: 1 });

  async function copy() {
    try {
      await navigator.clipboard.writeText(feedUrl);
    } catch {
      // Clipboard API unavailable (insecure context / permissions): select the text for a manual copy.
      inputRef.current?.select();
      toast.info('لینک انتخاب شد؛ با Ctrl+C کپی کنید.');
      return;
    }
    setCopied(true);
    toast.success('لینک اختصاصی ترب کپی شد.');
    window.setTimeout(() => setCopied(false), 2500);
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Search className="size-5 text-brand-600" /> اتصال به موتور جستجوی تُرب (Torob)
        </span>
      }
    >
      <div className="flex flex-col gap-4 text-sm">
        <p className="leading-7 text-slate-600">
          با این لینک، کالاهای فروشگاه شما با قیمت و موجودی لحظه‌ای در ترب نمایش داده می‌شوند و خریداران مستقیم به صفحهٔ کالا در فروشگاه شما هدایت می‌شوند.
        </p>

        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            ref={inputRef}
            readOnly
            dir="ltr"
            aria-label="لینک اختصاصی فید ترب"
            value={feedUrl}
            onFocus={(event) => event.currentTarget.select()}
            className="h-10 flex-1 rounded-xl border border-slate-300 bg-slate-50 px-3 font-mono text-xs text-slate-800"
          />
          <Button onClick={() => void copy()} disabled={!origin} icon={copied ? <Check className="size-4" /> : <Copy className="size-4" />}>
            {copied ? 'کپی شد' : 'کپی لینک اختصاصی برای ترب'}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {feed.loading && !feed.data ? (
            <Skeleton className="h-4 w-40" />
          ) : feed.error && !feed.data ? (
            <span className="text-rose-600">وضعیت فید دریافت نشد: {feed.error.message}</span>
          ) : feed.data ? (
            <span>
              اکنون <strong className="text-slate-800">{formatCount(feed.data.count)}</strong> کالا (تنوع) در فید شما است.
              {feed.data.count === 0 ? ' کالاهای منتشرشده و تأییدشده در فید قرار می‌گیرند.' : ''}
            </span>
          ) : null}
          {origin ? (
            <a href={feedUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-brand-700 hover:underline">
              مشاهدهٔ فید <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>

        <div className="rounded-xl bg-slate-50 p-4">
          <p className="mb-2 font-bold text-slate-800">راهنمای اتصال</p>
          <ol className="list-inside list-decimal space-y-1.5 leading-7 text-slate-600">
            <li>در پنل فروشندگان ترب ثبت‌نام کنید یا وارد حساب فروشگاه خود شوید.</li>
            <li>هنگام ثبت فروشگاه یا در درخواست اتصال محصولات، لینک بالا را به‌عنوان «API / فید محصولات» وارد کنید یا برای پشتیبانی ترب بفرستید.</li>
            <li>پس از بررسی و تأیید ترب، کالاهای منتشرشدهٔ شما نمایش داده می‌شوند. تغییر قیمت و موجودی در پنل شما خودکار در فید اعمال می‌شود.</li>
          </ol>
          <p className="mt-2 text-xs text-slate-500">فقط کالاهای منتشرشده و مسدودنشده در فید هستند؛ کالای ناموجود با وضعیت «ناموجود» اعلام می‌شود.</p>
        </div>
      </div>
    </Card>
  );
}
