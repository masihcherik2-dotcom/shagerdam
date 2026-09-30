# Shopino — Phase 6 deliverable

**Scope (TM brief):** cart engine (guest + account), customer address book, multi-vendor order
splitting, inventory reservation, per-store shipping fees, order lifecycle state machine.
**Base:** Phase 5 approved at `3861992`.
**Status:** implemented and verified against live PostgreSQL 16 + Redis 7.4 — see
`docs/phase-6-verification.md`. Items that are deliberately **not** part of this phase are listed
in §9; nothing below is mocked.

---

## 1. Module layout

```
apps/backend/src/
├── common/
│   ├── http-errors.ts                    409/400 bodies with a stable `code` (+ details)
│   └── decorators/current-user.decorator.ts   + OptionalUser (identity on @Public routes)
├── modules/
│   ├── shipping/                         TM-approved fee rule
│   │   ├── shipping-fee.ts               pure quoteShipping()
│   │   ├── shipping-calculator.service.ts   policy: store override → system_configs → env
│   │   ├── shipping-fee.spec.ts
│   │   └── shipping.module.ts
│   ├── addresses/                        customer address book
│   │   ├── dto/address-input.dto.ts
│   │   ├── dto/address-response.dto.ts
│   │   ├── addresses.service.ts
│   │   ├── addresses.controller.ts       /customer/addresses
│   │   └── addresses.module.ts
│   ├── cart/                             guest + account cart
│   │   ├── purchasable.ts                single definition of "can be bought now"
│   │   ├── cart-token.ts                 guest token issue / SHA-256 digest / @CartToken()
│   │   ├── cart-view.ts                  evaluateLine() + grouped view (shared with checkout)
│   │   ├── dto/cart-input.dto.ts
│   │   ├── dto/cart-response.dto.ts
│   │   ├── cart.service.ts
│   │   ├── cart.controller.ts            /cart
│   │   └── cart.module.ts
│   └── orders/                           checkout, split, lifecycle
│       ├── order-math.ts (+ .spec)       decimal money split, rounding
│       ├── sub-order-state-machine.ts (+ .spec)
│       ├── order-audit.ts                in-transaction audit, parent row lock, sorted stock moves
│       ├── order-views.ts                selects + mappers per audience
│       ├── dto/order-input.dto.ts
│       ├── dto/order-response.dto.ts
│       ├── checkout.service.ts           the single order transaction
│       ├── order-lifecycle.service.ts    cancel / pay / fail / expire / vendor / staff
│       ├── order-queries.service.ts      customer / vendor / staff read side
│       ├── order-expiry.scheduler.ts     payment-timeout sweeper (Redis lock)
│       ├── checkout.controller.ts        /orders/checkout
│       ├── customer-orders.controller.ts /customer/orders
│       ├── vendor-orders.controller.ts   /vendor/orders
│       ├── admin-orders.controller.ts    /admin/orders, /admin/sub-orders/:id/force-status
│       └── orders.module.ts
prisma/migrations/20260928090000_phase6_orders/migration.sql
test/orders.e2e-spec.ts                   32 e2e tests on the live stack
```

## 2. Endpoints (`/api/v1`)

| Method & path | Who | Notes |
| --- | --- | --- |
| `POST /customer/addresses` | CUSTOMER | first address becomes default; max 20; mobile → E.164, Persian digits normalised |
| `GET /customer/addresses` | CUSTOMER | default first |
| `PATCH /customer/addresses/:id` | CUSTOMER (owner) | 404 for others' addresses |
| `DELETE /customer/addresses/:id` | CUSTOMER (owner) | default moves to newest remaining; orders keep their own snapshot |
| `GET /cart` | guest (`X-Cart-Token`) or signed-in | grouped by store; subtotal, shipping estimate, `issues` per line (`OUT_OF_STOCK`, `INSUFFICIENT_STOCK`, `PRICE_CHANGED`, unavailability reasons), `canCheckout` |
| `POST /cart/items` | guest or signed-in | adds to existing line; ≤ available stock; ≤100 per line; ≤50 lines; new guest cart returns `cartToken` once |
| `PATCH /cart/items/:id` | owner | raise checked against stock; lowering always allowed |
| `DELETE /cart/items/:id` | owner | |
| `POST /cart/clear` | owner | |
| `POST /cart/merge` | signed-in + `X-Cart-Token` | adds guest quantities, clamps to stock, drops unavailable lines, deletes guest cart; idempotent |
| `POST /orders/checkout` | CUSTOMER | `{addressId, customerNote?}` → `{parentOrderId, orderNumber:"SHP-…", finalPayableAmount, subOrders:[…]}` |
| `GET /customer/orders` | CUSTOMER | paginated, package breakdown; filter `paymentStatus` |
| `GET /customer/orders/:id` | CUSTOMER (owner) | address snapshot, packages, items, tracking, timeline |
| `POST /customer/orders/:id/cancel` | CUSTOMER (owner) | only while payment PENDING; releases stock |
| `GET /vendor/orders` | VENDOR | own packages of PAID orders; filters `status`, `search`, `page`, `pageSize` |
| `GET /vendor/orders/:id` | VENDOR (owner) | shipping address, items with commission, history, `allowedTransitions` |
| `PATCH /vendor/orders/:id/status` | VENDOR (owner) | PENDING_APPROVAL→PROCESSING; PROCESSING→SHIPPED (trackingCode + shippingCarrier); PENDING_APPROVAL/PROCESSING→CANCELLED (reason; restock) |
| `GET /admin/orders` | SUPER_ADMIN, ADMIN, SUPPORT | filters: paymentStatus, subOrderStatus, vendorId, customerId, search (number prefix or mobile), createdFrom/To |
| `PATCH /admin/sub-orders/:id/force-status` | SUPER_ADMIN, ADMIN | DELIVERED (from PROCESSING/SHIPPED) or REFUNDED (from any non-refunded); reason required |

Machine-readable error codes (409 unless noted): `CART_EMPTY`, `CART_NOT_CHECKOUTABLE` (+`lines`),
`CART_PRICES_CHANGED` (+`changes`), `INSUFFICIENT_STOCK`/`OUT_OF_STOCK` (+`availableQuantity`),
`CART_FULL`, unavailability reasons (`PRODUCT_UNPUBLISHED`, …), `ORDER_NOT_CANCELLABLE`,
`ORDER_NOT_PAID`, `INVALID_STATUS_TRANSITION` (+`allowedTransitions`), `CONCURRENT_UPDATE`,
400 `INVALID_CART_TOKEN`.

## 3. Checkout — one transaction

1. **Pre-check (no locks):** cart must be non-empty and every line purchasable with enough
   stock (`CART_NOT_CHECKOUTABLE` otherwise). Lines whose live price differs from the price the
   customer saw are **written back to the cart** and the request fails with
   `CART_PRICES_CHANGED` listing old/new prices. The next attempt proceeds at the prices now
   shown. (This happens outside the order transaction on purpose: a rolled-back transaction
   could not persist the refreshed prices.)
2. **Order transaction** (`prisma.$transaction`):
   - `SELECT … FROM carts … FOR UPDATE` — no concurrent edit or double submission of one cart;
   - `SELECT … FROM product_variants WHERE id IN (…) ORDER BY id FOR UPDATE` — stock rows
     locked in a global order (no deadlocks), then re-read and re-evaluated (authoritative
     check; any change → rollback with the same error codes);
   - `nextval('parent_order_number_seq')` → `SHP-100000001`…; packages `SHP-…-1`, `-2`, … in
     the order the stores' first lines were added to the cart;
   - per store: `itemsSubtotal = Σ unitPrice × qty`; shipping by the TM rule; commission per
     line = `round_half_up(lineTotal × rate / 100, 2)` where
     `rate = vendor.commissionRateOverride ?? category.defaultCommissionRate`;
     `vendorEarnings = itemsSubtotal − commission`;
   - `finalPayable = Σ itemsSubtotal + Σ shippingFee − totalDiscount` (discount 0: no
     discount engine yet);
   - insert ParentOrder (payment PENDING, `CASH_IPG`, `paymentExpiresAt = now +
     ORDER_PAYMENT_TIMEOUT_MINUTES`), SubOrders (PENDING_APPROVAL), OrderItem snapshots
     (title, SKU, variant details, unit price, commission rate, store name) and the first
     status-history row per package;
   - `reserved_quantity += q` per variant via the guarded `InventoryService.reserve`;
   - empty the cart; write the audit row (amounts, store ids — no address PII).
3. The response is read back from the committed rows.

The database enforces the identities independently (CHECK constraints from the migration):
`commission + earnings = itemsSubtotal` per package, `totalLineAmount = unitPrice × qty −
discount`, `finalPayable = items + shipping − discount` on the parent, SHIPPED ⇒ tracking code
and carrier present, cart quantity > 0.

## 4. Shipping rule (TM decision, implemented verbatim)

```
defaultFee      = system_configs['shipping.default_fee_per_vendor']     ?? env SHIPPING_DEFAULT_FEE_PER_VENDOR
defaultThreshold= system_configs['shipping.free_threshold_per_vendor']  ?? env SHIPPING_FREE_THRESHOLD_PER_VENDOR
threshold       = vendor.freeShippingThreshold ?? defaultThreshold
fee             = (threshold > 0 && itemsSubtotal >= threshold) ? 0 : (vendor.shippingFeeOverride ?? defaultFee)
```
The policy is read from the DB on every quote (no stale cache). An invalid `system_configs`
value fails with 503 instead of silently charging an unconfigured fee.

## 5. Lifecycle and stock

```
ParentOrder.paymentStatus:  PENDING ──markPaid──► PAID
                               ├──customer cancel / expiry──► CANCELLED   (reserved −= q)
                               └──markPaymentFailed─────────► FAILED      (reserved −= q)
                            on PAID: stock −= q, reserved −= q  (commitReservation)

SubOrder (paid orders):  PENDING_APPROVAL ─vendor→ PROCESSING ─vendor→ SHIPPED ─staff→ DELIVERED
                         PENDING_APPROVAL/PROCESSING ─vendor→ CANCELLED   (stock += q)
                         any non-refunded ─staff→ REFUNDED  (stock += q only if never shipped)
```
- Every lifecycle operation first locks the parent order row, so payment callbacks, customer
  cancel, the expiry sweeper and vendor/staff actions on one order are serialised; the status
  read after the lock is the one acted upon, and the UPDATE is additionally guarded by
  `WHERE status = <read status>`.
- Stock moves are aggregated per variant and applied in variant-id order (same order as
  checkout).
- Every transition writes `sub_order_status_history` (actor user, role, note) and an audit row
  (`STATUS_CHANGE`, `PAYMENT_CAPTURE`, `CREATE`) in the same transaction.
- Vendors see and act on packages only once the parent order is PAID; foreign, unknown and
  unpaid packages all return 404 (no existence leak). SUSPENDED stores can still fulfil orders
  they have already sold.
- **Expiry sweeper:** `setInterval` every `ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS` (0 disables),
  timer `unref()`ed; a Redis `SET NX PX` lock (released by compare-and-delete Lua) keeps
  several API instances from sweeping at once. Each order is expired in its own transaction
  and re-checked under the row lock (a payment that landed first wins).
- `markPaid` / `markPaymentFailed` are service methods only (exported by `OrdersModule`) for the
  payment module; no HTTP endpoint can mark an order paid.

## 6. Cart design decisions (announced in Persian as conservative defaults)

- Guest carts use a random 256-bit token (`X-Cart-Token`); only its SHA-256 digest is stored.
  An unknown token never adopts a cart: a new one is issued. Malformed → 400.
- A signed-in user always works on the account cart; combining with a guest cart is the
  explicit `POST /cart/merge` (called by the client right after login).
- Stock is **checked** on add (cart quantity ≤ stock − reserved) but **reserved only at
  checkout**, in the order transaction as required.
- Adding more of a line refreshes its price snapshot (the customer is looking at the live
  price); otherwise changed prices are flagged `PRICE_CHANGED` until checkout.
- Cart endpoints are `@SkipAudit()`: high volume, no authority, and the response contains the
  guest token, which must not land in the audit table.

## 7. Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SHIPPING_DEFAULT_FEE_PER_VENDOR` | required | fallback per-store fee (Toman) |
| `SHIPPING_FREE_THRESHOLD_PER_VENDOR` | required | fallback free-shipping threshold; 0 disables |
| `ORDER_PAYMENT_TIMEOUT_MINUTES` | 30 | payment window before automatic cancellation |
| `ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS` | 60 | sweeper period; 0 disables |

`system_configs` keys `shipping.default_fee_per_vendor` / `shipping.free_threshold_per_vendor`
override the env values when present (not seeded).

## 8. Schema changes (migration `20260928090000_phase6_orders`)

- `vendors.shipping_fee_override`, `vendors.free_shipping_threshold` (nullable Decimal, ≥ 0).
- `cart_items.unit_price_snapshot` (+ CHECK quantity > 0, snapshot > 0).
- `parent_orders`: `customer_note`, `payment_expires_at`, `paid_at`, `cancelled_at`,
  `cancellation_reason`; index `(payment_status, payment_expires_at)`; money identity CHECK.
- `sub_orders`: `shipped_at`, `cancelled_at`, `cancellation_reason` (`delivered_at` already existed); CHECK
  commission + earnings = subtotal; CHECK SHIPPED ⇒ tracking code + carrier.
- `order_items`: `sku_snapshot`, `vendor_store_name_snapshot`; line-total CHECK.
- new table `sub_order_status_history`; sequence `parent_order_number_seq` (starts 100000001).

## 9. Not in this phase (stated honestly)

- **Payment gateway / payment endpoint:** not implemented. `markPaid` and
  `markPaymentFailed` exist and are tested, but nothing calls them over HTTP yet; in the e2e
  suite they are invoked directly on the real service.
- **Refund money movement / wallet entries:** a vendor cancel or staff REFUNDED of a paid
  package changes status and stock and is audited, but no money is moved and no
  `wallet_transactions` / escrow rows are written — that belongs to the finance phase.
- **Discounts / coupons:** `totalDiscountAmount` is always 0.
- **BNPL (`BANK_CREDIT`, `HYBRID`):** checkout creates `CASH_IPG` orders only.
- **Store shipping settings API:** the two new vendor columns have no endpoint (not in the
  Phase-6 list); the e2e test sets them directly.
- **Stale guest carts** are never purged (needs a cleanup job).
- **Rate limiting** of cart/checkout endpoints is not implemented (platform-wide gap).

---

## 10. Complete source files

### `apps/backend/src/modules/addresses/addresses.controller.ts`

```ts
import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { AddressesService, MAX_ADDRESSES_PER_CUSTOMER } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address-input.dto';
import { AddressDto, AddressListDto, DeleteAddressResponseDto } from './dto/address-response.dto';

const UUID = new ParseUUIDPipe({ version: '4' });

/**
 * The signed-in customer's address book. Writes are `@SkipAudit()` because the
 * service writes a PII-free audit row inside each transaction.
 */
@ApiTags('customer-addresses')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only customers have an address book' })
@Controller('customer/addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @ApiOperation({ summary: 'List saved addresses (default first)' })
  @ApiOkResponse({ type: AddressListDto })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<AddressListDto> {
    const items = await this.addresses.list(user.id);
    return { items, total: items.length, limit: MAX_ADDRESSES_PER_CUSTOMER };
  }

  @Post()
  @SkipAudit()
  @ApiOperation({ summary: 'Add an address', description: 'The first address becomes the default automatically.' })
  @ApiCreatedResponse({ type: AddressDto })
  @ApiBadRequestResponse({ description: 'Validation failed (postal code, mobile, lengths)' })
  @ApiConflictResponse({ description: `Address book full (${MAX_ADDRESSES_PER_CUSTOMER})` })
  create(
    @Body() dto: CreateAddressDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AddressDto> {
    return this.addresses.create(user.id, dto, { actorId: user.id, context });
  }

  @Patch(':id')
  @SkipAudit()
  @ApiOperation({ summary: 'Update an address or make it the default' })
  @ApiOkResponse({ type: AddressDto })
  @ApiBadRequestResponse({ description: 'Validation failed, empty body, or isDefault=false' })
  @ApiNotFoundResponse({ description: 'No such address in this address book' })
  update(
    @Param('id', UUID) id: string,
    @Body() dto: UpdateAddressDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AddressDto> {
    return this.addresses.update(user.id, id, dto, { actorId: user.id, context });
  }

  @Delete(':id')
  @SkipAudit()
  @ApiOperation({
    summary: 'Delete an address',
    description:
      'Hard delete. Always allowed: orders keep their own copy of the shipping address. Deleting the default promotes the newest remaining address.',
  })
  @ApiOkResponse({ type: DeleteAddressResponseDto })
  @ApiNotFoundResponse({ description: 'No such address in this address book' })
  remove(
    @Param('id', UUID) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<DeleteAddressResponseDto> {
    return this.addresses.remove(user.id, id, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/addresses/addresses.module.ts`

```ts
import { Module } from '@nestjs/common';
import { AddressesController } from './addresses.controller';
import { AddressesService } from './addresses.service';

/** Customer address book; checkout reads addresses directly by (id, userId). */
@Module({
  controllers: [AddressesController],
  providers: [AddressesService],
  exports: [AddressesService],
})
export class AddressesModule {}
```

### `apps/backend/src/modules/addresses/addresses.service.ts`

```ts
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import type { RequestContext } from '../../common/types/request-context';
import { toE164 } from '../../common/validators/iranian-mobile';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { CreateAddressDto, UpdateAddressDto } from './dto/address-input.dto';
import type { AddressDto, DeleteAddressResponseDto } from './dto/address-response.dto';

/** Upper bound on saved addresses per customer (abuse protection, not a business rule). */
export const MAX_ADDRESSES_PER_CUSTOMER = 20;

type Tx = Prisma.TransactionClient;

interface ActorParams {
  actorId: string;
  context: RequestContext;
}

const addressSelect = {
  id: true,
  province: true,
  city: true,
  postalAddress: true,
  postalCode: true,
  buildingNumber: true,
  unitNumber: true,
  recipientName: true,
  recipientMobile: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AddressSelect;

const listOrder: Prisma.AddressOrderByWithRelationInput[] = [{ isDefault: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }];

/**
 * A customer's address book.
 *
 * Invariants: a customer with addresses has exactly one default, and
 * `customer_profiles.default_address_id` always points at it. Both are changed in
 * the same transaction, under a row lock on the user, so two concurrent "make
 * default" requests cannot leave two defaults behind.
 *
 * Addresses are always deletable: an order copies the address into
 * `parent_orders.shipping_address_snapshot` at checkout, so no order depends on
 * the row afterwards.
 *
 * Audit rows record *which* fields changed, never the values: addresses and
 * recipient phone numbers are personal data and do not belong in a long-lived log.
 */
@Injectable()
export class AddressesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(userId: string): Promise<AddressDto[]> {
    return this.prisma.address.findMany({ where: { userId }, select: addressSelect, orderBy: listOrder });
  }

  async create(userId: string, dto: CreateAddressDto, params: ActorParams): Promise<AddressDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const count = await tx.address.count({ where: { userId } });
      if (count >= MAX_ADDRESSES_PER_CUSTOMER) {
        throw new ConflictException(
          `An address book holds at most ${MAX_ADDRESSES_PER_CUSTOMER} addresses; delete one before adding another`,
        );
      }
      const makeDefault = count === 0 || dto.isDefault === true;
      if (makeDefault) {
        await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
      }
      const address = await tx.address.create({
        data: {
          userId,
          province: dto.province,
          city: dto.city,
          postalAddress: dto.postalAddress,
          postalCode: dto.postalCode,
          buildingNumber: dto.buildingNumber ?? null,
          unitNumber: dto.unitNumber ?? null,
          recipientName: dto.recipientName,
          recipientMobile: canonicalMobile(dto.recipientMobile),
          isDefault: makeDefault,
        },
        select: addressSelect,
      });
      if (makeDefault) {
        await syncProfileDefault(tx, userId, address.id);
      }
      await audit(tx, params, AuditAction.CREATE, address.id, { isDefault: makeDefault });
      return address;
    });
  }

  async update(userId: string, addressId: string, dto: UpdateAddressDto, params: ActorParams): Promise<AddressDto> {
    const changedFields = Object.entries(dto)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key);
    if (changedFields.length === 0) {
      throw new BadRequestException('Send at least one field to update');
    }
    if (dto.isDefault === false) {
      throw new BadRequestException('isDefault only accepts true; mark another address as default instead');
    }

    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.address.findFirst({ where: { id: addressId, userId }, select: { id: true, isDefault: true } });
      if (!current) {
        throw new NotFoundException('Address not found');
      }
      if (dto.isDefault === true && !current.isDefault) {
        await tx.address.updateMany({ where: { userId, isDefault: true }, data: { isDefault: false } });
        await syncProfileDefault(tx, userId, addressId);
      }
      const address = await tx.address.update({
        where: { id: addressId },
        data: {
          ...(dto.province !== undefined ? { province: dto.province } : {}),
          ...(dto.city !== undefined ? { city: dto.city } : {}),
          ...(dto.postalAddress !== undefined ? { postalAddress: dto.postalAddress } : {}),
          ...(dto.postalCode !== undefined ? { postalCode: dto.postalCode } : {}),
          ...(dto.buildingNumber !== undefined ? { buildingNumber: dto.buildingNumber } : {}),
          ...(dto.unitNumber !== undefined ? { unitNumber: dto.unitNumber } : {}),
          ...(dto.recipientName !== undefined ? { recipientName: dto.recipientName } : {}),
          ...(dto.recipientMobile !== undefined ? { recipientMobile: canonicalMobile(dto.recipientMobile) } : {}),
          ...(dto.isDefault === true ? { isDefault: true } : {}),
        },
        select: addressSelect,
      });
      await audit(tx, params, AuditAction.UPDATE, addressId, { changedFields });
      return address;
    });
  }

  async remove(userId: string, addressId: string, params: ActorParams): Promise<DeleteAddressResponseDto> {
    return this.prisma.$transaction(async (tx) => {
      await lockUser(tx, userId);
      const current = await tx.address.findFirst({ where: { id: addressId, userId }, select: { id: true, isDefault: true } });
      if (!current) {
        throw new NotFoundException('Address not found');
      }
      await tx.address.delete({ where: { id: addressId } });

      let newDefaultAddressId: string | null = null;
      if (current.isDefault) {
        const next = await tx.address.findFirst({
          where: { userId },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          select: { id: true },
        });
        if (next) {
          await tx.address.update({ where: { id: next.id }, data: { isDefault: true } });
          newDefaultAddressId = next.id;
        }
        // The profile FK is ON DELETE SET NULL; re-point it at the promoted address.
        await syncProfileDefault(tx, userId, newDefaultAddressId);
      }
      await audit(tx, params, AuditAction.DELETE, addressId, { wasDefault: current.isDefault, newDefaultAddressId });
      return { id: addressId, deleted: true, newDefaultAddressId };
    });
  }
}

/** Serialises address-book writes of one customer. */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`);
}

async function syncProfileDefault(tx: Tx, userId: string, addressId: string | null): Promise<void> {
  await tx.customerProfile.upsert({
    where: { userId },
    update: { defaultAddressId: addressId },
    create: { userId, defaultAddressId: addressId },
  });
}

function canonicalMobile(input: string): string {
  const e164 = toE164(input);
  if (e164 === null) {
    // The DTO validator already guarantees this; kept as a hard stop for direct callers.
    throw new BadRequestException('recipientMobile must be an Iranian mobile number');
  }
  return e164;
}

async function audit(
  tx: Tx,
  params: ActorParams,
  action: AuditAction,
  entityId: string,
  newValue: Record<string, unknown>,
): Promise<void> {
  await tx.auditLog.create({
    data: {
      userId: params.actorId,
      action,
      entityName: 'Address',
      entityId,
      ipAddress: params.context.ipAddress,
      userAgent: params.context.userAgent,
      newValue: newValue as Prisma.InputJsonValue,
    },
  });
}
```

### `apps/backend/src/modules/addresses/dto/address-input.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { normalizePersianParagraphs, normalizePersianText, toAsciiDigits } from '../../products/catalog-text';

/** Iranian postal codes: 10 digits, never starting with 0. */
export const POSTAL_CODE_PATTERN = /^[1-9][0-9]{9}$/;

const text = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? normalizePersianText(value) : value);
const paragraph = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? normalizePersianParagraphs(value) : value;
const digits = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? toAsciiDigits(value).replace(/[\s-]/g, '') : value;
/** Empty optional strings are stored as NULL rather than ''. */
const optionalText = ({ value }: { value: unknown }): unknown => {
  if (typeof value !== 'string') return value;
  const normalized = toAsciiDigits(normalizePersianText(value));
  return normalized === '' ? null : normalized;
};

export class CreateAddressDto {
  @ApiProperty({ example: 'تهران', maxLength: 60 })
  @Transform(text)
  @IsString()
  @Length(2, 60)
  province!: string;

  @ApiProperty({ example: 'تهران', maxLength: 60 })
  @Transform(text)
  @IsString()
  @Length(2, 60)
  city!: string;

  @ApiProperty({ example: 'خیابان ولیعصر، بالاتر از میدان ونک، کوچه نگار', maxLength: 500 })
  @Transform(paragraph)
  @IsString()
  @Length(10, 500)
  postalAddress!: string;

  @ApiProperty({ example: '1969833111', description: '10 digits; Persian digits, spaces and dashes are accepted.' })
  @Transform(digits)
  @IsString()
  @Matches(POSTAL_CODE_PATTERN, { message: 'postalCode must be a 10-digit Iranian postal code' })
  postalCode!: string;

  @ApiPropertyOptional({ example: '12', maxLength: 20, nullable: true })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  buildingNumber?: string | null;

  @ApiPropertyOptional({ example: '4', maxLength: 20, nullable: true })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unitNumber?: string | null;

  @ApiProperty({ example: 'مریم احمدی', maxLength: 120 })
  @Transform(text)
  @IsString()
  @Length(2, 120)
  recipientName!: string;

  @ApiProperty({ example: '09121234567', description: 'Any common spelling; stored as E.164 (+989…).' })
  @IsString()
  @IsIranianMobile()
  recipientMobile!: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Make this the default address. The first address a customer saves is always the default.',
  })
  @IsOptional()
  @IsBoolean()
  isDefault?: boolean;
}

export class UpdateAddressDto {
  @ApiPropertyOptional({ example: 'اصفهان', maxLength: 60 })
  @Transform(text)
  @IsOptionalNonNullable()
  @IsString()
  @Length(2, 60)
  province?: string;

  @ApiPropertyOptional({ example: 'اصفهان', maxLength: 60 })
  @Transform(text)
  @IsOptionalNonNullable()
  @IsString()
  @Length(2, 60)
  city?: string;

  @ApiPropertyOptional({ example: 'خیابان چهارباغ عباسی، کوچه ۱۲', maxLength: 500 })
  @Transform(paragraph)
  @IsOptionalNonNullable()
  @IsString()
  @Length(10, 500)
  postalAddress?: string;

  @ApiPropertyOptional({ example: '8174673111' })
  @Transform(digits)
  @IsOptionalNonNullable()
  @IsString()
  @Matches(POSTAL_CODE_PATTERN, { message: 'postalCode must be a 10-digit Iranian postal code' })
  postalCode?: string;

  @ApiPropertyOptional({ example: '7', maxLength: 20, nullable: true, description: 'null clears the value.' })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  buildingNumber?: string | null;

  @ApiPropertyOptional({ example: '2', maxLength: 20, nullable: true, description: 'null clears the value.' })
  @Transform(optionalText)
  @IsOptional()
  @IsString()
  @MaxLength(20)
  unitNumber?: string | null;

  @ApiPropertyOptional({ example: 'علی رضایی', maxLength: 120 })
  @Transform(text)
  @IsOptionalNonNullable()
  @IsString()
  @Length(2, 120)
  recipientName?: string;

  @ApiPropertyOptional({ example: '+989351234567' })
  @IsOptionalNonNullable()
  @IsString()
  @IsIranianMobile()
  recipientMobile?: string;

  @ApiPropertyOptional({
    example: true,
    description: 'Only `true` is accepted: to change the default, mark another address as default.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isDefault?: boolean;
}
```

### `apps/backend/src/modules/addresses/dto/address-response.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';

export class AddressDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'تهران' })
  province!: string;

  @ApiProperty({ example: 'تهران' })
  city!: string;

  @ApiProperty({ example: 'خیابان ولیعصر، بالاتر از میدان ونک، کوچه نگار' })
  postalAddress!: string;

  @ApiProperty({ example: '1969833111' })
  postalCode!: string;

  @ApiProperty({ example: '12', nullable: true, type: String })
  buildingNumber!: string | null;

  @ApiProperty({ example: '4', nullable: true, type: String })
  unitNumber!: string | null;

  @ApiProperty({ example: 'مریم احمدی' })
  recipientName!: string;

  @ApiProperty({ example: '+989121234567', description: 'E.164' })
  recipientMobile!: string;

  @ApiProperty()
  isDefault!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AddressListDto {
  @ApiProperty({ type: [AddressDto], description: 'Default address first, then newest first.' })
  items!: AddressDto[];

  @ApiProperty({ example: 2 })
  total!: number;

  @ApiProperty({ example: 20, description: 'Maximum number of addresses a customer can keep.' })
  limit!: number;
}

export class DeleteAddressResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'When the deleted address was the default, the address promoted in its place (newest remaining).',
  })
  newDefaultAddressId!: string | null;
}
```

### `apps/backend/src/modules/cart/cart-token.ts`

```ts
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { badRequestWith } from '../../common/http-errors';

/** Header carrying a guest cart's bearer token. */
export const CART_TOKEN_HEADER = 'x-cart-token';

/** 32 random bytes, base64url: 43 characters, 256 bits of entropy. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * Guest carts are addressed by a random bearer token the server issues on the
 * first add. Only its SHA-256 digest is stored (`carts.session_token`), so a
 * database leak does not hand out usable cart tokens; knowing the digest is not
 * enough to act on the cart.
 */
export function issueCartToken(): { token: string; digest: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, digest: digestCartToken(token) };
}

export function digestCartToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Reads `X-Cart-Token`. Absent → `undefined`. Present but malformed → 400, so a
 * client bug is visible instead of silently starting a new empty cart.
 */
export const CartToken = createParamDecorator((_data: unknown, context: ExecutionContext): string | undefined => {
  const request = context.switchToHttp().getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
  const raw = request.headers?.[CART_TOKEN_HEADER];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (value === undefined || value === '') {
    return undefined;
  }
  if (!TOKEN_PATTERN.test(value)) {
    throw badRequestWith('INVALID_CART_TOKEN', `${CART_TOKEN_HEADER} is malformed`);
  }
  return value;
});
```

### `apps/backend/src/modules/cart/cart-view.ts`

```ts
import { Prisma } from '@prisma/client';
import { quoteShipping, type ShippingPolicy } from '../shipping/shipping-fee';
import type { CartDto, CartIssueDto, CartLineDto, CartVendorGroupDto } from './dto/cart-response.dto';
import {
  availableQuantity,
  purchasableVariantSelect,
  unavailableReason,
  UNAVAILABLE_MESSAGES,
  type PurchasableVariant,
} from './purchasable';

export const cartLineSelect = {
  id: true,
  quantity: true,
  unitPriceSnapshot: true,
  createdAt: true,
  productVariant: { select: purchasableVariantSelect },
} satisfies Prisma.CartItemSelect;

export type CartLineRow = Prisma.CartItemGetPayload<{ select: typeof cartLineSelect }>;

const ZERO = new Prisma.Decimal(0);
const money = (value: Prisma.Decimal): string => value.toFixed(2);

/** Evaluated state of one cart line against live catalogue data. */
export interface EvaluatedLine {
  row: CartLineRow;
  variant: PurchasableVariant;
  available: number;
  isPurchasable: boolean;
  priceChanged: boolean;
  issues: CartIssueDto[];
}

export function evaluateLine(row: CartLineRow, visibleCategoryIds: ReadonlySet<string>): EvaluatedLine {
  const variant = row.productVariant;
  const issues: CartIssueDto[] = [];
  const reason = unavailableReason(variant, visibleCategoryIds);
  const available = availableQuantity(variant);

  if (reason !== null) {
    issues.push({ code: reason, message: UNAVAILABLE_MESSAGES[reason] });
  } else if (available === 0) {
    issues.push({ code: 'OUT_OF_STOCK', message: 'Out of stock' });
  } else if (available < row.quantity) {
    issues.push({ code: 'INSUFFICIENT_STOCK', message: `Only ${available} left in stock` });
  }

  const priceChanged = !variant.price.eq(row.unitPriceSnapshot);
  if (priceChanged) {
    issues.push({
      code: 'PRICE_CHANGED',
      message: `Price changed from ${money(row.unitPriceSnapshot)} to ${money(variant.price)}`,
    });
  }

  return { row, variant, available, isPurchasable: reason === null, priceChanged, issues };
}

/**
 * Builds the cart response: lines grouped by store (in the order the store's
 * first line was added), per-store subtotal and shipping estimate, and totals.
 * Only purchasable lines count toward subtotals and shipping.
 */
export function buildCartView(
  rows: CartLineRow[],
  visibleCategoryIds: ReadonlySet<string>,
  policy: ShippingPolicy,
  meta: { owner: CartDto['owner']; cartToken: string | null },
): CartDto {
  const groups = new Map<string, { vendor: PurchasableVariant['product']['vendor']; lines: EvaluatedLine[] }>();
  const ordered = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

  for (const row of ordered) {
    const line = evaluateLine(row, visibleCategoryIds);
    const vendor = line.variant.product.vendor;
    const group = groups.get(vendor.id) ?? { vendor, lines: [] };
    group.lines.push(line);
    groups.set(vendor.id, group);
  }

  let itemsSubtotal = ZERO;
  let shippingTotal = ZERO;
  let itemCount = 0;
  let hasIssues = false;
  let hasPriceChanges = false;

  const groupDtos: CartVendorGroupDto[] = [...groups.values()].map(({ vendor, lines }) => {
    const subtotal = lines
      .filter((line) => line.isPurchasable)
      .reduce((sum, line) => sum.add(line.variant.price.mul(line.row.quantity)), ZERO);
    const quote = subtotal.gt(ZERO)
      ? quoteShipping(subtotal, vendor, policy)
      : { fee: ZERO, isFree: false, freeThreshold: vendor.freeShippingThreshold ?? policy.freeThresholdPerVendor, remainingForFreeShipping: null };

    itemsSubtotal = itemsSubtotal.add(subtotal);
    shippingTotal = shippingTotal.add(quote.fee);

    return {
      vendor: { storeName: vendor.storeName, storeSlug: vendor.storeSlug },
      lines: lines.map((line): CartLineDto => {
        itemCount += line.row.quantity;
        hasIssues ||= line.issues.length > 0;
        hasPriceChanges ||= line.priceChanged;
        const media = line.variant.product.media[0];
        return {
          id: line.row.id,
          productVariantId: line.variant.id,
          sku: line.variant.sku,
          productId: line.variant.product.id,
          productSlug: line.variant.product.slug,
          productTitle: line.variant.product.title,
          colorName: line.variant.colorName,
          colorHex: line.variant.colorHex,
          size: line.variant.size,
          guarantee: line.variant.guarantee,
          image: media ? { url: media.url, thumbnailUrl: media.thumbnailUrl } : null,
          quantity: line.row.quantity,
          unitPrice: money(line.variant.price),
          priceWhenAdded: money(line.row.unitPriceSnapshot),
          compareAtPrice: line.variant.compareAtPrice === null ? null : money(line.variant.compareAtPrice),
          lineTotal: money(line.variant.price.mul(line.row.quantity)),
          availableQuantity: line.available,
          isPurchasable: line.isPurchasable,
          issues: line.issues,
          addedAt: line.row.createdAt,
        };
      }),
      itemsSubtotal: money(subtotal),
      shipping: {
        fee: money(quote.fee),
        isFree: quote.isFree,
        freeThreshold: money(quote.freeThreshold),
        remainingForFreeShipping: quote.remainingForFreeShipping === null ? null : money(quote.remainingForFreeShipping),
      },
      packageTotal: money(subtotal.add(quote.fee)),
    };
  });

  return {
    cartToken: meta.cartToken,
    owner: meta.owner,
    groups: groupDtos,
    itemCount,
    lineCount: rows.length,
    itemsSubtotal: money(itemsSubtotal),
    shippingTotal: money(shippingTotal),
    payableAmount: money(itemsSubtotal.add(shippingTotal)),
    hasPriceChanges,
    canCheckout: rows.length > 0 && !hasIssues,
  };
}
```

### `apps/backend/src/modules/cart/cart.controller.ts`

```ts
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, OptionalUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { SkipAudit } from '../audit/audit.decorator';
import { CART_TOKEN_HEADER, CartToken } from './cart-token';
import { CartService, type CartIdentity } from './cart.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart-input.dto';
import { CartDto, MergeCartResponseDto } from './dto/cart-response.dto';

const UUID = new ParseUUIDPipe({ version: '4' });

const TOKEN_HEADER_DOC = {
  name: CART_TOKEN_HEADER,
  required: false,
  description:
    'Guest cart token (43 characters) returned as `cartToken` when the guest cart was created. Ignored when a valid bearer token is sent: signed-in users always use their own cart.',
};

const identityOf = (user: AuthenticatedUser | undefined, token: string | undefined): CartIdentity =>
  user ? { userId: user.id } : token !== undefined ? { token } : {};

/**
 * Cart for guests and signed-in users. Cart edits are not audited
 * (`@SkipAudit()`): they are high-volume, carry no authority, and the response
 * contains the guest token, which must never be written to the audit table.
 */
@ApiTags('cart')
@SkipAudit()
@ApiBadRequestResponse({ description: 'Malformed X-Cart-Token (code INVALID_CART_TOKEN) or validation failed' })
@Controller('cart')
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Get()
  @Public()
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({
    summary: 'Current cart, grouped by store',
    description:
      'Every line is checked against live data: availability, stock and price. Changed prices are flagged (PRICE_CHANGED) until the customer acts on the line or checks out.',
  })
  @ApiOkResponse({ type: CartDto })
  get(@OptionalUser() user: AuthenticatedUser | undefined, @CartToken() token: string | undefined): Promise<CartDto> {
    return this.carts.get(identityOf(user, token));
  }

  @Post('items')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({
    summary: 'Add a product option to the cart',
    description:
      'Adds to the existing quantity of the same variant. The total may not exceed available stock. A guest without a token gets a new cart and its token in `cartToken` (returned once).',
  })
  @ApiOkResponse({ type: CartDto })
  @ApiBadRequestResponse({ description: 'Validation failed, malformed X-Cart-Token, or per-item cap exceeded' })
  @ApiNotFoundResponse({ description: 'Unknown variant' })
  @ApiConflictResponse({ description: 'Not purchasable, out of stock / insufficient stock (with availableQuantity), or cart full' })
  add(
    @Body() dto: AddCartItemDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @CartToken() token: string | undefined,
  ): Promise<CartDto> {
    return this.carts.addItem(identityOf(user, token), dto);
  }

  @Patch('items/:id')
  @Public()
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({ summary: 'Change the quantity of a cart line', description: 'Raising the quantity is checked against live stock; lowering it always works.' })
  @ApiOkResponse({ type: CartDto })
  @ApiNotFoundResponse({ description: 'No such line in the caller’s cart' })
  @ApiConflictResponse({ description: 'Insufficient stock or no longer purchasable' })
  update(
    @Param('id', UUID) id: string,
    @Body() dto: UpdateCartItemDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @CartToken() token: string | undefined,
  ): Promise<CartDto> {
    return this.carts.updateItem(identityOf(user, token), id, dto);
  }

  @Delete('items/:id')
  @Public()
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({ summary: 'Remove a line from the cart' })
  @ApiOkResponse({ type: CartDto })
  @ApiNotFoundResponse({ description: 'No such line in the caller’s cart' })
  remove(
    @Param('id', UUID) id: string,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @CartToken() token: string | undefined,
  ): Promise<CartDto> {
    return this.carts.removeItem(identityOf(user, token), id);
  }

  @Post('clear')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({ summary: 'Remove every line from the cart' })
  @ApiOkResponse({ type: CartDto })
  clear(@OptionalUser() user: AuthenticatedUser | undefined, @CartToken() token: string | undefined): Promise<CartDto> {
    return this.carts.clear(identityOf(user, token));
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiHeader({ ...TOKEN_HEADER_DOC, required: true, description: 'Token of the guest cart to merge into the account cart.' })
  @ApiOperation({
    summary: 'Merge the guest cart into the signed-in user’s cart (call right after login)',
    description:
      'Quantities of the same variant are added and limited to live stock; unavailable lines are dropped. The guest cart is deleted. Calling it again with the same token is a no-op.',
  })
  @ApiOkResponse({ type: MergeCartResponseDto })
  @ApiBadRequestResponse({ description: 'X-Cart-Token missing or malformed' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  merge(@CurrentUser() user: AuthenticatedUser, @CartToken() token: string | undefined): Promise<MergeCartResponseDto> {
    if (token === undefined) {
      throw new BadRequestException(`${CART_TOKEN_HEADER} header is required`);
    }
    return this.carts.merge(user.id, token);
  }
}
```

### `apps/backend/src/modules/cart/cart.module.ts`

```ts
import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { ShippingModule } from '../shipping/shipping.module';
import { CartController } from './cart.controller';
import { CartService } from './cart.service';

/** Guest and account carts. `CartService` is exported for checkout. */
@Module({
  imports: [CategoriesModule, ShippingModule],
  controllers: [CartController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
```

### `apps/backend/src/modules/cart/cart.service.ts`

```ts
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
```

### `apps/backend/src/modules/cart/dto/cart-input.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsUUID, Max, Min } from 'class-validator';

/** Largest quantity of one variant in a cart (abuse protection; stock is the real limit). */
export const MAX_LINE_QUANTITY = 100;
/** Largest number of distinct lines in one cart. */
export const MAX_CART_LINES = 50;

export class AddCartItemDto {
  @ApiProperty({ format: 'uuid', description: 'The variant (colour/size option) to buy.' })
  @IsUUID('4')
  productVariantId!: string;

  @ApiProperty({
    example: 1,
    minimum: 1,
    maximum: MAX_LINE_QUANTITY,
    description: 'Added to the quantity already in the cart for this variant.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}

export class UpdateCartItemDto {
  @ApiProperty({ example: 2, minimum: 1, maximum: MAX_LINE_QUANTITY, description: 'The new absolute quantity.' })
  @IsInt()
  @Min(1)
  @Max(MAX_LINE_QUANTITY)
  quantity!: number;
}
```

### `apps/backend/src/modules/cart/dto/cart-response.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const CART_ISSUE_CODES = [
  'VARIANT_INACTIVE',
  'PRODUCT_UNPUBLISHED',
  'PRODUCT_BLOCKED',
  'STORE_UNAVAILABLE',
  'CATEGORY_UNAVAILABLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'PRICE_CHANGED',
] as const;
export type CartIssueCode = (typeof CART_ISSUE_CODES)[number];

export const MERGE_DROP_REASONS = [...CART_ISSUE_CODES, 'CART_FULL'] as const;
export type MergeDropReason = (typeof MERGE_DROP_REASONS)[number];

export class CartIssueDto {
  @ApiProperty({ enum: CART_ISSUE_CODES })
  code!: CartIssueCode;

  @ApiProperty({ example: 'Only 2 left in stock' })
  message!: string;
}

export class CartImageDto {
  @ApiProperty()
  url!: string;

  @ApiProperty({ nullable: true, type: String })
  thumbnailUrl!: string | null;
}

export class CartLineDto {
  @ApiProperty({ format: 'uuid', description: 'Cart line id (use it for PATCH/DELETE /cart/items/:id).' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productVariantId!: string;

  @ApiProperty({ example: 'SHP-X1-256-BLK' })
  sku!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ example: 'shopino-sample-smartphone-x1' })
  productSlug!: string;

  @ApiProperty({ example: 'گوشی موبایل شاپینو X1' })
  productTitle!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ type: CartImageDto, nullable: true })
  image!: CartImageDto | null;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: '42500000.00', description: 'Live selling price of the variant.' })
  unitPrice!: string;

  @ApiProperty({ example: '42000000.00', description: 'Price the customer last saw for this line.' })
  priceWhenAdded!: string;

  @ApiProperty({ example: '45000000.00', nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ example: '42500000.00', description: 'unitPrice × quantity.' })
  lineTotal!: string;

  @ApiProperty({ example: 12, description: 'Units that can still be bought right now.' })
  availableQuantity!: number;

  @ApiProperty({ description: 'False when the variant cannot be bought at all (see issues).' })
  isPurchasable!: boolean;

  @ApiProperty({ type: [CartIssueDto] })
  issues!: CartIssueDto[];

  @ApiProperty()
  addedAt!: Date;
}

export class CartVendorDto {
  @ApiProperty({ example: 'فروشگاه نمونه شاپینو' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;
}

export class CartShippingDto {
  @ApiProperty({ example: '500000.00' })
  fee!: string;

  @ApiProperty()
  isFree!: boolean;

  @ApiProperty({ example: '10000000.00', description: 'Free-shipping threshold for this store ("0.00" = none).' })
  freeThreshold!: string;

  @ApiProperty({ example: '1500000.00', nullable: true, type: String, description: 'Missing amount for free shipping.' })
  remainingForFreeShipping!: string | null;
}

export class CartVendorGroupDto {
  @ApiProperty({ type: CartVendorDto })
  vendor!: CartVendorDto;

  @ApiProperty({ type: [CartLineDto] })
  lines!: CartLineDto[];

  @ApiProperty({ example: '85000000.00', description: 'Sum of line totals of purchasable lines.' })
  itemsSubtotal!: string;

  @ApiProperty({ type: CartShippingDto, description: 'Estimate for this store package with the current policy.' })
  shipping!: CartShippingDto;

  @ApiProperty({ example: '85500000.00' })
  packageTotal!: string;
}

export class CartDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Guest cart token, returned only in the response that created the guest cart. Send it back in the X-Cart-Token header.',
  })
  cartToken!: string | null;

  @ApiProperty({ enum: ['user', 'guest', 'none'], description: '"none": no cart exists yet.' })
  owner!: 'user' | 'guest' | 'none';

  @ApiProperty({ type: [CartVendorGroupDto], description: 'Lines grouped by store, in the order stores were added.' })
  groups!: CartVendorGroupDto[];

  @ApiProperty({ example: 3, description: 'Total units.' })
  itemCount!: number;

  @ApiProperty({ example: 2 })
  lineCount!: number;

  @ApiProperty({ example: '85000000.00' })
  itemsSubtotal!: string;

  @ApiProperty({ example: '500000.00' })
  shippingTotal!: string;

  @ApiProperty({ example: '85500000.00' })
  payableAmount!: string;

  @ApiProperty({ description: 'True when at least one line has a changed price.' })
  hasPriceChanges!: boolean;

  @ApiProperty({ description: 'True when the cart is non-empty and no line has an issue.' })
  canCheckout!: boolean;
}

export class MergeAdjustmentDto {
  @ApiProperty({ format: 'uuid' })
  productVariantId!: string;

  @ApiProperty({ example: 'SHP-X1-256-BLK' })
  sku!: string;

  @ApiPropertyOptional({ example: 5, description: 'Quantity the merge wanted to place.' })
  requested?: number;

  @ApiPropertyOptional({ example: 3, description: 'Quantity actually placed (limited by stock).' })
  applied?: number;

  @ApiPropertyOptional({ enum: MERGE_DROP_REASONS, description: 'Why the line was dropped.' })
  reason?: MergeDropReason;
}

export class MergeReportDto {
  @ApiProperty({ example: 2, description: 'Guest lines moved into the account cart (new or combined).' })
  mergedLines!: number;

  @ApiProperty({ type: [MergeAdjustmentDto], description: 'Lines whose combined quantity exceeded stock.' })
  clampedLines!: MergeAdjustmentDto[];

  @ApiProperty({ type: [MergeAdjustmentDto], description: 'Lines that could not be merged (unavailable, no stock, cart full).' })
  droppedLines!: MergeAdjustmentDto[];
}

export class MergeCartResponseDto {
  @ApiProperty({ type: CartDto })
  cart!: CartDto;

  @ApiProperty({ type: MergeReportDto })
  report!: MergeReportDto;
}
```

### `apps/backend/src/modules/cart/purchasable.ts`

```ts
import type { Prisma} from '@prisma/client';
import { VendorStatus } from '@prisma/client';

/**
 * The single definition of "this variant can be bought right now", shared by
 * the cart (to flag lines) and checkout (to refuse them). It mirrors the public
 * visibility rule of the catalogue (`catalog-visibility.ts`) at variant level:
 * the variant is active, its product is published and not blocked, its store is
 * APPROVED and its category is reachable in the active tree.
 */
export const purchasableVariantSelect = {
  id: true,
  sku: true,
  colorName: true,
  colorHex: true,
  size: true,
  guarantee: true,
  price: true,
  compareAtPrice: true,
  stockQuantity: true,
  reservedQuantity: true,
  isActive: true,
  product: {
    select: {
      id: true,
      slug: true,
      title: true,
      isPublished: true,
      isBlockedByAdmin: true,
      categoryId: true,
      category: { select: { defaultCommissionRate: true } },
      vendor: {
        select: {
          id: true,
          storeName: true,
          storeSlug: true,
          status: true,
          commissionRateOverride: true,
          shippingFeeOverride: true,
          freeShippingThreshold: true,
        },
      },
      media: {
        select: { url: true, thumbnailUrl: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        take: 1,
      },
    },
  },
} satisfies Prisma.ProductVariantSelect;

export type PurchasableVariant = Prisma.ProductVariantGetPayload<{ select: typeof purchasableVariantSelect }>;

export type UnavailableReason =
  | 'VARIANT_INACTIVE'
  | 'PRODUCT_UNPUBLISHED'
  | 'PRODUCT_BLOCKED'
  | 'STORE_UNAVAILABLE'
  | 'CATEGORY_UNAVAILABLE';

export const UNAVAILABLE_MESSAGES: Record<UnavailableReason, string> = {
  VARIANT_INACTIVE: 'This option is no longer offered by the store',
  PRODUCT_UNPUBLISHED: 'This product is not on sale at the moment',
  PRODUCT_BLOCKED: 'This product is not on sale at the moment',
  STORE_UNAVAILABLE: 'The store selling this product is not accepting orders',
  CATEGORY_UNAVAILABLE: 'This product is not on sale at the moment',
};

/** Why the variant cannot be bought, or `null` when it can. */
export function unavailableReason(variant: PurchasableVariant, visibleCategoryIds: ReadonlySet<string>): UnavailableReason | null {
  if (!variant.isActive) return 'VARIANT_INACTIVE';
  if (variant.product.isBlockedByAdmin) return 'PRODUCT_BLOCKED';
  if (!variant.product.isPublished) return 'PRODUCT_UNPUBLISHED';
  if (variant.product.vendor.status !== VendorStatus.APPROVED) return 'STORE_UNAVAILABLE';
  if (!visibleCategoryIds.has(variant.product.categoryId)) return 'CATEGORY_UNAVAILABLE';
  return null;
}

/** Units that can still be sold: on hand minus held by open checkouts. */
export function availableQuantity(variant: Pick<PurchasableVariant, 'stockQuantity' | 'reservedQuantity'>): number {
  return Math.max(0, variant.stockQuantity - variant.reservedQuantity);
}
```

### `apps/backend/src/modules/orders/admin-orders.controller.ts`

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { AdminOrderQueryDto, ForceSubOrderStatusDto } from './dto/order-input.dto';
import { AdminSubOrderTransitionDto, PaginatedAdminOrdersDto } from './dto/order-response.dto';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';

@ApiTags('admin-orders')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Staff only' })
@Controller('admin')
export class AdminOrdersController {
  constructor(
    private readonly queries: OrderQueriesService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get('orders')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({
    summary: 'All orders with global filters',
    description: 'Filter by payment status, package status, store, customer, number/mobile search and creation window.',
  })
  @ApiOkResponse({ type: PaginatedAdminOrdersDto })
  list(@Query() query: AdminOrderQueryDto): Promise<PaginatedAdminOrdersDto> {
    return this.queries.listForStaff(query);
  }

  @Patch('sub-orders/:id/force-status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Force a package to DELIVERED or REFUNDED (paid orders only)',
    description:
      'DELIVERED from PROCESSING or SHIPPED (e.g. carrier confirmation). REFUNDED from any non-refunded status; ' +
      'if the goods never shipped (PENDING_APPROVAL / PROCESSING) the stock is returned to inventory. ' +
      'The money movement of the refund is handled by the finance module, not here.',
  })
  @ApiOkResponse({ type: AdminSubOrderTransitionDto })
  @ApiBadRequestResponse({ description: 'Validation failed (status or reason)' })
  @ApiNotFoundResponse({ description: 'Unknown sub-order' })
  @ApiConflictResponse({ description: 'ORDER_NOT_PAID, INVALID_STATUS_TRANSITION or CONCURRENT_UPDATE' })
  async forceStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ForceSubOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminSubOrderTransitionDto> {
    const result = await this.lifecycle.staffForce(id, dto, { actorId: user.id, context });
    return {
      previousStatus: result.previousStatus,
      stockAction: result.stockAction,
      auditLogId: result.auditLogId,
      subOrder: await this.queries.subOrderForStaff(id),
    };
  }
}
```

### `apps/backend/src/modules/orders/checkout.controller.ts`

```ts
import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { CheckoutService } from './checkout.service';
import { CheckoutDto } from './dto/order-input.dto';
import { CheckoutResponseDto } from './dto/order-response.dto';

@ApiTags('orders')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only customers can place orders' })
@Controller('orders')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('checkout')
  @SkipAudit() // audited inside the order transaction (without the address PII)
  @ApiOperation({
    summary: 'Place an order from the cart (one package per store)',
    description:
      'Re-validates every cart line against live stock and prices, then — in one database transaction — creates the parent order ' +
      '(payment PENDING, payment method CASH_IPG), one sub-order per store (PENDING_APPROVAL) with its shipping fee, platform ' +
      'commission and vendor earnings, immutable item snapshots, reserves stock and empties the cart.\n\n' +
      '409 codes: `CART_EMPTY`; `CART_NOT_CHECKOUTABLE` (with `lines`: unavailable items or quantity above stock); ' +
      '`CART_PRICES_CHANGED` (with `changes`: the cart has been updated to the current prices — show them and retry).\n\n' +
      'Unpaid orders are cancelled automatically after `paymentExpiresAt` and their stock is released.',
  })
  @ApiCreatedResponse({ type: CheckoutResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({ description: 'Address not found (not one of the caller’s addresses)' })
  @ApiConflictResponse({ description: 'CART_EMPTY, CART_NOT_CHECKOUTABLE or CART_PRICES_CHANGED' })
  placeOrder(
    @Body() dto: CheckoutDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<CheckoutResponseDto> {
    return this.checkout.checkout(user.id, dto, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/orders/checkout.service.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, ParentOrderPaymentStatus, PaymentMethod, Prisma, SubOrderStatus } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { evaluateLine, cartLineSelect, type EvaluatedLine } from '../cart/cart-view';
import { CategoriesService } from '../categories/categories.service';
import { InventoryService } from '../products/inventory.service';
import { ShippingCalculatorService } from '../shipping/shipping-calculator.service';
import { quoteShipping, type ShippingPolicy } from '../shipping/shipping-fee';
import type { CheckoutDto } from './dto/order-input.dto';
import type { CheckoutResponseDto } from './dto/order-response.dto';
import { lockParentOrder, stockMovements, writeOrderAudit, type OrderActor } from './order-audit';
import { effectiveCommissionRate, groupInOrder, lineTotal, parentTotals, subOrderTotals } from './order-math';
import { addressSnapshot, customerSubOrderSelect, toCustomerSubOrder, variantDetailsSnapshot } from './order-views';

type Tx = Prisma.TransactionClient;

interface PriceChange {
  cartItemId: string;
  productVariantId: string;
  productTitle: string;
  previousUnitPrice: string;
  currentUnitPrice: string;
}

interface BlockingLine {
  cartItemId: string;
  productVariantId: string;
  productTitle: string;
  requestedQuantity: number;
  availableQuantity: number;
  issues: string[];
}

/**
 * Turns the caller's cart into one parent order with one package (sub-order)
 * per store.
 *
 * Price and availability are evaluated twice: once before the transaction (so
 * a changed price can be written back to the cart and reported, which a rolled
 * back transaction could not do) and once inside it, under row locks, which is
 * the authoritative check. Inside the transaction:
 *
 * 1. the cart row is locked (no concurrent edits or double checkout);
 * 2. the variant rows are locked in id order (no deadlocks) and re-read;
 * 3. amounts are computed from live prices, category/store commission rates and
 *    the shipping policy;
 * 4. parent order, packages, item snapshots and initial status history are
 *    inserted, stock is reserved and the cart is emptied.
 *
 * Any failure rolls everything back: no order without reservation and no
 * reservation without order.
 */
@Injectable()
export class CheckoutService {
  private readonly paymentTimeoutMinutes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
    private readonly shipping: ShippingCalculatorService,
    private readonly inventory: InventoryService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.paymentTimeoutMinutes = config.getOrThrow<number>('ORDER_PAYMENT_TIMEOUT_MINUTES');
  }

  async checkout(userId: string, dto: CheckoutDto, actor: OrderActor): Promise<CheckoutResponseDto> {
    const address = await this.prisma.address.findFirst({ where: { id: dto.addressId, userId } });
    if (!address) {
      throw new NotFoundException('Address not found');
    }
    const cart = await this.prisma.cart.findUnique({ where: { userId }, select: { id: true } });
    if (!cart) {
      throw conflictWith('CART_EMPTY', 'The cart is empty');
    }
    const [visibleIds, policy] = await Promise.all([this.categories.visibleCategoryIds(), this.shipping.loadPolicy()]);
    const visible = new Set(visibleIds);

    await this.precheck(cart.id, visible);

    const orderId = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT id FROM carts WHERE id = ${cart.id}::uuid FOR UPDATE`);
      const variantIds = (await tx.cartItem.findMany({ where: { cartId: cart.id }, select: { productVariantId: true } }))
        .map((row) => row.productVariantId)
        .sort();
      if (variantIds.length === 0) {
        throw conflictWith('CART_EMPTY', 'The cart is empty');
      }
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM product_variants WHERE id IN (${Prisma.join(variantIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`,
      );
      const rows = await tx.cartItem.findMany({
        where: { cartId: cart.id },
        select: cartLineSelect,
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const lines = rows.map((row) => evaluateLine(row, visible));
      assertCheckoutable(lines);

      return this.createOrder(tx, { userId, cartId: cart.id, lines, policy, dto, address: addressSnapshot(address), actor });
    });

    const created = await this.prisma.parentOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        paymentStatus: true,
        paymentMethod: true,
        totalItemsAmount: true,
        totalShippingFee: true,
        totalDiscountAmount: true,
        finalPayableAmount: true,
        paymentExpiresAt: true,
        subOrders: { select: customerSubOrderSelect, orderBy: { subOrderNumber: 'asc' } },
      },
    });
    return {
      parentOrderId: created.id,
      orderNumber: created.orderNumber,
      paymentStatus: created.paymentStatus,
      paymentMethod: created.paymentMethod,
      totalItemsAmount: created.totalItemsAmount.toFixed(2),
      totalShippingFee: created.totalShippingFee.toFixed(2),
      totalDiscountAmount: created.totalDiscountAmount.toFixed(2),
      finalPayableAmount: created.finalPayableAmount.toFixed(2),
      paymentExpiresAt: created.paymentExpiresAt,
      subOrders: created.subOrders.map(toCustomerSubOrder),
    };
  }

  /**
   * Non-locking pass. Unavailable lines stop checkout; changed prices are
   * written back to the cart (so the next attempt proceeds at the new price the
   * customer has now been shown) and reported with 409 CART_PRICES_CHANGED.
   */
  private async precheck(cartId: string, visible: ReadonlySet<string>): Promise<void> {
    const rows = await this.prisma.cartItem.findMany({ where: { cartId }, select: cartLineSelect });
    if (rows.length === 0) {
      throw conflictWith('CART_EMPTY', 'The cart is empty');
    }
    const lines = rows.map((row) => evaluateLine(row, visible));
    assertAvailable(lines);

    const changed = lines.filter((line) => line.priceChanged);
    if (changed.length === 0) {
      return;
    }
    await this.prisma.$transaction(
      changed.map((line) =>
        this.prisma.cartItem.update({ where: { id: line.row.id }, data: { unitPriceSnapshot: line.variant.price } }),
      ),
    );
    throw priceChangedError(changed);
  }

  private async createOrder(
    tx: Tx,
    input: {
      userId: string;
      cartId: string;
      lines: EvaluatedLine[];
      policy: ShippingPolicy;
      dto: CheckoutDto;
      address: ReturnType<typeof addressSnapshot>;
      actor: OrderActor;
    },
  ): Promise<string> {
    const [{ seq }] = await tx.$queryRaw<[{ seq: bigint }]>(Prisma.sql`SELECT nextval('parent_order_number_seq') AS seq`);
    const orderNumber = `SHP-${seq.toString()}`;

    const packages = groupInOrder(input.lines, (line) => line.variant.product.vendor.id).map((group, index) => {
      const vendor = group.items[0]!.variant.product.vendor;
      const priced = group.items.map((line) => ({
        line,
        unitPrice: line.variant.price,
        quantity: line.row.quantity,
        commissionRate: effectiveCommissionRate(vendor.commissionRateOverride, line.variant.product.category.defaultCommissionRate),
      }));
      const subtotal = priced.reduce((sum, item) => sum.add(lineTotal(item.unitPrice, item.quantity)), new Prisma.Decimal(0));
      const shipping = quoteShipping(subtotal, vendor, input.policy);
      return {
        vendor,
        subOrderNumber: `${orderNumber}-${index + 1}`,
        priced,
        totals: subOrderTotals(priced, shipping.fee),
      };
    });
    const totals = parentTotals(packages.map((pkg) => pkg.totals));
    const paymentExpiresAt = new Date(Date.now() + this.paymentTimeoutMinutes * 60_000);

    const order = await tx.parentOrder.create({
      data: {
        orderNumber,
        userId: input.userId,
        shippingAddressSnapshot: input.address as unknown as Prisma.InputJsonValue,
        ...totals,
        paymentMethod: PaymentMethod.CASH_IPG,
        paymentStatus: ParentOrderPaymentStatus.PENDING,
        customerNote: input.dto.customerNote ?? null,
        paymentExpiresAt,
        subOrders: {
          create: packages.map((pkg) => ({
            vendorId: pkg.vendor.id,
            subOrderNumber: pkg.subOrderNumber,
            ...pkg.totals,
            status: SubOrderStatus.PENDING_APPROVAL,
            items: {
              create: pkg.priced.map(({ line, unitPrice, quantity, commissionRate }) => ({
                productVariantId: line.variant.id,
                productTitleSnapshot: line.variant.product.title,
                vendorStoreNameSnapshot: pkg.vendor.storeName,
                skuSnapshot: line.variant.sku,
                variantDetailsSnapshot: variantDetailsSnapshot(line.variant) as unknown as Prisma.InputJsonValue,
                unitPriceSnapshot: unitPrice,
                commissionRateSnapshot: commissionRate,
                quantity,
                totalLineAmount: lineTotal(unitPrice, quantity),
              })),
            },
            statusHistory: {
              create: { fromStatus: null, toStatus: SubOrderStatus.PENDING_APPROVAL, actorUserId: input.userId, actorRole: 'CUSTOMER' },
            },
          })),
        },
      },
      select: { id: true },
    });

    // Rows are already locked; the guarded UPDATEs cannot fail on stock here,
    // but they stay the source of truth if they ever did (the transaction aborts).
    await lockParentOrder(tx, order.id);
    for (const move of stockMovements(input.lines.map((line) => ({ productVariantId: line.variant.id, quantity: line.row.quantity })))) {
      await this.inventory.reserve(move.variantId, move.quantity, tx);
    }

    await tx.cartItem.deleteMany({ where: { cartId: input.cartId } });
    await tx.cart.update({ where: { id: input.cartId }, data: { updatedAt: new Date() } });

    await writeOrderAudit(tx, input.actor, {
      action: AuditAction.CREATE,
      entityName: 'ParentOrder',
      entityId: order.id,
      newValue: {
        orderNumber,
        paymentStatus: ParentOrderPaymentStatus.PENDING,
        totalItemsAmount: totals.totalItemsAmount.toFixed(2),
        totalShippingFee: totals.totalShippingFee.toFixed(2),
        finalPayableAmount: totals.finalPayableAmount.toFixed(2),
        paymentExpiresAt: paymentExpiresAt.toISOString(),
        subOrders: packages.map((pkg) => ({
          subOrderNumber: pkg.subOrderNumber,
          vendorId: pkg.vendor.id,
          itemsSubtotal: pkg.totals.itemsSubtotal.toFixed(2),
          shippingFee: pkg.totals.shippingFee.toFixed(2),
          platformCommissionAmount: pkg.totals.platformCommissionAmount.toFixed(2),
          lines: pkg.priced.map((item) => ({ productVariantId: item.line.variant.id, quantity: item.quantity })),
        })),
      },
    });
    return order.id;
  }
}

function describeBlocking(line: EvaluatedLine): BlockingLine {
  return {
    cartItemId: line.row.id,
    productVariantId: line.variant.id,
    productTitle: line.variant.product.title,
    requestedQuantity: line.row.quantity,
    availableQuantity: line.available,
    issues: line.issues.filter((issue) => issue.code !== 'PRICE_CHANGED').map((issue) => issue.code),
  };
}

const isBlocking = (line: EvaluatedLine): boolean => !line.isPurchasable || line.available < line.row.quantity;

function assertAvailable(lines: EvaluatedLine[]): void {
  const blocking = lines.filter(isBlocking);
  if (blocking.length > 0) {
    throw conflictWith(
      'CART_NOT_CHECKOUTABLE',
      'Some items in the cart are unavailable or exceed the available stock; update the cart and try again',
      { lines: blocking.map(describeBlocking) },
    );
  }
}

function priceChangedError(changed: EvaluatedLine[]): ReturnType<typeof conflictWith> {
  const changes: PriceChange[] = changed.map((line) => ({
    cartItemId: line.row.id,
    productVariantId: line.variant.id,
    productTitle: line.variant.product.title,
    previousUnitPrice: line.row.unitPriceSnapshot.toFixed(2),
    currentUnitPrice: line.variant.price.toFixed(2),
  }));
  return conflictWith(
    'CART_PRICES_CHANGED',
    'Prices of some items have changed; the cart now shows the current prices. Review it and check out again',
    { changes },
  );
}

/** Authoritative check under locks: availability and unchanged prices. */
function assertCheckoutable(lines: EvaluatedLine[]): void {
  assertAvailable(lines);
  const changed = lines.filter((line) => line.priceChanged);
  if (changed.length > 0) {
    // Changed between the pre-check and the lock; the transaction rolls back and
    // the next attempt's pre-check refreshes the cart.
    throw priceChangedError(changed);
  }
}
```

### `apps/backend/src/modules/orders/customer-orders.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { CancelOrderDto, CustomerOrderQueryDto } from './dto/order-input.dto';
import { CancelOrderResponseDto, CustomerOrderDetailDto, PaginatedCustomerOrdersDto } from './dto/order-response.dto';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';

const UUID = new ParseUUIDPipe({ version: '4' });

@ApiTags('customer-orders')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Customers only' })
@Controller('customer/orders')
export class CustomerOrdersController {
  constructor(
    private readonly queries: OrderQueriesService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My orders, newest first, with a per-store package breakdown' })
  @ApiOkResponse({ type: PaginatedCustomerOrdersDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: CustomerOrderQueryDto): Promise<PaginatedCustomerOrdersDto> {
    return this.queries.listForCustomer(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Order detail: packages, items, tracking codes and timeline' })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiNotFoundResponse({ description: 'Unknown order or not the caller’s' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', UUID) id: string): Promise<CustomerOrderDetailDto> {
    return this.queries.detailForCustomer(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Cancel an unpaid order',
    description: 'Only while payment is PENDING. All packages become CANCELLED and the reserved stock is released. Paid orders are cancelled by the store or support.',
  })
  @ApiOkResponse({ type: CancelOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Unknown order or not the caller’s' })
  @ApiConflictResponse({ description: 'ORDER_NOT_CANCELLABLE (already paid, cancelled or failed)' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UUID) id: string,
    @Body() dto: CancelOrderDto,
    @ClientContext() context: RequestContext,
  ): Promise<CancelOrderResponseDto> {
    const auditLogId = await this.lifecycle.cancelByCustomer(user.id, id, dto.reason, { actorId: user.id, context });
    return { ...(await this.queries.detailForCustomer(user.id, id)), auditLogId };
  }
}
```

### `apps/backend/src/modules/orders/dto/order-input.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, SubOrderStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Length, Matches, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { STAFF_FORCE_STATUSES, VENDOR_TARGET_STATUSES, type StaffForceStatus, type VendorTargetStatus } from '../sub-order-state-machine';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const trimToUndefined = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? (value.trim() === '' ? undefined : value.trim()) : value;

export class CheckoutDto {
  @ApiProperty({ format: 'uuid', description: 'One of the caller’s saved addresses; it is copied into the order.' })
  @IsUUID('4')
  addressId!: string;

  @ApiPropertyOptional({ maxLength: 500, example: 'لطفاً قبل از ارسال تماس بگیرید' })
  @IsOptionalNonNullable()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(500)
  customerNote?: string;
}

export class CancelOrderDto {
  @ApiPropertyOptional({ maxLength: 500, example: 'از خرید منصرف شدم' })
  @IsOptionalNonNullable()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class VendorUpdateSubOrderStatusDto {
  @ApiProperty({ enum: VENDOR_TARGET_STATUSES })
  @IsIn(VENDOR_TARGET_STATUSES)
  status!: VendorTargetStatus;

  @ApiPropertyOptional({ description: 'Required for SHIPPED.', maxLength: 40, example: '123456789012345678901234' })
  @ValidateIf((dto: VendorUpdateSubOrderStatusDto) => dto.status === SubOrderStatus.SHIPPED || dto.trackingCode !== undefined)
  @Transform(trim)
  @IsString()
  @Length(4, 40)
  @Matches(/^[A-Za-z0-9-]+$/, { message: 'trackingCode may contain only latin letters, digits and dashes' })
  trackingCode?: string;

  @ApiPropertyOptional({ description: 'Required for SHIPPED.', maxLength: 80, example: 'پست پیشتاز' })
  @ValidateIf((dto: VendorUpdateSubOrderStatusDto) => dto.status === SubOrderStatus.SHIPPED || dto.shippingCarrier !== undefined)
  @Transform(trim)
  @IsString()
  @Length(2, 80)
  shippingCarrier?: string;

  @ApiPropertyOptional({ description: 'Required for CANCELLED; shown to the customer.', maxLength: 500 })
  @ValidateIf((dto: VendorUpdateSubOrderStatusDto) => dto.status === SubOrderStatus.CANCELLED || dto.reason !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason?: string;
}

export class ForceSubOrderStatusDto {
  @ApiProperty({ enum: STAFF_FORCE_STATUSES })
  @IsIn(STAFF_FORCE_STATUSES)
  status!: StaffForceStatus;

  @ApiProperty({ minLength: 5, maxLength: 500, description: 'Why staff overrode the normal flow (kept in history and audit).' })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class CustomerOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ParentOrderPaymentStatus })
  @IsOptional()
  @IsIn(Object.values(ParentOrderPaymentStatus))
  paymentStatus?: ParentOrderPaymentStatus;
}

export class VendorOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SubOrderStatus })
  @IsOptional()
  @IsIn(Object.values(SubOrderStatus))
  status?: SubOrderStatus;

  @ApiPropertyOptional({ description: 'Order or package number, or its beginning', example: 'SHP-100000001' })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(24)
  search?: string;
}

export class AdminOrderQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ParentOrderPaymentStatus })
  @IsOptional()
  @IsIn(Object.values(ParentOrderPaymentStatus))
  paymentStatus?: ParentOrderPaymentStatus;

  @ApiPropertyOptional({ enum: SubOrderStatus, description: 'Orders having at least one package in this status' })
  @IsOptional()
  @IsIn(Object.values(SubOrderStatus))
  subOrderStatus?: SubOrderStatus;

  @ApiPropertyOptional({ format: 'uuid', description: 'Orders containing a package of this store' })
  @IsOptional()
  @IsUUID('4')
  vendorId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  customerId?: string;

  @ApiPropertyOptional({ description: 'Order/package number prefix or customer mobile (+98… or 09…)', example: 'SHP-1000' })
  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(24)
  search?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Placed at or after' })
  @IsOptional()
  @IsDateString()
  createdFrom?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Placed before' })
  @IsOptional()
  @IsDateString()
  createdTo?: string;
}
```

### `apps/backend/src/modules/orders/dto/order-response.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, PaymentMethod, SubOrderStatus } from '@prisma/client';

const MONEY = { type: String, example: '1250000.00', description: 'Toman, 2 decimals, as a string.' } as const;

export class AddressSnapshotDto {
  @ApiProperty({ example: 'تهران' }) province!: string;
  @ApiProperty({ example: 'تهران' }) city!: string;
  @ApiProperty({ example: 'خیابان ولیعصر، کوچه نگار' }) postalAddress!: string;
  @ApiProperty({ example: '1969833111' }) postalCode!: string;
  @ApiProperty({ nullable: true, type: String }) buildingNumber!: string | null;
  @ApiProperty({ nullable: true, type: String }) unitNumber!: string | null;
  @ApiProperty({ example: 'مریم احمدی' }) recipientName!: string;
  @ApiProperty({ example: '+989121234567' }) recipientMobile!: string;
}

export class VariantDetailsDto {
  @ApiProperty({ nullable: true, type: String }) colorName!: string | null;
  @ApiProperty({ nullable: true, type: String }) colorHex!: string | null;
  @ApiProperty({ nullable: true, type: String }) size!: string | null;
  @ApiProperty({ nullable: true, type: String }) guarantee!: string | null;
}

/** An order line exactly as it was bought (snapshot; later catalogue edits do not change it). */
export class OrderItemDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Null if the variant was later deleted.' })
  productVariantId!: string | null;
  @ApiProperty() productTitle!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() vendorStoreName!: string;
  @ApiProperty({ type: VariantDetailsDto }) variantDetails!: VariantDetailsDto;
  @ApiProperty(MONEY) unitPrice!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty(MONEY) discount!: string;
  @ApiProperty(MONEY) lineTotal!: string;
}

export class VendorOrderItemDto extends OrderItemDto {
  @ApiProperty({ example: '8.50', description: 'Commission rate (%) frozen at checkout.' }) commissionRate!: string;
  @ApiProperty(MONEY) commissionAmount!: string;
}

export class StoreRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty() storeSlug!: string;
}

export class TimelineEventDto {
  @ApiProperty() at!: Date;
  @ApiProperty({ enum: ['ORDER_PLACED', 'PAYMENT_CONFIRMED', 'ORDER_CANCELLED', 'PAYMENT_FAILED', 'SUB_ORDER_STATUS'] })
  type!: 'ORDER_PLACED' | 'PAYMENT_CONFIRMED' | 'ORDER_CANCELLED' | 'PAYMENT_FAILED' | 'SUB_ORDER_STATUS';
  @ApiProperty({ nullable: true, type: String }) subOrderNumber!: string | null;
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) fromStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) toStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: ['CUSTOMER', 'VENDOR', 'STAFF', 'SYSTEM'] }) actor!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}

export class CustomerSubOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SHP-100000001-1' }) subOrderNumber!: string;
  @ApiProperty({ type: StoreRefDto }) store!: StoreRefDto;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty({ ...MONEY, description: 'itemsSubtotal + shippingFee' }) total!: string;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierName!: string | null;
  @ApiProperty({ nullable: true, type: Date }) shippedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) deliveredAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ type: [OrderItemDto] }) items!: OrderItemDto[];
}

class OrderMoneyDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'SHP-100000001' }) orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) paymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty(MONEY) totalItemsAmount!: string;
  @ApiProperty(MONEY) totalShippingFee!: string;
  @ApiProperty(MONEY) totalDiscountAmount!: string;
  @ApiProperty(MONEY) finalPayableAmount!: string;
  @ApiProperty({ nullable: true, type: Date, description: 'Unpaid orders are cancelled automatically after this instant.' })
  paymentExpiresAt!: Date | null;
  @ApiProperty() createdAt!: Date;
}

export class CustomerSubOrderSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() subOrderNumber!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
}

export class CustomerOrderSummaryDto extends OrderMoneyDto {
  @ApiProperty({ type: [CustomerSubOrderSummaryDto] }) subOrders!: CustomerSubOrderSummaryDto[];
}

export class PaginatedCustomerOrdersDto {
  @ApiProperty({ type: [CustomerOrderSummaryDto] }) items!: CustomerOrderSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class CustomerOrderDetailDto extends OrderMoneyDto {
  @ApiProperty({ type: AddressSnapshotDto }) shippingAddress!: AddressSnapshotDto;
  @ApiProperty({ nullable: true, type: String }) customerNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ description: 'True while the order is unpaid and can still be cancelled by the customer.' })
  canCancel!: boolean;
  @ApiProperty({ type: [CustomerSubOrderDto] }) subOrders!: CustomerSubOrderDto[];
  @ApiProperty({ type: [TimelineEventDto], description: 'Oldest first.' }) timeline!: TimelineEventDto[];
}

export class CheckoutResponseDto {
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000001' }) orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus, example: ParentOrderPaymentStatus.PENDING }) paymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty(MONEY) totalItemsAmount!: string;
  @ApiProperty(MONEY) totalShippingFee!: string;
  @ApiProperty(MONEY) totalDiscountAmount!: string;
  @ApiProperty(MONEY) finalPayableAmount!: string;
  @ApiProperty({ nullable: true, type: Date }) paymentExpiresAt!: Date | null;
  @ApiProperty({ type: [CustomerSubOrderDto] }) subOrders!: CustomerSubOrderDto[];
}

export class StatusHistoryDto {
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) fromStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: SubOrderStatus }) toStatus!: SubOrderStatus;
  @ApiProperty({ example: 'VENDOR' }) actorRole!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() at!: Date;
}

export class VendorSubOrderSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() subOrderNumber!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty(MONEY) platformCommissionAmount!: string;
  @ApiProperty(MONEY) vendorEarningsAmount!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierName!: string | null;
  @ApiProperty({ description: 'When the order was placed' }) placedAt!: Date;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ enum: SubOrderStatus, isArray: true, description: 'Statuses this vendor may move the package to now.' })
  allowedTransitions!: SubOrderStatus[];
}

export class PaginatedVendorSubOrdersDto {
  @ApiProperty({ type: [VendorSubOrderSummaryDto] }) items!: VendorSubOrderSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class VendorSubOrderDetailDto extends VendorSubOrderSummaryDto {
  @ApiProperty({ type: AddressSnapshotDto, description: 'Where to ship this package.' }) shippingAddress!: AddressSnapshotDto;
  @ApiProperty({ nullable: true, type: String }) customerNote!: string | null;
  @ApiProperty({ nullable: true, type: Date }) shippedAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) deliveredAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ nullable: true, type: String }) cancellationReason!: string | null;
  @ApiProperty({ type: [VendorOrderItemDto] }) items!: VendorOrderItemDto[];
  @ApiProperty({ type: [StatusHistoryDto] }) history!: StatusHistoryDto[];
}

export class SubOrderTransitionResultDto {
  @ApiProperty({ enum: SubOrderStatus }) previousStatus!: SubOrderStatus;
  @ApiProperty({ enum: ['RESTOCKED', 'NONE'], description: 'What happened to the stock of the package lines.' })
  stockAction!: 'RESTOCKED' | 'NONE';
  @ApiProperty({ format: 'uuid' }) auditLogId!: string;
}

export class VendorSubOrderTransitionDto extends SubOrderTransitionResultDto {
  @ApiProperty({ type: VendorSubOrderDetailDto }) subOrder!: VendorSubOrderDetailDto;
}

export class CustomerRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() mobile!: string;
}

export class AdminSubOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() subOrderNumber!: string;
  @ApiProperty({ type: StoreRefDto }) store!: StoreRefDto;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
  @ApiProperty(MONEY) platformCommissionAmount!: string;
  @ApiProperty(MONEY) vendorEarningsAmount!: string;
  @ApiProperty() itemCount!: number;
  @ApiProperty({ nullable: true, type: String }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) carrierName!: string | null;
  @ApiProperty() updatedAt!: Date;
}

export class AdminOrderDto extends OrderMoneyDto {
  @ApiProperty({ type: CustomerRefDto }) customer!: CustomerRefDto;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ type: [AdminSubOrderDto] }) subOrders!: AdminSubOrderDto[];
}

export class PaginatedAdminOrdersDto {
  @ApiProperty({ type: [AdminOrderDto] }) items!: AdminOrderDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class AdminSubOrderTransitionDto extends SubOrderTransitionResultDto {
  @ApiProperty({ type: AdminSubOrderDto }) subOrder!: AdminSubOrderDto;
}

export class CancelOrderResponseDto extends CustomerOrderDetailDto {
  @ApiPropertyOptional({ format: 'uuid' }) auditLogId?: string;
}
```

### `apps/backend/src/modules/orders/order-audit.ts`

```ts
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
    entityName: 'ParentOrder' | 'SubOrder';
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
```

### `apps/backend/src/modules/orders/order-expiry.scheduler.ts`

```ts
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { OrderLifecycleService } from './order-lifecycle.service';

const LOCK_KEY = 'lock:orders:expiry-sweep';

/**
 * Periodically cancels unpaid orders whose payment window passed and releases
 * their stock. Several API instances may run this timer; a Redis `SET NX PX`
 * lock lets only one of them sweep at a time (correctness does not depend on
 * it — each order is re-checked under a row lock — it only avoids duplicate work).
 *
 * `ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=0` disables the timer (e.g. when a
 * dedicated worker takes over).
 */
@Injectable()
export class OrderExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrderExpiryScheduler.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly lifecycle: OrderLifecycleService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS') * 1000;
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('Unpaid-order expiry sweep is disabled (ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=0)');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref(); // never keeps the process alive on its own
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running?.catch(() => 0);
  }

  /** One sweep; returns the number of orders expired (0 when another instance holds the lock). */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    const owner = randomUUID();
    this.running = (async (): Promise<number> => {
      try {
        const acquired = await this.redis.client.set(LOCK_KEY, owner, 'PX', Math.max(this.intervalMs, 30_000), 'NX');
        if (acquired !== 'OK') return 0;
        try {
          const expired = await this.lifecycle.expireOverdue();
          if (expired > 0) this.logger.log(`Expired ${expired} unpaid order(s) and released their stock`);
          return expired;
        } finally {
          // Release only our own lock.
          await this.redis.client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            LOCK_KEY,
            owner,
          );
        }
      } catch (error) {
        this.logger.error(`Expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
```

### `apps/backend/src/modules/orders/order-lifecycle.service.ts`

```ts
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction, ParentOrderPaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { InventoryService } from '../products/inventory.service';
import type { ForceSubOrderStatusDto, VendorUpdateSubOrderStatusDto } from './dto/order-input.dto';
import { lockParentOrder, stockMovements, SYSTEM_ACTOR, writeOrderAudit, type OrderActor } from './order-audit';
import type { ActorRole } from './order-views';
import { canStaffForce, canVendorTransition, paidStockEffect, vendorTransitionsFrom } from './sub-order-state-machine';

type Tx = Prisma.TransactionClient;

type UnpaidOutcome = 'CUSTOMER_CANCEL' | 'PAYMENT_FAILED' | 'PAYMENT_EXPIRED';

const UNPAID_OUTCOME: Record<UnpaidOutcome, { status: ParentOrderPaymentStatus; role: ActorRole; defaultReason: string }> = {
  CUSTOMER_CANCEL: { status: ParentOrderPaymentStatus.CANCELLED, role: 'CUSTOMER', defaultReason: 'Cancelled by the customer before payment' },
  PAYMENT_FAILED: { status: ParentOrderPaymentStatus.FAILED, role: 'SYSTEM', defaultReason: 'Payment failed' },
  PAYMENT_EXPIRED: { status: ParentOrderPaymentStatus.CANCELLED, role: 'SYSTEM', defaultReason: 'Payment was not completed in time' },
};

export interface TransitionResult {
  subOrderId: string;
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  auditLogId: string;
}

/**
 * Every state change of an order after checkout. All operations lock the parent
 * order row first, so a payment callback, a customer cancel, the expiry sweeper
 * and vendor/staff actions on the same order are strictly serialised, and the
 * state read after the lock is the state acted upon.
 *
 * Stock rules (reservation made at checkout):
 * - unpaid order cancelled / payment failed / payment expired → release reservation;
 * - payment confirmed → commit reservation (stock and reserved both drop);
 * - paid package cancelled by the vendor or refunded by staff before shipping → restock.
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
  ) {}

  // ─── unpaid orders ────────────────────────────────────────────────────────

  /** Customer cancels an order that has not been paid yet. */
  async cancelByCustomer(userId: string, parentOrderId: string, reason: string | undefined, actor: OrderActor): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockParentOrder(tx, parentOrderId);
      const order = locked
        ? await tx.parentOrder.findFirst({ where: { id: parentOrderId, userId }, select: { id: true, paymentStatus: true } })
        : null;
      if (!order) {
        throw new NotFoundException('Order not found');
      }
      if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
        throw conflictWith(
          'ORDER_NOT_CANCELLABLE',
          order.paymentStatus === ParentOrderPaymentStatus.PAID
            ? 'This order is already paid; ask the store or support to cancel it'
            : `This order is already ${order.paymentStatus}`,
          { paymentStatus: order.paymentStatus },
        );
      }
      return this.closeUnpaid(tx, order.id, 'CUSTOMER_CANCEL', reason, actor);
    });
  }

  /** Payment gateway reported failure for an unpaid order. Idempotent: returns `false` if not PENDING. */
  async markPaymentFailed(parentOrderId: string, reason?: string, actor: OrderActor = SYSTEM_ACTOR): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockPending(tx, parentOrderId);
      if (!order) return false;
      await this.closeUnpaid(tx, order.id, 'PAYMENT_FAILED', reason, actor);
      return true;
    });
  }

  /**
   * Payment confirmed: the order becomes PAID and each reservation is converted
   * into a sale. Called by the payment module once a verified gateway callback
   * arrives (no HTTP endpoint exposes it). Idempotent: returns `false` if the
   * order is not PENDING (already paid, or cancelled/expired first).
   */
  async markPaid(parentOrderId: string, actor: OrderActor = SYSTEM_ACTOR): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const order = await this.lockPending(tx, parentOrderId);
      if (!order) return false;
      const items = await tx.orderItem.findMany({
        where: { subOrder: { parentOrderId } },
        select: { productVariantId: true, quantity: true },
      });
      for (const move of stockMovements(items)) {
        await this.inventory.commitReservation(move.variantId, move.quantity, tx);
      }
      const paidAt = new Date();
      await tx.parentOrder.update({
        where: { id: parentOrderId },
        data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.PAYMENT_CAPTURE,
        entityName: 'ParentOrder',
        entityId: parentOrderId,
        oldValue: { paymentStatus: ParentOrderPaymentStatus.PENDING },
        newValue: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt: paidAt.toISOString() },
      });
      return true;
    });
  }

  /**
   * Cancels unpaid orders whose payment window has passed and releases their
   * stock. Each order is handled in its own transaction (one bad row cannot
   * block the rest) and re-checked under lock (a payment that landed meanwhile wins).
   */
  async expireOverdue(now: Date = new Date(), batchSize = 100): Promise<number> {
    const due = await this.prisma.parentOrder.findMany({
      where: { paymentStatus: ParentOrderPaymentStatus.PENDING, paymentExpiresAt: { lte: now } },
      select: { id: true },
      orderBy: { paymentExpiresAt: 'asc' },
      take: batchSize,
    });
    let expired = 0;
    for (const { id } of due) {
      try {
        const done = await this.prisma.$transaction(async (tx) => {
          const order = await this.lockPending(tx, id);
          if (!order || order.paymentExpiresAt === null || order.paymentExpiresAt > now) return false;
          await this.closeUnpaid(tx, id, 'PAYMENT_EXPIRED', undefined, SYSTEM_ACTOR);
          return true;
        });
        if (done) expired += 1;
      } catch (error) {
        this.logger.error(`Could not expire order ${id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return expired;
  }

  // ─── paid orders: vendor and staff ────────────────────────────────────────

  async vendorTransition(userId: string, subOrderId: string, dto: VendorUpdateSubOrderStatusDto, actor: OrderActor): Promise<TransitionResult> {
    const store = await this.prisma.vendor.findUnique({ where: { userId }, select: { id: true, status: true } });
    if (!store) {
      throw new ForbiddenException('This account has no store');
    }
    // A suspended store still has to fulfil or cancel what it already sold.
    if (store.status !== VendorStatus.APPROVED && store.status !== VendorStatus.SUSPENDED) {
      throw new ForbiddenException(`The store is ${store.status}; it has no orders to manage`);
    }
    const parentOrderId = await this.parentOf(subOrderId, (sub) => sub.vendorId === store.id);

    return this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, parentOrderId);
      const sub = await this.loadForTransition(tx, subOrderId);
      if (!sub || sub.vendorId !== store.id || sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID) {
        throw new NotFoundException('Order not found');
      }
      if (!canVendorTransition(sub.status, dto.status)) {
        throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be moved to ${dto.status}`, {
          currentStatus: sub.status,
          allowedTransitions: vendorTransitionsFrom(sub.status),
        });
      }
      const now = new Date();
      const data: Prisma.SubOrderUpdateManyMutationInput =
        dto.status === SubOrderStatus.SHIPPED
          ? { status: dto.status, trackingCode: dto.trackingCode!, carrierName: dto.shippingCarrier!, shippedAt: now }
          : dto.status === SubOrderStatus.CANCELLED
            ? { status: dto.status, cancelledAt: now, cancellationReason: dto.reason! }
            : { status: dto.status };
      const note =
        dto.status === SubOrderStatus.SHIPPED ? `${dto.shippingCarrier!}: ${dto.trackingCode!}` : (dto.reason ?? null);
      return this.applyTransition(tx, sub, dto.status, data, { role: 'VENDOR', note, actor });
    });
  }

  async staffForce(subOrderId: string, dto: ForceSubOrderStatusDto, actor: OrderActor): Promise<TransitionResult> {
    const parentOrderId = await this.parentOf(subOrderId, () => true);
    return this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, parentOrderId);
      const sub = await this.loadForTransition(tx, subOrderId);
      if (!sub) {
        throw new NotFoundException('Sub-order not found');
      }
      if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID) {
        throw conflictWith('ORDER_NOT_PAID', 'Only packages of paid orders can be delivered or refunded', {
          paymentStatus: sub.parentOrder.paymentStatus,
        });
      }
      if (!canStaffForce(sub.status, dto.status)) {
        throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be forced to ${dto.status}`, {
          currentStatus: sub.status,
        });
      }
      const data: Prisma.SubOrderUpdateManyMutationInput =
        dto.status === SubOrderStatus.DELIVERED ? { status: dto.status, deliveredAt: new Date() } : { status: dto.status };
      return this.applyTransition(tx, sub, dto.status, data, { role: 'STAFF', note: dto.reason, actor });
    });
  }

  // ─── internals ────────────────────────────────────────────────────────────

  private async lockPending(tx: Tx, parentOrderId: string): Promise<{ id: string; paymentExpiresAt: Date | null } | null> {
    if (!(await lockParentOrder(tx, parentOrderId))) {
      return null;
    }
    return tx.parentOrder.findFirst({
      where: { id: parentOrderId, paymentStatus: ParentOrderPaymentStatus.PENDING },
      select: { id: true, paymentExpiresAt: true },
    });
  }

  /** Unpaid order leaves the funnel: reservations released, every package CANCELLED. Parent row must be locked. */
  private async closeUnpaid(tx: Tx, parentOrderId: string, outcome: UnpaidOutcome, reason: string | undefined, actor: OrderActor): Promise<string> {
    const rule = UNPAID_OUTCOME[outcome];
    const note = reason ?? rule.defaultReason;
    const now = new Date();
    const subs = await tx.subOrder.findMany({
      where: { parentOrderId },
      select: { id: true, status: true, items: { select: { productVariantId: true, quantity: true } } },
    });
    for (const move of stockMovements(subs.flatMap((sub) => sub.items))) {
      await this.inventory.release(move.variantId, move.quantity, tx);
    }
    await tx.parentOrder.update({
      where: { id: parentOrderId },
      data: { paymentStatus: rule.status, cancelledAt: now, cancellationReason: note },
    });
    await tx.subOrder.updateMany({
      where: { parentOrderId },
      data: { status: SubOrderStatus.CANCELLED, cancelledAt: now, cancellationReason: note },
    });
    await tx.subOrderStatusHistory.createMany({
      data: subs.map((sub) => ({
        subOrderId: sub.id,
        fromStatus: sub.status,
        toStatus: SubOrderStatus.CANCELLED,
        actorUserId: actor.actorId,
        actorRole: rule.role,
        note,
      })),
    });
    return writeOrderAudit(tx, actor, {
      action: AuditAction.STATUS_CHANGE,
      entityName: 'ParentOrder',
      entityId: parentOrderId,
      oldValue: { paymentStatus: ParentOrderPaymentStatus.PENDING },
      newValue: {
        paymentStatus: rule.status,
        outcome,
        reason: note,
        releasedLines: subs.reduce((count, sub) => count + sub.items.length, 0),
      },
    });
  }

  /** Resolves the parent id before locking; unknown or foreign sub-orders are a 404 (no existence leak). */
  private async parentOf(subOrderId: string, visible: (sub: { vendorId: string }) => boolean): Promise<string> {
    const sub = await this.prisma.subOrder.findUnique({ where: { id: subOrderId }, select: { parentOrderId: true, vendorId: true } });
    if (!sub || !visible(sub)) {
      throw new NotFoundException('Order not found');
    }
    return sub.parentOrderId;
  }

  private loadForTransition(tx: Tx, subOrderId: string): Promise<TransitionRow | null> {
    return tx.subOrder.findUnique({ where: { id: subOrderId }, select: transitionSelect });
  }

  private async applyTransition(
    tx: Tx,
    sub: TransitionRow,
    target: SubOrderStatus,
    data: Prisma.SubOrderUpdateManyMutationInput,
    meta: { role: ActorRole; note: string | null; actor: OrderActor },
  ): Promise<TransitionResult> {
    // Guarded by the status read under the parent lock; the WHERE makes it explicit.
    const updated = await tx.subOrder.updateMany({ where: { id: sub.id, status: sub.status }, data });
    if (updated.count !== 1) {
      throw conflictWith('CONCURRENT_UPDATE', 'The package was changed by someone else; reload and try again');
    }
    const restock = paidStockEffect(sub.status, target) === 'RESTOCK';
    if (restock) {
      for (const move of stockMovements(sub.items)) {
        await this.inventory.adjustStock(move.variantId, move.quantity, tx);
      }
    }
    await tx.subOrderStatusHistory.create({
      data: { subOrderId: sub.id, fromStatus: sub.status, toStatus: target, actorUserId: meta.actor.actorId, actorRole: meta.role, note: meta.note },
    });
    const auditLogId = await writeOrderAudit(tx, meta.actor, {
      action: AuditAction.STATUS_CHANGE,
      entityName: 'SubOrder',
      entityId: sub.id,
      oldValue: { status: sub.status },
      newValue: {
        status: target,
        subOrderNumber: sub.subOrderNumber,
        actorRole: meta.role,
        note: meta.note,
        stockAction: restock ? 'RESTOCKED' : 'NONE',
        ...(restock ? { restockedLines: stockMovements(sub.items) } : {}),
      },
    });
    return { subOrderId: sub.id, previousStatus: sub.status, stockAction: restock ? 'RESTOCKED' : 'NONE', auditLogId };
  }
}

const transitionSelect = {
  id: true,
  vendorId: true,
  subOrderNumber: true,
  status: true,
  parentOrder: { select: { paymentStatus: true } },
  items: { select: { productVariantId: true, quantity: true } },
} satisfies Prisma.SubOrderSelect;

type TransitionRow = Prisma.SubOrderGetPayload<{ select: typeof transitionSelect }>;
```

### `apps/backend/src/modules/orders/order-math.spec.ts`

```ts
import { Prisma } from '@prisma/client';
import { effectiveCommissionRate, groupInOrder, lineCommission, parentTotals, subOrderTotals } from './order-math';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

describe('order math', () => {
  it('uses the store override before the category rate', () => {
    expect(effectiveCommissionRate(d('7.50'), d('12.00')).toFixed(2)).toBe('7.50');
    expect(effectiveCommissionRate(null, d('12.00')).toFixed(2)).toBe('12.00');
  });

  it('rounds each line commission half-up to 2 places', () => {
    expect(lineCommission(d('333.33'), d('12.5')).toFixed(2)).toBe('41.67'); // 41.66625
    expect(lineCommission(d('100.10'), d('5')).toFixed(2)).toBe('5.01'); // 5.005
  });

  it('keeps commission + earnings = subtotal exactly, with mixed category rates', () => {
    const totals = subOrderTotals(
      [
        { unitPrice: d('42500000'), quantity: 1, commissionRate: d('6.25') },
        { unitPrice: d('333.33'), quantity: 3, commissionRate: d('12.5') },
        { unitPrice: d('890000'), quantity: 2, commissionRate: d('9.75') },
      ],
      d('500000'),
    );
    expect(totals.itemsSubtotal.toFixed(2)).toBe('44280999.99');
    expect(totals.platformCommissionAmount.add(totals.vendorEarningsAmount).eq(totals.itemsSubtotal)).toBe(true);
    expect(totals.platformCommissionAmount.toFixed(2)).toBe('2829925.00'); // 2656250 + 125.00 + 173550
  });

  it('adds sub-orders up to the payable amount', () => {
    const a = subOrderTotals([{ unitPrice: d('1000000'), quantity: 2, commissionRate: d('10') }], d('500000'));
    const b = subOrderTotals([{ unitPrice: d('12000000'), quantity: 1, commissionRate: d('8') }], d('0'));
    const parent = parentTotals([a, b]);
    expect(parent.totalItemsAmount.toFixed(2)).toBe('14000000.00');
    expect(parent.totalShippingFee.toFixed(2)).toBe('500000.00');
    expect(parent.finalPayableAmount.toFixed(2)).toBe('14500000.00');
    expect(parentTotals([a, b], d('100000')).finalPayableAmount.toFixed(2)).toBe('14400000.00');
  });

  it('groups in first-seen order', () => {
    const groups = groupInOrder(['b1', 'a1', 'b2', 'c1', 'a2'], (value) => value[0]!);
    expect(groups.map((group) => group.key)).toEqual(['b', 'a', 'c']);
    expect(groups[0]!.items).toEqual(['b1', 'b2']);
  });
});
```

### `apps/backend/src/modules/orders/order-math.ts`

```ts
import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);
const HUNDRED = new Prisma.Decimal(100);

/**
 * Money arithmetic of the multi-vendor split. Pure and decimal-only: no floats
 * anywhere, and every rounding step is explicit (2 places, half-up) so the
 * identities the database also enforces hold by construction:
 *
 *   commission + earnings = itemsSubtotal          (per sub-order)
 *   Σ (itemsSubtotal + shippingFee) − discount = finalPayableAmount
 */

/** Vendor-specific rate wins; otherwise the category's default rate applies. */
export function effectiveCommissionRate(
  vendorOverride: Prisma.Decimal | null,
  categoryRate: Prisma.Decimal,
): Prisma.Decimal {
  return vendorOverride ?? categoryRate;
}

export function lineTotal(unitPrice: Prisma.Decimal, quantity: number, discount: Prisma.Decimal = ZERO): Prisma.Decimal {
  return unitPrice.mul(quantity).sub(discount);
}

/** Platform commission on one line, rounded to 2 places half-up. */
export function lineCommission(total: Prisma.Decimal, ratePercent: Prisma.Decimal): Prisma.Decimal {
  return total.mul(ratePercent).div(HUNDRED).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
}

export interface SplitLine {
  unitPrice: Prisma.Decimal;
  quantity: number;
  commissionRate: Prisma.Decimal;
}

export interface SubOrderTotals {
  itemsSubtotal: Prisma.Decimal;
  shippingFee: Prisma.Decimal;
  platformCommissionAmount: Prisma.Decimal;
  vendorEarningsAmount: Prisma.Decimal;
}

/**
 * Totals of one store package. Commission is summed from per-line commissions
 * (each line keeps its own category rate), and earnings are derived by
 * subtraction, so the two always add up to the subtotal exactly.
 */
export function subOrderTotals(lines: readonly SplitLine[], shippingFee: Prisma.Decimal): SubOrderTotals {
  let itemsSubtotal = ZERO;
  let commission = ZERO;
  for (const line of lines) {
    const total = lineTotal(line.unitPrice, line.quantity);
    itemsSubtotal = itemsSubtotal.add(total);
    commission = commission.add(lineCommission(total, line.commissionRate));
  }
  return {
    itemsSubtotal,
    shippingFee,
    platformCommissionAmount: commission,
    vendorEarningsAmount: itemsSubtotal.sub(commission),
  };
}

export interface ParentTotals {
  totalItemsAmount: Prisma.Decimal;
  totalShippingFee: Prisma.Decimal;
  totalDiscountAmount: Prisma.Decimal;
  finalPayableAmount: Prisma.Decimal;
}

export function parentTotals(subOrders: readonly SubOrderTotals[], discount: Prisma.Decimal = ZERO): ParentTotals {
  const totalItemsAmount = subOrders.reduce((sum, sub) => sum.add(sub.itemsSubtotal), ZERO);
  const totalShippingFee = subOrders.reduce((sum, sub) => sum.add(sub.shippingFee), ZERO);
  return {
    totalItemsAmount,
    totalShippingFee,
    totalDiscountAmount: discount,
    finalPayableAmount: totalItemsAmount.add(totalShippingFee).sub(discount),
  };
}

/** Groups items by a key, preserving first-seen order of keys and items. */
export function groupInOrder<T>(items: readonly T[], keyOf: (item: T) => string): Array<{ key: string; items: T[] }> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()].map(([key, grouped]) => ({ key, items: grouped }));
}
```

### `apps/backend/src/modules/orders/order-queries.service.ts`

```ts
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
```

### `apps/backend/src/modules/orders/order-views.ts`

```ts
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
```

### `apps/backend/src/modules/orders/orders.module.ts`

```ts
import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CategoriesModule } from '../categories/categories.module';
import { ProductsModule } from '../products/products.module';
import { ShippingModule } from '../shipping/shipping.module';
import { AdminOrdersController } from './admin-orders.controller';
import { CheckoutController } from './checkout.controller';
import { CheckoutService } from './checkout.service';
import { CustomerOrdersController } from './customer-orders.controller';
import { OrderExpiryScheduler } from './order-expiry.scheduler';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';
import { VendorOrdersController } from './vendor-orders.controller';

/**
 * Checkout, multi-vendor order splitting and the order lifecycle.
 * `OrderLifecycleService` is exported for the payment module (markPaid /
 * markPaymentFailed).
 */
@Module({
  imports: [CartModule, CategoriesModule, ProductsModule, ShippingModule],
  controllers: [CheckoutController, CustomerOrdersController, VendorOrdersController, AdminOrdersController],
  providers: [CheckoutService, OrderLifecycleService, OrderQueriesService, OrderExpiryScheduler],
  exports: [OrderLifecycleService],
})
export class OrdersModule {}
```

### `apps/backend/src/modules/orders/sub-order-state-machine.spec.ts`

```ts
import { SubOrderStatus as S } from '@prisma/client';
import { canStaffForce, canVendorTransition, paidStockEffect, vendorTransitionsFrom } from './sub-order-state-machine';

describe('sub-order state machine', () => {
  it('allows exactly the vendor transitions of the brief', () => {
    expect(canVendorTransition(S.PENDING_APPROVAL, S.PROCESSING)).toBe(true);
    expect(canVendorTransition(S.PROCESSING, S.SHIPPED)).toBe(true);
    expect(canVendorTransition(S.PENDING_APPROVAL, S.CANCELLED)).toBe(true);
    expect(canVendorTransition(S.PROCESSING, S.CANCELLED)).toBe(true);

    expect(canVendorTransition(S.PENDING_APPROVAL, S.SHIPPED)).toBe(false); // must process first
    expect(canVendorTransition(S.SHIPPED, S.CANCELLED)).toBe(false);
    expect(canVendorTransition(S.SHIPPED, S.DELIVERED)).toBe(false); // staff only
    expect(canVendorTransition(S.PROCESSING, S.REFUNDED)).toBe(false);
    expect(canVendorTransition(S.PROCESSING, S.PENDING_APPROVAL)).toBe(false); // no going back
  });

  it('treats DELIVERED, CANCELLED and REFUNDED as terminal for vendors', () => {
    for (const status of [S.SHIPPED, S.DELIVERED, S.CANCELLED, S.REFUNDED]) {
      expect(vendorTransitionsFrom(status)).toEqual([]);
    }
  });

  it('lets staff force DELIVERED only after the package is handed over or in preparation', () => {
    expect(canStaffForce(S.SHIPPED, S.DELIVERED)).toBe(true);
    expect(canStaffForce(S.PROCESSING, S.DELIVERED)).toBe(true);
    expect(canStaffForce(S.PENDING_APPROVAL, S.DELIVERED)).toBe(false);
    expect(canStaffForce(S.CANCELLED, S.DELIVERED)).toBe(false);
    expect(canStaffForce(S.DELIVERED, S.DELIVERED)).toBe(false);
  });

  it('lets staff refund anything not already refunded', () => {
    for (const from of [S.PENDING_APPROVAL, S.PROCESSING, S.SHIPPED, S.DELIVERED, S.CANCELLED]) {
      expect(canStaffForce(from, S.REFUNDED)).toBe(true);
    }
    expect(canStaffForce(S.REFUNDED, S.REFUNDED)).toBe(false);
  });

  it('restocks only goods that never left the store', () => {
    expect(paidStockEffect(S.PENDING_APPROVAL, S.CANCELLED)).toBe('RESTOCK');
    expect(paidStockEffect(S.PROCESSING, S.CANCELLED)).toBe('RESTOCK');
    expect(paidStockEffect(S.PROCESSING, S.REFUNDED)).toBe('RESTOCK');
    expect(paidStockEffect(S.SHIPPED, S.REFUNDED)).toBe('NONE');
    expect(paidStockEffect(S.DELIVERED, S.REFUNDED)).toBe('NONE');
    expect(paidStockEffect(S.CANCELLED, S.REFUNDED)).toBe('NONE'); // restocked when cancelled
    expect(paidStockEffect(S.PROCESSING, S.SHIPPED)).toBe('NONE');
  });
});
```

### `apps/backend/src/modules/orders/sub-order-state-machine.ts`

```ts
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
```

### `apps/backend/src/modules/orders/vendor-orders.controller.ts`

```ts
import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { VendorOrderQueryDto, VendorUpdateSubOrderStatusDto } from './dto/order-input.dto';
import { PaginatedVendorSubOrdersDto, VendorSubOrderDetailDto, VendorSubOrderTransitionDto } from './dto/order-response.dto';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';

const UUID = new ParseUUIDPipe({ version: '4' });

@ApiTags('vendor-orders')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Not a vendor, or the store is neither APPROVED nor SUSPENDED' })
@Controller('vendor/orders')
export class VendorOrdersController {
  constructor(
    private readonly queries: OrderQueriesService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My store’s packages (paid orders only), newest first',
    description: 'Only packages of PAID orders are listed: an unpaid order is not yet a commitment to ship.',
  })
  @ApiOkResponse({ type: PaginatedVendorSubOrdersDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: VendorOrderQueryDto): Promise<PaginatedVendorSubOrdersDto> {
    return this.queries.listForVendor(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Package detail with shipping address, items, commission and history' })
  @ApiOkResponse({ type: VendorSubOrderDetailDto })
  @ApiNotFoundResponse({ description: 'Unknown, unpaid or another store’s package' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', UUID) id: string): Promise<VendorSubOrderDetailDto> {
    return this.queries.detailForVendor(user.id, id);
  }

  @Patch(':id/status')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Move a package through fulfilment',
    description:
      'PENDING_APPROVAL → PROCESSING; PROCESSING → SHIPPED (trackingCode and shippingCarrier required); ' +
      'PENDING_APPROVAL or PROCESSING → CANCELLED (reason required; stock is returned to inventory and the package ' +
      'amount becomes due for refund to the customer).',
  })
  @ApiOkResponse({ type: VendorSubOrderTransitionDto })
  @ApiBadRequestResponse({ description: 'Validation failed (missing tracking code / carrier / reason)' })
  @ApiNotFoundResponse({ description: 'Unknown, unpaid or another store’s package' })
  @ApiConflictResponse({ description: 'INVALID_STATUS_TRANSITION (with allowedTransitions) or CONCURRENT_UPDATE' })
  async updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UUID) id: string,
    @Body() dto: VendorUpdateSubOrderStatusDto,
    @ClientContext() context: RequestContext,
  ): Promise<VendorSubOrderTransitionDto> {
    const result = await this.lifecycle.vendorTransition(user.id, id, dto, { actorId: user.id, context });
    return {
      previousStatus: result.previousStatus,
      stockAction: result.stockAction,
      auditLogId: result.auditLogId,
      subOrder: await this.queries.detailForVendor(user.id, id),
    };
  }
}
```

### `apps/backend/src/modules/shipping/shipping-calculator.service.ts`

```ts
import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import {
  quoteShipping,
  type ShippingPolicy,
  type ShippingQuote,
  type ShippingSettingSource,
  type VendorShippingSettings,
} from './shipping-fee';

/** `system_configs` keys that override the environment fallbacks. */
export const SHIPPING_CONFIG_KEYS = {
  defaultFeePerVendor: 'shipping.default_fee_per_vendor',
  freeThresholdPerVendor: 'shipping.free_threshold_per_vendor',
} as const;

const MONEY_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

/**
 * Resolves the shipping policy and prices store packages.
 *
 * Precedence, per value: store override → `system_configs` → environment. The
 * policy is read from the database on every call (two indexed key lookups), so
 * an operator's change applies to the next checkout without a restart and no
 * cache can serve a stale price.
 *
 * A `system_configs` value that is not a valid non-negative amount fails the
 * calculation (503) instead of silently falling back: charging a fee nobody
 * configured is worse than refusing to quote.
 */
@Injectable()
export class ShippingCalculatorService {
  private readonly logger = new Logger(ShippingCalculatorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<EnvironmentVariables, true>,
  ) {}

  async loadPolicy(executor: Pick<Prisma.TransactionClient, 'systemConfig'> = this.prisma): Promise<ShippingPolicy> {
    const rows = await executor.systemConfig.findMany({
      where: { key: { in: Object.values(SHIPPING_CONFIG_KEYS) } },
      select: { key: true, value: true },
    });
    const stored = new Map(rows.map((row) => [row.key, row.value]));

    const defaultFee = this.resolve(
      stored.get(SHIPPING_CONFIG_KEYS.defaultFeePerVendor),
      SHIPPING_CONFIG_KEYS.defaultFeePerVendor,
      this.config.get('SHIPPING_DEFAULT_FEE_PER_VENDOR', { infer: true }),
    );
    const freeThreshold = this.resolve(
      stored.get(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor),
      SHIPPING_CONFIG_KEYS.freeThresholdPerVendor,
      this.config.get('SHIPPING_FREE_THRESHOLD_PER_VENDOR', { infer: true }),
    );

    return {
      defaultFeePerVendor: defaultFee.value,
      freeThresholdPerVendor: freeThreshold.value,
      source: { defaultFeePerVendor: defaultFee.source, freeThresholdPerVendor: freeThreshold.source },
    };
  }

  quote(packageSubtotal: Prisma.Decimal, vendor: VendorShippingSettings, policy: ShippingPolicy): ShippingQuote {
    return quoteShipping(packageSubtotal, vendor, policy);
  }

  private resolve(
    stored: string | undefined,
    key: string,
    fallback: number,
  ): { value: Prisma.Decimal; source: ShippingSettingSource } {
    if (stored === undefined) {
      return { value: new Prisma.Decimal(fallback), source: 'env' };
    }
    const trimmed = stored.trim();
    if (!MONEY_PATTERN.test(trimmed)) {
      this.logger.error(`system_configs "${key}" holds an invalid amount (${JSON.stringify(stored)})`);
      throw new ServiceUnavailableException(
        'Shipping is temporarily unavailable: the shipping configuration is invalid',
      );
    }
    return { value: new Prisma.Decimal(trimmed), source: 'system_config' };
  }
}
```

### `apps/backend/src/modules/shipping/shipping-fee.spec.ts`

```ts
import { Prisma } from '@prisma/client';
import { quoteShipping, type VendorShippingSettings } from './shipping-fee';

const d = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);
const policy = { defaultFeePerVendor: d(500_000), freeThresholdPerVendor: d(10_000_000) };
const noOverrides: VendorShippingSettings = { shippingFeeOverride: null, freeShippingThreshold: null };

describe('quoteShipping (TM-approved per-store rule)', () => {
  it('charges the platform default below the platform threshold', () => {
    const quote = quoteShipping(d(9_999_999), noOverrides, policy);
    expect(quote.fee.toFixed(2)).toBe('500000.00');
    expect(quote.isFree).toBe(false);
    expect(quote.remainingForFreeShipping?.toFixed(2)).toBe('1.00');
  });

  it('is free exactly at and above the threshold', () => {
    expect(quoteShipping(d(10_000_000), noOverrides, policy).fee.toFixed(2)).toBe('0.00');
    expect(quoteShipping(d(25_000_000), noOverrides, policy).isFree).toBe(true);
  });

  it('never makes shipping free when the threshold is 0 (disabled)', () => {
    const quote = quoteShipping(d(999_999_999), noOverrides, { ...policy, freeThresholdPerVendor: d(0) });
    expect(quote.fee.toFixed(2)).toBe('500000.00');
    expect(quote.remainingForFreeShipping).toBeNull();
  });

  it('prefers the store fee override over the platform default', () => {
    const quote = quoteShipping(d(1_000), { shippingFeeOverride: d(350_000), freeShippingThreshold: null }, policy);
    expect(quote.fee.toFixed(2)).toBe('350000.00');
  });

  it('prefers the store threshold over the platform threshold, in both directions', () => {
    const lower = { shippingFeeOverride: null, freeShippingThreshold: d(2_000_000) };
    expect(quoteShipping(d(2_000_000), lower, policy).isFree).toBe(true);

    const disabled = { shippingFeeOverride: null, freeShippingThreshold: d(0) };
    expect(quoteShipping(d(50_000_000), disabled, policy).fee.toFixed(2)).toBe('500000.00');
  });

  it('supports stores that always ship for free (override 0)', () => {
    const quote = quoteShipping(d(1), { shippingFeeOverride: d(0), freeShippingThreshold: null }, policy);
    expect(quote.fee.toFixed(2)).toBe('0.00');
    expect(quote.isFree).toBe(true);
  });
});
```

### `apps/backend/src/modules/shipping/shipping-fee.ts`

```ts
import { Prisma } from '@prisma/client';

/** Platform-wide shipping settings in effect for one calculation. */
export interface ShippingPolicy {
  /** Fee charged per store package when shipping is not free. */
  defaultFeePerVendor: Prisma.Decimal;
  /** Package subtotal at which shipping becomes free; `0` = free shipping disabled. */
  freeThresholdPerVendor: Prisma.Decimal;
  /** Where each value came from, reported so operators can see what is active. */
  source: { defaultFeePerVendor: ShippingSettingSource; freeThresholdPerVendor: ShippingSettingSource };
}

export type ShippingSettingSource = 'system_config' | 'env';

/** A store's own settings; `null` means "use the platform policy". */
export interface VendorShippingSettings {
  shippingFeeOverride: Prisma.Decimal | null;
  freeShippingThreshold: Prisma.Decimal | null;
}

export interface ShippingQuote {
  fee: Prisma.Decimal;
  isFree: boolean;
  /** Threshold that applied to this package (`0` = none). */
  freeThreshold: Prisma.Decimal;
  /** Amount still missing to reach free shipping, `null` when not applicable. */
  remainingForFreeShipping: Prisma.Decimal | null;
}

const ZERO = new Prisma.Decimal(0);

/**
 * Shipping fee for one store package (the TM-approved rule):
 *
 * ```
 * freeThreshold = vendor.freeShippingThreshold ?? platform.freeThresholdPerVendor
 * fee = (freeThreshold > 0 && subtotal >= freeThreshold)
 *         ? 0
 *         : vendor.shippingFeeOverride ?? platform.defaultFeePerVendor
 * ```
 *
 * Pure: no I/O, no rounding surprises (all arithmetic is decimal).
 */
export function quoteShipping(
  packageSubtotal: Prisma.Decimal,
  vendor: VendorShippingSettings,
  policy: Pick<ShippingPolicy, 'defaultFeePerVendor' | 'freeThresholdPerVendor'>,
): ShippingQuote {
  const freeThreshold = vendor.freeShippingThreshold ?? policy.freeThresholdPerVendor;
  const thresholdActive = freeThreshold.gt(ZERO);

  if (thresholdActive && packageSubtotal.gte(freeThreshold)) {
    return { fee: ZERO, isFree: true, freeThreshold, remainingForFreeShipping: ZERO };
  }

  const fee = vendor.shippingFeeOverride ?? policy.defaultFeePerVendor;
  return {
    fee,
    isFree: fee.eq(ZERO),
    freeThreshold,
    remainingForFreeShipping: thresholdActive ? freeThreshold.sub(packageSubtotal) : null,
  };
}
```

### `apps/backend/src/modules/shipping/shipping.module.ts`

```ts
import { Module } from '@nestjs/common';
import { ShippingCalculatorService } from './shipping-calculator.service';

/** Shipping-fee policy and calculation, shared by the cart (estimates) and checkout (charges). */
@Module({
  providers: [ShippingCalculatorService],
  exports: [ShippingCalculatorService],
})
export class ShippingModule {}
```

### `apps/backend/src/common/http-errors.ts`

```ts
import { BadRequestException, ConflictException } from '@nestjs/common';

/**
 * Errors that a client must be able to act on programmatically (show "only 2
 * left", re-render changed prices) carry a stable `code` and structured details
 * next to the usual `statusCode` / `error` / `message` fields Nest produces.
 */
export function conflictWith(code: string, message: string, details: Record<string, unknown> = {}): ConflictException {
  return new ConflictException({ statusCode: 409, error: 'Conflict', code, message, ...details });
}

export function badRequestWith(code: string, message: string, details: Record<string, unknown> = {}): BadRequestException {
  return new BadRequestException({ statusCode: 400, error: 'Bad Request', code, message, ...details });
}
```

### `apps/backend/prisma/migrations/20260928090000_phase6_orders/migration.sql`

```sql
-- Phase 6: cart price snapshots, order lifecycle fields, status timeline,
-- per-store shipping settings, order-number sequence and money invariants.

-- AlterTable
-- Added nullable, back-filled from the live price, then made mandatory, so the
-- migration is safe on a database that already holds carts.
ALTER TABLE "cart_items" ADD COLUMN "unit_price_snapshot" DECIMAL(15,2);
UPDATE "cart_items" ci SET "unit_price_snapshot" = pv."price"
  FROM "product_variants" pv WHERE pv."id" = ci."product_variant_id";
ALTER TABLE "cart_items" ALTER COLUMN "unit_price_snapshot" SET NOT NULL;

-- AlterTable
-- Same pattern for the new snapshots: back-fill from the current rows where the
-- variant still exists; otherwise record that the source is gone.
ALTER TABLE "order_items" ADD COLUMN "sku_snapshot" VARCHAR(64),
ADD COLUMN "vendor_store_name_snapshot" VARCHAR(120);
UPDATE "order_items" oi SET "sku_snapshot" = pv."sku"
  FROM "product_variants" pv WHERE pv."id" = oi."product_variant_id";
UPDATE "order_items" SET "sku_snapshot" = 'UNKNOWN' WHERE "sku_snapshot" IS NULL;
UPDATE "order_items" oi SET "vendor_store_name_snapshot" = v."store_name"
  FROM "sub_orders" so JOIN "vendors" v ON v."id" = so."vendor_id"
 WHERE so."id" = oi."sub_order_id" AND oi."vendor_store_name_snapshot" IS NULL;
ALTER TABLE "order_items" ALTER COLUMN "sku_snapshot" SET NOT NULL,
ALTER COLUMN "vendor_store_name_snapshot" SET NOT NULL;

-- AlterTable
ALTER TABLE "parent_orders" ADD COLUMN     "cancellation_reason" VARCHAR(500),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "customer_note" VARCHAR(500),
ADD COLUMN     "paid_at" TIMESTAMPTZ(3),
ADD COLUMN     "payment_expires_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "sub_orders" ADD COLUMN     "cancellation_reason" VARCHAR(500),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "shipped_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "free_shipping_threshold" DECIMAL(15,2),
ADD COLUMN     "shipping_fee_override" DECIMAL(15,2);

-- CreateTable
CREATE TABLE "sub_order_status_history" (
    "id" UUID NOT NULL,
    "sub_order_id" UUID NOT NULL,
    "from_status" "SubOrderStatus",
    "to_status" "SubOrderStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_role" VARCHAR(20) NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sub_order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sub_order_status_history_sub_order_id_created_at_idx" ON "sub_order_status_history"("sub_order_id", "created_at");

-- CreateIndex
CREATE INDEX "parent_orders_payment_status_payment_expires_at_idx" ON "parent_orders"("payment_status", "payment_expires_at");

-- AddForeignKey
ALTER TABLE "sub_order_status_history" ADD CONSTRAINT "sub_order_status_history_sub_order_id_fkey" FOREIGN KEY ("sub_order_id") REFERENCES "sub_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_order_status_history" ADD CONSTRAINT "sub_order_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Order numbers ──────────────────────────────────────────────────────────
-- Monotonic, gap-tolerant, collision-free across instances: SHP-100000001 …
CREATE SEQUENCE IF NOT EXISTS "parent_order_number_seq" START WITH 100000001 INCREMENT BY 1 NO CYCLE;

-- ─── Invariants the database enforces on its own ────────────────────────────
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_shipping_settings_check"
  CHECK (("shipping_fee_override" IS NULL OR "shipping_fee_override" >= 0)
     AND ("free_shipping_threshold" IS NULL OR "free_shipping_threshold" >= 0));

ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_check"
  CHECK ("quantity" > 0 AND "unit_price_snapshot" > 0);

-- Money identities of the split: the parent adds up, each sub-order's
-- commission and earnings add up to its subtotal, nothing is negative.
ALTER TABLE "parent_orders" ADD CONSTRAINT "parent_orders_amounts_check"
  CHECK ("total_items_amount" >= 0 AND "total_shipping_fee" >= 0 AND "total_discount_amount" >= 0
     AND "final_payable_amount" >= 0
     AND "final_payable_amount" = "total_items_amount" + "total_shipping_fee" - "total_discount_amount");

ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_amounts_check"
  CHECK ("items_subtotal" >= 0 AND "shipping_fee" >= 0
     AND "platform_commission_amount" >= 0 AND "vendor_earnings_amount" >= 0
     AND "platform_commission_amount" + "vendor_earnings_amount" = "items_subtotal");

-- A shipped package always carries its tracking data.
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_shipped_tracking_check"
  CHECK ("status" <> 'SHIPPED' OR ("tracking_code" IS NOT NULL AND "carrier_name" IS NOT NULL));

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts_check"
  CHECK ("quantity" > 0 AND "unit_price_snapshot" > 0 AND "discount_snapshot" >= 0
     AND "commission_rate_snapshot" >= 0 AND "commission_rate_snapshot" <= 100
     AND "total_line_amount" = "unit_price_snapshot" * "quantity" - "discount_snapshot");
```

### `apps/backend/test/orders.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { ParentOrderPaymentStatus, SubOrderStatus } from '@prisma/client';
import { AuditAction, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { OrderLifecycleService } from '../src/modules/orders/order-lifecycle.service';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 6 — address book, cart, checkout with
 * multi-vendor splitting, stock reservation and the order lifecycle — against
 * the real PostgreSQL 16 and Redis 7 of docker-compose. Nothing is stubbed:
 * stores are onboarded and approved over the API, products are created over the
 * vendor API, orders are placed over the checkout API.
 *
 * Payment confirmation has no HTTP endpoint yet (payment gateway = later
 * phase), so the suite calls the real `OrderLifecycleService.markPaid` — the
 * exact method the payment module will call — to move orders to PAID.
 *
 * The platform shipping policy is set for the duration of the suite through
 * real `system_configs` rows (restored afterwards).
 */

const TEST_UA = 'shopino-orders-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971140001';
const VENDOR_B_MOBILE = '+989971140002';
const CUSTOMER_MOBILE = '+989971140003';
const CUSTOMER_2_MOBILE = '+989971140004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE];
const IBANS = ['IR550540102680020817909003', 'IR760170000000000000000001'];
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';

/** Platform shipping policy used by this suite (Toman). */
const PLATFORM_FEE = '450000';
const PLATFORM_FREE_THRESHOLD = '3000000';
/** Store B offers free shipping from 2,000,000. */
const STORE_B_FREE_THRESHOLD = '2000000';

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

interface Address {
  id: string;
  isDefault: boolean;
  postalCode: string;
  recipientMobile: string;
  city: string;
}

interface CartLine {
  id: string;
  productVariantId: string;
  quantity: number;
  unitPrice: string;
  priceWhenAdded: string;
  availableQuantity: number;
  isPurchasable: boolean;
  issues: Array<{ code: string }>;
}

interface Cart {
  cartToken: string | null;
  owner: 'user' | 'guest' | 'none';
  groups: Array<{
    vendor: { storeSlug: string };
    lines: CartLine[];
    itemsSubtotal: string;
    shipping: { fee: string; isFree: boolean; freeThreshold: string };
    packageTotal: string;
  }>;
  itemCount: number;
  lineCount: number;
  itemsSubtotal: string;
  shippingTotal: string;
  payableAmount: string;
  hasPriceChanges: boolean;
  canCheckout: boolean;
}

interface OrderItem {
  productTitle: string;
  sku: string;
  vendorStoreName: string;
  unitPrice: string;
  quantity: number;
  lineTotal: string;
  variantDetails: { colorName: string | null };
}

interface SubOrder {
  id: string;
  subOrderNumber: string;
  store: { id: string; storeSlug: string };
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  total: string;
  trackingCode: string | null;
  carrierName: string | null;
  items: OrderItem[];
}

interface Checkout {
  parentOrderId: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: string;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string;
  subOrders: SubOrder[];
}

interface OrderDetail extends Omit<Checkout, 'parentOrderId'> {
  id: string;
  canCancel: boolean;
  shippingAddress: { postalCode: string; recipientName: string };
  timeline: Array<{ type: string; toStatus: SubOrderStatus | null; actor: string }>;
  auditLogId?: string;
}

interface VendorSubOrder {
  id: string;
  subOrderNumber: string;
  orderNumber: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  platformCommissionAmount: string;
  vendorEarningsAmount: string;
  allowedTransitions: SubOrderStatus[];
  trackingCode: string | null;
  shippingAddress?: { postalCode: string };
  items?: Array<{ commissionRate: string; commissionAmount: string }>;
  history?: Array<{ toStatus: SubOrderStatus; actorRole: string }>;
}

interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

interface ErrorBody {
  code?: string;
  message: string | string[];
  availableQuantity?: number;
  changes?: Array<{ productVariantId: string; previousUnitPrice: string; currentUnitPrice: string }>;
  lines?: Array<{ productVariantId: string; issues: string[] }>;
  allowedTransitions?: SubOrderStatus[];
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

describe('Phase 6 — cart, checkout, multi-vendor orders and lifecycle (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let lifecycle: OrderLifecycleService;

  let adminToken: string;
  let supportToken: string;
  let vendorA: { token: string; userId: string; vendorId: string; storeSlug: string };
  let vendorB: { token: string; userId: string; vendorId: string; storeSlug: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };

  let categoryId: string;
  /** Variant ids: A1/A2 sold by store A, B1 by store B, D1 unpublished (store A). */
  const v: Record<'A1' | 'A2' | 'B1' | 'D1', string> = {} as never;
  let productAId: string;
  let address: Address;
  let address2: Address;
  let savedSystemConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; token?: string; cartToken?: string; body?: unknown } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    if (options.cartToken !== undefined) headers['x-cart-token'] = options.cartToken;
    let payload: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({
      method: options.method ?? 'GET',
      url: `${API}${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T),
      headers: response.headers,
    };
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', {
      method: 'POST',
      body: { mobile, code },
    });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  const onboardStore = async (
    login: { token: string; userId: string },
    storeSlug: string,
    iban: string,
    commissionRateOverride: number | null,
  ): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: {
        storeName: `فروشگاه آزمون سفارش ${storeSlug}`,
        storeSlug,
        bio: 'فروشگاه ساخته‌شده در آزمون سفارش',
        bankIban: iban,
        bankAccountHolder: 'شرکت آزمون سفارش',
      },
    });
    expect(registered.status).toBe(201);
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% orders e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const serialized = new Response(form);
    const uploaded = await app.inject({
      method: 'POST',
      url: `${API}/media/upload/document`,
      headers: {
        authorization: `Bearer ${login.token}`,
        'user-agent': TEST_UA,
        'content-type': serialized.headers.get('content-type') ?? '',
      },
      payload: Buffer.from(await serialized.arrayBuffer()),
    });
    expect(uploaded.statusCode).toBe(201);
    const submitted = await request('/vendors/verification/documents', {
      method: 'POST',
      token: login.token,
      body: { nationalIdCardUrl: (JSON.parse(uploaded.body) as { url: string }).url },
    });
    expect(submitted.status).toBe(200);
    const verified = await request(`/admin/vendors/${registered.body.id}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null, commissionRateOverride },
    });
    expect(verified.status).toBe(200);
    return registered.body.id;
  };

  const createProduct = async (
    token: string,
    title: string,
    variants: Array<{ sku: string; price: number; stockQuantity: number; colorName?: string }>,
    isPublished = true,
  ): Promise<{ id: string; variants: Array<{ id: string; sku: string }> }> => {
    const response = await request<{ id: string; variants: Array<{ id: string; sku: string }> }>('/vendor/products', {
      method: 'POST',
      token,
      body: { title, categoryId, basePrice: variants[0]!.price, isPublished, variants },
    });
    expect(response.status).toBe(201);
    return response.body;
  };

  const variantIdBySku = (product: { variants: Array<{ id: string; sku: string }> }, sku: string): string =>
    product.variants.find((variant) => variant.sku === sku)!.id;

  const stockOf = async (variantId: string): Promise<{ stock: number; reserved: number }> => {
    const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true, reservedQuantity: true } });
    return { stock: row.stockQuantity, reserved: row.reservedQuantity };
  };

  const setStock = (variantId: string, stockQuantity: number): Promise<HttpResult<unknown>> =>
    request(`/vendor/products/variants/${variantId}`, {
      method: 'PATCH',
      token: variantId === v.B1 ? vendorB.token : vendorA.token,
      body: { stockQuantity },
    });

  const addToUserCart = (token: string, productVariantId: string, quantity: number): Promise<HttpResult<Cart & ErrorBody>> =>
    request<Cart & ErrorBody>('/cart/items', { method: 'POST', token, body: { productVariantId, quantity } });

  const checkout = (token: string, addressId: string, customerNote?: string): Promise<HttpResult<Checkout & ErrorBody>> =>
    request<Checkout & ErrorBody>('/orders/checkout', {
      method: 'POST',
      token,
      body: { addressId, ...(customerNote === undefined ? {} : { customerNote }) },
    });

  const clearCart = async (token: string): Promise<void> => {
    expect((await request('/cart/clear', { method: 'POST', token })).status).toBe(200);
  };

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    lifecycle = app.get(OrderLifecycleService);
    await resetAuthKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);

    // Platform shipping policy for this run, via real system_configs rows.
    savedSystemConfigs = (await prisma.systemConfig.findMany({
      where: { key: { in: Object.values(SHIPPING_CONFIG_KEYS) } },
      select: { key: true, value: true, valueType: true, description: true },
    })) as never;
    for (const [key, value] of [
      [SHIPPING_CONFIG_KEYS.defaultFeePerVendor, PLATFORM_FEE],
      [SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, PLATFORM_FREE_THRESHOLD],
    ] as const) {
      await prisma.systemConfig.upsert({
        where: { key },
        update: { value },
        create: { key, value, valueType: 'NUMBER', description: `orders e2e ${RUN}` },
      });
    }

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-ord-${RUN}`, titleFa: `دسته آزمون سفارش ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    const storeA = `ord-e2e-a-${RUN}`;
    const storeB = `ord-e2e-b-${RUN}`;
    vendorA = { ...a, storeSlug: storeA, vendorId: await onboardStore(a, storeA, IBANS[0]!, 7.5) };
    vendorB = { ...b, storeSlug: storeB, vendorId: await onboardStore(b, storeB, IBANS[1]!, null) };
    // No API sets a store's shipping settings yet (not in the Phase-6 endpoint list): set the column directly.
    await prisma.vendor.update({ where: { id: vendorB.vendorId }, data: { freeShippingThreshold: d(STORE_B_FREE_THRESHOLD) } });

    const pa = await createProduct(vendorA.token, `هدفون آزمون ${RUN}`, [
      { sku: `ORD-${TAG}-A1`, price: 1_200_000, stockQuantity: 5, colorName: 'مشکی' },
      { sku: `ORD-${TAG}-A2`, price: 350_000, stockQuantity: 2, colorName: 'سفید' },
    ]);
    productAId = pa.id;
    v.A1 = variantIdBySku(pa, `ORD-${TAG}-A1`);
    v.A2 = variantIdBySku(pa, `ORD-${TAG}-A2`);
    const pb = await createProduct(vendorB.token, `کتاب آزمون ${RUN}`, [{ sku: `ORD-${TAG}-B1`, price: 2_500_000, stockQuantity: 3 }]);
    v.B1 = variantIdBySku(pb, `ORD-${TAG}-B1`);
    const draft = await createProduct(vendorA.token, `پیش‌نویس آزمون ${RUN}`, [{ sku: `ORD-${TAG}-D1`, price: 90_000, stockQuantity: 9 }], false);
    v.D1 = variantIdBySku(draft, `ORD-${TAG}-D1`);
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const orders = await prisma.parentOrder.findMany({ where: { userId: { in: userIds } }, select: { id: true, subOrders: { select: { id: true } } } });
      const orderIds = orders.map((order) => order.id);
      const subIds = orders.flatMap((order) => order.subOrders.map((sub) => sub.id));
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));

      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { userAgent: TEST_UA },
            { entityId: { in: [...vendorIds, ...productIds, ...variantIds, ...orderIds, ...subIds, categoryId].filter(Boolean) } },
          ],
        },
      });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } }); // cascades to sub-orders, items, history
      await prisma.cart.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { items: { some: { productVariantId: { in: variantIds } } } }] } });
      await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      if (categoryId !== undefined) await prisma.category.deleteMany({ where: { id: categoryId } });

      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true } });
      for (const asset of assets) await storage.delete(asset.path).catch(() => false);
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await prisma.systemConfig.deleteMany({ where: { key: { in: Object.values(SHIPPING_CONFIG_KEYS) } } });
      for (const row of savedSystemConfigs) await prisma.systemConfig.create({ data: row });
      await app.get(CategoriesService).invalidateTree();
      await resetAuthKeys();
    }
    await app?.close();
  }, 120_000);

  async function resetAuthKeys(): Promise<void> {
    const redis = app.get(RedisService);
    const keys = [
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
      ...SUITE_MOBILES.flatMap((mobile) => [
        OtpKeys.challenge(mobile),
        OtpKeys.lock(mobile),
        OtpKeys.cooldown(mobile),
        OtpKeys.hourlyByMobile(mobile),
        loginAttemptsKey(normalizeIdentifier(mobile)),
        loginLockKey(normalizeIdentifier(mobile)),
      ]),
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL].flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  // ─── 1. address book ───────────────────────────────────────────────────────

  describe('customer address book', () => {
    const body = {
      province: 'تهران',
      city: 'تهران',
      postalAddress: 'خیابان ولیعصر، کوچه نگار، پلاک ۱۲',
      postalCode: '۱۹۶۹۸۳۳۱۱۱', // Persian digits: normalised
      buildingNumber: '12',
      unitNumber: '4',
      recipientName: 'مریم احمدی',
      recipientMobile: '09121234567',
    };

    it('creates addresses; the first becomes the default and mobile/postal code are normalised', async () => {
      const first = await request<Address>('/customer/addresses', { method: 'POST', token: customer.token, body });
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({ isDefault: true, postalCode: '1969833111', recipientMobile: '+989121234567' });
      address = first.body;

      const second = await request<Address>('/customer/addresses', {
        method: 'POST',
        token: customer.token,
        body: { ...body, city: 'کرج', province: 'البرز', postalCode: '3134567890', isDefault: true },
      });
      expect(second.status).toBe(201);
      expect(second.body.isDefault).toBe(true);
      const list = await request<{ items: Address[]; total: number }>('/customer/addresses', { token: customer.token });
      expect(list.body.total).toBe(2);
      expect(list.body.items[0]!.id).toBe(second.body.id); // default first
      expect(list.body.items.filter((item) => item.isDefault)).toHaveLength(1);

      const own2 = await request<Address>('/customer/addresses', { method: 'POST', token: customer2.token, body });
      expect(own2.status).toBe(201);
      address2 = own2.body;
    });

    it('updates and deletes; the default moves when the default is deleted', async () => {
      const list = await request<{ items: Address[] }>('/customer/addresses', { token: customer.token });
      const karaj = list.body.items[0]!;
      const patched = await request<Address>(`/customer/addresses/${karaj.id}`, { method: 'PATCH', token: customer.token, body: { city: 'فردیس' } });
      expect(patched.status).toBe(200);
      expect(patched.body.city).toBe('فردیس');

      const removed = await request<{ deleted: boolean }>(`/customer/addresses/${karaj.id}`, { method: 'DELETE', token: customer.token });
      expect(removed.status).toBe(200);
      const after = await request<{ items: Address[] }>('/customer/addresses', { token: customer.token });
      expect(after.body.items.map((item) => [item.id, item.isDefault])).toEqual([[address.id, true]]);
    });

    it('validates input and isolates customers', async () => {
      expect((await request('/customer/addresses', { method: 'POST', token: customer.token, body: { ...body, postalCode: '0123456789' } })).status).toBe(400);
      expect((await request('/customer/addresses', { method: 'POST', token: customer.token, body: { ...body, recipientMobile: '12345' } })).status).toBe(400);
      expect((await request(`/customer/addresses/${address.id}`, { method: 'PATCH', token: customer2.token, body: { city: 'رشت' } })).status).toBe(404);
      expect((await request(`/customer/addresses/${address.id}`, { method: 'DELETE', token: customer2.token })).status).toBe(404);
      expect((await request('/customer/addresses', { token: vendorA.token })).status).toBe(403);
      expect((await request('/customer/addresses')).status).toBe(401);
    });
  });

  // ─── 2. cart ───────────────────────────────────────────────────────────────

  describe('cart', () => {
    let guestToken: string;

    it('creates a guest cart on first add and returns its token exactly once', async () => {
      const added = await request<Cart>('/cart/items', { method: 'POST', body: { productVariantId: v.A1, quantity: 2 } });
      expect(added.status).toBe(200);
      expect(added.body.owner).toBe('guest');
      expect(added.body.cartToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      guestToken = added.body.cartToken!;

      const again = await request<Cart>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.B1, quantity: 1 } });
      expect(again.status).toBe(200);
      expect(again.body.cartToken).toBeNull();
      expect(again.body.lineCount).toBe(2);

      // Only the digest is stored.
      const stored = await prisma.cart.findFirst({ where: { items: { some: { productVariantId: v.B1 } }, userId: null } });
      expect(stored?.sessionToken).not.toBe(guestToken);
      expect(stored?.sessionToken).toMatch(/^[0-9a-f]{64}$/);
    });

    it('adds to the same line, enforces the stock limit and reports what is available', async () => {
      const more = await request<Cart>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A1, quantity: 1 } });
      expect(more.status).toBe(200);
      const line = more.body.groups.flatMap((group) => group.lines).find((item) => item.productVariantId === v.A1)!;
      expect(line.quantity).toBe(3);

      const tooMany = await request<ErrorBody>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A1, quantity: 3 } });
      expect(tooMany.status).toBe(409);
      expect(tooMany.body).toMatchObject({ code: 'INSUFFICIENT_STOCK', availableQuantity: 5 });

      const patched = await request<Cart>(`/cart/items/${line.id}`, { method: 'PATCH', cartToken: guestToken, body: { quantity: 6 } });
      expect(patched.status).toBe(409);
      const ok = await request<Cart>(`/cart/items/${line.id}`, { method: 'PATCH', cartToken: guestToken, body: { quantity: 5 } });
      expect(ok.status).toBe(200);
      expect(ok.body.itemCount).toBe(6);
    });

    it('refuses unpublished products, unknown variants and bad input', async () => {
      const draft = await request<ErrorBody>('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.D1, quantity: 1 } });
      expect(draft.status).toBe(409);
      expect(draft.body.code).toBe('PRODUCT_UNPUBLISHED');
      expect((await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: '8f8b7a2e-3c41-4f59-9d1e-5b9a2c7d4e10', quantity: 1 } })).status).toBe(404);
      expect((await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A2, quantity: 0 } })).status).toBe(400);
      expect((await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.A2, quantity: 101 } })).status).toBe(400);
      const malformed = await request<ErrorBody>('/cart', { cartToken: 'not a token' });
      expect(malformed.status).toBe(400);
      expect(malformed.body.code).toBe('INVALID_CART_TOKEN');
    });

    it('deletes a line; another guest cannot see or touch it', async () => {
      const cart = await request<Cart>('/cart', { cartToken: guestToken });
      const bLine = cart.body.groups.flatMap((group) => group.lines).find((item) => item.productVariantId === v.B1)!;
      const other = await request<Cart>('/cart/items', { method: 'POST', body: { productVariantId: v.A2, quantity: 1 } });
      expect((await request(`/cart/items/${bLine.id}`, { method: 'DELETE', cartToken: other.body.cartToken! })).status).toBe(404);
      const removed = await request<Cart>(`/cart/items/${bLine.id}`, { method: 'DELETE', cartToken: guestToken });
      expect(removed.status).toBe(200);
      expect(removed.body.lineCount).toBe(1);
      // put B1 back for the merge test
      await request('/cart/items', { method: 'POST', cartToken: guestToken, body: { productVariantId: v.B1, quantity: 1 } });
    });

    it('merges the guest cart into the account cart on login, clamped to stock', async () => {
      expect((await addToUserCart(customer.token, v.A1, 2)).status).toBe(200);

      expect((await request('/cart/merge', { method: 'POST', cartToken: guestToken })).status).toBe(401);
      expect((await request('/cart/merge', { method: 'POST', token: customer.token })).status).toBe(400);

      const merged = await request<{ cart: Cart; report: { mergedLines: number; clampedLines: Array<{ applied: number }>; droppedLines: unknown[] } }>(
        '/cart/merge',
        { method: 'POST', token: customer.token, cartToken: guestToken },
      );
      expect(merged.status).toBe(200);
      expect(merged.body.cart.owner).toBe('user');
      const lines = merged.body.cart.groups.flatMap((group) => group.lines);
      expect(lines.find((line) => line.productVariantId === v.A1)?.quantity).toBe(5); // 2 + 5 clamped to stock 5
      expect(lines.find((line) => line.productVariantId === v.B1)?.quantity).toBe(1);
      expect(merged.body.report.clampedLines).toEqual([expect.objectContaining({ applied: 5 })]);

      // The guest cart is gone; merging again is a no-op.
      const again = await request<{ report: { mergedLines: number } }>('/cart/merge', { method: 'POST', token: customer.token, cartToken: guestToken });
      expect(again.status).toBe(200);
      expect(again.body.report.mergedLines).toBe(0);
      expect((await request<Cart>('/cart', { cartToken: guestToken })).body.owner).toBe('none');
    });

    it('groups by store with per-store shipping from the platform policy and store overrides', async () => {
      const line = (await request<Cart>('/cart', { token: customer.token })).body.groups.flatMap((g) => g.lines).find((l) => l.productVariantId === v.A1)!;
      await request(`/cart/items/${line.id}`, { method: 'PATCH', token: customer.token, body: { quantity: 2 } });
      await addToUserCart(customer.token, v.A2, 1);

      const cart = await request<Cart>('/cart', { token: customer.token });
      expect(cart.status).toBe(200);
      const a = cart.body.groups.find((group) => group.vendor.storeSlug === vendorA.storeSlug)!;
      const b = cart.body.groups.find((group) => group.vendor.storeSlug === vendorB.storeSlug)!;
      expect(cart.body.groups).toHaveLength(2);
      // A: 2×1,200,000 + 350,000 = 2,750,000 < platform threshold 3,000,000 → platform fee
      expect(a.itemsSubtotal).toBe('2750000.00');
      expect(a.shipping).toMatchObject({ fee: '450000.00', isFree: false, freeThreshold: '3000000.00' });
      // B: 2,500,000 ≥ store threshold 2,000,000 → free
      expect(b.shipping).toMatchObject({ fee: '0.00', isFree: true, freeThreshold: '2000000.00' });
      expect(cart.body).toMatchObject({ itemsSubtotal: '5250000.00', shippingTotal: '450000.00', payableAmount: '5700000.00', canCheckout: true });
    });

    it('flags availability problems in the cart view', async () => {
      await setStock(v.A2, 0);
      const cart = await request<Cart>('/cart', { token: customer.token });
      const a2 = cart.body.groups.flatMap((g) => g.lines).find((l) => l.productVariantId === v.A2)!;
      expect(a2.issues.map((issue) => issue.code)).toContain('OUT_OF_STOCK');
      expect(cart.body.canCheckout).toBe(false);
      const blocked = await checkout(customer.token, address.id);
      expect(blocked.status).toBe(409);
      expect(blocked.body.code).toBe('CART_NOT_CHECKOUTABLE');
      expect(blocked.body.lines).toEqual([expect.objectContaining({ productVariantId: v.A2, issues: ['OUT_OF_STOCK'] })]);
      expect((await setStock(v.A2, 2)).status).toBe(200);
    });
  });

  // ─── 3. checkout ───────────────────────────────────────────────────────────

  describe('checkout', () => {
    let order: Checkout;

    it('refuses foreign addresses and empty carts', async () => {
      expect((await checkout(customer.token, address2.id)).status).toBe(404);
      const empty = await checkout(customer2.token, address2.id);
      expect(empty.status).toBe(409);
      expect(empty.body.code).toBe('CART_EMPTY');
      expect((await checkout(vendorA.token, address.id)).status).toBe(403);
      expect((await request('/orders/checkout', { method: 'POST', body: { addressId: address.id } })).status).toBe(401);
    });

    it('reports changed prices, refreshes the cart, and succeeds on the next attempt', async () => {
      expect((await request(`/vendor/products/variants/${v.A2}`, { method: 'PATCH', token: vendorA.token, body: { price: 400_000 } })).status).toBe(200);

      const cart = await request<Cart>('/cart', { token: customer.token });
      expect(cart.body.hasPriceChanges).toBe(true);

      const changed = await checkout(customer.token, address.id);
      expect(changed.status).toBe(409);
      expect(changed.body.code).toBe('CART_PRICES_CHANGED');
      expect(changed.body.changes).toEqual([
        expect.objectContaining({ productVariantId: v.A2, previousUnitPrice: '350000.00', currentUnitPrice: '400000.00' }),
      ]);
      expect(await prisma.parentOrder.count({ where: { userId: customer.userId } })).toBe(0);
      expect((await request<Cart>('/cart', { token: customer.token })).body.hasPriceChanges).toBe(false);
    });

    it('creates 1 parent order and 2 store packages with correct money, snapshots and reservations', async () => {
      const before = { A1: await stockOf(v.A1), A2: await stockOf(v.A2), B1: await stockOf(v.B1) };
      const response = await checkout(customer.token, address.id, 'لطفاً قبل از ارسال تماس بگیرید');
      expect(response.status).toBe(201);
      order = response.body;

      expect(order.orderNumber).toMatch(/^SHP-\d{9,}$/);
      expect(order.paymentStatus).toBe('PENDING');
      expect(order.paymentMethod).toBe('CASH_IPG');
      expect(order.subOrders).toHaveLength(2);
      expect(order.subOrders.map((sub) => sub.subOrderNumber)).toEqual([`${order.orderNumber}-1`, `${order.orderNumber}-2`]);
      expect(order.subOrders.every((sub) => sub.status === 'PENDING_APPROVAL')).toBe(true);

      const a = order.subOrders.find((sub) => sub.store.id === vendorA.vendorId)!;
      const b = order.subOrders.find((sub) => sub.store.id === vendorB.vendorId)!;
      // A: 2×1,200,000 + 400,000 = 2,800,000 (< 3,000,000 → fee 450,000); B: 2,500,000 (free from 2,000,000)
      expect(a).toMatchObject({ itemsSubtotal: '2800000.00', shippingFee: '450000.00', total: '3250000.00' });
      expect(b).toMatchObject({ itemsSubtotal: '2500000.00', shippingFee: '0.00', total: '2500000.00' });
      expect(order).toMatchObject({
        totalItemsAmount: '5300000.00',
        totalShippingFee: '450000.00',
        totalDiscountAmount: '0.00',
        finalPayableAmount: '5750000.00',
      });
      expect(new Date(order.paymentExpiresAt).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);

      // Money identities, checked on the stored rows.
      const parent = await prisma.parentOrder.findUniqueOrThrow({ where: { id: order.parentOrderId }, include: { subOrders: { include: { items: true } } } });
      const sumPackages = parent.subOrders.reduce((sum, sub) => sum.add(sub.itemsSubtotal).add(sub.shippingFee), d(0));
      expect(sumPackages.eq(parent.finalPayableAmount)).toBe(true);
      for (const sub of parent.subOrders) {
        expect(sub.platformCommissionAmount.add(sub.vendorEarningsAmount).eq(sub.itemsSubtotal)).toBe(true);
      }
      const subA = parent.subOrders.find((sub) => sub.vendorId === vendorA.vendorId)!;
      const subB = parent.subOrders.find((sub) => sub.vendorId === vendorB.vendorId)!;
      expect(subA.platformCommissionAmount.toFixed(2)).toBe('210000.00'); // store override 7.5% of 2,800,000
      expect(subB.platformCommissionAmount.toFixed(2)).toBe('250000.00'); // category default 10% of 2,500,000
      expect(subA.items.every((item) => item.commissionRateSnapshot.toFixed(2) === '7.50')).toBe(true);
      expect(subB.items[0]!.commissionRateSnapshot.toFixed(2)).toBe('10.00');
      const a1Item = subA.items.find((item) => item.productVariantId === v.A1)!;
      expect(a1Item).toMatchObject({ skuSnapshot: `ORD-${TAG}-A1`, quantity: 2, productTitleSnapshot: `هدفون آزمون ${RUN}` });
      expect(a1Item.vendorStoreNameSnapshot).toBe(`فروشگاه آزمون سفارش ${vendorA.storeSlug}`);
      expect(a1Item.variantDetailsSnapshot).toMatchObject({ colorName: 'مشکی' });
      expect(parent.shippingAddressSnapshot).toMatchObject({ postalCode: '1969833111', recipientName: 'مریم احمدی' });
      expect(parent.customerNote).toBe('لطفاً قبل از ارسال تماس بگیرید');

      // Stock reserved, not yet sold.
      expect(await stockOf(v.A1)).toEqual({ stock: before.A1.stock, reserved: before.A1.reserved + 2 });
      expect(await stockOf(v.A2)).toEqual({ stock: before.A2.stock, reserved: before.A2.reserved + 1 });
      expect(await stockOf(v.B1)).toEqual({ stock: before.B1.stock, reserved: before.B1.reserved + 1 });

      // Cart emptied, history started, audit row written without address PII.
      expect((await request<Cart>('/cart', { token: customer.token })).body.lineCount).toBe(0);
      expect(await prisma.subOrderStatusHistory.count({ where: { subOrder: { parentOrderId: order.parentOrderId } } })).toBe(2);
      const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: order.parentOrderId, action: AuditAction.CREATE } });
      expect(audit.userId).toBe(customer.userId);
      expect(JSON.stringify(audit.newValue)).not.toContain('1969833111');
    });

    it('keeps item snapshots immutable when the catalogue changes afterwards', async () => {
      await request(`/vendor/products/${productAId}`, { method: 'PATCH', token: vendorA.token, body: { title: `عنوان جدید ${RUN}` } });
      await request(`/vendor/products/variants/${v.A1}`, { method: 'PATCH', token: vendorA.token, body: { price: 1_300_000 } });
      const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
      const a1 = detail.body.subOrders.flatMap((sub) => sub.items).find((item) => item.sku === `ORD-${TAG}-A1`)!;
      expect(a1).toMatchObject({ productTitle: `هدفون آزمون ${RUN}`, unitPrice: '1200000.00', lineTotal: '2400000.00' });
      await request(`/vendor/products/variants/${v.A1}`, { method: 'PATCH', token: vendorA.token, body: { price: 1_200_000 } });
    });

    it('lets exactly one of two concurrent checkouts take the last units', async () => {
      const available = (await stockOf(v.A2));
      const units = available.stock - available.reserved; // 1 left
      expect(units).toBe(1);
      await addToUserCart(customer.token, v.A2, units);
      await addToUserCart(customer2.token, v.A2, units);
      const results = await Promise.all([checkout(customer.token, address.id), checkout(customer2.token, address2.id)]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      const loser = results.find((result) => result.status === 409)!;
      expect(loser.body.code).toBe('CART_NOT_CHECKOUTABLE');
      expect(await stockOf(v.A2)).toEqual({ stock: available.stock, reserved: available.stock });

      // Release the winner's order again (unpaid cancel) and clear the loser's cart.
      const winnerToken = results[0].status === 201 ? customer.token : customer2.token;
      const winner = results.find((result) => result.status === 201)!.body;
      expect((await request(`/customer/orders/${winner.parentOrderId}/cancel`, { method: 'POST', token: winnerToken, body: {} })).status).toBe(200);
      await clearCart(customer.token);
      await clearCart(customer2.token);
      expect(await stockOf(v.A2)).toEqual({ stock: available.stock, reserved: available.reserved });
    });

    it('does not create two orders from one cart submitted twice at once', async () => {
      await addToUserCart(customer2.token, v.B1, 1);
      const results = await Promise.all([checkout(customer2.token, address2.id), checkout(customer2.token, address2.id)]);
      expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
      expect(results.find((result) => result.status === 409)!.body.code).toBe('CART_EMPTY');
      const winner = results.find((result) => result.status === 201)!.body;
      await request(`/customer/orders/${winner.parentOrderId}/cancel`, { method: 'POST', token: customer2.token, body: {} });
    });

    // ─── 4. customer orders and cancellation ─────────────────────────────────

    describe('customer orders', () => {
      it('lists own orders with the package breakdown; others get 404', async () => {
        const list = await request<Page<{ id: string; orderNumber: string; subOrders: Array<{ storeName: string; itemCount: number }> }>>(
          '/customer/orders?pageSize=10',
          { token: customer.token },
        );
        expect(list.status).toBe(200);
        const mine = list.body.items.find((item) => item.id === order.parentOrderId)!;
        expect(mine.subOrders).toHaveLength(2);
        expect(mine.subOrders.map((sub) => sub.itemCount).sort()).toEqual([1, 2]);
        expect((await request(`/customer/orders/${order.parentOrderId}`, { token: customer2.token })).status).toBe(404);
        const pending = await request<Page<unknown>>('/customer/orders?paymentStatus=PENDING', { token: customer.token });
        expect(pending.body.items).toHaveLength(1);
      });

      it('shows the order detail with address, packages and timeline', async () => {
        const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
        expect(detail.status).toBe(200);
        expect(detail.body).toMatchObject({ orderNumber: order.orderNumber, canCancel: true, finalPayableAmount: '5750000.00' });
        expect(detail.body.shippingAddress.postalCode).toBe('1969833111');
        expect(detail.body.timeline[0]).toMatchObject({ type: 'ORDER_PLACED' });
      });

      it('cancels an unpaid order, releases the stock and refuses a second cancel', async () => {
        await addToUserCart(customer.token, v.A1, 1);
        const second = await checkout(customer.token, address.id);
        expect(second.status).toBe(201);
        const reservedBefore = (await stockOf(v.A1)).reserved;

        const cancelled = await request<OrderDetail>(`/customer/orders/${second.body.parentOrderId}/cancel`, {
          method: 'POST',
          token: customer.token,
          body: { reason: 'از خرید منصرف شدم' },
        });
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ paymentStatus: 'CANCELLED', canCancel: false });
        expect(cancelled.body.subOrders.every((sub) => sub.status === 'CANCELLED')).toBe(true);
        expect(cancelled.body.timeline.map((event) => event.type)).toEqual(expect.arrayContaining(['ORDER_CANCELLED', 'SUB_ORDER_STATUS']));
        expect((await stockOf(v.A1)).reserved).toBe(reservedBefore - 1);
        expect(cancelled.body.auditLogId).toBeDefined();

        const again = await request<ErrorBody>(`/customer/orders/${second.body.parentOrderId}/cancel`, { method: 'POST', token: customer.token, body: {} });
        expect(again.status).toBe(409);
        expect(again.body.code).toBe('ORDER_NOT_CANCELLABLE');
        expect((await request(`/customer/orders/${order.parentOrderId}/cancel`, { method: 'POST', token: customer2.token, body: {} })).status).toBe(404);
      });
    });

    // ─── 5. payment, vendor fulfilment and isolation ─────────────────────────

    describe('after payment', () => {
      let subA: string;
      let subB: string;

      it('hides unpaid orders from vendors', async () => {
        const list = await request<Page<VendorSubOrder>>('/vendor/orders', { token: vendorA.token });
        expect(list.body.items.find((item) => item.orderNumber === order.orderNumber)).toBeUndefined();
        subA = order.subOrders.find((sub) => sub.store.id === vendorA.vendorId)!.id;
        subB = order.subOrders.find((sub) => sub.store.id === vendorB.vendorId)!.id;
        expect((await request(`/vendor/orders/${subA}`, { token: vendorA.token })).status).toBe(404);
        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'PROCESSING' } })).status).toBe(404);
      });

      it('commits the reservation when payment is confirmed (stock and reserved both drop)', async () => {
        const before = { A1: await stockOf(v.A1), B1: await stockOf(v.B1) };
        expect(await lifecycle.markPaid(order.parentOrderId)).toBe(true);
        expect(await lifecycle.markPaid(order.parentOrderId)).toBe(false); // idempotent
        expect(await stockOf(v.A1)).toEqual({ stock: before.A1.stock - 2, reserved: before.A1.reserved - 2 });
        expect(await stockOf(v.B1)).toEqual({ stock: before.B1.stock - 1, reserved: before.B1.reserved - 1 });
        const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
        expect(detail.body).toMatchObject({ paymentStatus: 'PAID', canCancel: false });
        expect((await request(`/customer/orders/${order.parentOrderId}/cancel`, { method: 'POST', token: customer.token, body: {} })).status).toBe(409);
      });

      it('shows each vendor only its own package, with address, commission and allowed transitions', async () => {
        const listA = await request<Page<VendorSubOrder>>('/vendor/orders?status=PENDING_APPROVAL', { token: vendorA.token });
        expect(listA.status).toBe(200);
        expect(listA.body.items.map((item) => item.id)).toEqual([subA]);
        expect(listA.body.items[0]).toMatchObject({
          itemsSubtotal: '2800000.00',
          platformCommissionAmount: '210000.00',
          vendorEarningsAmount: '2590000.00',
          allowedTransitions: ['PROCESSING', 'CANCELLED'],
        });
        const detail = await request<VendorSubOrder>(`/vendor/orders/${subA}`, { token: vendorA.token });
        expect(detail.body.shippingAddress?.postalCode).toBe('1969833111');
        expect(detail.body.items?.every((item) => item.commissionRate === '7.50')).toBe(true);
        const searched = await request<Page<VendorSubOrder>>(`/vendor/orders?search=${order.orderNumber}`, { token: vendorB.token });
        expect(searched.body.items.map((item) => item.id)).toEqual([subB]);
      });

      it('forbids vendor A from reading or updating vendor B’s package', async () => {
        expect((await request(`/vendor/orders/${subB}`, { token: vendorA.token })).status).toBe(404);
        expect((await request(`/vendor/orders/${subB}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'PROCESSING' } })).status).toBe(404);
        expect((await request(`/vendor/orders/${subA}`, { token: customer.token })).status).toBe(403);
        expect((await request('/vendor/orders', { token: adminToken })).status).toBe(403);
        const untouched = await prisma.subOrder.findUniqueOrThrow({ where: { id: subB } });
        expect(untouched.status).toBe('PENDING_APPROVAL');
      });

      it('enforces the state machine and ships with a tracking code', async () => {
        const skip = await request<ErrorBody>(`/vendor/orders/${subA}/status`, {
          method: 'PATCH',
          token: vendorA.token,
          body: { status: 'SHIPPED', trackingCode: 'TRK-1', shippingCarrier: 'پست' },
        });
        expect(skip.status).toBe(409);
        expect(skip.body).toMatchObject({ code: 'INVALID_STATUS_TRANSITION', allowedTransitions: ['PROCESSING', 'CANCELLED'] });

        const processing = await request<{ previousStatus: string; subOrder: VendorSubOrder }>(`/vendor/orders/${subA}/status`, {
          method: 'PATCH',
          token: vendorA.token,
          body: { status: 'PROCESSING' },
        });
        expect(processing.status).toBe(200);
        expect(processing.body).toMatchObject({ previousStatus: 'PENDING_APPROVAL', subOrder: { status: 'PROCESSING', allowedTransitions: ['SHIPPED', 'CANCELLED'] } });

        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'SHIPPED' } })).status).toBe(400);
        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'SHIPPED', trackingCode: 'TRACK 1', shippingCarrier: 'پست' } })).status).toBe(400);

        const shipped = await request<{ subOrder: VendorSubOrder; auditLogId: string }>(`/vendor/orders/${subA}/status`, {
          method: 'PATCH',
          token: vendorA.token,
          body: { status: 'SHIPPED', trackingCode: '123456789012345678901234', shippingCarrier: 'پست پیشتاز' },
        });
        expect(shipped.status).toBe(200);
        expect(shipped.body.subOrder).toMatchObject({ status: 'SHIPPED', trackingCode: '123456789012345678901234', allowedTransitions: [] });
        expect(shipped.body.subOrder.history?.map((entry) => entry.toStatus)).toEqual(['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED']);
        const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: shipped.body.auditLogId } });
        expect(audit).toMatchObject({ action: AuditAction.STATUS_CHANGE, entityName: 'SubOrder', entityId: subA, userId: vendorA.userId });

        expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'CANCELLED', reason: 'دیگر موجود نیست' } })).status).toBe(409);

        const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
        const pkg = detail.body.subOrders.find((sub) => sub.id === subA)!;
        expect(pkg).toMatchObject({ trackingCode: '123456789012345678901234', carrierName: 'پست پیشتاز', status: 'SHIPPED' });
        expect(detail.body.timeline.filter((event) => event.type === 'SUB_ORDER_STATUS').map((event) => event.toStatus)).toEqual(['PROCESSING', 'SHIPPED']);
      });

      it('restocks when a vendor cancels a paid package that has not shipped', async () => {
        const before = await stockOf(v.B1);
        expect((await request(`/vendor/orders/${subB}/status`, { method: 'PATCH', token: vendorB.token, body: { status: 'CANCELLED' } })).status).toBe(400); // reason required
        const cancelled = await request<{ stockAction: string; subOrder: VendorSubOrder }>(`/vendor/orders/${subB}/status`, {
          method: 'PATCH',
          token: vendorB.token,
          body: { status: 'CANCELLED', reason: 'نسخه چاپی تمام شده است' },
        });
        expect(cancelled.status).toBe(200);
        expect(cancelled.body).toMatchObject({ stockAction: 'RESTOCKED', subOrder: { status: 'CANCELLED' } });
        expect(await stockOf(v.B1)).toEqual({ stock: before.stock + 1, reserved: before.reserved });
      });

      // ─── 6. staff ──────────────────────────────────────────────────────────

      it('lets staff search globally; support may read but not force', async () => {
        const found = await request<Page<{ id: string; customer: { mobile: string }; subOrders: unknown[] }>>(
          `/admin/orders?search=${order.orderNumber}`,
          { token: supportToken },
        );
        expect(found.status).toBe(200);
        expect(found.body.items.map((item) => item.id)).toEqual([order.parentOrderId]);
        expect(found.body.items[0]!.customer.mobile).toBe(CUSTOMER_MOBILE);
        const byMobile = await request<Page<{ id: string }>>(`/admin/orders?search=09971140003&paymentStatus=PAID`, { token: adminToken });
        expect(byMobile.body.items.map((item) => item.id)).toEqual([order.parentOrderId]);
        const byVendor = await request<Page<{ id: string }>>(`/admin/orders?vendorId=${vendorB.vendorId}&subOrderStatus=CANCELLED`, { token: adminToken });
        expect(byVendor.body.items.map((item) => item.id)).toContain(order.parentOrderId);

        expect((await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: supportToken, body: { status: 'DELIVERED', reason: 'تایید تحویل' } })).status).toBe(403);
        expect((await request('/admin/orders', { token: customer.token })).status).toBe(403);
        expect((await request('/admin/orders', { token: vendorA.token })).status).toBe(403);
      });

      it('forces DELIVERED and REFUNDED with history and audit; unpaid orders are refused', async () => {
        const delivered = await request<{ previousStatus: string; stockAction: string; subOrder: { status: string } }>(
          `/admin/sub-orders/${subA}/force-status`,
          { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'تحویل توسط شرکت پست تایید شد' } },
        );
        expect(delivered.status).toBe(200);
        expect(delivered.body).toMatchObject({ previousStatus: 'SHIPPED', stockAction: 'NONE', subOrder: { status: 'DELIVERED' } });
        expect((await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'دوباره' } })).status).toBe(409);

        const b1Before = await stockOf(v.B1);
        const refunded = await request<{ previousStatus: string; stockAction: string }>(`/admin/sub-orders/${subB}/force-status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'REFUNDED', reason: 'بازپرداخت به مشتری' },
        });
        expect(refunded.status).toBe(200);
        expect(refunded.body).toMatchObject({ previousStatus: 'CANCELLED', stockAction: 'NONE' }); // already restocked on cancel
        expect(await stockOf(v.B1)).toEqual(b1Before);
        const history = await prisma.subOrderStatusHistory.findMany({ where: { subOrderId: subB }, orderBy: { createdAt: 'asc' } });
        expect(history.map((row) => [row.toStatus, row.actorRole])).toEqual([
          ['PENDING_APPROVAL', 'CUSTOMER'],
          ['CANCELLED', 'VENDOR'],
          ['REFUNDED', 'STAFF'],
        ]);

        const cancelledOrder = await prisma.subOrder.findFirstOrThrow({
          where: { parentOrder: { userId: customer.userId, paymentStatus: 'CANCELLED' } },
          select: { id: true },
        });
        const unpaid = await request<ErrorBody>(`/admin/sub-orders/${cancelledOrder.id}/force-status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'REFUNDED', reason: 'آزمون سفارش پرداخت‌نشده' },
        });
        expect(unpaid.status).toBe(409);
        expect(unpaid.body.code).toBe('ORDER_NOT_PAID');
        expect((await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'SHIPPED', reason: 'نامعتبر' } })).status).toBe(400);
      });

      it('restocks a paid package refunded by staff before shipping', async () => {
        await addToUserCart(customer.token, v.A2, 1);
        const placed = await checkout(customer.token, address.id);
        expect(placed.status).toBe(201);
        await lifecycle.markPaid(placed.body.parentOrderId);
        const before = await stockOf(v.A2);
        const refunded = await request<{ stockAction: string }>(`/admin/sub-orders/${placed.body.subOrders[0]!.id}/force-status`, {
          method: 'PATCH',
          token: adminToken,
          body: { status: 'REFUNDED', reason: 'درخواست انصراف پیش از پردازش' },
        });
        expect(refunded.status).toBe(200);
        expect(refunded.body.stockAction).toBe('RESTOCKED');
        expect(await stockOf(v.A2)).toEqual({ stock: before.stock + 1, reserved: before.reserved });
      });
    });

    // ─── 7. payment failure and expiry ───────────────────────────────────────

    describe('unpaid orders that never complete', () => {
      it('releases the reservation when payment fails', async () => {
        await addToUserCart(customer2.token, v.B1, 1);
        const placed = await checkout(customer2.token, address2.id);
        expect(placed.status).toBe(201);
        const reserved = (await stockOf(v.B1)).reserved;
        expect(await lifecycle.markPaymentFailed(placed.body.parentOrderId, 'Gateway declined')).toBe(true);
        expect((await stockOf(v.B1)).reserved).toBe(reserved - 1);
        const detail = await request<OrderDetail>(`/customer/orders/${placed.body.parentOrderId}`, { token: customer2.token });
        expect(detail.body.paymentStatus).toBe('FAILED');
        expect(detail.body.timeline.map((event) => event.type)).toContain('PAYMENT_FAILED');
        expect(await lifecycle.markPaid(placed.body.parentOrderId)).toBe(false);
      });

      it('cancels orders whose payment window passed and releases their stock', async () => {
        await addToUserCart(customer2.token, v.A1, 1);
        const placed = await checkout(customer2.token, address2.id);
        expect(placed.status).toBe(201);
        const reserved = (await stockOf(v.A1)).reserved;
        expect(await lifecycle.expireOverdue(new Date())).toBe(0); // not due yet

        await prisma.parentOrder.update({ where: { id: placed.body.parentOrderId }, data: { paymentExpiresAt: new Date(Date.now() - 1000) } });
        expect(await lifecycle.expireOverdue(new Date())).toBeGreaterThanOrEqual(1);
        expect((await stockOf(v.A1)).reserved).toBe(reserved - 1);
        const row = await prisma.parentOrder.findUniqueOrThrow({ where: { id: placed.body.parentOrderId }, include: { subOrders: true } });
        expect(row.paymentStatus).toBe('CANCELLED');
        expect(row.cancellationReason).toBe('Payment was not completed in time');
        expect(row.subOrders.every((sub) => sub.status === 'CANCELLED')).toBe(true);
        expect(await lifecycle.markPaid(placed.body.parentOrderId)).toBe(false);
      });
    });
  });

  // ─── 8. database guarantees ─────────────────────────────────────────────────

  describe('database guarantees', () => {
    it('rejects SHIPPED without a tracking code and broken money identities', async () => {
      const sub = await prisma.subOrder.findFirstOrThrow({ where: { parentOrder: { userId: customer.userId } }, select: { id: true } });
      await expect(
        prisma.$executeRaw`UPDATE sub_orders SET status = 'SHIPPED', tracking_code = NULL WHERE id = ${sub.id}::uuid`,
      ).rejects.toThrow(/sub_orders_shipped_tracking_check|check constraint/);
      await expect(
        prisma.$executeRaw`UPDATE sub_orders SET vendor_earnings_amount = vendor_earnings_amount + 1 WHERE id = ${sub.id}::uuid`,
      ).rejects.toThrow(/check constraint/);
      const parent = await prisma.parentOrder.findFirstOrThrow({ where: { userId: customer.userId }, select: { id: true } });
      await expect(
        prisma.$executeRaw`UPDATE parent_orders SET final_payable_amount = final_payable_amount + 1 WHERE id = ${parent.id}::uuid`,
      ).rejects.toThrow(/check constraint/);
    });
  });

  // ─── 9. OpenAPI ─────────────────────────────────────────────────────────────

  describe('Swagger', () => {
    it('documents every Phase-6 route with its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>;
        tags: Array<{ name: string }>;
      };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/customer/addresses', 'post', 'customer-addresses'],
        ['/api/v1/customer/addresses', 'get', 'customer-addresses'],
        ['/api/v1/customer/addresses/{id}', 'patch', 'customer-addresses'],
        ['/api/v1/customer/addresses/{id}', 'delete', 'customer-addresses'],
        ['/api/v1/cart', 'get', 'cart'],
        ['/api/v1/cart/items', 'post', 'cart'],
        ['/api/v1/cart/items/{id}', 'patch', 'cart'],
        ['/api/v1/cart/items/{id}', 'delete', 'cart'],
        ['/api/v1/cart/clear', 'post', 'cart'],
        ['/api/v1/cart/merge', 'post', 'cart'],
        ['/api/v1/orders/checkout', 'post', 'orders'],
        ['/api/v1/customer/orders', 'get', 'customer-orders'],
        ['/api/v1/customer/orders/{id}', 'get', 'customer-orders'],
        ['/api/v1/customer/orders/{id}/cancel', 'post', 'customer-orders'],
        ['/api/v1/vendor/orders', 'get', 'vendor-orders'],
        ['/api/v1/vendor/orders/{id}', 'get', 'vendor-orders'],
        ['/api/v1/vendor/orders/{id}/status', 'patch', 'vendor-orders'],
        ['/api/v1/admin/orders', 'get', 'admin-orders'],
        ['/api/v1/admin/sub-orders/{id}/force-status', 'patch', 'admin-orders'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(2);
      }
      expect(document.tags.map((tag) => tag.name)).toEqual(
        expect.arrayContaining(['customer-addresses', 'cart', 'orders', 'customer-orders', 'vendor-orders', 'admin-orders']),
      );
    });
  });
});
```

## 11. Changes to existing files (git diff against `3861992`)

```diff
diff --git a/.env.example b/.env.example
index a3f25e4..29dffec 100644
--- a/.env.example
+++ b/.env.example
@@ -160,3 +160,16 @@ BACKEND_INTERNAL_URL=http://127.0.0.1:4000
 # Comma-separated extra origins allowed to load Next.js dev assets
 # (remote dev sandboxes / tunnels). Production builds ignore this.
 NEXT_ALLOWED_DEV_ORIGINS=
+
+# ─── Commerce: shipping & order lifecycle (Phase 6) ─────────────────────────
+# Amounts are in the platform currency (system_configs platform.currency = IRR, rial).
+# These are fallbacks: system_configs keys shipping.default_fee_per_vendor and
+# shipping.free_threshold_per_vendor take precedence; a store's own
+# shippingFeeOverride / freeShippingThreshold take precedence over both.
+# 500000 IRR = 50,000 toman · 10000000 IRR = 1,000,000 toman. 0 threshold = never free.
+SHIPPING_DEFAULT_FEE_PER_VENDOR=500000
+SHIPPING_FREE_THRESHOLD_PER_VENDOR=10000000
+# Unpaid orders release their stock reservation after this many minutes.
+ORDER_PAYMENT_TIMEOUT_MINUTES=30
+# Expiry sweeper period in seconds (0 disables it on this instance).
+ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=60
diff --git a/apps/backend/package.json b/apps/backend/package.json
index d70de60..dac6d75 100644
--- a/apps/backend/package.json
+++ b/apps/backend/package.json
@@ -11,7 +11,7 @@
     "typecheck": "pnpm run db:generate && tsc --noEmit -p tsconfig.json",
     "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\" \"scripts/**/*.ts\" \"prisma/**/*.ts\"",
     "test": "jest --config jest.config.js --runInBand",
-    "test:e2e": "jest --config ./test/jest-e2e.json --runInBand",
+    "test:e2e": "jest --config ./test/jest-e2e.json",
     "prisma:generate": "pnpm run db:generate",
     "db:validate": "dotenv -e ../../.env -- prisma validate",
     "db:migrate": "dotenv -e ../../.env -- prisma migrate dev",
diff --git a/apps/backend/prisma/schema.prisma b/apps/backend/prisma/schema.prisma
index bbee37a..6a309fa 100644
--- a/apps/backend/prisma/schema.prisma
+++ b/apps/backend/prisma/schema.prisma
@@ -90,20 +90,21 @@ model User {
   createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
   updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)
 
-  customerProfile      CustomerProfile?
-  addresses            Address[]
-  vendor               Vendor?
-  auditLogs            AuditLog[]
-  carts                Cart[]
-  parentOrders         ParentOrder[]
-  creditAccounts       CreditAccount[]
-  creditApplications   CreditApplication[]
-  disputesRaised       Dispute[]
-  disputeEvidence      DisputeEvidence[]
-  verificationsReview  VendorVerification[] @relation("VerificationReviewer")
-  mediaAssets          MediaAsset[]         @relation("MediaAssetOwner")
-  settlementsProcessed SettlementRequest[]  @relation("SettlementProcessor")
-  productsBlocked      Product[]            @relation("ProductBlockedBy")
+  customerProfile       CustomerProfile?
+  addresses             Address[]
+  vendor                Vendor?
+  auditLogs             AuditLog[]
+  carts                 Cart[]
+  parentOrders          ParentOrder[]
+  creditAccounts        CreditAccount[]
+  creditApplications    CreditApplication[]
+  disputesRaised        Dispute[]
+  disputeEvidence       DisputeEvidence[]
+  verificationsReview   VendorVerification[]    @relation("VerificationReviewer")
+  mediaAssets           MediaAsset[]            @relation("MediaAssetOwner")
+  settlementsProcessed  SettlementRequest[]     @relation("SettlementProcessor")
+  subOrderStatusChanges SubOrderStatusHistory[] @relation("SubOrderStatusActor")
+  productsBlocked       Product[]               @relation("ProductBlockedBy")
 
   @@index([role, isActive])
   @@index([createdAt])
@@ -202,6 +203,10 @@ model Vendor {
   bankAccountHolder      String?      @map("bank_account_holder") @db.VarChar(120)
   /// Vendor-specific commission; when null, the category rate applies.
   commissionRateOverride Decimal?     @map("commission_rate_override") @db.Decimal(5, 2)
+  /// Flat shipping fee for this store's packages; null = platform default.
+  shippingFeeOverride    Decimal?     @map("shipping_fee_override") @db.Decimal(15, 2)
+  /// Package subtotal at which this store ships for free; null = platform default, 0 = never free.
+  freeShippingThreshold  Decimal?     @map("free_shipping_threshold") @db.Decimal(15, 2)
   status                 VendorStatus @default(PENDING)
   verifiedAt             DateTime?    @map("verified_at") @db.Timestamptz(3)
   createdAt              DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
@@ -446,14 +451,16 @@ model Cart {
 /// One line of a cart. A variant appears at most once per cart: quantity changes
 /// are an update, never a second row.
 model CartItem {
-  id               String         @id @default(uuid()) @db.Uuid
-  cartId           String         @map("cart_id") @db.Uuid
-  cart             Cart           @relation(fields: [cartId], references: [id], onDelete: Cascade)
-  productVariantId String         @map("product_variant_id") @db.Uuid
-  productVariant   ProductVariant @relation(fields: [productVariantId], references: [id], onDelete: Cascade)
-  quantity         Int
-  createdAt        DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
-  updatedAt        DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)
+  id                String         @id @default(uuid()) @db.Uuid
+  cartId            String         @map("cart_id") @db.Uuid
+  cart              Cart           @relation(fields: [cartId], references: [id], onDelete: Cascade)
+  productVariantId  String         @map("product_variant_id") @db.Uuid
+  productVariant    ProductVariant @relation(fields: [productVariantId], references: [id], onDelete: Cascade)
+  quantity          Int
+  /// Unit price the customer last saw for this line; checkout compares it with the live price.
+  unitPriceSnapshot Decimal        @map("unit_price_snapshot") @db.Decimal(15, 2)
+  createdAt         DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
+  updatedAt         DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)
 
   @@unique([cartId, productVariantId])
   @@index([productVariantId])
@@ -476,6 +483,12 @@ model ParentOrder {
   finalPayableAmount      Decimal                  @map("final_payable_amount") @db.Decimal(15, 2)
   paymentMethod           PaymentMethod            @map("payment_method")
   paymentStatus           ParentOrderPaymentStatus @default(PENDING) @map("payment_status")
+  customerNote            String?                  @map("customer_note") @db.VarChar(500)
+  /// Unpaid orders are cancelled (and their reservations released) after this instant.
+  paymentExpiresAt        DateTime?                @map("payment_expires_at") @db.Timestamptz(3)
+  paidAt                  DateTime?                @map("paid_at") @db.Timestamptz(3)
+  cancelledAt             DateTime?                @map("cancelled_at") @db.Timestamptz(3)
+  cancellationReason      String?                  @map("cancellation_reason") @db.VarChar(500)
   createdAt               DateTime                 @default(now()) @map("created_at") @db.Timestamptz(3)
   updatedAt               DateTime                 @updatedAt @map("updated_at") @db.Timestamptz(3)
 
@@ -486,6 +499,7 @@ model ParentOrder {
 
   @@index([userId, createdAt])
   @@index([paymentStatus, createdAt])
+  @@index([paymentStatus, paymentExpiresAt])
   @@index([createdAt])
   @@map("parent_orders")
 }
@@ -507,7 +521,10 @@ model SubOrder {
   status                   SubOrderStatus @default(PENDING_APPROVAL)
   trackingCode             String?        @map("tracking_code") @db.VarChar(40)
   carrierName              String?        @map("carrier_name") @db.VarChar(80)
+  shippedAt                DateTime?      @map("shipped_at") @db.Timestamptz(3)
   deliveredAt              DateTime?      @map("delivered_at") @db.Timestamptz(3)
+  cancelledAt              DateTime?      @map("cancelled_at") @db.Timestamptz(3)
+  cancellationReason       String?        @map("cancellation_reason") @db.VarChar(500)
   /// Set when the escrowed amount moves from pendingBalance to withdrawable.
   escrowReleasedAt         DateTime?      @map("escrow_released_at") @db.Timestamptz(3)
   createdAt                DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
@@ -516,6 +533,7 @@ model SubOrder {
   items              OrderItem[]
   walletTransactions WalletTransaction[]
   disputes           Dispute[]
+  statusHistory      SubOrderStatusHistory[]
 
   @@index([parentOrderId])
   @@index([vendorId, status, createdAt])
@@ -523,25 +541,46 @@ model SubOrder {
   @@map("sub_orders")
 }
 
+/// Append-only timeline of sub-order status changes (who, when, why).
+model SubOrderStatusHistory {
+  id          String          @id @default(uuid()) @db.Uuid
+  subOrderId  String          @map("sub_order_id") @db.Uuid
+  subOrder    SubOrder        @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
+  fromStatus  SubOrderStatus? @map("from_status")
+  toStatus    SubOrderStatus  @map("to_status")
+  /// Null for system transitions (payment timeout, gateway callbacks).
+  actorUserId String?         @map("actor_user_id") @db.Uuid
+  actorUser   User?           @relation("SubOrderStatusActor", fields: [actorUserId], references: [id], onDelete: SetNull)
+  actorRole   String          @map("actor_role") @db.VarChar(20)
+  note        String?         @db.VarChar(500)
+  createdAt   DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)
+
+  @@index([subOrderId, createdAt])
+  @@map("sub_order_status_history")
+}
+
 /// Immutable order line. Every value that can change later (title, variant,
 /// price, discount, commission) is captured as a snapshot at placement time, so
 /// editing a product never rewrites history. `productVariantId` is nullable with
 /// SET NULL: the line survives even if the variant is removed from the catalog.
 model OrderItem {
-  id                     String          @id @default(uuid()) @db.Uuid
-  subOrderId             String          @map("sub_order_id") @db.Uuid
-  subOrder               SubOrder        @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
-  productVariantId       String?         @map("product_variant_id") @db.Uuid
-  productVariant         ProductVariant? @relation(fields: [productVariantId], references: [id], onDelete: SetNull)
-  productTitleSnapshot   String          @map("product_title_snapshot") @db.VarChar(200)
+  id                      String          @id @default(uuid()) @db.Uuid
+  subOrderId              String          @map("sub_order_id") @db.Uuid
+  subOrder                SubOrder        @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
+  productVariantId        String?         @map("product_variant_id") @db.Uuid
+  productVariant          ProductVariant? @relation(fields: [productVariantId], references: [id], onDelete: SetNull)
+  productTitleSnapshot    String          @map("product_title_snapshot") @db.VarChar(200)
+  vendorStoreNameSnapshot String          @map("vendor_store_name_snapshot") @db.VarChar(120)
+  /// SKU at checkout; the variant row may later change or disappear.
+  skuSnapshot             String          @map("sku_snapshot") @db.VarChar(64)
   /// { colorName, colorHex, size, guarantee } captured at checkout.
-  variantDetailsSnapshot Json            @map("variant_details_snapshot")
-  unitPriceSnapshot      Decimal         @map("unit_price_snapshot") @db.Decimal(15, 2)
-  discountSnapshot       Decimal         @default(0) @map("discount_snapshot") @db.Decimal(15, 2)
-  commissionRateSnapshot Decimal         @map("commission_rate_snapshot") @db.Decimal(5, 2)
-  quantity               Int
-  totalLineAmount        Decimal         @map("total_line_amount") @db.Decimal(15, 2)
-  createdAt              DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)
+  variantDetailsSnapshot  Json            @map("variant_details_snapshot")
+  unitPriceSnapshot       Decimal         @map("unit_price_snapshot") @db.Decimal(15, 2)
+  discountSnapshot        Decimal         @default(0) @map("discount_snapshot") @db.Decimal(15, 2)
+  commissionRateSnapshot  Decimal         @map("commission_rate_snapshot") @db.Decimal(5, 2)
+  quantity                Int
+  totalLineAmount         Decimal         @map("total_line_amount") @db.Decimal(15, 2)
+  createdAt               DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)
 
   @@index([subOrderId])
   @@index([productVariantId])
diff --git a/apps/backend/src/app.module.ts b/apps/backend/src/app.module.ts
index 95bfe12..3cd9416 100644
--- a/apps/backend/src/app.module.ts
+++ b/apps/backend/src/app.module.ts
@@ -18,6 +18,10 @@ import { UsersModule } from './modules/users/users.module';
 import { VendorsModule } from './modules/vendors/vendors.module';
 import { CategoriesModule } from './modules/categories/categories.module';
 import { ProductsModule } from './modules/products/products.module';
+import { ShippingModule } from './modules/shipping/shipping.module';
+import { AddressesModule } from './modules/addresses/addresses.module';
+import { CartModule } from './modules/cart/cart.module';
+import { OrdersModule } from './modules/orders/orders.module';
 
 @Module({
   imports: [
@@ -44,6 +48,10 @@ import { ProductsModule } from './modules/products/products.module';
     VendorsModule,
     CategoriesModule,
     ProductsModule,
+    ShippingModule,
+    AddressesModule,
+    CartModule,
+    OrdersModule,
   ],
   providers: [
     // Order matters: authentication runs first and populates `request.user`,
diff --git a/apps/backend/src/common/decorators/current-user.decorator.ts b/apps/backend/src/common/decorators/current-user.decorator.ts
index 02e8f1f..fb4e211 100644
--- a/apps/backend/src/common/decorators/current-user.decorator.ts
+++ b/apps/backend/src/common/decorators/current-user.decorator.ts
@@ -45,3 +45,16 @@ export const ClientContext = createParamDecorator(
     };
   },
 );
+
+/**
+ * Injects the identity on a `@Public()` route when the caller sent a valid
+ * access token, and `undefined` otherwise. Used by endpoints that serve guests
+ * and signed-in users alike (the cart). On public routes `JwtAuthGuard` treats a
+ * missing, invalid or expired token the same way — the caller is anonymous — so
+ * a client whose access token lapsed keeps working with its guest cart token
+ * until it refreshes the session.
+ */
+export const OptionalUser = createParamDecorator(
+  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
+    context.switchToHttp().getRequest<RequestWithIdentity>().user,
+);
diff --git a/apps/backend/src/config/env.validation.spec.ts b/apps/backend/src/config/env.validation.spec.ts
index 708a0f4..f6598db 100644
--- a/apps/backend/src/config/env.validation.spec.ts
+++ b/apps/backend/src/config/env.validation.spec.ts
@@ -17,9 +17,29 @@ const VALID_ENV: Record<string, unknown> = {
   LOG_LEVEL: 'debug',
   JWT_ACCESS_SECRET: 'a'.repeat(48),
   JWT_REFRESH_SECRET: 'b'.repeat(48),
+  SHIPPING_DEFAULT_FEE_PER_VENDOR: '500000',
+  SHIPPING_FREE_THRESHOLD_PER_VENDOR: '10000000',
 };
 
 describe('validateEnvironment', () => {
+  it('requires the shipping fee settings and validates the order lifecycle timings', () => {
+    const withoutFee: Record<string, unknown> = { ...VALID_ENV };
+    delete withoutFee.SHIPPING_DEFAULT_FEE_PER_VENDOR;
+    expect(() => validateEnvironment(withoutFee)).toThrow(/SHIPPING_DEFAULT_FEE_PER_VENDOR/);
+    expect(() => validateEnvironment({ ...VALID_ENV, SHIPPING_FREE_THRESHOLD_PER_VENDOR: '-1' })).toThrow(
+      /SHIPPING_FREE_THRESHOLD_PER_VENDOR/,
+    );
+    expect(() => validateEnvironment({ ...VALID_ENV, ORDER_PAYMENT_TIMEOUT_MINUTES: '1' })).toThrow(
+      /ORDER_PAYMENT_TIMEOUT_MINUTES/,
+    );
+
+    const config = validateEnvironment(VALID_ENV);
+    expect(config.SHIPPING_DEFAULT_FEE_PER_VENDOR).toBe(500_000);
+    expect(config.SHIPPING_FREE_THRESHOLD_PER_VENDOR).toBe(10_000_000);
+    expect(config.ORDER_PAYMENT_TIMEOUT_MINUTES).toBe(30);
+    expect(config.ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS).toBe(60);
+  });
+
   it('accepts a complete configuration and coerces numeric values', () => {
     const config = validateEnvironment(VALID_ENV);
 
diff --git a/apps/backend/src/config/env.validation.ts b/apps/backend/src/config/env.validation.ts
index 8accd8a..32cd4b9 100644
--- a/apps/backend/src/config/env.validation.ts
+++ b/apps/backend/src/config/env.validation.ts
@@ -5,6 +5,7 @@ import {
   IsEnum,
   IsIn,
   IsInt,
+  IsNumber,
   IsOptional,
   IsString,
   Matches,
@@ -305,6 +306,41 @@ export class EnvironmentVariables {
   @Max(100 * 1024 * 1024)
   MEDIA_MAX_DOCUMENT_BYTES: number = 10_485_760;
 
+  // ─── Commerce: shipping and order lifecycle ────────────────────────────────
+  /**
+   * Platform default shipping fee per store package, in the platform currency
+   * (`platform.currency`, IRR). Fallback when the `system_configs` key
+   * `shipping.default_fee_per_vendor` is absent. Required: the fee is a business
+   * value and has no code default.
+   */
+  @Type(() => Number)
+  @IsNumber({ maxDecimalPlaces: 2 })
+  @Min(0)
+  SHIPPING_DEFAULT_FEE_PER_VENDOR!: number;
+
+  /**
+   * Store-package subtotal at which shipping becomes free (platform currency);
+   * `0` disables free shipping. Fallback for `shipping.free_threshold_per_vendor`.
+   */
+  @Type(() => Number)
+  @IsNumber({ maxDecimalPlaces: 2 })
+  @Min(0)
+  SHIPPING_FREE_THRESHOLD_PER_VENDOR!: number;
+
+  /** Minutes an unpaid order keeps its stock reservation before it is cancelled. */
+  @Type(() => Number)
+  @IsInt()
+  @Min(5)
+  @Max(24 * 60)
+  ORDER_PAYMENT_TIMEOUT_MINUTES: number = 30;
+
+  /** How often the expiry sweeper runs, in seconds; `0` disables it on this instance. */
+  @Type(() => Number)
+  @IsInt()
+  @Min(0)
+  @Max(3600)
+  ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS: number = 60;
+
   @IsOptional()
   @IsIn(LOG_LEVELS, { message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
   LOG_LEVEL?: LogLevelName;
diff --git a/apps/backend/src/setup/app.setup.ts b/apps/backend/src/setup/app.setup.ts
index b7503f6..89dd33a 100644
--- a/apps/backend/src/setup/app.setup.ts
+++ b/apps/backend/src/setup/app.setup.ts
@@ -106,6 +106,12 @@ export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
       .addTag('products', 'Public catalogue search, filtering and product pages')
       .addTag('vendor-products', "A vendor's own products, variant matrix and stock")
       .addTag('admin-products', 'Staff product review and moderation')
+      .addTag('customer-addresses', "A customer's address book (copied into orders at checkout)")
+      .addTag('cart', 'Guest and account cart, grouped by store, with live stock and price checks')
+      .addTag('orders', 'Checkout: one order, one package per store, stock reserved in one transaction')
+      .addTag('customer-orders', "A customer's orders, tracking and cancellation of unpaid orders")
+      .addTag('vendor-orders', "A store's paid packages and fulfilment status")
+      .addTag('admin-orders', 'Staff order search and forced package resolutions')
       .build(),
   );
 }
diff --git a/apps/backend/test/catalog.e2e-spec.ts b/apps/backend/test/catalog.e2e-spec.ts
index f243723..cb9da84 100644
--- a/apps/backend/test/catalog.e2e-spec.ts
+++ b/apps/backend/test/catalog.e2e-spec.ts
@@ -1167,7 +1167,10 @@ describe('Phase 5 — categories, product catalogue and discovery (live stack)',
       expect(slugs(zero)).toEqual(slugs(await search({ ...inRoot, sortBy: 'newest' })));
 
       const line = async (suffix: string, sku: string, quantity: number, status: SubOrderStatus): Promise<void> => {
-        const variant = await prisma.productVariant.findUniqueOrThrow({ where: { sku }, include: { product: true } });
+        const variant = await prisma.productVariant.findUniqueOrThrow({
+          where: { sku },
+          include: { product: { include: { vendor: true } } },
+        });
         const amount = variant.price.mul(quantity);
         await prisma.parentOrder.create({
           data: {
@@ -1190,6 +1193,8 @@ describe('Phase 5 — categories, product catalogue and discovery (live stack)',
                   create: {
                     productVariantId: variant.id,
                     productTitleSnapshot: variant.product.title,
+                    vendorStoreNameSnapshot: variant.product.vendor.storeName,
+                    skuSnapshot: variant.sku,
                     variantDetailsSnapshot: {},
                     unitPriceSnapshot: variant.price,
                     discountSnapshot: 0,
diff --git a/apps/backend/test/jest-e2e.json b/apps/backend/test/jest-e2e.json
index 0527afd..63667b2 100644
--- a/apps/backend/test/jest-e2e.json
+++ b/apps/backend/test/jest-e2e.json
@@ -1,9 +1,15 @@
 {
-  "moduleFileExtensions": ["js", "json", "ts"],
+  "moduleFileExtensions": [
+    "js",
+    "json",
+    "ts"
+  ],
   "rootDir": ".",
   "testEnvironment": "node",
   "testRegex": ".e2e-spec.ts$",
-  "setupFiles": ["<rootDir>/setup-env.ts"],
+  "setupFiles": [
+    "<rootDir>/setup-env.ts"
+  ],
   "transform": {
     "^.+\\.(t|j)s$": [
       "ts-jest",
@@ -12,5 +18,7 @@
       }
     ]
   },
-  "testTimeout": 30000
+  "testTimeout": 30000,
+  "maxWorkers": 1,
+  "workerIdleMemoryLimit": "350MB"
 }
diff --git a/apps/backend/test/schema-integrity.e2e-spec.ts b/apps/backend/test/schema-integrity.e2e-spec.ts
index 583b11a..855a8ef 100644
--- a/apps/backend/test/schema-integrity.e2e-spec.ts
+++ b/apps/backend/test/schema-integrity.e2e-spec.ts
@@ -84,10 +84,12 @@ describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
         const cart = await tx.cart.create({ data: { userId: customer.id } });
         const variant = await tx.productVariant.findFirstOrThrow({
           where: { stockQuantity: { gt: 0 } },
-          include: { product: true },
+          include: { product: { include: { vendor: true } } },
         });
         const quantity = 2;
-        await tx.cartItem.create({ data: { cartId: cart.id, productVariantId: variant.id, quantity } });
+        await tx.cartItem.create({
+          data: { cartId: cart.id, productVariantId: variant.id, quantity, unitPriceSnapshot: variant.price },
+        });
 
         // ── money split (Decimal arithmetic end to end, no floating point) ───
         const unitPrice = variant.price;
@@ -137,6 +139,8 @@ describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
             subOrderId: subOrder.id,
             productVariantId: variant.id,
             productTitleSnapshot: variant.product.title,
+            vendorStoreNameSnapshot: variant.product.vendor.storeName,
+            skuSnapshot: variant.sku,
             variantDetailsSnapshot: {
               colorName: variant.colorName,
               colorHex: variant.colorHex,
```
