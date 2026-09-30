import { Prisma } from '@prisma/client';
import { addDays, buildInstallmentSchedule, calendarDateToDb, dbDateToCalendar, InstallmentMathError, platformDate } from './installment-math';

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((acc, value) => acc.plus(value), D(0));
}

describe('buildInstallmentSchedule (Option A, whole rials)', () => {
  it('splits an evenly divisible amount into equal instalments with no interest (3-month plan, 0%)', () => {
    const schedule = buildInstallmentSchedule({ creditAmount: D(3_000_000), interestRatePercent: D(0), durationMonths: 3, purchaseDate: '2026-09-27' });
    expect(schedule.lines.map((l) => l.principalAmount.toFixed(0))).toEqual(['1000000', '1000000', '1000000']);
    expect(schedule.lines.every((l) => l.interestAmount.isZero())).toBe(true);
    expect(schedule.totalInterest.toFixed(0)).toBe('0');
    expect(schedule.totalPayable.toFixed(0)).toBe('3000000');
  });

  it('puts the principal and interest remainders on the last instalment; sums are exact', () => {
    // 1,000,001 over 6 months at 9%: interest = floor(90,000.09) = 90,000
    const schedule = buildInstallmentSchedule({ creditAmount: D(1_000_001), interestRatePercent: D('9.00'), durationMonths: 6, purchaseDate: '2026-09-27' });
    expect(schedule.totalInterest.toFixed(0)).toBe('90000');
    expect(schedule.lines).toHaveLength(6);
    expect(schedule.lines.slice(0, 5).every((l) => l.principalAmount.equals(166_666))).toBe(true);
    expect(schedule.lines[5]!.principalAmount.toFixed(0)).toBe('166671');
    expect(schedule.lines.every((l) => l.interestAmount.equals(15_000))).toBe(true);
    expect(sum(schedule.lines.map((l) => l.principalAmount)).equals(1_000_001)).toBe(true);
    expect(sum(schedule.lines.map((l) => l.interestAmount)).equals(schedule.totalInterest)).toBe(true);
    expect(sum(schedule.lines.map((l) => l.totalAmount)).equals(schedule.totalPayable)).toBe(true);
  });

  it('rounds the total interest down (customer-favourable) and keeps every amount whole', () => {
    // 12-month 18% on 7,777,777: 1,399,999.86 → 1,399,999
    const schedule = buildInstallmentSchedule({ creditAmount: D(7_777_777), interestRatePercent: D('18.00'), durationMonths: 12, purchaseDate: '2026-01-15' });
    expect(schedule.totalInterest.toFixed(0)).toBe('1399999');
    for (const line of schedule.lines) {
      expect(line.principalAmount.isInteger() && line.interestAmount.isInteger() && line.totalAmount.isInteger()).toBe(true);
      expect(line.totalAmount.equals(line.principalAmount.plus(line.interestAmount))).toBe(true);
    }
    expect(sum(schedule.lines.map((l) => l.principalAmount)).equals(7_777_777)).toBe(true);
  });

  it('holds the exact-sum property over many amounts and plans', () => {
    for (const months of [1, 3, 6, 12]) {
      for (const rate of ['0', '9', '18', '12.5']) {
        for (const amount of [1, 2, 11, 999_999, 1_234_567, 100_000_000]) {
          const s = buildInstallmentSchedule({ creditAmount: D(amount), interestRatePercent: D(rate), durationMonths: months, purchaseDate: '2026-02-01' });
          expect(sum(s.lines.map((l) => l.principalAmount)).equals(amount)).toBe(true);
          expect(sum(s.lines.map((l) => l.interestAmount)).equals(s.totalInterest)).toBe(true);
          expect(s.lines.every((l) => !l.principalAmount.lessThan(0))).toBe(true);
        }
      }
    }
  });

  it('dates instalment k at purchase date + 30·k days, across month and year ends', () => {
    const schedule = buildInstallmentSchedule({ creditAmount: D(600), interestRatePercent: D(0), durationMonths: 6, purchaseDate: '2026-11-20' });
    expect(schedule.lines.map((l) => l.dueDate)).toEqual(['2026-12-20', '2027-01-19', '2027-02-18', '2027-03-20', '2027-04-19', '2027-05-19']);
    expect(schedule.lines.map((l) => `${l.installmentNumber}/${l.totalInstallments}`)).toEqual(['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']);
  });

  it('rejects fractional or non-positive amounts, bad durations and negative rates', () => {
    const base = { interestRatePercent: D(0), durationMonths: 3, purchaseDate: '2026-09-27' };
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D('100.50') })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(0) })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(100), durationMonths: 0 })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(100), interestRatePercent: D(-1) })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(100), purchaseDate: '27/09/2026' })).toThrow(InstallmentMathError);
  });
});

describe('calendar helpers', () => {
  it('platformDate uses the Asia/Tehran calendar day', () => {
    // 21:00 UTC on 27 Sep is already 28 Sep in Tehran (UTC+03:30).
    expect(platformDate(new Date('2026-09-27T21:00:00Z'))).toBe('2026-09-28');
    expect(platformDate(new Date('2026-09-27T19:00:00Z'))).toBe('2026-09-27');
  });

  it('addDays is pure calendar arithmetic (leap years included)', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-12-31', 30)).toBe('2027-01-30');
  });

  it('round-trips calendar dates through the DB representation', () => {
    expect(dbDateToCalendar(calendarDateToDb('2026-10-27'))).toBe('2026-10-27');
  });
});
