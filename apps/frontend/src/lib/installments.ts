/**
 * Client-side PREVIEW of the backend's instalment arithmetic, mirrored line
 * for line from `apps/backend/src/modules/credit/installment-math.ts` and
 * `credit-math.ts#splitPayment` (TM-approved Phase 8 "Option A"):
 *
 *   totalInterest = floor(creditAmount × interestRatePercent / 100)
 *   basePrincipal = floor(creditAmount / n), remainder → last instalment
 *   baseInterest  = floor(totalInterest / n), remainder → last instalment
 *
 * All values are whole Rials (strings in API format). The backend remains the
 * source of truth: the real schedule is created and returned by the API when
 * a credit payment is initiated. This module only lets the product page and
 * checkout show the same numbers beforehand.
 */
import { fromRialCents, toRialCents, type RialAmount } from './money';

export interface InstallmentPreviewLine {
  installmentNumber: number;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
}

export interface InstallmentPreview {
  creditAmount: string;
  totalInterest: string;
  totalPayable: string;
  /** Amount of each regular instalment (the last one may be slightly larger). */
  regularInstallment: string;
  lines: InstallmentPreviewLine[];
}

/** "9.00" → 900n (hundredths of a percent). */
function percentToBasisPoints(percent: string | number): bigint {
  const text = typeof percent === 'number' ? percent.toFixed(2) : percent.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new TypeError(`Not a percentage: "${String(percent)}"`);
  }
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function wholeRials(amount: RialAmount): bigint {
  const cents = toRialCents(amount);
  if (cents % 100n !== 0n) {
    throw new TypeError('Credit amounts are whole Rials');
  }
  return cents / 100n;
}

const rials = (value: bigint): string => fromRialCents(value * 100n);

export function previewInstallments(creditAmount: RialAmount, interestRatePercent: string | number, durationMonths: number): InstallmentPreview {
  if (!Number.isInteger(durationMonths) || durationMonths < 1) {
    throw new TypeError('durationMonths must be a positive integer');
  }
  const credit = wholeRials(creditAmount);
  if (credit <= 0n) {
    throw new TypeError('creditAmount must be positive');
  }
  const n = BigInt(durationMonths);
  // floor(credit × bp / 10000) === floor(credit × percent / 100)
  const totalInterest = (credit * percentToBasisPoints(interestRatePercent)) / 10_000n;
  const basePrincipal = credit / n;
  const principalRemainder = credit - basePrincipal * n;
  const baseInterest = totalInterest / n;
  const interestRemainder = totalInterest - baseInterest * n;

  const lines: InstallmentPreviewLine[] = [];
  for (let k = 1; k <= durationMonths; k += 1) {
    const last = k === durationMonths;
    const principal = last ? basePrincipal + principalRemainder : basePrincipal;
    const interest = last ? baseInterest + interestRemainder : baseInterest;
    lines.push({ installmentNumber: k, principalAmount: rials(principal), interestAmount: rials(interest), totalAmount: rials(principal + interest) });
  }
  return {
    creditAmount: rials(credit),
    totalInterest: rials(totalInterest),
    totalPayable: rials(credit + totalInterest),
    regularInstallment: rials(basePrincipal + baseInterest),
    lines,
  };
}

export type CreditSplit =
  | { ok: true; creditAmount: string; cashAmount: string }
  | { ok: false; reason: 'INSUFFICIENT_CREDIT' | 'HYBRID_NOT_REQUIRED' | 'AMOUNT_NOT_WHOLE_RIALS' };

/** Mirror of the backend's `splitPayment` for BANK_CREDIT / HYBRID. */
export function splitCreditPayment(method: 'BANK_CREDIT' | 'HYBRID', payable: RialAmount, available: RialAmount): CreditSplit {
  const payableCents = toRialCents(payable);
  const availableCents = toRialCents(available);
  if (payableCents <= 0n || payableCents % 100n !== 0n) {
    return { ok: false, reason: 'AMOUNT_NOT_WHOLE_RIALS' };
  }
  if (method === 'BANK_CREDIT') {
    return availableCents >= payableCents
      ? { ok: true, creditAmount: fromRialCents(payableCents), cashAmount: '0.00' }
      : { ok: false, reason: 'INSUFFICIENT_CREDIT' };
  }
  if (availableCents >= payableCents) {
    return { ok: false, reason: 'HYBRID_NOT_REQUIRED' };
  }
  const creditCents = (availableCents / 100n) * 100n; // floor to whole Rials
  if (creditCents <= 0n) {
    return { ok: false, reason: 'INSUFFICIENT_CREDIT' };
  }
  return { ok: true, creditAmount: fromRialCents(creditCents), cashAmount: fromRialCents(payableCents - creditCents) };
}
