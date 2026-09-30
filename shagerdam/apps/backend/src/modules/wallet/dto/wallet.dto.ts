import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';

/** Money is IRR (`platform.currency`), 2 decimals, serialised as a string. */
export const MONEY = { type: String, example: '2590000.00', description: 'IRR (Rial), 2 decimals, as a string.' } as const;
export const SIGNED_MONEY = { type: String, example: '-2590000.00', description: 'Signed IRR amount: negative = debit of the bucket.' } as const;

export class WalletSummaryDto {
  @ApiProperty(MONEY) pendingBalance!: string;
  @ApiProperty(MONEY) withdrawableBalance!: string;
  @ApiProperty({ ...MONEY, description: 'Reserved by open settlement requests awaiting the finance team (IRR).' })
  settlementHoldBalance!: string;
  @ApiProperty({ ...MONEY, description: 'Earnings frozen by open disputes about your packages; released or refunded when the dispute is decided (IRR).' })
  disputeHoldBalance!: string;
  @ApiProperty({
    ...MONEY,
    description: 'Earnings that left escrow (delivered, or frozen by a dispute), net of refunds (IRR). Equals withdrawable + settlement hold + dispute hold + withdrawn.',
  })
  totalEarnedBalance!: string;
  @ApiProperty({ ...MONEY, description: 'Lifetime amount paid out by PAYA (IRR).' })
  totalWithdrawnAmount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
}

export class WalletTransactionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WalletTransactionType })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @ApiPropertyOptional({ enum: WalletBalanceBucket })
  @IsOptional()
  @IsEnum(WalletBalanceBucket)
  bucket?: WalletBalanceBucket;
}

export class WalletTransactionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: WalletTransactionType }) type!: WalletTransactionType;
  @ApiProperty({ enum: WalletBalanceBucket, description: 'Balance bucket this row moved money in.' }) bucket!: WalletBalanceBucket;
  @ApiProperty(SIGNED_MONEY) amount!: string;
  @ApiProperty({ ...MONEY, description: 'Balance of `bucket` right after this row (IRR).' }) balanceAfter!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) subOrderId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'SHP-100000012-1' }) subOrderNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) settlementRequestId!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedWalletTransactionsDto {
  @ApiProperty({ type: [WalletTransactionDto] }) items!: WalletTransactionDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
