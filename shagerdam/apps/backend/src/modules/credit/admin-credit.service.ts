import { Injectable } from '@nestjs/common';
import { CreditTransactionType, InstallmentStatus, Prisma } from '@prisma/client';
import { toE164 } from '../../common/validators/iranian-mobile';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { accountSelect, applicationSelect, outstandingByAccount, toAccountDto, toApplicationDto, userSummary, userSummarySelect } from './credit-views';
import type {
  AdminCreditAccountPageDto,
  AdminCreditAccountsQueryDto,
  AdminCreditApplicationPageDto,
  AdminCreditApplicationsQueryDto,
  CreditExposureDto,
} from './dto/credit.dto';

interface ExposureRow {
  accounts: bigint;
  total_limit: Prisma.Decimal | null;
  used: Prisma.Decimal | null;
  reserved: Prisma.Decimal | null;
  available: Prisma.Decimal | null;
  inconsistent: bigint;
}

interface InstallmentExposureRow {
  outstanding: Prisma.Decimal | null;
  overdue_count: bigint;
  overdue_amount: Prisma.Decimal | null;
}

/** Staff views of the credit book: applications and accounts with the platform's aggregated exposure. */
@Injectable()
export class AdminCreditService {
  constructor(private readonly prisma: PrismaService) {}

  async applications(query: AdminCreditApplicationsQueryDto): Promise<AdminCreditApplicationPageDto> {
    const where: Prisma.CreditApplicationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.providerCode ? { provider: { code: query.providerCode } } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.creditApplication.findMany({
        where,
        select: { ...applicationSelect, user: { select: userSummarySelect } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.creditApplication.count({ where }),
    ]);
    // An approved application is linked to its account by the CREDIT_ALLOCATION row (referenceCode = application id).
    const allocations = await this.prisma.creditTransaction.findMany({
      where: { type: CreditTransactionType.CREDIT_ALLOCATION, referenceCode: { in: rows.map((row) => row.id) } },
      select: { referenceCode: true, creditAccountId: true },
    });
    const accounts = await this.prisma.creditAccount.findMany({ where: { id: { in: allocations.map((a) => a.creditAccountId) } }, select: accountSelect });
    const outstanding = await outstandingByAccount(this.prisma, accounts.map((account) => account.id));
    const accountById = new Map(accounts.map((account) => [account.id, toAccountDto(account, outstanding)]));
    const accountByApplication = new Map(allocations.map((a) => [a.referenceCode, accountById.get(a.creditAccountId) ?? null]));
    return {
      items: rows.map((row) => ({ ...toApplicationDto(row, accountByApplication.get(row.id) ?? null), user: userSummary(row.user) })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async accounts(query: AdminCreditAccountsQueryDto): Promise<AdminCreditAccountPageDto> {
    const search = query.search?.trim();
    const mobile = search ? toE164(search) : null;
    const where: Prisma.CreditAccountWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.providerCode ? { provider: { code: query.providerCode } } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(search
        ? { user: { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { mobile: { contains: mobile ?? search } }] } }
        : {}),
    };
    const [rows, total, ids] = await this.prisma.$transaction([
      this.prisma.creditAccount.findMany({
        where,
        select: { ...accountSelect, user: { select: userSummarySelect } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.creditAccount.count({ where }),
      this.prisma.creditAccount.findMany({ where, select: { id: true } }),
    ]);
    const outstanding = await outstandingByAccount(this.prisma, rows.map((row) => row.id));
    return {
      items: rows.map((row) => ({ ...toAccountDto(row, outstanding), user: userSummary(row.user) })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      exposure: await this.exposure(ids.map((row) => row.id)),
    };
  }

  /**
   * Aggregates over the given accounts. `inconsistent` counts accounts that break
   * the invariant or whose stored balances differ from the replay of their
   * credit_transactions (the ledger is the source of truth).
   */
  private async exposure(accountIds: string[]): Promise<CreditExposureDto> {
    if (accountIds.length === 0) {
      return { accounts: 0, totalLimit: '0.00', used: '0.00', reserved: '0.00', available: '0.00', outstandingInstallments: '0.00', overdueInstallments: 0, overdueAmount: '0.00', ledgerConsistent: true, inconsistentAccounts: 0 };
    }
    const ids = Prisma.join(accountIds.map((id) => Prisma.sql`${id}::uuid`));
    const [balances] = await this.prisma.$queryRaw<ExposureRow[]>(Prisma.sql`
      WITH replay AS (
        SELECT credit_account_id,
          COALESCE(SUM(amount) FILTER (WHERE type = 'CREDIT_ALLOCATION'), 0) AS total_limit,
          COALESCE(SUM(amount) FILTER (WHERE type = 'PURCHASE_COMMIT'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE type IN ('INSTALLMENT_REPAYMENT_RESTORE', 'REFUND_RESTORE')), 0) AS used,
          COALESCE(SUM(amount) FILTER (WHERE type = 'PURCHASE_RESERVE_HOLD'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE type IN ('PURCHASE_COMMIT', 'RESERVATION_RELEASE')), 0) AS reserved
        FROM credit_transactions
        WHERE credit_account_id IN (${ids})
        GROUP BY credit_account_id
      )
      SELECT COUNT(*)::bigint AS accounts,
        SUM(a.total_limit) AS total_limit, SUM(a.used_amount) AS used,
        SUM(a.reserved_amount) AS reserved, SUM(a.available_amount) AS available,
        COUNT(*) FILTER (WHERE
          a.total_limit <> a.used_amount + a.reserved_amount + a.available_amount
          OR r.credit_account_id IS NULL
          OR a.total_limit <> r.total_limit OR a.used_amount <> r.used OR a.reserved_amount <> r.reserved
          OR a.available_amount <> r.total_limit - r.used - r.reserved
        )::bigint AS inconsistent
      FROM credit_accounts a
      LEFT JOIN replay r ON r.credit_account_id = a.id
      WHERE a.id IN (${ids})`);
    const [installments] = await this.prisma.$queryRaw<InstallmentExposureRow[]>(Prisma.sql`
      SELECT SUM(total_amount + penalty_amount - paid_amount) AS outstanding,
        COUNT(*) FILTER (WHERE status = ${InstallmentStatus.OVERDUE}::"InstallmentStatus")::bigint AS overdue_count,
        SUM(total_amount + penalty_amount - paid_amount) FILTER (WHERE status = ${InstallmentStatus.OVERDUE}::"InstallmentStatus") AS overdue_amount
      FROM installment_schedules
      WHERE credit_account_id IN (${ids})
        AND status IN (${InstallmentStatus.PENDING}::"InstallmentStatus", ${InstallmentStatus.OVERDUE}::"InstallmentStatus")`);
    const money = (value: Prisma.Decimal | null | undefined): string => new Prisma.Decimal(value ?? 0).toFixed(2);
    const inconsistent = Number(balances?.inconsistent ?? 0n);
    return {
      accounts: Number(balances?.accounts ?? 0n),
      totalLimit: money(balances?.total_limit),
      used: money(balances?.used),
      reserved: money(balances?.reserved),
      available: money(balances?.available),
      outstandingInstallments: money(installments?.outstanding),
      overdueInstallments: Number(installments?.overdue_count ?? 0n),
      overdueAmount: money(installments?.overdue_amount),
      ledgerConsistent: inconsistent === 0,
      inconsistentAccounts: inconsistent,
    };
  }
}
