import { SubOrderStatus } from '@prisma/client';

/**
 * Sub-order lifecycle.
 *
 * ```
 *   PENDING_APPROVAL ──vendor──► PROCESSING ──vendor──► SHIPPED ──staff──► DELIVERED
 *         │                          │                     │                  │
 *         └──vendor──► CANCELLED ◄───┘                     └──staff──► REFUNDED ◄┘
 *                         └────────────staff──────────────────────────►┘
 * ```
 *
 * Vendors act only on sub-orders whose parent order is PAID (enforced by the
 * service); unpaid orders are cancelled by the customer, a failed payment or the
 * payment-timeout sweeper, all of which release the stock reservation instead.
 */
const VENDOR_TRANSITIONS: Readonly<Record<SubOrderStatus, readonly SubOrderStatus[]>> = {
  [SubOrderStatus.PENDING_APPROVAL]: [SubOrderStatus.PROCESSING, SubOrderStatus.CANCELLED],
  [SubOrderStatus.PROCESSING]: [SubOrderStatus.SHIPPED, SubOrderStatus.CANCELLED],
  [SubOrderStatus.SHIPPED]: [],
  [SubOrderStatus.DELIVERED]: [],
  [SubOrderStatus.CANCELLED]: [],
  [SubOrderStatus.REFUNDED]: [],
};

/** Staff "force" resolutions (disputes, carrier confirmations), keyed by target. */
const STAFF_FORCE_SOURCES = {
  [SubOrderStatus.DELIVERED]: [SubOrderStatus.PROCESSING, SubOrderStatus.SHIPPED],
  [SubOrderStatus.REFUNDED]: [
    SubOrderStatus.PENDING_APPROVAL,
    SubOrderStatus.PROCESSING,
    SubOrderStatus.SHIPPED,
    SubOrderStatus.DELIVERED,
    SubOrderStatus.CANCELLED,
  ],
} as const satisfies Partial<Record<SubOrderStatus, readonly SubOrderStatus[]>>;

export const VENDOR_TARGET_STATUSES = [SubOrderStatus.PROCESSING, SubOrderStatus.SHIPPED, SubOrderStatus.CANCELLED] as const;
export type VendorTargetStatus = (typeof VENDOR_TARGET_STATUSES)[number];

export const STAFF_FORCE_STATUSES = [SubOrderStatus.DELIVERED, SubOrderStatus.REFUNDED] as const;
export type StaffForceStatus = (typeof STAFF_FORCE_STATUSES)[number];

export function vendorTransitionsFrom(status: SubOrderStatus): readonly SubOrderStatus[] {
  return VENDOR_TRANSITIONS[status];
}

export function canVendorTransition(from: SubOrderStatus, to: SubOrderStatus): boolean {
  return VENDOR_TRANSITIONS[from].includes(to);
}

export function canStaffForce(from: SubOrderStatus, to: StaffForceStatus): boolean {
  return (STAFF_FORCE_SOURCES[to] as readonly SubOrderStatus[]).includes(from);
}

/** Statuses in which the goods have not left the store. */
const NOT_SHIPPED: readonly SubOrderStatus[] = [SubOrderStatus.PENDING_APPROVAL, SubOrderStatus.PROCESSING];

/**
 * Stock consequence of a transition on a **paid** sub-order. Paid orders have
 * already committed their reservation (stock was decremented), so goods that
 * never shipped go back on the shelf. Once shipped, stock is untouched: a return
 * is a physical event handled by the returns process, not by a status change.
 */
export function paidStockEffect(from: SubOrderStatus, to: SubOrderStatus): 'RESTOCK' | 'NONE' {
  const leavesSale = to === SubOrderStatus.CANCELLED || to === SubOrderStatus.REFUNDED;
  return leavesSale && NOT_SHIPPED.includes(from) ? 'RESTOCK' : 'NONE';
}
