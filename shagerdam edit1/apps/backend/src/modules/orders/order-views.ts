import type { Prisma, SubOrderStatus } from '@prisma/client';
import { ParentOrderPaymentStatus } from '@prisma/client';
import type {
  AddressSnapshotDto,
  AdminOrderDto,
  AdminSubOrderDto,
  CustomerOrderDetailDto,
  CustomerOrderSummaryDto,
  CustomerSubOrderDto,
  OrderItemDto,
  StatusHistoryDto,
  TimelineEventDto,
  VariantDetailsDto,
  VendorOrderItemDto,
  VendorSubOrderDetailDto,
  VendorSubOrderSummaryDto,
} from './dto/order-response.dto';
import { lineCommission } from './order-math';
import { vendorTransitionsFrom } from './sub-order-state-machine';

const money = (value: Prisma.Decimal): string => value.toFixed(2);

/** Who performed a sub-order transition (`sub_order_status_history.actor_role`). */
export type ActorRole = 'CUSTOMER' | 'VENDOR' | 'STAFF' | 'SYSTEM';

// ─── selects ────────────────────────────────────────────────────────────────

export const orderItemSelect = {
  id: true,
  productVariantId: true,
  productTitleSnapshot: true,
  skuSnapshot: true,
  vendorStoreNameSnapshot: true,
  variantDetailsSnapshot: true,
  unitPriceSnapshot: true,
  discountSnapshot: true,
  commissionRateSnapshot: true,
  quantity: true,
  totalLineAmount: true,
} satisfies Prisma.OrderItemSelect;

const itemsInclude = {
  select: orderItemSelect,
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
} satisfies Prisma.SubOrder$itemsArgs;
const historyInclude = {
  select: { fromStatus: true, toStatus: true, actorRole: true, note: true, createdAt: true },
  orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
} satisfies Prisma.SubOrder$statusHistoryArgs;
const storeSelect = { select: { id: true, storeName: true, storeSlug: true } } satisfies Prisma.VendorDefaultArgs;

const parentMoneySelect = {
  id: true,
  orderNumber: true,
  paymentStatus: true,
  paymentMethod: true,
  totalItemsAmount: true,
  totalShippingFee: true,
  totalDiscountAmount: true,
  finalPayableAmount: true,
  paymentExpiresAt: true,
  createdAt: true,
} satisfies Prisma.ParentOrderSelect;

export const customerSubOrderSelect = {
  id: true,
  subOrderNumber: true,
  status: true,
  itemsSubtotal: true,
  shippingFee: true,
  trackingCode: true,
  carrierName: true,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  cancellationReason: true,
  vendor: storeSelect,
  items: itemsInclude,
} satisfies Prisma.SubOrderSelect;

export const customerOrderSummarySelect = {
  ...parentMoneySelect,
  subOrders: {
    select: {
      id: true,
      subOrderNumber: true,
      status: true,
      itemsSubtotal: true,
      shippingFee: true,
      trackingCode: true,
      vendor: { select: { storeName: true } },
      _count: { select: { items: true } },
    },
    orderBy: { subOrderNumber: 'asc' },
  },
} satisfies Prisma.ParentOrderSelect;

export const customerOrderDetailSelect = {
  ...parentMoneySelect,
  shippingAddressSnapshot: true,
  customerNote: true,
  paidAt: true,
  cancelledAt: true,
  cancellationReason: true,
  subOrders: {
    select: { ...customerSubOrderSelect, statusHistory: historyInclude },
    orderBy: { subOrderNumber: 'asc' },
  },
} satisfies Prisma.ParentOrderSelect;

const vendorSubOrderBaseSelect = {
  id: true,
  subOrderNumber: true,
  status: true,
  itemsSubtotal: true,
  shippingFee: true,
  platformCommissionAmount: true,
  vendorEarningsAmount: true,
  trackingCode: true,
  carrierName: true,
  parentOrder: { select: { orderNumber: true, createdAt: true, paidAt: true } },
  _count: { select: { items: true } },
} satisfies Prisma.SubOrderSelect;

export const vendorSubOrderSummarySelect = vendorSubOrderBaseSelect;

export const vendorSubOrderDetailSelect = {
  ...vendorSubOrderBaseSelect,
  shippedAt: true,
  deliveredAt: true,
  cancelledAt: true,
  cancellationReason: true,
  parentOrder: {
    select: { orderNumber: true, createdAt: true, paidAt: true, shippingAddressSnapshot: true, customerNote: true },
  },
  items: itemsInclude,
  statusHistory: historyInclude,
} satisfies Prisma.SubOrderSelect;

export const adminSubOrderSelect = {
  id: true,
  subOrderNumber: true,
  status: true,
  itemsSubtotal: true,
  shippingFee: true,
  platformCommissionAmount: true,
  vendorEarningsAmount: true,
  trackingCode: true,
  carrierName: true,
  updatedAt: true,
  vendor: storeSelect,
  _count: { select: { items: true } },
} satisfies Prisma.SubOrderSelect;

export const adminOrderSelect = {
  ...parentMoneySelect,
  paidAt: true,
  cancelledAt: true,
  user: { select: { id: true, fullName: true, mobile: true } },
  subOrders: { select: adminSubOrderSelect, orderBy: { subOrderNumber: 'asc' } },
} satisfies Prisma.ParentOrderSelect;

type ItemRow = Prisma.OrderItemGetPayload<{ select: typeof orderItemSelect }>;
type HistoryRow = { fromStatus: SubOrderStatus | null; toStatus: SubOrderStatus; actorRole: string; note: string | null; createdAt: Date };
type ParentMoneyRow = Prisma.ParentOrderGetPayload<{ select: typeof parentMoneySelect }>;
export type CustomerSubOrderRow = Prisma.SubOrderGetPayload<{ select: typeof customerSubOrderSelect }>;
export type CustomerOrderSummaryRow = Prisma.ParentOrderGetPayload<{ select: typeof customerOrderSummarySelect }>;
export type CustomerOrderDetailRow = Prisma.ParentOrderGetPayload<{ select: typeof customerOrderDetailSelect }>;
export type VendorSubOrderSummaryRow = Prisma.SubOrderGetPayload<{ select: typeof vendorSubOrderSummarySelect }>;
export type VendorSubOrderDetailRow = Prisma.SubOrderGetPayload<{ select: typeof vendorSubOrderDetailSelect }>;
export type AdminSubOrderRow = Prisma.SubOrderGetPayload<{ select: typeof adminSubOrderSelect }>;
export type AdminOrderRow = Prisma.ParentOrderGetPayload<{ select: typeof adminOrderSelect }>;

// ─── snapshots ──────────────────────────────────────────────────────────────

/** Shape written to `parent_orders.shipping_address_snapshot`. */
export function addressSnapshot(address: AddressSnapshotDto): AddressSnapshotDto {
  return {
    province: address.province,
    city: address.city,
    postalAddress: address.postalAddress,
    postalCode: address.postalCode,
    buildingNumber: address.buildingNumber,
    unitNumber: address.unitNumber,
    recipientName: address.recipientName,
    recipientMobile: address.recipientMobile,
  };
}

/** Shape written to `order_items.variant_details_snapshot`. */
export function variantDetailsSnapshot(variant: VariantDetailsDto): VariantDetailsDto {
  return {
    colorName: variant.colorName,
    colorHex: variant.colorHex,
    size: variant.size,
    guarantee: variant.guarantee,
  };
}

function readObject(value: Prisma.JsonValue): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function toAddress(value: Prisma.JsonValue): AddressSnapshotDto {
  const raw = readObject(value);
  return {
    province: str(raw.province),
    city: str(raw.city),
    postalAddress: str(raw.postalAddress),
    postalCode: str(raw.postalCode),
    buildingNumber: strOrNull(raw.buildingNumber),
    unitNumber: strOrNull(raw.unitNumber),
    recipientName: str(raw.recipientName),
    recipientMobile: str(raw.recipientMobile),
  };
}

function toVariantDetails(value: Prisma.JsonValue): VariantDetailsDto {
  const raw = readObject(value);
  return {
    colorName: strOrNull(raw.colorName),
    colorHex: strOrNull(raw.colorHex),
    size: strOrNull(raw.size),
    guarantee: strOrNull(raw.guarantee),
  };
}

// ─── mappers ────────────────────────────────────────────────────────────────

function toItem(row: ItemRow): OrderItemDto {
  return {
    id: row.id,
    productVariantId: row.productVariantId,
    productTitle: row.productTitleSnapshot,
    sku: row.skuSnapshot,
    vendorStoreName: row.vendorStoreNameSnapshot,
    variantDetails: toVariantDetails(row.variantDetailsSnapshot),
    unitPrice: money(row.unitPriceSnapshot),
    quantity: row.quantity,
    discount: money(row.discountSnapshot),
    lineTotal: money(row.totalLineAmount),
  };
}

function toVendorItem(row: ItemRow): VendorOrderItemDto {
  return {
    ...toItem(row),
    commissionRate: row.commissionRateSnapshot.toFixed(2),
    commissionAmount: money(lineCommission(row.totalLineAmount, row.commissionRateSnapshot)),
  };
}

function toHistory(row: HistoryRow): StatusHistoryDto {
  return { fromStatus: row.fromStatus, toStatus: row.toStatus, actorRole: row.actorRole, note: row.note, at: row.createdAt };
}

function parentMoney(row: ParentMoneyRow): Omit<ParentMoneyRow, 'totalItemsAmount' | 'totalShippingFee' | 'totalDiscountAmount' | 'finalPayableAmount'> & {
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
} {
  return {
    id: row.id,
    orderNumber: row.orderNumber,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    totalItemsAmount: money(row.totalItemsAmount),
    totalShippingFee: money(row.totalShippingFee),
    totalDiscountAmount: money(row.totalDiscountAmount),
    finalPayableAmount: money(row.finalPayableAmount),
    paymentExpiresAt: row.paymentExpiresAt,
    createdAt: row.createdAt,
  };
}

export function toCustomerSubOrder(row: CustomerSubOrderRow): CustomerSubOrderDto {
  return {
    id: row.id,
    subOrderNumber: row.subOrderNumber,
    store: row.vendor,
    status: row.status,
    itemsSubtotal: money(row.itemsSubtotal),
    shippingFee: money(row.shippingFee),
    total: money(row.itemsSubtotal.add(row.shippingFee)),
    trackingCode: row.trackingCode,
    carrierName: row.carrierName,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    items: row.items.map(toItem),
  };
}

export function toCustomerOrderSummary(row: CustomerOrderSummaryRow): CustomerOrderSummaryDto {
  return {
    ...parentMoney(row),
    subOrders: row.subOrders.map((sub) => ({
      id: sub.id,
      subOrderNumber: sub.subOrderNumber,
      storeName: sub.vendor.storeName,
      status: sub.status,
      itemsSubtotal: money(sub.itemsSubtotal),
      shippingFee: money(sub.shippingFee),
      itemCount: sub._count.items,
      trackingCode: sub.trackingCode,
    })),
  };
}

/**
 * Customer-facing timeline: order placed, payment, cancellation and every
 * package status change after creation, oldest first.
 */
export function buildTimeline(row: CustomerOrderDetailRow): TimelineEventDto[] {
  const events: TimelineEventDto[] = [
    { at: row.createdAt, type: 'ORDER_PLACED', subOrderNumber: null, fromStatus: null, toStatus: null, actor: 'CUSTOMER', note: null },
  ];
  if (row.paidAt) {
    events.push({ at: row.paidAt, type: 'PAYMENT_CONFIRMED', subOrderNumber: null, fromStatus: null, toStatus: null, actor: 'SYSTEM', note: null });
  }
  if (row.cancelledAt) {
    const failed = row.paymentStatus === ParentOrderPaymentStatus.FAILED;
    events.push({
      at: row.cancelledAt,
      type: failed ? 'PAYMENT_FAILED' : 'ORDER_CANCELLED',
      subOrderNumber: null,
      fromStatus: null,
      toStatus: null,
      actor: 'SYSTEM',
      note: row.cancellationReason,
    });
  }
  for (const sub of row.subOrders) {
    for (const entry of sub.statusHistory) {
      if (entry.fromStatus === null) continue; // creation is ORDER_PLACED
      events.push({
        at: entry.createdAt,
        type: 'SUB_ORDER_STATUS',
        subOrderNumber: sub.subOrderNumber,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actor: entry.actorRole,
        note: entry.note,
      });
    }
  }
  return events.sort((a, b) => a.at.getTime() - b.at.getTime());
}

export function toCustomerOrderDetail(row: CustomerOrderDetailRow): CustomerOrderDetailDto {
  return {
    ...parentMoney(row),
    shippingAddress: toAddress(row.shippingAddressSnapshot),
    customerNote: row.customerNote,
    paidAt: row.paidAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    canCancel: row.paymentStatus === ParentOrderPaymentStatus.PENDING,
    subOrders: row.subOrders.map(toCustomerSubOrder),
    timeline: buildTimeline(row),
  };
}

export function toVendorSubOrderSummary(row: VendorSubOrderSummaryRow): VendorSubOrderSummaryDto {
  return {
    id: row.id,
    subOrderNumber: row.subOrderNumber,
    orderNumber: row.parentOrder.orderNumber,
    status: row.status,
    itemsSubtotal: money(row.itemsSubtotal),
    shippingFee: money(row.shippingFee),
    platformCommissionAmount: money(row.platformCommissionAmount),
    vendorEarningsAmount: money(row.vendorEarningsAmount),
    itemCount: row._count.items,
    trackingCode: row.trackingCode,
    carrierName: row.carrierName,
    placedAt: row.parentOrder.createdAt,
    paidAt: row.parentOrder.paidAt,
    allowedTransitions: [...vendorTransitionsFrom(row.status)],
  };
}

export function toVendorSubOrderDetail(row: VendorSubOrderDetailRow): VendorSubOrderDetailDto {
  return {
    ...toVendorSubOrderSummary(row),
    shippingAddress: toAddress(row.parentOrder.shippingAddressSnapshot),
    customerNote: row.parentOrder.customerNote,
    shippedAt: row.shippedAt,
    deliveredAt: row.deliveredAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    items: row.items.map(toVendorItem),
    history: row.statusHistory.map(toHistory),
  };
}

export function toAdminSubOrder(row: AdminSubOrderRow): AdminSubOrderDto {
  return {
    id: row.id,
    subOrderNumber: row.subOrderNumber,
    store: row.vendor,
    status: row.status,
    itemsSubtotal: money(row.itemsSubtotal),
    shippingFee: money(row.shippingFee),
    platformCommissionAmount: money(row.platformCommissionAmount),
    vendorEarningsAmount: money(row.vendorEarningsAmount),
    itemCount: row._count.items,
    trackingCode: row.trackingCode,
    carrierName: row.carrierName,
    updatedAt: row.updatedAt,
  };
}

export function toAdminOrder(row: AdminOrderRow): AdminOrderDto {
  return {
    ...parentMoney(row),
    customer: row.user,
    paidAt: row.paidAt,
    cancelledAt: row.cancelledAt,
    subOrders: row.subOrders.map(toAdminSubOrder),
  };
}
