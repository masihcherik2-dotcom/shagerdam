import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { TorobFeedCacheService } from '../integrations/torob/torob-feed-cache.service';

/** Anything that can run raw SQL: the root client or an interactive transaction. */
export type SqlExecutor = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface StockLevel {
  variantId: string;
  stockQuantity: number;
  reservedQuantity: number;
  /** `stockQuantity - reservedQuantity`: what can still be sold. */
  availableQuantity: number;
}

interface StockRow {
  id: string;
  stock_quantity: number;
  reserved_quantity: number;
}

/**
 * Race-free inventory arithmetic.
 *
 * Every mutation is a single conditional `UPDATE … WHERE <guard> RETURNING`:
 * PostgreSQL row-locks the variant for the duration of the statement and
 * re-evaluates the guard against the committed value, so two concurrent
 * requests can never both take the last unit — the loser's `UPDATE` matches no
 * row and is reported as a conflict. No read-modify-write happens in
 * application memory. The `product_variants_inventory_check` CHECK constraint
 * (`stock >= 0 AND reserved >= 0 AND reserved <= stock`) is the last line of
 * defence behind these guards.
 *
 * Every method accepts an optional transaction client so checkout can reserve
 * several lines atomically (all or nothing).
 */
@Injectable()
export class InventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly torobFeedCache: TorobFeedCacheService,
  ) {}

  /** Sets on-hand stock to an absolute value; refused below the reserved quantity. */
  async setStock(variantId: string, stockQuantity: number, executor: SqlExecutor = this.prisma): Promise<StockLevel> {
    assertNonNegativeInteger(stockQuantity, 'stockQuantity');
    const rows = await executor.$queryRaw<StockRow[]>(Prisma.sql`
      UPDATE product_variants
         SET stock_quantity = ${stockQuantity}, updated_at = now()
       WHERE id = ${variantId}::uuid AND reserved_quantity <= ${stockQuantity}
   RETURNING id, stock_quantity, reserved_quantity`);
    return this.resultOrConflict(rows, variantId, executor, (level) =>
      `stockQuantity cannot be set to ${stockQuantity}: ${level.reservedQuantity} unit(s) are reserved by open checkouts`,
    );
  }

  /**
   * Adds (positive) or removes (negative) on-hand stock atomically. A decrement
   * that would take stock below the reserved quantity (or below zero) is refused.
   */
  async adjustStock(variantId: string, delta: number, executor: SqlExecutor = this.prisma): Promise<StockLevel> {
    if (!Number.isInteger(delta) || delta === 0) {
      throw new BadRequestException('stockDelta must be a non-zero integer');
    }
    const rows = await executor.$queryRaw<StockRow[]>(Prisma.sql`
      UPDATE product_variants
         SET stock_quantity = stock_quantity + ${delta}, updated_at = now()
       WHERE id = ${variantId}::uuid AND stock_quantity + ${delta} >= reserved_quantity
   RETURNING id, stock_quantity, reserved_quantity`);
    return this.resultOrConflict(rows, variantId, executor, (level) =>
      `stockDelta ${delta} would leave ${level.stockQuantity + delta} unit(s) on hand, below the ${level.reservedQuantity} reserved`,
    );
  }

  /** Holds `quantity` units for a checkout. Only active variants can be reserved. */
  async reserve(variantId: string, quantity: number, executor: SqlExecutor = this.prisma): Promise<StockLevel> {
    assertPositiveInteger(quantity);
    const rows = await executor.$queryRaw<StockRow[]>(Prisma.sql`
      UPDATE product_variants
         SET reserved_quantity = reserved_quantity + ${quantity}, updated_at = now()
       WHERE id = ${variantId}::uuid
         AND is_active = true
         AND stock_quantity - reserved_quantity >= ${quantity}
   RETURNING id, stock_quantity, reserved_quantity`);
    return this.resultOrConflict(rows, variantId, executor, (level) =>
      `Only ${level.availableQuantity} unit(s) available; cannot reserve ${quantity}`,
    );
  }

  /** Returns reserved units to the sellable pool (abandoned or failed checkout). */
  async release(variantId: string, quantity: number, executor: SqlExecutor = this.prisma): Promise<StockLevel> {
    assertPositiveInteger(quantity);
    const rows = await executor.$queryRaw<StockRow[]>(Prisma.sql`
      UPDATE product_variants
         SET reserved_quantity = reserved_quantity - ${quantity}, updated_at = now()
       WHERE id = ${variantId}::uuid AND reserved_quantity >= ${quantity}
   RETURNING id, stock_quantity, reserved_quantity`);
    return this.resultOrConflict(rows, variantId, executor, (level) =>
      `Cannot release ${quantity} unit(s): only ${level.reservedQuantity} reserved`,
    );
  }

  /**
   * Converts a reservation into a sale: stock and reservation both drop by
   * `quantity` in the same statement (the "safe decrement" used after payment).
   */
  async commitReservation(variantId: string, quantity: number, executor: SqlExecutor = this.prisma): Promise<StockLevel> {
    assertPositiveInteger(quantity);
    const rows = await executor.$queryRaw<StockRow[]>(Prisma.sql`
      UPDATE product_variants
         SET stock_quantity = stock_quantity - ${quantity},
             reserved_quantity = reserved_quantity - ${quantity},
             updated_at = now()
       WHERE id = ${variantId}::uuid AND reserved_quantity >= ${quantity}
   RETURNING id, stock_quantity, reserved_quantity`);
    return this.resultOrConflict(rows, variantId, executor, (level) =>
      `Cannot commit ${quantity} unit(s): only ${level.reservedQuantity} reserved`,
    );
  }

  async level(variantId: string, executor: SqlExecutor = this.prisma): Promise<StockLevel | null> {
    const rows = await executor.$queryRaw<StockRow[]>(Prisma.sql`
      SELECT id, stock_quantity, reserved_quantity FROM product_variants WHERE id = ${variantId}::uuid`);
    const row = rows[0];
    return row ? toLevel(row) : null;
  }

  /** A guarded UPDATE matched nothing: tell "no such variant" apart from "guard refused". */
  private async resultOrConflict(
    rows: StockRow[],
    variantId: string,
    executor: SqlExecutor,
    describe: (current: StockLevel) => string,
  ): Promise<StockLevel> {
    const updated = rows[0];
    if (updated) {
      // Sellable stock changed: cached price-comparison feed pages are stale. These
      // statements usually run inside the caller's transaction, hence
      // `afterCommit` (a second, delayed invalidation). Fire-and-forget: it never
      // throws and must not hold the transaction open.
      void this.torobFeedCache.invalidate({ afterCommit: true });
      return toLevel(updated);
    }
    const current = await this.level(variantId, executor);
    if (!current) {
      throw new NotFoundException('Variant not found');
    }
    throw new ConflictException(describe(current));
  }
}

function toLevel(row: StockRow): StockLevel {
  return {
    variantId: row.id,
    stockQuantity: row.stock_quantity,
    reservedQuantity: row.reserved_quantity,
    availableQuantity: row.stock_quantity - row.reserved_quantity,
  };
}

function assertPositiveInteger(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new BadRequestException('quantity must be a positive integer');
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new BadRequestException(`${field} must be a non-negative integer`);
  }
}
