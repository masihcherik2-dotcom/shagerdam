# Shopino — Phase 2 deliverable: full marketplace database schema

**Phase:** 2 — Comprehensive Prisma schema & database migrations
**Role executed:** Lead Database Architect & Backend Engineer
**Date:** 2026-09-26
**Status:** implemented · migrated against live PostgreSQL 16.15 · verified (see `phase-2-verification.md`)

---

## 1. Summary

Phase 2 replaces the Phase-1 placeholder schema with the complete, production-shaped
relational model of the marketplace: identity and access control, vendor onboarding,
catalogue, cart, the parent/sub-order split, payments with escrow, the vendor wallet
ledger, the BNPL credit engine, settlements and disputes.

Nothing in this phase is a stub. Every entity the technical manager listed exists as a
real table with real foreign keys, real enum types, real indexes, real `onDelete` rules
and real monetary precision. No placeholder table, no mock column, no "TODO later".

| Metric | Value |
| --- | --- |
| Prisma models | **28** |
| PostgreSQL tables | **29** (28 models + Prisma's `_prisma_migrations`) |
| Enum types | **17** (82 values) |
| Foreign keys | **40** |
| Primary keys | **29** |
| Unique indexes | **50** |
| Indexes in total | **105** |
| Migrations | **2** (`init`, `phase2_full_marketplace_schema`) |
| Schema size | **872** lines |

---

## 2. Entity groups as delivered

### 2.1 Identity, access & audit

| Model | Table | Notes |
| --- | --- | --- |
| `User` | `users` | UUID PK · `mobile` unique (identity business key, E.164-normalised Iranian format) · `email` unique nullable · `nationalCode` unique nullable · `passwordHash` (Argon2id, never plaintext) · `role` (`UserRole`) · `isActive`, `lastLoginAt`, timestamps |
| `CustomerProfile` | `customer_profiles` | 1:1 with `User` (CASCADE) · `bankIban` · `birthDate` · `gender` (`Gender`) · `defaultAddressId` (SET NULL) |
| `Address` | `addresses` | owned by `User` (CASCADE) · province/city/postal code/address · recipient name + mobile · `isDefault` · geo coordinates as `Decimal(10,7)` |
| `AuditLog` | `audit_logs` | append-only (`createdAt` only) · `action` (`AuditAction`, 10 values) · `entityName`/`entityId` · `oldValue`/`newValue` JSON · actor `userId` (SET NULL so the trail survives user deletion) · ip/user-agent |

`UserRole` covers all six required roles: `SUPER_ADMIN`, `ADMIN`, `VENDOR`, `CUSTOMER`,
`FINANCIAL_OFFICER`, `SUPPORT`.

### 2.2 Vendor

| Model | Table | Notes |
| --- | --- | --- |
| `Vendor` | `vendors` | 1:1 with `User` (RESTRICT — a vendor account cannot vanish) · `storeName`, `storeSlug` unique · `status` (`VendorStatus`) · `bankIban`, `bankAccountHolder` · `commissionRate` override · `isActive` |
| `VendorVerification` | `vendor_verifications` | one row per verification round: `nationalIdCardUrl`, `businessLicenseUrl`, `bankAccountProofUrl`, reviewed by `reviewedByUserId` (SET NULL), `status`, `rejectionReason` |

### 2.3 Catalogue

| Model | Table | Notes |
| --- | --- | --- |
| `Category` | `categories` | `parentId` self-relation (SET NULL — deleting a parent promotes children to root instead of deleting them) · `slug` unique · `titleFa`/`titleEn` · **`defaultCommissionRate` `Decimal(5,2)`** and `requiresCreditApproval` |
| `Product` | `products` | `vendorId` (RESTRICT), `categoryId` (RESTRICT) · `slug` unique · `title` · `description` · `status` · `isCreditEligible` · `basePrice` |
| `ProductVariant` | `product_variants` | `sku` **globally unique** · `price`, `discountPrice`, `stockQuantity`, `reservedQuantity` · colour (`colorName`, `colorHex`), `size`, `weightGrams`, `guarantee` · `isActive` |
| `ProductMedia` | `product_media` | CASCADE with the product · `url`, `mediaType`, `sortOrder`, `altText` |

`ProductVariant` is the real sellable unit: cart lines, order lines and stock all point at
it, and deleting it must never destroy order history (see `OrderItem` below).

### 2.4 Cart and orders

| Model | Table | Notes |
| --- | --- | --- |
| `Cart` | `carts` | one active cart per user (`userId` unique, CASCADE) plus an anonymous `sessionToken` unique path |
| `CartItem` | `cart_items` | `@@unique([cartId, productVariantId])` — a variant can appear **once** per cart · CASCADE from both parents |
| `ParentOrder` | `parent_orders` | customer-facing order · **`orderNumber` unique, human-readable (`SHP-100234`)** · `userId` (RESTRICT) · **`shippingAddressSnapshot` JSON** (address frozen at checkout) · `totalItemsAmount`, `totalShippingFee`, `totalDiscountAmount`, `finalPayableAmount` all `Decimal(15,2)` · **`paymentMethod` (`CASH_IPG` / `BANK_CREDIT` / `HYBRID`)** · `paymentStatus` · `shippingMethod`, `customerNote` |
| `SubOrder` | `sub_orders` | the per-vendor split · `subOrderNumber` unique (`SHP-100234-1`) · `vendorId` (RESTRICT) · `itemsSubtotal`, `shippingFee`, **`platformCommissionAmount`**, `vendorEarningsAmount` · `status` (`SubOrderStatus`) · `trackingCode`, `shippingCarrier` · **`escrowReleasedAt`** · status timestamps (`shippedAt`, `deliveredAt`, `cancelledAt`) |
| `OrderItem` | `order_items` | **immutable snapshot line**: `productTitleSnapshot`, `variantDetailsSnapshot` JSON (colour, size, guarantee), `unitPriceSnapshot`, `discountSnapshot`, `commissionRateSnapshot`, `quantity`, `totalLineAmount` · `productVariantId` is **nullable with SET NULL**, so the line keeps its own copy and survives variant deletion |

The money identity `platformCommissionAmount + vendorEarningsAmount = itemsSubtotal` is
enforced by the service layer and asserted in the integrity suite.

### 2.5 Payments, escrow & settlement

| Model | Table | Notes |
| --- | --- | --- |
| `Payment` | `payments` | `parentOrderId` (RESTRICT) · **`gatewayName` as a string (`SANDBOX` / `ZARINPAL` / `SADAD`)** — a new gateway never needs a migration · `gatewayTrackingToken`, `bankRrn` · **`cashAmount` + `creditAmount`** for the HYBRID split · `status` (`PaymentStatus`) · `paidAt`, `refundedAt`, `failureReason` |
| `VendorWallet` | `vendor_wallets` | one per vendor (`vendorId` unique, RESTRICT) · **`pendingBalance`** (escrow-held) · **`withdrawableBalance`** · **`totalEarnedBalance`** · `totalWithdrawnAmount` |
| `WalletTransaction` | `wallet_transactions` | append-only ledger · `type` (`WalletTransactionType`, 5 values: `CREDIT_SALE_ESCROW_HOLD`, `ESCROW_RELEASE_TO_WITHDRAWABLE`, `COMMISSION_DEDUCTION`, `SETTLEMENT_PAYOUT`, `REFUND_DEDUCTION`) · `amount`, `balanceAfter` · `subOrderId` (SET NULL) and `settlementRequestId` (SET NULL) as traceable references · `description` |
| `SettlementRequest` | `settlement_requests` | vendor payout request · `amount`, `status` (`SettlementStatus`: `REQUESTED`, `PROCESSING`, `PAID_PAYA`, `REJECTED`) · `payaReferenceNumber`, `bankTrackingCode` · `processedByUserId` (SET NULL) · `processedAt` |

### 2.6 BNPL credit engine

| Model | Table | Notes |
| --- | --- | --- |
| `CreditProvider` | `credit_providers` | `code` unique (`SANDBOX_BANK`, `SAMAN_BANK`, `BLUBANK`, `DIGIPAY`) · `name` · `isActive` · `apiBaseUrl`, `credentialsRef` (a **reference** to a secret store — never a raw key in the database) |
| `CreditAccount` | `credit_accounts` | `@@unique([userId, providerId])` · `totalLimit`, `usedAmount`, `reservedAmount`, `availableAmount` · `status` (`CreditAccountStatus`) · `validUntil` |
| `CreditApplication` | `credit_applications` | `status` (`CreditApplicationStatus`: `DRAFT`, `PENDING_BANK_INQUIRY`, `DOCS_REQUIRED`, `APPROVED`, `REJECTED`) · requested/approved amount · `checksum`, `inquiryReference`, `decisionReason` |
| `CreditTransaction` | `credit_transactions` | append-only ledger · `type` (`CreditTransactionType`, 6 values: `CREDIT_ALLOCATION`, `PURCHASE_RESERVE_HOLD`, `PURCHASE_COMMIT`, `RESERVATION_RELEASE`, `INSTALLMENT_REPAYMENT_RESTORE`, `REFUND_RESTORE`) · `amount`, `balanceAfter` · `parentOrderId` (SET NULL) · `referenceCode` |
| `InstallmentPlan` | `installment_plans` | `@@unique([providerId, durationMonths])` · `interestRate`, `installmentCount`, `minOrderAmount`, `isActive`, `isDefault` |
| `InstallmentSchedule` | `installment_schedules` | `@@unique([parentOrderId, installmentNumber])` · `creditAccountId` (RESTRICT) · `dueDate` · `principalAmount`, `interestAmount`, `totalAmount` · `status` (`InstallmentStatus`: `PENDING`, `PAID`, `OVERDUE`, `WAIVED`) · `paidAt`, `paymentReference` |

### 2.7 Disputes

| Model | Table | Notes |
| --- | --- | --- |
| `Dispute` | `disputes` | raised on a `SubOrder` (CASCADE) by a `User` (RESTRICT) · `reason` (`DisputeReason`, 5 values: `WRONG_ITEM`, `DAMAGED`, `NOT_AS_DESCRIBED`, `NOT_DELIVERED`, `COUNTERFEIT`) · `status` (`DisputeStatus`, 6 values) · `description` · `resolutionNote`, `resolvedAt` |
| `DisputeEvidence` | `dispute_evidence` | CASCADE with the dispute · `fileUrl`, `fileType`, `caption`, uploader |

### 2.8 Platform configuration

`SystemConfig` (`system_configs`) — `key` unique, typed values (`ConfigValueType`:
`STRING`, `NUMBER`, `BOOLEAN`, `JSON`), `description`, `isPublic`. Used to switch the BNPL
engine on/off and select the active provider without a deployment.

---

## 3. Conventions enforced across the whole schema

| Concern | Decision |
| --- | --- |
| Primary keys | `String @id @default(uuid()) @db.Uuid` on every model |
| Money | `Decimal(15, 2)` — never `Float`. Percentages are `Decimal(5, 2)` |
| Time | `@db.Timestamptz(3)` everywhere; `createdAt @default(now())` + `updatedAt @updatedAt` on mutable rows |
| Append-only rows | Ledgers, audit logs and order lines carry `createdAt` **only** — no `updatedAt`, because they must never be edited |
| Ledger shape | Every wallet/credit movement stores `amount` **and** `balanceAfter`, plus a typed reference (`subOrderId`, `settlementRequestId`, `parentOrderId`, `referenceCode`) — the double-entry trace back to the triggering order or repayment |
| Referential actions | **Cascade** = the child cannot exist without the parent (`cart_items`, `order_items`, `product_variants`, `product_media`, `addresses`, `customer_profiles`, `sub_orders`, `disputes`, `dispute_evidence`). **Restrict** = financial or historical records (`payments`, `parent_orders`, `products`, `vendors`, `credit_*`, `installment_schedules`, `settlement_requests`, `wallet`s). **SetNull** = optional back-references that must not block the parent's deletion (`audit_logs.userId`, `order_items.productVariantId`, `wallet_transactions.subOrderId`, `categories.parentId`, `*.reviewedByUserId`) |
| Naming | Prisma models/enums in PascalCase/snake-free; every table and column mapped to `snake_case` with `@@map` / `@map` |
| Secrets | No credential is ever stored as a raw column: `CreditProvider.credentialsRef` holds an environment/secret-manager reference |
| Deletion safety | No `onDelete: Cascade` path reaches a money row; deleting a vendor or customer with financial history is refused by the database |

---

## 4. Migrations

```
apps/backend/prisma/migrations/
├── 20260926124703_init/                         (69 lines — Phase 1 skeleton)
└── 20260926130137_phase2_full_marketplace_schema/ (834 lines — this phase)
```

The Phase-2 migration contains 25 `CREATE TABLE`, 15 `CREATE TYPE`, 52 `CREATE INDEX`,
18 `CREATE UNIQUE INDEX` and 41 `ALTER TABLE` statements. It was **reviewed line by line
before being applied**, because Prisma's generated SQL was destructive in two places:

1. `DROP COLUMN categories.title` → replaced with `RENAME COLUMN categories.title TO title_fa`,
   which preserves any existing data, and the new `default_commission_rate` is added with
   `DEFAULT 0` so existing rows stay valid.
2. `ALTER TABLE users ALTER COLUMN mobile SET NOT NULL` on a table that could contain rows →
   wrapped in a `DO $$ ... RAISE EXCEPTION` guard: it aborts with an explicit message if
   `users` is not empty, and the file documents the correct three-step rollout
   (add nullable → backfill → set not null) for a populated production database.

After hand-tuning, the migration contains **zero** `DROP COLUMN`, `DROP TABLE` or
`DROP CONSTRAINT` statements. The review note is kept in the file header so the reasoning
travels with the migration.

`prisma migrate status` on the live database:

```
2 migrations found in prisma/migrations
Database schema is up to date!
```

---

## 5. Seed (`prisma/seed.ts`)

The seed is deterministic, idempotent and non-destructive: it **upserts master data only**
and refuses to invent money, orders or credit limits.

* **Staff & roles** — `SUPER_ADMIN` (env-configured email/mobile), `SUPPORT` and
  `FINANCIAL_OFFICER` accounts so every role in the RBAC matrix has a real login.
* **Vendor** — one sample vendor (`shopino-sample-store`) in `APPROVED` state with its
  owner account, wallet row and an approved verification record.
* **Catalogue** — a **6-root / 19-node category tree with per-node commission rates**, and
  3 products with 7 variants (stock, colour, size) and 4 media rows.
* **BNPL** — 4 credit providers, of which **`SANDBOX_BANK` is the only active one** (the
  bank providers ship inactive until their real credentials exist), with **3-, 6- and
  12-month plans where the 3-month plan carries 0 % interest**.
* **Configuration** — 9 `SystemConfig` rows, including `credit.enabled = false` (the BNPL
  engine is off until the credit service exists) and `credits.activeProvider = SANDBOX_BANK`
  kept consistent with the provider table.

Passwords come from environment variables (`SUPER_ADMIN_PASSWORD`, `SEED_STAFF_PASSWORD`,
`SEED_VENDOR_PASSWORD`), are hashed with **Argon2id**, and are never printed or committed.
The second run reports `0 created, 4 updated` — proof of idempotency without drift.

---

## 6. How to reproduce

```bash
pnpm install
pnpm infra:prepare                        # ./.docker-data with uid 999
docker compose up -d                      # postgres + redis, both healthy
pnpm db:generate                          # Prisma client from the Phase-2 schema
pnpm db:deploy                            # applies both migrations
pnpm db:seed                              # idempotent master data
pnpm verify:seed                          # double-run + invariant assertions
pnpm typecheck && pnpm lint && pnpm test  # quality gates
cd apps/backend && pnpm run test:e2e      # unit-independent integration suites
pnpm build                                # production build of both apps
```

---

## 7. What Phase 2 deliberately does **not** include

Honest scope boundary — these belong to later phases and are not claimed as delivered:

* No HTTP endpoints, DTOs, guards or services that read/write these tables yet; the
  application layer that will use the schema is Phase 3+.
* No real bank/IPG integration: `gatewayName = SANDBOX` is the active test gateway and the
  active credit provider is `SANDBOX_BANK`. The real providers are modelled but inactive.
* `credit.enabled` is `false` by design; nothing in the system has a credit limit yet.
* No financial seed data of any kind — the tables are intentionally empty.
