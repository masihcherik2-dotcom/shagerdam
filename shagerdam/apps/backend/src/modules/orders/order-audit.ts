import type { AuditAction} from '@prisma/client';
import { Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/types/request-context';
import { sanitize } from '../audit/audit-log.service';

type Tx = Prisma.TransactionClient;

/** Who performed an order operation; `actorId` is null for system jobs. */
export interface OrderActor {
  actorId: string | null;
  context: RequestContext;
}

export const SYSTEM_ACTOR: OrderActor = { actorId: null, context: { ipAddress: null, userAgent: null } };

/**
 * Writes an audit row inside the caller's transaction, so the trail commits or
 * rolls back together with the change it describes. Values never contain the
 * shipping address (PII); orders are referenced by number and id.
 */
export async function writeOrderAudit(
  tx: Tx,
  actor: OrderActor,
  entry: {
    action: AuditAction;
    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest' | 'CreditApplication' | 'CreditAccount' | 'InstallmentSchedule' | 'Dispute';
    entityId: string;
    oldValue?: Record<string, unknown>;
    newValue: Record<string, unknown>;
  },
): Promise<string> {
  const row = await tx.auditLog.create({
    data: {
      userId: actor.actorId,
      action: entry.action,
      entityName: entry.entityName,
      entityId: entry.entityId,
      ipAddress: actor.context.ipAddress,
      userAgent: actor.context.userAgent,
      ...(entry.oldValue !== undefined ? { oldValue: sanitize(entry.oldValue) as Prisma.InputJsonValue } : {}),
      newValue: sanitize(entry.newValue) as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  return row.id;
}

/** Locks the parent order row: every lifecycle change of an order and its packages serialises on it. */
export async function lockParentOrder(tx: Tx, parentOrderId: string): Promise<boolean> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM parent_orders WHERE id = ${parentOrderId}::uuid FOR UPDATE`,
  );
  return rows.length === 1;
}

/**
 * Aggregates the order lines per variant and sorts by variant id, so stock rows
 * are always locked in the same global order (no deadlocks between concurrent
 * checkouts, cancellations and payments touching overlapping variants).
 */
export function stockMovements(items: ReadonlyArray<{ productVariantId: string | null; quantity: number }>): Array<{ variantId: string; quantity: number }> {
  const totals = new Map<string, number>();
  for (const item of items) {
    if (item.productVariantId === null) continue; // variant deleted after the sale: nothing to move
    totals.set(item.productVariantId, (totals.get(item.productVariantId) ?? 0) + item.quantity);
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([variantId, quantity]) => ({ variantId, quantity }));
}
