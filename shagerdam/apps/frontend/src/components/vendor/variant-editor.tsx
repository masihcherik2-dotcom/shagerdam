'use client';

import { Grid3X3, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { toPersianDigits } from '@/lib/format';
import { MAX_VARIANTS_PER_PRODUCT, buildVariantMatrix, emptyVariantRow, type ColorChoice, type VariantRow } from '@/lib/product-form';

interface Props {
  rows: VariantRow[];
  onChange: (rows: VariantRow[]) => void;
  skuPrefix: string;
  /** Rows that may still be added (existing variants count against the 100 limit). */
  capacity?: number;
}

/**
 * Multi-variant table: colour (name + swatch), size, price, compare price,
 * stock and SKU per row. The generator builds the colour × size matrix at once.
 */
export function VariantEditor({ rows, onChange, skuPrefix, capacity = MAX_VARIANTS_PER_PRODUCT }: Props) {
  const [colors, setColors] = useState<ColorChoice[]>([]);
  const [colorName, setColorName] = useState('');
  const [colorHex, setColorHex] = useState('#1D4ED8');
  const [sizes, setSizes] = useState('');
  const [price, setPrice] = useState('');
  const [compare, setCompare] = useState('');
  const [stock, setStock] = useState('10');
  const [notice, setNotice] = useState<string | null>(null);

  const update = (key: string, patch: Partial<VariantRow>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  function addColor() {
    const name = colorName.trim();
    if (!name) return;
    setColors((current) => [...current.filter((color) => color.name !== name), { name, hex: colorHex.toUpperCase() }]);
    setColorName('');
  }

  function generate() {
    const sizeList = sizes
      .split(/[,،]/)
      .map((size) => size.trim())
      .filter(Boolean);
    const generated = buildVariantMatrix(colors, [...new Set(sizeList)], { priceToman: price, compareToman: compare, stock, skuPrefix });
    const room = capacity - rows.length;
    if (generated.length > room) {
      setNotice(`حداکثر ${toPersianDigits(MAX_VARIANTS_PER_PRODUCT)} تنوع مجاز است؛ ${toPersianDigits(Math.max(room, 0))} ردیف افزوده شد.`);
    } else {
      setNotice(null);
    }
    onChange([...rows, ...generated.slice(0, Math.max(room, 0))]);
  }

  return (
    <div className="flex flex-col gap-4">
      <details className="rounded-xl border border-dashed border-brand-300 bg-brand-50/40 p-4" open={rows.length === 0}>
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-bold text-brand-800">
          <Grid3X3 className="size-4" /> ساخت خودکار ماتریس رنگ × سایز
        </summary>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-600">رنگ‌ها</span>
            <div className="flex gap-2">
              <input type="color" aria-label="انتخاب رنگ" value={colorHex} onChange={(event) => setColorHex(event.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-slate-200" />
              <Input
                placeholder="نام رنگ (مثلاً سرمه‌ای)"
                value={colorName}
                maxLength={40}
                onChange={(event) => setColorName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addColor();
                  }
                }}
              />
              <Button variant="secondary" onClick={addColor} icon={<Plus className="size-4" />} aria-label="افزودن رنگ" />
            </div>
            <div className="flex flex-wrap gap-2">
              {colors.map((color) => (
                <span key={color.name} className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1 pe-1 ps-2 text-xs">
                  <span className="size-3 rounded-full border" style={{ background: color.hex }} /> {color.name}
                  <button type="button" aria-label={`حذف ${color.name}`} onClick={() => setColors((current) => current.filter((item) => item.name !== color.name))} className="rounded-full p-0.5 hover:bg-slate-100">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-600">سایزها (با ویرگول جدا کنید)</span>
            <Input placeholder="S, M, L, XL" value={sizes} onChange={(event) => setSizes(event.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-2 lg:col-span-2">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              قیمت فروش (تومان)
              <Input dir="ltr" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              قیمت قبل از تخفیف
              <Input dir="ltr" inputMode="decimal" value={compare} onChange={(event) => setCompare(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              موجودی هر تنوع
              <Input dir="ltr" inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
            <Button onClick={generate} icon={<Grid3X3 className="size-4" />}>
              ساخت {toPersianDigits(Math.max(colors.length, 1) * Math.max(sizes.split(/[,،]/).filter((size) => size.trim()).length, 1))} تنوع
            </Button>
            {notice ? <span className="text-xs text-amber-700">{notice}</span> : null}
          </div>
        </div>
      </details>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="px-2 py-2 text-start font-medium">رنگ</th>
              <th className="px-2 py-2 text-start font-medium">سایز</th>
              <th className="px-2 py-2 text-start font-medium">قیمت (تومان)</th>
              <th className="px-2 py-2 text-start font-medium">قبل از تخفیف</th>
              <th className="px-2 py-2 text-start font-medium">موجودی</th>
              <th className="px-2 py-2 text-start font-medium">SKU</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  هنوز تنوعی اضافه نشده است. از ماتریس بالا استفاده کنید یا ردیف دستی بیفزایید.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.key}>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <input
                        type="color"
                        aria-label="رنگ"
                        value={row.colorHex || '#FFFFFF'}
                        onChange={(event) => update(row.key, { colorHex: event.target.value.toUpperCase() })}
                        className="h-9 w-9 shrink-0 cursor-pointer rounded border border-slate-200"
                      />
                      <Input aria-label="نام رنگ" value={row.colorName} maxLength={40} onChange={(event) => update(row.key, { colorName: event.target.value })} className="h-9 min-w-24" />
                      {row.colorHex ? (
                        <button type="button" aria-label="بدون رنگ" title="بدون رنگ" onClick={() => update(row.key, { colorHex: '', colorName: '' })} className="rounded p-1 text-slate-400 hover:bg-slate-100">
                          <X className="size-3" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="سایز" value={row.size} maxLength={20} onChange={(event) => update(row.key, { size: event.target.value })} className="h-9 w-20" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="قیمت" dir="ltr" inputMode="decimal" value={row.priceToman} onChange={(event) => update(row.key, { priceToman: event.target.value })} className="h-9 w-32" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="قیمت قبل از تخفیف" dir="ltr" inputMode="decimal" value={row.compareToman} onChange={(event) => update(row.key, { compareToman: event.target.value })} className="h-9 w-32" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="موجودی" dir="ltr" inputMode="numeric" value={row.stock} onChange={(event) => update(row.key, { stock: event.target.value })} className="h-9 w-20" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="SKU" dir="ltr" value={row.sku} maxLength={64} onChange={(event) => update(row.key, { sku: event.target.value.toUpperCase() })} className="h-9 w-44 font-mono text-xs" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Button size="sm" variant="ghost" className="text-rose-600" aria-label="حذف ردیف" icon={<Trash2 className="size-4" />} onClick={() => onChange(rows.filter((item) => item.key !== row.key))} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={rows.length >= capacity} onClick={() => onChange([...rows, emptyVariantRow({ stock: '0' })])}>
          افزودن ردیف
        </Button>
        <span>
          {toPersianDigits(rows.length)} تنوع
        </span>
      </div>
    </div>
  );
}
