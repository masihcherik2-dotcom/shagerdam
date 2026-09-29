import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CategoriesService } from '../categories/categories.service';
import { ShippingCalculatorService } from '../shipping/shipping-calculator.service';
import { buildCartView, cartLineSelect, type CartLineRow } from './cart-view';
import { digestCartToken, issueCartToken } from './cart-token';
import { MAX_CART_LINES, MAX_LINE_QUANTITY, type AddCartItemDto, type UpdateCartItemDto } from './dto/cart-input.dto';
import type { CartDto, MergeAdjustmentDto, MergeCartResponseDto } from './dto/cart-response.dto';
import {
  availableQuantity,
  purchasableVariantSelect,
  unavailableReason,
  UNAVAILABLE_MESSAGES,
} from './purchasable';

type Tx = Prisma.TransactionClient;

/** Who is asking: a signed-in user, a guest holding a cart token, or neither. */
export interface CartIdentity {
  userId?: string;
  token?: string;
}

interface ResolvedCart {
  id: string;
  owner: 'user' | 'guest';
  /** Set when this request created a guest cart; must be returned to the client once. */
  issuedToken: string | null;
}

/**
 * Shopping carts for guests and signed-in users.
 *
 * - A signed-in user always works on their own cart (`carts.user_id`), even if a
 *   guest token is also sent; combining the two is an explicit `POST /cart/merge`.
 * - A guest cart is created on the first add and addressed by a bearer token
 *   (only its SHA-256 digest is stored).
 * - Every write locks the cart row, so concurrent adds of the same variant add
 *   up correctly and the stock check sees the final quantity.
 * - Stock is *checked* when adding (quantity in cart ≤ available) but not
 *   reserved: reservation happens at checkout, inside the order transaction.
 */
@Injectable()
export class CartService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly shipping: ShippingCalculatorService,
  ) {}

  async get(identity: CartIdentity): Promise<CartDto> {
    const cart = await this.find(this.prisma, identity);
    if (!cart) {
      return this.view(null, { owner: 'none', cartToken: null });
    }
    return this.view(cart.id, { owner: cart.owner, cartToken: null });
  }

  async addItem(identity: CartIdentity, dto: AddCartItemDto): Promise<CartDto> {
    const visible = await this.visibleCategoryIds();
    const cart = await this.prisma.$transaction(async (tx) => {
      const resolved = await this.ensure(tx, identity);
      await lockCart(tx, resolved.id);

      const variant = await tx.productVariant.findUnique({ where: { id: dto.productVariantId }, select: purchasableVariantSelect });
      if (!variant) {
        throw new NotFoundException('Product option not found');
      }
      const reason = unavailableReason(variant, visible);
      if (reason !== null) {
        throw conflictWith(reason, UNAVAILABLE_MESSAGES[reason]);
      }

      const existing = await tx.cartItem.findUnique({
        where: { cartId_productVariantId: { cartId: resolved.id, productVariantId: variant.id } },
        select: { id: true, quantity: true },
      });
      if (!existing) {
        const lines = await tx.cartItem.count({ where: { cartId: resolved.id } });
        if (lines >= MAX_CART_LINES) {
          throw conflictWith('CART_FULL', `A cart holds at most ${MAX_CART_LINES} different items`);
        }
      }

      const quantity = (existing?.quantity ?? 0) + dto.quantity;
      assertQuantity(quantity, availableQuantity(variant), existing?.quantity ?? 0);

      if (existing) {
        // The customer is looking at the live price when adding more: refresh the snapshot.
        await tx.cartItem.update({ where: { id: existing.id }, data: { quantity, unitPriceSnapshot: variant.price } });
      } else {
        await tx.cartItem.create({
          data: { cartId: resolved.id, productVariantId: variant.id, quantity, unitPriceSnapshot: variant.price },
        });
      }
      await touch(tx, resolved.id);
      return resolved;
    });
    return this.view(cart.id, { owner: cart.owner, cartToken: cart.issuedToken });
  }

  async updateItem(identity: CartIdentity, itemId: string, dto: UpdateCartItemDto): Promise<CartDto> {
    const cart = await this.prisma.$transaction(async (tx) => {
      const resolved = await this.requireCart(tx, identity);
      await lockCart(tx, resolved.id);
      const item = await tx.cartItem.findFirst({
        where: { id: itemId, cartId: resolved.id },
        select: { id: true, quantity: true, productVariant: { select: purchasableVariantSelect } },
      });
      if (!item) {
        throw new NotFoundException('Cart item not found');
      }
      // Lowering a quantity is always allowed (it can only fix a stock problem);
      // raising it is checked against live availability.
      if (dto.quantity > item.quantity) {
        const visible = await this.visibleCategoryIds();
        const reason = unavailableReason(item.productVariant, visible);
        if (reason !== null) {
          throw conflictWith(reason, UNAVAILABLE_MESSAGES[reason]);
        }
        assertQuantity(dto.quantity, availableQuantity(item.productVariant), item.quantity);
      }
      await tx.cartItem.update({
        where: { id: item.id },
        data: { quantity: dto.quantity, unitPriceSnapshot: item.productVariant.price },
      });
      await touch(tx, resolved.id);
      return resolved;
    });
    return this.view(cart.id, { owner: cart.owner, cartToken: null });
  }

  async removeItem(identity: CartIdentity, itemId: string): Promise<CartDto> {
    const cart = await this.prisma.$transaction(async (tx) => {
      const resolved = await this.requireCart(tx, identity);
      const deleted = await tx.cartItem.deleteMany({ where: { id: itemId, cartId: resolved.id } });
      if (deleted.count === 0) {
        throw new NotFoundException('Cart item not found');
      }
      await touch(tx, resolved.id);
      return resolved;
    });
    return this.view(cart.id, { owner: cart.owner, cartToken: null });
  }

  async clear(identity: CartIdentity): Promise<CartDto> {
    const cart = await this.find(this.prisma, identity);
    if (!cart) {
      return this.view(null, { owner: 'none', cartToken: null });
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
      await touch(tx, cart.id);
    });
    return this.view(cart.id, { owner: cart.owner, cartToken: null });
  }

  /**
   * Moves a guest cart into the signed-in user's cart and deletes the guest cart.
   * Quantities of the same variant are added, then limited to live stock and the
   * per-line cap; unavailable lines are dropped. Every adjustment is reported.
   * Idempotent: once merged, the token no longer resolves and nothing more moves.
   */
  async merge(userId: string, token: string): Promise<MergeCartResponseDto> {
    const visible = await this.visibleCategoryIds();
    const report: MergeCartResponseDto['report'] = { mergedLines: 0, clampedLines: [], droppedLines: [] };

    const cartId = await this.prisma.$transaction(async (tx) => {
      const target = await this.ensure(tx, { userId });
      await lockCart(tx, target.id);

      const guest = await tx.cart.findUnique({ where: { sessionToken: digestCartToken(token) }, select: { id: true, userId: true } });
      if (!guest || guest.userId !== null || guest.id === target.id) {
        return target.id;
      }
      await lockCart(tx, guest.id);

      const guestLines = await tx.cartItem.findMany({
        where: { cartId: guest.id },
        select: { quantity: true, unitPriceSnapshot: true, productVariant: { select: purchasableVariantSelect } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const existing = new Map(
        (
          await tx.cartItem.findMany({ where: { cartId: target.id }, select: { id: true, productVariantId: true, quantity: true } })
        ).map((line) => [line.productVariantId, line]),
      );
      let lineCount = existing.size;

      for (const line of guestLines) {
        const variant = line.productVariant;
        const drop = (reason: NonNullable<MergeAdjustmentDto['reason']>): void => {
          report.droppedLines.push({ productVariantId: variant.id, sku: variant.sku, reason });
        };
        const reason = unavailableReason(variant, visible);
        if (reason !== null) {
          drop(reason);
          continue;
        }
        const current = existing.get(variant.id);
        if (!current && lineCount >= MAX_CART_LINES) {
          drop('CART_FULL');
          continue;
        }
        const requested = (current?.quantity ?? 0) + line.quantity;
        const applied = Math.min(requested, availableQuantity(variant), MAX_LINE_QUANTITY);
        if (applied <= (current?.quantity ?? 0)) {
          if (!current) {
            drop('OUT_OF_STOCK');
          } else {
            report.clampedLines.push({ productVariantId: variant.id, sku: variant.sku, requested, applied: current.quantity });
          }
          continue;
        }
        if (applied < requested) {
          report.clampedLines.push({ productVariantId: variant.id, sku: variant.sku, requested, applied });
        }
        if (current) {
          await tx.cartItem.update({ where: { id: current.id }, data: { quantity: applied } });
        } else {
          await tx.cartItem.create({
            data: { cartId: target.id, productVariantId: variant.id, quantity: applied, unitPriceSnapshot: line.unitPriceSnapshot },
          });
          lineCount += 1;
        }
        report.mergedLines += 1;
      }

      await tx.cart.delete({ where: { id: guest.id } });
      await touch(tx, target.id);
      return target.id;
    });

    return { cart: await this.view(cartId, { owner: 'user', cartToken: null }), report };
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  async visibleCategoryIds(): Promise<ReadonlySet<string>> {
    return new Set(await this.categories.visibleCategoryIds());
  }

  private async view(cartId: string | null, meta: { owner: CartDto['owner']; cartToken: string | null }): Promise<CartDto> {
    const [rows, visible, policy] = await Promise.all([
      cartId === null
        ? Promise.resolve([] as CartLineRow[])
        : this.prisma.cartItem.findMany({ where: { cartId }, select: cartLineSelect }),
      this.visibleCategoryIds(),
      this.shipping.loadPolicy(),
    ]);
    return buildCartView(rows, visible, policy, meta);
  }

  private async find(executor: Tx | PrismaService, identity: CartIdentity): Promise<ResolvedCart | null> {
    if (identity.userId !== undefined) {
      const cart = await executor.cart.findUnique({ where: { userId: identity.userId }, select: { id: true } });
      return cart ? { id: cart.id, owner: 'user', issuedToken: null } : null;
    }
    if (identity.token !== undefined) {
      const cart = await executor.cart.findUnique({ where: { sessionToken: digestCartToken(identity.token) }, select: { id: true } });
      return cart ? { id: cart.id, owner: 'guest', issuedToken: null } : null;
    }
    return null;
  }

  private async requireCart(tx: Tx, identity: CartIdentity): Promise<ResolvedCart> {
    const cart = await this.find(tx, identity);
    if (!cart) {
      throw new NotFoundException('Cart item not found');
    }
    return cart;
  }

  /** Finds the caller's cart or creates it; a new guest cart gets a fresh token. */
  private async ensure(tx: Tx, identity: CartIdentity): Promise<ResolvedCart> {
    if (identity.userId !== undefined) {
      const cart = await tx.cart.upsert({
        where: { userId: identity.userId },
        update: {},
        create: { userId: identity.userId },
        select: { id: true },
      });
      return { id: cart.id, owner: 'user', issuedToken: null };
    }
    const found = await this.find(tx, identity);
    if (found) {
      return found;
    }
    // Unknown or no token: start a new guest cart. An unknown token is never
    // adopted as-is, so a client cannot choose its own cart identifier.
    const { token, digest } = issueCartToken();
    const cart = await tx.cart.create({ data: { sessionToken: digest }, select: { id: true } });
    return { id: cart.id, owner: 'guest', issuedToken: token };
  }
}

async function lockCart(tx: Tx, cartId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM carts WHERE id = ${cartId}::uuid FOR UPDATE`);
}

async function touch(tx: Tx, cartId: string): Promise<void> {
  await tx.cart.update({ where: { id: cartId }, data: { updatedAt: new Date() } });
}

function assertQuantity(requested: number, available: number, alreadyInCart: number): void {
  if (requested > MAX_LINE_QUANTITY) {
    throw new BadRequestException(`At most ${MAX_LINE_QUANTITY} units of one item per order`);
  }
  if (requested > available) {
    throw conflictWith(
      available === 0 ? 'OUT_OF_STOCK' : 'INSUFFICIENT_STOCK',
      available === 0 ? 'Out of stock' : `Only ${available} left in stock`,
      { availableQuantity: available, quantityInCart: alreadyInCart },
    );
  }
}
