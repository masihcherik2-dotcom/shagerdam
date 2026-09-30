import { ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus } from '@prisma/client';

import type { PaymentOutcomeDto } from './dto/payment.dto';
import { buildResultRedirectQuery } from './payments.controller';

const outcome = (overrides: Partial<PaymentOutcomeDto> = {}): PaymentOutcomeDto => ({
  outcome: 'PAID',
  paymentId: '0b8c7d4e-1111-4222-8333-444455556666',
  paymentStatus: PaymentStatus.SUCCESSFUL,
  parentOrderId: '6f1e2d3c-aaaa-4bbb-8ccc-ddddeeeeffff',
  orderNumber: 'SHP-100000123',
  orderPaymentStatus: ParentOrderPaymentStatus.PAID,
  bankRrn: '123456789012',
  message: 'ok',
  canRetry: false,
  paymentExpiresAt: null,
  purpose: PaymentPurpose.ORDER_CHECKOUT,
  paymentMethod: PaymentMethod.CASH_IPG,
  cashAmount: '1000000.00',
  creditAmount: '0.00',
  installmentScheduleId: null,
  ...overrides,
});

describe('buildResultRedirectQuery', () => {
  it('carries order number, outcome, payment id, order id, purpose and the bank RRN', () => {
    const query = buildResultRedirectQuery(outcome());
    expect(Object.fromEntries(query)).toEqual({
      orderNumber: 'SHP-100000123',
      outcome: 'PAID',
      paymentId: '0b8c7d4e-1111-4222-8333-444455556666',
      parentOrderId: '6f1e2d3c-aaaa-4bbb-8ccc-ddddeeeeffff',
      purpose: 'ORDER_CHECKOUT',
      rrn: '123456789012',
    });
  });

  it('marks instalment repayments so the result page does not judge them by the (already paid) order', () => {
    expect(buildResultRedirectQuery(outcome({ purpose: PaymentPurpose.INSTALLMENT_REPAYMENT })).get('purpose')).toBe('INSTALLMENT_REPAYMENT');
  });

  it('omits rrn when the bank returned none (failed or cancelled payment)', () => {
    const query = buildResultRedirectQuery(outcome({ outcome: 'FAILED', bankRrn: null }));
    expect(query.has('rrn')).toBe(false);
    expect(query.get('outcome')).toBe('FAILED');
  });

  it('URL-encodes values', () => {
    expect(buildResultRedirectQuery(outcome({ bankRrn: 'A&B=C' })).toString()).toContain('rrn=A%26B%3DC');
  });
});
