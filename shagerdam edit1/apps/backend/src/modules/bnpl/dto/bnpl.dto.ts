import { ApiProperty } from '@nestjs/swagger';
import { InstallmentStatus, ParentOrderPaymentStatus, PaymentMethod } from '@prisma/client';
import { IsIn, IsUUID } from 'class-validator';
import { MONEY } from '../../wallet/dto/wallet.dto';

export const CREDIT_PAYMENT_METHODS = [PaymentMethod.BANK_CREDIT, PaymentMethod.HYBRID] as const;
export type CreditPaymentMethod = (typeof CREDIT_PAYMENT_METHODS)[number];

// ─── input ──────────────────────────────────────────────────────────────────

export class InitiateCreditPaymentDto {
  @ApiProperty({ format: 'uuid', description: 'A PENDING order of yours (from `POST /checkout`).' })
  @IsUUID()
  parentOrderId!: string;

  @ApiProperty({ format: 'uuid', description: 'An active plan of the active provider (`GET /credit/plans`).' })
  @IsUUID()
  planId!: string;

  @ApiProperty({
    enum: CREDIT_PAYMENT_METHODS,
    description:
      'BANK_CREDIT: the whole amount on credit (available ≥ finalPayableAmount). HYBRID: all available credit (whole rials) + the rest by ' +
      'card; only when available < finalPayableAmount.',
  })
  @IsIn(CREDIT_PAYMENT_METHODS)
  paymentMethod!: CreditPaymentMethod;
}

// ─── output ─────────────────────────────────────────────────────────────────

export class ScheduleSummaryDto {
  @ApiProperty({ example: 6 }) installments!: number;
  @ApiProperty(MONEY) creditAmount!: string;
  @ApiProperty(MONEY) totalInterest!: string;
  @ApiProperty(MONEY) totalPayable!: string;
  @ApiProperty({ example: '2026-10-27' }) firstDueDate!: string;
  @ApiProperty({ example: '2027-03-26' }) lastDueDate!: string;
}

export class InstallmentPlanRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() durationMonths!: number;
  @ApiProperty({ example: '9.00' }) interestRatePercent!: string;
}

export const CREDIT_INITIATE_STATUSES = ['COMPLETED', 'IPG_REQUIRED'] as const;

export class CreditPaymentInitiateResponseDto {
  @ApiProperty({
    enum: CREDIT_INITIATE_STATUSES,
    description: 'COMPLETED: BANK_CREDIT — the order is PAID now. IPG_REQUIRED: HYBRID — credit is reserved; send the customer to `redirectUrl` for the card part.',
  })
  status!: (typeof CREDIT_INITIATE_STATUSES)[number];
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ enum: CREDIT_PAYMENT_METHODS }) paymentMethod!: CreditPaymentMethod;
  @ApiProperty(MONEY) creditAmount!: string;
  @ApiProperty(MONEY) cashAmount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ type: InstallmentPlanRefDto }) plan!: InstallmentPlanRefDto;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) orderPaymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ nullable: true, type: String, description: 'IPG_REQUIRED only: the bank payment page for cashAmount.' }) redirectUrl!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'sandbox', description: 'IPG_REQUIRED only.' }) gatewayName!: string | null;
  @ApiProperty({ nullable: true, type: Date, description: 'IPG_REQUIRED only: the card part must be paid before this.' }) paymentExpiresAt!: Date | null;
  @ApiProperty({ type: ScheduleSummaryDto, nullable: true, description: 'COMPLETED only: the instalment schedule created (HYBRID: created when the card part is verified).' })
  schedule!: ScheduleSummaryDto | null;
}

export class InstallmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 1 }) installmentNumber!: number;
  @ApiProperty({ example: 6 }) totalInstallments!: number;
  @ApiProperty({ example: '2026-10-27', description: 'Calendar date (Asia/Tehran).' }) dueDate!: string;
  @ApiProperty(MONEY) principalAmount!: string;
  @ApiProperty(MONEY) interestAmount!: string;
  @ApiProperty({ ...MONEY, description: 'Late penalty (not applied automatically in this phase: always 0).' }) penaltyAmount!: string;
  @ApiProperty(MONEY) totalAmount!: string;
  @ApiProperty(MONEY) paidAmount!: string;
  @ApiProperty({ ...MONEY, description: 'What `POST /credit/installments/{id}/pay` charges now (0 when settled).' }) amountDue!: string;
  @ApiProperty({ enum: InstallmentStatus, description: 'PENDING, PAID or OVERDUE (due date passed unpaid). WAIVED is reserved for staff.' })
  status!: InstallmentStatus;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
}

export class OrderInstallmentsDto {
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ type: InstallmentPlanRefDto, nullable: true }) plan!: InstallmentPlanRefDto | null;
  @ApiProperty({ ...MONEY, description: 'Financed principal (sum of instalment principals).' }) creditAmount!: string;
  @ApiProperty(MONEY) totalInterest!: string;
  @ApiProperty(MONEY) totalPayable!: string;
  @ApiProperty(MONEY) paidAmount!: string;
  @ApiProperty(MONEY) remainingAmount!: string;
  @ApiProperty() paidCount!: number;
  @ApiProperty() overdueCount!: number;
  @ApiProperty({ type: [InstallmentDto] }) installments!: InstallmentDto[];
}

export class InstallmentsOverviewDto {
  @ApiProperty({ type: [OrderInstallmentsDto], description: 'Credit-financed orders, newest first.' }) orders!: OrderInstallmentsDto[];
  @ApiProperty({ ...MONEY, description: 'Unpaid amount over all orders.' }) totalRemaining!: string;
  @ApiProperty() overdueCount!: number;
}

export class InstallmentPaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid' }) installmentId!: string;
  @ApiProperty() installmentNumber!: number;
  @ApiProperty() totalInstallments!: number;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ description: 'Bank payment page; the instalment becomes PAID when the bank callback is verified.' }) redirectUrl!: string;
  @ApiProperty({ example: 'sandbox' }) gatewayName!: string;
  @ApiProperty(MONEY) amount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
}
