import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AuditAction, Prisma, SettlementStatus, VendorStatus } from '@prisma/client';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { normalizeSheba } from '../../common/validators/iranian-sheba';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { requireStore } from '../wallet/vendor-store';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import type {
  AdminSettlementQueryDto,
  CreateSettlementRequestDto,
  PaginatedSettlementRequestsDto,
  ProcessSettlementDto,
  SettlementProcessResultDto,
  SettlementRequestDto,
  VendorSettlementQueryDto,
} from './dto/settlement.dto';

/** `system_configs` key of the minimum settlement amount (IRR), seeded in Phase 2. */
export const SETTLEMENT_MIN_AMOUNT_KEY = 'commerce.settlementMinimumAmount';
const MONEY_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

const settlementSelect = {
  id: true,
  vendorId: true,
  amount: true,
  targetIban: true,
  status: true,
  bankPayaReference: true,
  rejectionReason: true,
  processedAt: true,
  createdAt: true,
  vendor: { select: { storeName: true } },
  processedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.SettlementRequestSelect;

type SettlementRow = Prisma.SettlementRequestGetPayload<{ select: typeof settlementSelect }>;

/**
 * Vendor payouts (PAYA transfers).
 *
 * - request: the amount moves WITHDRAWABLE → SETTLEMENT_HOLD immediately, so it
 *   cannot be requested twice or consumed by a refund while finance reviews it;
 * - approve: the held amount leaves the wallet (SETTLEMENT_PAYOUT) and the
 *   request becomes PAID_PAYA with the bank reference;
 * - reject: the held amount returns to WITHDRAWABLE.
 *
 * Every step is one transaction: wallet row lock → settlement row lock →
 * status check → ledger → status update → audit.
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: WalletLedgerService,
  ) {}

  async request(userId: string, dto: CreateSettlementRequestDto, actor: OrderActor): Promise<SettlementRequestDto> {
    const store = await requireStore(this.prisma, userId);
    if (store.status !== VendorStatus.APPROVED) {
      throw new ForbiddenException(`The store is ${store.status}; only approved stores can request a settlement`);
    }
    if (!store.bankIban) {
      throw conflictWith('BANK_ACCOUNT_MISSING', 'Register the store’s bank IBAN on the store profile first');
    }
    const targetIban = normalizeSheba(dto.targetIban);
    if (targetIban !== normalizeSheba(store.bankIban)) {
      throw conflictWith('IBAN_MISMATCH', 'Settlements are paid only to the IBAN registered on the store profile');
    }
    const amount = new Prisma.Decimal(dto.amount);
    const minimum = await this.minimumAmount();
    if (amount.lessThan(minimum)) {
      throw badRequestWith('AMOUNT_BELOW_MINIMUM', `The minimum settlement amount is ${minimum.toFixed(2)} IRR`, {
        minimumAmount: minimum.toFixed(2),
      });
    }

    const id = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, store.id); // wallet first, as in every money path
      const created = await tx.settlementRequest.create({
        data: { vendorId: store.id, amount, targetIban, status: SettlementStatus.REQUESTED },
        select: { id: true },
      });
      await this.ledger.holdForSettlement(tx, store.id, created.id, amount); // 409 INSUFFICIENT_WALLET_BALANCE
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'SettlementRequest',
        entityId: created.id,
        newValue: { vendorId: store.id, amount: amount.toFixed(2), status: SettlementStatus.REQUESTED },
      });
      return created.id;
    });
    return this.toDto(await this.prisma.settlementRequest.findUniqueOrThrow({ where: { id }, select: settlementSelect }));
  }

  async listForVendor(userId: string, query: VendorSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    const store = await requireStore(this.prisma, userId);
    return this.list({ vendorId: store.id, ...(query.status ? { status: query.status } : {}) }, query);
  }

  async listForStaff(query: AdminSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    return this.list({ ...(query.vendorId ? { vendorId: query.vendorId } : {}), ...(query.status ? { status: query.status } : {}) }, query);
  }

  async process(id: string, dto: ProcessSettlementDto, actor: OrderActor & { actorId: string }): Promise<SettlementProcessResultDto> {
    const target = await this.prisma.settlementRequest.findUnique({ where: { id }, select: { vendorId: true } });
    if (!target) {
      throw new NotFoundException('Settlement request not found');
    }
    const auditLogId = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, target.vendorId);
      const rows = await tx.$queryRaw<Array<{ status: SettlementStatus; amount: Prisma.Decimal }>>(
        Prisma.sql`SELECT status, amount FROM settlement_requests WHERE id = ${id}::uuid FOR UPDATE`,
      );
      const current = rows[0];
      if (!current) {
        throw new NotFoundException('Settlement request not found');
      }
      if (current.status !== SettlementStatus.REQUESTED) {
        throw conflictWith('SETTLEMENT_ALREADY_PROCESSED', `This request is already ${current.status}`, { status: current.status });
      }
      const amount = new Prisma.Decimal(current.amount);
      const processedAt = new Date();

      if (dto.action === 'APPROVE') {
        const reference = dto.payaReferenceNumber!;
        const reused = await tx.settlementRequest.count({ where: { bankPayaReference: reference, status: SettlementStatus.PAID_PAYA } });
        if (reused > 0) {
          throw conflictWith('PAYA_REFERENCE_IN_USE', 'This PAYA reference is already recorded on another settlement');
        }
        await this.ledger.payoutSettlement(tx, target.vendorId, id, amount, reference);
        await tx.settlementRequest.update({
          where: { id },
          data: { status: SettlementStatus.PAID_PAYA, bankPayaReference: reference, processedByUserId: actor.actorId, processedAt },
        });
      } else {
        await this.ledger.releaseSettlementHold(tx, target.vendorId, id, amount);
        await tx.settlementRequest.update({
          where: { id },
          data: { status: SettlementStatus.REJECTED, rejectionReason: dto.rejectionReason!, processedByUserId: actor.actorId, processedAt },
        });
      }
      return writeOrderAudit(tx, actor, {
        action: AuditAction.SETTLEMENT_TRIGGER,
        entityName: 'SettlementRequest',
        entityId: id,
        oldValue: { status: SettlementStatus.REQUESTED },
        newValue: {
          status: dto.action === 'APPROVE' ? SettlementStatus.PAID_PAYA : SettlementStatus.REJECTED,
          vendorId: target.vendorId,
          amount: amount.toFixed(2),
          ...(dto.action === 'APPROVE' ? { bankPayaReference: dto.payaReferenceNumber } : { rejectionReason: dto.rejectionReason }),
        },
      });
    });
    const row = await this.prisma.settlementRequest.findUniqueOrThrow({ where: { id }, select: settlementSelect });
    return { ...this.toDto(row), auditLogId };
  }

  /** Minimum from `system_configs`; a missing or invalid value fails closed (503), like the shipping policy. */
  async minimumAmount(): Promise<Prisma.Decimal> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: SETTLEMENT_MIN_AMOUNT_KEY }, select: { value: true } });
    const raw = row?.value.trim();
    if (raw === undefined || !MONEY_PATTERN.test(raw)) {
      this.logger.error(`system_configs "${SETTLEMENT_MIN_AMOUNT_KEY}" is missing or invalid (${JSON.stringify(row?.value ?? null)})`);
      throw new ServiceUnavailableException('Settlements are temporarily unavailable: the settlement configuration is invalid');
    }
    return new Prisma.Decimal(raw);
  }

  private async list(where: Prisma.SettlementRequestWhereInput, query: { page: number; pageSize: number }): Promise<PaginatedSettlementRequestsDto> {
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.settlementRequest.count({ where }),
      this.prisma.settlementRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: settlementSelect,
      }),
    ]);
    return { items: rows.map((row) => this.toDto(row)), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  private toDto(row: SettlementRow): SettlementRequestDto {
    return {
      id: row.id,
      vendorId: row.vendorId,
      storeName: row.vendor.storeName,
      amount: row.amount.toFixed(2),
      targetIban: row.targetIban,
      status: row.status,
      bankPayaReference: row.bankPayaReference,
      rejectionReason: row.rejectionReason,
      processedAt: row.processedAt,
      processedBy: row.processedBy ? { id: row.processedBy.id, fullName: row.processedBy.fullName } : null,
      createdAt: row.createdAt,
    };
  }
}
