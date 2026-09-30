'use client';

import { useCallback, useState } from 'react';

import { PLATFORM_MONOGRAM, PLATFORM_NAME } from '@/lib/brand';
import { useBrokenImageRef } from '@/lib/hooks/use-broken-image';

/**
 * The platform logo with a guaranteed fallback: no logo configured, or an image
 * that fails to load, shows the built-in monogram + name — never a broken image.
 *
 * `header`: desktop logo, and the mobile logo (falling back to the main logo)
 * below the `sm` breakpoint. `footer`: the main logo only.
 */
export function BrandLogo({ logoUrl, mobileLogoUrl = null, variant }: { logoUrl: string | null; mobileLogoUrl?: string | null; variant: 'header' | 'footer' }) {
  const [failed, setFailed] = useState<Record<string, true>>({});
  const usable = (url: string | null): url is string => Boolean(url) && !failed[url as string];
  const markFailed = useCallback((url: string) => setFailed((current) => (current[url] ? current : { ...current, [url]: true })), []);

  const desktop = usable(logoUrl) ? logoUrl : null;
  const mobile = variant === 'header' ? (usable(mobileLogoUrl) ? mobileLogoUrl : desktop) : null;
  // Server-rendered: catch images that already failed before hydration.
  const desktopRef = useBrokenImageRef(useCallback(() => desktop && markFailed(desktop), [desktop, markFailed]));
  const mobileRef = useBrokenImageRef(useCallback(() => mobile && markFailed(mobile), [mobile, markFailed]));

  if (variant === 'footer') {
    return desktop ? (
      // eslint-disable-next-line @next/next/no-img-element -- remote media URL of unknown aspect ratio; sized by CSS.
      <img ref={desktopRef} src={desktop} alt={PLATFORM_NAME} className="h-10 w-auto max-w-[200px] object-contain object-right" onError={() => markFailed(desktop)} data-testid="brand-logo-footer" />
    ) : (
      <p className="text-base font-black text-brand-700">{PLATFORM_NAME}</p>
    );
  }

  if (!desktop && !mobile) {
    return <Monogram />;
  }
  return (
    <>
      {mobile ? (
        // eslint-disable-next-line @next/next/no-img-element -- see above.
        <img ref={mobileRef} src={mobile} alt={PLATFORM_NAME} className="h-9 w-auto max-w-[120px] object-contain sm:hidden" onError={() => markFailed(mobile)} data-testid="brand-logo-mobile" />
      ) : (
        <span className="sm:hidden">
          <Monogram compact />
        </span>
      )}
      {desktop ? (
        // eslint-disable-next-line @next/next/no-img-element -- see above.
        <img ref={desktopRef} src={desktop} alt={PLATFORM_NAME} className="hidden h-9 w-auto max-w-[180px] object-contain sm:block" onError={() => markFailed(desktop)} data-testid="brand-logo" />
      ) : (
        <span className="hidden sm:contents">
          <Monogram />
        </span>
      )}
    </>
  );
}

function Monogram({ compact = false }: { compact?: boolean }) {
  return (
    <>
      <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white" aria-hidden data-testid="brand-monogram">
        {PLATFORM_MONOGRAM}
      </span>
      {compact ? <span className="sr-only">{PLATFORM_NAME}</span> : <span className="hidden sm:inline">{PLATFORM_NAME}</span>}
    </>
  );
}
