import { Injectable, Logger } from '@nestjs/common';
import { InstallmentStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { buildInstallmentSchedule, calendarDateToDb, platformDate } from './installment-math';
import { CreditProviderRegistry } from './providers/credit-provider.registry';

type Tx = Prisma.TransactionClient;

/** The credit part of a payment attempt (BANK_CREDIT or HYBRID). */
export interface CreditPart {
  id: string;
  parentOrderId: string;
  creditAmount: Prisma.Decimal;
  creditAccountId: string | null;
  creditReservationRef: string | null;
  installmentPlanId: string | null;
}

/**
 * A provider call that must happen after the database transaction committed
 * (the provider is an external system and cannot join the transaction).
 */
export interface ProviderFollowUp {
  paymentId: string;
  creditAccountId: string;
  reservationRef: string;
  action: 'COMMIT' | 'RELEASE';
}

export interface ScheduleSummary {
  installments: number;
  creditAmount: string;
  totalInterest: string;
  totalPayable: string;
  firstDueDate: string;
  lastDueDate: string;
}

export interface RepaymentApplication {
  applied: boolean;
  installmentStatus: InstallmentStatus;
  restoredPrincipal: string;
}

/**
 * Order-side credit operations shared by the card-payment callback, the BNPL
 * checkout and the order lifecycle. All `…Locked` methods run in the caller's
 * transaction, which must already hold the parent-order lock (or, for
 * repayments, nothing else: the instalment row is locked here).
 */
@Injectable()
export class CreditOrderService {
  private readonly logger = new Logger(CreditOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
    private readonly registry: CreditProviderRegistry,
  ) {}

  /**
   * The order is being paid: commit the reservation (reserved → used) and write
   * the instalment schedule of the chosen plan, in the same transaction.
   */
  async commitAndScheduleLocked(tx: Tx, part: CreditPart, paidAt: Date): Promise<{ followUp: ProviderFollowUp; schedule: ScheduleSummary }> {
    const { accountId, ref, planId } = requireCreditPart(part);
    await this.ledger.commit(tx, accountId, ref);
    const plan = await tx.installmentPlan.findUniqueOrThrow({ where: { id: planId }, select: { durationMonths: true, interestRatePercent: true } });
    const schedule = buildInstallmentSchedule({
      creditAmount: part.creditAmount,
      interestRatePercent: plan.interestRatePercent,
      durationMonths: plan.durationMonths,
      purchaseDate: platformDate(paidAt),
    });
    await tx.installmentSchedule.createMany({
      data: schedule.lines.map((line) => ({
        parentOrderId: part.parentOrderId,
        creditAccountId: accountId,
        installmentNumber: line.installmentNumber,
        totalInstallments: line.totalInstallments,
        dueDate: calendarDateToDb(line.dueDate),
        principalAmount: line.principalAmount,
        interestAmount: line.interestAmount,
        totalAmount: line.totalAmount,
        status: InstallmentStatus.PENDING,
      })),
    });
    return {
      followUp: { paymentId: part.id, creditAccountId: accountId, reservationRef: ref, action: 'COMMIT' },
      schedule: {
        installments: schedule.lines.length,
        creditAmount: schedule.creditAmount.toFixed(2),
        totalInterest: schedule.totalInterest.toFixed(2),
        totalPayable: schedule.totalPayable.toFixed(2),
        firstDueDate: schedule.lines[0]!.dueDate,
        lastDueDate: schedule.lines[schedule.lines.length - 1]!.dueDate,
      },
    };
  }

  /** Releases the reservation of one payment attempt if it is still held. */
  async releaseLocked(tx: Tx, part: CreditPart): Promise<ProviderFollowUp | null> {
    if (!part.creditAmount.greaterThan(0) || part.creditAccountId === null || part.creditReservationRef === null) {
      return null;
    }
    const released = await this.ledger.release(tx, part.creditAccountId, part.creditReservationRef);
    return released ? { paymentId: part.id, creditAccountId: part.creditAccountId, reservationRef: part.creditReservationRef, action: 'RELEASE' } : null;
  }

  /**
   * Releases every still-held reservation of an order's payment attempts
   * (order cancelled / expired, or paid by another attempt). Attempts whose
   * gateway session may still settle keep their status: a late capture is
   * then flagged for manual refund and never re-uses the released credit.
   */
  async releaseOpenReservationsLocked(tx: Tx, parentOrderId: string, exceptPaymentId?: string): Promise<ProviderFollowUp[]> {
    const attempts = await tx.payment.findMany({
      where: {
        parentOrderId,
        creditReservationRef: { not: null },
        status: { in: [PaymentStatus.INITIATED, PaymentStatus.FAILED] },
        ...(exceptPaymentId ? { id: { not: exceptPaymentId } } : {}),
      },
      select: { id: true, parentOrderId: true, creditAmount: true, creditAccountId: true, creditReservationRef: true, installmentPlanId: true },
      orderBy: { creditAccountId: 'asc' },
    });
    const followUps: ProviderFollowUp[] = [];
    for (const attempt of attempts) {
      const followUp = await this.releaseLocked(tx, attempt);
      if (followUp) followUps.push(followUp);
    }
    return followUps;
  }

  /**
   * A card payment for an instalment was verified: the instalment becomes PAID
   * and its principal returns to the credit line (INSTALLMENT_REPAYMENT_RESTORE).
   * `applied: false` when it was already paid (or waived) — the caller flags the
   * money for manual refund.
   */
  async applyRepaymentLocked(tx: Tx, installmentId: string, amountPaid: Prisma.Decimal, bank: { bankRrn: string | null; paidAt: Date }): Promise<RepaymentApplication> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM installment_schedules WHERE id = ${installmentId}::uuid FOR UPDATE`);
    if (rows.length !== 1) {
      throw new Error(`Instalment ${installmentId} does not exist`);
    }
    const installment = await tx.installmentSchedule.findUniqueOrThrow({
      where: { id: installmentId },
      select: { id: true, status: true, parentOrderId: true, creditAccountId: true, principalAmount: true, totalAmount: true, penaltyAmount: true, paidAmount: true },
    });
    if (installment.status !== InstallmentStatus.PENDING && installment.status !== InstallmentStatus.OVERDUE) {
      return { applied: false, installmentStatus: installment.status, restoredPrincipal: '0.00' };
    }
    const due = amountDue(installment);
    if (!amountPaid.equals(due)) {
      // The amount due is fixed at initiation; a mismatch means the instalment changed meanwhile.
      this.logger.error(`Instalment ${installmentId}: paid ${amountPaid.toFixed(2)} but ${due.toFixed(2)} is due; left unpaid for manual review`);
      return { applied: false, installmentStatus: installment.status, restoredPrincipal: '0.00' };
    }
    await tx.installmentSchedule.update({
      where: { id: installmentId },
      data: { status: InstallmentStatus.PAID, paidAmount: installment.paidAmount.plus(amountPaid), paidAt: bank.paidAt, bankTransactionId: bank.bankRrn },
    });
    const restored = await this.ledger.restoreRepayment(tx, installment.creditAccountId, installment.principalAmount, installment.id, installment.parentOrderId);
    return { applied: true, installmentStatus: InstallmentStatus.PAID, restoredPrincipal: restored ? installment.principalAmount.toFixed(2) : '0.00' };
  }

  /**
   * Performs the provider calls of committed transactions. A failure never
   * undoes the committed database state (the platform ledger is the record);
   * it is logged and stored on the payment (`metadata.providerSync`) for
   * reconciliation.
   */
  async followUp(actions: readonly ProviderFollowUp[]): Promise<void> {
    for (const action of actions) {
      try {
        const account = await this.prisma.creditAccount.findUniqueOrThrow({ where: { id: action.creditAccountId }, select: { providerId: true } });
        const adapter = await this.registry.adapterForProviderId(account.providerId);
        if (action.action === 'COMMIT') {
          await adapter.commitCredit(action.reservationRef);
        } else {
          await adapter.releaseCredit(action.reservationRef);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Provider ${action.action} of reservation ${action.reservationRef} (payment ${action.paymentId}) failed: ${message}`);
        await this.recordProviderSyncFailure(action, message);
      }
    }
  }

  private async recordProviderSyncFailure(action: ProviderFollowUp, message: string): Promise<void> {
    try {
      const payment = await this.prisma.payment.findUnique({ where: { id: action.paymentId }, select: { metadata: true } });
      const metadata = typeof payment?.metadata === 'object' && payment.metadata !== null && !Array.isArray(payment.metadata) ? payment.metadata : {};
      await this.prisma.payment.update({
        where: { id: action.paymentId },
        data: { metadata: { ...metadata, providerSync: { action: action.action, status: 'FAILED', message: message.slice(0, 300), at: new Date().toISOString() } } },
      });
    } catch (error) {
      this.logger.error(`Could not record the provider sync failure on payment ${action.paymentId}: ${String(error)}`);
    }
  }
}

/** What a customer owes for an instalment right now (penalties are not computed in Phase 8, so penaltyAmount is 0). */
export function amountDue(installment: { totalAmount: Prisma.Decimal; penaltyAmount: Prisma.Decimal; paidAmount: Prisma.Decimal }): Prisma.Decimal {
  return installment.totalAmount.plus(installment.penaltyAmount).minus(installment.paidAmount);
}

function requireCreditPart(part: CreditPart): { accountId: string; ref: string; planId: string } {
  if (!part.creditAmount.greaterThan(0) || part.creditAccountId === null || part.creditReservationRef === null || part.installmentPlanId === null) {
    throw new Error(`Payment ${part.id} has no credit part`);
  }
  return { accountId: part.creditAccountId, ref: part.creditReservationRef, planId: part.installmentPlanId };
}
