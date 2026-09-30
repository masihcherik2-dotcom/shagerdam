import { ApiProperty } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus } from '@prisma/client';
import { IsUUID } from 'class-validator';

const MONEY = { type: String, example: '5750000.00', description: 'IRR (Rial), 2 decimals, as a string.' } as const;

export class InitiatePaymentDto {
  @ApiProperty({ format: 'uuid', description: 'An unpaid (PENDING) order of the caller.' })
  @IsUUID('4')
  parentOrderId!: string;
}

export class InitiatePaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ description: 'Send the customer’s browser here to pay.', example: 'https://payment.zarinpal.com/pg/StartPay/A00000000000000000000000000217885159' })
  redirectUrl!: string;
  @ApiProperty({ enum: ['SANDBOX', 'ZARINPAL'], description: 'Active gateway. SANDBOX = simulated bank, development/test only.' })
  gatewayName!: 'SANDBOX' | 'ZARINPAL';
  @ApiProperty(MONEY) amount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ nullable: true, type: Date, description: 'The order is cancelled and its stock released if unpaid by then.' })
  paymentExpiresAt!: Date | null;
}

export const PAYMENT_OUTCOMES = ['PAID', 'FAILED', 'VERIFICATION_PENDING', 'PAID_REQUIRES_REFUND'] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

export class PaymentOutcomeDto {
  @ApiProperty({
    enum: PAYMENT_OUTCOMES,
    description:
      'PAID = verified and the order is paid. FAILED = not paid (see canRetry). VERIFICATION_PENDING = the gateway could not be reached; ' +
      'the payment stays INITIATED and the same callback can be retried. PAID_REQUIRES_REFUND = the bank captured the money but the order ' +
      'had already been paid or closed; finance must refund it manually.',
  })
  outcome!: PaymentOutcome;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ enum: PaymentStatus }) paymentStatus!: PaymentStatus;
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) orderPaymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ nullable: true, type: String, example: '712345678901', description: 'Bank reference number of a successful payment.' })
  bankRrn!: string | null;
  @ApiProperty() message!: string;
  @ApiProperty({ description: 'True when the order is still unpaid and inside its payment window: a new payment can be initiated.' })
  canRetry!: boolean;
  @ApiProperty({ nullable: true, type: Date }) paymentExpiresAt!: Date | null;
  @ApiProperty({ enum: PaymentPurpose, description: 'ORDER_CHECKOUT (the order) or INSTALLMENT_REPAYMENT (one BNPL instalment).' })
  purpose!: PaymentPurpose;
  @ApiProperty({ enum: PaymentMethod, description: 'CASH_IPG = card only; BANK_CREDIT = credit only; HYBRID = credit + card.' })
  paymentMethod!: PaymentMethod;
  @ApiProperty({ type: String, example: '1500000.00', description: 'Card part (IRR).' }) cashAmount!: string;
  @ApiProperty({ type: String, example: '3000000.00', description: 'Credit part (IRR); 0 for CASH_IPG.' }) creditAmount!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'The instalment an INSTALLMENT_REPAYMENT settles.' })
  installmentScheduleId!: string | null;
}
