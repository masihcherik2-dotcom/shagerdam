import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { MONEY } from '../../wallet/dto/wallet.dto';

export class FinancialOverviewQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01T00:00:00+03:30', description: 'Sales window start (order paidAt ≥ from). Balances are always current.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-01T00:00:00+03:30', description: 'Sales window end (order paidAt < to).' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class SalesFiguresDto {
  @ApiProperty({ description: 'Paid orders in the window.' }) paidOrders!: number;
  @ApiProperty({ description: 'Packages of paid orders that are not cancelled or refunded.' }) activePackages!: number;
  @ApiProperty({ ...MONEY, description: 'GMV: items subtotal of active packages of paid orders (excludes shipping, cancelled and refunded packages).' })
  gmv!: string;
  @ApiProperty({ ...MONEY, description: 'Shipping fees of active packages of paid orders.' }) shippingFees!: string;
  @ApiProperty({ ...MONEY, description: 'Cash captured by the gateway for orders (SUCCESSFUL ORDER_CHECKOUT payments; card part of HYBRID), including captures awaiting manual refund.' })
  collectedByGateway!: string;
  @ApiProperty({ ...MONEY, description: 'Order amounts financed by bank credit (credit part of SUCCESSFUL BANK_CREDIT / HYBRID payments).' })
  fundedByCredit!: string;
  @ApiProperty({ ...MONEY, description: 'Instalment repayments captured by the gateway (SUCCESSFUL INSTALLMENT_REPAYMENT payments).' })
  installmentsCollected!: string;
}

export class CommissionFiguresDto {
  @ApiProperty({ ...MONEY, description: 'Commission of DELIVERED packages (escrow released).' }) earned!: string;
  @ApiProperty({ ...MONEY, description: 'Commission of paid packages not delivered yet (PENDING_APPROVAL / PROCESSING / SHIPPED).' }) pending!: string;
  @ApiProperty(MONEY) total!: string;
}

export class WalletFiguresDto {
  @ApiProperty({ ...MONEY, description: 'Escrow held: sum of all vendors’ pendingBalance.' }) escrowHeld!: string;
  @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ withdrawableBalance.' }) withdrawable!: string;
  @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ settlementHoldBalance (open requests).' }) settlementHold!: string;
  @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ disputeHoldBalance: earnings frozen by open disputes (Phase 9).' }) disputeHold!: string;
  @ApiProperty({ ...MONEY, description: 'Lifetime PAYA payouts.' }) totalWithdrawn!: string;
  @ApiProperty({ description: 'True when, for every wallet and bucket, the ledger sum equals the balance column.' }) ledgerConsistent!: boolean;
  @ApiProperty({ description: 'Wallets whose balances do not match their ledger (should always be 0).' }) inconsistentWallets!: number;
}

export class SettlementFiguresDto {
  @ApiProperty({ description: 'Requests awaiting finance (REQUESTED / PROCESSING).' }) pendingCount!: number;
  @ApiProperty(MONEY) pendingAmount!: string;
  @ApiProperty({ description: 'Requests paid by PAYA in the window (processedAt).' }) paidCount!: number;
  @ApiProperty(MONEY) paidAmount!: string;
}

export class DisputeFiguresDto {
  @ApiProperty({ description: 'Disputes waiting for the vendor (OPEN / VENDOR_RESPONDED).' }) open!: number;
  @ApiProperty({ description: 'Disputes waiting for a staff decision (UNDER_ARBITRATION).' }) underArbitration!: number;
  @ApiProperty({ description: 'Disputes resolved for the customer in the window (resolvedAt).' }) resolvedForBuyer!: number;
  @ApiProperty({ ...MONEY, description: 'Amount owed back to customers by those resolutions (package items + shipping); refunded manually by finance.' })
  refundsOwedToCustomers!: string;
  @ApiProperty({ ...MONEY, description: 'Vendor earnings those resolutions could not recover from the wallet (already withdrawn).' })
  unrecoveredVendorEarnings!: string;
}

export class FinancialOverviewDto {
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ nullable: true, type: Date }) from!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) to!: Date | null;
  @ApiProperty() generatedAt!: Date;
  @ApiProperty({ type: SalesFiguresDto }) sales!: SalesFiguresDto;
  @ApiProperty({ type: CommissionFiguresDto }) commission!: CommissionFiguresDto;
  @ApiProperty({ type: WalletFiguresDto }) wallets!: WalletFiguresDto;
  @ApiProperty({ type: SettlementFiguresDto }) settlements!: SettlementFiguresDto;
  @ApiProperty({ description: 'Captured payments whose order was already paid/closed; finance must refund them manually.' })
  paymentsRequiringManualRefund!: number;
  @ApiProperty({ type: DisputeFiguresDto }) disputes!: DisputeFiguresDto;
}
