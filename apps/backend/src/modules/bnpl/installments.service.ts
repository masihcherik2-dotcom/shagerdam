import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, InstallmentStatus, PaymentMethod, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { amountDue } from '../credit/credit-order.service';
import { calendarDateToDb, dbDateToCalendar, platformDate } from '../credit/installment-math';
import { writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { MAX_OPEN_ATTEMPTS, PaymentsService } from '../payments/payments.service';
import type { InstallmentDto, InstallmentPaymentResponseDto, InstallmentsOverviewDto, OrderInstallmentsDto } from './dto/bnpl.dto';
import { PLATFORM_DISPLAY_NAME } from '../../common/brand';

const ZERO = new Prisma.Decimal(0);

const installmentSelect = {
  id: true,
  parentOrderId: true,
  installmentNumber: true,
  totalInstallments: true,
  dueDate: true,
  principalAmount: true,
  interestAmount: true,
  penaltyAmount: true,
  totalAmount: true,
  paidAmount: true,
  status: true,
  paidAt: true,
} satisfies Prisma.InstallmentScheduleSelect;

type InstallmentRow = Prisma.InstallmentScheduleGetPayload<{ select: typeof installmentSelect }>;

/**
 * Instalments of a customer's credit purchases, and their repayment.
 *
 * Repayment goes through the platform card gateway (Phase 7 IPG): `pay` opens a
 * bank session for the amount due; the verified bank callback marks the
 * instalment PAID and restores its principal to the credit line
 * (INSTALLMENT_REPAYMENT_RESTORE) in one transaction — see PaymentsService.
 */
@Injectable()
export class InstallmentsService {
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  /**
   * PENDING instalments whose due date (Asia/Tehran calendar) has passed become
   * OVERDUE. Due on the due date itself is still PENDING. Optionally limited to
   * one customer's accounts (used before listing them).
   */
  async markOverdue(now: Date = new Date(), userId?: string): Promise<number> {
    const today = calendarDateToDb(platformDate(now));
    const result = await this.prisma.installmentSchedule.updateMany({
      where: { status: InstallmentStatus.PENDING, dueDate: { lt: today }, ...(userId ? { creditAccount: { userId } } : {}) },
      data: { status: InstallmentStatus.OVERDUE },
    });
    return result.count;
  }

  async overview(userId: string): Promise<InstallmentsOverviewDto> {
    await this.markOverdue(new Date(), userId);
    const rows = await this.prisma.installmentSchedule.findMany({
      where: { creditAccount: { userId } },
      select: installmentSelect,
      orderBy: [{ parentOrderId: 'asc' }, { installmentNumber: 'asc' }],
    });
    const orderIds = [...new Set(rows.map((row) => row.parentOrderId))];
    const [orders, creditPayments] = await Promise.all([
      this.prisma.parentOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, paymentMethod: true, paidAt: true } }),
      this.prisma.payment.findMany({
        where: { parentOrderId: { in: orderIds }, purpose: PaymentPurpose.ORDER_CHECKOUT, status: PaymentStatus.SUCCESSFUL, installmentPlanId: { not: null } },
        select: { parentOrderId: true, installmentPlan: { select: { id: true, title: true, durationMonths: true, interestRatePercent: true } } },
      }),
    ]);
    const planByOrder = new Map(creditPayments.map((payment) => [payment.parentOrderId, payment.installmentPlan]));
    const byOrder = new Map<string, InstallmentRow[]>();
    for (const row of rows) {
      byOrder.set(row.parentOrderId, [...(byOrder.get(row.parentOrderId) ?? []), row]);
    }
    const groups: OrderInstallmentsDto[] = orders
      .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0))
      .map((order) => {
        const lines = byOrder.get(order.id) ?? [];
        const sum = (pick: (row: InstallmentRow) => Prisma.Decimal): Prisma.Decimal => lines.reduce((acc, row) => acc.plus(pick(row)), ZERO);
        const remaining = lines.reduce((acc, row) => acc.plus(isOpen(row.status) ? amountDue(row) : ZERO), ZERO);
        const plan = planByOrder.get(order.id) ?? null;
        return {
          parentOrderId: order.id,
          orderNumber: order.orderNumber,
          paymentMethod: order.paymentMethod,
          paidAt: order.paidAt,
          plan: plan ? { id: plan.id, title: plan.title, durationMonths: plan.durationMonths, interestRatePercent: plan.interestRatePercent.toFixed(2) } : null,
          creditAmount: sum((row) => row.principalAmount).toFixed(2),
          totalInterest: sum((row) => row.interestAmount).toFixed(2),
          totalPayable: sum((row) => row.totalAmount.plus(row.penaltyAmount)).toFixed(2),
          paidAmount: sum((row) => row.paidAmount).toFixed(2),
          remainingAmount: remaining.toFixed(2),
          paidCount: lines.filter((row) => row.status === InstallmentStatus.PAID).length,
          overdueCount: lines.filter((row) => row.status === InstallmentStatus.OVERDUE).length,
          installments: lines.map(toInstallmentDto),
        };
      });
    return {
      orders: groups,
      totalRemaining: groups.reduce((acc, group) => acc.plus(group.remainingAmount), ZERO).toFixed(2),
      overdueCount: groups.reduce((acc, group) => acc + group.overdueCount, 0),
    };
  }

  /** Opens a card payment for the amount due of one PENDING or OVERDUE instalment. */
  async pay(userId: string, installmentId: string, actor: OrderActor): Promise<InstallmentPaymentResponseDto> {
    const installment = await this.prisma.installmentSchedule.findFirst({
      where: { id: installmentId, creditAccount: { userId } },
      select: { ...installmentSelect, parentOrder: { select: { orderNumber: true, user: { select: { mobile: true } } } } },
    });
    if (!installment) {
      throw new NotFoundException('Instalment not found');
    }
    if (!isOpen(installment.status)) {
      throw conflictWith('INSTALLMENT_NOT_PAYABLE', `This instalment is ${installment.status}`, { installmentStatus: installment.status });
    }
    const due = amountDue(installment);
    if (!due.greaterThan(0)) {
      throw conflictWith('INSTALLMENT_NOT_PAYABLE', 'Nothing is due on this instalment', { installmentStatus: installment.status });
    }
    const open = await this.prisma.payment.count({
      where: { installmentScheduleId: installment.id, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(Date.now() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this instalment; finish or wait for one of them', this.graceMs / 1000);
    }
    const orderNumber = installment.parentOrder.orderNumber;
    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          parentOrderId: installment.parentOrderId,
          purpose: PaymentPurpose.INSTALLMENT_REPAYMENT,
          paymentMethod: PaymentMethod.CASH_IPG,
          installmentScheduleId: installment.id,
          gatewayName: this.payments.gatewayName,
          cashAmount: due,
          creditAmount: 0,
          status: PaymentStatus.INITIATED,
        },
        select: { id: true },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Payment',
        entityId: created.id,
        newValue: {
          purpose: PaymentPurpose.INSTALLMENT_REPAYMENT,
          installmentScheduleId: installment.id,
          installmentNumber: installment.installmentNumber,
          orderNumber,
          amount: due.toFixed(2),
          gatewayName: this.payments.gatewayName,
        },
      });
      return created;
    });
    const initiation = await this.payments.startGatewaySession({
      paymentId: payment.id,
      parentOrderId: installment.parentOrderId,
      orderNumber,
      amount: due,
      description: `پرداخت قسط ${installment.installmentNumber} از ${installment.totalInstallments} سفارش ${orderNumber} — ${PLATFORM_DISPLAY_NAME}`,
      customerMobile: installment.parentOrder.user.mobile,
    });
    return {
      paymentId: payment.id,
      installmentId: installment.id,
      installmentNumber: installment.installmentNumber,
      totalInstallments: installment.totalInstallments,
      orderNumber,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.payments.gatewayName,
      amount: due.toFixed(2),
      currency: 'IRR',
    };
  }
}

function isOpen(status: InstallmentStatus): boolean {
  return status === InstallmentStatus.PENDING || status === InstallmentStatus.OVERDUE;
}

function toInstallmentDto(row: InstallmentRow): InstallmentDto {
  return {
    id: row.id,
    installmentNumber: row.installmentNumber,
    totalInstallments: row.totalInstallments,
    dueDate: dbDateToCalendar(row.dueDate),
    principalAmount: row.principalAmount.toFixed(2),
    interestAmount: row.interestAmount.toFixed(2),
    penaltyAmount: row.penaltyAmount.toFixed(2),
    totalAmount: row.totalAmount.toFixed(2),
    paidAmount: row.paidAmount.toFixed(2),
    amountDue: (isOpen(row.status) ? amountDue(row) : ZERO).toFixed(2),
    status: row.status,
    paidAt: row.paidAt,
  };
}
