import { Prisma } from '@prisma/client';

/** Calendar used for instalment due dates (the platform operates in Iran). */
export const PLATFORM_TIME_ZONE = 'Asia/Tehran';

/** Days between two consecutive instalments (TM brief: "30 days apart"). */
export const INSTALLMENT_INTERVAL_DAYS = 30;

export interface InstallmentScheduleInput {
  /** Principal financed by credit, in whole rials. */
  creditAmount: Prisma.Decimal;
  /** Total interest rate of the whole plan duration (0 for 3 months, 9 for 6 months, …). */
  interestRatePercent: Prisma.Decimal;
  durationMonths: number;
  /** Calendar date (YYYY-MM-DD, platform time zone) the purchase was paid; instalment k is due k × 30 days later. */
  purchaseDate: string;
  intervalDays?: number;
}

export interface InstallmentLine {
  installmentNumber: number;
  totalInstallments: number;
  /** Due date as a calendar date (YYYY-MM-DD). */
  dueDate: string;
  principalAmount: Prisma.Decimal;
  interestAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

export interface InstallmentSchedule {
  creditAmount: Prisma.Decimal;
  totalInterest: Prisma.Decimal;
  totalPayable: Prisma.Decimal;
  lines: InstallmentLine[];
}

export class InstallmentMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallmentMathError';
  }
}

/**
 * The TM-approved instalment arithmetic (Phase 8, "Option A — fixed plan
 * duration rate", whole-rial rounding):
 *
 *   totalInterest  = floor(creditAmount × interestRatePercent / 100)   — rounded down, in the customer's favour
 *   basePrincipal  = floor(creditAmount / n),  remainder → last instalment
 *   baseInterest   = floor(totalInterest / n), remainder → last instalment
 *
 * Every amount is a whole number of rials (Shaparak/Shetab have no fractional
 * unit); Σ principal = creditAmount and Σ interest = totalInterest exactly.
 * Only the principal consumes the credit line; the interest is a financing fee
 * paid with the instalments.
 */
export function buildInstallmentSchedule(input: InstallmentScheduleInput): InstallmentSchedule {
  const { creditAmount, interestRatePercent, durationMonths } = input;
  const intervalDays = input.intervalDays ?? INSTALLMENT_INTERVAL_DAYS;
  if (!creditAmount.isInteger() || !creditAmount.greaterThan(0)) {
    throw new InstallmentMathError(`creditAmount must be a positive whole number of rials, got ${creditAmount.toFixed(2)}`);
  }
  if (!Number.isInteger(durationMonths) || durationMonths < 1) {
    throw new InstallmentMathError(`durationMonths must be a positive integer, got ${durationMonths}`);
  }
  if (interestRatePercent.lessThan(0)) {
    throw new InstallmentMathError('interestRatePercent cannot be negative');
  }
  if (!Number.isInteger(intervalDays) || intervalDays < 1) {
    throw new InstallmentMathError('intervalDays must be a positive integer');
  }

  const n = new Prisma.Decimal(durationMonths);
  const totalInterest = creditAmount.times(interestRatePercent).dividedBy(100).floor();
  const basePrincipal = creditAmount.dividedBy(n).floor();
  const principalRemainder = creditAmount.minus(basePrincipal.times(n));
  const baseInterest = totalInterest.dividedBy(n).floor();
  const interestRemainder = totalInterest.minus(baseInterest.times(n));

  const lines: InstallmentLine[] = [];
  for (let k = 1; k <= durationMonths; k += 1) {
    const last = k === durationMonths;
    const principalAmount = last ? basePrincipal.plus(principalRemainder) : basePrincipal;
    const interestAmount = last ? baseInterest.plus(interestRemainder) : baseInterest;
    lines.push({
      installmentNumber: k,
      totalInstallments: durationMonths,
      dueDate: addDays(input.purchaseDate, k * intervalDays),
      principalAmount,
      interestAmount,
      totalAmount: principalAmount.plus(interestAmount),
    });
  }
  return { creditAmount, totalInterest, totalPayable: creditAmount.plus(totalInterest), lines };
}

/** Calendar date (YYYY-MM-DD) of an instant in the platform time zone. */
export function platformDate(instant: Date, timeZone = PLATFORM_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Adds whole days to a calendar date (no time-zone or DST effects: pure calendar arithmetic in UTC). */
export function addDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new InstallmentMathError(`Not a calendar date: ${date}`);
  }
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return new Date(utc).toISOString().slice(0, 10);
}

/** A calendar date as the Date Prisma writes to a `@db.Date` column (UTC midnight). */
export function calendarDateToDb(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** A `@db.Date` value back to YYYY-MM-DD. */
export function dbDateToCalendar(value: Date): string {
  return value.toISOString().slice(0, 10);
}
