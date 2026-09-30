'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

import { isExternalLink, type HeroBanner } from '@/lib/branding';
import { toPersianDigits } from '@/lib/format';

const AUTOPLAY_MS = 6_000;

/**
 * Home hero carousel of the admin-managed banners (active ones only, already
 * ordered by the API).
 *
 * - autoplay every 6 s, paused on hover/focus, in a hidden tab and when the
 *   user prefers reduced motion;
 * - previous/next buttons, dots and ←/→ keys (RTL-aware: "next" is to the left);
 * - a banner whose image fails to load is dropped instead of showing a broken image;
 * - site links navigate in-app, https links open in a new tab.
 */
export function HeroCarousel({ banners: initial }: { banners: HeroBanner[] }) {
  const [broken, setBroken] = useState<Set<string>>(() => new Set());
  const banners = initial.filter((banner) => !broken.has(banner.id));
  const [index, setIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const regionRef = useRef<HTMLElement>(null);
  const count = banners.length;
  const current = count > 0 ? Math.min(index, count - 1) : 0;

  const go = useCallback((next: number) => setIndex(count > 0 ? (next + count) % count : 0), [count]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(query.matches);
    const onChange = (event: MediaQueryListEvent) => setReducedMotion(event.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  useEffect(() => {
    if (count < 2 || paused || reducedMotion) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') setIndex((value) => (value + 1) % count);
    }, AUTOPLAY_MS);
    return () => window.clearInterval(timer);
  }, [count, paused, reducedMotion]);

  if (count === 0) return null;

  const onKeyDown = (event: React.KeyboardEvent) => {
    // RTL: the next slide is to the left.
    if (event.key === 'ArrowLeft') go(current + 1);
    if (event.key === 'ArrowRight') go(current - 1);
  };

  return (
    <section
      ref={regionRef}
      aria-roledescription="carousel"
      aria-label="بنرهای ویژه"
      className="relative overflow-hidden rounded-3xl bg-slate-200"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(event) => {
        if (!regionRef.current?.contains(event.relatedTarget as Node | null)) setPaused(false);
      }}
      onKeyDown={onKeyDown}
      data-testid="hero-carousel"
    >
      <div className="relative aspect-[2/1] w-full md:aspect-[3/1]">
        {banners.map((banner, position) => {
          const active = position === current;
          const markBroken = () => setBroken((set) => (set.has(banner.id) ? set : new Set(set).add(banner.id)));
          const image = (
            // eslint-disable-next-line @next/next/no-img-element -- admin-uploaded WebP of variable aspect ratio; cropped by CSS.
            <img
              ref={(element) => {
                // Server-rendered: an image that failed before hydration never fired onError.
                if (element && element.complete && element.naturalWidth === 0) markBroken();
              }}
              src={banner.imageUrl}
              alt={banner.title ?? ''}
              className="size-full object-cover"
              loading={position === 0 ? 'eager' : 'lazy'}
              fetchPriority={position === 0 ? 'high' : 'auto'}
              onError={markBroken}
            />
          );
          return (
            <div
              key={banner.id}
              role="group"
              aria-roledescription="slide"
              aria-label={`${toPersianDigits(position + 1)} از ${toPersianDigits(count)}`}
              aria-hidden={!active}
              className={`absolute inset-0 transition-opacity duration-700 motion-reduce:transition-none ${active ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
              data-testid="hero-slide"
              data-active={active}
            >
              <BannerLink banner={banner} tabIndex={active ? 0 : -1}>
                {image}
                {banner.title ? (
                  <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent px-6 pb-5 pt-12 text-lg font-black text-white md:px-10 md:text-2xl">
                    {banner.title}
                  </span>
                ) : null}
              </BannerLink>
            </div>
          );
        })}
      </div>

      {count > 1 ? (
        <>
          <button
            type="button"
            onClick={() => go(current - 1)}
            aria-label="بنر قبلی"
            className="absolute right-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/80 text-slate-800 shadow hover:bg-white"
          >
            <ChevronRight className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => go(current + 1)}
            aria-label="بنر بعدی"
            className="absolute left-3 top-1/2 flex size-10 -translate-y-1/2 items-center justify-center rounded-full bg-white/80 text-slate-800 shadow hover:bg-white"
          >
            <ChevronLeft className="size-5" />
          </button>
          <div className="absolute inset-x-0 bottom-3 flex justify-center gap-2">
            {banners.map((banner, position) => (
              <button
                key={banner.id}
                type="button"
                onClick={() => go(position)}
                aria-label={`نمایش بنر ${toPersianDigits(position + 1)}`}
                aria-current={position === current}
                className={`h-2 rounded-full transition-all ${position === current ? 'w-6 bg-white' : 'w-2 bg-white/60 hover:bg-white/90'}`}
              />
            ))}
          </div>
        </>
      ) : null}
    </section>
  );
}

function BannerLink({ banner, tabIndex, children }: { banner: HeroBanner; tabIndex: number; children: ReactNode }) {
  const className = 'relative block size-full';
  if (!banner.linkUrl) return <div className={className}>{children}</div>;
  if (isExternalLink(banner.linkUrl)) {
    return (
      <a href={banner.linkUrl} target="_blank" rel="noopener noreferrer" className={className} tabIndex={tabIndex}>
        {children}
      </a>
    );
  }
  return (
    <Link href={banner.linkUrl} className={className} tabIndex={tabIndex}>
      {children}
    </Link>
  );
}
