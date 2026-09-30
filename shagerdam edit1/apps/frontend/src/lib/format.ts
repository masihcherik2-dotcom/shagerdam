/**
 * Non-monetary display helpers: Persian digits, counts, percentages and dates
 * (Solar Hijri calendar, Tehran time). Money goes through `currency.ts` only.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

export function toPersianDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Persian/Arabic-Indic digits → ASCII (for inputs such as mobile or postal code). */
export function toLatinDigits(value: string): string {
  return value
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

/** Integer count with Persian digits and ٬ grouping: 12500 → "۱۲٬۵۰۰". */
export function formatCount(value: number): string {
  return toPersianDigits(Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '٬'));
}

/** Percentage from an API decimal string or number: "9.00" → "۹٪", "2.5" → "۲٫۵٪". */
export function formatPercent(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return '—';
  }
  const text = Number.isInteger(numeric) ? numeric.toString() : numeric.toFixed(2).replace(/0+$/, '');
  return `${toPersianDigits(text).replace('.', '٫')}٪`;
}

const TIME_ZONE = 'Asia/Tehran';

const dateFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026-09-28T…" → "۶ مهر ۱۴۰۵". A plain calendar date ("2026-10-28") is read as that day. */
export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const normalised = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  const date = toDate(normalised);
  return date ? dateFormatter.format(date) : '—';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '—';
}

/** Iranian mobile in a readable, Persian-digit form: +989121234567 → "۰۹۱۲ ۱۲۳ ۴۵۶۷". */
export function formatMobile(mobile: string): string {
  const local = mobile.replace(/^\+98/, '0');
  const grouped = /^0\d{10}$/.test(local) ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : local;
  return toPersianDigits(grouped);
}
