'use client';

import { FileText, ImagePlus, LoaderCircle, Trash2, UploadCloud } from 'lucide-react';
import Image from 'next/image';
import { useId, useRef, useState, type DragEvent } from 'react';

import { apiUpload } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { DocumentPurpose, DocumentUploadResponse, ImagePurpose, ImageUploadResponse } from '@/lib/api/types';
import { toPersianDigits } from '@/lib/format';

export interface UploadedFile {
  id: string;
  url: string;
  /** Image thumbnail, when the upload is an image. */
  thumbnailUrl: string | null;
  name: string;
}

type UploadKind = { kind: 'image'; purpose: ImagePurpose } | { kind: 'document'; purpose: DocumentPurpose };

interface FileDropProps {
  upload: UploadKind;
  value: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
  max: number;
  accept: string;
  label: string;
  hint?: string;
  /** Allow re-ordering (first = primary image). */
  orderable?: boolean;
}

interface Pending {
  key: string;
  name: string;
  progress: number;
}

/**
 * Drag-and-drop (or click) uploader bound to the real media endpoints:
 * images → POST /media/upload/image (WebP + thumbnail), documents →
 * POST /media/upload/document (private). Uploads run in parallel with
 * progress; server-side rejections (type, size, corrupt file) are shown per file.
 */
export function FileDrop({ upload, value, onChange, max, accept, label, hint, orderable = false }: FileDropProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const valueRef = useRef(value);
  valueRef.current = value;

  const remaining = max - value.length - pending.length;

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = Array.from(list).slice(0, Math.max(0, remaining));
    const skipped = list.length - files.length;
    const nextErrors: string[] = skipped > 0 ? [`حداکثر ${toPersianDigits(max)} فایل مجاز است؛ ${toPersianDigits(skipped)} فایل اضافه نشد.`] : [];
    const jobs = files.map((file, index) => ({ key: `${Date.now()}-${index}-${file.name}`, file }));
    setPending((current) => [...current, ...jobs.map((job) => ({ key: job.key, name: job.file.name, progress: 0 }))]);

    const results = await Promise.all(
      jobs.map(async (job): Promise<UploadedFile | null> => {
        const onProgress = (fraction: number) =>
          setPending((current) => current.map((item) => (item.key === job.key ? { ...item, progress: fraction } : item)));
        try {
          if (upload.kind === 'image') {
            const result = await apiUpload<ImageUploadResponse>('/media/upload/image', job.file, upload.purpose, onProgress);
            return { id: result.id, url: result.url, thumbnailUrl: result.thumbnailUrl, name: job.file.name };
          }
          const result = await apiUpload<DocumentUploadResponse>('/media/upload/document', job.file, upload.purpose, onProgress);
          return { id: result.id, url: result.url, thumbnailUrl: null, name: result.originalName };
        } catch (caught) {
          nextErrors.push(`«${job.file.name}»: ${toApiError(caught).message}`);
          return null;
        } finally {
          setPending((current) => current.filter((item) => item.key !== job.key));
        }
      }),
    );
    const uploaded = results.filter((item): item is UploadedFile => item !== null);
    if (uploaded.length > 0) {
      onChange([...valueRef.current, ...uploaded]);
    }
    setErrors(nextErrors);
    if (inputRef.current) inputRef.current.value = '';
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {remaining > 0 ? (
        <label
          htmlFor={inputId}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50 hover:border-brand-400'
          }`}
        >
          <UploadCloud className="size-8 text-brand-600" />
          <span className="text-sm font-medium text-slate-700">فایل‌ها را اینجا رها کنید یا برای انتخاب کلیک کنید</span>
          {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
          <span className="text-xs text-slate-400">{toPersianDigits(remaining)} فایل دیگر مجاز است</span>
          <input id={inputId} ref={inputRef} type="file" accept={accept} multiple={max > 1} className="sr-only" onChange={(event) => void handleFiles(event.target.files)} />
        </label>
      ) : null}

      {errors.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-800">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      {value.length > 0 || pending.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {value.map((file, index) => (
            <li key={file.id} className="relative flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2">
              {file.thumbnailUrl ? (
                <div className="relative aspect-square overflow-hidden rounded-lg bg-slate-100">
                  <Image src={file.thumbnailUrl} alt={file.name} fill sizes="160px" className="object-cover" unoptimized />
                </div>
              ) : (
                <div className="flex aspect-square items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                  {upload.kind === 'image' ? <ImagePlus className="size-8" /> : <FileText className="size-8" />}
                </div>
              )}
              <span className="truncate text-xs text-slate-600" title={file.name}>
                {orderable && index === 0 ? '★ تصویر اصلی — ' : ''}
                {file.name}
              </span>
              <div className="flex items-center justify-between gap-1">
                {orderable ? (
                  <div className="flex gap-1">
                    <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className="rounded-md border px-1.5 text-xs disabled:opacity-30" aria-label="جابه‌جایی به قبل">
                      →
                    </button>
                    <button type="button" onClick={() => move(index, 1)} disabled={index === value.length - 1} className="rounded-md border px-1.5 text-xs disabled:opacity-30" aria-label="جابه‌جایی به بعد">
                      ←
                    </button>
                  </div>
                ) : (
                  <span />
                )}
                <button type="button" onClick={() => onChange(value.filter((item) => item.id !== file.id))} className="rounded-md p-1 text-rose-600 hover:bg-rose-50" aria-label={`حذف ${file.name}`}>
                  <Trash2 className="size-4" />
                </button>
              </div>
            </li>
          ))}
          {pending.map((item) => (
            <li key={item.key} className="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-2 text-center">
              <LoaderCircle className="size-6 animate-spin text-brand-600" />
              <span className="w-full truncate text-xs text-slate-600">{item.name}</span>
              <span className="text-xs text-slate-400">{toPersianDigits(Math.round(item.progress * 100))}٪</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
