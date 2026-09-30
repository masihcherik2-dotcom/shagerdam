import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { FinancialOverviewDto, FinancialOverviewQueryDto } from './dto/financial.dto';

type Money = Prisma.Decimal | null;
const money = (value: Money): string => new Prisma.Decimal(value ?? 0).toFixed(2);

/**
 * Platform finance figures, computed live from the database (no cached
 * aggregates that could drift). Definitions are documented on the DTO fields
 * and in docs/phase-7-deliverable.md.
 */
@Injectable()
export class FinancialService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(query: FinancialOverviewQueryDto): Promise<FinancialOverviewDto> {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && to && from >= to) {
      throw new BadRequestException('from must be earlier than to');
    }
    const paidWindow = Prisma.sql`${from ? Prisma.sql`AND po.paid_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND po.paid_at < ${to}` : Prisma.empty}`;
    const processedWindow = Prisma.sql`${from ? Prisma.sql`AND processed_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND processed_at < ${to}` : Prisma.empty}`;
    const resolvedWindow = Prisma.sql`${from ? Prisma.sql`AND resolved_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND resolved_at < ${to}` : Prisma.empty}`;
    const paymentWindow = Prisma.sql`${from ? Prisma.sql`AND paid_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND paid_at < ${to}` : Prisma.empty}`;

    const [sales, collected, wallets, reconciliation, settlements, manualRefunds, disputes] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Array<{ paid_orders: bigint; active_packages: bigint; gmv: Money; shipping: Money; commission_earned: Money; commission_pending: Money }>>(Prisma.sql`
        SELECT COUNT(DISTINCT po.id) AS paid_orders,
               COUNT(so.id) FILTER (WHERE so.status NOT IN ('CANCELLED', 'REFUNDED')) AS active_packages,
               SUM(so.items_subtotal) FILTER (WHERE so.status NOT IN ('CANCELLED', 'REFUNDED')) AS gmv,
               SUM(so.shipping_fee) FILTER (WHERE so.status NOT IN ('CANCELLED', 'REFUNDED')) AS shipping,
               SUM(so.platform_commission_amount) FILTER (WHERE so.status = 'DELIVERED') AS commission_earned,
               SUM(so.platform_commission_amount) FILTER (WHERE so.status IN ('PENDING_APPROVAL', 'PROCESSING', 'SHIPPED')) AS commission_pending
        FROM parent_orders po
        JOIN sub_orders so ON so.parent_order_id = po.id
        WHERE po.payment_status = 'PAID' ${paidWindow}`),
      this.prisma.$queryRaw<Array<{ collected: Money; funded_by_credit: Money; installments_collected: Money }>>(Prisma.sql`
        SELECT SUM(cash_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS collected,
               SUM(credit_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS funded_by_credit,
               SUM(cash_amount) FILTER (WHERE purpose = 'INSTALLMENT_REPAYMENT') AS installments_collected
        FROM payments WHERE status = 'SUCCESSFUL' ${paymentWindow}`),
      this.prisma.$queryRaw<Array<{ pending: Money; withdrawable: Money; hold: Money; dispute_hold: Money; withdrawn: Money }>>(Prisma.sql`
        SELECT SUM(pending_balance) AS pending, SUM(withdrawable_balance) AS withdrawable,
               SUM(settlement_hold_balance) AS hold, SUM(dispute_hold_balance) AS dispute_hold, SUM(total_withdrawn_amount) AS withdrawn
        FROM vendor_wallets`),
      this.prisma.$queryRaw<Array<{ inconsistent: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS inconsistent FROM (
          SELECT w.id
          FROM vendor_wallets w
          LEFT JOIN wallet_transactions t ON t.wallet_id = w.id
          GROUP BY w.id, w.pending_balance, w.withdrawable_balance, w.settlement_hold_balance, w.dispute_hold_balance
          HAVING COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'PENDING'), 0) <> w.pending_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'WITHDRAWABLE'), 0) <> w.withdrawable_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'SETTLEMENT_HOLD'), 0) <> w.settlement_hold_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'DISPUTE_HOLD'), 0) <> w.dispute_hold_balance
        ) AS drift`),
      this.prisma.$queryRaw<Array<{ pending_count: bigint; pending_amount: Money; paid_count: bigint; paid_amount: Money }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS pending_count,
               SUM(amount) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS pending_amount,
               COUNT(*) FILTER (WHERE status = 'PAID_PAYA' ${processedWindow}) AS paid_count,
               SUM(amount) FILTER (WHERE status = 'PAID_PAYA' ${processedWindow}) AS paid_amount
        FROM settlement_requests`),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS count FROM payments WHERE status = 'SUCCESSFUL' AND metadata ->> 'requiresManualRefund' = 'true'`),
      this.prisma.$queryRaw<Array<{ open_count: bigint; arbitration_count: bigint; buyer_favor_count: bigint; refunds_owed: Money; unrecovered: Money }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('OPEN', 'VENDOR_RESPONDED')) AS open_count,
               COUNT(*) FILTER (WHERE status = 'UNDER_ARBITRATION') AS arbitration_count,
               COUNT(*) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS buyer_favor_count,
               SUM(refund_amount) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS refunds_owed,
               SUM(refund_unrecovered_amount) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS unrecovered
        FROM disputes`),
    ]);
    const dq = disputes[0];

    const s = sales[0];
    const w = wallets[0];
    const st = settlements[0];
    const earned = new Prisma.Decimal(s?.commission_earned ?? 0);
    const pending = new Prisma.Decimal(s?.commission_pending ?? 0);
    const inconsistentWallets = Number(reconciliation[0]?.inconsistent ?? 0);
    return {
      currency: 'IRR',
      from,
      to,
      generatedAt: new Date(),
      sales: {
        paidOrders: Number(s?.paid_orders ?? 0),
        activePackages: Number(s?.active_packages ?? 0),
        gmv: money(s?.gmv ?? null),
        shippingFees: money(s?.shipping ?? null),
        collectedByGateway: money(collected[0]?.collected ?? null),
        fundedByCredit: money(collected[0]?.funded_by_credit ?? null),
        installmentsCollected: money(collected[0]?.installments_collected ?? null),
      },
      commission: { earned: earned.toFixed(2), pending: pending.toFixed(2), total: earned.plus(pending).toFixed(2) },
      wallets: {
        escrowHeld: money(w?.pending ?? null),
        withdrawable: money(w?.withdrawable ?? null),
        settlementHold: money(w?.hold ?? null),
        disputeHold: money(w?.dispute_hold ?? null),
        totalWithdrawn: money(w?.withdrawn ?? null),
        ledgerConsistent: inconsistentWallets === 0,
        inconsistentWallets,
      },
      settlements: {
        pendingCount: Number(st?.pending_count ?? 0),
        pendingAmount: money(st?.pending_amount ?? null),
        paidCount: Number(st?.paid_count ?? 0),
        paidAmount: money(st?.paid_amount ?? null),
      },
      paymentsRequiringManualRefund: Number(manualRefunds[0]?.count ?? 0),
      disputes: {
        open: Number(dq?.open_count ?? 0),
        underArbitration: Number(dq?.arbitration_count ?? 0),
        resolvedForBuyer: Number(dq?.buyer_favor_count ?? 0),
        refundsOwedToCustomers: money(dq?.refunds_owed ?? null),
        unrecoveredVendorEarnings: money(dq?.unrecovered ?? null),
      },
    };
  }
}
