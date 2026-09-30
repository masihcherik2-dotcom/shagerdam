import { Injectable } from '@nestjs/common';
import { CreditAccountStatus, CreditTransactionType, Prisma } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import { applyCreditMovement, InsufficientCreditError, reservationStateOf, zeroBalances, type CreditBalances, type ReservationState } from './credit-math';

type Tx = Prisma.TransactionClient;

export interface LockedCreditAccount {
  id: string;
  userId: string;
  providerId: string;
  status: CreditAccountStatus;
  balances: CreditBalances;
}

interface AccountRow {
  id: string;
  user_id: string;
  provider_id: string;
  status: CreditAccountStatus;
  total_limit: Prisma.Decimal;
  used_amount: Prisma.Decimal;
  reserved_amount: Prisma.Decimal;
  available_amount: Prisma.Decimal;
}

/**
 * The only writer of credit accounts (TM brief §2). Every method runs in the
 * caller's transaction, locks the account row (`SELECT … FOR UPDATE`), applies
 * the movement with the pure `applyCreditMovement` (which refuses to take more
 * than a bucket holds) and writes the new balances and one `CreditTransaction`
 * row together — so the ledger and the projection commit or roll back as one.
 *
 * Guarantees, each also enforced by PostgreSQL (migration phase8_credit):
 * - invariant totalLimit = used + reserved + available, all ≥ 0 (CHECK);
 * - one row per (type, referenceCode): a reservation is held, committed or
 *   released at most once, an instalment restores credit at most once (UNIQUE);
 * - a reservation ends once: commit XOR release (partial UNIQUE).
 *
 * Lock order across the platform: parent order → credit account → stock rows →
 * vendor wallets. Callers must follow it.
 */
@Injectable()
export class CreditLedgerService {
  async lock(tx: Tx, creditAccountId: string): Promise<LockedCreditAccount> {
    const rows = await tx.$queryRaw<AccountRow[]>(Prisma.sql`
      SELECT id, user_id, provider_id, status, total_limit, used_amount, reserved_amount, available_amount
      FROM credit_accounts WHERE id = ${creditAccountId}::uuid FOR UPDATE`);
    const row = rows[0];
    if (!row) {
      throw new Error(`Credit account ${creditAccountId} does not exist`);
    }
    return {
      id: row.id,
      userId: row.user_id,
      providerId: row.provider_id,
      status: row.status,
      balances: {
        totalLimit: new Prisma.Decimal(row.total_limit),
        usedAmount: new Prisma.Decimal(row.used_amount),
        reservedAmount: new Prisma.Decimal(row.reserved_amount),
        availableAmount: new Prisma.Decimal(row.available_amount),
      },
    };
  }

  /** Opens a credit line with its CREDIT_ALLOCATION row (reference = the approved application). */
  async openAccount(tx: Tx, input: { userId: string; providerId: string; limit: Prisma.Decimal; applicationId: string; expiresAt: Date | null }): Promise<string> {
    const balances = applyCreditMovement(zeroBalances(), CreditTransactionType.CREDIT_ALLOCATION, input.limit);
    const account = await tx.creditAccount.create({
      data: {
        userId: input.userId,
        providerId: input.providerId,
        totalLimit: balances.totalLimit,
        usedAmount: balances.usedAmount,
        reservedAmount: balances.reservedAmount,
        availableAmount: balances.availableAmount,
        status: CreditAccountStatus.ACTIVE,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });
    await tx.creditTransaction.create({
      data: {
        creditAccountId: account.id,
        type: CreditTransactionType.CREDIT_ALLOCATION,
        amount: input.limit,
        balanceAfter: balances.availableAmount,
        referenceCode: input.applicationId,
      },
    });
    return account.id;
  }

  /** Checkout: available → reserved. 409 INSUFFICIENT_CREDIT / CREDIT_ACCOUNT_NOT_ACTIVE. */
  async hold(tx: Tx, creditAccountId: string, amount: Prisma.Decimal, reservationRef: string, parentOrderId: string): Promise<CreditBalances> {
    const account = await this.lock(tx, creditAccountId);
    if (account.status !== CreditAccountStatus.ACTIVE) {
      throw conflictWith('CREDIT_ACCOUNT_NOT_ACTIVE', `The credit account is ${account.status}`, { accountStatus: account.status });
    }
    return this.post(tx, account, CreditTransactionType.PURCHASE_RESERVE_HOLD, amount, reservationRef, parentOrderId);
  }

  /**
   * Order paid: reserved → used. Returns false if already committed (idempotent);
   * 409 if the reservation was released meanwhile (the caller must not complete a
   * credit purchase whose hold is gone).
   */
  async commit(tx: Tx, creditAccountId: string, reservationRef: string): Promise<boolean> {
    const account = await this.lock(tx, creditAccountId);
    const { state, amount, parentOrderId } = await this.reservation(tx, creditAccountId, reservationRef);
    if (state === 'COMMITTED') return false;
    if (state !== 'HELD') {
      throw conflictWith('CREDIT_RESERVATION_NOT_HELD', `Credit reservation ${reservationRef} is ${state}`, { reservationState: state });
    }
    await this.post(tx, account, CreditTransactionType.PURCHASE_COMMIT, amount, reservationRef, parentOrderId);
    return true;
  }

  /** Checkout failed / cancelled / expired: reserved → available. Returns false if not held (already ended or never held). */
  async release(tx: Tx, creditAccountId: string, reservationRef: string): Promise<boolean> {
    const account = await this.lock(tx, creditAccountId);
    const { state, amount, parentOrderId } = await this.reservation(tx, creditAccountId, reservationRef);
    if (state !== 'HELD') return false;
    await this.post(tx, account, CreditTransactionType.RESERVATION_RELEASE, amount, reservationRef, parentOrderId);
    return true;
  }

  /** Instalment paid: used → available by its principal. Returns false if this instalment already restored credit. */
  async restoreRepayment(tx: Tx, creditAccountId: string, principal: Prisma.Decimal, installmentId: string, parentOrderId: string): Promise<boolean> {
    const account = await this.lock(tx, creditAccountId);
    const done = await tx.creditTransaction.count({
      where: { type: CreditTransactionType.INSTALLMENT_REPAYMENT_RESTORE, referenceCode: installmentId },
    });
    if (done > 0 || !principal.greaterThan(0)) return false;
    await this.post(tx, account, CreditTransactionType.INSTALLMENT_REPAYMENT_RESTORE, principal, installmentId, parentOrderId);
    return true;
  }

  async reservationState(tx: Tx, creditAccountId: string, reservationRef: string): Promise<ReservationState> {
    return (await this.reservation(tx, creditAccountId, reservationRef)).state;
  }

  private async reservation(
    tx: Tx,
    creditAccountId: string,
    reservationRef: string,
  ): Promise<{ state: ReservationState; amount: Prisma.Decimal; parentOrderId: string | null }> {
    const rows = await tx.creditTransaction.findMany({
      where: { creditAccountId, referenceCode: reservationRef },
      select: { type: true, amount: true, parentOrderId: true },
    });
    const hold = rows.find((row) => row.type === CreditTransactionType.PURCHASE_RESERVE_HOLD);
    return {
      state: reservationStateOf(rows.map((row) => row.type)),
      amount: hold?.amount ?? new Prisma.Decimal(0),
      parentOrderId: hold?.parentOrderId ?? null,
    };
  }

  private async post(
    tx: Tx,
    account: LockedCreditAccount,
    type: CreditTransactionType,
    amount: Prisma.Decimal,
    referenceCode: string,
    parentOrderId: string | null,
  ): Promise<CreditBalances> {
    let next: CreditBalances;
    try {
      next = applyCreditMovement(account.balances, type, amount);
    } catch (error) {
      if (error instanceof InsufficientCreditError) {
        throw conflictWith('INSUFFICIENT_CREDIT', `Not enough ${error.bucket} credit for this operation`, {
          bucket: error.bucket,
          available: error.available.toFixed(2),
          requested: error.requested.toFixed(2),
        });
      }
      throw error;
    }
    await tx.creditAccount.update({
      where: { id: account.id },
      data: { totalLimit: next.totalLimit, usedAmount: next.usedAmount, reservedAmount: next.reservedAmount, availableAmount: next.availableAmount },
    });
    await tx.creditTransaction.create({
      data: { creditAccountId: account.id, parentOrderId, type, amount, balanceAfter: next.availableAmount, referenceCode },
    });
    account.balances = next; // the lock is held: later movements in this transaction start from here
    return next;
  }
}
