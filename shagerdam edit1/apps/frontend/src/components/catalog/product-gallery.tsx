'use client';

import { ImageOff } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';

import type { ImageRef } from '@/lib/api/types';
import { toPersianDigits } from '@/lib/format';

export function ProductGallery({ media, title }: { media: ImageRef[]; title: string }) {
  const [active, setActive] = useState(0);
  const current = media[active];

  if (!current) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-3xl border border-slate-200 bg-slate-100 text-slate-400">
        <ImageOff className="size-16" />
        <span className="sr-only">این محصول تصویری ندارد</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-square overflow-hidden rounded-3xl border border-slate-200 bg-white">
        <Image src={current.url} alt={`${title} — تصویر ${toPersianDigits(active + 1)}`} fill sizes="(max-width: 1024px) 100vw, 50vw" className="object-contain" priority unoptimized />
      </div>
      {media.length > 1 ? (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="تصاویر محصول">
          {media.map((image, index) => (
            <li key={image.url}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-label={`نمایش تصویر ${toPersianDigits(index + 1)}`}
                aria-current={index === active}
                className={`relative size-20 overflow-hidden rounded-xl border-2 bg-white ${index === active ? 'border-brand-600' : 'border-transparent opacity-70 hover:opacity-100'}`}
              >
                <Image src={image.thumbnailUrl ?? image.url} alt="" fill sizes="80px" className="object-cover" unoptimized />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
