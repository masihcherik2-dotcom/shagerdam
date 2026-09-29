import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ParentOrderPaymentStatus, Prisma, VendorStatus } from '@prisma/client';
import { toE164 } from '../../common/validators/iranian-mobile';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { AdminOrderQueryDto, CustomerOrderQueryDto, VendorOrderQueryDto } from './dto/order-input.dto';
import type {
  AdminSubOrderDto,
  CustomerOrderDetailDto,
  PaginatedAdminOrdersDto,
  PaginatedCustomerOrdersDto,
  PaginatedVendorSubOrdersDto,
  VendorSubOrderDetailDto,
} from './dto/order-response.dto';
import {
  adminOrderSelect,
  adminSubOrderSelect,
  customerOrderDetailSelect,
  customerOrderSummarySelect,
  toAdminOrder,
  toAdminSubOrder,
  toCustomerOrderDetail,
  toCustomerOrderSummary,
  toVendorSubOrderDetail,
  toVendorSubOrderSummary,
  vendorSubOrderDetailSelect,
  vendorSubOrderSummarySelect,
} from './order-views';

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

const page = <T>(items: T[], total: number, query: { page: number; pageSize: number }): Page<T> => ({
  items,
  page: query.page,
  pageSize: query.pageSize,
  total,
  totalPages: Math.ceil(total / query.pageSize),
});

/**
 * Read side of orders, scoped per audience:
 * - customers see only their own orders;
 * - vendors see only their own packages, and only once the order is PAID
 *   (an unpaid order is not a commitment to ship and may still be cancelled);
 * - staff see everything.
 */
@Injectable()
export class OrderQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  async listForCustomer(userId: string, query: CustomerOrderQueryDto): Promise<PaginatedCustomerOrdersDto> {
    const where: Prisma.ParentOrderWhereInput = { userId, ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}) };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.parentOrder.findMany({
        where,
        select: customerOrderSummarySelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.parentOrder.count({ where }),
    ]);
    return page(rows.map(toCustomerOrderSummary), total, query);
  }

  async detailForCustomer(userId: string, orderId: string): Promise<CustomerOrderDetailDto> {
    const row = await this.prisma.parentOrder.findFirst({ where: { id: orderId, userId }, select: customerOrderDetailSelect });
    if (!row) {
      throw new NotFoundException('Order not found');
    }
    return toCustomerOrderDetail(row);
  }

  async listForVendor(userId: string, query: VendorOrderQueryDto): Promise<PaginatedVendorSubOrdersDto> {
    const vendorId = await this.requireStore(userId);
    const where: Prisma.SubOrderWhereInput = {
      vendorId,
      parentOrder: { paymentStatus: ParentOrderPaymentStatus.PAID },
      ...(query.status ? { status: query.status } : {}),
      ...(query.search ? { subOrderNumber: { startsWith: query.search.toUpperCase() } } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.subOrder.findMany({
        where,
        select: vendorSubOrderSummarySelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.subOrder.count({ where }),
    ]);
    return page(rows.map(toVendorSubOrderSummary), total, query);
  }

  async detailForVendor(userId: string, subOrderId: string): Promise<VendorSubOrderDetailDto> {
    const vendorId = await this.requireStore(userId);
    return this.vendorSubOrder(vendorId, subOrderId);
  }

  /** A vendor's package by id; foreign, unknown and unpaid packages are all 404. */
  async vendorSubOrder(vendorId: string, subOrderId: string): Promise<VendorSubOrderDetailDto> {
    const row = await this.prisma.subOrder.findFirst({
      where: { id: subOrderId, vendorId, parentOrder: { paymentStatus: ParentOrderPaymentStatus.PAID } },
      select: vendorSubOrderDetailSelect,
    });
    if (!row) {
      throw new NotFoundException('Order not found');
    }
    return toVendorSubOrderDetail(row);
  }

  async listForStaff(query: AdminOrderQueryDto): Promise<PaginatedAdminOrdersDto> {
    const where = adminWhere(query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.parentOrder.findMany({
        where,
        select: adminOrderSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.parentOrder.count({ where }),
    ]);
    return page(rows.map(toAdminOrder), total, query);
  }

  async subOrderForStaff(subOrderId: string): Promise<AdminSubOrderDto> {
    const row = await this.prisma.subOrder.findUnique({ where: { id: subOrderId }, select: adminSubOrderSelect });
    if (!row) {
      throw new NotFoundException('Sub-order not found');
    }
    return toAdminSubOrder(row);
  }

  private async requireStore(userId: string): Promise<string> {
    const store = await this.prisma.vendor.findUnique({ where: { userId }, select: { id: true, status: true } });
    if (!store) {
      throw new ForbiddenException('This account has no store');
    }
    if (store.status !== VendorStatus.APPROVED && store.status !== VendorStatus.SUSPENDED) {
      throw new ForbiddenException(`The store is ${store.status}; it has no orders`);
    }
    return store.id;
  }
}

function adminWhere(query: AdminOrderQueryDto): Prisma.ParentOrderWhereInput {
  const and: Prisma.ParentOrderWhereInput[] = [];
  if (query.paymentStatus) and.push({ paymentStatus: query.paymentStatus });
  if (query.customerId) and.push({ userId: query.customerId });
  if (query.subOrderStatus || query.vendorId) {
    and.push({
      subOrders: {
        some: {
          ...(query.subOrderStatus ? { status: query.subOrderStatus } : {}),
          ...(query.vendorId ? { vendorId: query.vendorId } : {}),
        },
      },
    });
  }
  if (query.createdFrom || query.createdTo) {
    and.push({
      createdAt: {
        ...(query.createdFrom ? { gte: new Date(query.createdFrom) } : {}),
        ...(query.createdTo ? { lt: new Date(query.createdTo) } : {}),
      },
    });
  }
  if (query.search) {
    const mobile = toE164(query.search);
    and.push(
      mobile
        ? { user: { mobile } }
        : {
            OR: [
              { orderNumber: { startsWith: query.search.toUpperCase() } },
              { subOrders: { some: { subOrderNumber: { startsWith: query.search.toUpperCase() } } } },
            ],
          },
    );
  }
  return and.length > 0 ? { AND: and } : {};
}
