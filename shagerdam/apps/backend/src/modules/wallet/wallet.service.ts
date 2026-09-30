import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { PaginatedWalletTransactionsDto, WalletSummaryDto, WalletTransactionQueryDto } from './dto/wallet.dto';
import { requireStore } from './vendor-store';

const ZERO = new Prisma.Decimal(0).toFixed(2);

/** Read side of the vendor wallet. Writes go through `WalletLedgerService` only. */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /** A store that never sold anything has no wallet row yet: all balances are zero. */
  async summaryForVendor(userId: string): Promise<WalletSummaryDto> {
    const store = await requireStore(this.prisma, userId);
    const wallet = await this.prisma.vendorWallet.findUnique({ where: { vendorId: store.id } });
    return {
      pendingBalance: wallet?.pendingBalance.toFixed(2) ?? ZERO,
      withdrawableBalance: wallet?.withdrawableBalance.toFixed(2) ?? ZERO,
      settlementHoldBalance: wallet?.settlementHoldBalance.toFixed(2) ?? ZERO,
      disputeHoldBalance: wallet?.disputeHoldBalance.toFixed(2) ?? ZERO,
      totalEarnedBalance: wallet?.totalEarnedBalance.toFixed(2) ?? ZERO,
      totalWithdrawnAmount: wallet?.totalWithdrawnAmount.toFixed(2) ?? ZERO,
      currency: 'IRR',
    };
  }

  async transactionsForVendor(userId: string, query: WalletTransactionQueryDto): Promise<PaginatedWalletTransactionsDto> {
    const store = await requireStore(this.prisma, userId);
    const where: Prisma.WalletTransactionWhereInput = {
      wallet: { vendorId: store.id },
      ...(query.type ? { type: query.type } : {}),
      ...(query.bucket ? { bucket: query.bucket } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          bucket: true,
          amount: true,
          balanceAfter: true,
          subOrderId: true,
          settlementRequestId: true,
          description: true,
          createdAt: true,
          subOrder: { select: { subOrderNumber: true } },
        },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        bucket: row.bucket,
        amount: row.amount.toFixed(2),
        balanceAfter: row.balanceAfter.toFixed(2),
        subOrderId: row.subOrderId,
        subOrderNumber: row.subOrder?.subOrderNumber ?? null,
        settlementRequestId: row.settlementRequestId,
        description: row.description,
        createdAt: row.createdAt,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}
