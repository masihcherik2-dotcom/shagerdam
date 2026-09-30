import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { requireStore } from '../wallet/vendor-store';
import { disputeSelect, dossierSelect, toAdminSummaryDto, toDisputeDto, toDossierDto, toVendorDisputeDto, type DisputeRow } from './dispute-views';
import type {
  AdminDisputeDossierDto,
  AdminDisputePageDto,
  AdminDisputeQueryDto,
  CustomerDisputeQueryDto,
  DisputeDto,
  DisputePageDto,
  VendorDisputeDto,
  VendorDisputePageDto,
  VendorDisputeQueryDto,
} from './dto/dispute.dto';

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Read side of disputes. Every query is scoped to its audience: a customer sees
 * the disputes they raised, a store the disputes against it, staff everything.
 * A dispute outside the caller's scope is a 404 (existence is not revealed).
 */
@Injectable()
export class DisputeQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  // customer
  customerList(userId: string, query: CustomerDisputeQueryDto): Promise<DisputePageDto> {
    return this.page({ raisedByUserId: userId, status: query.status }, query, toDisputeDto);
  }

  async customerDetail(userId: string, disputeId: string): Promise<DisputeDto> {
    return toDisputeDto(await this.one({ id: disputeId, raisedByUserId: userId }));
  }

  // vendor
  async vendorList(userId: string, query: VendorDisputeQueryDto): Promise<VendorDisputePageDto> {
    const store = await requireStore(this.prisma, userId);
    return this.page({ vendorId: store.id, status: query.status }, query, toVendorDisputeDto);
  }

  async vendorDetail(userId: string, disputeId: string): Promise<VendorDisputeDto> {
    const store = await requireStore(this.prisma, userId);
    return toVendorDisputeDto(await this.one({ id: disputeId, vendorId: store.id }));
  }

  // staff
  adminList(query: AdminDisputeQueryDto): Promise<AdminDisputePageDto> {
    const createdAt = query.from || query.to ? { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } : undefined;
    return this.page(
      { status: query.status, reason: query.reason, vendorId: query.vendorId, raisedByUserId: query.customerId, createdAt },
      query,
      toAdminSummaryDto,
    );
  }

  async dossier(disputeId: string): Promise<AdminDisputeDossierDto> {
    const row = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: dossierSelect });
    if (!row) {
      throw new NotFoundException('Dispute not found');
    }
    return toDossierDto(row);
  }

  /** The shared view returned by every command (the caller was already authorised). */
  async shared(disputeId: string): Promise<DisputeDto> {
    return toDisputeDto(await this.one({ id: disputeId }));
  }

  private async one(where: Prisma.DisputeWhereInput): Promise<DisputeRow> {
    const row = await this.prisma.dispute.findFirst({ where, select: disputeSelect });
    if (!row) {
      throw new NotFoundException('Dispute not found');
    }
    return row;
  }

  private async page<T>(where: Prisma.DisputeWhereInput, query: { page: number; pageSize: number }, map: (row: DisputeRow) => T): Promise<Page<T>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.dispute.findMany({
        where,
        select: disputeSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.dispute.count({ where }),
    ]);
    return { items: rows.map(map), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }
}
