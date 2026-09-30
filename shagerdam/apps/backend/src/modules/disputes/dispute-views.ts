import { DisputeStatus, type Prisma } from '@prisma/client';
import { maskMobile } from './dispute-policy';
import type {
  AdminDisputeDossierDto,
  AdminDisputeSummaryDto,
  DisputeDto,
  DisputeEvidenceDto,
  DisputeHoldDto,
  DisputePartyDto,
  VendorDisputeDto,
} from './dto/dispute.dto';

/**
 * Row shapes and mappers of the dispute module. One base select serves every
 * audience; each mapper decides what that audience may see (the store gets a
 * masked mobile, staff get the full dossier).
 */

export const disputeSelect = {
  id: true,
  status: true,
  reason: true,
  description: true,
  vendorId: true,
  raisedByUserId: true,
  subOrderStatusAtOpen: true,
  holdSource: true,
  holdAmount: true,
  holdShortfall: true,
  vendorAction: true,
  vendorDefenseNotes: true,
  vendorRespondedAt: true,
  vendorRespondedByUserId: true,
  resolutionNotes: true,
  resolvedAt: true,
  resolvedByUserId: true,
  itemReturned: true,
  restocked: true,
  refundAmount: true,
  refundUnrecoveredAmount: true,
  cancelledAt: true,
  createdAt: true,
  updatedAt: true,
  raisedBy: { select: { id: true, fullName: true, mobile: true } },
  vendor: { select: { id: true, storeName: true, userId: true } },
  subOrder: {
    select: {
      id: true,
      subOrderNumber: true,
      status: true,
      itemsSubtotal: true,
      shippingFee: true,
      vendorEarningsAmount: true,
      parentOrderId: true,
      parentOrder: { select: { orderNumber: true } },
    },
  },
  evidence: {
    select: { id: true, uploadedByUserId: true, fileUrl: true, fileType: true, caption: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
  events: {
    select: { type: true, actorRole: true, fromStatus: true, toStatus: true, note: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.DisputeSelect;

export type DisputeRow = Prisma.DisputeGetPayload<{ select: typeof disputeSelect }>;

export const dossierSelect = {
  ...disputeSelect,
  subOrder: {
    select: {
      ...disputeSelect.subOrder.select,
      items: {
        select: { productTitleSnapshot: true, skuSnapshot: true, quantity: true, unitPriceSnapshot: true, totalLineAmount: true },
        orderBy: { createdAt: 'asc' },
      },
      statusHistory: {
        select: { fromStatus: true, toStatus: true, actorRole: true, note: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
      parentOrder: {
        select: {
          id: true,
          orderNumber: true,
          paymentStatus: true,
          paymentMethod: true,
          finalPayableAmount: true,
          createdAt: true,
          payments: {
            select: { id: true, gatewayName: true, paymentMethod: true, status: true, cashAmount: true, creditAmount: true, bankRrn: true, paidAt: true },
            orderBy: { createdAt: 'asc' },
          },
        },
      },
    },
  },
  vendor: {
    select: {
      id: true,
      storeName: true,
      userId: true,
      wallet: {
        select: {
          pendingBalance: true,
          withdrawableBalance: true,
          settlementHoldBalance: true,
          disputeHoldBalance: true,
          totalEarnedBalance: true,
          totalWithdrawnAmount: true,
        },
      },
    },
  },
} satisfies Prisma.DisputeSelect;

export type DossierRow = Prisma.DisputeGetPayload<{ select: typeof dossierSelect }>;

const money = (value: Prisma.Decimal): string => value.toFixed(2);

function uploaderRole(row: DisputeRow, userId: string): DisputeEvidenceDto['uploadedBy'] {
  if (userId === row.raisedByUserId) return 'CUSTOMER';
  if (userId === row.vendor.userId) return 'VENDOR';
  return 'STAFF';
}

/** The view every party shares: complaint, package, the store's answer, the outcome, evidence and timeline. */
export function toDisputeDto(row: DisputeRow): DisputeDto {
  const decided = row.status === DisputeStatus.RESOLVED_BUYER_FAVOR || row.status === DisputeStatus.RESOLVED_VENDOR_FAVOR;
  return {
    id: row.id,
    status: row.status,
    reason: row.reason,
    description: row.description,
    package: {
      subOrderId: row.subOrder.id,
      subOrderNumber: row.subOrder.subOrderNumber,
      orderNumber: row.subOrder.parentOrder.orderNumber,
      status: row.subOrder.status,
      vendorId: row.vendor.id,
      storeName: row.vendor.storeName,
      itemsSubtotal: money(row.subOrder.itemsSubtotal),
      shippingFee: money(row.subOrder.shippingFee),
    },
    subOrderStatusAtOpen: row.subOrderStatusAtOpen,
    vendorResponse:
      row.vendorAction !== null && row.vendorRespondedAt !== null
        ? { action: row.vendorAction, defenseNotes: row.vendorDefenseNotes ?? '', respondedAt: row.vendorRespondedAt }
        : null,
    resolution:
      decided && row.resolvedAt !== null
        ? {
            outcome: row.status,
            notes: row.resolutionNotes,
            resolvedAt: row.resolvedAt,
            decidedBy: row.resolvedByUserId !== null && row.resolvedByUserId === row.vendor.userId ? 'VENDOR' : 'STAFF',
            refundAmount: row.refundAmount === null ? null : money(row.refundAmount),
            itemReturned: row.itemReturned,
            restocked: row.restocked,
          }
        : null,
    cancelledAt: row.cancelledAt,
    evidence: row.evidence.map((item) => ({
      id: item.id,
      uploadedBy: uploaderRole(row, item.uploadedByUserId),
      fileUrl: item.fileUrl,
      fileType: item.fileType,
      caption: item.caption,
      createdAt: item.createdAt,
    })),
    timeline: row.events.map((event) => ({ ...event })),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toHoldDto(row: DisputeRow): DisputeHoldDto {
  return {
    source: row.holdSource,
    amount: money(row.holdAmount),
    shortfall: money(row.holdShortfall),
    unrecovered: money(row.refundUnrecoveredAmount),
  };
}

function toPartyDto(row: DisputeRow): DisputePartyDto {
  return { userId: row.raisedBy.id, name: row.raisedBy.fullName, mobile: row.raisedBy.mobile };
}

/** Store view: the customer is named but their mobile is masked. */
export function toVendorDisputeDto(row: DisputeRow): VendorDisputeDto {
  return {
    ...toDisputeDto(row),
    customerName: row.raisedBy.fullName,
    customerMobileMasked: maskMobile(row.raisedBy.mobile),
    hold: toHoldDto(row),
  };
}

export function toAdminSummaryDto(row: DisputeRow): AdminDisputeSummaryDto {
  return { ...toDisputeDto(row), customer: toPartyDto(row), hold: toHoldDto(row) };
}

/** Staff dossier: everything needed to decide — order, items, package history, payments, wallet. */
export function toDossierDto(row: DossierRow): AdminDisputeDossierDto {
  const parent = row.subOrder.parentOrder;
  const wallet = row.vendor.wallet;
  const zero = '0.00';
  return {
    ...toAdminSummaryDto(row),
    order: {
      id: parent.id,
      orderNumber: parent.orderNumber,
      paymentStatus: parent.paymentStatus,
      paymentMethod: parent.paymentMethod,
      finalPayableAmount: money(parent.finalPayableAmount),
      createdAt: parent.createdAt,
    },
    items: row.subOrder.items.map((item) => ({
      productTitle: item.productTitleSnapshot,
      sku: item.skuSnapshot,
      quantity: item.quantity,
      unitPrice: money(item.unitPriceSnapshot),
      totalLineAmount: money(item.totalLineAmount),
    })),
    packageHistory: row.subOrder.statusHistory.map((entry) => ({ ...entry })),
    payments: parent.payments.map((payment) => ({
      id: payment.id,
      gatewayName: payment.gatewayName,
      paymentMethod: payment.paymentMethod,
      status: payment.status,
      cashAmount: money(payment.cashAmount),
      creditAmount: money(payment.creditAmount),
      bankRrn: payment.bankRrn,
      paidAt: payment.paidAt,
    })),
    vendorWallet: {
      pendingBalance: wallet ? money(wallet.pendingBalance) : zero,
      withdrawableBalance: wallet ? money(wallet.withdrawableBalance) : zero,
      settlementHoldBalance: wallet ? money(wallet.settlementHoldBalance) : zero,
      disputeHoldBalance: wallet ? money(wallet.disputeHoldBalance) : zero,
      totalEarnedBalance: wallet ? money(wallet.totalEarnedBalance) : zero,
      totalWithdrawnAmount: wallet ? money(wallet.totalWithdrawnAmount) : zero,
    },
    vendorEarningsAmount: money(row.subOrder.vendorEarningsAmount),
  };
}
