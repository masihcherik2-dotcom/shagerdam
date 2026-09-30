import { DisputeStatus, SubOrderStatus, type Prisma } from '@prisma/client';

/**
 * Pure rules of the dispute workflow (Phase 9). No I/O: the services read the
 * rows under the parent-order lock and ask these functions what is allowed.
 *
 * ```
 *               customer opens                vendor REJECT_WITH_DEFENSE
 *  (package) ─────────────────► OPEN ─────────────────────────────► UNDER_ARBITRATION
 *                                │  │                                    │   │
 *        vendor ACCEPT_RETURN ───┘  └─── staff arbitrates ───┐           │   └── staff: VENDOR_FAVOR ─► RESOLVED_VENDOR_FAVOR
 *                │                                           │           └────── staff: BUYER_FAVOR ──► RESOLVED_BUYER_FAVOR
 *                └────────────────► RESOLVED_BUYER_FAVOR ◄───┘
 *  customer cancel (OPEN / VENDOR_RESPONDED / UNDER_ARBITRATION) ─► CANCELLED
 * ```
 */

/** Package statuses a customer may dispute (TM brief). */
export const DISPUTABLE_SUB_ORDER_STATUSES: readonly SubOrderStatus[] = [SubOrderStatus.PROCESSING, SubOrderStatus.SHIPPED, SubOrderStatus.DELIVERED];

/** Disputes that are still running and keep the package's earnings frozen. */
export const ACTIVE_STATUSES: readonly DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION];

/** Final decisions: a package that was decided cannot be disputed again. */
export const DECIDED_STATUSES: readonly DisputeStatus[] = [DisputeStatus.RESOLVED_BUYER_FAVOR, DisputeStatus.RESOLVED_VENDOR_FAVOR];

/** Most evidence files one party can attach in one request. */
export const MAX_EVIDENCE_PER_REQUEST = 10;

/** Most disputes a customer may open per rolling day (Redis counter); abuse guard. */
export const MAX_DISPUTES_PER_DAY = 10;

export type OpenRejection =
  | { code: 'ORDER_NOT_PAID'; message: string }
  | { code: 'SUB_ORDER_NOT_DISPUTABLE'; message: string }
  | { code: 'DISPUTE_ALREADY_ACTIVE'; message: string; disputeId: string }
  | { code: 'DISPUTE_ALREADY_DECIDED'; message: string; disputeId: string };

/**
 * Can the owner of a package open a dispute about it? (Ownership is checked by
 * the caller: a foreign package is a 404, never a policy answer.)
 *
 * - the order must be PAID and the package PROCESSING, SHIPPED or DELIVERED;
 * - at most one active dispute per package;
 * - a package whose dispute was decided (either way) cannot be disputed again;
 *   a dispute the customer cancelled does not block a new one.
 */
export function openRejection(
  parentPaid: boolean,
  subOrderStatus: SubOrderStatus,
  previous: ReadonlyArray<{ id: string; status: DisputeStatus }>,
): OpenRejection | null {
  if (!parentPaid) {
    return { code: 'ORDER_NOT_PAID', message: 'Only packages of paid orders can be disputed' };
  }
  if (!DISPUTABLE_SUB_ORDER_STATUSES.includes(subOrderStatus)) {
    return {
      code: 'SUB_ORDER_NOT_DISPUTABLE',
      message: `A ${subOrderStatus} package cannot be disputed; only ${DISPUTABLE_SUB_ORDER_STATUSES.join(', ')} packages can`,
    };
  }
  const active = previous.find((dispute) => ACTIVE_STATUSES.includes(dispute.status));
  if (active) {
    return { code: 'DISPUTE_ALREADY_ACTIVE', message: 'This package already has an active dispute', disputeId: active.id };
  }
  const decided = previous.find((dispute) => DECIDED_STATUSES.includes(dispute.status));
  if (decided) {
    return { code: 'DISPUTE_ALREADY_DECIDED', message: `A dispute about this package was already decided (${decided.status})`, disputeId: decided.id };
  }
  return null;
}

/** The vendor answers once, while the dispute is OPEN. */
export function vendorCanRespond(status: DisputeStatus): boolean {
  return status === DisputeStatus.OPEN;
}

/** Staff may decide any running dispute — also one the vendor never answered. */
export function staffCanArbitrate(status: DisputeStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/** The customer may withdraw a dispute until it is decided. */
export function customerCanCancel(status: DisputeStatus): boolean {
  return ACTIVE_STATUSES.includes(status);
}

/**
 * Buyer favour: does the stock go back on the shelf?
 * Goods that never shipped always do (Phase 6 rule). Shipped or delivered goods
 * only when the decision states they physically came back (`itemReturned`) —
 * a lost parcel (NOT_DELIVERED) or a destroyed item must not inflate stock.
 */
export function shouldRestock(subOrderStatus: SubOrderStatus, itemReturned: boolean | undefined): boolean {
  if (subOrderStatus === SubOrderStatus.PENDING_APPROVAL || subOrderStatus === SubOrderStatus.PROCESSING) return true;
  return itemReturned === true;
}

/** What the customer paid for the package and is owed back on a buyer-favour decision: items + shipping. */
export function refundDue(sub: { itemsSubtotal: Prisma.Decimal; shippingFee: Prisma.Decimal }): Prisma.Decimal {
  return sub.itemsSubtotal.plus(sub.shippingFee);
}

/** Masks an Iranian mobile for the vendor panel: `+98912***0001`. */
export function maskMobile(mobile: string): string {
  return mobile.length > 9 ? `${mobile.slice(0, 6)}***${mobile.slice(-4)}` : '***';
}
