'use client';

import { ArrowDown, ArrowUp, ListPlus, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { toPersianDigits } from '@/lib/format';
import {
  MAX_SPECIFICATIONS_PER_PRODUCT,
  SPECIFICATION_GROUP_MAX_LENGTH,
  SPECIFICATION_TITLE_MAX_LENGTH,
  SPECIFICATION_VALUE_MAX_LENGTH,
  emptySpecRow,
  type SpecRow,
} from '@/lib/product-specs';

interface SpecificationEditorProps {
  rows: SpecRow[];
  onChange: (rows: SpecRow[]) => void;
}

/**
 * Technical-specification table: group (optional), title and value per row.
 * Filled by hand or by the product importer; rows can be re-ordered, and the
 * order is the order shown on the product page.
 */
export function SpecificationEditor({ rows, onChange }: SpecificationEditorProps) {
  const full = rows.length >= MAX_SPECIFICATIONS_PER_PRODUCT;
  const update = (key: string, patch: Partial<SpecRow>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const remove = (key: string) => onChange(rows.filter((row) => row.key !== key));
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  /** A new row right after `index`, in the same group (typing a group once is enough). */
  const insertAfter = (index: number) => {
    const next = [...rows];
    next.splice(index + 1, 0, emptySpecRow(rows[index]?.groupTitle ?? ''));
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          هنوز مشخصاتی ثبت نشده است. ردیف اضافه کنید یا اطلاعات را از لینک کالا دریافت کنید.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="w-40 px-2 py-2 text-start font-medium">گروه (اختیاری)</th>
                <th className="w-52 px-2 py-2 text-start font-medium">عنوان ویژگی</th>
                <th className="px-2 py-2 text-start font-medium">مقدار</th>
                <th className="w-36 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) => (
                <tr key={row.key} className="align-top">
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`گروه ردیف ${toPersianDigits(index + 1)}`}
                      maxLength={SPECIFICATION_GROUP_MAX_LENGTH}
                      value={row.groupTitle}
                      placeholder="مثلاً دوربین"
                      onChange={(event) => update(row.key, { groupTitle: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`عنوان ردیف ${toPersianDigits(index + 1)}`}
                      maxLength={SPECIFICATION_TITLE_MAX_LENGTH}
                      value={row.title}
                      placeholder="مثلاً رزولوشن"
                      onChange={(event) => update(row.key, { title: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Textarea
                      aria-label={`مقدار ردیف ${toPersianDigits(index + 1)}`}
                      rows={Math.min(4, Math.max(1, row.value.split('\n').length))}
                      maxLength={SPECIFICATION_VALUE_MAX_LENGTH}
                      value={row.value}
                      onChange={(event) => update(row.key, { value: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton label="انتقال به بالا" disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton label="انتقال به پایین" disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown className="size-4" />
                      </IconButton>
                      <IconButton label="ردیف جدید در همین گروه" disabled={full} onClick={() => insertAfter(index)}>
                        <ListPlus className="size-4" />
                      </IconButton>
                      <IconButton label="حذف ردیف" tone="danger" onClick={() => remove(row.key)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} disabled={full} onClick={() => onChange([...rows, emptySpecRow(rows[rows.length - 1]?.groupTitle ?? '')])}>
          افزودن ردیف
        </Button>
        <span className="text-xs text-slate-500">
          {toPersianDigits(rows.length)} از {toPersianDigits(MAX_SPECIFICATIONS_PER_PRODUCT)} ردیف
          {rows.length > 0 ? (
            <button type="button" className="ms-3 text-rose-600 hover:underline" onClick={() => onChange([])}>
              حذف همه
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function IconButton({ label, onClick, disabled, tone = 'neutral', children }: { label: string; onClick: () => void; disabled?: boolean; tone?: 'neutral' | 'danger'; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg p-1.5 disabled:cursor-not-allowed disabled:opacity-30 ${tone === 'danger' ? 'text-rose-600 hover:bg-rose-50' : 'text-slate-600 hover:bg-slate-100'}`}
    >
      {children}
    </button>
  );
}
