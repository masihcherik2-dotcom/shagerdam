import { InstallmentStatus, Prisma, type PrismaClient } from '@prisma/client';
import type { CreditAccountDto, CreditApplicationDto, CreditProviderSummaryDto, CreditUserSummaryDto, OutstandingInstallmentsDto } from './dto/credit.dto';
import { dbDateToCalendar } from './installment-math';
import { SANDBOX_BANK_CODE } from './providers/sandbox-bank.provider';

type Db = PrismaClient | Prisma.TransactionClient;

export const accountSelect = {
  id: true,
  status: true,
  totalLimit: true,
  usedAmount: true,
  reservedAmount: true,
  availableAmount: true,
  expiresAt: true,
  createdAt: true,
  provider: { select: { code: true, name: true } },
} satisfies Prisma.CreditAccountSelect;

export type AccountRow = Prisma.CreditAccountGetPayload<{ select: typeof accountSelect }>;

export const applicationSelect = {
  id: true,
  status: true,
  requestedLimit: true,
  approvedLimit: true,
  bankApplicationTrackingCode: true,
  bankScoreResponse: true,
  decisionReason: true,
  decidedAt: true,
  createdAt: true,
  userId: true,
  providerId: true,
  provider: { select: { code: true, name: true } },
} satisfies Prisma.CreditApplicationSelect;

export type ApplicationRow = Prisma.CreditApplicationGetPayload<{ select: typeof applicationSelect }>;

export const userSummarySelect = { id: true, fullName: true, mobile: true, nationalCode: true } satisfies Prisma.UserSelect;

export function providerSummary(provider: { code: string; name: string }): CreditProviderSummaryDto {
  return { code: provider.code, name: provider.name, isSandbox: provider.code === SANDBOX_BANK_CODE };
}

export function maskNationalCode(nationalCode: string | null): string | null {
  return nationalCode === null ? null : `******${nationalCode.slice(-4)}`;
}

export function userSummary(user: Prisma.UserGetPayload<{ select: typeof userSummarySelect }>): CreditUserSummaryDto {
  return { id: user.id, fullName: user.fullName, mobile: user.mobile, nationalCodeMasked: maskNationalCode(user.nationalCode) };
}

const EMPTY_OUTSTANDING: OutstandingInstallmentsDto = { count: 0, overdueCount: 0, principal: '0.00', interest: '0.00', nextDueDate: null };

/** Unpaid-instalment summary per credit account. */
export async function outstandingByAccount(db: Db, accountIds: readonly string[]): Promise<Map<string, OutstandingInstallmentsDto>> {
  const result = new Map<string, OutstandingInstallmentsDto>();
  if (accountIds.length === 0) return result;
  const rows = await db.installmentSchedule.groupBy({
    by: ['creditAccountId', 'status'],
    where: { creditAccountId: { in: [...accountIds] }, status: { in: [InstallmentStatus.PENDING, InstallmentStatus.OVERDUE] } },
    _count: { _all: true },
    _sum: { principalAmount: true, interestAmount: true },
    _min: { dueDate: true },
  });
  for (const row of rows) {
    const current = result.get(row.creditAccountId) ?? { ...EMPTY_OUTSTANDING };
    const minDue = row._min.dueDate ? dbDateToCalendar(row._min.dueDate) : null;
    result.set(row.creditAccountId, {
      count: current.count + row._count._all,
      overdueCount: current.overdueCount + (row.status === InstallmentStatus.OVERDUE ? row._count._all : 0),
      principal: new Prisma.Decimal(current.principal).plus(row._sum.principalAmount ?? 0).toFixed(2),
      interest: new Prisma.Decimal(current.interest).plus(row._sum.interestAmount ?? 0).toFixed(2),
      nextDueDate: current.nextDueDate === null || (minDue !== null && minDue < current.nextDueDate) ? minDue : current.nextDueDate,
    });
  }
  return result;
}

export function toAccountDto(row: AccountRow, outstanding: Map<string, OutstandingInstallmentsDto>): CreditAccountDto {
  return {
    id: row.id,
    provider: providerSummary(row.provider),
    status: row.status,
    totalLimit: row.totalLimit.toFixed(2),
    usedAmount: row.usedAmount.toFixed(2),
    reservedAmount: row.reservedAmount.toFixed(2),
    availableAmount: row.availableAmount.toFixed(2),
    currency: 'IRR',
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    outstanding: outstanding.get(row.id) ?? { ...EMPTY_OUTSTANDING },
  };
}

export function toApplicationDto(row: ApplicationRow, account: CreditAccountDto | null): CreditApplicationDto {
  const response = typeof row.bankScoreResponse === 'object' && row.bankScoreResponse !== null && !Array.isArray(row.bankScoreResponse) ? row.bankScoreResponse : {};
  const inquiry = typeof response['inquiry'] === 'object' && response['inquiry'] !== null && !Array.isArray(response['inquiry']) ? response['inquiry'] : {};
  const score = inquiry['score'];
  return {
    id: row.id,
    status: row.status,
    provider: providerSummary(row.provider),
    requestedLimit: row.requestedLimit.toFixed(2),
    approvedLimit: row.approvedLimit?.toFixed(2) ?? null,
    trackingCode: row.bankApplicationTrackingCode,
    score: typeof score === 'number' ? score : null,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    account,
  };
}
