/**
 * The ONLY place where money changes unit (TM decision, Phase 10 — Option 1).
 *
 * - The API speaks Rial (IRR). Amounts arrive as decimal strings with two
 *   fraction digits ("35000000.00") and are sent as numbers of Rials.
 * - The UI speaks Toman (1 Toman = 10 Rials), always with Persian digits and
 *   the Persian thousands separator "٬": 35,000,000 IRR → "۳٬۵۰۰٬۰۰۰ تومان".
 *
 * Components never multiply or divide by 10 themselves: they call
 * {@link formatToman} to display, {@link tomanToRials} to submit, and
 * {@link rialsToToman} to prefill a Toman input from an API value.
 *
 * Arithmetic is exact (BigInt on hundredths of a Rial); binary floating point
 * never touches an amount on its way to the screen.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;
const THOUSANDS_SEPARATOR = '٬';
const DECIMAL_SEPARATOR = '٫';
const MINUS_SIGN = '−';
export const TOMAN_UNIT = 'تومان';

/** Rials per Toman. Exported for documentation/tests; components must not use it. */
export const RIALS_PER_TOMAN = 10;

export type MoneyInput = number | string | bigint;

export interface FormatTomanOptions {
  /** Append the "تومان" unit (default true). */
  unit?: boolean;
}

function toPersian(value: string): string {
  return value.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Converts Persian (U+06F0…) and Arabic-Indic (U+0660…) digits to ASCII. */
function toAscii(value: string): string {
  return value
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
}

/**
 * Parses an API amount (Rials) into hundredths of a Rial.
 * Accepts "35000000", "35000000.5", "35000000.00", "-2590000.00", numbers and bigints.
 */
function toRialHundredths(amountInRials: MoneyInput): bigint {
  if (typeof amountInRials === 'bigint') {
    return amountInRials * 100n;
  }
  let text: string;
  if (typeof amountInRials === 'number') {
    if (!Number.isFinite(amountInRials)) {
      throw new TypeError(`formatToman: amount must be finite, got ${amountInRials}`);
    }
    text = Number.isInteger(amountInRials) ? amountInRials.toString() : amountInRials.toFixed(2);
  } else {
    text = amountInRials.trim();
  }
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new TypeError(`formatToman: not a Rial amount: "${String(amountInRials)}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign ? -hundredths : hundredths;
}

/**
 * Formats a Rial amount from the API as Toman with Persian digits:
 * `formatToman('35000000.00')` → `"۳٬۵۰۰٬۰۰۰ تومان"`.
 *
 * Amounts that are not a whole number of Toman keep their fraction
 * (`"12345"` Rials → `"۱٬۲۳۴٫۵ تومان"`) instead of being silently rounded.
 */
export function formatToman(amountInRials: MoneyInput, options: FormatTomanOptions = {}): string {
  const hundredths = toRialHundredths(amountInRials);
  const negative = hundredths < 0n;
  const absolute = negative ? -hundredths : hundredths;
  // Toman × 1000 = Rial × 100, so the hundredths of a Rial are thousandths of a Toman.
  const whole = absolute / 1000n;
  const thousandths = absolute % 1000n;
  let text = groupThousands(whole.toString());
  if (thousandths > 0n) {
    text += DECIMAL_SEPARATOR + thousandths.toString().padStart(3, '0').replace(/0+$/, '');
  }
  text = toPersian(text);
  if (negative) {
    text = MINUS_SIGN + text;
  }
  return options.unit === false ? text : `${text} ${TOMAN_UNIT}`;
}

/**
 * Converts a Toman amount typed by a vendor/admin into the Rial number the API
 * expects: `tomanToRials('۳٬۵۰۰٬۰۰۰')` → `35000000`.
 *
 * Accepts Persian, Arabic-Indic or ASCII digits, thousands separators (٬ , or
 * spaces) and at most one fraction digit (0.1 Toman = 1 Rial). Negative,
 * empty, malformed and unsafe values throw a RangeError whose message can be
 * shown next to the field.
 */
export function tomanToRials(toman: number | string): number {
  let text: string;
  if (typeof toman === 'number') {
    if (!Number.isFinite(toman)) {
      throw new RangeError('مبلغ واردشده معتبر نیست.');
    }
    text = toman.toString();
  } else {
    text = toAscii(toman.trim())
      .replace(/[٬,\s]/g, '')
      .replace(DECIMAL_SEPARATOR, '.');
  }
  if (text === '') {
    throw new RangeError('مبلغ را وارد کنید.');
  }
  if (text.startsWith('-')) {
    throw new RangeError('مبلغ نمی‌تواند منفی باشد.');
  }
  const match = /^(\d+)(?:\.(\d))?$/.exec(text);
  if (!match) {
    throw new RangeError('مبلغ باید عدد تومان با حداکثر یک رقم اعشار باشد.');
  }
  const [, whole = '0', fraction = '0'] = match;
  const rials = BigInt(whole) * BigInt(RIALS_PER_TOMAN) + BigInt(fraction);
  if (rials > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('مبلغ بیش از حد بزرگ است.');
  }
  return Number(rials);
}

/**
 * Rial amount from the API → plain Toman string for an editable input
 * (ASCII digits, no separators): `rialsToToman('45000000.00')` → `"4500000"`.
 * Fractions of a Rial (never produced by the API for prices) are truncated.
 */
export function rialsToToman(amountInRials: MoneyInput): string {
  const hundredths = toRialHundredths(amountInRials);
  const negative = hundredths < 0n;
  const rials = (negative ? -hundredths : hundredths) / 100n;
  const whole = rials / BigInt(RIALS_PER_TOMAN);
  const tenth = rials % BigInt(RIALS_PER_TOMAN);
  const text = tenth === 0n ? whole.toString() : `${whole.toString()}.${tenth.toString()}`;
  return negative ? `-${text}` : text;
}
