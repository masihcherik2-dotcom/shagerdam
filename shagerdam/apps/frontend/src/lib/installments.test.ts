import { describe, expect, it } from 'vitest';

import { previewInstallments, splitCreditPayment } from './installments';
import { addRials, compareRials, multiplyRials, shareOf, subtractRials } from './money';

describe('previewInstallments (mirror of backend installment-math)', () => {
  it('0% plan over 3 months splits the principal, remainder on the last instalment', () => {
    const preview = previewInstallments('10000001.00', '0.00', 3);
    expect(preview.totalInterest).toBe('0.00');
    expect(preview.totalPayable).toBe('10000001.00');
    expect(preview.lines.map((line) => line.totalAmount)).toEqual(['3333333.00', '3333333.00', '3333335.00']);
  });

  it('applies the whole-plan rate once and floors interest in the customer’s favour', () => {
    // 12,345,679 × 9% = 1,111,111.11 → 1,111,111
    const preview = previewInstallments(12_345_679, '9.00', 6);
    expect(preview.totalInterest).toBe('1111111.00');
    expect(preview.totalPayable).toBe('13456790.00');
    const principal = preview.lines.reduce((sum, line) => addRials(sum, line.principalAmount), '0');
    const interest = preview.lines.reduce((sum, line) => addRials(sum, line.interestAmount), '0');
    expect(principal).toBe('12345679.00');
    expect(interest).toBe('1111111.00');
    expect(preview.regularInstallment).toBe(addRials(preview.lines[0]!.principalAmount, preview.lines[0]!.interestAmount));
  });

  it('supports fractional rates', () => {
    expect(previewInstallments(1_000_000, '18.5', 12).totalInterest).toBe('185000.00');
  });

  it('rejects invalid input', () => {
    expect(() => previewInstallments(0, '0', 3)).toThrow();
    expect(() => previewInstallments('100.50', '0', 3)).toThrow();
    expect(() => previewInstallments(100, '0', 0)).toThrow();
    expect(() => previewInstallments(100, 'x', 3)).toThrow();
  });
});

describe('splitCreditPayment (mirror of backend splitPayment)', () => {
  it('BANK_CREDIT needs the whole amount', () => {
    expect(splitCreditPayment('BANK_CREDIT', '5000000.00', '5000000.00')).toEqual({ ok: true, creditAmount: '5000000.00', cashAmount: '0.00' });
    expect(splitCreditPayment('BANK_CREDIT', '5000000.00', '4999999.00')).toEqual({ ok: false, reason: 'INSUFFICIENT_CREDIT' });
  });

  it('HYBRID deducts the whole-Rial available credit and leaves the rest to the card', () => {
    expect(splitCreditPayment('HYBRID', '5000000.00', '1200000.75')).toEqual({ ok: true, creditAmount: '1200000.00', cashAmount: '3800000.00' });
    expect(splitCreditPayment('HYBRID', '5000000.00', '5000000.00')).toEqual({ ok: false, reason: 'HYBRID_NOT_REQUIRED' });
    expect(splitCreditPayment('HYBRID', '5000000.00', '0.50')).toEqual({ ok: false, reason: 'INSUFFICIENT_CREDIT' });
  });

  it('refuses non-whole payable amounts', () => {
    expect(splitCreditPayment('HYBRID', '5000000.50', '100.00')).toEqual({ ok: false, reason: 'AMOUNT_NOT_WHOLE_RIALS' });
  });
});

describe('money helpers', () => {
  it('compares, adds, subtracts and multiplies exactly', () => {
    expect(compareRials('0.10', 0.1)).toBe(0);
    expect(compareRials('10.00', '9.99')).toBe(1);
    expect(addRials('0.10', '0.20')).toBe('0.30');
    expect(subtractRials('100.00', '250.50')).toBe('-150.50');
    expect(multiplyRials('33333.33', 3)).toBe('99999.99');
  });

  it('computes clamped shares for progress bars', () => {
    expect(shareOf('250.00', '1000.00')).toBe(0.25);
    expect(shareOf('2000', '1000')).toBe(1);
    expect(shareOf('-5', '1000')).toBe(0);
    expect(shareOf('5', '0')).toBe(0);
  });
});
