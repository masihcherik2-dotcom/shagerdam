/**
 * Exact arithmetic on Rial amounts as the API sends them ("35000000.00").
 * Values stay in Rials here — unit conversion for display lives in
 * `currency.ts` only. Everything works on BigInt hundredths of a Rial so no
 * float rounding can creep into comparisons or totals.
 */

export type RialAmount = string | number | bigint;

/** Hundredths of a Rial. */
export function toRialCents(amount: RialAmount): bigint {
  if (typeof amount === 'bigint') {
    return amount * 100n;
  }
  const text = typeof amount === 'number' ? (Number.isInteger(amount) ? amount.toString() : amount.toFixed(2)) : amount.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new TypeError(`Not a Rial amount: "${String(amount)}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign ? -cents : cents;
}

/** Back to the API's string form ("35000000.00"). */
export function fromRialCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const text = `${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** -1, 0 or 1. */
export function compareRials(a: RialAmount, b: RialAmount): number {
  const left = toRialCents(a);
  const right = toRialCents(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

export function isPositiveAmount(amount: RialAmount): boolean {
  return toRialCents(amount) > 0n;
}

export function addRials(...amounts: RialAmount[]): string {
  return fromRialCents(amounts.reduce<bigint>((sum, amount) => sum + toRialCents(amount), 0n));
}

export function subtractRials(a: RialAmount, b: RialAmount): string {
  return fromRialCents(toRialCents(a) - toRialCents(b));
}

/**
 * Share of `part` in `total`, clamped to 0…1 (progress bars, credit usage).
 * Returns 0 when total is not positive.
 */
export function shareOf(part: RialAmount, total: RialAmount): number {
  const whole = toRialCents(total);
  if (whole <= 0n) {
    return 0;
  }
  const piece = toRialCents(part);
  if (piece <= 0n) {
    return 0;
  }
  if (piece >= whole) {
    return 1;
  }
  // Scale to basis points in BigInt first, then a small safe division.
  return Number((piece * 10_000n) / whole) / 10_000;
}

/** Line total preview: unit price × quantity. */
export function multiplyRials(amount: RialAmount, quantity: number): string {
  if (!Number.isInteger(quantity)) {
    throw new TypeError('quantity must be an integer');
  }
  return fromRialCents(toRialCents(amount) * BigInt(quantity));
}
