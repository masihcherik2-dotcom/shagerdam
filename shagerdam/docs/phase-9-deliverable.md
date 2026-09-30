# Shopino — Phase 9 deliverable

**Scope:**
- customers open disputes about packages and attach private evidence;
- vendors defend (or accept the return), with their own evidence;
- earnings of a disputed package are frozen automatically in escrow (`DISPUTE_HOLD`);
- staff arbitrate, and the financial side is resolved automatically and atomically (wallet ledger, package status, stock, audit, refund notice).

**Base:** Phase 8 (`1438691`, approved).

**TM decisions applied:**
- **Dispute hold architecture (TM-approved):**
  - `VendorWallet.disputeHoldBalance` Decimal(15,2), default 0, with a DB CHECK ≥ 0;
  - new ledger types `DISPUTE_HOLD_LOCK` and `DISPUTE_HOLD_RELEASE`, and a new bucket `DISPUTE_HOLD`;
  - invariant `totalEarned = totalWithdrawn + withdrawable + settlementHold + disputeHold`, enforced by a DB CHECK and verified after every e2e step.
- **Doc names:** `docs/phase-9-deliverable.md` and `docs/phase-9-verification.md`.

**Conservative defaults (the clarifying question was skipped, so these were applied and are announced here):**
- An active dispute blocks every status change of its package with 409 `SUB_ORDER_UNDER_DISPUTE`. This covers vendor transitions, staff force-status and customer delivery confirmation.
- Staff who may arbitrate: `SUPPORT`, `ADMIN` and `SUPER_ADMIN`. `FINANCIAL_OFFICER` gets 403, following the TM's role list.
- Staff may decide any running dispute (`OPEN` or `UNDER_ARBITRATION`), including one the vendor never answered. The customer may cancel in the same states.
- A package may be disputed again after a **cancelled** dispute, but never after a **decided** one (`DISPUTE_ALREADY_DECIDED`).
- `VENDOR_RESPONDED` (an existing enum value) is not used: the vendor's answer either resolves the dispute or sends it to `UNDER_ARBITRATION`.
- **Customer cancel returns the hold to where it came from, and the package status stays unchanged.** For a DELIVERED package this is exactly the TM rule (hold → WITHDRAWABLE). For a PROCESSING/SHIPPED package the TM text says "DELIVERED + release"; that would pay the vendor for goods that were never delivered, so the hold goes back to escrow PENDING and the package keeps its status. **This is a deliberate deviation, announced for TM review.**
- A buyer-favour outcome on a credit-funded (BANK_CREDIT/HYBRID) package is refused with 409 `CREDIT_ORDER_REFUND_UNSUPPORTED`, and the hold stays in place. This is the same rule as every other refund path since Phase 8.
- Evidence must be the caller's own **private** upload with purpose `dispute_evidence` (JPEG/PNG/PDF through `POST /media/upload/document`).
- The refund notice is a transactional SMS sent **after commit**; its result is recorded in the dispute timeline as `REFUND_NOTICE_SENT` or `REFUND_NOTICE_FAILED`.
- `refundAmount` = the package's items + shipping. It is recorded as **owed to the customer**; the money itself is returned manually by finance (see §9).

**Active providers in this environment:** SMS `sandbox` and IPG `sandbox`. These are development/test providers: no SMS leaves the server and no money moves.

---

## 1. Module layout

```
apps/backend/src/modules/disputes/
├── dispute-policy.ts (+ spec)          pure rules: who may open / answer / arbitrate / cancel, restock rule,
│                                       refund amount, mobile masking
├── disputes.service.ts                 commands: open, cancel (customer), respond (vendor), arbitrate (staff);
│                                       parent-order lock first; ledger + lifecycle + dispute + audit in ONE tx
├── dispute-queries.service.ts          reads scoped per audience (customer / store / staff); 404 outside scope
├── dispute-views.ts                    Prisma selects + mappers (shared view, store view, staff dossier)
├── dispute-notifier.ts                 refund-notice SMS after commit + SENT/FAILED timeline event
├── dto/dispute.dto.ts                  validated inputs and documented responses
├── customer-disputes.controller.ts     customer/disputes, customer/disputes/:id, customer/disputes/:id/cancel
├── vendor-disputes.controller.ts       vendor/disputes, vendor/disputes/:id, vendor/disputes/:id/respond
├── admin-disputes.controller.ts        admin/disputes, admin/disputes/:id, admin/disputes/:id/arbitrate
└── disputes.module.ts                  imports OrdersModule (lifecycle), WalletModule (ledger), SmsModule
```

**Changed files:**

- `wallet/wallet-math.ts`: the escrow state of a package (`NONE / HELD / RELEASED / REVERSED / FROZEN`) is derived from its ledger rows across 5 types. The result does not depend on row order and handles cancel → refreeze.
- `wallet/wallet-ledger.service.ts`:
  - `dispute_hold_balance` is part of the locked row and of every post;
  - new `freezeForDispute`, `refundDisputeHold` and `releaseDisputeHold`;
  - `releaseEscrow` and `reverseEscrow` refuse a FROZEN package (409 `ESCROW_FROZEN_BY_DISPUTE`).
- `orders/order-lifecycle.service.ts`:
  - new `applyDisputeOutcomeLocked(tx, subOrderId, REFUNDED|DELIVERED, meta, outcome)`. It runs inside the dispute's transaction; the dispute supplies the restock decision and the wallet movement.
  - Every other transition checks for an active dispute first and returns 409 `SUB_ORDER_UNDER_DISPUTE`.
- `orders/dto/order-response.dto.ts`: `walletAction` gains `DISPUTE_HOLD_REFUNDED` and `DISPUTE_HOLD_RELEASED`.
- `orders/order-audit.ts`: entity name `Dispute`.
- `wallet/wallet.service.ts`, `wallet/dto/wallet.dto.ts`: `disputeHoldBalance` in the vendor wallet.
- `financial/financial.service.ts`, `financial/dto/financial.dto.ts`:
  - `wallets.disputeHold`;
  - the ledger-consistency check covers the new bucket;
  - new section `disputes {open, underArbitration, resolvedForBuyer, refundsOwedToCustomers, unrecoveredVendorEarnings}`.
- `media/media.controller.ts`: new document purpose `dispute_evidence`.
- `media/media.service.ts`: `canAccessPrivateAsset` also lets **both parties of a dispute** read its evidence (the customer who raised it and the owner of the store), in addition to the owner and staff.
- `app.module.ts`; `setup/app.setup.ts`: Swagger tags `customer-disputes`, `vendor-disputes` and `admin-disputes`.
- `prisma/schema.prisma` + 2 migrations (§8).
- Tests:
  - new: `disputes/dispute-policy.spec.ts`, `test/disputes.e2e-spec.ts`;
  - extended: `wallet-math.spec.ts` (escrow-state table), `media.service.spec.ts` (dispute-party access);
  - `finance.e2e-spec.ts`: reconciliation map with `DISPUTE_HOLD`;
  - `schema-integrity.e2e-spec.ts`: the dispute fixture now has the Phase 9 shape.

## 2. Endpoints (`/api/v1`)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `customer/disputes` | CUSTOMER | `{subOrderId, reason, description, evidenceUrls[]}` → dispute OPEN, evidence stored, escrow frozen (one transaction) |
| GET | `customer/disputes` | CUSTOMER | My disputes (filter `status`), each with the store's answer, the outcome and the timeline |
| GET | `customer/disputes/:id` | CUSTOMER | Details, evidence of both parties, vendor response, outcome (`refundAmount`), timeline |
| POST | `customer/disputes/:id/cancel` | CUSTOMER | `{reason?}` → CANCELLED; the hold returns to its source |
| GET | `vendor/disputes` | VENDOR | Disputes against my store (filter `status`); customer mobile masked; hold per dispute |
| GET | `vendor/disputes/:id` | VENDOR | With the buyer's evidence (downloadable by the store) |
| POST | `vendor/disputes/:id/respond` | VENDOR | `{action: ACCEPT_RETURN\|REJECT_WITH_DEFENSE, defenseNotes, evidenceUrls?, itemReturned?}` |
| GET | `admin/disputes` | SUPPORT, ADMIN, SUPER_ADMIN | Filters `status`, `reason`, `vendorId`, `customerId`, `from`, `to` |
| GET | `admin/disputes/:id` | SUPPORT, ADMIN, SUPER_ADMIN | Full dossier: order + payments, items, package status history, complaint, defence, evidence, timeline, hold, the store's current wallet |
| POST | `admin/disputes/:id/arbitrate` | SUPPORT, ADMIN, SUPER_ADMIN | `{decision: BUYER_FAVOR\|VENDOR_FAVOR, resolutionNotes, itemReturned?}` |

Every state-changing call returns `{dispute, walletAction, subOrderStatus, stockAction}`. `walletAction` is one of `FROZEN`, `REFUNDED`, `RELEASED_TO_WITHDRAWABLE`, `RETURNED_TO_ESCROW` or `NONE`.

**Error codes:**

| Status | Codes |
|---|---|
| 400 | validation errors; `EVIDENCE_NOT_ACCEPTED` (not the caller's own private `dispute_evidence` upload) |
| 401 / 403 | missing token / wrong role (customers, vendors and finance officers cannot arbitrate) |
| 404 | package or dispute outside the caller's scope (existence is not revealed) |
| 409 | `ORDER_NOT_PAID`, `SUB_ORDER_NOT_DISPUTABLE`, `DISPUTE_ALREADY_ACTIVE`, `DISPUTE_ALREADY_DECIDED`, `DISPUTE_NOT_AWAITING_VENDOR`, `DISPUTE_ALREADY_CLOSED`, `DISPUTE_NOT_CANCELLABLE`, `SUB_ORDER_UNDER_DISPUTE`, `ESCROW_FROZEN_BY_DISPUTE`, `ESCROW_NOT_FREEZABLE`, `ESCROW_NOT_FROZEN`, `CREDIT_ORDER_REFUND_UNSUPPORTED` |
| 429 | more than 10 dispute attempts per customer per 24 h (Redis counter `dispute:open:count:<userId>`) |

## 3. Dispute state machine

```
            customer opens                 vendor REJECT_WITH_DEFENSE
(package) ─────────────────► OPEN ───────────────────────────────► UNDER_ARBITRATION
                              │ │                                       │      │
      vendor ACCEPT_RETURN ───┘ └── staff arbitrates ──┐                │      └─ staff VENDOR_FAVOR ─► RESOLVED_VENDOR_FAVOR
              │                                        │                └──────── staff BUYER_FAVOR ──► RESOLVED_BUYER_FAVOR
              └──────────────► RESOLVED_BUYER_FAVOR ◄──┘
customer cancel (OPEN / UNDER_ARBITRATION) ─► CANCELLED
```

**Opening rules:**
- the package must belong to the caller (otherwise 404);
- the order must be PAID;
- the package must be PROCESSING, SHIPPED or DELIVERED;
- at most one active dispute per package: checked under the lock, with a partial unique index as the DB backstop;
- no earlier decided dispute on the package.

**Concurrency:** every command first takes the **parent-order row lock** (`SELECT … FOR UPDATE`), the same lock that payment callbacks, the lifecycle and delivery confirmation take. The lock order stays parent → stock → wallet.

## 4. Money: freeze, refund, release

With E = the package's `vendorEarningsAmount`:

| Moment | Package | Ledger (all rows carry `dispute_id`) | Wallet effect |
|---|---|---|---|
| Open | PROCESSING / SHIPPED (escrow HELD) | `DISPUTE_HOLD_LOCK` PENDING −E, DISPUTE_HOLD +E | pending −E, disputeHold +E, earned +E |
| Open | DELIVERED (escrow RELEASED) | `DISPUTE_HOLD_LOCK` WITHDRAWABLE −H, DISPUTE_HOLD +H, where H = min(E, withdrawable) | withdrawable −H, disputeHold +H; the shortfall E − H is stored on the dispute (`holdShortfall`) and noted in the OPENED event |
| Buyer favour / vendor accept | → REFUNDED | `REFUND_DEDUCTION` DISPUTE_HOLD −H, then the shortfall is recovered from the current WITHDRAWABLE as far as possible (`REFUND_DEDUCTION` WITHDRAWABLE) | disputeHold −H, earned −(everything deducted); the rest is `refundUnrecoveredAmount` (vendor debt, shown to staff and in the financial overview) |
| Vendor favour | → DELIVERED (`deliveredAt`; `escrowReleasedAt` set if empty) | `DISPUTE_HOLD_RELEASE` DISPUTE_HOLD −H, WITHDRAWABLE +H | disputeHold −H, withdrawable +H |
| Customer cancel | unchanged | `DISPUTE_HOLD_RELEASE` DISPUTE_HOLD −H, back to the source bucket | from PENDING: pending +H, earned −H; from WITHDRAWABLE: withdrawable +H |

**Stock:**
- goods that never shipped (PROCESSING) are always restocked on buyer favour;
- shipped or delivered goods are restocked only when the decision states `itemReturned: true` (a lost parcel must not inflate stock).

**Audit:** both the `Dispute` and the `SubOrder` get a `DISPUTE_RESOLUTION` row with hold, deduction, recovery, unrecovered amount and restock details. Open and cancel are audited on the `Dispute` inside the same transaction; the controllers use `@SkipAudit()`.

**Escrow guard:** `releaseEscrow` / `reverseEscrow` refuse a FROZEN package, so no older code path can pay out or reverse disputed earnings. That includes delivery confirmation (whose status guard already returns `SUB_ORDER_UNDER_DISPUTE` first).

## 5. Evidence

- The file is uploaded with `POST /media/upload/document`, `purpose=dispute_evidence` (JPEG / PNG / PDF, magic-byte checked, private, never public).
- The returned url (`/api/v1/media/documents/<id>/download`) is sent in `evidenceUrls[]` (max 10, unique).
- The service accepts only the caller's own, private `dispute_evidence` documents. Someone else's file or a KYC document gets 400 `EVIDENCE_NOT_ACCEPTED`, because attaching it would expose it to the other party.
- Download goes through the existing authenticated route. Access: the owner, staff, and **both parties of the dispute the file is attached to**; everyone else gets 403. Every download is audited, as in Phase 3.

## 6. Refund notice

- After a buyer-favour decision commits, `DisputeNotifier` sends the customer this transactional SMS: `شاپینو: اختلاف مرسولهٔ {subOrderNumber} به نفع شما حل شد. مبلغ {amount} ریال به شما بازگردانده می‌شود.`
- The outcome is appended to the timeline: `REFUND_NOTICE_SENT` (provider + reference) or `REFUND_NOTICE_FAILED`.
- An SMS outage never rolls back the decision.

## 7. Configuration

| Key | Where | Value | Meaning |
|---|---|---|---|
| `MAX_DISPUTES_PER_DAY` | `dispute-policy.ts` | 10 | Dispute attempts per customer per rolling 24 h (Redis) |
| `MAX_EVIDENCE_PER_REQUEST` | `dispute-policy.ts` | 10 | Evidence files per request |
| `SMS_PROVIDER` | env (existing) | `sandbox` here | Channel of the refund notice |

No new environment variables.

## 8. Schema changes

**Migration `20261001090000_phase9_disputes`:**
- enums `DisputeVendorAction` and `DisputeEventType`;
- new enum values `WalletBalanceBucket.DISPUTE_HOLD`, `WalletTransactionType.DISPUTE_HOLD_LOCK` and `DISPUTE_HOLD_RELEASE`;
- `vendor_wallets.dispute_hold_balance`;
- `wallet_transactions.dispute_id` (FK SET NULL, indexed);
- `disputes` columns: `vendor_id` (FK Restrict), `sub_order_status_at_open`, `hold_source`, `hold_amount`, `hold_shortfall`, vendor response columns, resolution columns (`resolved_by_user_id`, `item_returned`, `restocked`, `refund_amount`, `refund_unrecovered_amount`) and `cancelled_at`;
- new table `dispute_events` (the timeline);
- `dispute_evidence.media_asset_id` with unique `(dispute_id, media_asset_id)`;
- CHECKs:
  - wallet: dispute hold ≥ 0, and `total_earned >= withdrawn + withdrawable + dispute_hold`;
  - disputes: partial unique "one active dispute per package"; amounts ≥ 0;
  - hold shape: `hold_source` NULL ⇔ amount 0, otherwise PENDING/WITHDRAWABLE with amount > 0;
  - `status_at_open` ∈ {PROCESSING, SHIPPED, DELIVERED}; resolved ⇒ `resolved_at`; CANCELLED ⇒ `cancelled_at`; `refund_amount` only for buyer favour.

**Migration `20261001090100_phase9_dispute_ledger_rules`** (separate because PostgreSQL cannot use an enum value in the migration that adds it):
- unique `(dispute_id, type, bucket)`, which makes every dispute movement idempotent;
- dispute types and the DISPUTE_HOLD bucket require `dispute_id`;
- the DISPUTE_HOLD bucket may only be moved by LOCK, RELEASE or REFUND_DEDUCTION.

## 9. Not done in this phase (stated honestly)

- **The customer's money is not paid back automatically.** The decision records `refundAmount` (items + shipping) and the financial overview lists `refundsOwedToCustomers`. The actual bank refund is done manually by finance, because no refund API of the IPG is integrated (the Phase 7 limitation still applies).
- **Unrecovered vendor earnings** (money the vendor had already withdrawn and that no later earnings covered) are recorded as `refundUnrecoveredAmount` and reported. Nothing collects them automatically from future earnings, because that needs a TM decision (a vendor debt ledger).
- **Credit-funded packages cannot be resolved for the buyer** (409 `CREDIT_ORDER_REFUND_UNSUPPORTED`; the Phase 8 limitation). The hold stays until a reverse credit flow is decided.
- **No SLA / auto-escalation:** an OPEN dispute the vendor never answers waits for staff; there is no timer.
- **No partial refunds**; decisions cover the whole package.
- **No notifications to the vendor** (the SMS covers only the buyer's refund notice). **No frontend pages** (backend phase).
- `VENDOR_RESPONDED` remains in the enum but is unused.

## 10. Complete source files

New files are listed in full. For changed files the full current content is listed; the exact diff against `1438691` follows in §11.

### `apps/backend/prisma/migrations/20261001090000_phase9_disputes/migration.sql`

```sql
-- Phase 9: disputes, evidence, dispute timeline and the DISPUTE_HOLD wallet bucket.
--
-- New enum values (DISPUTE_HOLD, DISPUTE_HOLD_LOCK, DISPUTE_HOLD_RELEASE) are only
-- *added* here: PostgreSQL forbids using a freshly added enum value in the same
-- transaction, so the rules that mention them live in the next migration
-- (20261001090100_phase9_dispute_ledger_rules).
--
-- No dispute rows existed before Phase 9 (no endpoint created them), so the new
-- NOT NULL columns of "disputes" need no backfill.

-- CreateEnum
CREATE TYPE "DisputeVendorAction" AS ENUM ('ACCEPT_RETURN', 'REJECT_WITH_DEFENSE');

-- CreateEnum
CREATE TYPE "DisputeEventType" AS ENUM ('OPENED', 'EVIDENCE_ADDED', 'VENDOR_ACCEPTED_RETURN', 'VENDOR_DEFENDED', 'ARBITRATED_BUYER_FAVOR', 'ARBITRATED_VENDOR_FAVOR', 'CANCELLED_BY_CUSTOMER', 'REFUND_NOTICE_SENT', 'REFUND_NOTICE_FAILED');

-- AlterEnum
ALTER TYPE "WalletBalanceBucket" ADD VALUE 'DISPUTE_HOLD';

-- AlterEnum
ALTER TYPE "WalletTransactionType" ADD VALUE 'DISPUTE_HOLD_LOCK';
ALTER TYPE "WalletTransactionType" ADD VALUE 'DISPUTE_HOLD_RELEASE';

-- AlterTable
ALTER TABLE "dispute_evidence" ADD COLUMN     "media_asset_id" UUID;

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "hold_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "hold_shortfall" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "hold_source" "WalletBalanceBucket",
ADD COLUMN     "item_returned" BOOLEAN,
ADD COLUMN     "refund_amount" DECIMAL(15,2),
ADD COLUMN     "refund_unrecovered_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "resolved_by_user_id" UUID,
ADD COLUMN     "restocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sub_order_status_at_open" "SubOrderStatus" NOT NULL,
ADD COLUMN     "vendor_action" "DisputeVendorAction",
ADD COLUMN     "vendor_defense_notes" TEXT,
ADD COLUMN     "vendor_id" UUID NOT NULL,
ADD COLUMN     "vendor_responded_at" TIMESTAMPTZ(3),
ADD COLUMN     "vendor_responded_by_user_id" UUID;

-- AlterTable
ALTER TABLE "vendor_wallets" ADD COLUMN     "dispute_hold_balance" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "dispute_id" UUID;

-- CreateTable
CREATE TABLE "dispute_events" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "type" "DisputeEventType" NOT NULL,
    "actor_user_id" UUID,
    "actor_role" VARCHAR(20) NOT NULL,
    "from_status" "DisputeStatus",
    "to_status" "DisputeStatus",
    "note" VARCHAR(1000),
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispute_events_dispute_id_created_at_idx" ON "dispute_events"("dispute_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_evidence_media_asset_id_idx" ON "dispute_evidence"("media_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_evidence_dispute_id_media_asset_id_key" ON "dispute_evidence"("dispute_id", "media_asset_id");

-- CreateIndex
CREATE INDEX "disputes_vendor_id_status_created_at_idx" ON "disputes"("vendor_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_dispute_id_idx" ON "wallet_transactions"("dispute_id");

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_vendor_responded_by_user_id_fkey" FOREIGN KEY ("vendor_responded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Integrity rules the Prisma schema language cannot express ───────────────

-- The dispute hold is a balance like the others: never negative. And the
-- TM invariant: everything the vendor was credited with (totalEarned) covers
-- what was paid out plus what is withdrawable plus what is frozen by disputes.
ALTER TABLE "vendor_wallets"
  ADD CONSTRAINT "vendor_wallets_dispute_hold_non_negative" CHECK ("dispute_hold_balance" >= 0),
  ADD CONSTRAINT "vendor_wallets_earned_covers_balances" CHECK (
    "total_earned_balance" >= "total_withdrawn_amount" + "withdrawable_balance" + "dispute_hold_balance"
  );

-- At most one active dispute per package (OPEN / VENDOR_RESPONDED / UNDER_ARBITRATION).
CREATE UNIQUE INDEX "disputes_one_active_per_sub_order_key"
  ON "disputes"("sub_order_id")
  WHERE "status" IN ('OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION');

ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_amounts_non_negative" CHECK (
    "hold_amount" >= 0 AND "hold_shortfall" >= 0 AND "refund_unrecovered_amount" >= 0
    AND ("refund_amount" IS NULL OR "refund_amount" >= 0)
  ),
  ADD CONSTRAINT "disputes_hold_source_valid" CHECK (
    ("hold_source" IS NULL AND "hold_amount" = 0) OR ("hold_source" IN ('PENDING', 'WITHDRAWABLE') AND "hold_amount" > 0)
  ),
  ADD CONSTRAINT "disputes_status_at_open_valid" CHECK ("sub_order_status_at_open" IN ('PROCESSING', 'SHIPPED', 'DELIVERED')),
  ADD CONSTRAINT "disputes_resolved_has_resolved_at" CHECK (
    "status" NOT IN ('RESOLVED_BUYER_FAVOR', 'RESOLVED_VENDOR_FAVOR') OR "resolved_at" IS NOT NULL
  ),
  ADD CONSTRAINT "disputes_cancelled_has_cancelled_at" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL),
  ADD CONSTRAINT "disputes_refund_only_buyer_favor" CHECK ("refund_amount" IS NULL OR "status" = 'RESOLVED_BUYER_FAVOR');

-- A dispute freezes, releases and refunds at most once per type and bucket.
CREATE UNIQUE INDEX "wallet_transactions_dispute_movement_key"
  ON "wallet_transactions"("dispute_id", "type", "bucket")
  WHERE "dispute_id" IS NOT NULL;
```

### `apps/backend/prisma/migrations/20261001090100_phase9_dispute_ledger_rules/migration.sql`

```sql
-- Phase 9 (part 2): ledger rules that reference the enum values added by
-- 20261001090000_phase9_disputes (they cannot be used in the migration that adds them).

-- Dispute movements always name their dispute, and the DISPUTE_HOLD bucket is only
-- moved by a dispute lock, a dispute release or a refund deduction.
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_dispute_rows_reference_dispute" CHECK (
    ("type" NOT IN ('DISPUTE_HOLD_LOCK', 'DISPUTE_HOLD_RELEASE') AND "bucket" <> 'DISPUTE_HOLD') OR "dispute_id" IS NOT NULL
  ),
  ADD CONSTRAINT "wallet_transactions_dispute_hold_bucket_types" CHECK (
    "bucket" <> 'DISPUTE_HOLD' OR "type" IN ('DISPUTE_HOLD_LOCK', 'DISPUTE_HOLD_RELEASE', 'REFUND_DEDUCTION')
  );
```

### `apps/backend/prisma/schema.prisma`

```prisma
// ============================================================================
// Shopino — Prisma schema
// Phase 2: complete marketplace + banking-credit (BNPL) data model
// ----------------------------------------------------------------------------
// Conventions applied throughout this file:
//
//  • Primary keys   — uuid v4 (`@default(uuid())`), stored as PostgreSQL UUID.
//  • Money          — `Decimal(15, 2)`, never floating point. The unit follows
//                     `platform.currency` in SystemConfig (IRR = Rial).
//  • Percentages    — `Decimal(5, 2)` (0.00–100.00).
//  • Timestamps     — `timestamptz(3)`. Mutable rows carry `createdAt` +
//                     `@updatedAt`; append-only rows (ledgers, audit trail,
//                     order lines) carry `createdAt` only, because rewriting
//                     them would destroy their evidential value.
//  • Foreign keys   — every relation declares `onDelete` explicitly:
//                       Cascade  → the child cannot exist without the parent
//                                  (order lines, cart lines, media, evidence),
//                       Restrict → financial/legal records that must never be
//                                  orphaned or silently disappear (payments,
//                                  ledger entries, settlements),
//                       SetNull  → optional back-references that may outlive
//                                  their target (ledger → order link).
//  • Table names    — snake_case plural (`@@map`), columns snake_case (`@map`).
//
// The schema is applied exclusively through migrations
// (`prisma migrate dev` / `prisma migrate deploy`); see README §5.
// ============================================================================

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// ============================================================================
// 1. IDENTITY, ACCESS & AUDIT
// ============================================================================

/// Platform identity. One row per human, whatever their role.
enum UserRole {
  SUPER_ADMIN
  ADMIN
  VENDOR
  CUSTOMER
  FINANCIAL_OFFICER
  SUPPORT
}

enum Gender {
  MALE
  FEMALE
  OTHER
}

/// Actions recorded in the immutable audit trail.
enum AuditAction {
  CREATE
  UPDATE
  DELETE
  LOGIN
  LOGOUT
  STATUS_CHANGE
  SETTLEMENT_TRIGGER
  PAYMENT_CAPTURE
  CREDIT_DECISION
  DISPUTE_RESOLUTION
}

/// Platform user. `mobile` is the primary business key: it is mandatory, unique
/// and the identifier customers register with. `email` and `nationalCode` are
/// optional but unique when present (they are required later in the process for
/// vendors and credit applicants).
model User {
  id           String    @id @default(uuid()) @db.Uuid
  mobile       String    @unique @db.VarChar(15)
  email        String?   @unique @db.VarChar(254)
  nationalCode String?   @unique @map("national_code") @db.VarChar(10)
  fullName     String    @map("full_name") @db.VarChar(120)
  role         UserRole  @default(CUSTOMER)
  isActive     Boolean   @default(true) @map("is_active")
  /// Argon2id hash. Nullable because OTP-only customer accounts exist before a
  /// password is ever set; staff accounts always have one (enforced by the
  /// authentication phase).
  passwordHash String?   @map("password_hash") @db.VarChar(255)
  lastLoginAt  DateTime? @map("last_login_at") @db.Timestamptz(3)
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  customerProfile       CustomerProfile?
  addresses             Address[]
  vendor                Vendor?
  auditLogs             AuditLog[]
  carts                 Cart[]
  parentOrders          ParentOrder[]
  creditAccounts        CreditAccount[]
  creditApplications    CreditApplication[]
  disputesRaised        Dispute[]
  disputeEvidence       DisputeEvidence[]
  disputesResponded     Dispute[]               @relation("DisputeVendorResponder")
  disputesResolved      Dispute[]               @relation("DisputeResolver")
  disputeEvents         DisputeEvent[]
  verificationsReview   VendorVerification[]    @relation("VerificationReviewer")
  mediaAssets           MediaAsset[]            @relation("MediaAssetOwner")
  settlementsProcessed  SettlementRequest[]     @relation("SettlementProcessor")
  subOrderStatusChanges SubOrderStatusHistory[] @relation("SubOrderStatusActor")
  productsBlocked       Product[]               @relation("ProductBlockedBy")

  @@index([role, isActive])
  @@index([createdAt])
  @@map("users")
}

/// Role-specific customer data. Absent for staff and for vendors.
model CustomerProfile {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @unique @map("user_id") @db.Uuid
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  birthDate        DateTime? @map("birth_date") @db.Date
  gender           Gender?
  /// Sheba/IBAN: "IR" + 24 digits.
  bankIban         String?   @map("bank_iban") @db.VarChar(26)
  defaultAddressId String?   @unique @map("default_address_id") @db.Uuid
  defaultAddress   Address?  @relation("CustomerDefaultAddress", fields: [defaultAddressId], references: [id], onDelete: SetNull)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("customer_profiles")
}

/// Delivery address of a user. Rows are kept even when no longer default, so
/// historical orders can still explain where they were shipped.
model Address {
  id              String   @id @default(uuid()) @db.Uuid
  userId          String   @map("user_id") @db.Uuid
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  province        String   @db.VarChar(60)
  city            String   @db.VarChar(60)
  postalAddress   String   @map("postal_address") @db.Text
  postalCode      String   @map("postal_code") @db.VarChar(10)
  buildingNumber  String?  @map("building_number") @db.VarChar(20)
  unitNumber      String?  @map("unit_number") @db.VarChar(20)
  recipientName   String   @map("recipient_name") @db.VarChar(120)
  recipientMobile String   @map("recipient_mobile") @db.VarChar(15)
  isDefault       Boolean  @default(false) @map("is_default")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  defaultForProfile CustomerProfile? @relation("CustomerDefaultAddress")

  @@index([userId, isDefault])
  @@index([userId, createdAt])
  @@map("addresses")
}

/// Append-only audit trail. Rows are never updated or deleted: `oldValue` /
/// `newValue` capture the state transition, and the pair (entityName, entityId)
/// is the query path for "history of this record".
model AuditLog {
  id         String      @id @default(uuid()) @db.Uuid
  userId     String?     @map("user_id") @db.Uuid
  user       User?       @relation(fields: [userId], references: [id], onDelete: SetNull)
  action     AuditAction
  entityName String      @map("entity_name") @db.VarChar(80)
  entityId   String?     @map("entity_id") @db.VarChar(64)
  ipAddress  String?     @map("ip_address") @db.VarChar(45)
  userAgent  String?     @map("user_agent") @db.VarChar(512)
  oldValue   Json?       @map("old_value")
  newValue   Json?       @map("new_value")
  createdAt  DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([entityName, entityId])
  @@index([userId, createdAt])
  @@index([action, createdAt])
  @@map("audit_logs")
}

// ============================================================================
// 2. VENDOR MANAGEMENT & VERIFICATION
// ============================================================================

enum VendorStatus {
  PENDING
  APPROVED
  REJECTED
  SUSPENDED
}

/// A store operating on the marketplace. Created together with its owner User
/// (role VENDOR); `verifiedAt` is stamped only when a reviewer approves the
/// verification documents.
model Vendor {
  id                     String       @id @default(uuid()) @db.Uuid
  userId                 String       @unique @map("user_id") @db.Uuid
  user                   User         @relation(fields: [userId], references: [id], onDelete: Restrict)
  storeName              String       @map("store_name") @db.VarChar(120)
  storeSlug              String       @unique @map("store_slug") @db.VarChar(140)
  instagramHandle        String?      @map("instagram_handle") @db.VarChar(60)
  logoUrl                String?      @map("logo_url") @db.VarChar(512)
  bio                    String?      @db.Text
  bankIban               String       @map("bank_iban") @db.VarChar(26)
  /// Legal name of the account holder; payouts must match the IBAN holder.
  bankAccountHolder      String?      @map("bank_account_holder") @db.VarChar(120)
  /// Vendor-specific commission; when null, the category rate applies.
  commissionRateOverride Decimal?     @map("commission_rate_override") @db.Decimal(5, 2)
  /// Flat shipping fee for this store's packages; null = platform default.
  shippingFeeOverride    Decimal?     @map("shipping_fee_override") @db.Decimal(15, 2)
  /// Package subtotal at which this store ships for free; null = platform default, 0 = never free.
  freeShippingThreshold  Decimal?     @map("free_shipping_threshold") @db.Decimal(15, 2)
  status                 VendorStatus @default(PENDING)
  verifiedAt             DateTime?    @map("verified_at") @db.Timestamptz(3)
  createdAt              DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt              DateTime     @updatedAt @map("updated_at") @db.Timestamptz(3)

  verifications      VendorVerification[]
  mediaAssets        MediaAsset[]         @relation("VendorMediaAssets")
  products           Product[]
  subOrders          SubOrder[]
  disputes           Dispute[]
  wallet             VendorWallet?
  settlementRequests SettlementRequest[]

  @@index([status])
  @@index([status, createdAt])
  @@map("vendors")
}

/// Verification dossier of a vendor. A vendor may have several rows over time
/// (resubmission after a rejection); the review outcome is recorded per row.
model VendorVerification {
  id                  String    @id @default(uuid()) @db.Uuid
  vendorId            String    @map("vendor_id") @db.Uuid
  vendor              Vendor    @relation(fields: [vendorId], references: [id], onDelete: Cascade)
  nationalCardDocUrl  String    @map("national_card_doc_url") @db.VarChar(512)
  businessDocUrl      String?   @map("business_doc_url") @db.VarChar(512)
  /// Proof that the declared IBAN belongs to the store owner (bank statement / cheque).
  bankAccountProofUrl String?   @map("bank_account_proof_url") @db.VarChar(512)
  rejectionReason     String?   @map("rejection_reason") @db.Text
  reviewedByUserId    String?   @map("reviewed_by_user_id") @db.Uuid
  reviewedBy          User?     @relation("VerificationReviewer", fields: [reviewedByUserId], references: [id], onDelete: SetNull)
  reviewedAt          DateTime? @map("reviewed_at") @db.Timestamptz(3)
  createdAt           DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([vendorId, createdAt])
  @@index([reviewedByUserId])
  @@map("vendor_verifications")
}

// ============================================================================
// 3. CATALOG, HIERARCHICAL CATEGORIES & VARIANTS
// ============================================================================

/// Self-referencing category tree. `defaultCommissionRate` is the platform's
/// commission for products in this category unless the vendor has an override.
model Category {
  id                    String     @id @default(uuid()) @db.Uuid
  parentId              String?    @map("parent_id") @db.Uuid
  parent                Category?  @relation("CategoryTree", fields: [parentId], references: [id], onDelete: SetNull)
  children              Category[] @relation("CategoryTree")
  slug                  String     @unique @db.VarChar(80)
  titleFa               String     @map("title_fa") @db.VarChar(120)
  titleEn               String?    @map("title_en") @db.VarChar(120)
  defaultCommissionRate Decimal    @default(0) @map("default_commission_rate") @db.Decimal(5, 2)
  sortOrder             Int        @default(0) @map("sort_order")
  isActive              Boolean    @default(true) @map("is_active")
  createdAt             DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)

  products Product[]

  @@index([parentId, sortOrder])
  @@index([isActive])
  @@map("categories")
}

/// A product published by exactly one vendor. `basePrice` is the display price;
/// the price actually charged is the selected variant's `price`.
model Product {
  id               String    @id @default(uuid()) @db.Uuid
  vendorId         String    @map("vendor_id") @db.Uuid
  vendor           Vendor    @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  categoryId       String    @map("category_id") @db.Uuid
  category         Category  @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  title            String    @db.VarChar(200)
  slug             String    @unique @db.VarChar(220)
  description      String?   @db.Text
  brand            String?   @db.VarChar(80)
  basePrice        Decimal   @map("base_price") @db.Decimal(15, 2)
  /// Vendor-controlled visibility. Cannot be switched on while `isBlockedByAdmin` is true.
  isPublished      Boolean   @default(false) @map("is_published")
  /// Staff moderation flag: a blocked product is never public, whatever the vendor sets.
  isBlockedByAdmin Boolean   @default(false) @map("is_blocked_by_admin")
  blockedReason    String?   @map("blocked_reason") @db.VarChar(500)
  blockedAt        DateTime? @map("blocked_at") @db.Timestamptz(3)
  blockedByUserId  String?   @map("blocked_by_user_id") @db.Uuid
  blockedBy        User?     @relation("ProductBlockedBy", fields: [blockedByUserId], references: [id], onDelete: SetNull)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  variants ProductVariant[]
  media    ProductMedia[]

  @@index([vendorId, isPublished])
  @@index([categoryId, isPublished])
  @@index([isPublished, createdAt])
  @@index([isPublished, isBlockedByAdmin, createdAt])
  /// pg_trgm GIN indexes: substring (ILIKE '%…%') search on Persian text.
  @@index([title(ops: raw("gin_trgm_ops"))], type: Gin, map: "products_title_trgm_idx")
  @@index([description(ops: raw("gin_trgm_ops"))], type: Gin, map: "products_description_trgm_idx")
  @@index([brand(ops: raw("gin_trgm_ops"))], type: Gin, map: "products_brand_trgm_idx")
  @@map("products")
}

/// Sellable unit of a product: the only thing that can be added to a cart or
/// referenced by an order line. `compareAtPrice` drives the "was/now" display.
model ProductVariant {
  id               String   @id @default(uuid()) @db.Uuid
  productId        String   @map("product_id") @db.Uuid
  product          Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  sku              String   @unique @db.VarChar(64)
  colorName        String?  @map("color_name") @db.VarChar(40)
  colorHex         String?  @map("color_hex") @db.VarChar(7)
  size             String?  @db.VarChar(20)
  guarantee        String?  @db.VarChar(60)
  price            Decimal  @db.Decimal(15, 2)
  compareAtPrice   Decimal? @map("compare_at_price") @db.Decimal(15, 2)
  /// On-hand units. DB CHECK: stock_quantity >= 0 AND reserved_quantity >= 0 AND reserved_quantity <= stock_quantity.
  stockQuantity    Int      @default(0) @map("stock_quantity")
  /// Units held by unfinished checkouts; sellable = stockQuantity - reservedQuantity.
  reservedQuantity Int      @default(0) @map("reserved_quantity")
  weightGrams      Int?     @map("weight_grams")
  isActive         Boolean  @default(true) @map("is_active")
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  cartItems  CartItem[]
  orderItems OrderItem[]

  @@index([productId, isActive])
  @@index([isActive, price])
  @@map("product_variants")
}

/// Gallery of a product. Exactly one row should have `isPrimary = true`.
/// One stored file.
///
/// Every upload leaves a row here, so the platform always knows what exists in
/// the object store, who owns it and whether it may be served anonymously. It is
/// deliberately independent of `ProductMedia` (which links catalogue rows to
/// their images): logos, avatars and KYC documents are not catalogue data.
model MediaAsset {
  id              String    @id @default(uuid()) @db.Uuid
  ownerUserId     String?   @map("owner_user_id") @db.Uuid
  owner           User?     @relation("MediaAssetOwner", fields: [ownerUserId], references: [id], onDelete: SetNull)
  vendorId        String?   @map("vendor_id") @db.Uuid
  vendor          Vendor?   @relation("VendorMediaAssets", fields: [vendorId], references: [id], onDelete: SetNull)
  kind            MediaKind
  /// Business purpose, e.g. `store_logo`, `avatar`, `kyc_national_id`.
  purpose         String    @db.VarChar(60)
  /// Which provider wrote the file, so a migration between providers is traceable.
  storageProvider String    @map("storage_provider") @db.VarChar(20)
  /// Provider-relative object key. Unique: one file, one row.
  path            String    @unique @db.VarChar(512)
  thumbnailPath   String?   @map("thumbnail_path") @db.VarChar(512)
  url             String    @db.VarChar(1024)
  thumbnailUrl    String?   @map("thumbnail_url") @db.VarChar(1024)
  mimeType        String    @map("mime_type") @db.VarChar(100)
  originalName    String?   @map("original_name") @db.VarChar(255)
  sizeBytes       Int       @map("size_bytes")
  width           Int?
  height          Int?
  /// Documents default to private: KYC material must never be world-readable.
  isPublic        Boolean   @default(false) @map("is_public")
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  productMedia    ProductMedia[]
  disputeEvidence DisputeEvidence[]

  @@index([ownerUserId, kind, createdAt])
  @@index([vendorId, purpose])
  @@index([kind, isPublic, createdAt])
  @@map("media_assets")
}

model ProductMedia {
  id           String      @id @default(uuid()) @db.Uuid
  productId    String      @map("product_id") @db.Uuid
  product      Product     @relation(fields: [productId], references: [id], onDelete: Cascade)
  /// The uploaded file (Phase-4 storage pipeline) this gallery entry was created from.
  mediaAssetId String?     @map("media_asset_id") @db.Uuid
  mediaAsset   MediaAsset? @relation(fields: [mediaAssetId], references: [id], onDelete: SetNull)
  url          String      @db.VarChar(512)
  thumbnailUrl String?     @map("thumbnail_url") @db.VarChar(512)
  isPrimary    Boolean     @default(false) @map("is_primary")
  sortOrder    Int         @default(0) @map("sort_order")
  createdAt    DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([productId, sortOrder])
  @@index([mediaAssetId])
  @@map("product_media")
}

// ============================================================================
// 4. CART, MULTI-VENDOR ORDER SPLITTING & LOGISTICS
// ============================================================================

/// What a stored file is. Images run through the Sharp pipeline; documents are
/// stored as received and are never publicly readable.
enum MediaKind {
  IMAGE
  DOCUMENT
}

enum PaymentMethod {
  CASH_IPG
  BANK_CREDIT
  HYBRID
}

enum ParentOrderPaymentStatus {
  PENDING
  PAID
  FAILED
  CANCELLED
}

enum SubOrderStatus {
  PENDING_APPROVAL
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
  REFUNDED
}

/// Shopping cart. Either owned by a registered user (`userId`) or anonymous
/// (`sessionToken`); both are unique so a cart is addressable by exactly one
/// key. The application layer guarantees one of the two is always set.
model Cart {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String?  @unique @map("user_id") @db.Uuid
  user         User?    @relation(fields: [userId], references: [id], onDelete: Cascade)
  sessionToken String?  @unique @map("session_token") @db.VarChar(64)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  items CartItem[]

  @@index([updatedAt])
  @@map("carts")
}

/// One line of a cart. A variant appears at most once per cart: quantity changes
/// are an update, never a second row.
model CartItem {
  id                String         @id @default(uuid()) @db.Uuid
  cartId            String         @map("cart_id") @db.Uuid
  cart              Cart           @relation(fields: [cartId], references: [id], onDelete: Cascade)
  productVariantId  String         @map("product_variant_id") @db.Uuid
  productVariant    ProductVariant @relation(fields: [productVariantId], references: [id], onDelete: Cascade)
  quantity          Int
  /// Unit price the customer last saw for this line; checkout compares it with the live price.
  unitPriceSnapshot Decimal        @map("unit_price_snapshot") @db.Decimal(15, 2)
  createdAt         DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@unique([cartId, productVariantId])
  @@index([productVariantId])
  @@map("cart_items")
}

/// A customer checkout, which may span several vendors. Totals here are the
/// authoritative amounts for payment; per-vendor money lives on SubOrder.
/// `shippingAddressSnapshot` freezes the delivery address at checkout time so a
/// later address edit cannot rewrite order history.
model ParentOrder {
  id                      String                   @id @default(uuid()) @db.Uuid
  orderNumber             String                   @unique @map("order_number") @db.VarChar(20)
  userId                  String                   @map("user_id") @db.Uuid
  user                    User                     @relation(fields: [userId], references: [id], onDelete: Restrict)
  shippingAddressSnapshot Json                     @map("shipping_address_snapshot")
  totalItemsAmount        Decimal                  @map("total_items_amount") @db.Decimal(15, 2)
  totalShippingFee        Decimal                  @default(0) @map("total_shipping_fee") @db.Decimal(15, 2)
  totalDiscountAmount     Decimal                  @default(0) @map("total_discount_amount") @db.Decimal(15, 2)
  finalPayableAmount      Decimal                  @map("final_payable_amount") @db.Decimal(15, 2)
  paymentMethod           PaymentMethod            @map("payment_method")
  paymentStatus           ParentOrderPaymentStatus @default(PENDING) @map("payment_status")
  customerNote            String?                  @map("customer_note") @db.VarChar(500)
  /// Unpaid orders are cancelled (and their reservations released) after this instant.
  paymentExpiresAt        DateTime?                @map("payment_expires_at") @db.Timestamptz(3)
  paidAt                  DateTime?                @map("paid_at") @db.Timestamptz(3)
  cancelledAt             DateTime?                @map("cancelled_at") @db.Timestamptz(3)
  cancellationReason      String?                  @map("cancellation_reason") @db.VarChar(500)
  createdAt               DateTime                 @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt               DateTime                 @updatedAt @map("updated_at") @db.Timestamptz(3)

  subOrders            SubOrder[]
  payments             Payment[]
  creditTransactions   CreditTransaction[]
  installmentSchedules InstallmentSchedule[]

  @@index([userId, createdAt])
  @@index([paymentStatus, createdAt])
  @@index([paymentStatus, paymentExpiresAt])
  @@index([createdAt])
  @@map("parent_orders")
}

/// Per-vendor slice of a parent order. Carries the money split: what the vendor
/// earns (`vendorEarningsAmount`) versus what the platform keeps
/// (`platformCommissionAmount`).
model SubOrder {
  id                       String         @id @default(uuid()) @db.Uuid
  parentOrderId            String         @map("parent_order_id") @db.Uuid
  parentOrder              ParentOrder    @relation(fields: [parentOrderId], references: [id], onDelete: Cascade)
  vendorId                 String         @map("vendor_id") @db.Uuid
  vendor                   Vendor         @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  subOrderNumber           String         @unique @map("sub_order_number") @db.VarChar(24)
  itemsSubtotal            Decimal        @map("items_subtotal") @db.Decimal(15, 2)
  shippingFee              Decimal        @default(0) @map("shipping_fee") @db.Decimal(15, 2)
  platformCommissionAmount Decimal        @map("platform_commission_amount") @db.Decimal(15, 2)
  vendorEarningsAmount     Decimal        @map("vendor_earnings_amount") @db.Decimal(15, 2)
  status                   SubOrderStatus @default(PENDING_APPROVAL)
  trackingCode             String?        @map("tracking_code") @db.VarChar(40)
  carrierName              String?        @map("carrier_name") @db.VarChar(80)
  shippedAt                DateTime?      @map("shipped_at") @db.Timestamptz(3)
  deliveredAt              DateTime?      @map("delivered_at") @db.Timestamptz(3)
  cancelledAt              DateTime?      @map("cancelled_at") @db.Timestamptz(3)
  cancellationReason       String?        @map("cancellation_reason") @db.VarChar(500)
  /// Set when the escrowed amount moves from pendingBalance to withdrawable.
  escrowReleasedAt         DateTime?      @map("escrow_released_at") @db.Timestamptz(3)
  createdAt                DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  items              OrderItem[]
  walletTransactions WalletTransaction[]
  disputes           Dispute[]
  statusHistory      SubOrderStatusHistory[]

  @@index([parentOrderId])
  @@index([vendorId, status, createdAt])
  @@index([status, createdAt])
  @@map("sub_orders")
}

/// Append-only timeline of sub-order status changes (who, when, why).
model SubOrderStatusHistory {
  id          String          @id @default(uuid()) @db.Uuid
  subOrderId  String          @map("sub_order_id") @db.Uuid
  subOrder    SubOrder        @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
  fromStatus  SubOrderStatus? @map("from_status")
  toStatus    SubOrderStatus  @map("to_status")
  /// Null for system transitions (payment timeout, gateway callbacks).
  actorUserId String?         @map("actor_user_id") @db.Uuid
  actorUser   User?           @relation("SubOrderStatusActor", fields: [actorUserId], references: [id], onDelete: SetNull)
  actorRole   String          @map("actor_role") @db.VarChar(20)
  note        String?         @db.VarChar(500)
  createdAt   DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([subOrderId, createdAt])
  @@map("sub_order_status_history")
}

/// Immutable order line. Every value that can change later (title, variant,
/// price, discount, commission) is captured as a snapshot at placement time, so
/// editing a product never rewrites history. `productVariantId` is nullable with
/// SET NULL: the line survives even if the variant is removed from the catalog.
model OrderItem {
  id                      String          @id @default(uuid()) @db.Uuid
  subOrderId              String          @map("sub_order_id") @db.Uuid
  subOrder                SubOrder        @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
  productVariantId        String?         @map("product_variant_id") @db.Uuid
  productVariant          ProductVariant? @relation(fields: [productVariantId], references: [id], onDelete: SetNull)
  productTitleSnapshot    String          @map("product_title_snapshot") @db.VarChar(200)
  vendorStoreNameSnapshot String          @map("vendor_store_name_snapshot") @db.VarChar(120)
  /// SKU at checkout; the variant row may later change or disappear.
  skuSnapshot             String          @map("sku_snapshot") @db.VarChar(64)
  /// { colorName, colorHex, size, guarantee } captured at checkout.
  variantDetailsSnapshot  Json            @map("variant_details_snapshot")
  unitPriceSnapshot       Decimal         @map("unit_price_snapshot") @db.Decimal(15, 2)
  discountSnapshot        Decimal         @default(0) @map("discount_snapshot") @db.Decimal(15, 2)
  commissionRateSnapshot  Decimal         @map("commission_rate_snapshot") @db.Decimal(5, 2)
  quantity                Int
  totalLineAmount         Decimal         @map("total_line_amount") @db.Decimal(15, 2)
  createdAt               DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([subOrderId])
  @@index([productVariantId])
  @@map("order_items")
}

// ============================================================================
// 5. PAYMENTS, ESCROW & VENDOR SETTLEMENTS
// ============================================================================

enum PaymentPurpose {
  ORDER_CHECKOUT
  INSTALLMENT_REPAYMENT
}

enum PaymentStatus {
  INITIATED
  SUCCESSFUL
  FAILED
  REFUNDED
}

enum WalletTransactionType {
  CREDIT_SALE_ESCROW_HOLD
  ESCROW_RELEASE_TO_WITHDRAWABLE
  COMMISSION_DEDUCTION
  SETTLEMENT_PAYOUT
  REFUND_DEDUCTION
  /// Withdrawable → settlement hold when a vendor requests a payout.
  SETTLEMENT_HOLD
  /// Settlement hold → withdrawable when finance rejects the request.
  SETTLEMENT_HOLD_RELEASE
  /// Escrow (PENDING) or WITHDRAWABLE → DISPUTE_HOLD when a customer opens a dispute (Phase 9).
  DISPUTE_HOLD_LOCK
  /// DISPUTE_HOLD → WITHDRAWABLE (vendor favour) or back to its source bucket (dispute cancelled).
  DISPUTE_HOLD_RELEASE
}

/// Balance bucket of a vendor wallet a ledger row moves money in.
enum WalletBalanceBucket {
  PENDING
  WITHDRAWABLE
  SETTLEMENT_HOLD
  /// Earnings frozen while a dispute about the package is open (Phase 9).
  DISPUTE_HOLD
}

enum SettlementStatus {
  REQUESTED
  PROCESSING
  PAID_PAYA
  REJECTED
}

/// Payment attempt against a parent order. A hybrid order settles partly from
/// the customer's wallet/IPG (`cashAmount`) and partly from bank credit
/// (`creditAmount`); the two always add up to the order's final payable amount.
/// `gatewayName` is a string, not an enum: gateways are configuration, and
/// adding one must not require a migration.
model Payment {
  id                    String               @id @default(uuid()) @db.Uuid
  parentOrderId         String               @map("parent_order_id") @db.Uuid
  parentOrder           ParentOrder          @relation(fields: [parentOrderId], references: [id], onDelete: Restrict)
  /// What the money is for: the order itself, or one instalment of a BNPL order.
  purpose               PaymentPurpose       @default(ORDER_CHECKOUT)
  /// How this attempt splits the amount (CASH_IPG = card only, BANK_CREDIT = credit only, HYBRID = both).
  paymentMethod         PaymentMethod        @default(CASH_IPG) @map("payment_method")
  /// Credit line used by a BANK_CREDIT / HYBRID attempt.
  creditAccountId       String?              @map("credit_account_id") @db.Uuid
  creditAccount         CreditAccount?       @relation(fields: [creditAccountId], references: [id], onDelete: Restrict)
  /// Instalment plan chosen for the credit part.
  installmentPlanId     String?              @map("installment_plan_id") @db.Uuid
  installmentPlan       InstallmentPlan?     @relation(fields: [installmentPlanId], references: [id], onDelete: Restrict)
  /// Provider reservation reference of the credit part (reserve → commit | release).
  creditReservationRef  String?              @map("credit_reservation_ref") @db.VarChar(80)
  /// The instalment an INSTALLMENT_REPAYMENT payment settles.
  installmentScheduleId String?              @map("installment_schedule_id") @db.Uuid
  installmentSchedule   InstallmentSchedule? @relation(fields: [installmentScheduleId], references: [id], onDelete: Restrict)
  gatewayName           String               @map("gateway_name") @db.VarChar(40)
  gatewayTrackingToken  String?              @map("gateway_tracking_token") @db.VarChar(120)
  bankRrn               String?              @map("bank_rrn") @db.VarChar(40)
  cashAmount            Decimal              @default(0) @map("cash_amount") @db.Decimal(15, 2)
  creditAmount          Decimal              @default(0) @map("credit_amount") @db.Decimal(15, 2)
  status                PaymentStatus        @default(INITIATED)
  paidAt                DateTime?            @map("paid_at") @db.Timestamptz(3)
  metadata              Json?
  createdAt             DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime             @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([parentOrderId, status])
  @@index([status, createdAt])
  @@index([gatewayTrackingToken])
  @@index([installmentScheduleId, status])
  @@index([creditAccountId])
  @@map("payments")
}

/// Escrow wallet of a vendor. The balance columns are the projection of the
/// ledger (`WalletTransaction`), maintained in the same database transaction as
/// every ledger write, one column per ledger bucket:
///   pendingBalance         — PENDING bucket: vendor earnings of paid packages
///                            that are not delivered yet (escrow),
///   withdrawableBalance    — WITHDRAWABLE bucket: released, requestable,
///   settlementHoldBalance  — SETTLEMENT_HOLD bucket: reserved by open
///                            settlement requests awaiting finance,
///   totalEarnedBalance     — earnings released on delivery (minus refunds of
///                            delivered packages),
///   totalWithdrawnAmount   — lifetime amount paid out by PAYA.
/// CHECK constraints keep every balance >= 0 (migration phase7_finance).
model VendorWallet {
  id                    String   @id @default(uuid()) @db.Uuid
  vendorId              String   @unique @map("vendor_id") @db.Uuid
  vendor                Vendor   @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  pendingBalance        Decimal  @default(0) @map("pending_balance") @db.Decimal(15, 2)
  withdrawableBalance   Decimal  @default(0) @map("withdrawable_balance") @db.Decimal(15, 2)
  settlementHoldBalance Decimal  @default(0) @map("settlement_hold_balance") @db.Decimal(15, 2)
  /// Earnings frozen by open disputes; never withdrawable (Phase 9).
  disputeHoldBalance    Decimal  @default(0) @map("dispute_hold_balance") @db.Decimal(15, 2)
  totalEarnedBalance    Decimal  @default(0) @map("total_earned_balance") @db.Decimal(15, 2)
  totalWithdrawnAmount  Decimal  @default(0) @map("total_withdrawn_amount") @db.Decimal(15, 2)
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  transactions WalletTransaction[]

  @@index([updatedAt])
  @@map("vendor_wallets")
}

/// Append-only wallet ledger. Every row moves money in exactly one bucket of
/// the wallet: `amount` is the signed change (negative = debit) and
/// `balanceAfter` is that bucket's balance right after the row, so for every
/// wallet and bucket SUM(amount) equals the wallet column. A transfer between
/// two buckets (escrow release, settlement hold/release) is written as a pair
/// of rows with the same type that sum to zero.
/// Partial unique indexes (migration phase7_finance) make each sub-order and
/// settlement movement happen at most once per type and bucket.
model WalletTransaction {
  id                  String                @id @default(uuid()) @db.Uuid
  walletId            String                @map("wallet_id") @db.Uuid
  wallet              VendorWallet          @relation(fields: [walletId], references: [id], onDelete: Cascade)
  subOrderId          String?               @map("sub_order_id") @db.Uuid
  subOrder            SubOrder?             @relation(fields: [subOrderId], references: [id], onDelete: SetNull)
  settlementRequestId String?               @map("settlement_request_id") @db.Uuid
  settlementRequest   SettlementRequest?    @relation(fields: [settlementRequestId], references: [id], onDelete: SetNull)
  /// Dispute whose freeze / resolution produced this row (Phase 9).
  disputeId           String?               @map("dispute_id") @db.Uuid
  dispute             Dispute?              @relation(fields: [disputeId], references: [id], onDelete: SetNull)
  type                WalletTransactionType
  bucket              WalletBalanceBucket
  amount              Decimal               @db.Decimal(15, 2)
  balanceAfter        Decimal               @map("balance_after") @db.Decimal(15, 2)
  description         String?               @db.VarChar(255)
  createdAt           DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([walletId, createdAt])
  @@index([walletId, bucket])
  @@index([subOrderId])
  @@index([settlementRequestId])
  @@index([disputeId])
  @@map("wallet_transactions")
}

/// Vendor payout request. `amount` is validated against the wallet's
/// withdrawable balance by the settlement service; `processedByUserId` records
/// which staff member authorised the bank transfer (PAYA).
model SettlementRequest {
  id                String           @id @default(uuid()) @db.Uuid
  vendorId          String           @map("vendor_id") @db.Uuid
  vendor            Vendor           @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  amount            Decimal          @db.Decimal(15, 2)
  targetIban        String           @map("target_iban") @db.VarChar(26)
  status            SettlementStatus @default(REQUESTED)
  bankPayaReference String?          @map("bank_paya_reference") @db.VarChar(60)
  processedByUserId String?          @map("processed_by_user_id") @db.Uuid
  processedBy       User?            @relation("SettlementProcessor", fields: [processedByUserId], references: [id], onDelete: SetNull)
  processedAt       DateTime?        @map("processed_at") @db.Timestamptz(3)
  rejectionReason   String?          @map("rejection_reason") @db.VarChar(500)
  createdAt         DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)

  walletTransactions WalletTransaction[]

  @@index([vendorId, status, createdAt])
  @@index([status, createdAt])
  @@map("settlement_requests")
}

// ============================================================================
// 6. BANKING CREDIT, BNPL ENGINE & INSTALLMENTS
// ============================================================================

enum CreditAccountStatus {
  ACTIVE
  FROZEN
  CLOSED
}

enum CreditApplicationStatus {
  DRAFT
  PENDING_BANK_INQUIRY
  DOCS_REQUIRED
  APPROVED
  REJECTED
}

enum CreditTransactionType {
  CREDIT_ALLOCATION
  PURCHASE_RESERVE_HOLD
  PURCHASE_COMMIT
  RESERVATION_RELEASE
  INSTALLMENT_REPAYMENT_RESTORE
  REFUND_RESTORE
}

enum InstallmentStatus {
  PENDING
  PAID
  OVERDUE
  WAIVED
}

/// Bank or fintech partner that issues credit. `code` is the stable identifier
/// used by configuration (`SANDBOX_BANK`, `SAMAN_BANK`, `BLUBANK`, `DIGIPAY`);
/// `config` holds provider-specific settings (base URL, merchant id, …) so that
/// onboarding a provider is a data change, not a deploy.
model CreditProvider {
  id        String   @id @default(uuid()) @db.Uuid
  name      String   @db.VarChar(80)
  code      String   @unique @db.VarChar(40)
  isActive  Boolean  @default(false) @map("is_active")
  config    Json?
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  accounts         CreditAccount[]
  applications     CreditApplication[]
  installmentPlans InstallmentPlan[]

  @@index([isActive])
  @@map("credit_providers")
}

/// Credit line of a customer at one provider. `availableAmount` is stored (not
/// computed on read) because checkout must reject an over-limit purchase under a
/// row lock. The ledger (`CreditTransaction`) is the source of truth; the four
/// amounts are its maintained projection.
/// Invariant enforced by the credit service: available = total − used − reserved.
model CreditAccount {
  id              String              @id @default(uuid()) @db.Uuid
  userId          String              @map("user_id") @db.Uuid
  user            User                @relation(fields: [userId], references: [id], onDelete: Restrict)
  providerId      String              @map("provider_id") @db.Uuid
  provider        CreditProvider      @relation(fields: [providerId], references: [id], onDelete: Restrict)
  totalLimit      Decimal             @map("total_limit") @db.Decimal(15, 2)
  usedAmount      Decimal             @default(0) @map("used_amount") @db.Decimal(15, 2)
  reservedAmount  Decimal             @default(0) @map("reserved_amount") @db.Decimal(15, 2)
  availableAmount Decimal             @map("available_amount") @db.Decimal(15, 2)
  status          CreditAccountStatus @default(ACTIVE)
  expiresAt       DateTime?           @map("expires_at") @db.Timestamptz(3)
  createdAt       DateTime            @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime            @updatedAt @map("updated_at") @db.Timestamptz(3)

  transactions         CreditTransaction[]
  installmentSchedules InstallmentSchedule[]
  payments             Payment[]

  @@unique([userId, providerId])
  @@index([userId, status])
  @@index([providerId, status])
  @@map("credit_accounts")
}

/// Loan application submitted to a provider. The bank's raw answer is stored in
/// `bankScoreResponse` for audit; `approvedLimit` is what the decision service
/// used when opening or updating the CreditAccount.
model CreditApplication {
  id                          String                  @id @default(uuid()) @db.Uuid
  userId                      String                  @map("user_id") @db.Uuid
  user                        User                    @relation(fields: [userId], references: [id], onDelete: Restrict)
  providerId                  String                  @map("provider_id") @db.Uuid
  provider                    CreditProvider          @relation(fields: [providerId], references: [id], onDelete: Restrict)
  requestedLimit              Decimal                 @map("requested_limit") @db.Decimal(15, 2)
  approvedLimit               Decimal?                @map("approved_limit") @db.Decimal(15, 2)
  status                      CreditApplicationStatus @default(DRAFT)
  bankApplicationTrackingCode String?                 @map("bank_application_tracking_code") @db.VarChar(60)
  bankScoreResponse           Json?                   @map("bank_score_response")
  /// Short machine-readable reason of a REJECTED decision (e.g. SCORE_BELOW_THRESHOLD).
  decisionReason              String?                 @map("decision_reason") @db.VarChar(120)
  decidedAt                   DateTime?               @map("decided_at") @db.Timestamptz(3)
  createdAt                   DateTime                @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                   DateTime                @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([userId, status, createdAt])
  @@index([providerId, status])
  @@index([bankApplicationTrackingCode])
  @@map("credit_applications")
}

/// Append-only credit ledger. Every movement of a credit line is one row; the
/// order or repayment that caused it is referenced by `parentOrderId` and
/// `referenceCode`. Balance semantics per type:
///   CREDIT_ALLOCATION                → available +amount (limit granted/increased)
///   PURCHASE_RESERVE_HOLD            → reserved +amount, available −amount
///   PURCHASE_COMMIT                  → reserved −amount, used +amount
///   RESERVATION_RELEASE              → reserved −amount, available +amount
///   INSTALLMENT_REPAYMENT_RESTORE    → used −amount, available +amount
///   REFUND_RESTORE                   → used −amount, available +amount
/// `amount` is always positive (the type carries the direction); `balanceAfter`
/// is the account's availableAmount after the movement. `referenceCode` is the
/// application id (allocation), the provider reservation ref (hold / commit /
/// release) or the instalment id (repayment); (type, referenceCode) is unique,
/// and a reservation ends at most once (commit XOR release) — migration phase8_credit.
model CreditTransaction {
  id              String                @id @default(uuid()) @db.Uuid
  creditAccountId String                @map("credit_account_id") @db.Uuid
  creditAccount   CreditAccount         @relation(fields: [creditAccountId], references: [id], onDelete: Restrict)
  parentOrderId   String?               @map("parent_order_id") @db.Uuid
  parentOrder     ParentOrder?          @relation(fields: [parentOrderId], references: [id], onDelete: SetNull)
  type            CreditTransactionType
  amount          Decimal               @db.Decimal(15, 2)
  balanceAfter    Decimal               @map("balance_after") @db.Decimal(15, 2)
  referenceCode   String                @map("reference_code") @db.VarChar(80)
  createdAt       DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([creditAccountId, createdAt])
  @@index([parentOrderId])
  @@index([referenceCode])
  @@map("credit_transactions")
}

/// Productised instalment offer of a provider (3 × 0 %, 6 × …, 12 × …).
/// `penaltyRatePercentPerMonth` is the late-payment penalty applied per month of
/// delay, used when an InstallmentSchedule turns OVERDUE.
model InstallmentPlan {
  id                         String         @id @default(uuid()) @db.Uuid
  providerId                 String         @map("provider_id") @db.Uuid
  provider                   CreditProvider @relation(fields: [providerId], references: [id], onDelete: Restrict)
  title                      String         @db.VarChar(120)
  durationMonths             Int            @map("duration_months")
  interestRatePercent        Decimal        @map("interest_rate_percent") @db.Decimal(5, 2)
  penaltyRatePercentPerMonth Decimal        @map("penalty_rate_percent_per_month") @db.Decimal(5, 2)
  isActive                   Boolean        @default(true) @map("is_active")
  createdAt                  DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                  DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  payments Payment[]

  @@unique([providerId, durationMonths])
  @@index([providerId, isActive])
  @@map("installment_plans")
}

/// One instalment of a BNPL purchase. The full schedule is generated at
/// checkout inside the same transaction that commits the credit line, so the
/// customer's obligations and the credit ledger can never disagree.
/// (order, instalmentNumber) is unique: a schedule cannot contain duplicates.
model InstallmentSchedule {
  id                String            @id @default(uuid()) @db.Uuid
  parentOrderId     String            @map("parent_order_id") @db.Uuid
  parentOrder       ParentOrder       @relation(fields: [parentOrderId], references: [id], onDelete: Restrict)
  creditAccountId   String            @map("credit_account_id") @db.Uuid
  creditAccount     CreditAccount     @relation(fields: [creditAccountId], references: [id], onDelete: Restrict)
  installmentNumber Int               @map("installment_number")
  totalInstallments Int               @map("total_installments")
  dueDate           DateTime          @map("due_date") @db.Date
  principalAmount   Decimal           @map("principal_amount") @db.Decimal(15, 2)
  interestAmount    Decimal           @default(0) @map("interest_amount") @db.Decimal(15, 2)
  totalAmount       Decimal           @map("total_amount") @db.Decimal(15, 2)
  penaltyAmount     Decimal           @default(0) @map("penalty_amount") @db.Decimal(15, 2)
  paidAmount        Decimal           @default(0) @map("paid_amount") @db.Decimal(15, 2)
  status            InstallmentStatus @default(PENDING)
  paidAt            DateTime?         @map("paid_at") @db.Timestamptz(3)
  bankTransactionId String?           @map("bank_transaction_id") @db.VarChar(80)
  createdAt         DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime          @updatedAt @map("updated_at") @db.Timestamptz(3)

  payments Payment[]

  @@unique([parentOrderId, installmentNumber])
  @@index([creditAccountId, status])
  @@index([status, dueDate])
  @@map("installment_schedules")
}

// ============================================================================
// 7. DISPUTES & CUSTOMER SUPPORT
// ============================================================================

enum DisputeReason {
  WRONG_ITEM
  DAMAGED
  NOT_AS_DESCRIBED
  NOT_DELIVERED
  COUNTERFEIT
}

enum DisputeStatus {
  OPEN
  VENDOR_RESPONDED
  UNDER_ARBITRATION
  RESOLVED_BUYER_FAVOR
  RESOLVED_VENDOR_FAVOR
  CANCELLED
}

/// What the vendor answered to a dispute (Phase 9).
enum DisputeVendorAction {
  ACCEPT_RETURN
  REJECT_WITH_DEFENSE
}

/// Entries of a dispute's append-only timeline (Phase 9).
enum DisputeEventType {
  OPENED
  EVIDENCE_ADDED
  VENDOR_ACCEPTED_RETURN
  VENDOR_DEFENDED
  ARBITRATED_BUYER_FAVOR
  ARBITRATED_VENDOR_FAVOR
  CANCELLED_BY_CUSTOMER
  REFUND_NOTICE_SENT
  REFUND_NOTICE_FAILED
}

/// Complaint raised by a customer about one vendor's slice of an order.
/// Disputes live as long as the sub-order they belong to. At most one dispute
/// per sub-order is active (OPEN / VENDOR_RESPONDED / UNDER_ARBITRATION) —
/// enforced by a partial unique index (migration phase9_disputes).
///
/// Escrow freeze (Phase 9): on opening, the package's earnings move into the
/// vendor wallet's DISPUTE_HOLD bucket — from PENDING if not delivered yet, or
/// from WITHDRAWABLE (as much as is there) if already delivered. `holdSource`,
/// `holdAmount` and `holdShortfall` record exactly what was frozen, so the
/// resolution moves back or refunds precisely that amount.
model Dispute {
  id                      String               @id @default(uuid()) @db.Uuid
  subOrderId              String               @map("sub_order_id") @db.Uuid
  subOrder                SubOrder             @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
  /// Store the dispute is against (denormalised from the sub-order for the vendor panel).
  vendorId                String               @map("vendor_id") @db.Uuid
  vendor                  Vendor               @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  raisedByUserId          String               @map("raised_by_user_id") @db.Uuid
  raisedBy                User                 @relation(fields: [raisedByUserId], references: [id], onDelete: Restrict)
  reason                  DisputeReason
  description             String               @db.Text
  status                  DisputeStatus        @default(OPEN)
  /// Package status when the dispute was opened (PROCESSING / SHIPPED / DELIVERED).
  subOrderStatusAtOpen    SubOrderStatus       @map("sub_order_status_at_open")
  /// Bucket the frozen earnings came from: PENDING or WITHDRAWABLE; null when nothing could be frozen.
  holdSource              WalletBalanceBucket? @map("hold_source")
  holdAmount              Decimal              @default(0) @map("hold_amount") @db.Decimal(15, 2)
  /// Earnings that could not be frozen because the vendor had already withdrawn them.
  holdShortfall           Decimal              @default(0) @map("hold_shortfall") @db.Decimal(15, 2)
  vendorAction            DisputeVendorAction? @map("vendor_action")
  vendorDefenseNotes      String?              @map("vendor_defense_notes") @db.Text
  vendorRespondedAt       DateTime?            @map("vendor_responded_at") @db.Timestamptz(3)
  vendorRespondedByUserId String?              @map("vendor_responded_by_user_id") @db.Uuid
  vendorRespondedBy       User?                @relation("DisputeVendorResponder", fields: [vendorRespondedByUserId], references: [id], onDelete: SetNull)
  resolutionNotes         String?              @map("resolution_notes") @db.Text
  resolvedAt              DateTime?            @map("resolved_at") @db.Timestamptz(3)
  resolvedByUserId        String?              @map("resolved_by_user_id") @db.Uuid
  resolvedBy              User?                @relation("DisputeResolver", fields: [resolvedByUserId], references: [id], onDelete: SetNull)
  /// Buyer-favour only: whether the goods came back (drives restocking of shipped packages).
  itemReturned            Boolean?             @map("item_returned")
  restocked               Boolean              @default(false)
  /// Buyer-favour only: amount owed back to the customer (package items + shipping).
  refundAmount            Decimal?             @map("refund_amount") @db.Decimal(15, 2)
  /// Buyer-favour only: vendor earnings that could not be recovered from the wallet (vendor debt).
  refundUnrecoveredAmount Decimal              @default(0) @map("refund_unrecovered_amount") @db.Decimal(15, 2)
  cancelledAt             DateTime?            @map("cancelled_at") @db.Timestamptz(3)
  createdAt               DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt               DateTime             @updatedAt @map("updated_at") @db.Timestamptz(3)

  evidence           DisputeEvidence[]
  events             DisputeEvent[]
  walletTransactions WalletTransaction[]

  @@index([subOrderId])
  @@index([status, createdAt])
  @@index([raisedByUserId, createdAt])
  @@index([vendorId, status, createdAt])
  @@map("disputes")
}

/// Uploaded proof for a dispute (photo, invoice, chat export). The uploader is
/// recorded separately from the raiser because staff and vendors may add files.
/// Since Phase 9 every row references the uploader's own media asset.
model DisputeEvidence {
  id               String      @id @default(uuid()) @db.Uuid
  disputeId        String      @map("dispute_id") @db.Uuid
  dispute          Dispute     @relation(fields: [disputeId], references: [id], onDelete: Cascade)
  uploadedByUserId String      @map("uploaded_by_user_id") @db.Uuid
  uploadedBy       User        @relation(fields: [uploadedByUserId], references: [id], onDelete: Restrict)
  mediaAssetId     String?     @map("media_asset_id") @db.Uuid
  mediaAsset       MediaAsset? @relation(fields: [mediaAssetId], references: [id], onDelete: SetNull)
  fileUrl          String      @map("file_url") @db.VarChar(512)
  fileType         String?     @map("file_type") @db.VarChar(40)
  caption          String?     @db.VarChar(255)
  createdAt        DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  @@unique([disputeId, mediaAssetId])
  @@index([disputeId, createdAt])
  @@index([uploadedByUserId])
  @@index([mediaAssetId])
  @@map("dispute_evidence")
}

/// Append-only timeline of a dispute: who did what, when, and the status change.
model DisputeEvent {
  id          String           @id @default(uuid()) @db.Uuid
  disputeId   String           @map("dispute_id") @db.Uuid
  dispute     Dispute          @relation(fields: [disputeId], references: [id], onDelete: Cascade)
  type        DisputeEventType
  actorUserId String?          @map("actor_user_id") @db.Uuid
  actorUser   User?            @relation(fields: [actorUserId], references: [id], onDelete: SetNull)
  /// CUSTOMER / VENDOR / STAFF / SYSTEM.
  actorRole   String           @map("actor_role") @db.VarChar(20)
  fromStatus  DisputeStatus?   @map("from_status")
  toStatus    DisputeStatus?   @map("to_status")
  note        String?          @db.VarChar(1000)
  data        Json?
  createdAt   DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([disputeId, createdAt])
  @@map("dispute_events")
}

// ============================================================================
// PLATFORM CONFIGURATION (Phase 1)
// ============================================================================

enum ConfigValueType {
  STRING
  NUMBER
  BOOLEAN
  JSON
}

/// Key/value platform configuration. `key` is the stable identifier consumed by
/// application code; rows are upserted by the seed and never invented at runtime.
model SystemConfig {
  id          String          @id @default(uuid()) @db.Uuid
  key         String          @unique @db.VarChar(120)
  value       String          @db.Text
  valueType   ConfigValueType @default(STRING) @map("value_type")
  description String?         @db.VarChar(255)
  createdAt   DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime        @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("system_configs")
}
```

### `apps/backend/src/app.module.ts`

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { resolveEnvFilePaths } from './config/env-file-paths';
import { validateEnvironment, type EnvironmentVariables } from './config/env.validation';
import { HealthModule } from './infra/health/health.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { MediaModule } from './modules/media/media.module';
import { SmsModule } from './modules/sms/sms.module';
import { StorageModule } from './modules/storage/storage.module';
import { UsersModule } from './modules/users/users.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ProductsModule } from './modules/products/products.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { AddressesModule } from './modules/addresses/addresses.module';
import { CartModule } from './modules/cart/cart.module';
import { BnplModule } from './modules/bnpl/bnpl.module';
import { CreditModule } from './modules/credit/credit.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { FinancialModule } from './modules/financial/financial.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot<EnvironmentVariables>({
      isGlobal: true,
      cache: true,
      envFilePath: resolveEnvFilePaths(),
      expandVariables: false,
      validate: (raw: Record<string, unknown>) => validateEnvironment(raw),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    // AuditModule comes before AuthModule: the auth module records LOGIN rows
    // through `AuditLogService`.
    AuditModule,
    AuthModule,
    UsersModule,
    SmsModule,
    // Storage is imported before MediaModule for readability; MediaModule pulls it
    // in itself, and `StorageModule` is stateless, so the order is not load-bearing.
    StorageModule,
    MediaModule,
    VendorsModule,
    CategoriesModule,
    ProductsModule,
    ShippingModule,
    AddressesModule,
    CartModule,
    OrdersModule,
    WalletModule,
    PaymentsModule,
    SettlementsModule,
    FinancialModule,
    CreditModule,
    BnplModule,
    DisputesModule,
  ],
  providers: [
    // Order matters: authentication runs first and populates `request.user`,
    // then authorization decides. Both are global, so every route is protected
    // unless it opts out with `@Public()`.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // One global interceptor writes the audit trail for mutating requests.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
```

### `apps/backend/src/modules/disputes/admin-disputes.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
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
import { DisputeQueriesService } from './dispute-queries.service';
import { DisputesService } from './disputes.service';
import { AdminDisputeDossierDto, AdminDisputePageDto, AdminDisputeQueryDto, ArbitrateDisputeDto, DisputeActionResultDto } from './dto/dispute.dto';

@ApiTags('admin-disputes')
@ApiBearerAuth('access-token')
@Roles(UserRole.SUPPORT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Support staff and administrators only' })
@Controller('admin/disputes')
export class AdminDisputesController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly queries: DisputeQueriesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'All disputes', description: 'Filter by status, reason, store, customer and opening date; newest first.' })
  @ApiOkResponse({ type: AdminDisputePageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or paging' })
  list(@Query() query: AdminDisputeQueryDto): Promise<AdminDisputePageDto> {
    return this.queries.adminList(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Dispute dossier',
    description: 'Everything needed to decide: order and payments, items, package status history, complaint, defence, evidence of both parties, timeline, the hold and the store’s current wallet.',
  })
  @ApiOkResponse({ type: AdminDisputeDossierDto })
  @ApiNotFoundResponse({ description: 'Dispute not found' })
  dossier(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<AdminDisputeDossierDto> {
    return this.queries.dossier(id);
  }

  @Post(':id/arbitrate')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction (DISPUTE_RESOLUTION on the dispute and on the package)
  @ApiOperation({
    summary: 'Arbitrate a dispute',
    description:
      'Any running dispute (OPEN or UNDER_ARBITRATION). Atomic: wallet ledger, package status, dispute and audit rows commit together. ' +
      'BUYER_FAVOR → package REFUNDED, frozen earnings deducted (REFUND_DEDUCTION; a delivered-package shortfall is recovered from the ' +
      'current withdrawable balance, the rest reported as `hold.unrecovered`), stock restored when appropriate, refund notice SMS to the ' +
      'customer after commit. VENDOR_FAVOR → package DELIVERED, frozen earnings released to WITHDRAWABLE (DISPUTE_HOLD_RELEASE).',
  })
  @ApiOkResponse({ type: DisputeActionResultDto })
  @ApiBadRequestResponse({ description: 'Validation error' })
  @ApiNotFoundResponse({ description: 'Dispute not found' })
  @ApiConflictResponse({ description: 'DISPUTE_ALREADY_CLOSED, CREDIT_ORDER_REFUND_UNSUPPORTED, INVALID_STATUS_TRANSITION or ESCROW_NOT_FROZEN' })
  arbitrate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ArbitrateDisputeDto,
    @ClientContext() context: RequestContext,
  ): Promise<DisputeActionResultDto> {
    return this.disputes.arbitrate(user, id, dto, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/disputes/customer-disputes.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { MAX_DISPUTES_PER_DAY } from './dispute-policy';
import { DisputeQueriesService } from './dispute-queries.service';
import { DisputesService } from './disputes.service';
import { CancelDisputeDto, CreateDisputeDto, CustomerDisputeQueryDto, DisputeActionResultDto, DisputeDto, DisputePageDto } from './dto/dispute.dto';

@ApiTags('customer-disputes')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Customers only' })
@Controller('customer/disputes')
export class CustomerDisputesController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly queries: DisputeQueriesService,
  ) {}

  @Post()
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Open a dispute about a package',
    description:
      'Only packages of your own PAID orders in PROCESSING, SHIPPED or DELIVERED; at most one active dispute per package, and a package whose ' +
      'dispute was already decided cannot be disputed again. In one transaction: the dispute (OPEN), its evidence and timeline are written ' +
      "and the package's vendor earnings are frozen in the store's DISPUTE_HOLD balance (from PENDING before delivery, from WITHDRAWABLE " +
      'after delivery — whatever the store already withdrew is recorded as `hold.shortfall`). While the dispute is active, delivery ' +
      `confirmation and status changes of the package are refused (409 SUB_ORDER_UNDER_DISPUTE). At most ${MAX_DISPUTES_PER_DAY} disputes per customer per 24 hours.`,
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: DisputeActionResultDto, description: 'Dispute opened; walletAction FROZEN (or NONE for zero earnings).' })
  @ApiBadRequestResponse({ description: 'Validation error, or EVIDENCE_NOT_ACCEPTED (not your own dispute_evidence upload)' })
  @ApiNotFoundResponse({ description: 'The package does not exist or is not yours' })
  @ApiConflictResponse({ description: 'ORDER_NOT_PAID, SUB_ORDER_NOT_DISPUTABLE, DISPUTE_ALREADY_ACTIVE, DISPUTE_ALREADY_DECIDED or ESCROW_NOT_FREEZABLE' })
  @ApiTooManyRequestsResponse({ description: 'Daily dispute quota exhausted' })
  open(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDisputeDto, @ClientContext() context: RequestContext): Promise<DisputeActionResultDto> {
    return this.disputes.open(user, dto, { actorId: user.id, context });
  }

  @Get()
  @ApiOperation({ summary: 'My disputes', description: 'Newest first, each with its status, the store’s answer, the outcome and the full timeline.' })
  @ApiOkResponse({ type: DisputePageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or paging' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: CustomerDisputeQueryDto): Promise<DisputePageDto> {
    return this.queries.customerList(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my disputes', description: 'Complaint, evidence of both parties, the store’s response, the outcome (refund amount) and the timeline.' })
  @ApiOkResponse({ type: DisputeDto })
  @ApiNotFoundResponse({ description: 'Dispute not found (or not yours)' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<DisputeDto> {
    return this.queries.customerDetail(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Withdraw my dispute',
    description:
      'Allowed while the dispute is OPEN or UNDER_ARBITRATION. The frozen earnings go back to where they were frozen from ' +
      '(escrow PENDING before delivery → RETURNED_TO_ESCROW; WITHDRAWABLE for a delivered package → RELEASED_TO_WITHDRAWABLE); ' +
      'the package status does not change. A new dispute about the same package may be opened later.',
  })
  @ApiOkResponse({ type: DisputeActionResultDto })
  @ApiNotFoundResponse({ description: 'Dispute not found (or not yours)' })
  @ApiConflictResponse({ description: 'DISPUTE_NOT_CANCELLABLE (already decided or cancelled) or ESCROW_NOT_FROZEN' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelDisputeDto,
    @ClientContext() context: RequestContext,
  ): Promise<DisputeActionResultDto> {
    return this.disputes.cancel(user, id, dto, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/disputes/dispute-notifier.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { DisputeEventType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

/** Transactional SMS sent to the customer when a dispute is decided in their favour. `{key}` placeholders are filled by the provider. */
export const DISPUTE_REFUND_TEMPLATE =
  'شاپینو: اختلاف مرسولهٔ {subOrderNumber} به نفع شما حل شد. مبلغ {amount} ریال به شما بازگردانده می‌شود.';

export interface RefundNotice {
  disputeId: string;
  mobile: string;
  subOrderNumber: string;
  amount: string;
}

/**
 * Refund notice of a buyer-favour decision. Runs **after** the decision has
 * committed: an SMS outage must never roll back a financial resolution. The
 * outcome (sent with the provider reference, or failed) is appended to the
 * dispute timeline so staff can see who still has to be told.
 */
@Injectable()
export class DisputeNotifier {
  private readonly logger = new Logger(DisputeNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  async refundNotice(notice: RefundNotice): Promise<void> {
    try {
      const sent = await this.sms.sendTransactional(notice.mobile, DISPUTE_REFUND_TEMPLATE, {
        subOrderNumber: notice.subOrderNumber,
        amount: notice.amount,
      });
      await this.record(notice.disputeId, DisputeEventType.REFUND_NOTICE_SENT, 'Refund notice sent by SMS', {
        provider: sent.provider,
        referenceId: sent.referenceId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Refund notice for dispute ${notice.disputeId} failed: ${detail}`);
      await this.record(notice.disputeId, DisputeEventType.REFUND_NOTICE_FAILED, 'Refund notice could not be sent; contact the customer', {
        error: detail.slice(0, 300),
      }).catch((recordError: unknown) => {
        this.logger.error(`Could not record the failed refund notice of dispute ${notice.disputeId}: ${String(recordError)}`);
      });
    }
  }

  private async record(disputeId: string, type: DisputeEventType, note: string, data: Record<string, string>): Promise<void> {
    await this.prisma.disputeEvent.create({ data: { disputeId, type, actorRole: 'SYSTEM', note, data } });
  }
}
```

### `apps/backend/src/modules/disputes/dispute-policy.spec.ts`

```ts
import { DisputeStatus, Prisma, SubOrderStatus } from '@prisma/client';
import { customerCanCancel, maskMobile, openRejection, refundDue, shouldRestock, staffCanArbitrate, vendorCanRespond } from './dispute-policy';

describe('dispute-policy', () => {
  describe('openRejection', () => {
    it('allows PROCESSING, SHIPPED and DELIVERED packages of paid orders', () => {
      for (const status of [SubOrderStatus.PROCESSING, SubOrderStatus.SHIPPED, SubOrderStatus.DELIVERED]) {
        expect(openRejection(true, status, [])).toBeNull();
      }
    });

    it('refuses unpaid orders and every other package status', () => {
      expect(openRejection(false, SubOrderStatus.SHIPPED, [])?.code).toBe('ORDER_NOT_PAID');
      for (const status of [SubOrderStatus.PENDING_APPROVAL, SubOrderStatus.CANCELLED, SubOrderStatus.REFUNDED]) {
        expect(openRejection(true, status, [])?.code).toBe('SUB_ORDER_NOT_DISPUTABLE');
      }
    });

    it('allows one active dispute per package, never re-opens a decided one, but allows a new one after a cancellation', () => {
      for (const status of [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION]) {
        expect(openRejection(true, SubOrderStatus.DELIVERED, [{ id: 'a', status }])).toEqual(expect.objectContaining({ code: 'DISPUTE_ALREADY_ACTIVE', disputeId: 'a' }));
      }
      for (const status of [DisputeStatus.RESOLVED_BUYER_FAVOR, DisputeStatus.RESOLVED_VENDOR_FAVOR]) {
        expect(openRejection(true, SubOrderStatus.DELIVERED, [{ id: 'b', status }])).toEqual(expect.objectContaining({ code: 'DISPUTE_ALREADY_DECIDED', disputeId: 'b' }));
      }
      expect(openRejection(true, SubOrderStatus.DELIVERED, [{ id: 'c', status: DisputeStatus.CANCELLED }])).toBeNull();
    });
  });

  it('lets the vendor answer only OPEN disputes; staff and customer act on any running dispute', () => {
    expect(vendorCanRespond(DisputeStatus.OPEN)).toBe(true);
    expect(vendorCanRespond(DisputeStatus.UNDER_ARBITRATION)).toBe(false);
    for (const status of [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION]) {
      expect(staffCanArbitrate(status)).toBe(true);
      expect(customerCanCancel(status)).toBe(true);
    }
    for (const status of [DisputeStatus.RESOLVED_BUYER_FAVOR, DisputeStatus.RESOLVED_VENDOR_FAVOR, DisputeStatus.CANCELLED]) {
      expect(staffCanArbitrate(status)).toBe(false);
      expect(customerCanCancel(status)).toBe(false);
      expect(vendorCanRespond(status)).toBe(false);
    }
  });

  it('restocks goods that never shipped, and shipped goods only when they came back', () => {
    expect(shouldRestock(SubOrderStatus.PROCESSING, undefined)).toBe(true);
    expect(shouldRestock(SubOrderStatus.SHIPPED, undefined)).toBe(false);
    expect(shouldRestock(SubOrderStatus.SHIPPED, false)).toBe(false);
    expect(shouldRestock(SubOrderStatus.DELIVERED, true)).toBe(true);
  });

  it('owes the customer the items and the shipping of the package', () => {
    expect(refundDue({ itemsSubtotal: new Prisma.Decimal('6000000.00'), shippingFee: new Prisma.Decimal('450000.00') }).toFixed(2)).toBe('6450000.00');
  });

  it('masks mobiles for the other party', () => {
    expect(maskMobile('+989121234567')).toBe('+98912***4567');
    expect(maskMobile('123')).toBe('***');
  });
});
```

### `apps/backend/src/modules/disputes/dispute-policy.ts`

```ts
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
```

### `apps/backend/src/modules/disputes/dispute-queries.service.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { requireStore } from '../wallet/vendor-store';
import { disputeSelect, dossierSelect, toAdminSummaryDto, toDisputeDto, toDossierDto, toVendorDisputeDto, type DisputeRow } from './dispute-views';
import type {
  AdminDisputeDossierDto,
  AdminDisputePageDto,
  AdminDisputeQueryDto,
  CustomerDisputeQueryDto,
  DisputeDto,
  DisputePageDto,
  VendorDisputeDto,
  VendorDisputePageDto,
  VendorDisputeQueryDto,
} from './dto/dispute.dto';

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/**
 * Read side of disputes. Every query is scoped to its audience: a customer sees
 * the disputes they raised, a store the disputes against it, staff everything.
 * A dispute outside the caller's scope is a 404 (existence is not revealed).
 */
@Injectable()
export class DisputeQueriesService {
  constructor(private readonly prisma: PrismaService) {}

  // customer
  customerList(userId: string, query: CustomerDisputeQueryDto): Promise<DisputePageDto> {
    return this.page({ raisedByUserId: userId, status: query.status }, query, toDisputeDto);
  }

  async customerDetail(userId: string, disputeId: string): Promise<DisputeDto> {
    return toDisputeDto(await this.one({ id: disputeId, raisedByUserId: userId }));
  }

  // vendor
  async vendorList(userId: string, query: VendorDisputeQueryDto): Promise<VendorDisputePageDto> {
    const store = await requireStore(this.prisma, userId);
    return this.page({ vendorId: store.id, status: query.status }, query, toVendorDisputeDto);
  }

  async vendorDetail(userId: string, disputeId: string): Promise<VendorDisputeDto> {
    const store = await requireStore(this.prisma, userId);
    return toVendorDisputeDto(await this.one({ id: disputeId, vendorId: store.id }));
  }

  // staff
  adminList(query: AdminDisputeQueryDto): Promise<AdminDisputePageDto> {
    const createdAt = query.from || query.to ? { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } : undefined;
    return this.page(
      { status: query.status, reason: query.reason, vendorId: query.vendorId, raisedByUserId: query.customerId, createdAt },
      query,
      toAdminSummaryDto,
    );
  }

  async dossier(disputeId: string): Promise<AdminDisputeDossierDto> {
    const row = await this.prisma.dispute.findUnique({ where: { id: disputeId }, select: dossierSelect });
    if (!row) {
      throw new NotFoundException('Dispute not found');
    }
    return toDossierDto(row);
  }

  /** The shared view returned by every command (the caller was already authorised). */
  async shared(disputeId: string): Promise<DisputeDto> {
    return toDisputeDto(await this.one({ id: disputeId }));
  }

  private async one(where: Prisma.DisputeWhereInput): Promise<DisputeRow> {
    const row = await this.prisma.dispute.findFirst({ where, select: disputeSelect });
    if (!row) {
      throw new NotFoundException('Dispute not found');
    }
    return row;
  }

  private async page<T>(where: Prisma.DisputeWhereInput, query: { page: number; pageSize: number }, map: (row: DisputeRow) => T): Promise<Page<T>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.dispute.findMany({
        where,
        select: disputeSelect,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.dispute.count({ where }),
    ]);
    return { items: rows.map(map), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }
}
```

### `apps/backend/src/modules/disputes/dispute-views.ts`

```ts
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
```

### `apps/backend/src/modules/disputes/disputes.module.ts`

```ts
import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module';
import { SmsModule } from '../sms/sms.module';
import { WalletModule } from '../wallet/wallet.module';
import { AdminDisputesController } from './admin-disputes.controller';
import { CustomerDisputesController } from './customer-disputes.controller';
import { DisputeNotifier } from './dispute-notifier';
import { DisputeQueriesService } from './dispute-queries.service';
import { DisputesService } from './disputes.service';
import { VendorDisputesController } from './vendor-disputes.controller';

/**
 * Disputes (Phase 9): customer complaints about a package, the store's answer,
 * staff arbitration, and the escrow freeze / release / refund that follows.
 * Money moves through WalletLedgerService; the package status through
 * OrderLifecycleService, so the wallet ledger and the order state machine stay
 * the only writers of their tables.
 */
@Module({
  imports: [OrdersModule, WalletModule, SmsModule],
  controllers: [CustomerDisputesController, VendorDisputesController, AdminDisputesController],
  providers: [DisputesService, DisputeQueriesService, DisputeNotifier],
})
export class DisputesModule {}
```

### `apps/backend/src/modules/disputes/disputes.service.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditAction,
  DisputeEventType,
  DisputeStatus,
  DisputeVendorAction,
  MediaKind,
  Prisma,
  SubOrderStatus,
  WalletBalanceBucket,
} from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import type { ActorRole } from '../orders/order-views';
import { WalletLedgerService, type DisputeRefund } from '../wallet/wallet-ledger.service';
import { requireStore } from '../wallet/vendor-store';
import { DisputeNotifier, type RefundNotice } from './dispute-notifier';
import { customerCanCancel, MAX_DISPUTES_PER_DAY, openRejection, refundDue, shouldRestock, staffCanArbitrate, vendorCanRespond } from './dispute-policy';
import { DisputeQueriesService } from './dispute-queries.service';
import type { ArbitrateDisputeDto, CancelDisputeDto, CreateDisputeDto, DisputeActionResultDto, VendorRespondDisputeDto } from './dto/dispute.dto';

type Tx = Prisma.TransactionClient;
type WalletResult = DisputeActionResultDto['walletAction'];

const DAY_SECONDS = 24 * 60 * 60;
export const EVIDENCE_PURPOSE = 'dispute_evidence';
export const disputeOpenCountKey = (userId: string): string => `dispute:open:count:${userId}`;

/** The dispute as the commands need it, read under the parent-order lock. */
const lockedSelect = {
  id: true,
  status: true,
  subOrderId: true,
  holdSource: true,
  holdAmount: true,
  holdShortfall: true,
  raisedBy: { select: { mobile: true } },
  subOrder: {
    select: { id: true, vendorId: true, subOrderNumber: true, vendorEarningsAmount: true, status: true, itemsSubtotal: true, shippingFee: true },
  },
} satisfies Prisma.DisputeSelect;
type LockedDispute = Prisma.DisputeGetPayload<{ select: typeof lockedSelect }>;

interface EvidenceAsset {
  id: string;
  url: string;
  mimeType: string;
}

interface Decision {
  role: ActorRole;
  userId: string;
  notes: string;
  itemReturned: boolean | undefined;
  event: DisputeEventType;
  actor: OrderActor;
}

interface Resolved {
  walletAction: WalletResult;
  stockAction: 'RESTOCKED' | 'NONE';
  subOrderStatus: SubOrderStatus;
  notice: RefundNotice | null;
}

/**
 * State-changing side of disputes (Phase 9).
 *
 * Every command takes the **parent-order lock first** — the same lock the order
 * lifecycle, payment callbacks and delivery confirmation take — so a dispute can
 * never race a status change of its package. Lock order stays
 * parent → stock → wallet. The dispute row, its evidence and timeline, the wallet
 * ledger, the package status and the audit rows commit in one transaction; the
 * refund SMS goes out only after the commit.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly ledger: WalletLedgerService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly notifier: DisputeNotifier,
    private readonly queries: DisputeQueriesService,
  ) {}

  // ─── customer ─────────────────────────────────────────────────────────────

  async open(user: AuthenticatedUser, dto: CreateDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const owned = await this.prisma.subOrder.findFirst({
      where: { id: dto.subOrderId, parentOrder: { userId: user.id } },
      select: { parentOrderId: true },
    });
    if (!owned) {
      throw new NotFoundException('Sub-order not found');
    }
    const evidence = await this.resolveEvidence(dto.evidenceUrls, user.id);
    await this.enforceDailyLimit(user.id);

    const opened = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, owned.parentOrderId);
      const sub = await tx.subOrder.findUniqueOrThrow({
        where: { id: dto.subOrderId },
        select: {
          id: true,
          vendorId: true,
          subOrderNumber: true,
          vendorEarningsAmount: true,
          status: true,
          parentOrder: { select: { paymentStatus: true } },
          disputes: { select: { id: true, status: true } },
        },
      });
      const rejection = openRejection(sub.parentOrder.paymentStatus === 'PAID', sub.status, sub.disputes);
      if (rejection) {
        const { code, message, ...details } = rejection;
        throw conflictWith(code, message, details);
      }

      const dispute = await tx.dispute
        .create({
          data: {
            subOrderId: sub.id,
            vendorId: sub.vendorId,
            raisedByUserId: user.id,
            reason: dto.reason,
            description: dto.description,
            subOrderStatusAtOpen: sub.status,
          },
          select: { id: true },
        })
        .catch((error: unknown) => {
          // Backstop of the partial unique index "one active dispute per package".
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
            throw conflictWith('DISPUTE_ALREADY_ACTIVE', 'This package already has an active dispute');
          }
          throw error;
        });

      const freeze = await this.ledger.freezeForDispute(tx, sub, dispute.id);
      await tx.dispute.update({
        where: { id: dispute.id },
        data: { holdSource: freeze.source, holdAmount: freeze.amount, holdShortfall: freeze.shortfall },
      });
      await this.addEvidence(tx, dispute.id, user.id, evidence);

      const shortfallNote = freeze.shortfall.greaterThan(0)
        ? ` Shortfall ${freeze.shortfall.toFixed(2)}: the store had already withdrawn part of these earnings.`
        : '';
      await tx.disputeEvent.create({
        data: {
          disputeId: dispute.id,
          type: DisputeEventType.OPENED,
          actorUserId: user.id,
          actorRole: 'CUSTOMER',
          toStatus: DisputeStatus.OPEN,
          note: `Dispute opened (${dto.reason}).${shortfallNote}`.slice(0, 1000),
          data: {
            reason: dto.reason,
            evidenceCount: evidence.length,
            holdSource: freeze.source,
            holdAmount: freeze.amount.toFixed(2),
            holdShortfall: freeze.shortfall.toFixed(2),
          },
        },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Dispute',
        entityId: dispute.id,
        newValue: {
          subOrderId: sub.id,
          subOrderNumber: sub.subOrderNumber,
          reason: dto.reason,
          status: DisputeStatus.OPEN,
          subOrderStatus: sub.status,
          holdSource: freeze.source,
          holdAmount: freeze.amount.toFixed(2),
          holdShortfall: freeze.shortfall.toFixed(2),
          evidenceCount: evidence.length,
        },
      });
      return { id: dispute.id, frozen: freeze.source !== null, subOrderStatus: sub.status };
    });

    return this.result(opened.id, opened.frozen ? 'FROZEN' : 'NONE', opened.subOrderStatus, 'NONE');
  }

  /** The customer withdraws the dispute: the frozen earnings go back where they came from; the package keeps its status. */
  async cancel(user: AuthenticatedUser, disputeId: string, dto: CancelDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const parentOrderId = await this.parentOf({ id: disputeId, raisedByUserId: user.id });

    const done = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, parentOrderId);
      const dispute = await this.locked(tx, disputeId);
      if (!customerCanCancel(dispute.status)) {
        throw conflictWith('DISPUTE_NOT_CANCELLABLE', `A ${dispute.status} dispute cannot be cancelled`, { status: dispute.status });
      }
      const credited = await this.ledger.releaseDisputeHold(tx, dispute.subOrder, dispute, 'SOURCE');
      await tx.dispute.update({ where: { id: dispute.id }, data: { status: DisputeStatus.CANCELLED, cancelledAt: new Date() } });
      const note = dto.reason ?? 'Cancelled by the customer';
      await tx.disputeEvent.create({
        data: {
          disputeId: dispute.id,
          type: DisputeEventType.CANCELLED_BY_CUSTOMER,
          actorUserId: user.id,
          actorRole: 'CUSTOMER',
          fromStatus: dispute.status,
          toStatus: DisputeStatus.CANCELLED,
          note,
          data: { holdReturnedTo: credited, amount: dispute.holdAmount.toFixed(2) },
        },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.STATUS_CHANGE,
        entityName: 'Dispute',
        entityId: dispute.id,
        oldValue: { status: dispute.status },
        newValue: { status: DisputeStatus.CANCELLED, note, holdReturnedTo: credited, amount: dispute.holdAmount.toFixed(2) },
      });
      const walletAction: WalletResult =
        credited === null ? 'NONE' : credited === WalletBalanceBucket.WITHDRAWABLE ? 'RELEASED_TO_WITHDRAWABLE' : 'RETURNED_TO_ESCROW';
      return { walletAction, subOrderStatus: dispute.subOrder.status };
    });

    return this.result(disputeId, done.walletAction, done.subOrderStatus, 'NONE');
  }

  // ─── vendor ───────────────────────────────────────────────────────────────

  async respond(user: AuthenticatedUser, disputeId: string, dto: VendorRespondDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const store = await requireStore(this.prisma, user.id);
    const parentOrderId = await this.parentOf({ id: disputeId, vendorId: store.id });
    const evidence = await this.resolveEvidence(dto.evidenceUrls ?? [], user.id);

    const done = await this.prisma.$transaction(async (tx): Promise<Resolved> => {
      await lockParentOrder(tx, parentOrderId);
      const dispute = await this.locked(tx, disputeId);
      if (!vendorCanRespond(dispute.status)) {
        throw conflictWith('DISPUTE_NOT_AWAITING_VENDOR', `The store can no longer answer a ${dispute.status} dispute`, { status: dispute.status });
      }
      await tx.dispute.update({
        where: { id: dispute.id },
        data: { vendorAction: dto.action, vendorDefenseNotes: dto.defenseNotes, vendorRespondedAt: new Date(), vendorRespondedByUserId: user.id },
      });
      await this.addEvidence(tx, dispute.id, user.id, evidence);

      if (dto.action === DisputeVendorAction.ACCEPT_RETURN) {
        return this.resolveForBuyer(tx, dispute, {
          role: 'VENDOR',
          userId: user.id,
          notes: `Store accepted the return: ${dto.defenseNotes}`,
          itemReturned: dto.itemReturned,
          event: DisputeEventType.VENDOR_ACCEPTED_RETURN,
          actor,
        });
      }

      await tx.dispute.update({ where: { id: dispute.id }, data: { status: DisputeStatus.UNDER_ARBITRATION } });
      await tx.disputeEvent.create({
        data: {
          disputeId: dispute.id,
          type: DisputeEventType.VENDOR_DEFENDED,
          actorUserId: user.id,
          actorRole: 'VENDOR',
          fromStatus: dispute.status,
          toStatus: DisputeStatus.UNDER_ARBITRATION,
          note: dto.defenseNotes.slice(0, 1000),
          data: { evidenceCount: evidence.length },
        },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.STATUS_CHANGE,
        entityName: 'Dispute',
        entityId: dispute.id,
        oldValue: { status: dispute.status },
        newValue: { status: DisputeStatus.UNDER_ARBITRATION, vendorAction: dto.action, evidenceCount: evidence.length },
      });
      return { walletAction: 'NONE', stockAction: 'NONE', subOrderStatus: dispute.subOrder.status, notice: null };
    });

    return this.finish(disputeId, done);
  }

  // ─── staff ────────────────────────────────────────────────────────────────

  async arbitrate(user: AuthenticatedUser, disputeId: string, dto: ArbitrateDisputeDto, actor: OrderActor): Promise<DisputeActionResultDto> {
    const parentOrderId = await this.parentOf({ id: disputeId });

    const done = await this.prisma.$transaction(async (tx): Promise<Resolved> => {
      await lockParentOrder(tx, parentOrderId);
      const dispute = await this.locked(tx, disputeId);
      if (!staffCanArbitrate(dispute.status)) {
        throw conflictWith('DISPUTE_ALREADY_CLOSED', `A ${dispute.status} dispute cannot be arbitrated`, { status: dispute.status });
      }
      if (dto.decision === 'BUYER_FAVOR') {
        return this.resolveForBuyer(tx, dispute, {
          role: 'STAFF',
          userId: user.id,
          notes: dto.resolutionNotes,
          itemReturned: dto.itemReturned,
          event: DisputeEventType.ARBITRATED_BUYER_FAVOR,
          actor,
        });
      }
      return this.resolveForVendor(tx, dispute, {
        role: 'STAFF',
        userId: user.id,
        notes: dto.resolutionNotes,
        itemReturned: undefined,
        event: DisputeEventType.ARBITRATED_VENDOR_FAVOR,
        actor,
      });
    });

    return this.finish(disputeId, done);
  }

  // ─── outcomes ─────────────────────────────────────────────────────────────

  /**
   * Buyer favour: package REFUNDED (restocked when appropriate), frozen earnings
   * deducted with REFUND_DEDUCTION (plus any shortfall recovered from the
   * current withdrawable balance), refund owed to the customer recorded.
   */
  private async resolveForBuyer(tx: Tx, dispute: LockedDispute, decision: Decision): Promise<Resolved> {
    const restock = shouldRestock(dispute.subOrder.status, decision.itemReturned);
    let refund: DisputeRefund | null = null;
    const transition = await this.lifecycle.applyDisputeOutcomeLocked(
      tx,
      dispute.subOrderId,
      SubOrderStatus.REFUNDED,
      { role: decision.role, note: decision.notes.slice(0, 500), actor: decision.actor },
      {
        restock,
        wallet: async (walletTx, pkg) => {
          refund = await this.ledger.refundDisputeHold(walletTx, pkg, dispute, decision.notes);
          return refund.fromHold.plus(refund.fromWithdrawable).greaterThan(0) ? 'DISPUTE_HOLD_REFUNDED' : 'NONE';
        },
        audit: { disputeId: dispute.id, decision: 'BUYER_FAVOR', itemReturned: decision.itemReturned ?? null },
      },
    );
    const settled = refund as DisputeRefund | null;
    const fromHold = settled?.fromHold ?? new Prisma.Decimal(0);
    const fromWithdrawable = settled?.fromWithdrawable ?? new Prisma.Decimal(0);
    const unrecovered = settled?.unrecovered ?? new Prisma.Decimal(0);
    const amount = refundDue(dispute.subOrder);
    const restocked = transition.stockAction === 'RESTOCKED';

    await tx.dispute.update({
      where: { id: dispute.id },
      data: {
        status: DisputeStatus.RESOLVED_BUYER_FAVOR,
        resolvedAt: new Date(),
        resolvedByUserId: decision.userId,
        resolutionNotes: decision.notes,
        itemReturned: decision.itemReturned ?? null,
        restocked,
        refundAmount: amount,
        refundUnrecoveredAmount: unrecovered,
      },
    });
    const financial = {
      refundAmount: amount.toFixed(2),
      deductedFromHold: fromHold.toFixed(2),
      recoveredFromWithdrawable: fromWithdrawable.toFixed(2),
      unrecovered: unrecovered.toFixed(2),
      restocked,
    };
    await this.closeWith(tx, dispute, decision, DisputeStatus.RESOLVED_BUYER_FAVOR, financial);

    const deducted = fromHold.plus(fromWithdrawable).greaterThan(0);
    return {
      walletAction: deducted ? 'REFUNDED' : 'NONE',
      stockAction: transition.stockAction,
      subOrderStatus: SubOrderStatus.REFUNDED,
      notice: { disputeId: dispute.id, mobile: dispute.raisedBy.mobile, subOrderNumber: dispute.subOrder.subOrderNumber, amount: amount.toFixed(0) },
    };
  }

  /** Vendor favour: package DELIVERED, frozen earnings released to WITHDRAWABLE, escrow marked released. */
  private async resolveForVendor(tx: Tx, dispute: LockedDispute, decision: Decision): Promise<Resolved> {
    let credited: WalletBalanceBucket | null = null;
    const transition = await this.lifecycle.applyDisputeOutcomeLocked(
      tx,
      dispute.subOrderId,
      SubOrderStatus.DELIVERED,
      { role: decision.role, note: decision.notes.slice(0, 500), actor: decision.actor },
      {
        restock: false,
        wallet: async (walletTx, pkg) => {
          credited = await this.ledger.releaseDisputeHold(walletTx, pkg, dispute, 'WITHDRAWABLE');
          await walletTx.subOrder.updateMany({ where: { id: pkg.id, escrowReleasedAt: null }, data: { escrowReleasedAt: new Date() } });
          return credited === null ? 'NONE' : 'DISPUTE_HOLD_RELEASED';
        },
        audit: { disputeId: dispute.id, decision: 'VENDOR_FAVOR' },
      },
    );
    await tx.dispute.update({
      where: { id: dispute.id },
      data: { status: DisputeStatus.RESOLVED_VENDOR_FAVOR, resolvedAt: new Date(), resolvedByUserId: decision.userId, resolutionNotes: decision.notes },
    });
    await this.closeWith(tx, dispute, decision, DisputeStatus.RESOLVED_VENDOR_FAVOR, {
      releasedToWithdrawable: credited === null ? '0.00' : dispute.holdAmount.toFixed(2),
    });
    return {
      walletAction: credited === null ? 'NONE' : 'RELEASED_TO_WITHDRAWABLE',
      stockAction: transition.stockAction,
      subOrderStatus: SubOrderStatus.DELIVERED,
      notice: null,
    };
  }

  private async closeWith(tx: Tx, dispute: LockedDispute, decision: Decision, status: DisputeStatus, financial: Record<string, unknown>): Promise<void> {
    await tx.disputeEvent.create({
      data: {
        disputeId: dispute.id,
        type: decision.event,
        actorUserId: decision.userId,
        actorRole: decision.role,
        fromStatus: dispute.status,
        toStatus: status,
        note: decision.notes.slice(0, 1000),
        data: financial as Prisma.InputJsonObject,
      },
    });
    await writeOrderAudit(tx, decision.actor, {
      action: AuditAction.DISPUTE_RESOLUTION,
      entityName: 'Dispute',
      entityId: dispute.id,
      oldValue: { status: dispute.status, subOrderStatus: dispute.subOrder.status },
      newValue: {
        status,
        decidedBy: decision.role,
        subOrderId: dispute.subOrderId,
        subOrderNumber: dispute.subOrder.subOrderNumber,
        holdSource: dispute.holdSource,
        holdAmount: dispute.holdAmount.toFixed(2),
        holdShortfall: dispute.holdShortfall.toFixed(2),
        ...financial,
      },
    });
  }

  // ─── helpers ──────────────────────────────────────────────────────────────

  private async finish(disputeId: string, done: Resolved): Promise<DisputeActionResultDto> {
    if (done.notice) {
      await this.notifier.refundNotice(done.notice);
    }
    return this.result(disputeId, done.walletAction, done.subOrderStatus, done.stockAction);
  }

  private async result(
    disputeId: string,
    walletAction: WalletResult,
    subOrderStatus: SubOrderStatus,
    stockAction: 'RESTOCKED' | 'NONE',
  ): Promise<DisputeActionResultDto> {
    return { dispute: await this.queries.shared(disputeId), walletAction, subOrderStatus, stockAction };
  }

  /** Parent order of a dispute the caller may act on; 404 otherwise (never reveals foreign disputes). */
  private async parentOf(where: Prisma.DisputeWhereInput): Promise<string> {
    const found = await this.prisma.dispute.findFirst({ where, select: { subOrder: { select: { parentOrderId: true } } } });
    if (!found) {
      throw new NotFoundException('Dispute not found');
    }
    return found.subOrder.parentOrderId;
  }

  private locked(tx: Tx, disputeId: string): Promise<LockedDispute> {
    return tx.dispute.findUniqueOrThrow({ where: { id: disputeId }, select: lockedSelect });
  }

  /**
   * Evidence URLs → the caller's own private `dispute_evidence` documents.
   * Anything else (someone else's file, a KYC document, a public image) is 400:
   * attaching it would expose it to the other party of the dispute.
   */
  private async resolveEvidence(urls: readonly string[], userId: string): Promise<EvidenceAsset[]> {
    if (urls.length === 0) return [];
    const ids = urls.map((url) => url.split('/').at(-2) ?? '');
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerUserId: true, purpose: true, kind: true, isPublic: true, mimeType: true },
    });
    return urls.map((url, index) => {
      const asset = assets.find((candidate) => candidate.id === ids[index]);
      if (!asset || asset.ownerUserId !== userId || asset.purpose !== EVIDENCE_PURPOSE || asset.kind !== MediaKind.DOCUMENT || asset.isPublic) {
        throw badRequestWith(
          'EVIDENCE_NOT_ACCEPTED',
          `Evidence must be your own upload from POST /media/upload/document with purpose ${EVIDENCE_PURPOSE}`,
          { url },
        );
      }
      return { id: asset.id, url, mimeType: asset.mimeType };
    });
  }

  private async addEvidence(tx: Tx, disputeId: string, userId: string, evidence: readonly EvidenceAsset[]): Promise<void> {
    if (evidence.length === 0) return;
    const existing = await tx.disputeEvidence.findMany({
      where: { disputeId, mediaAssetId: { in: evidence.map((item) => item.id) } },
      select: { mediaAssetId: true },
    });
    const fresh = evidence.filter((item) => !existing.some((row) => row.mediaAssetId === item.id));
    if (fresh.length === 0) return;
    await tx.disputeEvidence.createMany({
      data: fresh.map((item) => ({ disputeId, uploadedByUserId: userId, mediaAssetId: item.id, fileUrl: item.url, fileType: item.mimeType.slice(0, 40) })),
    });
  }

  private async enforceDailyLimit(userId: string): Promise<void> {
    const key = disputeOpenCountKey(userId);
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, DAY_SECONDS);
    if (count > MAX_DISPUTES_PER_DAY) {
      const ttl = await this.redis.client.ttl(key);
      throw new TooManyRequestsException('Too many disputes opened today; try again later', ttl > 0 ? ttl : DAY_SECONDS);
    }
  }
}
```

### `apps/backend/src/modules/disputes/dto/dispute.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional, type ApiPropertyOptions } from '@nestjs/swagger';
import { DisputeEventType, DisputeReason, DisputeStatus, DisputeVendorAction, ParentOrderPaymentStatus, PaymentMethod, SubOrderStatus, WalletBalanceBucket } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { ArrayMaxSize, ArrayUnique, IsArray, IsBoolean, IsDate, IsEnum, IsIn, IsOptional, IsString, IsUUID, Length, Matches } from 'class-validator';
import { DOCUMENT_URL_HINT, DOCUMENT_URL_PATTERN } from '../../media/media-urls';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { MONEY } from '../../wallet/dto/wallet.dto';
import { MAX_EVIDENCE_PER_REQUEST } from '../dispute-policy';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const EVIDENCE_MESSAGE = `each evidenceUrls item must be the url returned by ${DOCUMENT_URL_HINT} (purpose=dispute_evidence)`;

const EVIDENCE_PROPERTY: ApiPropertyOptions & { description: string } = {
  type: [String],
  maxItems: MAX_EVIDENCE_PER_REQUEST,
  example: ['/api/v1/media/documents/7a4c3f7e-8d1b-4a45-9a61-2f1f5a0c2b10/download'],
  description:
    `Proof files (JPEG / PNG / PDF). Upload each with \`POST /media/upload/document\` and purpose \`dispute_evidence\`, then send the returned ` +
    '`url`. Only your own uploads are accepted; they stay private and are readable by the other party of the dispute and staff.',
};

// ─── input ──────────────────────────────────────────────────────────────────

export class CreateDisputeDto {
  @ApiProperty({ format: 'uuid', description: 'The package (sub-order) of one of your paid orders.' })
  @IsUUID('4')
  subOrderId!: string;

  @ApiProperty({ enum: DisputeReason })
  @IsEnum(DisputeReason)
  reason!: DisputeReason;

  @ApiProperty({ minLength: 20, maxLength: 2000, example: 'The screen arrived cracked; the box was dented on one corner.' })
  @Transform(trim)
  @IsString()
  @Length(20, 2000)
  description!: string;

  @ApiProperty({ ...EVIDENCE_PROPERTY, description: `${EVIDENCE_PROPERTY.description} May be empty (e.g. NOT_DELIVERED).` })
  @IsArray()
  @ArrayMaxSize(MAX_EVIDENCE_PER_REQUEST)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(DOCUMENT_URL_PATTERN, { each: true, message: EVIDENCE_MESSAGE })
  evidenceUrls!: string[];
}

export class CancelDisputeDto {
  @ApiPropertyOptional({ maxLength: 500, example: 'The seller sent a replacement.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Length(1, 500)
  reason?: string;
}

export class VendorRespondDisputeDto {
  @ApiProperty({
    enum: DisputeVendorAction,
    description: 'ACCEPT_RETURN resolves the dispute for the customer immediately (refund); REJECT_WITH_DEFENSE sends it to staff arbitration.',
  })
  @IsEnum(DisputeVendorAction)
  action!: DisputeVendorAction;

  @ApiProperty({ minLength: 10, maxLength: 2000, example: 'The item was photographed intact before dispatch; see the attached packing photos.' })
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  defenseNotes!: string;

  @ApiPropertyOptional(EVIDENCE_PROPERTY)
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_EVIDENCE_PER_REQUEST)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(DOCUMENT_URL_PATTERN, { each: true, message: EVIDENCE_MESSAGE })
  evidenceUrls?: string[];

  @ApiPropertyOptional({
    description:
      'ACCEPT_RETURN only: the goods physically came back to the store. Shipped/delivered stock is restocked only when true; ' +
      'goods that never shipped are always restocked.',
  })
  @IsOptional()
  @IsBoolean()
  itemReturned?: boolean;
}

export const ARBITRATION_DECISIONS = ['BUYER_FAVOR', 'VENDOR_FAVOR'] as const;
export type ArbitrationDecision = (typeof ARBITRATION_DECISIONS)[number];

export class ArbitrateDisputeDto {
  @ApiProperty({
    enum: ARBITRATION_DECISIONS,
    description:
      'BUYER_FAVOR: package REFUNDED, frozen earnings deducted (REFUND_DEDUCTION), refund owed to the customer. ' +
      'VENDOR_FAVOR: package DELIVERED, frozen earnings released to the withdrawable balance (DISPUTE_HOLD_RELEASE).',
  })
  @IsIn(ARBITRATION_DECISIONS)
  decision!: ArbitrationDecision;

  @ApiProperty({ minLength: 10, maxLength: 2000, example: 'Photos show transit damage; the carrier confirmed the dented box.' })
  @Transform(trim)
  @IsString()
  @Length(10, 2000)
  resolutionNotes!: string;

  @ApiPropertyOptional({ description: 'BUYER_FAVOR only: the goods came back to the store (restocks shipped/delivered packages).' })
  @IsOptional()
  @IsBoolean()
  itemReturned?: boolean;
}

export class CustomerDisputeQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: DisputeStatus })
  @IsOptional()
  @IsEnum(DisputeStatus)
  status?: DisputeStatus;
}

export class VendorDisputeQueryDto extends CustomerDisputeQueryDto {}

export class AdminDisputeQueryDto extends CustomerDisputeQueryDto {
  @ApiPropertyOptional({ enum: DisputeReason })
  @IsOptional()
  @IsEnum(DisputeReason)
  reason?: DisputeReason;

  @ApiPropertyOptional({ format: 'uuid', description: 'Store the disputes are against.' })
  @IsOptional()
  @IsUUID('4')
  vendorId?: string;

  @ApiPropertyOptional({ format: 'uuid', description: 'Customer who raised the disputes.' })
  @IsOptional()
  @IsUUID('4')
  customerId?: string;

  @ApiPropertyOptional({ type: Date, description: 'Opened at or after (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @ApiPropertyOptional({ type: Date, description: 'Opened before (ISO 8601).' })
  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}

// ─── output ─────────────────────────────────────────────────────────────────

export class DisputeEvidenceDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['CUSTOMER', 'VENDOR', 'STAFF'] }) uploadedBy!: 'CUSTOMER' | 'VENDOR' | 'STAFF';
  @ApiProperty({ example: '/api/v1/media/documents/7a4c3f7e-8d1b-4a45-9a61-2f1f5a0c2b10/download' }) fileUrl!: string;
  @ApiProperty({ nullable: true, type: String, example: 'image/jpeg' }) fileType!: string | null;
  @ApiProperty({ nullable: true, type: String }) caption!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DisputeEventDto {
  @ApiProperty({ enum: DisputeEventType }) type!: DisputeEventType;
  @ApiProperty({ enum: ['CUSTOMER', 'VENDOR', 'STAFF', 'SYSTEM'] }) actorRole!: string;
  @ApiProperty({ enum: DisputeStatus, nullable: true }) fromStatus!: DisputeStatus | null;
  @ApiProperty({ enum: DisputeStatus, nullable: true }) toStatus!: DisputeStatus | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DisputePackageDto {
  @ApiProperty({ format: 'uuid' }) subOrderId!: string;
  @ApiProperty({ example: 'SHP-100000001-1' }) subOrderNumber!: string;
  @ApiProperty({ example: 'SHP-100000001' }) orderNumber!: string;
  @ApiProperty({ enum: SubOrderStatus }) status!: SubOrderStatus;
  @ApiProperty({ format: 'uuid' }) vendorId!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty(MONEY) itemsSubtotal!: string;
  @ApiProperty(MONEY) shippingFee!: string;
}

export class DisputeVendorResponseDto {
  @ApiProperty({ enum: DisputeVendorAction }) action!: DisputeVendorAction;
  @ApiProperty() defenseNotes!: string;
  @ApiProperty() respondedAt!: Date;
}

export class DisputeResolutionDto {
  @ApiProperty({ enum: [DisputeStatus.RESOLVED_BUYER_FAVOR, DisputeStatus.RESOLVED_VENDOR_FAVOR] }) outcome!: DisputeStatus;
  @ApiProperty({ nullable: true, type: String }) notes!: string | null;
  @ApiProperty() resolvedAt!: Date;
  @ApiProperty({ enum: ['VENDOR', 'STAFF'], description: 'VENDOR when the store accepted the return, STAFF for an arbitration.' }) decidedBy!: 'VENDOR' | 'STAFF';
  @ApiProperty({ ...MONEY, nullable: true, description: 'Buyer favour: amount owed back to the customer (items + shipping).' }) refundAmount!: string | null;
  @ApiProperty({ nullable: true, type: Boolean }) itemReturned!: boolean | null;
  @ApiProperty() restocked!: boolean;
}

export class DisputeDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DisputeStatus }) status!: DisputeStatus;
  @ApiProperty({ enum: DisputeReason }) reason!: DisputeReason;
  @ApiProperty() description!: string;
  @ApiProperty({ type: DisputePackageDto }) package!: DisputePackageDto;
  @ApiProperty({ enum: SubOrderStatus, description: 'Package status when the dispute was opened.' }) subOrderStatusAtOpen!: SubOrderStatus;
  @ApiProperty({ type: DisputeVendorResponseDto, nullable: true }) vendorResponse!: DisputeVendorResponseDto | null;
  @ApiProperty({ type: DisputeResolutionDto, nullable: true }) resolution!: DisputeResolutionDto | null;
  @ApiProperty({ nullable: true, type: Date }) cancelledAt!: Date | null;
  @ApiProperty({ type: [DisputeEvidenceDto] }) evidence!: DisputeEvidenceDto[];
  @ApiProperty({ type: [DisputeEventDto], description: 'Timeline, oldest first.' }) timeline!: DisputeEventDto[];
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class DisputeHoldDto {
  @ApiProperty({ enum: [WalletBalanceBucket.PENDING, WalletBalanceBucket.WITHDRAWABLE], nullable: true, description: 'Where the frozen earnings came from.' })
  source!: WalletBalanceBucket | null;
  @ApiProperty({ ...MONEY, description: 'Earnings frozen in DISPUTE_HOLD by this dispute.' }) amount!: string;
  @ApiProperty({ ...MONEY, description: 'Delivered packages: earnings the vendor had already withdrawn when the dispute was opened.' }) shortfall!: string;
  @ApiProperty({ ...MONEY, description: 'Buyer favour: earnings that could not be recovered at all (vendor debt).' }) unrecovered!: string;
}

export class VendorDisputeDto extends DisputeDto {
  @ApiProperty({ description: 'Customer name as shown to the store; the mobile is masked.' }) customerName!: string;
  @ApiProperty({ example: '+98912***4567' }) customerMobileMasked!: string;
  @ApiProperty({ type: DisputeHoldDto }) hold!: DisputeHoldDto;
}

export class DisputePartyDto {
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: '+989121234567' }) mobile!: string;
}

export class DossierOrderDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) paymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty(MONEY) finalPayableAmount!: string;
  @ApiProperty() createdAt!: Date;
}

export class DossierItemDto {
  @ApiProperty() productTitle!: string;
  @ApiProperty() sku!: string;
  @ApiProperty() quantity!: number;
  @ApiProperty(MONEY) unitPrice!: string;
  @ApiProperty(MONEY) totalLineAmount!: string;
}

export class DossierStatusChangeDto {
  @ApiProperty({ enum: SubOrderStatus, nullable: true }) fromStatus!: SubOrderStatus | null;
  @ApiProperty({ enum: SubOrderStatus }) toStatus!: SubOrderStatus;
  @ApiProperty() actorRole!: string;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class DossierPaymentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() gatewayName!: string;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty() status!: string;
  @ApiProperty(MONEY) cashAmount!: string;
  @ApiProperty(MONEY) creditAmount!: string;
  @ApiProperty({ nullable: true, type: String }) bankRrn!: string | null;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
}

export class DossierWalletDto {
  @ApiProperty(MONEY) pendingBalance!: string;
  @ApiProperty(MONEY) withdrawableBalance!: string;
  @ApiProperty(MONEY) settlementHoldBalance!: string;
  @ApiProperty(MONEY) disputeHoldBalance!: string;
  @ApiProperty(MONEY) totalEarnedBalance!: string;
  @ApiProperty(MONEY) totalWithdrawnAmount!: string;
}

export class AdminDisputeDossierDto extends DisputeDto {
  @ApiProperty({ type: DisputePartyDto }) customer!: DisputePartyDto;
  @ApiProperty({ type: DisputeHoldDto }) hold!: DisputeHoldDto;
  @ApiProperty({ type: DossierOrderDto }) order!: DossierOrderDto;
  @ApiProperty({ type: [DossierItemDto] }) items!: DossierItemDto[];
  @ApiProperty({ type: [DossierStatusChangeDto], description: 'Package status history, oldest first.' }) packageHistory!: DossierStatusChangeDto[];
  @ApiProperty({ type: [DossierPaymentDto] }) payments!: DossierPaymentDto[];
  @ApiProperty({ type: DossierWalletDto, description: "The store's wallet right now." }) vendorWallet!: DossierWalletDto;
  @ApiProperty(MONEY) vendorEarningsAmount!: string;
}

export class DisputePageDto {
  @ApiProperty({ type: [DisputeDto] }) items!: DisputeDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class VendorDisputePageDto {
  @ApiProperty({ type: [VendorDisputeDto] }) items!: VendorDisputeDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class AdminDisputeSummaryDto extends DisputeDto {
  @ApiProperty({ type: DisputePartyDto }) customer!: DisputePartyDto;
  @ApiProperty({ type: DisputeHoldDto }) hold!: DisputeHoldDto;
}

export class AdminDisputePageDto {
  @ApiProperty({ type: [AdminDisputeSummaryDto] }) items!: AdminDisputeSummaryDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

/** Result of every state-changing dispute call. */
export class DisputeActionResultDto {
  @ApiProperty({ type: DisputeDto }) dispute!: DisputeDto;
  @ApiProperty({
    enum: ['FROZEN', 'REFUNDED', 'RELEASED_TO_WITHDRAWABLE', 'RETURNED_TO_ESCROW', 'NONE'],
    description:
      'Wallet consequence: FROZEN (opened: earnings moved to DISPUTE_HOLD), REFUNDED (buyer favour: REFUND_DEDUCTION), ' +
      'RELEASED_TO_WITHDRAWABLE (vendor favour, or a cancelled dispute on a delivered package), RETURNED_TO_ESCROW (cancelled before delivery), NONE.',
  })
  walletAction!: 'FROZEN' | 'REFUNDED' | 'RELEASED_TO_WITHDRAWABLE' | 'RETURNED_TO_ESCROW' | 'NONE';
  @ApiProperty({ enum: SubOrderStatus }) subOrderStatus!: SubOrderStatus;
  @ApiProperty({ enum: ['RESTOCKED', 'NONE'] }) stockAction!: 'RESTOCKED' | 'NONE';
}
```

### `apps/backend/src/modules/disputes/vendor-disputes.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
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
import { DisputeQueriesService } from './dispute-queries.service';
import { DisputesService } from './disputes.service';
import { DisputeActionResultDto, VendorDisputeDto, VendorDisputePageDto, VendorDisputeQueryDto, VendorRespondDisputeDto } from './dto/dispute.dto';

@ApiTags('vendor-disputes')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Vendors with a store only' })
@Controller('vendor/disputes')
export class VendorDisputesController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly queries: DisputeQueriesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Disputes against my store', description: 'Newest first; includes the frozen amount of each dispute. Customer mobiles are masked.' })
  @ApiOkResponse({ type: VendorDisputePageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or paging' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: VendorDisputeQueryDto): Promise<VendorDisputePageDto> {
    return this.queries.vendorList(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One dispute against my store', description: 'The complaint with the buyer’s evidence (downloadable by the store), timeline and hold.' })
  @ApiOkResponse({ type: VendorDisputeDto })
  @ApiNotFoundResponse({ description: 'Dispute not found (or against another store)' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<VendorDisputeDto> {
    return this.queries.vendorDetail(user.id, id);
  }

  @Post(':id/respond')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Answer a dispute',
    description:
      'Once, while the dispute is OPEN. ACCEPT_RETURN resolves it for the customer at once: package REFUNDED, the frozen earnings ' +
      'are deducted (REFUND_DEDUCTION), stock is restored for goods that never shipped or that came back (`itemReturned`), and the ' +
      'customer receives a refund notice. REJECT_WITH_DEFENSE records the defence and evidence and moves the dispute to UNDER_ARBITRATION.',
  })
  @ApiOkResponse({ type: DisputeActionResultDto })
  @ApiBadRequestResponse({ description: 'Validation error, or EVIDENCE_NOT_ACCEPTED' })
  @ApiNotFoundResponse({ description: 'Dispute not found (or against another store)' })
  @ApiConflictResponse({ description: 'DISPUTE_NOT_AWAITING_VENDOR, CREDIT_ORDER_REFUND_UNSUPPORTED or ESCROW_NOT_FROZEN' })
  respond(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: VendorRespondDisputeDto,
    @ClientContext() context: RequestContext,
  ): Promise<DisputeActionResultDto> {
    return this.disputes.respond(user, id, dto, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/financial/dto/financial.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';
import { MONEY } from '../../wallet/dto/wallet.dto';

export class FinancialOverviewQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01T00:00:00+03:30', description: 'Sales window start (order paidAt ≥ from). Balances are always current.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-10-01T00:00:00+03:30', description: 'Sales window end (order paidAt < to).' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class SalesFiguresDto {
  @ApiProperty({ description: 'Paid orders in the window.' }) paidOrders!: number;
  @ApiProperty({ description: 'Packages of paid orders that are not cancelled or refunded.' }) activePackages!: number;
  @ApiProperty({ ...MONEY, description: 'GMV: items subtotal of active packages of paid orders (excludes shipping, cancelled and refunded packages).' })
  gmv!: string;
  @ApiProperty({ ...MONEY, description: 'Shipping fees of active packages of paid orders.' }) shippingFees!: string;
  @ApiProperty({ ...MONEY, description: 'Cash captured by the gateway for orders (SUCCESSFUL ORDER_CHECKOUT payments; card part of HYBRID), including captures awaiting manual refund.' })
  collectedByGateway!: string;
  @ApiProperty({ ...MONEY, description: 'Order amounts financed by bank credit (credit part of SUCCESSFUL BANK_CREDIT / HYBRID payments).' })
  fundedByCredit!: string;
  @ApiProperty({ ...MONEY, description: 'Instalment repayments captured by the gateway (SUCCESSFUL INSTALLMENT_REPAYMENT payments).' })
  installmentsCollected!: string;
}

export class CommissionFiguresDto {
  @ApiProperty({ ...MONEY, description: 'Commission of DELIVERED packages (escrow released).' }) earned!: string;
  @ApiProperty({ ...MONEY, description: 'Commission of paid packages not delivered yet (PENDING_APPROVAL / PROCESSING / SHIPPED).' }) pending!: string;
  @ApiProperty(MONEY) total!: string;
}

export class WalletFiguresDto {
  @ApiProperty({ ...MONEY, description: 'Escrow held: sum of all vendors’ pendingBalance.' }) escrowHeld!: string;
  @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ withdrawableBalance.' }) withdrawable!: string;
  @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ settlementHoldBalance (open requests).' }) settlementHold!: string;
  @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ disputeHoldBalance: earnings frozen by open disputes (Phase 9).' }) disputeHold!: string;
  @ApiProperty({ ...MONEY, description: 'Lifetime PAYA payouts.' }) totalWithdrawn!: string;
  @ApiProperty({ description: 'True when, for every wallet and bucket, the ledger sum equals the balance column.' }) ledgerConsistent!: boolean;
  @ApiProperty({ description: 'Wallets whose balances do not match their ledger (should always be 0).' }) inconsistentWallets!: number;
}

export class SettlementFiguresDto {
  @ApiProperty({ description: 'Requests awaiting finance (REQUESTED / PROCESSING).' }) pendingCount!: number;
  @ApiProperty(MONEY) pendingAmount!: string;
  @ApiProperty({ description: 'Requests paid by PAYA in the window (processedAt).' }) paidCount!: number;
  @ApiProperty(MONEY) paidAmount!: string;
}

export class DisputeFiguresDto {
  @ApiProperty({ description: 'Disputes waiting for the vendor (OPEN / VENDOR_RESPONDED).' }) open!: number;
  @ApiProperty({ description: 'Disputes waiting for a staff decision (UNDER_ARBITRATION).' }) underArbitration!: number;
  @ApiProperty({ description: 'Disputes resolved for the customer in the window (resolvedAt).' }) resolvedForBuyer!: number;
  @ApiProperty({ ...MONEY, description: 'Amount owed back to customers by those resolutions (package items + shipping); refunded manually by finance.' })
  refundsOwedToCustomers!: string;
  @ApiProperty({ ...MONEY, description: 'Vendor earnings those resolutions could not recover from the wallet (already withdrawn).' })
  unrecoveredVendorEarnings!: string;
}

export class FinancialOverviewDto {
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ nullable: true, type: Date }) from!: Date | null;
  @ApiProperty({ nullable: true, type: Date }) to!: Date | null;
  @ApiProperty() generatedAt!: Date;
  @ApiProperty({ type: SalesFiguresDto }) sales!: SalesFiguresDto;
  @ApiProperty({ type: CommissionFiguresDto }) commission!: CommissionFiguresDto;
  @ApiProperty({ type: WalletFiguresDto }) wallets!: WalletFiguresDto;
  @ApiProperty({ type: SettlementFiguresDto }) settlements!: SettlementFiguresDto;
  @ApiProperty({ description: 'Captured payments whose order was already paid/closed; finance must refund them manually.' })
  paymentsRequiringManualRefund!: number;
  @ApiProperty({ type: DisputeFiguresDto }) disputes!: DisputeFiguresDto;
}
```

### `apps/backend/src/modules/financial/financial.service.ts`

```ts
import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { FinancialOverviewDto, FinancialOverviewQueryDto } from './dto/financial.dto';

type Money = Prisma.Decimal | null;
const money = (value: Money): string => new Prisma.Decimal(value ?? 0).toFixed(2);

/**
 * Platform finance figures, computed live from the database (no cached
 * aggregates that could drift). Definitions are documented on the DTO fields
 * and in docs/phase-7-deliverable.md.
 */
@Injectable()
export class FinancialService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(query: FinancialOverviewQueryDto): Promise<FinancialOverviewDto> {
    const from = query.from ? new Date(query.from) : null;
    const to = query.to ? new Date(query.to) : null;
    if (from && to && from >= to) {
      throw new BadRequestException('from must be earlier than to');
    }
    const paidWindow = Prisma.sql`${from ? Prisma.sql`AND po.paid_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND po.paid_at < ${to}` : Prisma.empty}`;
    const processedWindow = Prisma.sql`${from ? Prisma.sql`AND processed_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND processed_at < ${to}` : Prisma.empty}`;
    const resolvedWindow = Prisma.sql`${from ? Prisma.sql`AND resolved_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND resolved_at < ${to}` : Prisma.empty}`;
    const paymentWindow = Prisma.sql`${from ? Prisma.sql`AND paid_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND paid_at < ${to}` : Prisma.empty}`;

    const [sales, collected, wallets, reconciliation, settlements, manualRefunds, disputes] = await this.prisma.$transaction([
      this.prisma.$queryRaw<Array<{ paid_orders: bigint; active_packages: bigint; gmv: Money; shipping: Money; commission_earned: Money; commission_pending: Money }>>(Prisma.sql`
        SELECT COUNT(DISTINCT po.id) AS paid_orders,
               COUNT(so.id) FILTER (WHERE so.status NOT IN ('CANCELLED', 'REFUNDED')) AS active_packages,
               SUM(so.items_subtotal) FILTER (WHERE so.status NOT IN ('CANCELLED', 'REFUNDED')) AS gmv,
               SUM(so.shipping_fee) FILTER (WHERE so.status NOT IN ('CANCELLED', 'REFUNDED')) AS shipping,
               SUM(so.platform_commission_amount) FILTER (WHERE so.status = 'DELIVERED') AS commission_earned,
               SUM(so.platform_commission_amount) FILTER (WHERE so.status IN ('PENDING_APPROVAL', 'PROCESSING', 'SHIPPED')) AS commission_pending
        FROM parent_orders po
        JOIN sub_orders so ON so.parent_order_id = po.id
        WHERE po.payment_status = 'PAID' ${paidWindow}`),
      this.prisma.$queryRaw<Array<{ collected: Money; funded_by_credit: Money; installments_collected: Money }>>(Prisma.sql`
        SELECT SUM(cash_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS collected,
               SUM(credit_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS funded_by_credit,
               SUM(cash_amount) FILTER (WHERE purpose = 'INSTALLMENT_REPAYMENT') AS installments_collected
        FROM payments WHERE status = 'SUCCESSFUL' ${paymentWindow}`),
      this.prisma.$queryRaw<Array<{ pending: Money; withdrawable: Money; hold: Money; dispute_hold: Money; withdrawn: Money }>>(Prisma.sql`
        SELECT SUM(pending_balance) AS pending, SUM(withdrawable_balance) AS withdrawable,
               SUM(settlement_hold_balance) AS hold, SUM(dispute_hold_balance) AS dispute_hold, SUM(total_withdrawn_amount) AS withdrawn
        FROM vendor_wallets`),
      this.prisma.$queryRaw<Array<{ inconsistent: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS inconsistent FROM (
          SELECT w.id
          FROM vendor_wallets w
          LEFT JOIN wallet_transactions t ON t.wallet_id = w.id
          GROUP BY w.id, w.pending_balance, w.withdrawable_balance, w.settlement_hold_balance, w.dispute_hold_balance
          HAVING COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'PENDING'), 0) <> w.pending_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'WITHDRAWABLE'), 0) <> w.withdrawable_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'SETTLEMENT_HOLD'), 0) <> w.settlement_hold_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'DISPUTE_HOLD'), 0) <> w.dispute_hold_balance
        ) AS drift`),
      this.prisma.$queryRaw<Array<{ pending_count: bigint; pending_amount: Money; paid_count: bigint; paid_amount: Money }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS pending_count,
               SUM(amount) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS pending_amount,
               COUNT(*) FILTER (WHERE status = 'PAID_PAYA' ${processedWindow}) AS paid_count,
               SUM(amount) FILTER (WHERE status = 'PAID_PAYA' ${processedWindow}) AS paid_amount
        FROM settlement_requests`),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS count FROM payments WHERE status = 'SUCCESSFUL' AND metadata ->> 'requiresManualRefund' = 'true'`),
      this.prisma.$queryRaw<Array<{ open_count: bigint; arbitration_count: bigint; buyer_favor_count: bigint; refunds_owed: Money; unrecovered: Money }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('OPEN', 'VENDOR_RESPONDED')) AS open_count,
               COUNT(*) FILTER (WHERE status = 'UNDER_ARBITRATION') AS arbitration_count,
               COUNT(*) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS buyer_favor_count,
               SUM(refund_amount) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS refunds_owed,
               SUM(refund_unrecovered_amount) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS unrecovered
        FROM disputes`),
    ]);
    const dq = disputes[0];

    const s = sales[0];
    const w = wallets[0];
    const st = settlements[0];
    const earned = new Prisma.Decimal(s?.commission_earned ?? 0);
    const pending = new Prisma.Decimal(s?.commission_pending ?? 0);
    const inconsistentWallets = Number(reconciliation[0]?.inconsistent ?? 0);
    return {
      currency: 'IRR',
      from,
      to,
      generatedAt: new Date(),
      sales: {
        paidOrders: Number(s?.paid_orders ?? 0),
        activePackages: Number(s?.active_packages ?? 0),
        gmv: money(s?.gmv ?? null),
        shippingFees: money(s?.shipping ?? null),
        collectedByGateway: money(collected[0]?.collected ?? null),
        fundedByCredit: money(collected[0]?.funded_by_credit ?? null),
        installmentsCollected: money(collected[0]?.installments_collected ?? null),
      },
      commission: { earned: earned.toFixed(2), pending: pending.toFixed(2), total: earned.plus(pending).toFixed(2) },
      wallets: {
        escrowHeld: money(w?.pending ?? null),
        withdrawable: money(w?.withdrawable ?? null),
        settlementHold: money(w?.hold ?? null),
        disputeHold: money(w?.dispute_hold ?? null),
        totalWithdrawn: money(w?.withdrawn ?? null),
        ledgerConsistent: inconsistentWallets === 0,
        inconsistentWallets,
      },
      settlements: {
        pendingCount: Number(st?.pending_count ?? 0),
        pendingAmount: money(st?.pending_amount ?? null),
        paidCount: Number(st?.paid_count ?? 0),
        paidAmount: money(st?.paid_amount ?? null),
      },
      paymentsRequiringManualRefund: Number(manualRefunds[0]?.count ?? 0),
      disputes: {
        open: Number(dq?.open_count ?? 0),
        underArbitration: Number(dq?.arbitration_count ?? 0),
        resolvedForBuyer: Number(dq?.buyer_favor_count ?? 0),
        refundsOwedToCustomers: money(dq?.refunds_owed ?? null),
        unrecoveredVendorEarnings: money(dq?.unrecovered ?? null),
      },
    };
  }
}
```

### `apps/backend/src/modules/media/media.controller.ts`

```ts
import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  PayloadTooLargeException,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { MediaKind, UserRole } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Auditable, SkipAudit } from '../audit/audit.decorator';
import { setAuditSnapshot } from '../audit/audit-context';
import { AuditAction } from '@prisma/client';
import { MediaService, type UploadedFile as UploadedFilePayload } from './media.service';
import {
  DocumentUploadResponseDto,
  ImageUploadResponseDto,
  MediaAssetDto,
  StorageProviderInfoDto,
  toMediaAssetDto,
} from './dto/media-response.dto';
import type { MultipartRequest } from './multipart-request';

/** Purposes a client may declare, and whether the resulting asset is public. */
const IMAGE_PURPOSES = new Map<string, boolean>([
  ['avatar', true],
  ['store_logo', true],
  ['store_banner', true],
  ['product_image', true],
  ['kyc_document', false],
]);

const DOCUMENT_PURPOSES = new Set([
  'kyc_national_id',
  'kyc_business_license',
  'kyc_bank_proof',
  /** Proof attached to a dispute (Phase 9): private; readable by the dispute's buyer, vendor and staff. */
  'dispute_evidence',
  'other',
]);

/**
 * Media endpoints.
 *
 * Read routes are `@Public()` **only** for objects the platform has explicitly
 * marked public (store logos, product images): the row in `media_assets` is the
 * authority, not the URL, so guessing a path never reveals a KYC scan. Private
 * objects are served through an authenticated endpoint that checks ownership or
 * a staff role.
 */
@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload/image')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'PNG, JPEG، GIF یا WEBP — حداکثر ۵ مگابایت' },
        purpose: {
          type: 'string',
          enum: [...IMAGE_PURPOSES.keys()],
          default: 'product_image',
          description: 'کاربرد فایل؛ تعیین می‌کند تصویر عمومی باشد یا خصوصی',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'آپلود تصویر با پردازش خودکار',
    description:
      'نوع واقعی فایل با امضای بایتی (magic bytes) تشخیص داده می‌شود، سپس Sharp آن را می‌چرخاند (اصلاح جهت EXIF)، ' +
      'به WebP تبدیل و به حداکثر ۱۶۰۰ پیکسل محدود می‌کند و یک بندانگشتی ۳۰۰×۳۰۰ می‌سازد. ' +
      'فایل‌های غیرتصویری یا خراب و فایل‌های بزرگ‌تر از سقف، با ۴۰۰ رد می‌شوند.',
  })
  @ApiOkResponse({ type: ImageUploadResponseDto, description: 'تصویر پردازش و ذخیره شد' })
  @ApiBadRequestResponse({ description: 'فایل خالی، نوع پشتیبانی‌نشده، تصویر خراب یا بیش از حد بزرگ' })
  @ApiPayloadTooLargeResponse({ description: 'حجم بدنه درخواست از سقف انتقال بیشتر است' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async uploadImage(
    @Req() request: MultipartRequest,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ImageUploadResponseDto> {
    const { file, fields } = await readMultipartUpload(request);
    const purpose = fields['purpose'] ?? 'product_image';
    const isPublic = IMAGE_PURPOSES.get(purpose);

    if (isPublic === undefined) {
      throw new BadRequestException(
        `Unsupported purpose "${purpose}". Allowed: ${[...IMAGE_PURPOSES.keys()].join(', ')}`,
      );
    }

    const result = await this.media.uploadImage(file, { ownerUserId: user.id, purpose, isPublic });

    setAuditSnapshot(request, {
      actorId: user.id,
      entityId: result.id,
      newValue: {
        purpose,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        originalSizeBytes: result.originalSizeBytes,
        isPublic,
      },
    });
    return result;
  }

  @Post('upload/document')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'PDF، PNG یا JPEG — حداکثر ۱۰ مگابایت' },
        purpose: {
          type: 'string',
          enum: [...DOCUMENT_PURPOSES],
          default: 'kyc_national_id',
          description: 'نوع مدرک برای پیگیری در فرایند احراز هویت',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'آپلود مدرک (KYC)',
    description:
      'مدارک PDF/PNG/JPEG را بدون تغییر ذخیره می‌کند (بازکدگذاری، ارزش اثباتی مدرک را از بین می‌برد). ' +
      'همهٔ مدارک خصوصی هستند و فقط مالک یا کارکنان مجاز می‌توانند آن‌ها را دانلود کنند.',
  })
  @ApiOkResponse({ type: DocumentUploadResponseDto })
  @ApiBadRequestResponse({ description: 'نوع نامعتبر، فایل خراب یا بزرگ‌تر از سقف' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async uploadDocument(
    @Req() request: MultipartRequest,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DocumentUploadResponseDto> {
    const { file, fields } = await readMultipartUpload(request);
    const purpose = fields['purpose'] ?? 'kyc_national_id';

    if (!DOCUMENT_PURPOSES.has(purpose)) {
      throw new BadRequestException(
        `Unsupported purpose "${purpose}". Allowed: ${[...DOCUMENT_PURPOSES].join(', ')}`,
      );
    }

    const result = await this.media.uploadDocument(file, { ownerUserId: user.id, purpose });

    setAuditSnapshot(request, {
      actorId: user.id,
      entityId: result.id,
      newValue: { purpose, mimeType: result.mimeType, sizeBytes: result.sizeBytes, isPublic: false },
    });
    return result;
  }

  @Get('storage-provider')
  @Public()
  @SkipAudit()
  @ApiOperation({
    summary: 'اطلاع از Provider فعال ذخیره‌سازی',
    description: 'مشخص می‌کند فایل‌ها روی دیسک همین سرور ذخیره می‌شوند یا در Object Storage، و سقف‌های حجم را اعلام می‌کند.',
  })
  @ApiOkResponse({ type: StorageProviderInfoDto })
  storageProvider(): StorageProviderInfoDto {
    const info = this.media.storageProviderInfo();
    const limits = this.media.limits;
    return {
      provider: info.provider,
      isLocal: info.isLocal,
      maxImageBytes: limits.imageBytes,
      maxDocumentBytes: limits.documentBytes,
    };
  }

  @Get('assets/:id')
  @ApiBearerAuth('access-token')
  @SkipAudit()
  @ApiOperation({
    summary: 'اطلاعات یک فایل ذخیره‌شده',
    description: 'فایل عمومی برای همه؛ فایل خصوصی فقط برای مالک یا کارکنان.',
  })
  @ApiOkResponse({ type: MediaAssetDto, description: 'فرادادهٔ فایل' })
  @ApiForbiddenResponse({ description: 'این فایل خصوصی است و به شما تعلق ندارد' })
  @ApiNotFoundResponse({ description: 'فایل یافت نشد' })
  async asset(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MediaAssetDto> {
    const asset = await this.media.findAsset(id);
    if (asset === null) {
      throw new NotFoundException('Media asset not found');
    }
    if (!asset.isPublic && !(await this.media.canAccessPrivateAsset({ asset, user }))) {
      throw new ForbiddenException('This asset is private');
    }
    return toMediaAssetDto(asset);
  }

  /**
   * Anonymous file route for public objects (store logos, product images).
   *
   * It is `@Public()` because the files are meant to be embedded in a storefront,
   * but it still consults the database: only rows with `is_public = true` are
   * served, so a leaked or guessed object key yields `404` rather than content.
   */
  @Get('files/*')
  @Public()
  @SkipAudit()
  @ApiOperation({
    summary: 'دریافت فایل عمومی',
    description:
      'فقط فایل‌هایی که در پایگاه داده عمومی علامت خورده‌اند سرو می‌شوند. مسیر با قواعد سخت‌گیرانه اعتبارسنجی می‌شود ' +
      'و هر تلاش برای خروج از پوشهٔ آپلود با ۴۰۰/۴۰۴ پاسخ می‌گیرد.',
  })
  @ApiOkResponse({ description: 'محتوای فایل' })
  @ApiNotFoundResponse({ description: 'فایل عمومی با این مسیر وجود ندارد' })
  async publicFile(@Req() request: { params: Record<string, string> }, @Res() reply: FastifyReply): Promise<void> {
    // Fastify's unnamed wildcard (`files/*`) arrives as the `*` parameter. The
    // value is never used to build a filesystem path directly: it is looked up in
    // `media_assets`, and only a row marked public resolves to a file.
    const path = request.params['*'];
    if (path === undefined || path.length === 0) {
      throw new BadRequestException('A file path is required');
    }

    const found = await this.media.findPublicAssetByPath(path);
    if (found === null) {
      throw new NotFoundException('File not found');
    }

    await this.media.streamAsset(found.asset, reply, found.storagePath);
  }

  @Get('documents/:id/download')
  @Roles(
    UserRole.CUSTOMER,
    UserRole.VENDOR,
    UserRole.SUPPORT,
    UserRole.FINANCIAL_OFFICER,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @Auditable({ action: AuditAction.STATUS_CHANGE, entityName: 'MediaAsset', entityIdParam: 'id' })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'دانلود مدرک خصوصی',
    description:
      'مدارک KYC هرگز آدرس عمومی ندارند؛ این مسیر پس از بررسی مالکیت یا نقش کارکنان، فایل را با اعتبارنامه‌های سرور می‌خواند و جریان می‌دهد. ' +
      'هر دانلود در audit_logs ثبت می‌شود.',
  })
  @ApiOkResponse({ description: 'محتوای مدرک' })
  @ApiForbiddenResponse({ description: 'این مدرک به شما تعلق ندارد' })
  @ApiNotFoundResponse({ description: 'مدرک یافت نشد' })
  async downloadDocument(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const asset = await this.media.findAsset(id);
    if (asset === null) {
      throw new NotFoundException('Document not found');
    }
    if (asset.kind !== MediaKind.DOCUMENT) {
      throw new BadRequestException('This asset is not a document');
    }
    if (!(await this.media.canAccessPrivateAsset({ asset, user }))) {
      throw new ForbiddenException('This document belongs to another account');
    }

    reply.header('content-disposition', `attachment; filename="${asset.originalName ?? 'document'}"`);
    await this.media.streamAsset(asset, reply);
  }
}

/**
 * Reads the single file out of a multipart request.
 *
 * Validation lives here rather than in a pipe because the decision needs the file
 * bytes and the declared field name together. A request without a file, or with
 * the file under the wrong field name, is a client error with a message that says
 * exactly what is missing.
 */
/**
 * Reads a multipart upload in a single pass over the request stream.
 *
 * Why one pass matters: a client may send the file before the fields (or the other
 * way round). Iterating `parts()` yields them in the order they arrived, so
 * `purpose` is always available once the file has been buffered — reading
 * `request.body` beforehand is a race that silently falls back to the default.
 *
 * Field names are checked against the two the contract defines (`file`, `purpose`)
 * and anything else is rejected, mirroring the strictness of the global validation
 * pipe: an unexpected field is a client bug the caller should see, not something to
 * ignore silently.
 */
const ALLOWED_FIELD_NAMES: ReadonlySet<string> = new Set(['file', 'purpose']);
const FILE_FIELD_NAME = 'file';

async function readMultipartUpload(
  request: MultipartRequest,
): Promise<{ file: UploadedFilePayload; fields: Record<string, string> }> {
  if (typeof request.parts !== 'function' || request.isMultipart?.() === false) {
    throw new BadRequestException(
      'Expected multipart/form-data: send the file in a field named "file" (curl -F "file=@…")',
    );
  }

  const fields: Record<string, string> = {};
  let file: UploadedFilePayload | null = null;

  try {
    for await (const part of request.parts()) {
      if (part.type === 'field') {
        if (!ALLOWED_FIELD_NAMES.has(part.fieldname)) {
          throw new BadRequestException(
            `Unexpected field "${part.fieldname}". Allowed fields: ${[...ALLOWED_FIELD_NAMES].join(', ')}`,
          );
        }
        if (part.fieldname === FILE_FIELD_NAME) {
          throw new BadRequestException(`Field "${FILE_FIELD_NAME}" must carry the file, not a value`);
        }
        // `value` is typed as unknown by the multipart types; only a string is a
        // legal form field, so anything else is a malformed request.
        if (typeof part.value !== 'string') {
          throw new BadRequestException(`Field "${part.fieldname}" must be a text value`);
        }
        fields[part.fieldname] = part.value;
        continue;
      }

      if (file !== null) {
        throw new BadRequestException('Only one file per request is supported');
      }
      if (part.fieldname !== FILE_FIELD_NAME) {
        throw new BadRequestException(
          `The file must be sent in a field named "${FILE_FIELD_NAME}", received "${part.fieldname}"`,
        );
      }

      const buffer = await part.toBuffer();
      if (part.file.truncated) {
        throw new PayloadTooLargeException(
          `The uploaded file exceeds the transport limit of ${Math.round(maxRequestFileBytes() / 1024 / 1024)} MB`,
        );
      }
      file = { originalName: part.filename, declaredMimeType: part.mimetype, buffer };
    }
  } catch (error) {
    throw toUploadError(error);
  }

  if (file === null) {
    throw new BadRequestException('No file was uploaded: expected a multipart part named "file"');
  }
  return { file, fields };
}

/**
 * Turns the multipart plugin's size-limit error into a 413 the client can act on.
 *
 * The distinction matters: `400` means "this file is wrong" (unsupported type, over
 * the per-kind budget, unreadable image), `413` means "this upload is too large to
 * receive at all". Anything else is rethrown untouched so real bugs stay visible.
 */
function toUploadError(error: unknown): unknown {
  if (error instanceof BadRequestException || error instanceof PayloadTooLargeException) {
    return error;
  }
  if (error instanceof Error && /too large|filesize|file size/i.test(error.message)) {
    return new PayloadTooLargeException(
      `The uploaded file exceeds the transport limit of ${Math.round(maxRequestFileBytes() / 1024 / 1024)} MB`,
    );
  }
  if (error instanceof Error && /multipart/i.test(error.message)) {
    return new BadRequestException('Expected a valid multipart/form-data request');
  }
  return error;
}

/** Transport ceiling, mirroring the value `registerMultipart` configures. */
function maxRequestFileBytes(): number {
  return Number(process.env['MEDIA_MAX_DOCUMENT_BYTES'] ?? 10_485_760);
}
```

### `apps/backend/src/modules/media/media.service.spec.ts`

```ts
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { MediaKind, UserRole } from '@prisma/client';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { PrismaService } from '../../infra/prisma/prisma.service';
import { LocalStorageProvider } from '../storage/providers/local-storage.provider';
import { StorageService } from '../storage/storage.service';
import {
  StorageError,
  type StorageProvider,
  type UploadParams,
} from '../storage/storage-provider.interface';
import { MediaService, type MediaAssetView, type UploadedFile } from './media.service';
import { detectFileType } from './file-signature';

/**
 * Unit coverage of the media pipeline.
 *
 * Sharp, the storage provider and the filesystem are **real**: the images are
 * genuine PNG/JPEG buffers produced by Sharp itself, they are written to a
 * temporary directory and read back from it, and the dimension assertions decode
 * the stored bytes rather than trusting the metadata the service returned. Only
 * `PrismaService` is a fake, because these tests are about the file pipeline, not
 * about PostgreSQL.
 */

const IMAGE_LIMIT = 5 * 1024 * 1024;
const DOCUMENT_LIMIT = 10 * 1024 * 1024;
const OWNER = 'user-owner-1';

interface AssetRow {
  id: string;
  ownerUserId: string | null;
  vendorId: string | null;
  kind: MediaKind;
  purpose: string;
  storageProvider: string;
  path: string;
  thumbnailPath: string | null;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  originalName: string | null;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  isPublic: boolean;
  createdAt: Date;
}

/** Minimal in-memory stand-in for the `media_assets` table. */
function createPrismaFake(): {
  service: PrismaService;
  rows: Map<string, AssetRow>;
  setOwner: (id: string, ownerUserId: string) => void;
  shareAsEvidence: (mediaAssetId: string, partyUserIds: string[]) => void;
} {
  const rows = new Map<string, AssetRow>();
  /** `dispute_evidence` rows: asset → user ids of the dispute's parties (customer, store owner). */
  const evidence: Array<{ mediaAssetId: string; parties: string[] }> = [];
  const owners = new Map<string, string>();
  let counter = 0;

  const withOwner = (row: AssetRow): AssetRow =>
    owners.has(row.id) ? { ...row, ownerUserId: owners.get(row.id) ?? null } : row;

  const service = {
    disputeEvidence: {
      count: (args: { where: { mediaAssetId: string; dispute: { OR: Array<{ raisedByUserId?: string; vendor?: { userId: string } }> } } }): Promise<number> => {
        const callers = args.where.dispute.OR.map((clause) => clause.raisedByUserId ?? clause.vendor?.userId);
        const hits = evidence.filter((row) => row.mediaAssetId === args.where.mediaAssetId && row.parties.some((party) => callers.includes(party)));
        return Promise.resolve(hits.length);
      },
    },
    mediaAsset: {
      create: (args: { data: Record<string, unknown> }): Promise<AssetRow> => {
        counter += 1;
        const row: AssetRow = {
          id: `asset-${counter}`,
          createdAt: new Date('2026-09-26T10:00:00.000Z'),
          ownerUserId: null,
          vendorId: null,
          kind: MediaKind.IMAGE,
          purpose: 'unknown',
          storageProvider: 'local',
          thumbnailPath: null,
          thumbnailUrl: null,
          originalName: null,
          width: null,
          height: null,
          isPublic: false,
          ...args.data,
        } as AssetRow;
        rows.set(row.id, row);
        return Promise.resolve(row);
      },
      findUnique: (args: { where: { id: string } }): Promise<AssetRow | null> => {
        const row = rows.get(args.where.id);
        return Promise.resolve(row === undefined ? null : withOwner(row));
      },
      findFirst: (args: {
        where: { path?: string; thumbnailPath?: string; isPublic?: boolean; OR?: Array<{ path?: string; thumbnailPath?: string }> };
      }): Promise<AssetRow | null> => {
        for (const row of rows.values()) {
          const matches = (candidate: AssetRow): boolean => {
            if (args.where.isPublic !== undefined && candidate.isPublic !== args.where.isPublic) {
              return false;
            }
            if (args.where.path !== undefined && candidate.path !== args.where.path) {
              return false;
            }
            if (args.where.thumbnailPath !== undefined && candidate.thumbnailPath !== args.where.thumbnailPath) {
              return false;
            }
            if (args.where.OR !== undefined) {
              return args.where.OR.some(
                (clause) =>
                  (clause.path !== undefined && candidate.path === clause.path) ||
                  (clause.thumbnailPath !== undefined && candidate.thumbnailPath === clause.thumbnailPath),
              );
            }
            return true;
          };
          if (matches(row)) {
            return Promise.resolve(withOwner(row));
          }
        }
        return Promise.resolve(null);
      },
      findMany: (): Promise<AssetRow[]> => Promise.resolve([...rows.values()].map(withOwner)),
    },
  } as unknown as PrismaService;

  return {
    service,
    rows,
    setOwner: (id: string, ownerUserId: string): void => {
      owners.set(id, ownerUserId);
    },
    shareAsEvidence: (mediaAssetId: string, partyUserIds: string[]): void => {
      evidence.push({ mediaAssetId, parties: partyUserIds });
    },
  };
}

/** Captures the headers a handler would have sent, without an HTTP server. */
interface ReplyStub {
  statusCode?: number;
  payload?: unknown;
  headers: Record<string, string>;
  header(name: string, value: string): ReplyStub;
  send(payload: Buffer): ReplyStub;
}

const createReplyStub = (): ReplyStub => {
  const stub: ReplyStub = {
    headers: {},
    header(name: string, value: string): ReplyStub {
      stub.headers[name.toLowerCase()] = value;
      return stub;
    },
    send(payload: Buffer): ReplyStub {
      stub.payload = payload;
      return stub;
    },
  };
  return stub;
};

const upload = (buffer: Buffer, originalName: string, declaredMimeType: string): UploadedFile => ({
  buffer,
  originalName,
  declaredMimeType,
});

describe('MediaService (real Sharp, real filesystem, fake Prisma)', () => {
  let uploadRoot: string;
  let prismaFake: ReturnType<typeof createPrismaFake>;
  let storage: StorageService;
  let service: MediaService;

  const png = (width: number, height: number): Promise<Buffer> =>
    sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 40, g: 120, b: 200 },
      },
    })
      .png()
      .toBuffer();

  const jpeg = (width: number, height: number): Promise<Buffer> =>
    sharp({
      create: { width, height, channels: 3, background: { r: 230, g: 20, b: 90 } },
    })
      .jpeg()
      .toBuffer();

  const configFake = {
    getOrThrow: (key: string): unknown => {
      if (key === 'MEDIA_MAX_IMAGE_BYTES') {
        return IMAGE_LIMIT;
      }
      if (key === 'MEDIA_MAX_DOCUMENT_BYTES') {
        return DOCUMENT_LIMIT;
      }
      throw new Error(`unexpected config key ${key}`);
    },
  } as unknown as ConfigService<EnvironmentVariables, true>;

  beforeAll(async () => {
    uploadRoot = await mkdtemp(join(tmpdir(), 'shopino-media-'));
  });

  afterAll(async () => {
    await rm(uploadRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    prismaFake = createPrismaFake();
    storage = new StorageService(
      new LocalStorageProvider({ root: uploadRoot, publicBaseUrl: '/api/v1/media/files' }),
    );
    service = new MediaService(prismaFake.service, storage, configFake);
  });

  // ─── Images ───────────────────────────────────────────────────────────────

  it('converts a 2400x1600 PNG to WebP capped at 1600px, plus a 300x300 thumbnail', async () => {
    const source = await png(2_400, 1_600);

    const result = await service.uploadImage(upload(source, 'store-logo.png', 'image/png'), {
      ownerUserId: OWNER,
      purpose: 'store_logo',
      isPublic: true,
    });

    expect(result.mimeType).toBe('image/webp');
    expect(result.width).toBe(1_600);
    expect(result.height).toBe(1_067);
    expect(result.originalSizeBytes).toBe(source.byteLength);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.sizeBytes).toBeLessThan(source.byteLength);
    expect(result.compressionRatio).toBeCloseTo(result.sizeBytes / source.byteLength, 4);

    // The bytes on disk are what the response describes — verified by decoding them.
    const optimisedBytes = await readFile(join(uploadRoot, result.url.replace('/api/v1/media/files/', '')));
    const thumbnailBytes = await readFile(
      join(uploadRoot, result.thumbnailUrl.replace('/api/v1/media/files/', '')),
    );

    expect(detectFileType(optimisedBytes)?.mimeType).toBe('image/webp');
    expect(detectFileType(thumbnailBytes)?.mimeType).toBe('image/webp');

    const optimisedMeta = await sharp(optimisedBytes).metadata();
    expect([optimisedMeta.width, optimisedMeta.height]).toEqual([1_600, 1_067]);

    const thumbnailMeta = await sharp(thumbnailBytes).metadata();
    expect([thumbnailMeta.width, thumbnailMeta.height]).toEqual([300, 300]);

    // Keys are siblings and both carry the purpose and the date prefix.
    expect(result.url).toMatch(/\/images\/store_logo\/\d{4}\/\d{2}\/[0-9a-f-]{36}\.webp$/);
    expect(result.thumbnailUrl).toBe(result.url.replace(/\.webp$/, '_thumb.webp'));
  });

  it('never enlarges a small image and stores it at its original size', async () => {
    const source = await jpeg(320, 240);

    const result = await service.uploadImage(upload(source, 'product.jpg', 'image/jpeg'), {
      ownerUserId: OWNER,
      purpose: 'product_image',
      isPublic: true,
    });

    expect([result.width, result.height]).toEqual([320, 240]);
  });

  it('applies the EXIF orientation so phone photos are not stored sideways', async () => {
    const rotated = await sharp({
      create: { width: 900, height: 600, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer();

    const result = await service.uploadImage(upload(rotated, 'photo.jpg', 'image/jpeg'), {
      ownerUserId: OWNER,
      purpose: 'product_image',
      isPublic: true,
    });

    // Orientation 6 means "rotate 90°": a 900x600 source is stored as 600x900.
    expect([result.width, result.height]).toEqual([600, 900]);
  });

  it('rejects a text file sent as image/png on its bytes, not on the declared type', async () => {
    const payload = Buffer.from('<html><body><script>alert(1)</script></body></html>', 'utf8');

    await expect(
      service.uploadImage(upload(payload, 'screenshot.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.uploadImage(upload(payload, 'screenshot.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('Unsupported image format. Allowed: PNG, JPEG, GIF, WEBP');
  });

  it('rejects a corrupt image that carries valid PNG magic bytes', async () => {
    const corrupted = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from('not an IHDR chunk at all, just text', 'latin1'),
    ]);

    await expect(
      service.uploadImage(upload(corrupted, 'broken.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('The file is not a readable image or is corrupted');
  });

  it('rejects an image above the 5 MB ceiling before it is processed', async () => {
    const oversized = Buffer.alloc(IMAGE_LIMIT + 1, 0x41);
    oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);

    await expect(
      service.uploadImage(upload(oversized, 'huge.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('The image exceeds the maximum size of 5 MB');
  });

  it('rejects an empty upload with a message that says so', async () => {
    await expect(
      service.uploadImage(upload(Buffer.alloc(0), 'empty.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('The uploaded file is empty');
  });

  it('rejects a PDF sent to the image endpoint, naming the type that actually arrived', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);

    await expect(
      service.uploadImage(upload(pdf, 'invoice.pdf', 'application/pdf'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('Expected an image (PNG, JPEG, GIF, WEBP) but received application/pdf');
  });

  it('refuses to store a document through the image endpoint', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x00)]);

    await expect(
      service.uploadImage(upload(zip, 'archive.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'product_image',
        isPublic: true,
      }),
    ).rejects.toThrow('Unsupported image format');

    expect(prismaFake.rows.size).toBe(0);
  });

  // ─── Documents ────────────────────────────────────────────────────────────

  it('stores a KYC document byte-for-byte and marks it private', async () => {
    const source = await jpeg(1_200, 900);

    const result = await service.uploadDocument(upload(source, 'national-card.jpg', 'image/jpeg'), {
      ownerUserId: OWNER,
      purpose: 'kyc_national_id',
    });

    expect(result.isPublic).toBe(false);
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.sizeBytes).toBe(source.byteLength);
    expect(result.originalName).toBe('national-card.jpg');
    expect(result.url).toBe(`/api/v1/media/documents/${result.id}/download`);

    const stored = await readFile(join(uploadRoot, (await service.findAsset(result.id))!.path));
    expect(stored.equals(source)).toBe(true);
    expect(join(uploadRoot, (await service.findAsset(result.id))!.path)).toContain('/documents/kyc_national_id/');

    const row = await service.findAsset(result.id);
    expect(row?.kind).toBe(MediaKind.DOCUMENT);
    expect(row?.isPublic).toBe(false);
    // Documents are stored as received and never decoded: a PDF or a KYC scan is
    // evidence, and handing untrusted bytes to an image decoder to learn their
    // dimensions would buy a cosmetic field at the price of an attack surface.
    expect([row?.width, row?.height]).toEqual([null, null]);
    expect(row?.path).toContain('documents/kyc_national_id/');
  });

  it('accepts a PDF as a document on its magic bytes', async () => {
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.7\n', 'latin1'),
      Buffer.alloc(512, 0x20),
      Buffer.from('%%EOF', 'latin1'),
    ]);

    const result = await service.uploadDocument(upload(pdf, 'bank-statement.pdf', 'application/pdf'), {
      ownerUserId: OWNER,
      purpose: 'kyc_bank_proof',
    });

    expect(result.mimeType).toBe('application/pdf');
    expect(result.sizeBytes).toBe(pdf.byteLength);
  });

  it('rejects a ZIP archive renamed to .pdf on the document endpoint too', async () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(128, 0x00)]);

    await expect(
      service.uploadDocument(upload(zip, 'licence.pdf', 'application/pdf'), {
        ownerUserId: OWNER,
        purpose: 'kyc_business_license',
      }),
    ).rejects.toThrow('Unsupported document format. Allowed: PDF, PNG, JPEG');
  });

  it('rejects a GIF as a document: nothing in the workflow produces one', async () => {
    const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 0x33)]);

    await expect(
      service.uploadDocument(upload(gif, 'card.gif', 'image/gif'), {
        ownerUserId: OWNER,
        purpose: 'kyc_national_id',
      }),
    ).rejects.toThrow('Expected a document (PDF, PNG, JPEG) but received image/gif');
  });

  it('rejects a document above the 10 MB ceiling', async () => {
    const oversized = Buffer.alloc(DOCUMENT_LIMIT + 1, 0x20);
    oversized.set(Buffer.from('%PDF-1.7', 'latin1'), 0);

    await expect(
      service.uploadDocument(upload(oversized, 'big.pdf', 'application/pdf'), {
        ownerUserId: OWNER,
        purpose: 'kyc_national_id',
      }),
    ).rejects.toThrow('The document exceeds the maximum size of 10 MB');
  });

  it('sanitizes the stored original name of a document', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);

    const result = await service.uploadDocument(
      upload(pdf, '../../etc/statement.html', 'application/pdf'),
      { ownerUserId: OWNER, purpose: 'kyc_bank_proof' },
    );

    expect(result.originalName).toBe('etc_statement.bin');
  });

  // ─── Lookup and access control ────────────────────────────────────────────

  it('resolves a public asset by its own key and by its thumbnail key', async () => {
    const source = await png(600, 600);
    const uploaded = await service.uploadImage(upload(source, 'logo.png', 'image/png'), {
      ownerUserId: OWNER,
      purpose: 'store_logo',
      isPublic: true,
    });

    const asset = await service.findAsset(uploaded.id);
    // Both keys are published, so both resolve — and each resolves to itself.
    const thumbnailKey = asset!.thumbnailUrl!.replace('/api/v1/media/files/', '');
    const byFile = await service.findPublicAssetByPath(asset!.path);
    const byThumbnail = await service.findPublicAssetByPath(thumbnailKey);

    expect(byFile?.asset.id).toBe(uploaded.id);
    expect(byFile?.storagePath).toBe(asset!.path);
    expect(byThumbnail?.asset.id).toBe(uploaded.id);
    expect(byThumbnail?.storagePath).toBe(thumbnailKey);

    // The two keys are different objects on disk, which is why serving the
    // thumbnail cannot simply reuse the asset's own path.
    expect(thumbnailKey).not.toBe(asset!.path);
  });

  it('never resolves a private document through the public key route', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
    const uploaded = await service.uploadDocument(upload(pdf, 'card.pdf', 'application/pdf'), {
      ownerUserId: OWNER,
      purpose: 'kyc_national_id',
    });
    const asset = await service.findAsset(uploaded.id);

    expect(await service.findPublicAssetByPath(asset!.path)).toBeNull();
    expect(await service.findPublicAssetByPath('images/store_logo/2026/09/nope.webp')).toBeNull();
  });

  it('grants private documents to the owner and to reviewing staff only', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
    const uploaded = await service.uploadDocument(upload(pdf, 'card.pdf', 'application/pdf'), {
      ownerUserId: OWNER,
      purpose: 'kyc_national_id',
    });
    const asset = (await service.findAsset(uploaded.id)) as MediaAssetView;
    prismaFake.setOwner(asset.id, OWNER);

    const allowed = await Promise.all(
      [UserRole.SUPPORT, UserRole.ADMIN, UserRole.SUPER_ADMIN, UserRole.FINANCIAL_OFFICER].map((role) =>
        service.canAccessPrivateAsset({ asset, user: { id: 'staff-1', role } }),
      ),
    );
    expect(allowed).toEqual([true, true, true, true]);

    expect(await service.canAccessPrivateAsset({ asset, user: { id: OWNER, role: UserRole.CUSTOMER } })).toBe(true);
    expect(
      await service.canAccessPrivateAsset({ asset, user: { id: 'someone-else', role: UserRole.VENDOR } }),
    ).toBe(false);
  });

  it('grants dispute evidence to both parties of the dispute and to nobody else (Phase 9)', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
    const uploaded = await service.uploadDocument(upload(pdf, 'photo.pdf', 'application/pdf'), { ownerUserId: OWNER, purpose: 'dispute_evidence' });
    const asset = (await service.findAsset(uploaded.id)) as MediaAssetView;
    prismaFake.setOwner(asset.id, OWNER);

    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'store-owner', role: UserRole.VENDOR } })).toBe(false);
    prismaFake.shareAsEvidence(asset.id, [OWNER, 'store-owner']);
    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'store-owner', role: UserRole.VENDOR } })).toBe(true);
    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'other-store', role: UserRole.VENDOR } })).toBe(false);
    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'other-customer', role: UserRole.CUSTOMER } })).toBe(false);
  });

  it('serves a public file as cacheable and a private one as no-store, with hardening headers', async () => {
    const source = await png(500, 500);
    const uploaded = await service.uploadImage(upload(source, 'logo.png', 'image/png'), {
      ownerUserId: OWNER,
      purpose: 'store_logo',
      isPublic: true,
    });
    const asset = (await service.findAsset(uploaded.id)) as MediaAssetView;

    const publicReply = createReplyStub();
    await service.streamAsset(asset, publicReply as never);

    expect(detectFileType(publicReply.payload as Buffer)?.mimeType).toBe('image/webp');
    expect(publicReply.headers['content-type']).toBe('image/webp');
    expect(publicReply.headers['content-length']).toBe(String(asset.sizeBytes));
    expect(publicReply.headers['cache-control']).toContain('public');
    expect(publicReply.headers['x-content-type-options']).toBe('nosniff');
    expect(publicReply.headers['content-security-policy']).toContain("default-src 'none'");

    const privateAsset = { ...asset, isPublic: false };
    const privateReply = createReplyStub();
    await service.streamAsset(privateAsset, privateReply as never);

    expect(privateReply.headers['cache-control']).toBe('private, no-store');
  });

  it('reports the active provider and the configured ceilings', () => {
    expect(service.storageProviderInfo()).toEqual({ provider: 'local', isLocal: true });
    expect(service.limits).toEqual({ imageBytes: IMAGE_LIMIT, documentBytes: DOCUMENT_LIMIT });
  });

  it('surfaces a storage outage as 503 rather than as a bad request', async () => {
    const failingProvider: StorageProvider = {
      kind: 'local',
      isLocal: true,
      upload: (params: UploadParams): Promise<never> => {
        void params;
        return Promise.reject(new StorageError('local', 'ENOSPC: no space left on device'));
      },
      delete: (): Promise<boolean> => Promise.resolve(false),
      exists: (): Promise<boolean> => Promise.resolve(false),
      read: (): Promise<Buffer> => Promise.resolve(Buffer.alloc(0)),
      getUrl: (path: string): string => `/api/v1/media/files/${path}`,
    };
    const failingStorage = new StorageService(failingProvider);
    const failingService = new MediaService(prismaFake.service, failingStorage, configFake);
    const source = await png(400, 400);

    const rejection = await failingService
      .uploadImage(upload(source, 'logo.png', 'image/png'), {
        ownerUserId: OWNER,
        purpose: 'store_logo',
        isPublic: true,
      })
      .catch((error: unknown) => error);

    expect(rejection).toBeInstanceOf(ServiceUnavailableException);
    expect((rejection as ServiceUnavailableException).getStatus()).toBe(503);
    expect((rejection as ServiceUnavailableException).message).toContain('provider: local');
    // Nothing was recorded: a failed store must not leave a row behind.
    expect(prismaFake.rows.size).toBe(0);
  });
});
```

### `apps/backend/src/modules/media/media.service.ts`

```ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MediaKind, Prisma, UserRole } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { StorageService } from '../storage/storage.service';
import {
  MAGIC_BYTE_PROBE_LENGTH,
  detectFileType,
  sanitizeOriginalName,
  type DetectedFileType,
} from './file-signature';
import { documentDownloadUrl } from './media-urls';

/** Longest edge of the stored (optimised) image, in pixels. */
const MAX_IMAGE_DIMENSION = 1_600;
/** Thumbnail box. `fit: cover` guarantees exactly 300×300 without distortion. */
const THUMBNAIL_SIZE = 300;
const WEBP_QUALITY = 82;

/**
 * Accepted types per endpoint.
 *
 * The document endpoint deliberately accepts PNG/JPEG as well as PDF: a KYC card
 * is usually photographed, and forcing a conversion would destroy the evidence.
 * GIF is not accepted as a document (nothing in the workflow produces one), and
 * the image endpoint does not accept PDFs — that is what the document endpoint is
 * for, and the error message says which one to use.
 */
const IMAGE_MIME_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
]);

/** Roles allowed to read any private asset (KYC review, support, auditing). */
const STAFF_ROLES_WITH_KYC_ACCESS = new Set<UserRole>([
  UserRole.SUPPORT,
  UserRole.FINANCIAL_OFFICER,
  UserRole.ADMIN,
  UserRole.SUPER_ADMIN,
]);
const THUMBNAIL_QUALITY = 75;

export interface UploadedFile {
  /** Original filename as sent by the client (untrusted; sanitized before use). */
  originalName: string;
  /** Declared content type; used only as a hint, never as a decision. */
  declaredMimeType: string;
  buffer: Buffer;
}

/**
 * Internal read model. It includes `path` — the object key the storage provider
 * needs — which is deliberately **not** part of the HTTP representation
 * (`MediaAssetDto`), so the API never discloses an internal key that would be
 * useful only to an attacker.
 */
/**
 * Result of resolving a public object key: which asset owns it, and **which** of
 * the asset's two keys matched. The thumbnail is a separate stored object, so
 * serving the URL is not the same as serving the asset's primary file.
 */
export interface PublicAssetLookup {
  asset: MediaAssetView;
  /** Provider-relative key to read: the file itself, or its thumbnail. */
  storagePath: string;
}

export interface MediaAssetView {
  id: string;
  kind: MediaKind;
  purpose: string;
  path: string;
  url: string;
  thumbnailUrl: string | null;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  originalName: string | null;
  isPublic: boolean;
  createdAt: Date;
}

export interface ImageUploadResult {
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: 'image/webp';
  sizeBytes: number;
  originalSizeBytes: number;
  width: number;
  height: number;
  compressionRatio: number;
}

export interface DocumentUploadResult {
  id: string;
  url: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  isPublic: false;
}

/**
 * The media pipeline.
 *
 * Order of operations, and why it is this order:
 *
 * 1. **size** — reject before allocating anything else;
 * 2. **magic bytes** — reject a mislabelled file before Sharp sees it;
 * 3. **Sharp decode** — the real proof that the bytes are a usable image, and
 *    the source of the true dimensions (a `Content-Type: image/png` header is a
 *    claim, decoding is evidence);
 * 4. **re-encode to WebP** — the pipeline never stores the uploaded bytes as
 *    received, so an image cannot smuggle a payload in a side channel of a
 *    format Sharp would otherwise copy verbatim (EXIF, ICC, trailing data);
 * 5. **store** — only after the buffer is known-good, so a rejected upload never
 *    leaves a file behind;
 * 6. **record** — one row per stored file, written last, after both objects exist.
 *
 * Documents take a shorter path (2 → 5 → 6): they are stored as received because
 * re-encoding a PDF or a KYC scan would destroy its evidentiary value. They are
 * marked private and are streamed through the API instead of being published.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);
  private readonly maxImageBytes: number;
  private readonly maxDocumentBytes: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxImageBytes = config.getOrThrow<number>('MEDIA_MAX_IMAGE_BYTES');
    this.maxDocumentBytes = config.getOrThrow<number>('MEDIA_MAX_DOCUMENT_BYTES');
  }

  get limits(): { imageBytes: number; documentBytes: number } {
    return { imageBytes: this.maxImageBytes, documentBytes: this.maxDocumentBytes };
  }

  // ─── Images ───────────────────────────────────────────────────────────────

  /**
   * Processes an uploaded image into two WebP objects (optimised + thumbnail)
   * and records the asset.
   *
   * `isPublic` is decided by the caller (`purpose`): a store logo is meant to be
   * seen by everyone, KYC material never is.
   */
  async uploadImage(
    file: UploadedFile,
    context: { ownerUserId: string; purpose: string; isPublic: boolean; vendorId?: string | null },
  ): Promise<ImageUploadResult> {
    this.assertWithinSize(file.buffer, this.maxImageBytes, 'image');
    const detected = this.assertDetectedType(file.buffer, 'image');

    const optimised = await this.processImage(file.buffer, { maxDimension: MAX_IMAGE_DIMENSION, quality: WEBP_QUALITY });
    const thumbnail = await this.processImage(file.buffer, {
      maxDimension: THUMBNAIL_SIZE,
      quality: THUMBNAIL_QUALITY,
      square: true,
    });

    const basePath = this.buildPath('images', context.purpose);
    const path = `${basePath}.webp`;
    const thumbnailPath = `${basePath}_thumb.webp`;

    const storedImage = await this.storage.upload({
      buffer: optimised.buffer,
      path,
      mimeType: 'image/webp',
      metadata: { originalType: detected.mimeType, purpose: context.purpose },
    });
    const storedThumbnail = await this.storage.upload({
      buffer: thumbnail.buffer,
      path: thumbnailPath,
      mimeType: 'image/webp',
      metadata: { purpose: `${context.purpose}_thumbnail` },
    });

    const asset = await this.prisma.mediaAsset.create({
      data: {
        ownerUserId: context.ownerUserId,
        vendorId: context.vendorId ?? null,
        kind: MediaKind.IMAGE,
        purpose: context.purpose,
        storageProvider: this.storage.kind,
        path: storedImage.path,
        thumbnailPath: storedThumbnail.path,
        url: storedImage.url,
        thumbnailUrl: storedThumbnail.url,
        mimeType: 'image/webp',
        originalName: sanitizeOriginalName(file.originalName),
        sizeBytes: storedImage.sizeBytes,
        width: optimised.width,
        height: optimised.height,
        isPublic: context.isPublic,
      },
      select: { id: true },
    });

    this.logger.log(
      `Stored image ${asset.id} (${context.purpose}): ${file.buffer.byteLength}B ${detected.extension} → ${storedImage.sizeBytes}B webp`,
    );

    return {
      id: asset.id,
      url: storedImage.url,
      thumbnailUrl: storedThumbnail.url,
      mimeType: 'image/webp',
      sizeBytes: storedImage.sizeBytes,
      originalSizeBytes: file.buffer.byteLength,
      width: optimised.width,
      height: optimised.height,
      compressionRatio: Number((storedImage.sizeBytes / file.buffer.byteLength).toFixed(4)),
    };
  }

  // ─── Documents ────────────────────────────────────────────────────────────

  /**
   * Stores a KYC/verification document. Never re-encoded, always private.
   *
   * A PDF is additionally opened by Sharp's metadata reader only when it is an
   * image; a PDF is accepted on its magic bytes alone, which is what its
   * producers and reviewers expect.
   */
  async uploadDocument(
    file: UploadedFile,
    context: { ownerUserId: string; purpose: string; vendorId?: string | null },
  ): Promise<DocumentUploadResult> {
    this.assertWithinSize(file.buffer, this.maxDocumentBytes, 'document');
    const detected = this.assertDetectedType(file.buffer, 'document');
    const originalName = sanitizeOriginalName(file.originalName);

    const path = `${this.buildPath('documents', context.purpose)}.${detected.extension}`;

    const stored = await this.storage.upload({
      buffer: file.buffer,
      path,
      mimeType: detected.mimeType,
      metadata: { purpose: context.purpose, originalName },
    });

    // The id is generated here, not by the database, because the canonical URL of a
    // private document *is* the guarded download route — and that route needs the
    // id. Handing back the provider path instead would produce a URL that 404s by
    // design (private objects are not served through the public file route), which
    // is exactly the kind of lying response a client cannot debug.
    const assetId = randomUUID();

    const asset = await this.prisma.mediaAsset.create({
      data: {
        id: assetId,
        ownerUserId: context.ownerUserId,
        vendorId: context.vendorId ?? null,
        kind: MediaKind.DOCUMENT,
        purpose: context.purpose,
        storageProvider: this.storage.kind,
        path: stored.path,
        url: documentDownloadUrl(assetId),
        mimeType: detected.mimeType,
        originalName,
        sizeBytes: stored.sizeBytes,
        isPublic: false,
      },
      select: { id: true },
    });

    this.logger.log(`Stored document ${asset.id} (${context.purpose}): ${originalName} ${stored.sizeBytes}B`);

    return {
      id: asset.id,
      url: documentDownloadUrl(asset.id),
      originalName,
      sizeBytes: stored.sizeBytes,
      mimeType: detected.mimeType,
      isPublic: false,
    };
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  async findAsset(id: string): Promise<MediaAssetView | null> {
    const asset = await this.prisma.mediaAsset.findUnique({ where: { id } });
    if (asset === null) {
      return null;
    }
    return {
      id: asset.id,
      kind: asset.kind,
      purpose: asset.purpose,
      path: asset.path,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      originalName: asset.originalName,
      isPublic: asset.isPublic,
      createdAt: asset.createdAt,
    };
  }

  /**
   * Public lookup by object key, used by the anonymous file route.
   *
   * Both of an asset's keys resolve here — the image and its thumbnail — because
   * both are published and both are in the URL a storefront embeds. The row is
   * what authorizes the file, so an unpublished object key yields `null` no matter
   * how plausible the path looks.
   */
  async findPublicAssetByPath(path: string): Promise<PublicAssetLookup | null> {
    const row = await this.prisma.mediaAsset.findFirst({
      where: { isPublic: true, OR: [{ path }, { thumbnailPath: path }] },
      select: { id: true, path: true, thumbnailPath: true },
    });
    if (row === null) {
      return null;
    }

    const asset = await this.findAsset(row.id);
    if (asset === null) {
      return null;
    }

    return {
      asset,
      storagePath: row.thumbnailPath === path ? row.thumbnailPath : row.path,
    };
  }

  /** Every asset of a vendor, newest first — used by the admin vendor detail view. */
  async listVendorAssets(vendorId: string): Promise<MediaAssetView[]> {
    const assets = await this.prisma.mediaAsset.findMany({
      where: { vendorId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      purpose: asset.purpose,
      path: asset.path,
      url: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      width: asset.width,
      height: asset.height,
      originalName: asset.originalName,
      isPublic: asset.isPublic,
      createdAt: asset.createdAt,
    }));
  }

  /**
   * Authorization for private objects: the owner, or a member of staff whose job
   * requires the file. Vendors never see other vendors' KYC material.
   *
   * `SUPPORT` and `FINANCIAL_OFFICER` are included because a support agent must
   * read the document a vendor complains about, and a credit officer must review
   * the bank proof attached to a KYC file — but neither can approve a vendor,
   * which stays with `ADMIN`/`SUPER_ADMIN`.
   */
  async canAccessPrivateAsset(params: {
    asset: MediaAssetView;
    user: { id: string; role: UserRole };
  }): Promise<boolean> {
    if (params.asset.isPublic) {
      return true;
    }

    const owner = await this.prisma.mediaAsset.findUnique({
      where: { id: params.asset.id },
      select: { ownerUserId: true },
    });
    if (owner?.ownerUserId === params.user.id) {
      return true;
    }

    if (STAFF_ROLES_WITH_KYC_ACCESS.has(params.user.role)) {
      return true;
    }

    // Dispute evidence (Phase 9): both parties of the dispute may read it — the
    // customer who raised it and the owner of the store it is against.
    const sharedAsEvidence = await this.prisma.disputeEvidence.count({
      where: {
        mediaAssetId: params.asset.id,
        dispute: { OR: [{ raisedByUserId: params.user.id }, { vendor: { userId: params.user.id } }] },
      },
    });
    return sharedAsEvidence > 0;
  }

  /**
   * Pipelines a stored object to the HTTP response.
   *
   * Content is read from the active provider — never from a client-supplied path
   * — and the response carries the stored content type plus hardening headers, so
   * an HTML-looking payload could not be rendered as a page even if the
   * magic-byte filter were somehow bypassed.
   *
   * `storagePath` defaults to the asset's own file and is overridden only when the
   * request was for the thumbnail key.
   */
  async streamAsset(asset: MediaAssetView, reply: FastifyReply, storagePath?: string): Promise<void> {
    const buffer = await this.storage.read(storagePath ?? asset.path);

    reply
      .header('content-type', asset.mimeType)
      .header('content-length', String(buffer.byteLength))
      .header('cache-control', asset.isPublic ? 'public, max-age=31536000, immutable' : 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .send(buffer);
  }

  /** Honest report of the active storage provider, surfaced by the API. */
  storageProviderInfo(): { provider: string; isLocal: boolean } {
    return this.storage.describe();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private assertWithinSize(buffer: Buffer, limit: number, label: string): void {
    if (buffer.byteLength === 0) {
      throw new BadRequestException('The uploaded file is empty');
    }
    if (buffer.byteLength > limit) {
      throw new BadRequestException(
        `The ${label} exceeds the maximum size of ${Math.round(limit / 1024 / 1024)} MB`,
      );
    }
  }

  /**
   * Magic bytes decide; a client-supplied extension or `Content-Type` never does.
   *
   * A file whose bytes are not in the allow-list is rejected here, before Sharp or
   * the storage provider ever see it, and a file that *is* identifiable but belongs
   * to the other family (a PDF sent to the image endpoint) is reported with the
   * type that actually arrived so the client can fix the call.
   */
  private assertDetectedType(buffer: Buffer, expected: 'image' | 'document'): DetectedFileType {
    if (buffer.length < MAGIC_BYTE_PROBE_LENGTH) {
      throw new BadRequestException('The file is too small to identify and was rejected');
    }

    const detected = detectFileType(buffer);
    if (detected === null) {
      throw new BadRequestException(
        expected === 'image'
          ? 'Unsupported image format. Allowed: PNG, JPEG, GIF, WEBP'
          : 'Unsupported document format. Allowed: PDF, PNG, JPEG',
      );
    }

    const accepted = expected === 'image' ? IMAGE_MIME_TYPES : DOCUMENT_MIME_TYPES;
    if (!accepted.has(detected.mimeType)) {
      throw new BadRequestException(
        expected === 'image'
          ? `Expected an image (PNG, JPEG, GIF, WEBP) but received ${detected.mimeType}`
          : `Expected a document (PDF, PNG, JPEG) but received ${detected.mimeType}`,
      );
    }
    return detected;
  }

  /**
   * Decodes and re-encodes with Sharp.
   *
   * `failOn: 'error'` makes a truncated or corrupt image throw instead of being
   * silently repaired, and `.rotate()` (no argument) applies the EXIF
   * orientation before the EXIF block is dropped by the WebP encoder — without
   * it, phone photos would be stored sideways.
   */
  private async processImage(
    buffer: Buffer,
    options: { maxDimension: number; quality: number; square?: boolean },
  ): Promise<{ buffer: Buffer; width: number; height: number }> {
    try {
      const pipeline = sharp(buffer, { failOn: 'error', limitInputPixels: 50_000_000 }).rotate();

      const resized =
        options.square === true
          ? pipeline.resize({ width: options.maxDimension, height: options.maxDimension, fit: 'cover' })
          : pipeline.resize({
              width: options.maxDimension,
              height: options.maxDimension,
              fit: 'inside',
              withoutEnlargement: true,
            });

      const { data, info } = await resized.webp({ quality: options.quality, effort: 4 }).toBuffer({
        resolveWithObject: true,
      });

      return { buffer: data, width: info.width, height: info.height };
    } catch (error) {
      this.logger.warn(`Image processing rejected a file: ${String(error)}`);
      throw new BadRequestException('The file is not a readable image or is corrupted');
    }
  }

  /**
   * Object key: `<family>/<purpose>/<yyyy>/<mm>/<uuid>`. The date prefix keeps
   * directories and S3 prefixes small, and the UUID makes collisions impossible
   * without trusting anything from the client.
   */
  private buildPath(family: string, purpose: string): string {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const safePurpose = purpose.replace(/[^a-z0-9_-]/gi, '_').slice(0, 40);
    return `${family}/${safePurpose}/${year}/${month}/${randomUUID()}`;
  }
}

/** Narrow helper so callers can distinguish a Prisma unique violation if needed. */
export function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
```

### `apps/backend/src/modules/orders/dto/order-response.dto.ts`

```ts
import type { WalletAction } from '../order-lifecycle.service';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, PaymentMethod, SubOrderStatus } from '@prisma/client';

const MONEY = { type: String, example: '1250000.00', description: 'IRR (Rial, `platform.currency`), 2 decimals, as a string.' } as const;

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
  @ApiProperty({
    enum: ['ESCROW_RELEASED', 'ESCROW_REVERSED', 'EARNINGS_REVERSED', 'DISPUTE_HOLD_REFUNDED', 'DISPUTE_HOLD_RELEASED', 'NONE'],
    description:
      'Wallet consequence: ESCROW_RELEASED (delivered → withdrawable), ESCROW_REVERSED (cancel/refund before delivery, out of escrow), ' +
      'EARNINGS_REVERSED (refund after delivery, out of the withdrawable balance), NONE. The DISPUTE_HOLD_* values are produced only by ' +
      'dispute resolutions (Phase 9): the frozen earnings were refunded or released to the vendor.',
  })
  walletAction!: WalletAction;
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

export class CustomerDeliveryConfirmationDto extends SubOrderTransitionResultDto {
  @ApiProperty({ type: CustomerOrderDetailDto, description: 'The whole order after the confirmation.' }) order!: CustomerOrderDetailDto;
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
```

### `apps/backend/src/modules/orders/order-lifecycle.service.ts`

```ts
import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, DisputeStatus, ParentOrderPaymentStatus, PaymentMethod, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditOrderService, type ProviderFollowUp } from '../credit/credit-order.service';
import { InventoryService } from '../products/inventory.service';
import { WalletLedgerService, type ReverseOutcome } from '../wallet/wallet-ledger.service';
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

/**
 * Wallet consequence of a package transition: escrow released on delivery, the
 * vendor's earnings reversed on cancel/refund, or — for dispute resolutions
 * (Phase 9) — the frozen earnings refunded or released.
 */
export type WalletAction = 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'DISPUTE_HOLD_REFUNDED' | 'DISPUTE_HOLD_RELEASED' | 'NONE';

export interface TransitionResult {
  subOrderId: string;
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
}

/** Disputes that still freeze their package (Phase 9). */
export const ACTIVE_DISPUTE_STATUSES: readonly DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION];

/** Package fields a dispute resolution receives (the row read under the parent-order lock). */
export type DisputedPackage = TransitionRow;

/**
 * How a dispute resolution overrides the default consequences of a transition:
 * the stock decision and the wallet movement come from the dispute, not from
 * the status change (the escrow is frozen in DISPUTE_HOLD, which the default
 * release/reverse refuse to touch).
 */
export interface DisputeOutcome {
  restock: boolean;
  wallet: (tx: Tx, sub: DisputedPackage) => Promise<WalletAction>;
  audit: Record<string, unknown>;
}

/** What confirming a payment did; `applied: false` means the order was no longer PENDING. */
export interface PaymentApplication {
  applied: boolean;
  escrowHeld: string;
  auditLogId: string | null;
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
 *
 * Wallet rules (Phase 7, via `WalletLedgerService` in the same transaction):
 * - payment confirmed → each package's vendorEarningsAmount is held in escrow (PENDING);
 * - package DELIVERED (customer confirmation or staff/carrier) → escrow released to WITHDRAWABLE, once;
 * - package CANCELLED / REFUNDED → the vendor's earnings are reversed (from escrow, or from the
 *   withdrawable balance if already delivered; 409 when the vendor already withdrew it).
 */
@Injectable()
export class OrderLifecycleService {
  private readonly logger = new Logger(OrderLifecycleService.name);

  private readonly paymentGraceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly ledger: WalletLedgerService,
    private readonly creditOrders: CreditOrderService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.paymentGraceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  // ─── unpaid orders ────────────────────────────────────────────────────────

  /** Customer cancels an order that has not been paid yet. */
  async cancelByCustomer(userId: string, parentOrderId: string, reason: string | undefined, actor: OrderActor): Promise<string> {
    const followUps: ProviderFollowUp[] = [];
    const auditLogId = await this.prisma.$transaction(async (tx) => {
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
      return this.closeUnpaid(tx, order.id, 'CUSTOMER_CANCEL', reason, actor, followUps);
    });
    await this.creditOrders.followUp(followUps);
    return auditLogId;
  }

  /** Payment gateway reported failure for an unpaid order. Idempotent: returns `false` if not PENDING. */
  async markPaymentFailed(parentOrderId: string, reason?: string, actor: OrderActor = SYSTEM_ACTOR): Promise<boolean> {
    const followUps: ProviderFollowUp[] = [];
    const closed = await this.prisma.$transaction(async (tx) => {
      const order = await this.lockPending(tx, parentOrderId);
      if (!order) return false;
      await this.closeUnpaid(tx, order.id, 'PAYMENT_FAILED', reason, actor, followUps);
      return true;
    });
    await this.creditOrders.followUp(followUps);
    return closed;
  }

  /**
   * Payment confirmed: the order becomes PAID, each reservation is converted
   * into a sale and each package's vendor earnings enter escrow. Idempotent:
   * `applied: false` if the order is not PENDING (already paid, or
   * cancelled/expired first).
   */
  async markPaid(parentOrderId: string, actor: OrderActor = SYSTEM_ACTOR): Promise<PaymentApplication> {
    return this.prisma.$transaction(async (tx) => {
      if (!(await lockParentOrder(tx, parentOrderId))) {
        return { applied: false, escrowHeld: '0.00', auditLogId: null };
      }
      return this.applyPaymentLocked(tx, parentOrderId, actor, {});
    });
  }

  /**
   * `markPaid` for a caller that already runs the transaction and holds the
   * parent-order lock (the payment callback, which updates the Payment row in
   * the same transaction). Sub-orders keep PENDING_APPROVAL and become visible
   * to vendors because the parent is now PAID. `paymentMethod` records how the
   * order was paid (CASH_IPG, BANK_CREDIT or HYBRID; default CASH_IPG).
   */
  async applyPaymentLocked(
    tx: Tx,
    parentOrderId: string,
    actor: OrderActor,
    payment: { paymentId?: string; bankRrn?: string; paymentMethod?: PaymentMethod },
  ): Promise<PaymentApplication> {
    const paymentMethod = payment.paymentMethod ?? PaymentMethod.CASH_IPG;
    const order = await tx.parentOrder.findFirst({
      where: { id: parentOrderId, paymentStatus: ParentOrderPaymentStatus.PENDING },
      select: { id: true },
    });
    if (!order) return { applied: false, escrowHeld: '0.00', auditLogId: null };

    const subs = await tx.subOrder.findMany({
      where: { parentOrderId },
      select: { id: true, vendorId: true, subOrderNumber: true, vendorEarningsAmount: true, items: { select: { productVariantId: true, quantity: true } } },
      orderBy: { vendorId: 'asc' }, // wallet lock order
    });
    for (const move of stockMovements(subs.flatMap((sub) => sub.items))) {
      await this.inventory.commitReservation(move.variantId, move.quantity, tx);
    }
    const paidAt = new Date();
    await tx.parentOrder.update({
      where: { id: parentOrderId },
      data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt, paymentMethod },
    });
    let escrowHeld = new Prisma.Decimal(0);
    for (const sub of subs) {
      if (await this.ledger.holdSaleEscrow(tx, sub)) {
        escrowHeld = escrowHeld.plus(sub.vendorEarningsAmount);
      }
    }
    const auditLogId = await writeOrderAudit(tx, actor, {
      action: AuditAction.PAYMENT_CAPTURE,
      entityName: 'ParentOrder',
      entityId: parentOrderId,
      oldValue: { paymentStatus: ParentOrderPaymentStatus.PENDING },
      newValue: {
        paymentStatus: ParentOrderPaymentStatus.PAID,
        paidAt: paidAt.toISOString(),
        paymentMethod,
        escrowHeld: escrowHeld.toFixed(2),
        packages: subs.length,
        ...(payment.paymentId ? { paymentId: payment.paymentId } : {}),
        ...(payment.bankRrn ? { bankRrn: payment.bankRrn } : {}),
      },
    });
    return { applied: true, escrowHeld: escrowHeld.toFixed(2), auditLogId };
  }

  /**
   * Cancels unpaid orders whose payment window has passed and releases their
   * stock. Each order is handled in its own transaction (one bad row cannot
   * block the rest) and re-checked under lock (a payment that landed meanwhile wins).
   */
  async expireOverdue(now: Date = new Date(), batchSize = 100): Promise<number> {
    // A customer who is on the bank page right now must not lose the order: an
    // INITIATED payment younger than the grace window protects it.
    const inFlightSince = new Date(now.getTime() - this.paymentGraceMs);
    const inFlight: Prisma.ParentOrderWhereInput = {
      payments: { some: { status: PaymentStatus.INITIATED, createdAt: { gt: inFlightSince } } },
    };
    const due = await this.prisma.parentOrder.findMany({
      where: { paymentStatus: ParentOrderPaymentStatus.PENDING, paymentExpiresAt: { lte: now }, NOT: inFlight },
      select: { id: true },
      orderBy: { paymentExpiresAt: 'asc' },
      take: batchSize,
    });
    let expired = 0;
    for (const { id } of due) {
      try {
        const followUps: ProviderFollowUp[] = [];
        const done = await this.prisma.$transaction(async (tx) => {
          const order = await this.lockPending(tx, id);
          if (!order || order.paymentExpiresAt === null || order.paymentExpiresAt > now) return false;
          if ((await tx.parentOrder.count({ where: { id, ...inFlight } })) > 0) return false;
          await this.closeUnpaid(tx, id, 'PAYMENT_EXPIRED', undefined, SYSTEM_ACTOR, followUps);
          return true;
        });
        await this.creditOrders.followUp(followUps);
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

  /**
   * The customer confirms receipt of a SHIPPED package: it becomes DELIVERED
   * and the vendor's escrow is released to the withdrawable balance.
   */
  async confirmDeliveryByCustomer(userId: string, parentOrderId: string, subOrderId: string, actor: OrderActor): Promise<TransitionResult> {
    return this.prisma.$transaction(async (tx) => {
      const locked = await lockParentOrder(tx, parentOrderId);
      const sub = locked ? await this.loadForTransition(tx, subOrderId) : null;
      if (!sub || sub.parentOrderId !== parentOrderId || sub.parentOrder.userId !== userId) {
        throw new NotFoundException('Order not found');
      }
      if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID || sub.status !== SubOrderStatus.SHIPPED) {
        throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be confirmed as delivered; only SHIPPED packages can`, {
          currentStatus: sub.status,
        });
      }
      return this.applyTransition(tx, sub, SubOrderStatus.DELIVERED, { status: SubOrderStatus.DELIVERED, deliveredAt: new Date() }, {
        role: 'CUSTOMER',
        note: 'Receipt confirmed by the customer',
        actor,
      });
    });
  }

  // ─── disputes (Phase 9) ─────────────────────────────────────────────────

  /**
   * Applies a dispute decision to its package, inside the caller's transaction
   * (which already holds the parent-order lock): REFUNDED for the buyer,
   * DELIVERED for the vendor. A package that is already DELIVERED keeps its
   * status; only the wallet movement and the audit row are written.
   *
   * Credit-funded packages cannot be refunded yet (CREDIT_ORDER_REFUND_UNSUPPORTED,
   * same rule as every other refund path).
   */
  async applyDisputeOutcomeLocked(
    tx: Tx,
    subOrderId: string,
    target: typeof SubOrderStatus.REFUNDED | typeof SubOrderStatus.DELIVERED,
    meta: { role: ActorRole; note: string; actor: OrderActor },
    outcome: DisputeOutcome,
  ): Promise<TransitionResult> {
    const sub = await this.loadForTransition(tx, subOrderId);
    if (!sub) {
      throw new NotFoundException('Sub-order not found');
    }
    if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID) {
      throw conflictWith('ORDER_NOT_PAID', 'Only packages of paid orders can be resolved', { paymentStatus: sub.parentOrder.paymentStatus });
    }
    if (sub.status === target) {
      const walletAction = await outcome.wallet(tx, sub);
      const auditLogId = await writeOrderAudit(tx, meta.actor, {
        action: AuditAction.DISPUTE_RESOLUTION,
        entityName: 'SubOrder',
        entityId: sub.id,
        oldValue: { status: sub.status },
        newValue: { status: target, subOrderNumber: sub.subOrderNumber, actorRole: meta.role, note: meta.note, stockAction: 'NONE', walletAction, ...outcome.audit },
      });
      return { subOrderId: sub.id, previousStatus: sub.status, stockAction: 'NONE', walletAction, auditLogId };
    }
    if (!canStaffForce(sub.status, target)) {
      throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be resolved to ${target}`, { currentStatus: sub.status });
    }
    const data: Prisma.SubOrderUpdateManyMutationInput =
      target === SubOrderStatus.DELIVERED ? { status: target, deliveredAt: new Date() } : { status: target };
    return this.applyTransition(tx, sub, target, data, meta, outcome);
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

  /**
   * Unpaid order leaves the funnel: credit reservations released (before stock,
   * per the lock order parent → credit account → stock → wallets), stock
   * reservations released, every package CANCELLED. Parent row must be locked;
   * the provider-side releases are appended to `followUps` for after the commit.
   */
  private async closeUnpaid(
    tx: Tx,
    parentOrderId: string,
    outcome: UnpaidOutcome,
    reason: string | undefined,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<string> {
    const rule = UNPAID_OUTCOME[outcome];
    const note = reason ?? rule.defaultReason;
    const now = new Date();
    const creditReleases = await this.creditOrders.releaseOpenReservationsLocked(tx, parentOrderId);
    followUps.push(...creditReleases);
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
        ...(creditReleases.length > 0 ? { creditReservationsReleased: creditReleases.map((r) => r.reservationRef) } : {}),
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
    dispute?: DisputeOutcome,
  ): Promise<TransitionResult> {
    if (!dispute) {
      // Escrow freeze (Phase 9): while a dispute is active, the package changes only through the dispute.
      const active = await tx.dispute.findFirst({ where: { subOrderId: sub.id, status: { in: [...ACTIVE_DISPUTE_STATUSES] } }, select: { id: true, status: true } });
      if (active) {
        throw conflictWith('SUB_ORDER_UNDER_DISPUTE', 'This package has an active dispute; it can only change through the dispute resolution', {
          disputeId: active.id,
          disputeStatus: active.status,
        });
      }
    }
    if ((target === SubOrderStatus.CANCELLED || target === SubOrderStatus.REFUNDED) && sub.parentOrder.paymentMethod !== PaymentMethod.CASH_IPG) {
      // Returning bank credit (REFUND_RESTORE, schedule adjustment, provider refund API) is not in the Phase 8 scope.
      throw conflictWith(
        'CREDIT_ORDER_REFUND_UNSUPPORTED',
        `Packages of orders paid with ${sub.parentOrder.paymentMethod} cannot be cancelled or refunded yet; handle it with the credit provider manually`,
        { paymentMethod: sub.parentOrder.paymentMethod },
      );
    }
    // Guarded by the status read under the parent lock; the WHERE makes it explicit.
    const updated = await tx.subOrder.updateMany({ where: { id: sub.id, status: sub.status }, data });
    if (updated.count !== 1) {
      throw conflictWith('CONCURRENT_UPDATE', 'The package was changed by someone else; reload and try again');
    }
    const restock = dispute ? dispute.restock : paidStockEffect(sub.status, target) === 'RESTOCK';
    if (restock) {
      for (const move of stockMovements(sub.items)) {
        await this.inventory.adjustStock(move.variantId, move.quantity, tx);
      }
    }
    const walletAction = dispute ? await dispute.wallet(tx, sub) : await this.applyWalletEffect(tx, sub, target, meta.note);
    await tx.subOrderStatusHistory.create({
      data: { subOrderId: sub.id, fromStatus: sub.status, toStatus: target, actorUserId: meta.actor.actorId, actorRole: meta.role, note: meta.note },
    });
    const auditLogId = await writeOrderAudit(tx, meta.actor, {
      action: dispute ? AuditAction.DISPUTE_RESOLUTION : AuditAction.STATUS_CHANGE,
      entityName: 'SubOrder',
      entityId: sub.id,
      oldValue: { status: sub.status },
      newValue: {
        status: target,
        subOrderNumber: sub.subOrderNumber,
        actorRole: meta.role,
        note: meta.note,
        stockAction: restock ? 'RESTOCKED' : 'NONE',
        walletAction,
        ...(walletAction !== 'NONE' ? { vendorEarningsAmount: sub.vendorEarningsAmount.toFixed(2) } : {}),
        ...(restock ? { restockedLines: stockMovements(sub.items) } : {}),
        ...(dispute ? dispute.audit : {}),
      },
    });
    return { subOrderId: sub.id, previousStatus: sub.status, stockAction: restock ? 'RESTOCKED' : 'NONE', walletAction, auditLogId };
  }

  /** Escrow consequence of a transition on a paid package; runs under the parent lock, before the audit row. */
  private async applyWalletEffect(tx: Tx, sub: TransitionRow, target: SubOrderStatus, note: string | null): Promise<WalletAction> {
    if (target === SubOrderStatus.DELIVERED) {
      const released = await this.ledger.releaseEscrow(tx, sub);
      if (released) {
        await tx.subOrder.update({ where: { id: sub.id }, data: { escrowReleasedAt: new Date() } });
      }
      return released ? 'ESCROW_RELEASED' : 'NONE';
    }
    if (target === SubOrderStatus.CANCELLED || target === SubOrderStatus.REFUNDED) {
      const outcome: ReverseOutcome = await this.ledger.reverseEscrow(tx, sub, note ?? target);
      return outcome === 'FROM_PENDING' ? 'ESCROW_REVERSED' : outcome === 'FROM_WITHDRAWABLE' ? 'EARNINGS_REVERSED' : 'NONE';
    }
    return 'NONE';
  }
}

const transitionSelect = {
  id: true,
  vendorId: true,
  subOrderNumber: true,
  parentOrderId: true,
  vendorEarningsAmount: true,
  status: true,
  parentOrder: { select: { paymentStatus: true, userId: true, paymentMethod: true } },
  items: { select: { productVariantId: true, quantity: true } },
} satisfies Prisma.SubOrderSelect;

type TransitionRow = Prisma.SubOrderGetPayload<{ select: typeof transitionSelect }>;
```

### `apps/backend/src/modules/wallet/dto/wallet.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';

/** Money is IRR (`platform.currency`), 2 decimals, serialised as a string. */
export const MONEY = { type: String, example: '2590000.00', description: 'IRR (Rial), 2 decimals, as a string.' } as const;
export const SIGNED_MONEY = { type: String, example: '-2590000.00', description: 'Signed IRR amount: negative = debit of the bucket.' } as const;

export class WalletSummaryDto {
  @ApiProperty(MONEY) pendingBalance!: string;
  @ApiProperty(MONEY) withdrawableBalance!: string;
  @ApiProperty({ ...MONEY, description: 'Reserved by open settlement requests awaiting the finance team (IRR).' })
  settlementHoldBalance!: string;
  @ApiProperty({ ...MONEY, description: 'Earnings frozen by open disputes about your packages; released or refunded when the dispute is decided (IRR).' })
  disputeHoldBalance!: string;
  @ApiProperty({
    ...MONEY,
    description: 'Earnings that left escrow (delivered, or frozen by a dispute), net of refunds (IRR). Equals withdrawable + settlement hold + dispute hold + withdrawn.',
  })
  totalEarnedBalance!: string;
  @ApiProperty({ ...MONEY, description: 'Lifetime amount paid out by PAYA (IRR).' })
  totalWithdrawnAmount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
}

export class WalletTransactionQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: WalletTransactionType })
  @IsOptional()
  @IsEnum(WalletTransactionType)
  type?: WalletTransactionType;

  @ApiPropertyOptional({ enum: WalletBalanceBucket })
  @IsOptional()
  @IsEnum(WalletBalanceBucket)
  bucket?: WalletBalanceBucket;
}

export class WalletTransactionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: WalletTransactionType }) type!: WalletTransactionType;
  @ApiProperty({ enum: WalletBalanceBucket, description: 'Balance bucket this row moved money in.' }) bucket!: WalletBalanceBucket;
  @ApiProperty(SIGNED_MONEY) amount!: string;
  @ApiProperty({ ...MONEY, description: 'Balance of `bucket` right after this row (IRR).' }) balanceAfter!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) subOrderId!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'SHP-100000012-1' }) subOrderNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) settlementRequestId!: string | null;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedWalletTransactionsDto {
  @ApiProperty({ type: [WalletTransactionDto] }) items!: WalletTransactionDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}
```

### `apps/backend/src/modules/wallet/wallet-ledger.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import { InsufficientBalanceError, escrowStateOf, planEntries, type BucketBalances, type EscrowState, type LedgerEntry } from './wallet-math';

type Tx = Prisma.TransactionClient;

const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD, DISPUTE_HOLD } = WalletBalanceBucket;
const ZERO = new Prisma.Decimal(0);

/** Package fields the escrow operations need. */
export interface EscrowSubOrder {
  id: string;
  vendorId: string;
  subOrderNumber: string;
  vendorEarningsAmount: Prisma.Decimal;
}

interface LockedWallet {
  id: string;
  balances: BucketBalances;
  totalEarned: Prisma.Decimal;
  totalWithdrawn: Prisma.Decimal;
}

interface WalletRow {
  id: string;
  pending_balance: Prisma.Decimal;
  withdrawable_balance: Prisma.Decimal;
  settlement_hold_balance: Prisma.Decimal;
  dispute_hold_balance: Prisma.Decimal;
  total_earned_balance: Prisma.Decimal;
  total_withdrawn_amount: Prisma.Decimal;
}

export type ReverseOutcome = 'NONE' | 'FROM_PENDING' | 'FROM_WITHDRAWABLE';

/** What opening a dispute froze (Phase 9). `source` is null when nothing could be frozen. */
export interface DisputeFreeze {
  source: typeof PENDING | typeof WITHDRAWABLE | null;
  amount: Prisma.Decimal;
  /** Delivered packages only: earnings the vendor had already moved out of WITHDRAWABLE. */
  shortfall: Prisma.Decimal;
}

/** The frozen position of a dispute, as recorded on the dispute row. */
export interface DisputeHoldPosition {
  id: string;
  holdSource: WalletBalanceBucket | null;
  holdAmount: Prisma.Decimal;
  holdShortfall: Prisma.Decimal;
}

export interface DisputeRefund {
  fromHold: Prisma.Decimal;
  /** Part of the shortfall recovered from the vendor's current WITHDRAWABLE balance. */
  fromWithdrawable: Prisma.Decimal;
  /** Earnings that could not be recovered at all (vendor debt, reported to staff). */
  unrecovered: Prisma.Decimal;
}

/**
 * The only writer of vendor wallets. Every method runs inside the caller's
 * transaction, locks the wallet row (`SELECT … FOR UPDATE`, creating the wallet
 * on first use), appends ledger rows and updates the balance projection in the
 * same statement set — so the ledger and the balances commit or roll back
 * together, and concurrent writers to one wallet are serialised.
 *
 * Lock order is always parent order → wallet(s) sorted by vendor id →
 * settlement request, which keeps concurrent payments, deliveries and
 * settlements deadlock-free.
 *
 * Idempotency: package operations derive the package's escrow state from its
 * own ledger rows (`escrowStateOf`) and do nothing when the step already
 * happened; the partial unique indexes of migration phase7_finance reject a
 * duplicate movement even if this check were bypassed.
 */
@Injectable()
export class WalletLedgerService {
  /** Sale confirmed: the vendor's earnings enter escrow (PENDING). Returns false if already held or nothing to hold. */
  async holdSaleEscrow(tx: Tx, sub: EscrowSubOrder): Promise<boolean> {
    if (!sub.vendorEarningsAmount.greaterThan(0)) return false;
    const wallet = await this.lock(tx, sub.vendorId);
    if ((await this.escrowState(tx, sub.id)) !== 'NONE') return false;
    await this.post(tx, wallet, [
      {
        type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
        bucket: PENDING,
        amount: sub.vendorEarningsAmount,
        subOrderId: sub.id,
        description: `Escrow hold for package ${sub.subOrderNumber}`,
      },
    ]);
    return true;
  }

  /** Package delivered: escrow moves to WITHDRAWABLE once. Returns false if there is nothing held to release. */
  async releaseEscrow(tx: Tx, sub: EscrowSubOrder): Promise<boolean> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (state === 'FROZEN') throw frozenError(sub);
    if (state !== 'HELD') return false;
    const description = `Escrow released on delivery of package ${sub.subOrderNumber}`;
    await this.post(
      tx,
      wallet,
      [
        { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: PENDING, amount: sub.vendorEarningsAmount.negated(), subOrderId: sub.id, description },
        { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: WITHDRAWABLE, amount: sub.vendorEarningsAmount, subOrderId: sub.id, description },
      ],
      { earned: sub.vendorEarningsAmount },
    );
    return true;
  }

  /**
   * Package cancelled or refunded: the vendor's earnings leave the wallet.
   * Before delivery they come out of escrow; after delivery out of the
   * withdrawable balance (409 INSUFFICIENT_WALLET_BALANCE if the vendor already
   * requested it — balances never go negative). No-op when nothing was ever
   * held (e.g. zero earnings) or it was already reversed.
   */
  async reverseEscrow(tx: Tx, sub: EscrowSubOrder, reason: string): Promise<ReverseOutcome> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (state === 'FROZEN') throw frozenError(sub);
    if (state === 'NONE' || state === 'REVERSED') return 'NONE';
    const fromWithdrawable = state === 'RELEASED';
    await this.post(
      tx,
      wallet,
      [
        {
          type: WalletTransactionType.REFUND_DEDUCTION,
          bucket: fromWithdrawable ? WITHDRAWABLE : PENDING,
          amount: sub.vendorEarningsAmount.negated(),
          subOrderId: sub.id,
          description: `Refund of package ${sub.subOrderNumber}: ${reason}`.slice(0, 255),
        },
      ],
      fromWithdrawable ? { earned: sub.vendorEarningsAmount.negated() } : {},
    );
    return fromWithdrawable ? 'FROM_WITHDRAWABLE' : 'FROM_PENDING';
  }

  // ─── disputes (Phase 9) ─────────────────────────────────────────────────

  /**
   * A dispute was opened: the package's earnings move into DISPUTE_HOLD, where
   * no delivery confirmation, cancellation or settlement can touch them.
   *
   * - Not delivered (escrow HELD): the full earnings, PENDING → DISPUTE_HOLD.
   *   They leave escrow here, so `totalEarned` grows by the same amount — this
   *   keeps `totalEarned ≥ withdrawn + withdrawable + disputeHold` exact.
   * - Delivered (escrow RELEASED): `min(earnings, withdrawable)`, WITHDRAWABLE →
   *   DISPUTE_HOLD; the rest is the shortfall the vendor already requested or
   *   withdrew. `totalEarned` is unchanged (the money was already counted).
   * - Zero earnings (nothing was escrowed): nothing to freeze.
   */
  async freezeForDispute(tx: Tx, sub: EscrowSubOrder, disputeId: string): Promise<DisputeFreeze> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    const earnings = sub.vendorEarningsAmount;
    const description = `Frozen by a dispute on package ${sub.subOrderNumber}`;
    if (state === 'NONE') return { source: null, amount: ZERO, shortfall: ZERO };
    if (state === 'HELD') {
      await this.post(
        tx,
        wallet,
        [
          { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: PENDING, amount: earnings.negated(), subOrderId: sub.id, disputeId, description },
          { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: DISPUTE_HOLD, amount: earnings, subOrderId: sub.id, disputeId, description },
        ],
        { earned: earnings },
      );
      return { source: PENDING, amount: earnings, shortfall: ZERO };
    }
    if (state === 'RELEASED') {
      const available = wallet.balances[WITHDRAWABLE];
      const amount = Prisma.Decimal.min(earnings, available);
      const shortfall = earnings.minus(amount);
      if (!amount.greaterThan(0)) return { source: null, amount: ZERO, shortfall };
      await this.post(tx, wallet, [
        { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: WITHDRAWABLE, amount: amount.negated(), subOrderId: sub.id, disputeId, description },
        { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: DISPUTE_HOLD, amount, subOrderId: sub.id, disputeId, description },
      ]);
      return { source: WITHDRAWABLE, amount, shortfall };
    }
    throw conflictWith('ESCROW_NOT_FREEZABLE', `The earnings of package ${sub.subOrderNumber} are ${state.toLowerCase()} and cannot be frozen`, { escrowState: state });
  }

  /**
   * Buyer-favour resolution: the frozen amount is deducted (REFUND_DEDUCTION on
   * DISPUTE_HOLD). A shortfall recorded at opening is recovered from whatever
   * WITHDRAWABLE balance the vendor has now; anything left is returned as
   * `unrecovered` (balances never go negative). `totalEarned` shrinks by all
   * that was deducted.
   */
  async refundDisputeHold(tx: Tx, sub: EscrowSubOrder, dispute: DisputeHoldPosition, reason: string): Promise<DisputeRefund> {
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (dispute.holdAmount.greaterThan(0) && state !== 'FROZEN') {
      throw conflictWith('ESCROW_NOT_FROZEN', `The earnings of package ${sub.subOrderNumber} are not frozen (${state})`, { escrowState: state });
    }
    const description = `Refund of package ${sub.subOrderNumber} (dispute): ${reason}`.slice(0, 255);
    const entries: LedgerEntry[] = [];
    if (dispute.holdAmount.greaterThan(0)) {
      entries.push({ type: WalletTransactionType.REFUND_DEDUCTION, bucket: DISPUTE_HOLD, amount: dispute.holdAmount.negated(), subOrderId: sub.id, disputeId: dispute.id, description });
    }
    const fromWithdrawable = Prisma.Decimal.min(dispute.holdShortfall, wallet.balances[WITHDRAWABLE]);
    if (fromWithdrawable.greaterThan(0)) {
      entries.push({ type: WalletTransactionType.REFUND_DEDUCTION, bucket: WITHDRAWABLE, amount: fromWithdrawable.negated(), subOrderId: sub.id, disputeId: dispute.id, description });
    }
    const deducted = dispute.holdAmount.plus(fromWithdrawable);
    if (entries.length > 0) {
      await this.post(tx, wallet, entries, { earned: deducted.negated() });
    }
    return { fromHold: dispute.holdAmount, fromWithdrawable, unrecovered: dispute.holdShortfall.minus(fromWithdrawable) };
  }

  /**
   * The frozen amount leaves DISPUTE_HOLD (DISPUTE_HOLD_RELEASE):
   * - `WITHDRAWABLE`: vendor-favour resolution — released to the vendor;
   * - `SOURCE`: the customer cancelled — back where it came from (PENDING for a
   *   package not delivered yet, which un-counts it from `totalEarned`, or
   *   WITHDRAWABLE for a delivered one).
   * Returns the bucket credited, or null when nothing was frozen.
   */
  async releaseDisputeHold(tx: Tx, sub: EscrowSubOrder, dispute: DisputeHoldPosition, to: 'WITHDRAWABLE' | 'SOURCE'): Promise<WalletBalanceBucket | null> {
    if (!dispute.holdAmount.greaterThan(0) || dispute.holdSource === null) return null;
    const wallet = await this.lock(tx, sub.vendorId);
    const state = await this.escrowState(tx, sub.id);
    if (state !== 'FROZEN') {
      throw conflictWith('ESCROW_NOT_FROZEN', `The earnings of package ${sub.subOrderNumber} are not frozen (${state})`, { escrowState: state });
    }
    const target = to === 'WITHDRAWABLE' ? WITHDRAWABLE : dispute.holdSource;
    const amount = dispute.holdAmount;
    const description =
      target === WITHDRAWABLE ? `Dispute on package ${sub.subOrderNumber} closed: earnings released` : `Dispute on package ${sub.subOrderNumber} cancelled: back to escrow`;
    await this.post(
      tx,
      wallet,
      [
        { type: WalletTransactionType.DISPUTE_HOLD_RELEASE, bucket: DISPUTE_HOLD, amount: amount.negated(), subOrderId: sub.id, disputeId: dispute.id, description },
        { type: WalletTransactionType.DISPUTE_HOLD_RELEASE, bucket: target, amount, subOrderId: sub.id, disputeId: dispute.id, description },
      ],
      target === PENDING ? { earned: amount.negated() } : {},
    );
    return target;
  }

  /** Settlement requested: the amount moves WITHDRAWABLE → SETTLEMENT_HOLD. */
  async holdForSettlement(tx: Tx, vendorId: string, settlementRequestId: string, amount: Prisma.Decimal): Promise<void> {
    const wallet = await this.lock(tx, vendorId);
    const description = 'Held for settlement request';
    await this.post(tx, wallet, [
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: WITHDRAWABLE, amount: amount.negated(), settlementRequestId, description },
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount, settlementRequestId, description },
    ]);
  }

  /** Settlement rejected: the held amount returns to WITHDRAWABLE. */
  async releaseSettlementHold(tx: Tx, vendorId: string, settlementRequestId: string, amount: Prisma.Decimal): Promise<void> {
    const wallet = await this.lock(tx, vendorId);
    const description = 'Settlement request rejected; amount returned';
    await this.post(tx, wallet, [
      { type: WalletTransactionType.SETTLEMENT_HOLD_RELEASE, bucket: SETTLEMENT_HOLD, amount: amount.negated(), settlementRequestId, description },
      { type: WalletTransactionType.SETTLEMENT_HOLD_RELEASE, bucket: WITHDRAWABLE, amount, settlementRequestId, description },
    ]);
  }

  /** Settlement paid by PAYA: the held amount leaves the wallet. */
  async payoutSettlement(tx: Tx, vendorId: string, settlementRequestId: string, amount: Prisma.Decimal, payaReference: string): Promise<void> {
    const wallet = await this.lock(tx, vendorId);
    await this.post(
      tx,
      wallet,
      [
        {
          type: WalletTransactionType.SETTLEMENT_PAYOUT,
          bucket: SETTLEMENT_HOLD,
          amount: amount.negated(),
          settlementRequestId,
          description: `Paid by PAYA, reference ${payaReference}`.slice(0, 255),
        },
      ],
      { withdrawn: amount },
    );
  }

  /** Locks (creating on first use) the wallet of a vendor. Callers locking several wallets must go in vendor-id order. */
  async lock(tx: Tx, vendorId: string): Promise<LockedWallet> {
    await tx.$executeRaw(
      Prisma.sql`INSERT INTO vendor_wallets (id, vendor_id, updated_at) VALUES (gen_random_uuid(), ${vendorId}::uuid, now()) ON CONFLICT (vendor_id) DO NOTHING`,
    );
    const rows = await tx.$queryRaw<WalletRow[]>(
      Prisma.sql`SELECT id, pending_balance, withdrawable_balance, settlement_hold_balance, dispute_hold_balance, total_earned_balance, total_withdrawn_amount
                 FROM vendor_wallets WHERE vendor_id = ${vendorId}::uuid FOR UPDATE`,
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Wallet of vendor ${vendorId} could not be created`);
    }
    return {
      id: row.id,
      balances: {
        [PENDING]: new Prisma.Decimal(row.pending_balance),
        [WITHDRAWABLE]: new Prisma.Decimal(row.withdrawable_balance),
        [SETTLEMENT_HOLD]: new Prisma.Decimal(row.settlement_hold_balance),
        [DISPUTE_HOLD]: new Prisma.Decimal(row.dispute_hold_balance),
      },
      totalEarned: new Prisma.Decimal(row.total_earned_balance),
      totalWithdrawn: new Prisma.Decimal(row.total_withdrawn_amount),
    };
  }

  private async escrowState(tx: Tx, subOrderId: string): Promise<EscrowState> {
    const rows = await tx.walletTransaction.findMany({
      where: {
        subOrderId,
        type: {
          in: [
            WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
            WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
            WalletTransactionType.REFUND_DEDUCTION,
            WalletTransactionType.DISPUTE_HOLD_LOCK,
            WalletTransactionType.DISPUTE_HOLD_RELEASE,
          ],
        },
      },
      select: { type: true, bucket: true, amount: true },
    });
    return escrowStateOf(rows);
  }

  private async post(
    tx: Tx,
    wallet: LockedWallet,
    entries: readonly LedgerEntry[],
    totals: { earned?: Prisma.Decimal; withdrawn?: Prisma.Decimal } = {},
  ): Promise<void> {
    let plan;
    try {
      plan = planEntries(wallet.balances, entries);
    } catch (error) {
      if (error instanceof InsufficientBalanceError) {
        throw conflictWith('INSUFFICIENT_WALLET_BALANCE', `The ${error.bucket.toLowerCase()} balance is not enough for this operation`, {
          bucket: error.bucket,
          available: error.available.toFixed(2),
          required: error.required.toFixed(2),
        });
      }
      throw error;
    }
    await tx.walletTransaction.createMany({
      data: plan.entries.map((entry) => ({
        walletId: wallet.id,
        type: entry.type,
        bucket: entry.bucket,
        amount: entry.amount,
        balanceAfter: entry.balanceAfter,
        subOrderId: entry.subOrderId ?? null,
        settlementRequestId: entry.settlementRequestId ?? null,
        disputeId: entry.disputeId ?? null,
        description: entry.description,
      })),
    });
    const totalEarned = wallet.totalEarned.plus(totals.earned ?? 0);
    const totalWithdrawn = wallet.totalWithdrawn.plus(totals.withdrawn ?? 0);
    await tx.vendorWallet.update({
      where: { id: wallet.id },
      data: {
        pendingBalance: plan.balances[PENDING],
        withdrawableBalance: plan.balances[WITHDRAWABLE],
        settlementHoldBalance: plan.balances[SETTLEMENT_HOLD],
        disputeHoldBalance: plan.balances[DISPUTE_HOLD],
        totalEarnedBalance: totalEarned,
        totalWithdrawnAmount: totalWithdrawn,
      },
    });
    // Keep the in-memory copy current for a second call within the same transaction.
    wallet.balances = plan.balances;
    wallet.totalEarned = totalEarned;
    wallet.totalWithdrawn = totalWithdrawn;
  }
}

function frozenError(sub: EscrowSubOrder): Error {
  return conflictWith('ESCROW_FROZEN_BY_DISPUTE', `The earnings of package ${sub.subOrderNumber} are frozen by an open dispute`, { subOrderId: sub.id });
}
```

### `apps/backend/src/modules/wallet/wallet-math.spec.ts`

```ts
import { Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { emptyBalances, escrowStateOf, InsufficientBalanceError, planEntries, sumByBucket, type EscrowRow } from './wallet-math';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD, DISPUTE_HOLD } = WalletBalanceBucket;

describe('wallet-math', () => {
  it('computes balanceAfter per bucket and the resulting balances', () => {
    const plan = planEntries(emptyBalances(), [
      { type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('2590000.00'), description: 'hold' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: PENDING, amount: d('-2590000.00'), description: 'out' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: WITHDRAWABLE, amount: d('2590000.00'), description: 'in' },
    ]);
    expect(plan.entries.map((entry) => entry.balanceAfter.toFixed(2))).toEqual(['2590000.00', '0.00', '2590000.00']);
    expect(plan.balances[PENDING].toFixed(2)).toBe('0.00');
    expect(plan.balances[WITHDRAWABLE].toFixed(2)).toBe('2590000.00');
    expect(plan.balances[SETTLEMENT_HOLD].toFixed(2)).toBe('0.00');
  });

  it('refuses to take a bucket below zero, checked entry by entry', () => {
    const start = { ...emptyBalances(), [WITHDRAWABLE]: d('100.00') };
    expect(() =>
      planEntries(start, [
        { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: WITHDRAWABLE, amount: d('-100.01'), description: 'x' },
        { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount: d('100.01'), description: 'y' },
      ]),
    ).toThrow(InsufficientBalanceError);
    // A debit listed before the credit that would fund it is still refused.
    expect(() =>
      planEntries(emptyBalances(), [
        { type: WalletTransactionType.SETTLEMENT_PAYOUT, bucket: SETTLEMENT_HOLD, amount: d('-1.00'), description: 'x' },
        { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount: d('1.00'), description: 'y' },
      ]),
    ).toThrow(InsufficientBalanceError);
  });

  it('rejects zero amounts and sub-rial precision', () => {
    expect(() => planEntries(emptyBalances(), [{ type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('0'), description: 'x' }])).toThrow(/zero/);
    expect(() => planEntries(emptyBalances(), [{ type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('1.001'), description: 'x' }])).toThrow(/decimals/);
  });

  it('reconciles: the sum of signed amounts per bucket equals the balances', () => {
    const plan = planEntries(emptyBalances(), [
      { type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, bucket: PENDING, amount: d('500.00'), description: 'a' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: PENDING, amount: d('-500.00'), description: 'b' },
      { type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, bucket: WITHDRAWABLE, amount: d('500.00'), description: 'c' },
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: WITHDRAWABLE, amount: d('-300.00'), description: 'd' },
      { type: WalletTransactionType.SETTLEMENT_HOLD, bucket: SETTLEMENT_HOLD, amount: d('300.00'), description: 'e' },
      { type: WalletTransactionType.SETTLEMENT_PAYOUT, bucket: SETTLEMENT_HOLD, amount: d('-300.00'), description: 'f' },
    ]);
    const sums = sumByBucket(plan.entries);
    for (const bucket of [PENDING, WITHDRAWABLE, SETTLEMENT_HOLD]) {
      expect(sums[bucket].equals(plan.balances[bucket])).toBe(true);
    }
    expect(plan.balances[WITHDRAWABLE].toFixed(2)).toBe('200.00');
  });

  describe('escrowStateOf (net amount per bucket, order-independent)', () => {
    const E = '5550000.00';
    const row = (type: WalletTransactionType, bucket: WalletBalanceBucket, amount: string): EscrowRow => ({ type, bucket, amount: d(amount) });
    const { CREDIT_SALE_ESCROW_HOLD: HOLD, ESCROW_RELEASE_TO_WITHDRAWABLE: RELEASE, REFUND_DEDUCTION: REFUND, DISPUTE_HOLD_LOCK: LOCK, DISPUTE_HOLD_RELEASE: UNLOCK } = WalletTransactionType;
    const held = [row(HOLD, PENDING, E)];
    const released = [...held, row(RELEASE, PENDING, `-${E}`), row(RELEASE, WITHDRAWABLE, E)];
    const frozenFromPending = [...held, row(LOCK, PENDING, `-${E}`), row(LOCK, DISPUTE_HOLD, E)];

    it('covers the Phase 7 life cycle', () => {
      expect(escrowStateOf([])).toBe('NONE');
      expect(escrowStateOf(held)).toBe('HELD');
      expect(escrowStateOf(released)).toBe('RELEASED');
      expect(escrowStateOf([...held, row(REFUND, PENDING, `-${E}`)])).toBe('REVERSED');
      expect(escrowStateOf([...released, row(REFUND, WITHDRAWABLE, `-${E}`)])).toBe('REVERSED');
    });

    it('a dispute freezes the escrow; cancelling it returns to HELD; a vendor-favour decision releases it', () => {
      expect(escrowStateOf(frozenFromPending)).toBe('FROZEN');
      const cancelled = [...frozenFromPending, row(UNLOCK, DISPUTE_HOLD, `-${E}`), row(UNLOCK, PENDING, E)];
      expect(escrowStateOf(cancelled)).toBe('HELD');
      // a second dispute on the same package freezes it again
      expect(escrowStateOf([...cancelled, row(LOCK, PENDING, `-${E}`), row(LOCK, DISPUTE_HOLD, E)])).toBe('FROZEN');
      expect(escrowStateOf([...frozenFromPending, row(UNLOCK, DISPUTE_HOLD, `-${E}`), row(UNLOCK, WITHDRAWABLE, E)])).toBe('RELEASED');
    });

    it('freezing a delivered package takes from WITHDRAWABLE; a refund from the hold is terminal', () => {
      const frozenDelivered = [...released, row(LOCK, WITHDRAWABLE, '-1000000.00'), row(LOCK, DISPUTE_HOLD, '1000000.00')];
      expect(escrowStateOf(frozenDelivered)).toBe('FROZEN');
      expect(escrowStateOf([...frozenDelivered, row(REFUND, DISPUTE_HOLD, '-1000000.00')])).toBe('REVERSED');
    });

    it('does not depend on row order (rows of one transaction share a timestamp)', () => {
      expect(escrowStateOf([...frozenFromPending].reverse())).toBe('FROZEN');
      expect(escrowStateOf([...released].reverse())).toBe('RELEASED');
    });
  });
});
```

### `apps/backend/src/modules/wallet/wallet-math.ts`

```ts
import { Prisma, WalletBalanceBucket, type WalletTransactionType } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

/** Balance of every ledger bucket of one wallet. */
export type BucketBalances = Record<WalletBalanceBucket, Prisma.Decimal>;

/** One ledger movement in one bucket; `amount` is signed (negative = debit). */
export interface LedgerEntry {
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: Prisma.Decimal;
  subOrderId?: string | null;
  settlementRequestId?: string | null;
  disputeId?: string | null;
  description: string;
}

export interface PlannedEntry extends LedgerEntry {
  balanceAfter: Prisma.Decimal;
}

export interface LedgerPlan {
  balances: BucketBalances;
  entries: PlannedEntry[];
}

/** A bucket would go below zero; carries what was needed and what was there. */
export class InsufficientBalanceError extends Error {
  constructor(
    readonly bucket: WalletBalanceBucket,
    readonly available: Prisma.Decimal,
    readonly required: Prisma.Decimal,
  ) {
    super(`Insufficient ${bucket} balance: ${available.toFixed(2)} available, ${required.toFixed(2)} required`);
    this.name = 'InsufficientBalanceError';
  }
}

export function emptyBalances(): BucketBalances {
  return {
    [WalletBalanceBucket.PENDING]: ZERO,
    [WalletBalanceBucket.WITHDRAWABLE]: ZERO,
    [WalletBalanceBucket.SETTLEMENT_HOLD]: ZERO,
    [WalletBalanceBucket.DISPUTE_HOLD]: ZERO,
  };
}

/**
 * Applies entries in order and computes each row's `balanceAfter` (the balance
 * of that row's bucket). Pure: the caller persists the plan. Refuses zero
 * amounts, more than 2 decimals, and any bucket going negative — checked per
 * entry, so a debit cannot be "funded" by a credit listed after it.
 */
export function planEntries(current: BucketBalances, entries: readonly LedgerEntry[]): LedgerPlan {
  const balances: BucketBalances = { ...current };
  const planned: PlannedEntry[] = [];
  for (const entry of entries) {
    if (entry.amount.isZero()) {
      throw new Error(`Ledger entry ${entry.type}/${entry.bucket} has a zero amount`);
    }
    if (entry.amount.decimalPlaces() > 2) {
      throw new Error(`Ledger entry ${entry.type}/${entry.bucket} has more than 2 decimals`);
    }
    const after = balances[entry.bucket].plus(entry.amount);
    if (after.lessThan(0)) {
      throw new InsufficientBalanceError(entry.bucket, balances[entry.bucket], entry.amount.negated());
    }
    balances[entry.bucket] = after;
    planned.push({ ...entry, balanceAfter: after });
  }
  return { balances, entries: planned };
}

/** Sum of signed amounts per bucket — the reconciliation side of the invariant. */
export function sumByBucket(rows: ReadonlyArray<{ bucket: WalletBalanceBucket; amount: Prisma.Decimal }>): BucketBalances {
  const totals = emptyBalances();
  for (const row of rows) {
    totals[row.bucket] = totals[row.bucket].plus(row.amount);
  }
  return totals;
}

/**
 * Escrow position of one package, derived from its own ledger rows (the ledger
 * is the source of truth):
 *
 * - `NONE`     nothing was ever escrowed (unpaid, or zero earnings);
 * - `HELD`     the earnings sit in PENDING (paid, not delivered);
 * - `FROZEN`   the earnings sit in DISPUTE_HOLD (an open dispute, Phase 9);
 * - `RELEASED` the earnings left escrow to WITHDRAWABLE (delivered, or a dispute
 *              decided for the vendor);
 * - `REVERSED` the earnings were deducted by a refund (terminal).
 *
 * Computed from the **net** amount per bucket, not from row order: rows written
 * by one transaction share a timestamp, and a package can go HELD → FROZEN →
 * HELD (dispute cancelled) → FROZEN (new dispute) any number of times.
 */
export type EscrowState = 'NONE' | 'HELD' | 'FROZEN' | 'RELEASED' | 'REVERSED';

export interface EscrowRow {
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: Prisma.Decimal;
}

export function escrowStateOf(rows: ReadonlyArray<EscrowRow>): EscrowState {
  if (rows.some((row) => row.type === 'REFUND_DEDUCTION')) return 'REVERSED';
  if (!rows.some((row) => row.type === 'CREDIT_SALE_ESCROW_HOLD')) return 'NONE';
  const net = sumByBucket(rows);
  if (net[WalletBalanceBucket.DISPUTE_HOLD].greaterThan(0)) return 'FROZEN';
  if (net[WalletBalanceBucket.PENDING].greaterThan(0)) return 'HELD';
  return 'RELEASED';
}
```

### `apps/backend/src/modules/wallet/wallet.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import type { PaginatedWalletTransactionsDto, WalletSummaryDto, WalletTransactionQueryDto } from './dto/wallet.dto';
import { requireStore } from './vendor-store';

const ZERO = new Prisma.Decimal(0).toFixed(2);

/** Read side of the vendor wallet. Writes go through `WalletLedgerService` only. */
@Injectable()
export class WalletService {
  constructor(private readonly prisma: PrismaService) {}

  /** A store that never sold anything has no wallet row yet: all balances are zero. */
  async summaryForVendor(userId: string): Promise<WalletSummaryDto> {
    const store = await requireStore(this.prisma, userId);
    const wallet = await this.prisma.vendorWallet.findUnique({ where: { vendorId: store.id } });
    return {
      pendingBalance: wallet?.pendingBalance.toFixed(2) ?? ZERO,
      withdrawableBalance: wallet?.withdrawableBalance.toFixed(2) ?? ZERO,
      settlementHoldBalance: wallet?.settlementHoldBalance.toFixed(2) ?? ZERO,
      disputeHoldBalance: wallet?.disputeHoldBalance.toFixed(2) ?? ZERO,
      totalEarnedBalance: wallet?.totalEarnedBalance.toFixed(2) ?? ZERO,
      totalWithdrawnAmount: wallet?.totalWithdrawnAmount.toFixed(2) ?? ZERO,
      currency: 'IRR',
    };
  }

  async transactionsForVendor(userId: string, query: WalletTransactionQueryDto): Promise<PaginatedWalletTransactionsDto> {
    const store = await requireStore(this.prisma, userId);
    const where: Prisma.WalletTransactionWhereInput = {
      wallet: { vendorId: store.id },
      ...(query.type ? { type: query.type } : {}),
      ...(query.bucket ? { bucket: query.bucket } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.walletTransaction.count({ where }),
      this.prisma.walletTransaction.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          type: true,
          bucket: true,
          amount: true,
          balanceAfter: true,
          subOrderId: true,
          settlementRequestId: true,
          description: true,
          createdAt: true,
          subOrder: { select: { subOrderNumber: true } },
        },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        bucket: row.bucket,
        amount: row.amount.toFixed(2),
        balanceAfter: row.balanceAfter.toFixed(2),
        subOrderId: row.subOrderId,
        subOrderNumber: row.subOrder?.subOrderNumber ?? null,
        settlementRequestId: row.settlementRequestId,
        description: row.description,
        createdAt: row.createdAt,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }
}
```

### `apps/backend/src/setup/app.setup.ts`

```ts
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { GLOBAL_API_PREFIX, SWAGGER_JSON_PATH, SWAGGER_PATH } from '../common/constants';
import { buildCorsOptions } from '../config/cors.config';

/**
 * Applies the HTTP contract of the API: URL prefix, CORS policy and request
 * validation. Called from `main.ts` and from the end-to-end tests so both run
 * the exact same configuration.
 */
export function applyGlobalPolicies(app: INestApplication, config: ConfigService): void {
  app.setGlobalPrefix(GLOBAL_API_PREFIX);
  app.enableCors(buildCorsOptions(config));
  registerMultipart(app, config);

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties that carry no decorator, and reject the request when
      // unknown properties are present: clients get a loud error instead of
      // silently ignored input.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Convert plain payloads into DTO instances so decorators transform values.
      transform: true,
      validateCustomDecorators: true,
    }),
  );
}

/**
 * Registers `@fastify/multipart` so `POST /media/upload/*` can accept
 * `multipart/form-data`.
 *
 * The limits here are the transport-level guard: a request body larger than the
 * document ceiling is aborted while it is still being received, so an oversized
 * upload never consumes memory in the application. The media service applies the
 * stricter per-kind limits (5 MB images / 10 MB documents) afterwards, because at
 * this level the kind is not yet known.
 *
 * `files: 1` is deliberate — one file per request. A batch endpoint, if it is
 * ever needed, should be its own route with its own accounting.
 */
export function registerMultipart(app: INestApplication, config: ConfigService): void {
  const maxDocumentBytes = config.get<number>('MEDIA_MAX_DOCUMENT_BYTES') ?? 10_485_760;
  // `register` lives on the Fastify adapter; the app is always created with it.
  const fastifyApp = app as NestFastifyApplication;
  // `@fastify/multipart` types its plugin against its own copy of `fastify`, which
  // TypeScript treats as a distinct module instance from the one the Nest adapter
  // ships. The runtime contract is the standard Fastify plugin signature, so the
  // cast is a version-drift workaround, not a behaviour change.
  const plugin = multipart as unknown as Parameters<NestFastifyApplication['register']>[0];

  void fastifyApp.register(plugin, {
    limits: {
      fileSize: maxDocumentBytes,
      files: 1,
      fields: 10,
      fieldNameSize: 100,
      fieldSize: 4_096,
    },
    // Streams are not thrown away silently: the media service reads the whole
    // buffer and decides, so a truncated file fails magic-byte detection.
    throwFileSizeLimit: true,
  });
}

/**
 * Builds the OpenAPI document from the registered controllers. Kept separate
 * from {@link setupSwagger} because generating the document is pure routing
 * metadata, while serving the UI needs the Fastify static-assets plugin. Tests
 * assert the contract in-process without pulling in the plugin.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Shopino API')
      .setDescription(
        'Multi-vendor marketplace with banking credit (BNPL). Every endpoint is namespaced under /api/v1.\n\n' +
          '**Authentication:** the two anonymous entry points are `POST /api/v1/auth/otp/request` and ' +
          '`POST /api/v1/auth/login/password`, both of which return an access token (15 minutes) and a ' +
          'rotating refresh token (7 days). Send the access token as `Authorization: Bearer <token>`; ' +
          'every other endpoint rejects requests without it.',
      )
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token issued by /api/v1/auth/otp/verify or /api/v1/auth/login/password',
        },
        'access-token',
      )
      .addTag('auth', 'Authentication, sessions and self-service profile')
      .addTag('admin-users', 'Staff-only identity lookup and search')
      .addTag('admin-audit', 'Immutable audit trail (admins only)')
      .addTag('media', 'File uploads: images are converted to WebP, documents stay private')
      .addTag('vendors', 'Store onboarding, KYC submission and storefront profile')
      .addTag('admin-vendors', 'Store review: listing, full detail and the verification decision')
      .addTag('categories', 'Public category tree and category pages with breadcrumbs')
      .addTag('admin-categories', 'Category management and commission rates (admins only)')
      .addTag('products', 'Public catalogue search, filtering and product pages')
      .addTag('vendor-products', "A vendor's own products, variant matrix and stock")
      .addTag('admin-products', 'Staff product review and moderation')
      .addTag('customer-addresses', "A customer's address book (copied into orders at checkout)")
      .addTag('cart', 'Guest and account cart, grouped by store, with live stock and price checks')
      .addTag('orders', 'Checkout: one order, one package per store, stock reserved in one transaction')
      .addTag('customer-orders', "A customer's orders, tracking and cancellation of unpaid orders")
      .addTag('vendor-orders', "A store's paid packages and fulfilment status")
      .addTag('admin-orders', 'Staff order search and forced package resolutions')
      .addTag('payments', 'Card payment (IPG): initiate a payment and the public bank callback')
      .addTag('sandbox-payments', 'DEVELOPMENT ONLY — simulated bank page of the sandbox gateway (404 unless PAYMENT_GATEWAY_PROVIDER=sandbox)')
      .addTag('vendor-wallet', "A store's escrow wallet, ledger and settlement (payout) requests")
      .addTag('admin-settlements', 'Finance: review and pay out vendor settlement requests')
      .addTag('admin-financial', 'Finance: platform GMV, commission, escrow and settlement overview')
      .addTag('credit', 'Credit engine (BNPL): apply for a credit line, my credit account, instalment plans on offer')
      .addTag('credit-payments', 'Pay an order with bank credit (BANK_CREDIT) or credit + card (HYBRID)')
      .addTag('credit-installments', 'My instalments grouped by order, and paying an instalment by card')
      .addTag('admin-credit', 'Finance: credit applications, credit accounts and the aggregated credit exposure')
      .addTag('customer-disputes', 'Disputes: open a dispute about a package (escrow is frozen), follow it, cancel it')
      .addTag('vendor-disputes', 'Disputes against my store: read the complaint and evidence, accept the return or defend')
      .addTag('admin-disputes', 'Trust & Safety: dispute dossiers and arbitration with automatic financial resolution')
      .build(),
  );
}

/**
 * Publishes the OpenAPI document. The UI is served at `/api/docs` and the raw
 * document at `/api/docs-json`; neither is affected by the global API prefix.
 */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    customSiteTitle: 'Shopino API',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  return document;
}
```

### `apps/backend/test/disputes.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, DisputeEventType, Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { MAX_DISPUTES_PER_DAY } from '../src/modules/disputes/dispute-policy';
import { disputeOpenCountKey } from '../src/modules/disputes/disputes.service';
import { SETTLEMENT_MIN_AMOUNT_KEY } from '../src/modules/settlements/settlements.service';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 9 — disputes, evidence, the escrow freeze
 * (DISPUTE_HOLD) and arbitration with automatic financial resolution — against
 * the real PostgreSQL 16 and Redis 7 of docker-compose. Payments go through the
 * SANDBOX gateway exactly as a browser would; SMS through the SANDBOX provider.
 * Nothing is stubbed inside the API.
 *
 * Money (IRR), category commission 10%, platform shipping 450,000 per package:
 *   A1 2,000,000 → earnings 1,800,000
 *   B1 1,000,000 → earnings   900,000
 *   B2   300,000 → earnings   270,000
 *
 * Scenarios
 *   1. order1 = A1 + B1. Guards (unpaid, not yet accepted, ownership, roles, evidence).
 *   2. order1/A (PROCESSING): dispute freezes PENDING → DISPUTE_HOLD; transitions are
 *      blocked; the store ACCEPTS the return → REFUNDED, REFUND_DEDUCTION, restocked, SMS.
 *   3. order1/B (DELIVERED): freeze from WITHDRAWABLE; the store DEFENDS →
 *      UNDER_ARBITRATION; staff VENDOR_FAVOR → DELIVERED, released to WITHDRAWABLE.
 *   4. order2/A (SHIPPED): delivery confirmation refused while disputed; the customer
 *      cancels (hold back to PENDING, still SHIPPED), re-opens; staff BUYER_FAVOR without
 *      a returned item → REFUNDED, no restock.
 *   5. order3/B (DELIVERED) after store B moved most of its balance into a settlement:
 *      hold 500,000 + shortfall 400,000; later earnings of order4 (270,000) are used to
 *      recover part of the shortfall on BUYER_FAVOR; 130,000 stays unrecovered.
 */

const TEST_UA = 'shopino-disputes-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971170001';
const VENDOR_B_MOBILE = '+989971170002';
const CUSTOMER_MOBILE = '+989971170003';
const CUSTOMER_2_MOBILE = '+989971170004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE];
const IBAN_A = 'IR820540102680020817909002';
const IBAN_B = 'IR570629600000001003242001';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const SEEDED_FINANCE_EMAIL = 'finance@shopino.local';

interface HttpResult<T> {
  status: number;
  body: T;
}

interface ErrorBody {
  code?: string;
  message: string | string[];
  disputeId?: string;
}

interface Checkout {
  parentOrderId: string;
  subOrders: Array<{ id: string; store: { id: string } }>;
}

interface Wallet {
  pendingBalance: string;
  withdrawableBalance: string;
  settlementHoldBalance: string;
  disputeHoldBalance: string;
  totalEarnedBalance: string;
  totalWithdrawnAmount: string;
}

interface Dispute {
  id: string;
  status: string;
  reason: string;
  package: { subOrderId: string; status: string; storeName: string };
  subOrderStatusAtOpen: string;
  vendorResponse: { action: string; defenseNotes: string } | null;
  resolution: { outcome: string; decidedBy: string; refundAmount: string | null; restocked: boolean; itemReturned: boolean | null } | null;
  cancelledAt: string | null;
  evidence: Array<{ uploadedBy: string; fileUrl: string; fileType: string | null }>;
  timeline: Array<{ type: string; actorRole: string; fromStatus: string | null; toStatus: string | null }>;
}

interface VendorDispute extends Dispute {
  customerName: string;
  customerMobileMasked: string;
  hold: { source: string | null; amount: string; shortfall: string; unrecovered: string };
}

interface Dossier extends VendorDispute {
  customer: { userId: string; mobile: string };
  order: { orderNumber: string; paymentStatus: string };
  items: Array<{ sku: string; quantity: number }>;
  packageHistory: Array<{ toStatus: string }>;
  payments: Array<{ status: string; cashAmount: string }>;
  vendorWallet: Wallet;
  vendorEarningsAmount: string;
}

interface ActionResult {
  dispute: Dispute;
  walletAction: string;
  subOrderStatus: string;
  stockAction: string;
}

interface Page<T> {
  items: T[];
  total: number;
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

describe('Phase 9 — disputes, escrow freeze and arbitration (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;

  let adminToken: string;
  let supportToken: string;
  let financeToken: string;
  let vendorA: { token: string; userId: string; vendorId: string };
  let vendorB: { token: string; userId: string; vendorId: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };
  let categoryId: string;
  let addressId: string;
  const v: Record<'A1' | 'B1' | 'B2', string> = {} as never;
  let savedConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];
  const paymentIds: string[] = [];

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH'; token?: string; body?: unknown; form?: Record<string, string> } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let payload: string | undefined;
    if (options.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(options.form).toString();
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({ method: options.method ?? 'GET', url: url.startsWith(API) ? url : `${API}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
    const isJson = String(response.headers['content-type'] ?? '').includes('application/json');
    return { status: response.statusCode, body: (isJson && response.body.length > 0 ? JSON.parse(response.body) : response.body) as T };
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  /** Uploads a private PDF through the real media route and returns its canonical download url. */
  const uploadDocument = async (token: string, purpose: string, label: string): Promise<string> => {
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% disputes e2e ${RUN} ${label}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), `${label}.pdf`);
    form.append('purpose', purpose);
    const serialized = new Response(form);
    const uploaded = await app.inject({
      method: 'POST',
      url: `${API}/media/upload/document`,
      headers: { authorization: `Bearer ${token}`, 'user-agent': TEST_UA, 'content-type': serialized.headers.get('content-type') ?? '' },
      payload: Buffer.from(await serialized.arrayBuffer()),
    });
    expect(uploaded.statusCode).toBe(201);
    return (JSON.parse(uploaded.body) as { url: string }).url;
  };

  const onboardStore = async (login: { token: string }, storeSlug: string, iban: string): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: { storeName: `فروشگاه آزمون اختلاف ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون فاز نه', bankIban: iban, bankAccountHolder: 'شرکت آزمون اختلاف' },
    });
    expect(registered.status).toBe(201);
    const nationalIdCardUrl = await uploadDocument(login.token, 'kyc_national_id', 'national-id');
    expect((await request('/vendors/verification/documents', { method: 'POST', token: login.token, body: { nationalIdCardUrl } })).status).toBe(200);
    const verified = await request(`/admin/vendors/${registered.body.id}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null, commissionRateOverride: null },
    });
    expect(verified.status).toBe(200);
    return registered.body.id;
  };

  const createProduct = async (token: string, title: string, sku: string, price: number): Promise<string> => {
    const response = await request<{ variants: Array<{ id: string }> }>('/vendor/products', {
      method: 'POST',
      token,
      body: { title, categoryId, basePrice: price, isPublished: true, variants: [{ sku, price, stockQuantity: 20 }] },
    });
    expect(response.status).toBe(201);
    return response.body.variants[0]!.id;
  };

  const placeOrder = async (lines: Array<[string, number]>): Promise<Checkout> => {
    expect((await request('/cart/clear', { method: 'POST', token: customer.token })).status).toBe(200);
    for (const [productVariantId, quantity] of lines) {
      expect((await request('/cart/items', { method: 'POST', token: customer.token, body: { productVariantId, quantity } })).status).toBe(200);
    }
    const placed = await request<Checkout>('/orders/checkout', { method: 'POST', token: customer.token, body: { addressId } });
    expect(placed.status).toBe(201);
    return placed.body;
  };

  const pay = async (parentOrderId: string): Promise<void> => {
    const initiated = await request<{ paymentId: string }>('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId } });
    expect(initiated.status).toBe(201);
    paymentIds.push(initiated.body.paymentId);
    const decision = await app.inject({
      method: 'POST',
      url: `${API}/sandbox/payment-page/${initiated.body.paymentId}/decision`,
      headers: { 'user-agent': TEST_UA, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ decision: 'PAY' }).toString(),
    });
    expect(decision.statusCode).toBe(303);
    const location = new URL(String(decision.headers['location']));
    const outcome = await request<{ outcome: string }>(`${location.pathname}${location.search}`);
    expect(outcome.body.outcome).toBe('PAID');
  };

  const subOf = (order: Checkout, vendorId: string): string => order.subOrders.find((sub) => sub.store.id === vendorId)!.id;

  const vendorStatus = (token: string, subId: string, status: 'PROCESSING' | 'SHIPPED'): Promise<HttpResult<ErrorBody>> =>
    request<ErrorBody>(`/vendor/orders/${subId}/status`, {
      method: 'PATCH',
      token,
      body: status === 'SHIPPED' ? { status, trackingCode: `TRK-${TAG}-${subId.slice(0, 6)}`, shippingCarrier: 'پست پیشتاز' } : { status },
    });

  const confirmDelivery = (order: Checkout, subId: string): Promise<HttpResult<ErrorBody>> =>
    request<ErrorBody>(`/customer/orders/${order.parentOrderId}/sub-orders/${subId}/confirm-delivery`, { method: 'POST', token: customer.token });

  const deliver = async (order: Checkout, subId: string, token: string): Promise<void> => {
    expect((await vendorStatus(token, subId, 'PROCESSING')).status).toBe(200);
    expect((await vendorStatus(token, subId, 'SHIPPED')).status).toBe(200);
    expect((await confirmDelivery(order, subId)).status).toBe(200);
  };

  const wallet = async (token: string): Promise<Wallet> => {
    const response = await request<Wallet>('/vendor/wallet', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  const openDispute = (body: Record<string, unknown>, token = customer.token): Promise<HttpResult<ActionResult & ErrorBody>> =>
    request<ActionResult & ErrorBody>('/customer/disputes', { method: 'POST', token, body });

  const stockOf = async (variantId: string): Promise<number> =>
    (await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true } })).stockQuantity;

  /**
   * The TM invariant, checked on the live rows: earned = withdrawn + withdrawable +
   * settlementHold + disputeHold, and every balance column equals the SUM of its ledger rows.
   */
  const expectInvariants = async (vendorId: string): Promise<void> => {
    const w = await prisma.vendorWallet.findUniqueOrThrow({ where: { vendorId } });
    expect(w.totalEarnedBalance.toFixed(2)).toBe(w.totalWithdrawnAmount.plus(w.withdrawableBalance).plus(w.settlementHoldBalance).plus(w.disputeHoldBalance).toFixed(2));
    const rows = await prisma.walletTransaction.findMany({ where: { walletId: w.id } });
    const columns: Record<WalletBalanceBucket, Prisma.Decimal> = {
      PENDING: w.pendingBalance,
      WITHDRAWABLE: w.withdrawableBalance,
      SETTLEMENT_HOLD: w.settlementHoldBalance,
      DISPUTE_HOLD: w.disputeHoldBalance,
    };
    for (const bucket of Object.values(WalletBalanceBucket)) {
      const sum = rows.filter((row) => row.bucket === bucket).reduce((acc, row) => acc.plus(row.amount), d(0));
      expect({ bucket, sum: sum.toFixed(2) }).toEqual({ bucket, sum: columns[bucket].toFixed(2) });
    }
  };

  const disputeLedger = (disputeId: string): Promise<Array<{ type: WalletTransactionType; bucket: WalletBalanceBucket; amount: Prisma.Decimal }>> =>
    prisma.walletTransaction.findMany({ where: { disputeId }, select: { type: true, bucket: true, amount: true }, orderBy: [{ createdAt: 'asc' }, { amount: 'asc' }] });

  const setConfig = async (key: string, value: string): Promise<void> => {
    await prisma.systemConfig.upsert({ where: { key }, update: { value }, create: { key, value, valueType: 'NUMBER', description: `disputes e2e ${RUN}` } });
  };

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    await resetRedisKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);
    financeToken = await loginWithPassword(SEEDED_FINANCE_EMAIL, staffPassword);

    const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), SETTLEMENT_MIN_AMOUNT_KEY];
    savedConfigs = (await prisma.systemConfig.findMany({ where: { key: { in: configKeys } }, select: { key: true, value: true, valueType: true, description: true } })) as never;
    await setConfig(SHIPPING_CONFIG_KEYS.defaultFeePerVendor, '450000');
    await setConfig(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, '20000000');
    await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '100000.00');

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-dsp-${RUN}`, titleFa: `دسته آزمون اختلاف ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    await prisma.user.update({ where: { id: customer.userId }, data: { fullName: 'مشتری آزمون اختلاف' } });
    vendorA = { ...a, vendorId: await onboardStore(a, `dsp-e2e-a-${RUN}`, IBAN_A) };
    vendorB = { ...b, vendorId: await onboardStore(b, `dsp-e2e-b-${RUN}`, IBAN_B) };
    v.A1 = await createProduct(vendorA.token, `گوشی آزمون اختلاف ${RUN}`, `DSP-${TAG}-A1`, 2_000_000);
    v.B1 = await createProduct(vendorB.token, `هدفون آزمون اختلاف ${RUN}`, `DSP-${TAG}-B1`, 1_000_000);
    v.B2 = await createProduct(vendorB.token, `کابل آزمون اختلاف ${RUN}`, `DSP-${TAG}-B2`, 300_000);

    const address = await request<{ id: string }>('/customer/addresses', {
      method: 'POST',
      token: customer.token,
      body: {
        province: 'تهران',
        city: 'تهران',
        postalAddress: 'خیابان انقلاب، پلاک ۹',
        postalCode: '1458889999',
        buildingNumber: '9',
        unitNumber: '1',
        recipientName: 'مشتری آزمون اختلاف',
        recipientMobile: '09971170003',
      },
    });
    expect(address.status).toBe(201);
    addressId = address.body.id;
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const orders = await prisma.parentOrder.findMany({ where: { userId: { in: userIds } }, select: { id: true, subOrders: { select: { id: true } } } });
      const orderIds = orders.map((row) => row.id);
      const subIds = orders.flatMap((row) => row.subOrders.map((sub) => sub.id));
      const disputes = await prisma.dispute.findMany({ where: { OR: [{ vendorId: { in: vendorIds } }, { raisedByUserId: { in: userIds } }] }, select: { id: true } });
      const payments = await prisma.payment.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true } });
      const settlements = await prisma.settlementRequest.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const entityIds = [
        ...vendorIds,
        ...productIds,
        ...variantIds,
        ...orderIds,
        ...subIds,
        ...disputes.map((row) => row.id),
        ...payments.map((row) => row.id),
        ...settlements.map((row) => row.id),
        categoryId,
      ];

      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: entityIds.filter(Boolean) } }] } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } }); // cascades to the ledger
      await prisma.settlementRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.dispute.deleteMany({ where: { id: { in: disputes.map((row) => row.id) } } }); // cascades to evidence and events
      await prisma.payment.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.cart.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { items: { some: { productVariantId: { in: variantIds } } } }] } });
      await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      if (categoryId !== undefined) await prisma.category.deleteMany({ where: { id: categoryId } });

      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true } });
      for (const asset of assets) await storage.delete(asset.path).catch(() => false);
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await prisma.systemConfig.deleteMany({ where: { key: { in: [...Object.values(SHIPPING_CONFIG_KEYS), SETTLEMENT_MIN_AMOUNT_KEY] } } });
      for (const row of savedConfigs) await prisma.systemConfig.create({ data: row });
      await app.get(CategoriesService).invalidateTree();

      const redis = app.get(RedisService);
      for (const paymentId of paymentIds) {
        const authority = await redis.client.get(`payment:sandbox:payment:${paymentId}`);
        await redis.client.del(`payment:sandbox:payment:${paymentId}`, ...(authority ? [`payment:sandbox:session:${authority}`] : []));
      }
      await resetRedisKeys(userIds);
    }
    await app?.close();
  }, 120_000);

  async function resetRedisKeys(userIds: string[] = []): Promise<void> {
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
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL, SEEDED_FINANCE_EMAIL].flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
      ...userIds.map((id) => disputeOpenCountKey(id)),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  // ─── 1. guards ─────────────────────────────────────────────────────────────

  let order1: Checkout;
  let subA1: string;
  let subB1: string;
  let evidenceUrl: string;

  describe('opening: ownership, order state, reason and evidence', () => {
    beforeAll(async () => {
      order1 = await placeOrder([
        [v.A1, 1],
        [v.B1, 1],
      ]);
      subA1 = subOf(order1, vendorA.vendorId);
      subB1 = subOf(order1, vendorB.vendorId);
      evidenceUrl = await uploadDocument(customer.token, 'dispute_evidence', 'cracked-screen');
    });

    const valid = (): Record<string, unknown> => ({
      subOrderId: subA1,
      reason: 'DAMAGED',
      description: 'The screen arrived cracked and the box was dented on one corner.',
      evidenceUrls: [evidenceUrl],
    });

    it('requires a customer token', async () => {
      expect((await request('/customer/disputes', { method: 'POST', body: valid() })).status).toBe(401);
      expect((await openDispute(valid(), vendorA.token)).status).toBe(403);
      expect((await openDispute(valid(), supportToken)).status).toBe(403);
    });

    it('refuses packages of unpaid orders, then packages the store has not accepted yet', async () => {
      const unpaid = await openDispute(valid());
      expect(unpaid.status).toBe(409);
      expect(unpaid.body.code).toBe('ORDER_NOT_PAID');

      await pay(order1.parentOrderId);
      const pending = await openDispute(valid());
      expect(pending.status).toBe(409);
      expect(pending.body.code).toBe('SUB_ORDER_NOT_DISPUTABLE');
    });

    it('hides other customers’ packages (404) and validates the body', async () => {
      expect((await openDispute(valid(), customer2.token)).status).toBe(404);
      expect((await openDispute({ ...valid(), reason: 'CHANGED_MY_MIND' })).status).toBe(400);
      expect((await openDispute({ ...valid(), description: 'too short' })).status).toBe(400);
      expect((await openDispute({ ...valid(), subOrderId: 'not-a-uuid' })).status).toBe(400);
      expect((await openDispute({ ...valid(), evidenceUrls: ['https://evil.example/photo.jpg'] })).status).toBe(400);
      expect((await openDispute({ ...valid(), evidenceUrls: undefined })).status).toBe(400);
    });

    it('accepts only the caller’s own dispute_evidence uploads as evidence', async () => {
      expect((await vendorStatus(vendorA.token, subA1, 'PROCESSING')).status).toBe(200);
      const foreign = await uploadDocument(customer2.token, 'dispute_evidence', 'someone-else');
      const kyc = await uploadDocument(customer.token, 'kyc_national_id', 'my-id-card');
      for (const url of [foreign, kyc]) {
        const response = await openDispute({ ...valid(), evidenceUrls: [url] });
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('EVIDENCE_NOT_ACCEPTED');
      }
      expect(await prisma.dispute.count({ where: { subOrderId: subA1 } })).toBe(0);
    });

    it(`limits a customer to ${MAX_DISPUTES_PER_DAY} dispute attempts per day (429, Redis counter)`, async () => {
      const redis = app.get(RedisService);
      const key = disputeOpenCountKey(customer.userId);
      await redis.client.set(key, String(MAX_DISPUTES_PER_DAY), 'EX', 60);
      const limited = await openDispute(valid());
      expect(limited.status).toBe(429);
      await redis.client.del(key);
      expect(await prisma.dispute.count({ where: { subOrderId: subA1 } })).toBe(0);
    });
  });

  // ─── 2. PROCESSING → store accepts the return ──────────────────────────────

  describe('not-yet-shipped package: freeze, blocked transitions, store accepts the return', () => {
    let disputeId: string;
    let stockBefore: number;

    it('opens the dispute and freezes the escrow PENDING → DISPUTE_HOLD in the same transaction', async () => {
      const before = await wallet(vendorA.token);
      expect(before.pendingBalance).toBe('1800000.00');
      stockBefore = await stockOf(v.A1);

      const opened = await openDispute({ subOrderId: subA1, reason: 'DAMAGED', description: 'The screen arrived cracked and the box was dented on one corner.', evidenceUrls: [evidenceUrl] });
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({ walletAction: 'FROZEN', subOrderStatus: 'PROCESSING', stockAction: 'NONE' });
      expect(opened.body.dispute).toMatchObject({ status: 'OPEN', reason: 'DAMAGED', subOrderStatusAtOpen: 'PROCESSING', vendorResponse: null, resolution: null });
      expect(opened.body.dispute.evidence).toEqual([expect.objectContaining({ uploadedBy: 'CUSTOMER', fileUrl: evidenceUrl, fileType: 'application/pdf' })]);
      expect(opened.body.dispute.timeline.map((event) => event.type)).toEqual([DisputeEventType.OPENED]);
      disputeId = opened.body.dispute.id;

      const after = await wallet(vendorA.token);
      expect(after).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '1800000.00', totalEarnedBalance: '1800000.00', withdrawableBalance: '0.00' });
      const rows = await disputeLedger(disputeId);
      expect(rows.map((row) => [row.type, row.bucket, row.amount.toFixed(2)])).toEqual(
        expect.arrayContaining([
          [WalletTransactionType.DISPUTE_HOLD_LOCK, WalletBalanceBucket.PENDING, '-1800000.00'],
          [WalletTransactionType.DISPUTE_HOLD_LOCK, WalletBalanceBucket.DISPUTE_HOLD, '1800000.00'],
        ]),
      );
      await expectInvariants(vendorA.vendorId);
      const audit = await prisma.auditLog.findFirst({ where: { entityName: 'Dispute', entityId: disputeId, action: AuditAction.CREATE } });
      expect(audit?.userId).toBe(customer.userId);
    });

    it('allows one active dispute per package', async () => {
      const again = await openDispute({ subOrderId: subA1, reason: 'WRONG_ITEM', description: 'Trying to open a second dispute on the same package.', evidenceUrls: [] });
      expect(again.status).toBe(409);
      expect(again.body).toMatchObject({ code: 'DISPUTE_ALREADY_ACTIVE', disputeId });
    });

    it('blocks every status change of the disputed package (409 SUB_ORDER_UNDER_DISPUTE)', async () => {
      const ship = await vendorStatus(vendorA.token, subA1, 'SHIPPED');
      expect(ship.status).toBe(409);
      expect(ship.body.code).toBe('SUB_ORDER_UNDER_DISPUTE');
      const forced = await request<ErrorBody>(`/admin/sub-orders/${subA1}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'تحویل دستی حین اختلاف' } });
      expect(forced.status).toBe(409);
      expect(forced.body.code).toBe('SUB_ORDER_UNDER_DISPUTE');
      expect((await wallet(vendorA.token)).disputeHoldBalance).toBe('1800000.00');
    });

    it('shows the dispute to its customer and its store only; the store may read the buyer’s evidence', async () => {
      const mine = await request<Page<Dispute>>('/customer/disputes', { token: customer.token });
      expect(mine.status).toBe(200);
      expect(mine.body.items.map((item) => item.id)).toContain(disputeId);
      expect((await request<Page<Dispute>>('/customer/disputes', { token: customer2.token })).body.total).toBe(0);
      expect((await request(`/customer/disputes/${disputeId}`, { token: customer2.token })).status).toBe(404);
      expect((await request(`/vendor/disputes/${disputeId}`, { token: vendorB.token })).status).toBe(404);
      expect((await request(`/customer/disputes/${disputeId}`, { token: vendorA.token })).status).toBe(403);

      const forStore = await request<VendorDispute>(`/vendor/disputes/${disputeId}`, { token: vendorA.token });
      expect(forStore.status).toBe(200);
      expect(forStore.body.customerMobileMasked).toBe('+98997***0003');
      expect(forStore.body.customerName).toBe('مشتری آزمون اختلاف');
      expect(forStore.body.hold).toEqual({ source: 'PENDING', amount: '1800000.00', shortfall: '0.00', unrecovered: '0.00' });
      expect((await request<Page<VendorDispute>>('/vendor/disputes?status=OPEN', { token: vendorA.token })).body.items.map((item) => item.id)).toContain(disputeId);

      expect((await request(evidenceUrl, { token: vendorA.token })).status).toBe(200);
      expect((await request(evidenceUrl, { token: vendorB.token })).status).toBe(403);
      expect((await request(evidenceUrl, { token: customer2.token })).status).toBe(403);
    });

    it('refuses arbitration to customers, stores, finance officers and anonymous callers', async () => {
      const body = { decision: 'BUYER_FAVOR', resolutionNotes: 'Not allowed to decide this dispute.' };
      expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', body })).status).toBe(401);
      for (const token of [customer.token, vendorA.token, vendorB.token, financeToken]) {
        expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token, body })).status).toBe(403);
      }
      expect((await request(`/admin/disputes/${disputeId}`, { token: vendorA.token })).status).toBe(403);
      expect((await request(`/vendor/disputes/${disputeId}/respond`, { method: 'POST', token: vendorB.token, body: { action: 'ACCEPT_RETURN', defenseNotes: 'Not my store at all.' } })).status).toBe(404);
    });

    it('store ACCEPT_RETURN resolves for the buyer: REFUNDED, REFUND_DEDUCTION from the hold, restocked, refund notice', async () => {
      const accepted = await request<ActionResult>(`/vendor/disputes/${disputeId}/respond`, {
        method: 'POST',
        token: vendorA.token,
        body: { action: 'ACCEPT_RETURN', defenseNotes: 'We accept; the item will be collected and refunded.' },
      });
      expect(accepted.status).toBe(200);
      expect(accepted.body).toMatchObject({ walletAction: 'REFUNDED', subOrderStatus: 'REFUNDED', stockAction: 'RESTOCKED' });
      expect(accepted.body.dispute).toMatchObject({
        status: 'RESOLVED_BUYER_FAVOR',
        vendorResponse: { action: 'ACCEPT_RETURN' },
        resolution: { outcome: 'RESOLVED_BUYER_FAVOR', decidedBy: 'VENDOR', refundAmount: '2450000.00', restocked: true },
      });
      expect(await stockOf(v.A1)).toBe(stockBefore + 1);

      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '0.00', withdrawableBalance: '0.00', totalEarnedBalance: '0.00' });
      const rows = await disputeLedger(disputeId);
      expect(rows.map((row) => [row.type, row.bucket, row.amount.toFixed(2)])).toContainEqual([WalletTransactionType.REFUND_DEDUCTION, WalletBalanceBucket.DISPUTE_HOLD, '-1800000.00']);
      await expectInvariants(vendorA.vendorId);

      const sub = await prisma.subOrder.findUniqueOrThrow({ where: { id: subA1 }, select: { status: true } });
      expect(sub.status).toBe('REFUNDED');
      const audits = await prisma.auditLog.findMany({ where: { action: AuditAction.DISPUTE_RESOLUTION, entityId: { in: [disputeId, subA1] } } });
      expect(audits.map((row) => row.entityName).sort()).toEqual(['Dispute', 'SubOrder']);

      const detail = await request<Dispute>(`/customer/disputes/${disputeId}`, { token: customer.token });
      expect(detail.body.timeline.map((event) => event.type)).toEqual([DisputeEventType.OPENED, DisputeEventType.VENDOR_ACCEPTED_RETURN, DisputeEventType.REFUND_NOTICE_SENT]);
    });

    it('a decided dispute cannot be answered again and its package cannot be disputed again', async () => {
      const again = await request<ErrorBody>(`/vendor/disputes/${disputeId}/respond`, { method: 'POST', token: vendorA.token, body: { action: 'REJECT_WITH_DEFENSE', defenseNotes: 'Changed our mind about this.' } });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DISPUTE_NOT_AWAITING_VENDOR');
      const reopen = await openDispute({ subOrderId: subA1, reason: 'DAMAGED', description: 'Trying to reopen an already refunded package.', evidenceUrls: [] });
      expect(reopen.status).toBe(409);
      expect(reopen.body.code).toBe('SUB_ORDER_NOT_DISPUTABLE');
    });
  });

  // ─── 3. DELIVERED → store defends → staff VENDOR_FAVOR ─────────────────────

  describe('delivered package: freeze from WITHDRAWABLE, store defends, staff decides for the store', () => {
    let disputeId: string;

    it('freezes the already released earnings (WITHDRAWABLE → DISPUTE_HOLD)', async () => {
      await deliver(order1, subB1, vendorB.token);
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '900000.00', totalEarnedBalance: '900000.00' });

      const opened = await openDispute({ subOrderId: subB1, reason: 'NOT_AS_DESCRIBED', description: 'The headphones are wired, the listing said wireless.', evidenceUrls: [] });
      expect(opened.status).toBe(201);
      expect(opened.body).toMatchObject({ walletAction: 'FROZEN', subOrderStatus: 'DELIVERED' });
      disputeId = opened.body.dispute.id;
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '0.00', disputeHoldBalance: '900000.00', totalEarnedBalance: '900000.00' });
      await expectInvariants(vendorB.vendorId);
    });

    it('store REJECT_WITH_DEFENSE with its own evidence → UNDER_ARBITRATION', async () => {
      const storeEvidence = await uploadDocument(vendorB.token, 'dispute_evidence', 'listing-screenshot');
      const defended = await request<ActionResult>(`/vendor/disputes/${disputeId}/respond`, {
        method: 'POST',
        token: vendorB.token,
        body: { action: 'REJECT_WITH_DEFENSE', defenseNotes: 'The listing clearly says wired; see the screenshot.', evidenceUrls: [storeEvidence] },
      });
      expect(defended.status).toBe(200);
      expect(defended.body).toMatchObject({ walletAction: 'NONE', subOrderStatus: 'DELIVERED' });
      expect(defended.body.dispute).toMatchObject({ status: 'UNDER_ARBITRATION', vendorResponse: { action: 'REJECT_WITH_DEFENSE' } });
      expect(defended.body.dispute.evidence.map((item) => item.uploadedBy)).toEqual(['VENDOR']);
      expect((await request(storeEvidence, { token: customer.token })).status).toBe(200);
      expect(await wallet(vendorB.token)).toMatchObject({ disputeHoldBalance: '900000.00' });
    });

    it('gives staff the full dossier', async () => {
      const dossier = await request<Dossier>(`/admin/disputes/${disputeId}`, { token: supportToken });
      expect(dossier.status).toBe(200);
      expect(dossier.body).toMatchObject({
        status: 'UNDER_ARBITRATION',
        customer: { userId: customer.userId, mobile: CUSTOMER_MOBILE },
        order: { paymentStatus: 'PAID' },
        hold: { source: 'WITHDRAWABLE', amount: '900000.00', shortfall: '0.00' },
        vendorWallet: { disputeHoldBalance: '900000.00' },
        vendorEarningsAmount: '900000.00',
      });
      expect(dossier.body.items).toEqual([expect.objectContaining({ sku: `DSP-${TAG}-B1`, quantity: 1 })]);
      expect(dossier.body.packageHistory.map((entry) => entry.toStatus)).toEqual(expect.arrayContaining(['PROCESSING', 'SHIPPED', 'DELIVERED']));
      expect(dossier.body.payments).toEqual([expect.objectContaining({ status: 'SUCCESSFUL' })]);
      const listed = await request<Page<VendorDispute>>(`/admin/disputes?status=UNDER_ARBITRATION&vendorId=${vendorB.vendorId}`, { token: adminToken });
      expect(listed.body.items.map((item) => item.id)).toEqual([disputeId]);
      expect((await request('/admin/disputes?status=NOPE', { token: adminToken })).status).toBe(400);
    });

    it('validates the arbitration body', async () => {
      expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token: supportToken, body: { decision: 'SPLIT', resolutionNotes: 'Half and half for both.' } })).status).toBe(400);
      expect((await request(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token: supportToken, body: { decision: 'VENDOR_FAVOR', resolutionNotes: 'short' } })).status).toBe(400);
    });

    it('VENDOR_FAVOR: package DELIVERED, hold released to WITHDRAWABLE (DISPUTE_HOLD_RELEASE), audited', async () => {
      const decided = await request<ActionResult>(`/admin/disputes/${disputeId}/arbitrate`, {
        method: 'POST',
        token: supportToken,
        body: { decision: 'VENDOR_FAVOR', resolutionNotes: 'The listing matches the delivered item.' },
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ walletAction: 'RELEASED_TO_WITHDRAWABLE', subOrderStatus: 'DELIVERED', stockAction: 'NONE' });
      expect(decided.body.dispute).toMatchObject({ status: 'RESOLVED_VENDOR_FAVOR', resolution: { decidedBy: 'STAFF', refundAmount: null } });
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '900000.00', disputeHoldBalance: '0.00', totalEarnedBalance: '900000.00' });
      const rows = await disputeLedger(disputeId);
      expect(rows.map((row) => [row.type, row.bucket, row.amount.toFixed(2)])).toEqual(
        expect.arrayContaining([
          [WalletTransactionType.DISPUTE_HOLD_RELEASE, WalletBalanceBucket.DISPUTE_HOLD, '-900000.00'],
          [WalletTransactionType.DISPUTE_HOLD_RELEASE, WalletBalanceBucket.WITHDRAWABLE, '900000.00'],
        ]),
      );
      await expectInvariants(vendorB.vendorId);
      const sub = await prisma.subOrder.findUniqueOrThrow({ where: { id: subB1 }, select: { status: true, escrowReleasedAt: true } });
      expect(sub.status).toBe('DELIVERED');
      expect(sub.escrowReleasedAt).not.toBeNull();
      const audit = await prisma.auditLog.findFirst({ where: { action: AuditAction.DISPUTE_RESOLUTION, entityName: 'Dispute', entityId: disputeId } });
      expect(audit).not.toBeNull();
    });

    it('a decided dispute cannot be arbitrated again, and the package cannot be disputed again', async () => {
      const again = await request<ErrorBody>(`/admin/disputes/${disputeId}/arbitrate`, { method: 'POST', token: adminToken, body: { decision: 'BUYER_FAVOR', resolutionNotes: 'Second thoughts on this one.' } });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('DISPUTE_ALREADY_CLOSED');
      const reopen = await openDispute({ subOrderId: subB1, reason: 'COUNTERFEIT', description: 'Now I think these headphones are counterfeit.', evidenceUrls: [] });
      expect(reopen.status).toBe(409);
      expect(reopen.body).toMatchObject({ code: 'DISPUTE_ALREADY_DECIDED', disputeId });
    });
  });

  // ─── 4. SHIPPED: cancel, re-open, staff BUYER_FAVOR without return ─────────

  describe('shipped package: delivery blocked, customer cancels and re-opens, staff decides for the buyer', () => {
    let order2: Checkout;
    let subA2: string;
    let firstId: string;
    let secondId: string;

    beforeAll(async () => {
      order2 = await placeOrder([[v.A1, 1]]);
      subA2 = subOf(order2, vendorA.vendorId);
      await pay(order2.parentOrderId);
      expect((await vendorStatus(vendorA.token, subA2, 'PROCESSING')).status).toBe(200);
      expect((await vendorStatus(vendorA.token, subA2, 'SHIPPED')).status).toBe(200);
    });

    it('delivery confirmation cannot release escrow while the dispute is active', async () => {
      const opened = await openDispute({ subOrderId: subA2, reason: 'NOT_DELIVERED', description: 'Tracking says delivered but nothing arrived at my door.', evidenceUrls: [] });
      expect(opened.status).toBe(201);
      firstId = opened.body.dispute.id;
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '1800000.00' });

      const confirm = await confirmDelivery(order2, subA2);
      expect(confirm.status).toBe(409);
      expect(confirm.body.code).toBe('SUB_ORDER_UNDER_DISPUTE');
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '0.00', disputeHoldBalance: '1800000.00' });
    });

    it('customer cancel returns the hold to escrow PENDING; the package stays SHIPPED', async () => {
      expect((await request(`/customer/disputes/${firstId}/cancel`, { method: 'POST', token: customer2.token, body: {} })).status).toBe(404);
      const cancelled = await request<ActionResult>(`/customer/disputes/${firstId}/cancel`, { method: 'POST', token: customer.token, body: { reason: 'The parcel was at the neighbour.' } });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ walletAction: 'RETURNED_TO_ESCROW', subOrderStatus: 'SHIPPED' });
      expect(cancelled.body.dispute.status).toBe('CANCELLED');
      expect(cancelled.body.dispute.cancelledAt).not.toBeNull();
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '1800000.00', disputeHoldBalance: '0.00', totalEarnedBalance: '0.00' });
      await expectInvariants(vendorA.vendorId);

      const twice = await request<ErrorBody>(`/customer/disputes/${firstId}/cancel`, { method: 'POST', token: customer.token, body: {} });
      expect(twice.status).toBe(409);
      expect(twice.body.code).toBe('DISPUTE_NOT_CANCELLABLE');
    });

    it('a cancelled dispute does not block a new one', async () => {
      const reopened = await openDispute({ subOrderId: subA2, reason: 'WRONG_ITEM', description: 'The parcel finally came but holds a different phone model.', evidenceUrls: [] });
      expect(reopened.status).toBe(201);
      secondId = reopened.body.dispute.id;
      expect(secondId).not.toBe(firstId);
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '1800000.00' });
    });

    it('staff BUYER_FAVOR without a returned item: REFUNDED, deducted, stock untouched', async () => {
      const stockBefore = await stockOf(v.A1);
      const decided = await request<ActionResult>(`/admin/disputes/${secondId}/arbitrate`, {
        method: 'POST',
        token: adminToken,
        body: { decision: 'BUYER_FAVOR', resolutionNotes: 'Carrier photo shows a different model.', itemReturned: false },
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ walletAction: 'REFUNDED', subOrderStatus: 'REFUNDED', stockAction: 'NONE' });
      expect(decided.body.dispute.resolution).toMatchObject({ decidedBy: 'STAFF', refundAmount: '2450000.00', restocked: false, itemReturned: false });
      expect(await stockOf(v.A1)).toBe(stockBefore);
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', disputeHoldBalance: '0.00', totalEarnedBalance: '0.00' });
      await expectInvariants(vendorA.vendorId);
    });
  });

  // ─── 5. DELIVERED with a shortfall: partial recovery ───────────────────────

  describe('delivered package whose earnings were partly withdrawn: shortfall, recovery, unrecovered remainder', () => {
    let order3: Checkout;
    let subB3: string;
    let disputeId: string;
    let settlementId: string;

    beforeAll(async () => {
      await app.get(RedisService).client.del(disputeOpenCountKey(customer.userId));
      order3 = await placeOrder([[v.B1, 1]]);
      subB3 = subOf(order3, vendorB.vendorId);
      await pay(order3.parentOrderId);
      await deliver(order3, subB3, vendorB.token);
      expect((await wallet(vendorB.token)).withdrawableBalance).toBe('1800000.00');
      const settlement = await request<{ id: string }>('/vendor/wallet/settlements', { method: 'POST', token: vendorB.token, body: { amount: 1_300_000, targetIban: IBAN_B } });
      expect(settlement.status).toBe(201);
      settlementId = settlement.body.id;
      expect((await wallet(vendorB.token)).withdrawableBalance).toBe('500000.00');
    });

    it('freezes what is left and records the shortfall', async () => {
      const opened = await openDispute({ subOrderId: subB3, reason: 'COUNTERFEIT', description: 'The serial number is not recognised by the brand.', evidenceUrls: [] });
      expect(opened.status).toBe(201);
      disputeId = opened.body.dispute.id;
      expect(opened.body.dispute.timeline[0]).toMatchObject({ type: 'OPENED' });
      const row = await prisma.dispute.findUniqueOrThrow({ where: { id: disputeId }, select: { holdSource: true, holdAmount: true, holdShortfall: true } });
      expect({ source: row.holdSource, amount: row.holdAmount.toFixed(2), shortfall: row.holdShortfall.toFixed(2) }).toEqual({ source: 'WITHDRAWABLE', amount: '500000.00', shortfall: '400000.00' });
      expect(await wallet(vendorB.token)).toMatchObject({ withdrawableBalance: '0.00', settlementHoldBalance: '1300000.00', disputeHoldBalance: '500000.00' });
      await expectInvariants(vendorB.vendorId);
    });

    it('BUYER_FAVOR deducts the hold, recovers from later earnings and reports the rest as unrecovered', async () => {
      const paid = await request(`/admin/settlements/${settlementId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'APPROVE', payaReferenceNumber: `PAYA-${TAG}` } });
      expect(paid.status).toBe(200);
      const order4 = await placeOrder([[v.B2, 1]]);
      const subB4 = subOf(order4, vendorB.vendorId);
      await pay(order4.parentOrderId);
      await deliver(order4, subB4, vendorB.token);
      expect((await wallet(vendorB.token)).withdrawableBalance).toBe('270000.00');

      const decided = await request<ActionResult>(`/admin/disputes/${disputeId}/arbitrate`, {
        method: 'POST',
        token: supportToken,
        body: { decision: 'BUYER_FAVOR', resolutionNotes: 'Brand confirmed the serial is fake.', itemReturned: true },
      });
      expect(decided.status).toBe(200);
      expect(decided.body).toMatchObject({ walletAction: 'REFUNDED', subOrderStatus: 'REFUNDED', stockAction: 'RESTOCKED' });
      expect(decided.body.dispute.resolution).toMatchObject({ refundAmount: '1450000.00', restocked: true, itemReturned: true });

      const rows = await disputeLedger(disputeId);
      expect(rows.filter((row) => row.type === WalletTransactionType.REFUND_DEDUCTION).map((row) => [row.bucket, row.amount.toFixed(2)])).toEqual(
        expect.arrayContaining([
          [WalletBalanceBucket.DISPUTE_HOLD, '-500000.00'],
          [WalletBalanceBucket.WITHDRAWABLE, '-270000.00'],
        ]),
      );
      const w = await wallet(vendorB.token);
      expect(w).toMatchObject({ withdrawableBalance: '0.00', disputeHoldBalance: '0.00', settlementHoldBalance: '0.00', totalWithdrawnAmount: '1300000.00' });
      await expectInvariants(vendorB.vendorId);

      const staffView = await request<Dossier>(`/admin/disputes/${disputeId}`, { token: adminToken });
      expect(staffView.body.hold).toEqual({ source: 'WITHDRAWABLE', amount: '500000.00', shortfall: '400000.00', unrecovered: '130000.00' });
    });

    it('surfaces disputes and the dispute hold in the financial overview', async () => {
      const overview = await request<{ wallets: { disputeHold: string; ledgerConsistent: boolean }; disputes: Record<string, unknown> }>('/admin/financial/overview', { token: financeToken });
      expect(overview.status).toBe(200);
      expect(overview.body.wallets.ledgerConsistent).toBe(true);
      for (const key of ['open', 'underArbitration', 'resolvedForBuyer']) expect(typeof overview.body.disputes[key]).toBe('number');
      expect(overview.body.disputes['resolvedForBuyer'] as number).toBeGreaterThanOrEqual(3);
      expect(d(overview.body.disputes['unrecoveredVendorEarnings'] as string).greaterThanOrEqualTo(130_000)).toBe(true);
      expect(d(overview.body.disputes['refundsOwedToCustomers'] as string).greaterThanOrEqualTo(2_450_000 * 2 + 1_450_000)).toBe(true);
    });
  });

  // ─── contract ──────────────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every Phase 9 route under its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as { paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>; tags: Array<{ name: string }> };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/customer/disputes', 'post', 'customer-disputes'],
        ['/api/v1/customer/disputes', 'get', 'customer-disputes'],
        ['/api/v1/customer/disputes/{id}', 'get', 'customer-disputes'],
        ['/api/v1/customer/disputes/{id}/cancel', 'post', 'customer-disputes'],
        ['/api/v1/vendor/disputes', 'get', 'vendor-disputes'],
        ['/api/v1/vendor/disputes/{id}', 'get', 'vendor-disputes'],
        ['/api/v1/vendor/disputes/{id}/respond', 'post', 'vendor-disputes'],
        ['/api/v1/admin/disputes', 'get', 'admin-disputes'],
        ['/api/v1/admin/disputes/{id}', 'get', 'admin-disputes'],
        ['/api/v1/admin/disputes/{id}/arbitrate', 'post', 'admin-disputes'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(3);
      }
      const tags = document.tags.map((tag) => tag.name);
      for (const tag of ['customer-disputes', 'vendor-disputes', 'admin-disputes']) expect(tags).toContain(tag);
    });
  });
});
```

### `apps/backend/test/finance.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { WalletTransactionType } from '@prisma/client';
import { AuditAction, Prisma, WalletBalanceBucket } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { OrderLifecycleService } from '../src/modules/orders/order-lifecycle.service';
import { SETTLEMENT_MIN_AMOUNT_KEY } from '../src/modules/settlements/settlements.service';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { WalletLedgerService } from '../src/modules/wallet/wallet-ledger.service';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 7 — card payment through the gateway
 * abstraction, escrow wallet ledger, escrow release on delivery, refunds and
 * vendor settlements — against the real PostgreSQL 16 and Redis 7 of
 * docker-compose.
 *
 * The active gateway is the SANDBOX provider (PAYMENT_GATEWAY_PROVIDER=sandbox,
 * development only): the suite drives it exactly as a browser would — initiate
 * → sandbox bank page → Pay/Decline form POST → 303 to the callback → callback
 * verifies server-to-server against the sandbox bank state in Redis. Nothing is
 * stubbed inside the API.
 *
 * Money (IRR). Store A has a 7.5% commission override, store B uses the 10%
 * category rate; platform shipping 450,000 per package (not credited to
 * vendors — earnings = items − commission, Phase 6 rule):
 *   A1 3,000,000 × 2 = 6,000,000 → commission 450,000 → earnings 5,550,000
 *   B1 3,000,000 × 1 = 3,000,000 → commission 300,000 → earnings 2,700,000
 *   payable = 6,000,000 + 3,000,000 + 2 × 450,000 = 9,900,000
 */

const TEST_UA = 'shopino-finance-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971150001';
const VENDOR_B_MOBILE = '+989971150002';
const CUSTOMER_MOBILE = '+989971150003';
const CUSTOMER_2_MOBILE = '+989971150004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE];
const IBAN_A = 'IR820540102680020817909002';
const IBAN_B = 'IR570629600000001003242001';
const OTHER_VALID_IBAN = 'IR550540102680020817909003';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const SEEDED_FINANCE_EMAIL = 'finance@shopino.local';

const PLATFORM_FEE = '450000';
const PLATFORM_FREE_THRESHOLD = '20000000';

interface HttpResult<T> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

interface ErrorBody {
  code?: string;
  message: string | string[];
}

interface Checkout {
  parentOrderId: string;
  orderNumber: string;
  finalPayableAmount: string;
  subOrders: Array<{ id: string; store: { id: string }; status: string }>;
}

interface Initiated {
  paymentId: string;
  redirectUrl: string;
  gatewayName: string;
  amount: string;
  currency: string;
  orderNumber: string;
}

interface Outcome {
  outcome: 'PAID' | 'FAILED' | 'VERIFICATION_PENDING' | 'PAID_REQUIRES_REFUND';
  paymentId: string;
  paymentStatus: string;
  parentOrderId: string;
  orderNumber: string;
  orderPaymentStatus: string;
  bankRrn: string | null;
  canRetry: boolean;
}

interface Wallet {
  pendingBalance: string;
  withdrawableBalance: string;
  settlementHoldBalance: string;
  totalEarnedBalance: string;
  totalWithdrawnAmount: string;
  currency: string;
}

interface LedgerRow {
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: string;
  balanceAfter: string;
  subOrderId: string | null;
  subOrderNumber: string | null;
  settlementRequestId: string | null;
}

interface Settlement {
  id: string;
  vendorId: string;
  amount: string;
  targetIban: string;
  status: string;
  bankPayaReference: string | null;
  rejectionReason: string | null;
  processedBy: { id: string } | null;
  auditLogId?: string;
}

interface Page<T> {
  items: T[];
  total: number;
}

interface Transition {
  previousStatus: string;
  walletAction: string;
  stockAction: string;
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

describe('Phase 7 — payments, escrow wallet and settlements (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let lifecycle: OrderLifecycleService;

  let adminToken: string;
  let supportToken: string;
  let financeToken: string;
  let financeUserId: string;
  let vendorA: { token: string; userId: string; vendorId: string };
  let vendorB: { token: string; userId: string; vendorId: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };
  let categoryId: string;
  let addressId: string;
  const v: Record<'A1' | 'B1', string> = {} as never;
  let savedConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];
  const paymentIds: string[] = [];

  /** The main order of the suite (A1×2 + B1×1). */
  let order: Checkout;
  let subA: string;
  let subB: string;

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH'; token?: string; body?: unknown; form?: Record<string, string> } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let payload: string | undefined;
    if (options.form !== undefined) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      payload = new URLSearchParams(options.form).toString();
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
    const isJson = String(response.headers['content-type'] ?? '').includes('application/json');
    return {
      status: response.statusCode,
      body: (isJson && response.body.length > 0 ? JSON.parse(response.body) : response.body) as T,
      headers: response.headers,
    };
  };

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<{ token: string; userId: string }> => {
    const response = await request<{ accessToken: string; user: { id: string } }>('/auth/login/password', { method: 'POST', body: { identifier, password } });
    expect(response.status).toBe(200);
    return { token: response.body.accessToken, userId: response.body.user.id };
  };

  const onboardStore = async (login: { token: string }, storeSlug: string, iban: string, commissionRateOverride: number | null): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: { storeName: `فروشگاه آزمون مالی ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون فاز هفت', bankIban: iban, bankAccountHolder: 'شرکت آزمون مالی' },
    });
    expect(registered.status).toBe(201);
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% finance e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const serialized = new Response(form);
    const uploaded = await app.inject({
      method: 'POST',
      url: `${API}/media/upload/document`,
      headers: { authorization: `Bearer ${login.token}`, 'user-agent': TEST_UA, 'content-type': serialized.headers.get('content-type') ?? '' },
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

  const createProduct = async (token: string, title: string, sku: string, price: number, stockQuantity: number): Promise<string> => {
    const response = await request<{ variants: Array<{ id: string }> }>('/vendor/products', {
      method: 'POST',
      token,
      body: { title, categoryId, basePrice: price, isPublished: true, variants: [{ sku, price, stockQuantity }] },
    });
    expect(response.status).toBe(201);
    return response.body.variants[0]!.id;
  };

  const placeOrder = async (lines: Array<[string, number]>, token = customer.token, address = addressId): Promise<Checkout> => {
    expect((await request('/cart/clear', { method: 'POST', token })).status).toBe(200);
    for (const [productVariantId, quantity] of lines) {
      expect((await request('/cart/items', { method: 'POST', token, body: { productVariantId, quantity } })).status).toBe(200);
    }
    const placed = await request<Checkout>('/orders/checkout', { method: 'POST', token, body: { addressId: address } });
    expect(placed.status).toBe(201);
    return placed.body;
  };

  const initiate = async (parentOrderId: string, token = customer.token): Promise<Initiated> => {
    const response = await request<Initiated>('/payments/initiate', { method: 'POST', token, body: { parentOrderId } });
    expect(response.status).toBe(201);
    paymentIds.push(response.body.paymentId);
    return response.body;
  };

  /** The payer's decision on the sandbox bank page; returns the callback path the browser is redirected to. */
  const decide = async (paymentId: string, decision: 'PAY' | 'DECLINE'): Promise<string> => {
    const response = await request(`/sandbox/payment-page/${paymentId}/decision`, { method: 'POST', form: { decision } });
    expect(response.status).toBe(303);
    const location = new URL(String(response.headers['location']));
    expect(location.pathname).toBe(`${API}/payments/callback`);
    return `${location.pathname.slice(API.length)}${location.search}`;
  };

  const payThroughSandbox = async (parentOrderId: string, decision: 'PAY' | 'DECLINE'): Promise<{ initiated: Initiated; callbackPath: string; outcome: HttpResult<Outcome> }> => {
    const initiated = await initiate(parentOrderId);
    const callbackPath = await decide(initiated.paymentId, decision);
    const outcome = await request<Outcome>(callbackPath);
    return { initiated, callbackPath, outcome };
  };

  const wallet = async (token: string): Promise<Wallet> => {
    const response = await request<Wallet>('/vendor/wallet', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  const ledger = async (token: string, query = ''): Promise<LedgerRow[]> => {
    const response = await request<Page<LedgerRow>>(`/vendor/wallet/transactions?pageSize=100${query}`, { token });
    expect(response.status).toBe(200);
    return response.body.items;
  };

  const stockOf = async (variantId: string): Promise<{ stock: number; reserved: number }> => {
    const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: { stockQuantity: true, reservedQuantity: true } });
    return { stock: row.stockQuantity, reserved: row.reservedQuantity };
  };

  /** Ledger invariant: per bucket, SUM(amount) = wallet column and the latest balanceAfter = wallet column. */
  const expectReconciled = async (vendorId: string): Promise<void> => {
    const w = await prisma.vendorWallet.findUniqueOrThrow({ where: { vendorId } });
    const rows = await prisma.walletTransaction.findMany({ where: { walletId: w.id } });
    const columns: Record<WalletBalanceBucket, Prisma.Decimal> = {
      PENDING: w.pendingBalance,
      WITHDRAWABLE: w.withdrawableBalance,
      SETTLEMENT_HOLD: w.settlementHoldBalance,
      DISPUTE_HOLD: w.disputeHoldBalance,
    };
    for (const bucket of Object.values(WalletBalanceBucket)) {
      const inBucket = rows.filter((row) => row.bucket === bucket);
      const sum = inBucket.reduce((acc, row) => acc.plus(row.amount), d(0));
      expect(sum.toFixed(2)).toBe(columns[bucket].toFixed(2));
      // balanceAfter chains: each row = previous balance + amount (rows of one transaction share a timestamp, so check the chain as a set)
      const afters = new Set(inBucket.map((row) => row.balanceAfter.toFixed(2)));
      if (inBucket.length > 0) expect(afters.has(columns[bucket].toFixed(2))).toBe(true);
    }
  };

  const setConfig = async (key: string, value: string): Promise<void> => {
    await prisma.systemConfig.upsert({ where: { key }, update: { value }, create: { key, value, valueType: 'NUMBER', description: `finance e2e ${RUN}` } });
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
    adminToken = (await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword)).token;
    supportToken = (await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword)).token;
    const finance = await loginWithPassword(SEEDED_FINANCE_EMAIL, staffPassword);
    financeToken = finance.token;
    financeUserId = finance.userId;

    const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), SETTLEMENT_MIN_AMOUNT_KEY];
    savedConfigs = (await prisma.systemConfig.findMany({
      where: { key: { in: configKeys } },
      select: { key: true, value: true, valueType: true, description: true },
    })) as never;
    await setConfig(SHIPPING_CONFIG_KEYS.defaultFeePerVendor, PLATFORM_FEE);
    await setConfig(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, PLATFORM_FREE_THRESHOLD);
    await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '5000000.00'); // the seeded value, pinned for determinism

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-fin-${RUN}`, titleFa: `دسته آزمون مالی ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    vendorA = { ...a, vendorId: await onboardStore(a, `fin-e2e-a-${RUN}`, IBAN_A, 7.5) };
    vendorB = { ...b, vendorId: await onboardStore(b, `fin-e2e-b-${RUN}`, IBAN_B, null) };
    v.A1 = await createProduct(vendorA.token, `لپ‌تاپ آزمون مالی ${RUN}`, `FIN-${TAG}-A1`, 3_000_000, 10);
    v.B1 = await createProduct(vendorB.token, `مانیتور آزمون مالی ${RUN}`, `FIN-${TAG}-B1`, 3_000_000, 10);

    const address = await request<{ id: string }>('/customer/addresses', {
      method: 'POST',
      token: customer.token,
      body: {
        province: 'تهران',
        city: 'تهران',
        postalAddress: 'خیابان آزادی، پلاک ۷',
        postalCode: '1458889999',
        buildingNumber: '7',
        unitNumber: '2',
        recipientName: 'مشتری آزمون مالی',
        recipientMobile: '09971150003',
      },
    });
    expect(address.status).toBe(201);
    addressId = address.body.id;
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const orders = await prisma.parentOrder.findMany({ where: { userId: { in: userIds } }, select: { id: true, subOrders: { select: { id: true } } } });
      const orderIds = orders.map((row) => row.id);
      const subIds = orders.flatMap((row) => row.subOrders.map((sub) => sub.id));
      const payments = await prisma.payment.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true } });
      const settlements = await prisma.settlementRequest.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const entityIds = [...vendorIds, ...productIds, ...variantIds, ...orderIds, ...subIds, ...payments.map((p) => p.id), ...settlements.map((s) => s.id), categoryId];

      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: entityIds.filter(Boolean) } }] } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } }); // cascades to the ledger
      await prisma.settlementRequest.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.payment.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.cart.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { items: { some: { productVariantId: { in: variantIds } } } }] } });
      await prisma.address.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      if (categoryId !== undefined) await prisma.category.deleteMany({ where: { id: categoryId } });

      const storage = app.get<StorageProvider>(STORAGE_PROVIDER);
      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true } });
      for (const asset of assets) await storage.delete(asset.path).catch(() => false);
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.customerProfile.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await prisma.systemConfig.deleteMany({ where: { key: { in: [...Object.values(SHIPPING_CONFIG_KEYS), SETTLEMENT_MIN_AMOUNT_KEY] } } });
      for (const row of savedConfigs) await prisma.systemConfig.create({ data: row });
      await app.get(CategoriesService).invalidateTree();

      const redis = app.get(RedisService);
      for (const paymentId of paymentIds) {
        const authority = await redis.client.get(`payment:sandbox:payment:${paymentId}`);
        await redis.client.del(`payment:sandbox:payment:${paymentId}`, ...(authority ? [`payment:sandbox:session:${authority}`] : []));
      }
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
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL, SEEDED_FINANCE_EMAIL].flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  // ─── 1. initiate ───────────────────────────────────────────────────────────

  describe('payment initiation', () => {
    beforeAll(async () => {
      order = await placeOrder([
        [v.A1, 2],
        [v.B1, 1],
      ]);
      subA = order.subOrders.find((sub) => sub.store.id === vendorA.vendorId)!.id;
      subB = order.subOrders.find((sub) => sub.store.id === vendorB.vendorId)!.id;
    });

    it('prices the order as documented (9,900,000 IRR)', () => {
      expect(order.finalPayableAmount).toBe('9900000.00');
    });

    it('enforces authentication, role and ownership', async () => {
      const body = { parentOrderId: order.parentOrderId };
      expect((await request('/payments/initiate', { method: 'POST', body })).status).toBe(401);
      expect((await request('/payments/initiate', { method: 'POST', token: vendorA.token, body })).status).toBe(403);
      expect((await request('/payments/initiate', { method: 'POST', token: customer2.token, body })).status).toBe(404);
      expect((await request('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId: 'not-a-uuid' } })).status).toBe(400);
    });

    it('creates an INITIATED payment and returns the sandbox bank page', async () => {
      const initiated = await initiate(order.parentOrderId);
      expect(initiated).toMatchObject({ gatewayName: 'SANDBOX', amount: '9900000.00', currency: 'IRR', orderNumber: order.orderNumber });
      expect(initiated.redirectUrl).toMatch(new RegExp(`/api/v1/sandbox/payment-page/${initiated.paymentId}$`));

      const row = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(row).toMatchObject({ status: 'INITIATED', gatewayName: 'SANDBOX', parentOrderId: order.parentOrderId });
      expect(row.cashAmount.toFixed(2)).toBe('9900000.00');
      expect(row.gatewayTrackingToken).toMatch(/^SBX[0-9A-F]{32}$/);
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.CREATE } })).toBe(1);

      const page = await request<string>(`/sandbox/payment-page/${initiated.paymentId}`);
      expect(page.status).toBe(200);
      expect(String(page.headers['content-type'])).toContain('text/html');
      expect(page.body).toContain(order.orderNumber);
      expect(page.body).toContain('SANDBOX');
      expect(page.body).toContain('۹٬۹۰۰٬۰۰۰'); // fa-IR formatted amount
      expect((await request(`/sandbox/payment-page/${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`)).status).toBe(404);
    });

    it('keeps packages hidden from vendors while the order is unpaid', async () => {
      const list = await request<Page<{ orderNumber: string }>>('/vendor/orders', { token: vendorA.token });
      expect(list.body.items.some((row) => row.orderNumber === order.orderNumber)).toBe(false);
    });
  });

  // ─── 2. failure, forged callbacks, retry, success ─────────────────────────

  describe('callback processing', () => {
    it('a declined payment fails the Payment but keeps the order payable with its stock reserved', async () => {
      const before = await stockOf(v.A1);
      const { outcome, initiated } = await payThroughSandbox(order.parentOrderId, 'DECLINE');
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'FAILED', paymentStatus: 'FAILED', orderPaymentStatus: 'PENDING', canRetry: true, bankRrn: null });
      expect((await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } })).status).toBe('FAILED');
      expect(await stockOf(v.A1)).toEqual(before);
      expect((await prisma.parentOrder.findUniqueOrThrow({ where: { id: order.parentOrderId } })).paymentStatus).toBe('PENDING');
      expect(await prisma.walletTransaction.count({ where: { subOrderId: { in: [subA, subB] } } })).toBe(0);
    });

    it('never trusts the redirect: a forged Status=OK for an unpaid bank session is verified and rejected', async () => {
      const initiated = await initiate(order.parentOrderId);
      const token = (await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } })).gatewayTrackingToken!;
      const forged = await request<Outcome>(`/payments/callback?Authority=${token}&Status=OK`);
      expect(forged.status).toBe(200);
      expect(forged.body).toMatchObject({ outcome: 'FAILED', orderPaymentStatus: 'PENDING' });
      const row = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(row.status).toBe('FAILED');
      expect(row.metadata).toMatchObject({ code: 'NOT_PAID' });
    });

    it('rejects callbacks without a token (400) and with an unknown token (404)', async () => {
      expect((await request<ErrorBody>('/payments/callback?Status=OK')).body.code).toBe('INVALID_CALLBACK');
      expect((await request('/payments/callback?Status=OK')).status).toBe(400);
      expect((await request('/payments/callback?Authority=SBXDOESNOTEXIST&Status=OK')).status).toBe(404);
    });

    it('a successful payment completes the order atomically: PAID, PENDING_APPROVAL, stock committed, escrow credited', async () => {
      const stockA = await stockOf(v.A1);
      const stockB = await stockOf(v.B1);
      const { outcome, initiated, callbackPath } = await payThroughSandbox(order.parentOrderId, 'PAY');
      expect(callbackPath).toMatch(/Status=OK/);
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'PAID', paymentStatus: 'SUCCESSFUL', orderPaymentStatus: 'PAID', orderNumber: order.orderNumber, canRetry: false });
      expect(outcome.body.bankRrn).toMatch(/^\d{12}$/);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(payment.status).toBe('SUCCESSFUL');
      expect(payment.bankRrn).toBe(outcome.body.bankRrn);
      expect(payment.paidAt).not.toBeNull();
      expect(payment.metadata).toMatchObject({ verifyCode: '100', escrowHeld: '8250000.00' });

      const parent = await prisma.parentOrder.findUniqueOrThrow({ where: { id: order.parentOrderId }, include: { subOrders: true } });
      expect(parent.paymentStatus).toBe('PAID');
      expect(parent.subOrders.map((sub) => sub.status)).toEqual(['PENDING_APPROVAL', 'PENDING_APPROVAL']);

      // stock -= q and reserved -= q
      expect(await stockOf(v.A1)).toEqual({ stock: stockA.stock - 2, reserved: stockA.reserved - 2 });
      expect(await stockOf(v.B1)).toEqual({ stock: stockB.stock - 1, reserved: stockB.reserved - 1 });

      // exact escrow credit: earnings = items − commission
      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '5550000.00', withdrawableBalance: '0.00', totalEarnedBalance: '0.00', currency: 'IRR' });
      expect(await wallet(vendorB.token)).toMatchObject({ pendingBalance: '2700000.00', withdrawableBalance: '0.00' });
      const rowsA = await ledger(vendorA.token);
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]).toMatchObject({
        type: 'CREDIT_SALE_ESCROW_HOLD',
        bucket: 'PENDING',
        amount: '5550000.00',
        balanceAfter: '5550000.00',
        subOrderId: subA,
      });
      expect(rowsA[0]!.subOrderNumber).toBe((await prisma.subOrder.findUniqueOrThrow({ where: { id: subA } })).subOrderNumber);
      await expectReconciled(vendorA.vendorId);
      await expectReconciled(vendorB.vendorId);

      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { entityName: 'ParentOrder', entityId: order.parentOrderId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
    });

    it('repeated callbacks (GET or form POST) return the same outcome and never apply twice', async () => {
      const payment = await prisma.payment.findFirstOrThrow({ where: { parentOrderId: order.parentOrderId, status: 'SUCCESSFUL' } });
      const again = await request<Outcome>(`/payments/callback?Authority=${payment.gatewayTrackingToken!}&Status=OK`);
      expect(again.body).toMatchObject({ outcome: 'PAID', paymentId: payment.id, bankRrn: payment.bankRrn });
      const posted = await request<Outcome>('/payments/callback', { method: 'POST', form: { Authority: payment.gatewayTrackingToken!, Status: 'OK' } });
      expect(posted.status).toBe(200);
      expect(posted.body).toMatchObject({ outcome: 'PAID', paymentId: payment.id });
      expect(await prisma.walletTransaction.count({ where: { subOrderId: { in: [subA, subB] } } })).toBe(2);
      expect((await wallet(vendorA.token)).pendingBalance).toBe('5550000.00');
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: payment.id, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
    });

    it('a paid order cannot be paid again', async () => {
      const response = await request<ErrorBody>('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId: order.parentOrderId } });
      expect(response.status).toBe(409);
      expect(response.body.code).toBe('ORDER_NOT_PAYABLE');
    });

    it('packages are now visible to their vendors in PENDING_APPROVAL', async () => {
      const list = await request<Page<{ id: string; status: string }>>('/vendor/orders', { token: vendorA.token });
      expect(list.body.items.find((row) => row.id === subA)?.status).toBe('PENDING_APPROVAL');
    });
  });

  // ─── 3. delivery releases escrow; cancellation reverses it ────────────────

  describe('escrow release and reversal', () => {
    it('customer confirmation of a SHIPPED package releases the escrow to withdrawable, exactly once', async () => {
      expect((await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'PROCESSING' } })).status).toBe(200);
      // not shipped yet: cannot be confirmed
      const early = await request<ErrorBody>(`/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`, { method: 'POST', token: customer.token });
      expect(early.status).toBe(409);
      expect(
        (await request(`/vendor/orders/${subA}/status`, { method: 'PATCH', token: vendorA.token, body: { status: 'SHIPPED', trackingCode: `TRK-${TAG}`, shippingCarrier: 'پست پیشتاز' } })).status,
      ).toBe(200);
      expect((await request(`/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`, { method: 'POST', token: customer2.token })).status).toBe(404);

      const confirmed = await request<Transition & { order: { subOrders: Array<{ id: string; status: string }> } }>(
        `/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`,
        { method: 'POST', token: customer.token },
      );
      expect(confirmed.status).toBe(200);
      expect(confirmed.body).toMatchObject({ previousStatus: 'SHIPPED', walletAction: 'ESCROW_RELEASED' });
      expect(confirmed.body.order.subOrders.find((sub) => sub.id === subA)?.status).toBe('DELIVERED');

      expect(await wallet(vendorA.token)).toMatchObject({ pendingBalance: '0.00', withdrawableBalance: '5550000.00', totalEarnedBalance: '5550000.00' });
      const sub = await prisma.subOrder.findUniqueOrThrow({ where: { id: subA } });
      expect(sub.status).toBe('DELIVERED');
      expect(sub.escrowReleasedAt).not.toBeNull();
      expect(sub.deliveredAt).not.toBeNull();
      const release = await ledger(vendorA.token, '&type=ESCROW_RELEASE_TO_WITHDRAWABLE');
      expect(release.map((row) => [row.bucket, row.amount]).sort()).toEqual([
        ['PENDING', '-5550000.00'],
        ['WITHDRAWABLE', '5550000.00'],
      ]);
      await expectReconciled(vendorA.vendorId);

      // idempotent: HTTP rejects a second confirmation, staff cannot re-deliver, the ledger service refuses, the DB refuses
      expect((await request(`/customer/orders/${order.parentOrderId}/sub-orders/${subA}/confirm-delivery`, { method: 'POST', token: customer.token })).status).toBe(409);
      expect(
        (await request(`/admin/sub-orders/${subA}/force-status`, { method: 'PATCH', token: adminToken, body: { status: 'DELIVERED', reason: 'تأیید دوباره تحویل' } })).status,
      ).toBe(409);
      const ledgerService = app.get(WalletLedgerService);
      const again = await prisma.$transaction((tx) =>
        ledgerService.releaseEscrow(tx, { id: subA, vendorId: vendorA.vendorId, subOrderNumber: sub.subOrderNumber, vendorEarningsAmount: sub.vendorEarningsAmount }),
      );
      expect(again).toBe(false);
      const w = await prisma.vendorWallet.findUniqueOrThrow({ where: { vendorId: vendorA.vendorId } });
      await expect(
        prisma.walletTransaction.create({
          data: { walletId: w.id, subOrderId: subA, type: 'ESCROW_RELEASE_TO_WITHDRAWABLE', bucket: 'WITHDRAWABLE', amount: 1, balanceAfter: 1, description: 'duplicate' },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
      expect((await wallet(vendorA.token)).withdrawableBalance).toBe('5550000.00');
    });

    it('a vendor cancel before delivery reverses the escrow and restocks; a later staff REFUNDED is a wallet no-op', async () => {
      const stockBefore = await stockOf(v.B1);
      const cancelled = await request<Transition>(`/vendor/orders/${subB}/status`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { status: 'CANCELLED', reason: 'موجودی انبار با سیستم همخوانی نداشت' },
      });
      expect(cancelled.status).toBe(200);
      expect(cancelled.body).toMatchObject({ walletAction: 'ESCROW_REVERSED', stockAction: 'RESTOCKED' });
      expect(await stockOf(v.B1)).toEqual({ stock: stockBefore.stock + 1, reserved: stockBefore.reserved });
      expect(await wallet(vendorB.token)).toMatchObject({ pendingBalance: '0.00', withdrawableBalance: '0.00', totalEarnedBalance: '0.00' });
      const refund = await ledger(vendorB.token, '&type=REFUND_DEDUCTION');
      expect(refund).toHaveLength(1);
      expect(refund[0]).toMatchObject({ bucket: 'PENDING', amount: '-2700000.00', balanceAfter: '0.00', subOrderId: subB });

      const refunded = await request<Transition>(`/admin/sub-orders/${subB}/force-status`, {
        method: 'PATCH',
        token: adminToken,
        body: { status: 'REFUNDED', reason: 'بازگشت وجه به مشتری ثبت شد' },
      });
      expect(refunded.status).toBe(200);
      expect(refunded.body.walletAction).toBe('NONE');
      expect(await ledger(vendorB.token, '&type=REFUND_DEDUCTION')).toHaveLength(1);
      await expectReconciled(vendorB.vendorId);
    });
  });

  // ─── 4. settlements ────────────────────────────────────────────────────────

  describe('vendor settlements', () => {
    let rejectedId: string;
    let approvedId: string;

    it('guards the vendor wallet endpoints by role', async () => {
      expect((await request('/vendor/wallet')).status).toBe(401);
      expect((await request('/vendor/wallet', { token: customer.token })).status).toBe(403);
      expect((await request('/vendor/wallet/settlements', { method: 'POST', token: customer.token, body: { amount: 5_000_000, targetIban: IBAN_A } })).status).toBe(403);
    });

    it('validates amount and IBAN: > withdrawable 409, < minimum 400, foreign IBAN 409, invalid IBAN 400', async () => {
      const over = await request<ErrorBody & { available: string }>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 6_000_000, targetIban: IBAN_A } });
      expect(over.status).toBe(409);
      expect(over.body).toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE', available: '5550000.00' });
      const under = await request<ErrorBody>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 1_000_000, targetIban: IBAN_A } });
      expect(under.status).toBe(400);
      expect(under.body.code).toBe('AMOUNT_BELOW_MINIMUM');
      const foreign = await request<ErrorBody>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: OTHER_VALID_IBAN } });
      expect(foreign.status).toBe(409);
      expect(foreign.body.code).toBe('IBAN_MISMATCH');
      expect((await request('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: 'IR620540102680020817909001' } })).status).toBe(400);
      expect((await request('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000.001, targetIban: IBAN_A } })).status).toBe(400);
      expect(await prisma.settlementRequest.count({ where: { vendorId: vendorA.vendorId } })).toBe(0);
      expect((await wallet(vendorA.token)).withdrawableBalance).toBe('5550000.00');
    });

    it('a request holds the amount immediately (withdrawable → settlement hold); a second one cannot overdraw', async () => {
      const created = await request<Settlement>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: IBAN_A } });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ status: 'REQUESTED', amount: '5000000.00', targetIban: IBAN_A, vendorId: vendorA.vendorId });
      rejectedId = created.body.id;
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '550000.00', settlementHoldBalance: '5000000.00' });
      const second = await request<ErrorBody>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: IBAN_A } });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('INSUFFICIENT_WALLET_BALANCE');
      const mine = await request<Page<Settlement>>('/vendor/wallet/settlements', { token: vendorA.token });
      expect(mine.body.items.map((row) => row.id)).toEqual([rejectedId]);
      expect((await request<Page<Settlement>>('/vendor/wallet/settlements', { token: vendorB.token })).body.total).toBe(0);
      await expectReconciled(vendorA.vendorId);
    });

    it('lists requests for finance staff with filters; support and vendors are refused', async () => {
      expect((await request('/admin/settlements', { token: supportToken })).status).toBe(403);
      expect((await request('/admin/settlements', { token: vendorA.token })).status).toBe(403);
      const listed = await request<Page<Settlement>>(`/admin/settlements?status=REQUESTED&vendorId=${vendorA.vendorId}`, { token: financeToken });
      expect(listed.status).toBe(200);
      expect(listed.body.items.map((row) => row.id)).toEqual([rejectedId]);
      expect((await request<Page<Settlement>>(`/admin/settlements?status=PAID_PAYA&vendorId=${vendorA.vendorId}`, { token: adminToken })).body.total).toBe(0);
      expect((await request('/admin/settlements?status=BOGUS', { token: financeToken })).status).toBe(400);
    });

    it('reject restores the held amount; a processed request cannot be processed again', async () => {
      expect((await request(`/admin/settlements/${rejectedId}/process`, { method: 'PATCH', token: supportToken, body: { action: 'REJECT', rejectionReason: 'x'.repeat(10) } })).status).toBe(403);
      expect((await request(`/admin/settlements/${rejectedId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'REJECT' } })).status).toBe(400);
      const rejected = await request<Settlement>(`/admin/settlements/${rejectedId}/process`, {
        method: 'PATCH',
        token: financeToken,
        body: { action: 'REJECT', rejectionReason: 'شماره شبا با نام صاحب حساب مطابقت ندارد' },
      });
      expect(rejected.status).toBe(200);
      expect(rejected.body).toMatchObject({ status: 'REJECTED', rejectionReason: 'شماره شبا با نام صاحب حساب مطابقت ندارد', processedBy: { id: financeUserId } });
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '5550000.00', settlementHoldBalance: '0.00', totalWithdrawnAmount: '0.00' });
      const again = await request<ErrorBody>(`/admin/settlements/${rejectedId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'APPROVE', payaReferenceNumber: 'PAYA-1' } });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('SETTLEMENT_ALREADY_PROCESSED');
      expect(await prisma.auditLog.count({ where: { entityName: 'SettlementRequest', entityId: rejectedId, action: AuditAction.SETTLEMENT_TRIGGER } })).toBe(1);
      await expectReconciled(vendorA.vendorId);
    });

    it('approve records the PAYA payout: PAID_PAYA, hold cleared, totalWithdrawnAmount increased', async () => {
      const created = await request<Settlement>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 5_000_000, targetIban: IBAN_A } });
      expect(created.status).toBe(201);
      approvedId = created.body.id;
      expect((await request(`/admin/settlements/${approvedId}/process`, { method: 'PATCH', token: financeToken, body: { action: 'APPROVE' } })).status).toBe(400);
      const approved = await request<Settlement>(`/admin/settlements/${approvedId}/process`, {
        method: 'PATCH',
        token: financeToken,
        body: { action: 'APPROVE', payaReferenceNumber: `PAYA-${TAG}-1` },
      });
      expect(approved.status).toBe(200);
      expect(approved.body).toMatchObject({ status: 'PAID_PAYA', bankPayaReference: `PAYA-${TAG}-1`, processedBy: { id: financeUserId } });
      expect(approved.body.auditLogId).toEqual(expect.any(String));
      expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '550000.00', settlementHoldBalance: '0.00', totalWithdrawnAmount: '5000000.00', totalEarnedBalance: '5550000.00' });
      const payout = await ledger(vendorA.token, '&type=SETTLEMENT_PAYOUT');
      expect(payout).toEqual([expect.objectContaining({ bucket: 'SETTLEMENT_HOLD', amount: '-5000000.00', balanceAfter: '0.00', settlementRequestId: approvedId })]);
      await expectReconciled(vendorA.vendorId);
    });

    it('POST …/payout pays a request; a PAYA reference cannot be reused', async () => {
      await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '100000.00');
      try {
        const created = await request<Settlement>('/vendor/wallet/settlements', { method: 'POST', token: vendorA.token, body: { amount: 500_000, targetIban: IBAN_A } });
        expect(created.status).toBe(201);
        const reused = await request<ErrorBody>(`/admin/settlements/${created.body.id}/payout`, { method: 'POST', token: adminToken, body: { payaReferenceNumber: `PAYA-${TAG}-1` } });
        expect(reused.status).toBe(409);
        expect(reused.body.code).toBe('PAYA_REFERENCE_IN_USE');
        const paid = await request<Settlement>(`/admin/settlements/${created.body.id}/payout`, { method: 'POST', token: adminToken, body: { payaReferenceNumber: `PAYA-${TAG}-2` } });
        expect(paid.status).toBe(200);
        expect(paid.body.status).toBe('PAID_PAYA');
        expect(await wallet(vendorA.token)).toMatchObject({ withdrawableBalance: '50000.00', totalWithdrawnAmount: '5500000.00' });
        expect((await request(`/admin/settlements/${created.body.id}/payout`, { method: 'POST', token: adminToken, body: { payaReferenceNumber: `PAYA-${TAG}-3` } })).status).toBe(409);
      } finally {
        await setConfig(SETTLEMENT_MIN_AMOUNT_KEY, '5000000.00');
      }
      await expectReconciled(vendorA.vendorId);
    });

    it('a refund after delivery cannot drive the withdrawable balance negative (409, nothing changes)', async () => {
      const refused = await request<ErrorBody & { bucket: string }>(`/admin/sub-orders/${subA}/force-status`, {
        method: 'PATCH',
        token: adminToken,
        body: { status: 'REFUNDED', reason: 'مشتری کالا را مرجوع کرد' },
      });
      expect(refused.status).toBe(409);
      expect(refused.body).toMatchObject({ code: 'INSUFFICIENT_WALLET_BALANCE', bucket: 'WITHDRAWABLE' });
      expect((await prisma.subOrder.findUniqueOrThrow({ where: { id: subA } })).status).toBe('DELIVERED');
      expect((await wallet(vendorA.token)).withdrawableBalance).toBe('50000.00');
    });
  });

  // ─── 5. expiry protection, late capture, concurrency ──────────────────────

  describe('payment edge cases', () => {
    it('the expiry sweeper spares an order whose payment is in flight, and a late capture is flagged for manual refund', async () => {
      const late = await placeOrder([[v.B1, 1]]);
      const initiated = await initiate(late.parentOrderId);
      await prisma.parentOrder.update({ where: { id: late.parentOrderId }, data: { paymentExpiresAt: new Date(Date.now() - 60_000) } });

      await lifecycle.expireOverdue();
      expect((await prisma.parentOrder.findUniqueOrThrow({ where: { id: late.parentOrderId } })).paymentStatus).toBe('PENDING');

      // the payer walked away: the attempt ages past the grace window, the sweeper cancels and releases stock
      await prisma.payment.update({ where: { id: initiated.paymentId }, data: { createdAt: new Date(Date.now() - 60 * 60_000) } });
      const reservedBefore = (await stockOf(v.B1)).reserved;
      await lifecycle.expireOverdue();
      expect((await prisma.parentOrder.findUniqueOrThrow({ where: { id: late.parentOrderId } })).paymentStatus).toBe('CANCELLED');
      expect((await stockOf(v.B1)).reserved).toBe(reservedBefore - 1);

      // ...then pays after all: the money is recorded, the order is not resurrected, finance is told to refund
      const walletBefore = await wallet(vendorB.token);
      const callbackPath = await decide(initiated.paymentId, 'PAY');
      const outcome = await request<Outcome>(callbackPath);
      expect(outcome.body).toMatchObject({ outcome: 'PAID_REQUIRES_REFUND', paymentStatus: 'SUCCESSFUL', orderPaymentStatus: 'CANCELLED' });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: initiated.paymentId } });
      expect(payment.metadata).toMatchObject({ requiresManualRefund: true });
      expect(await wallet(vendorB.token)).toEqual(walletBefore);
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
    });

    it('concurrent callbacks for one payment apply it exactly once', async () => {
      const racing = await placeOrder([[v.A1, 1]]);
      const initiated = await initiate(racing.parentOrderId);
      const callbackPath = await decide(initiated.paymentId, 'PAY');
      const pendingBefore = d((await wallet(vendorA.token)).pendingBalance);
      const results = await Promise.all([request<Outcome>(callbackPath), request<Outcome>(callbackPath), request<Outcome>(callbackPath)]);
      for (const result of results) {
        expect(result.status).toBe(200);
        expect(result.body.outcome).toBe('PAID');
      }
      const subId = racing.subOrders[0]!.id;
      expect(await prisma.walletTransaction.count({ where: { subOrderId: subId, type: 'CREDIT_SALE_ESCROW_HOLD' } })).toBe(1);
      // 3,000,000 − 7.5% = 2,775,000
      expect(d((await wallet(vendorA.token)).pendingBalance).minus(pendingBefore).toFixed(2)).toBe('2775000.00');
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: initiated.paymentId, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);
      await expectReconciled(vendorA.vendorId);
    });

    it('limits open payment attempts per order', async () => {
      const spam = await placeOrder([[v.A1, 1]]);
      for (let i = 0; i < 5; i += 1) await initiate(spam.parentOrderId);
      const refused = await request('/payments/initiate', { method: 'POST', token: customer.token, body: { parentOrderId: spam.parentOrderId } });
      expect(refused.status).toBe(429);
    });
  });

  // ─── 6. financial overview ─────────────────────────────────────────────────

  describe('financial overview', () => {
    it('is restricted to finance staff and admins', async () => {
      expect((await request('/admin/financial/overview')).status).toBe(401);
      expect((await request('/admin/financial/overview', { token: supportToken })).status).toBe(403);
      expect((await request('/admin/financial/overview', { token: vendorA.token })).status).toBe(403);
      expect((await request('/admin/financial/overview', { token: adminToken })).status).toBe(200);
      expect((await request('/admin/financial/overview?from=2026-10-01T00:00:00Z&to=2026-09-01T00:00:00Z', { token: financeToken })).status).toBe(400);
    });

    it('matches independent aggregates of the live database and reports a consistent ledger', async () => {
      const response = await request<{
        currency: string;
        sales: { gmv: string; shippingFees: string; collectedByGateway: string };
        commission: { earned: string; pending: string; total: string };
        wallets: { escrowHeld: string; withdrawable: string; settlementHold: string; totalWithdrawn: string; ledgerConsistent: boolean; inconsistentWallets: number };
        settlements: { pendingCount: number; pendingAmount: string; paidCount: number };
        paymentsRequiringManualRefund: number;
      }>('/admin/financial/overview', { token: financeToken });
      expect(response.status).toBe(200);
      const body = response.body;
      expect(body.currency).toBe('IRR');

      const active = { parentOrder: { paymentStatus: 'PAID' as const }, status: { notIn: ['CANCELLED' as const, 'REFUNDED' as const] } };
      const gmv = await prisma.subOrder.aggregate({ where: active, _sum: { itemsSubtotal: true, shippingFee: true } });
      const earned = await prisma.subOrder.aggregate({ where: { parentOrder: { paymentStatus: 'PAID' }, status: 'DELIVERED' }, _sum: { platformCommissionAmount: true } });
      const pending = await prisma.subOrder.aggregate({
        where: { parentOrder: { paymentStatus: 'PAID' }, status: { in: ['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED'] } },
        _sum: { platformCommissionAmount: true },
      });
      const wallets = await prisma.vendorWallet.aggregate({ _sum: { pendingBalance: true, withdrawableBalance: true, settlementHoldBalance: true, totalWithdrawnAmount: true } });
      const collected = await prisma.payment.aggregate({ where: { status: 'SUCCESSFUL', purpose: 'ORDER_CHECKOUT' }, _sum: { cashAmount: true } });
      const money = (value: Prisma.Decimal | null): string => d(value ?? 0).toFixed(2);

      expect(body.sales.gmv).toBe(money(gmv._sum.itemsSubtotal));
      expect(body.sales.shippingFees).toBe(money(gmv._sum.shippingFee));
      expect(body.sales.collectedByGateway).toBe(money(collected._sum.cashAmount));
      expect(body.commission.earned).toBe(money(earned._sum.platformCommissionAmount));
      expect(body.commission.pending).toBe(money(pending._sum.platformCommissionAmount));
      expect(body.wallets.escrowHeld).toBe(money(wallets._sum.pendingBalance));
      expect(body.wallets.withdrawable).toBe(money(wallets._sum.withdrawableBalance));
      expect(body.wallets.settlementHold).toBe(money(wallets._sum.settlementHoldBalance));
      expect(body.wallets.totalWithdrawn).toBe(money(wallets._sum.totalWithdrawnAmount));
      expect(body.wallets).toMatchObject({ ledgerConsistent: true, inconsistentWallets: 0 });
      expect(body.settlements.pendingCount).toBe(await prisma.settlementRequest.count({ where: { status: { in: ['REQUESTED', 'PROCESSING'] } } }));
      expect(body.paymentsRequiringManualRefund).toBeGreaterThanOrEqual(1);
      // this suite's own contribution is visible: store A's delivered package earned 450,000 commission
      expect(d(body.commission.earned).greaterThanOrEqualTo(450_000)).toBe(true);
    });
  });

  // ─── 7. contract ───────────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every Phase 7 route under its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as { paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>; tags: Array<{ name: string }> };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/payments/initiate', 'post', 'payments'],
        ['/api/v1/payments/callback', 'get', 'payments'],
        ['/api/v1/payments/callback', 'post', 'payments'],
        ['/api/v1/sandbox/payment-page/{paymentId}', 'get', 'sandbox-payments'],
        ['/api/v1/sandbox/payment-page/{paymentId}/decision', 'post', 'sandbox-payments'],
        ['/api/v1/vendor/wallet', 'get', 'vendor-wallet'],
        ['/api/v1/vendor/wallet/transactions', 'get', 'vendor-wallet'],
        ['/api/v1/vendor/wallet/settlements', 'post', 'vendor-wallet'],
        ['/api/v1/vendor/wallet/settlements', 'get', 'vendor-wallet'],
        ['/api/v1/admin/settlements', 'get', 'admin-settlements'],
        ['/api/v1/admin/settlements/{id}/process', 'patch', 'admin-settlements'],
        ['/api/v1/admin/settlements/{id}/payout', 'post', 'admin-settlements'],
        ['/api/v1/admin/financial/overview', 'get', 'admin-financial'],
        ['/api/v1/customer/orders/{id}/sub-orders/{subOrderId}/confirm-delivery', 'post', 'customer-orders'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(2);
      }
      const tags = document.tags.map((tag) => tag.name);
      for (const tag of ['payments', 'sandbox-payments', 'vendor-wallet', 'admin-settlements', 'admin-financial']) expect(tags).toContain(tag);
    });
  });
});
```

### `apps/backend/test/schema-integrity.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import {
  CreditTransactionType,
  DisputeReason,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  SubOrderStatus,
  UserRole,
  WalletBalanceBucket,
  WalletTransactionType,
} from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Thrown at the end of a transaction to roll it back. PostgreSQL aborts an
 * entire transaction after any failed statement ("current transaction is
 * aborted"), so every negative assertion below runs in its own transaction whose
 * only job is to fail: the check proves the constraint and the rollback keeps the
 * database pristine.
 */
class Rollback extends Error {
  constructor() {
    super('intentional rollback');
    this.name = 'Rollback';
  }
}

const UNIQUE_VIOLATION = /Unique constraint failed|duplicate key value/i;
// Prisma reports referential violations as either "Foreign key constraint
// violated on the constraint: <name>" or "Foreign key constraint failed".
const FK_VIOLATION = /foreign key constraint (failed|violated)/i;

function userInput(
  mobile: string,
  role: UserRole = UserRole.CUSTOMER,
): { mobile: string; fullName: string; role: UserRole } {
  return { mobile, fullName: `کاربر ${mobile}`, role };
}

/**
 * Exercises the Phase-2 schema against the live PostgreSQL instance: relations,
 * cascade rules, SET NULL behaviour, unique constraints, immutable snapshots and
 * the ledger shapes of both the vendor wallet and the credit line.
 *
 * Nothing is left behind: every scenario runs in a transaction that is rolled
 * back, and the final test asserts the database is exactly as the seed left it.
 */
describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
  let prisma: PrismaClient;

  beforeAll(() => {
    prisma = new PrismaService(new ConfigService(process.env));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('builds the full order → sub-order → line graph with snapshots and both ledgers', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        // ── identity ────────────────────────────────────────────────────────
        const customer = await tx.user.create({ data: userInput('09990000001') });
        const address = await tx.address.create({
          data: {
            userId: customer.id,
            province: 'تهران',
            city: 'تهران',
            postalAddress: 'خیابان نمونه، پلاک ۱۲',
            postalCode: '1234567890',
            buildingNumber: '12',
            unitNumber: '3',
            recipientName: 'گیرندهٔ نمونه',
            recipientMobile: '09990000001',
            isDefault: true,
          },
        });
        await tx.customerProfile.create({
          data: { userId: customer.id, bankIban: 'IR120570000000000000000001', defaultAddressId: address.id },
        });

        // ── cart ────────────────────────────────────────────────────────────
        const cart = await tx.cart.create({ data: { userId: customer.id } });
        const variant = await tx.productVariant.findFirstOrThrow({
          where: { stockQuantity: { gt: 0 } },
          include: { product: { include: { vendor: true } } },
        });
        const quantity = 2;
        await tx.cartItem.create({
          data: { cartId: cart.id, productVariantId: variant.id, quantity, unitPriceSnapshot: variant.price },
        });

        // ── money split (Decimal arithmetic end to end, no floating point) ───
        const unitPrice = variant.price;
        const itemsSubtotal = unitPrice.mul(quantity);
        const shippingFee = new Prisma.Decimal('150000');
        const commissionRate = new Prisma.Decimal('8.00');
        const commission = itemsSubtotal.mul(commissionRate).div(100);
        const vendorEarnings = itemsSubtotal.sub(commission);
        const finalPayable = itemsSubtotal.add(shippingFee);

        const order = await tx.parentOrder.create({
          data: {
            orderNumber: 'SHP-990000001',
            userId: customer.id,
            shippingAddressSnapshot: {
              province: address.province,
              city: address.city,
              postalCode: address.postalCode,
              recipientName: address.recipientName,
              recipientMobile: address.recipientMobile,
            },
            totalItemsAmount: itemsSubtotal,
            totalShippingFee: shippingFee,
            totalDiscountAmount: '0',
            finalPayableAmount: finalPayable,
            paymentMethod: PaymentMethod.HYBRID,
            paymentStatus: 'PAID',
          },
        });

        const subOrder = await tx.subOrder.create({
          data: {
            parentOrderId: order.id,
            vendorId: variant.product.vendorId,
            subOrderNumber: 'SHP-990000001-1',
            itemsSubtotal,
            shippingFee,
            platformCommissionAmount: commission,
            vendorEarningsAmount: vendorEarnings,
            status: SubOrderStatus.DELIVERED,
            deliveredAt: new Date(),
          },
        });

        const line = await tx.orderItem.create({
          data: {
            subOrderId: subOrder.id,
            productVariantId: variant.id,
            productTitleSnapshot: variant.product.title,
            vendorStoreNameSnapshot: variant.product.vendor.storeName,
            skuSnapshot: variant.sku,
            variantDetailsSnapshot: {
              colorName: variant.colorName,
              colorHex: variant.colorHex,
              size: variant.size,
              guarantee: variant.guarantee,
            },
            unitPriceSnapshot: unitPrice,
            discountSnapshot: '0',
            commissionRateSnapshot: commissionRate,
            quantity,
            totalLineAmount: itemsSubtotal,
          },
        });

        // ── payment split: must add up to the payable amount (whole rials) ───
        const cashAmount = finalPayable.mul('0.4').floor();
        const creditAmount = finalPayable.sub(cashAmount);
        expect(cashAmount.add(creditAmount).toString()).toBe(finalPayable.toString());

        // ── vendor escrow ledger ────────────────────────────────────────────
        const wallet = await tx.vendorWallet.findFirstOrThrow({ where: { vendorId: variant.product.vendorId } });
        // Bucket ledger (Phase 7): the hold credits PENDING; the release is a
        // pair of rows (PENDING −, WITHDRAWABLE +) that sums to zero.
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            subOrderId: subOrder.id,
            type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
            bucket: WalletBalanceBucket.PENDING,
            amount: vendorEarnings,
            balanceAfter: wallet.pendingBalance.add(vendorEarnings),
            description: 'نگه‌داری وجه فروش در حساب امانی',
          },
        });
        await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            subOrderId: subOrder.id,
            type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
            bucket: WalletBalanceBucket.PENDING,
            amount: vendorEarnings.negated(),
            balanceAfter: wallet.pendingBalance,
            description: 'آزادسازی وجه پس از تأیید تحویل',
          },
        });
        const released = await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            subOrderId: subOrder.id,
            type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
            bucket: WalletBalanceBucket.WITHDRAWABLE,
            amount: vendorEarnings,
            balanceAfter: wallet.withdrawableBalance.add(vendorEarnings),
            description: 'آزادسازی وجه پس از تأیید تحویل',
          },
        });
        await tx.vendorWallet.update({
          where: { id: wallet.id },
          data: {
            withdrawableBalance: wallet.withdrawableBalance.add(vendorEarnings),
            totalEarnedBalance: wallet.totalEarnedBalance.add(vendorEarnings),
          },
        });
        await tx.subOrder.update({ where: { id: subOrder.id }, data: { escrowReleasedAt: new Date() } });
        expect(released.balanceAfter.toString()).toBe(vendorEarnings.toString());

        // ── credit line, ledger and instalments ─────────────────────────────
        const provider = await tx.creditProvider.findFirstOrThrow({ where: { isActive: true } });
        const totalLimit = new Prisma.Decimal('100000000');
        const account = await tx.creditAccount.create({
          data: {
            userId: customer.id,
            providerId: provider.id,
            totalLimit,
            usedAmount: '0',
            reservedAmount: creditAmount,
            // Consumed by the credit service at checkout; reduced as the purchase commits.
            availableAmount: totalLimit.sub(creditAmount),
            status: 'ACTIVE',
          },
        });

        await tx.creditTransaction.create({
          data: {
            creditAccountId: account.id,
            parentOrderId: order.id,
            type: CreditTransactionType.PURCHASE_RESERVE_HOLD,
            amount: creditAmount,
            balanceAfter: totalLimit.sub(creditAmount),
            referenceCode: 'SHP-990000001',
          },
        });

        const plan = await tx.installmentPlan.findFirstOrThrow({
          where: { providerId: provider.id, durationMonths: 3 },
        });
        // Phase 8 shape: a HYBRID attempt carries its credit part (account, plan, reservation ref).
        await tx.payment.create({
          data: {
            parentOrderId: order.id,
            paymentMethod: 'HYBRID',
            creditAccountId: account.id,
            installmentPlanId: plan.id,
            creditReservationRef: 'SHP-990000001',
            gatewayName: 'SANDBOX',
            gatewayTrackingToken: 'SBX-TRACK-0001',
            bankRrn: '123456789012',
            cashAmount,
            creditAmount,
            status: PaymentStatus.SUCCESSFUL,
            paidAt: new Date(),
          },
        });
        const perInstalment = creditAmount.div(plan.durationMonths).toDecimalPlaces(2);
        await tx.installmentSchedule.createMany({
          data: [1, 2, 3].map((number) => ({
            parentOrderId: order.id,
            creditAccountId: account.id,
            installmentNumber: number,
            totalInstallments: plan.durationMonths,
            dueDate: new Date(Date.UTC(2027, number, 1)),
            principalAmount: perInstalment,
            interestAmount: '0',
            totalAmount: perInstalment,
          })),
        });
        expect(await tx.installmentSchedule.count({ where: { parentOrderId: order.id } })).toBe(3);

        // ── dispute + evidence ──────────────────────────────────────────────
        const dispute = await tx.dispute.create({
          data: {
            subOrderId: subOrder.id,
            vendorId: subOrder.vendorId,
            subOrderStatusAtOpen: SubOrderStatus.DELIVERED,
            raisedByUserId: customer.id,
            reason: DisputeReason.DAMAGED,
            description: 'بسته با آسیب فیزیکی تحویل داده شد.',
          },
        });
        await tx.disputeEvidence.create({
          data: {
            disputeId: dispute.id,
            uploadedByUserId: customer.id,
            fileUrl: 'https://cdn.shopino.local/disputes/990000001/photo.jpg',
            fileType: 'image/jpeg',
            caption: 'تصویر بستهٔ آسیب‌دیده',
          },
        });

        // ── audit trail ─────────────────────────────────────────────────────
        await tx.auditLog.create({
          data: {
            userId: customer.id,
            action: 'CREATE',
            entityName: 'ParentOrder',
            entityId: order.id,
            ipAddress: '127.0.0.1',
            userAgent: 'jest-e2e',
            newValue: { orderNumber: order.orderNumber, finalPayableAmount: finalPayable.toString() },
          },
        });

        // ── invariants the service layer must preserve ──────────────────────
        const storedSubOrder = await tx.subOrder.findUniqueOrThrow({ where: { id: subOrder.id } });
        expect(storedSubOrder.platformCommissionAmount.add(storedSubOrder.vendorEarningsAmount).toString()).toBe(
          storedSubOrder.itemsSubtotal.toString(),
        );
        expect(line.productTitleSnapshot).toBe(variant.product.title);
        expect((await tx.creditAccount.findUniqueOrThrow({ where: { id: account.id } })).availableAmount.add(creditAmount).toString()).toBe(
          totalLimit.toString(),
        );

        // ── SET NULL: removing a variant keeps order history readable ───────
        await tx.productVariant.delete({ where: { id: variant.id } });
        const survivingLine = await tx.orderItem.findUniqueOrThrow({ where: { id: line.id } });
        expect(survivingLine.productVariantId).toBeNull();
        expect(survivingLine.productTitleSnapshot).toBe(variant.product.title);
        expect(survivingLine.unitPriceSnapshot.toString()).toBe(unitPrice.toString());

        // ── CASCADE: deleting the cart removes its lines ────────────────────
        await tx.cart.delete({ where: { id: cart.id } });
        expect(await tx.cartItem.count({ where: { cartId: cart.id } })).toBe(0);

        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
  });

  it('enforces unique identity and catalogue keys in the database', async () => {
    // `mobile` is the identity key (canonical E.164): a duplicate insert must be
    // rejected by SQL.
    await expect(prisma.user.create({ data: userInput('+989120000001') })).rejects.toThrow(UNIQUE_VIOLATION);

    // The same human number written the national way is a *different* string, so
    // it must be normalized before it reaches the database — this assertion is
    // what makes that rule explicit.
    await expect(prisma.user.findUnique({ where: { mobile: '09120000001' } })).resolves.toBeNull();

    // SKUs are globally unique across the catalogue.
    const variant = await prisma.productVariant.findFirstOrThrow();
    await expect(
      prisma.productVariant.create({
        data: { productId: variant.productId, sku: variant.sku, price: '1000' },
      }),
    ).rejects.toThrow(UNIQUE_VIOLATION);

    // Vendor store slugs are unique.
    const vendor = await prisma.vendor.findFirstOrThrow();
    await expect(
      prisma.vendor.create({
        data: {
          userId: vendor.userId,
          storeName: 'فروشگاه تکراری',
          storeSlug: vendor.storeSlug,
          bankIban: 'IR120570000000000000000002',
        },
      }),
    ).rejects.toThrow(UNIQUE_VIOLATION);

    // Category slugs are unique.
    const category = await prisma.category.findFirstOrThrow();
    await expect(
      prisma.category.create({
        data: { slug: category.slug, titleFa: category.titleFa, defaultCommissionRate: '10.00' },
      }),
    ).rejects.toThrow(UNIQUE_VIOLATION);
  });

  it('protects financial records with RESTRICT and removes owned children with CASCADE', async () => {
    const vendor = await prisma.vendor.findFirstOrThrow({ where: { products: { some: {} } } });

    // A vendor that sells through the platform must not be deletable: the
    // catalogue, sub-orders and wallet all point at it.
    await expect(prisma.vendor.delete({ where: { id: vendor.id } })).rejects.toThrow(FK_VIOLATION);

    // A parent order with payments cannot be deleted either.
    await expect(
      prisma.$transaction(async (tx) => {
        const owner = await tx.user.create({ data: userInput('09990000002') });
        const order = await tx.parentOrder.create({
          data: {
            orderNumber: 'SHP-990000002',
            userId: owner.id,
            shippingAddressSnapshot: { city: 'تهران' },
            totalItemsAmount: '1000',
            finalPayableAmount: '1000',
            paymentMethod: PaymentMethod.CASH_IPG,
          },
        });
        await tx.payment.create({
          data: { parentOrderId: order.id, gatewayName: 'SANDBOX', cashAmount: '1000' },
        });
        await expect(tx.parentOrder.delete({ where: { id: order.id } })).rejects.toThrow(FK_VIOLATION);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);

    // Deleting a user cascades to their addresses (owned data).
    await expect(
      prisma.$transaction(async (tx) => {
        const owner = await tx.user.create({ data: userInput('09990000003') });
        await tx.address.create({
          data: {
            userId: owner.id,
            province: 'تهران',
            city: 'تهران',
            postalAddress: 'نشانی موقت',
            postalCode: '1111111111',
            recipientName: 'گیرنده',
            recipientMobile: '09990000003',
          },
        });
        expect(await tx.address.count({ where: { userId: owner.id } })).toBe(1);
        await tx.user.delete({ where: { id: owner.id } });
        expect(await tx.address.count({ where: { userId: owner.id } })).toBe(0);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
  });

  it('rejects a duplicate instalment number inside one schedule', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        const owner = await tx.user.create({ data: userInput('09990000004') });
        const provider = await tx.creditProvider.findFirstOrThrow({ where: { isActive: true } });
        const account = await tx.creditAccount.create({
          data: {
            userId: owner.id,
            providerId: provider.id,
            totalLimit: '50000000',
            availableAmount: '50000000',
          },
        });
        const order = await tx.parentOrder.create({
          data: {
            orderNumber: 'SHP-990000003',
            userId: owner.id,
            shippingAddressSnapshot: { city: 'تهران' },
            totalItemsAmount: '1000',
            finalPayableAmount: '1000',
            paymentMethod: PaymentMethod.BANK_CREDIT,
          },
        });
        const base = {
          parentOrderId: order.id,
          creditAccountId: account.id,
          installmentNumber: 1,
          totalInstallments: 3,
          dueDate: new Date(Date.UTC(2027, 1, 1)),
          principalAmount: new Prisma.Decimal('1000'),
          totalAmount: new Prisma.Decimal('1000'),
        };
        await tx.installmentSchedule.create({ data: base });
        // (parentOrderId, installmentNumber) is unique — the second insert must fail.
        await expect(tx.installmentSchedule.create({ data: base })).rejects.toThrow(UNIQUE_VIOLATION);
        throw new Rollback();
      }),
    ).rejects.toThrow(Rollback);
  });

  it('leaves no fabricated financial data behind and keeps the seeded rows intact', async () => {
    const [
      orders,
      payments,
      lines,
      disputes,
      creditTransactions,
      creditAccounts,
      schedules,
      walletTransactions,
      settlementRequests,
      users,
      variants,
    ] = await Promise.all([
      prisma.parentOrder.count(),
      prisma.payment.count(),
      prisma.orderItem.count(),
      prisma.dispute.count(),
      prisma.creditTransaction.count(),
      prisma.creditAccount.count(),
      prisma.installmentSchedule.count(),
      prisma.walletTransaction.count(),
      prisma.settlementRequest.count(),
      prisma.user.count(),
      prisma.productVariant.count(),
    ]);

    // The rollback left nothing behind: no order, payment, ledger entry, credit
    // line or instalment exists in the database.
    expect([
      orders,
      payments,
      lines,
      disputes,
      creditTransactions,
      creditAccounts,
      schedules,
      walletTransactions,
      settlementRequests,
    ]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0]);

    // `audit_logs` is deliberately **not** asserted to be empty any more: the
    // audit engine (Phase 3) writes a row for every mutating request, including
    // the ones the other e2e suites make. The invariant that still holds is that
    // auditing is append-only — nothing here updates or deletes a trail row.

    // Seeded identity and catalogue rows are untouched: 4 users (super admin,
    // support, finance, vendor owner) and 7 catalogue variants. The auth suite
    // creates its own customers and removes them again in its cleanup.
    expect(users).toBe(4);
    expect(variants).toBe(7);
  });
});
```

## 11. Diff of changed files (vs `1438691`)

```diff
diff --git a/apps/backend/prisma/schema.prisma b/apps/backend/prisma/schema.prisma
index ce54444..2184415 100644
--- a/apps/backend/prisma/schema.prisma
+++ b/apps/backend/prisma/schema.prisma
@@ -100,6 +100,9 @@ model User {
   creditApplications    CreditApplication[]
   disputesRaised        Dispute[]
   disputeEvidence       DisputeEvidence[]
+  disputesResponded     Dispute[]               @relation("DisputeVendorResponder")
+  disputesResolved      Dispute[]               @relation("DisputeResolver")
+  disputeEvents         DisputeEvent[]
   verificationsReview   VendorVerification[]    @relation("VerificationReviewer")
   mediaAssets           MediaAsset[]            @relation("MediaAssetOwner")
   settlementsProcessed  SettlementRequest[]     @relation("SettlementProcessor")
@@ -216,6 +219,7 @@ model Vendor {
   mediaAssets        MediaAsset[]         @relation("VendorMediaAssets")
   products           Product[]
   subOrders          SubOrder[]
+  disputes           Dispute[]
   wallet             VendorWallet?
   settlementRequests SettlementRequest[]
 
@@ -372,7 +376,8 @@ model MediaAsset {
   isPublic        Boolean   @default(false) @map("is_public")
   createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
 
-  productMedia ProductMedia[]
+  productMedia    ProductMedia[]
+  disputeEvidence DisputeEvidence[]
 
   @@index([ownerUserId, kind, createdAt])
   @@index([vendorId, purpose])
@@ -613,6 +618,10 @@ enum WalletTransactionType {
   SETTLEMENT_HOLD
   /// Settlement hold → withdrawable when finance rejects the request.
   SETTLEMENT_HOLD_RELEASE
+  /// Escrow (PENDING) or WITHDRAWABLE → DISPUTE_HOLD when a customer opens a dispute (Phase 9).
+  DISPUTE_HOLD_LOCK
+  /// DISPUTE_HOLD → WITHDRAWABLE (vendor favour) or back to its source bucket (dispute cancelled).
+  DISPUTE_HOLD_RELEASE
 }
 
 /// Balance bucket of a vendor wallet a ledger row moves money in.
@@ -620,6 +629,8 @@ enum WalletBalanceBucket {
   PENDING
   WITHDRAWABLE
   SETTLEMENT_HOLD
+  /// Earnings frozen while a dispute about the package is open (Phase 9).
+  DISPUTE_HOLD
 }
 
 enum SettlementStatus {
@@ -691,6 +702,8 @@ model VendorWallet {
   pendingBalance        Decimal  @default(0) @map("pending_balance") @db.Decimal(15, 2)
   withdrawableBalance   Decimal  @default(0) @map("withdrawable_balance") @db.Decimal(15, 2)
   settlementHoldBalance Decimal  @default(0) @map("settlement_hold_balance") @db.Decimal(15, 2)
+  /// Earnings frozen by open disputes; never withdrawable (Phase 9).
+  disputeHoldBalance    Decimal  @default(0) @map("dispute_hold_balance") @db.Decimal(15, 2)
   totalEarnedBalance    Decimal  @default(0) @map("total_earned_balance") @db.Decimal(15, 2)
   totalWithdrawnAmount  Decimal  @default(0) @map("total_withdrawn_amount") @db.Decimal(15, 2)
   createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
@@ -718,6 +731,9 @@ model WalletTransaction {
   subOrder            SubOrder?             @relation(fields: [subOrderId], references: [id], onDelete: SetNull)
   settlementRequestId String?               @map("settlement_request_id") @db.Uuid
   settlementRequest   SettlementRequest?    @relation(fields: [settlementRequestId], references: [id], onDelete: SetNull)
+  /// Dispute whose freeze / resolution produced this row (Phase 9).
+  disputeId           String?               @map("dispute_id") @db.Uuid
+  dispute             Dispute?              @relation(fields: [disputeId], references: [id], onDelete: SetNull)
   type                WalletTransactionType
   bucket              WalletBalanceBucket
   amount              Decimal               @db.Decimal(15, 2)
@@ -729,6 +745,7 @@ model WalletTransaction {
   @@index([walletId, bucket])
   @@index([subOrderId])
   @@index([settlementRequestId])
+  @@index([disputeId])
   @@map("wallet_transactions")
 }
 
@@ -975,48 +992,128 @@ enum DisputeStatus {
   CANCELLED
 }
 
+/// What the vendor answered to a dispute (Phase 9).
+enum DisputeVendorAction {
+  ACCEPT_RETURN
+  REJECT_WITH_DEFENSE
+}
+
+/// Entries of a dispute's append-only timeline (Phase 9).
+enum DisputeEventType {
+  OPENED
+  EVIDENCE_ADDED
+  VENDOR_ACCEPTED_RETURN
+  VENDOR_DEFENDED
+  ARBITRATED_BUYER_FAVOR
+  ARBITRATED_VENDOR_FAVOR
+  CANCELLED_BY_CUSTOMER
+  REFUND_NOTICE_SENT
+  REFUND_NOTICE_FAILED
+}
+
 /// Complaint raised by a customer about one vendor's slice of an order.
-/// Disputes live as long as the sub-order they belong to.
+/// Disputes live as long as the sub-order they belong to. At most one dispute
+/// per sub-order is active (OPEN / VENDOR_RESPONDED / UNDER_ARBITRATION) —
+/// enforced by a partial unique index (migration phase9_disputes).
+///
+/// Escrow freeze (Phase 9): on opening, the package's earnings move into the
+/// vendor wallet's DISPUTE_HOLD bucket — from PENDING if not delivered yet, or
+/// from WITHDRAWABLE (as much as is there) if already delivered. `holdSource`,
+/// `holdAmount` and `holdShortfall` record exactly what was frozen, so the
+/// resolution moves back or refunds precisely that amount.
 model Dispute {
-  id              String        @id @default(uuid()) @db.Uuid
-  subOrderId      String        @map("sub_order_id") @db.Uuid
-  subOrder        SubOrder      @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
-  raisedByUserId  String        @map("raised_by_user_id") @db.Uuid
-  raisedBy        User          @relation(fields: [raisedByUserId], references: [id], onDelete: Restrict)
-  reason          DisputeReason
-  description     String        @db.Text
-  status          DisputeStatus @default(OPEN)
-  resolutionNotes String?       @map("resolution_notes") @db.Text
-  resolvedAt      DateTime?     @map("resolved_at") @db.Timestamptz(3)
-  createdAt       DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
-  updatedAt       DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)
-
-  evidence DisputeEvidence[]
+  id                      String               @id @default(uuid()) @db.Uuid
+  subOrderId              String               @map("sub_order_id") @db.Uuid
+  subOrder                SubOrder             @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
+  /// Store the dispute is against (denormalised from the sub-order for the vendor panel).
+  vendorId                String               @map("vendor_id") @db.Uuid
+  vendor                  Vendor               @relation(fields: [vendorId], references: [id], onDelete: Restrict)
+  raisedByUserId          String               @map("raised_by_user_id") @db.Uuid
+  raisedBy                User                 @relation(fields: [raisedByUserId], references: [id], onDelete: Restrict)
+  reason                  DisputeReason
+  description             String               @db.Text
+  status                  DisputeStatus        @default(OPEN)
+  /// Package status when the dispute was opened (PROCESSING / SHIPPED / DELIVERED).
+  subOrderStatusAtOpen    SubOrderStatus       @map("sub_order_status_at_open")
+  /// Bucket the frozen earnings came from: PENDING or WITHDRAWABLE; null when nothing could be frozen.
+  holdSource              WalletBalanceBucket? @map("hold_source")
+  holdAmount              Decimal              @default(0) @map("hold_amount") @db.Decimal(15, 2)
+  /// Earnings that could not be frozen because the vendor had already withdrawn them.
+  holdShortfall           Decimal              @default(0) @map("hold_shortfall") @db.Decimal(15, 2)
+  vendorAction            DisputeVendorAction? @map("vendor_action")
+  vendorDefenseNotes      String?              @map("vendor_defense_notes") @db.Text
+  vendorRespondedAt       DateTime?            @map("vendor_responded_at") @db.Timestamptz(3)
+  vendorRespondedByUserId String?              @map("vendor_responded_by_user_id") @db.Uuid
+  vendorRespondedBy       User?                @relation("DisputeVendorResponder", fields: [vendorRespondedByUserId], references: [id], onDelete: SetNull)
+  resolutionNotes         String?              @map("resolution_notes") @db.Text
+  resolvedAt              DateTime?            @map("resolved_at") @db.Timestamptz(3)
+  resolvedByUserId        String?              @map("resolved_by_user_id") @db.Uuid
+  resolvedBy              User?                @relation("DisputeResolver", fields: [resolvedByUserId], references: [id], onDelete: SetNull)
+  /// Buyer-favour only: whether the goods came back (drives restocking of shipped packages).
+  itemReturned            Boolean?             @map("item_returned")
+  restocked               Boolean              @default(false)
+  /// Buyer-favour only: amount owed back to the customer (package items + shipping).
+  refundAmount            Decimal?             @map("refund_amount") @db.Decimal(15, 2)
+  /// Buyer-favour only: vendor earnings that could not be recovered from the wallet (vendor debt).
+  refundUnrecoveredAmount Decimal              @default(0) @map("refund_unrecovered_amount") @db.Decimal(15, 2)
+  cancelledAt             DateTime?            @map("cancelled_at") @db.Timestamptz(3)
+  createdAt               DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
+  updatedAt               DateTime             @updatedAt @map("updated_at") @db.Timestamptz(3)
+
+  evidence           DisputeEvidence[]
+  events             DisputeEvent[]
+  walletTransactions WalletTransaction[]
 
   @@index([subOrderId])
   @@index([status, createdAt])
   @@index([raisedByUserId, createdAt])
+  @@index([vendorId, status, createdAt])
   @@map("disputes")
 }
 
 /// Uploaded proof for a dispute (photo, invoice, chat export). The uploader is
 /// recorded separately from the raiser because staff and vendors may add files.
+/// Since Phase 9 every row references the uploader's own media asset.
 model DisputeEvidence {
-  id               String   @id @default(uuid()) @db.Uuid
-  disputeId        String   @map("dispute_id") @db.Uuid
-  dispute          Dispute  @relation(fields: [disputeId], references: [id], onDelete: Cascade)
-  uploadedByUserId String   @map("uploaded_by_user_id") @db.Uuid
-  uploadedBy       User     @relation(fields: [uploadedByUserId], references: [id], onDelete: Restrict)
-  fileUrl          String   @map("file_url") @db.VarChar(512)
-  fileType         String?  @map("file_type") @db.VarChar(40)
-  caption          String?  @db.VarChar(255)
-  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
-
+  id               String      @id @default(uuid()) @db.Uuid
+  disputeId        String      @map("dispute_id") @db.Uuid
+  dispute          Dispute     @relation(fields: [disputeId], references: [id], onDelete: Cascade)
+  uploadedByUserId String      @map("uploaded_by_user_id") @db.Uuid
+  uploadedBy       User        @relation(fields: [uploadedByUserId], references: [id], onDelete: Restrict)
+  mediaAssetId     String?     @map("media_asset_id") @db.Uuid
+  mediaAsset       MediaAsset? @relation(fields: [mediaAssetId], references: [id], onDelete: SetNull)
+  fileUrl          String      @map("file_url") @db.VarChar(512)
+  fileType         String?     @map("file_type") @db.VarChar(40)
+  caption          String?     @db.VarChar(255)
+  createdAt        DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)
+
+  @@unique([disputeId, mediaAssetId])
   @@index([disputeId, createdAt])
   @@index([uploadedByUserId])
+  @@index([mediaAssetId])
   @@map("dispute_evidence")
 }
 
+/// Append-only timeline of a dispute: who did what, when, and the status change.
+model DisputeEvent {
+  id          String           @id @default(uuid()) @db.Uuid
+  disputeId   String           @map("dispute_id") @db.Uuid
+  dispute     Dispute          @relation(fields: [disputeId], references: [id], onDelete: Cascade)
+  type        DisputeEventType
+  actorUserId String?          @map("actor_user_id") @db.Uuid
+  actorUser   User?            @relation(fields: [actorUserId], references: [id], onDelete: SetNull)
+  /// CUSTOMER / VENDOR / STAFF / SYSTEM.
+  actorRole   String           @map("actor_role") @db.VarChar(20)
+  fromStatus  DisputeStatus?   @map("from_status")
+  toStatus    DisputeStatus?   @map("to_status")
+  note        String?          @db.VarChar(1000)
+  data        Json?
+  createdAt   DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
+
+  @@index([disputeId, createdAt])
+  @@map("dispute_events")
+}
+
 // ============================================================================
 // PLATFORM CONFIGURATION (Phase 1)
 // ============================================================================
diff --git a/apps/backend/src/app.module.ts b/apps/backend/src/app.module.ts
index a2b5128..a60fa47 100644
--- a/apps/backend/src/app.module.ts
+++ b/apps/backend/src/app.module.ts
@@ -23,6 +23,7 @@ import { AddressesModule } from './modules/addresses/addresses.module';
 import { CartModule } from './modules/cart/cart.module';
 import { BnplModule } from './modules/bnpl/bnpl.module';
 import { CreditModule } from './modules/credit/credit.module';
+import { DisputesModule } from './modules/disputes/disputes.module';
 import { FinancialModule } from './modules/financial/financial.module';
 import { OrdersModule } from './modules/orders/orders.module';
 import { PaymentsModule } from './modules/payments/payments.module';
@@ -64,6 +65,7 @@ import { WalletModule } from './modules/wallet/wallet.module';
     FinancialModule,
     CreditModule,
     BnplModule,
+    DisputesModule,
   ],
   providers: [
     // Order matters: authentication runs first and populates `request.user`,
diff --git a/apps/backend/src/modules/financial/dto/financial.dto.ts b/apps/backend/src/modules/financial/dto/financial.dto.ts
index 88995e0..36aefa8 100644
--- a/apps/backend/src/modules/financial/dto/financial.dto.ts
+++ b/apps/backend/src/modules/financial/dto/financial.dto.ts
@@ -38,6 +38,7 @@ export class WalletFiguresDto {
   @ApiProperty({ ...MONEY, description: 'Escrow held: sum of all vendors’ pendingBalance.' }) escrowHeld!: string;
   @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ withdrawableBalance.' }) withdrawable!: string;
   @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ settlementHoldBalance (open requests).' }) settlementHold!: string;
+  @ApiProperty({ ...MONEY, description: 'Sum of all vendors’ disputeHoldBalance: earnings frozen by open disputes (Phase 9).' }) disputeHold!: string;
   @ApiProperty({ ...MONEY, description: 'Lifetime PAYA payouts.' }) totalWithdrawn!: string;
   @ApiProperty({ description: 'True when, for every wallet and bucket, the ledger sum equals the balance column.' }) ledgerConsistent!: boolean;
   @ApiProperty({ description: 'Wallets whose balances do not match their ledger (should always be 0).' }) inconsistentWallets!: number;
@@ -50,6 +51,16 @@ export class SettlementFiguresDto {
   @ApiProperty(MONEY) paidAmount!: string;
 }
 
+export class DisputeFiguresDto {
+  @ApiProperty({ description: 'Disputes waiting for the vendor (OPEN / VENDOR_RESPONDED).' }) open!: number;
+  @ApiProperty({ description: 'Disputes waiting for a staff decision (UNDER_ARBITRATION).' }) underArbitration!: number;
+  @ApiProperty({ description: 'Disputes resolved for the customer in the window (resolvedAt).' }) resolvedForBuyer!: number;
+  @ApiProperty({ ...MONEY, description: 'Amount owed back to customers by those resolutions (package items + shipping); refunded manually by finance.' })
+  refundsOwedToCustomers!: string;
+  @ApiProperty({ ...MONEY, description: 'Vendor earnings those resolutions could not recover from the wallet (already withdrawn).' })
+  unrecoveredVendorEarnings!: string;
+}
+
 export class FinancialOverviewDto {
   @ApiProperty({ example: 'IRR' }) currency!: string;
   @ApiProperty({ nullable: true, type: Date }) from!: Date | null;
@@ -61,4 +72,5 @@ export class FinancialOverviewDto {
   @ApiProperty({ type: SettlementFiguresDto }) settlements!: SettlementFiguresDto;
   @ApiProperty({ description: 'Captured payments whose order was already paid/closed; finance must refund them manually.' })
   paymentsRequiringManualRefund!: number;
+  @ApiProperty({ type: DisputeFiguresDto }) disputes!: DisputeFiguresDto;
 }
diff --git a/apps/backend/src/modules/financial/financial.service.ts b/apps/backend/src/modules/financial/financial.service.ts
index ea510b5..dad97fa 100644
--- a/apps/backend/src/modules/financial/financial.service.ts
+++ b/apps/backend/src/modules/financial/financial.service.ts
@@ -23,9 +23,10 @@ export class FinancialService {
     }
     const paidWindow = Prisma.sql`${from ? Prisma.sql`AND po.paid_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND po.paid_at < ${to}` : Prisma.empty}`;
     const processedWindow = Prisma.sql`${from ? Prisma.sql`AND processed_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND processed_at < ${to}` : Prisma.empty}`;
+    const resolvedWindow = Prisma.sql`${from ? Prisma.sql`AND resolved_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND resolved_at < ${to}` : Prisma.empty}`;
     const paymentWindow = Prisma.sql`${from ? Prisma.sql`AND paid_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND paid_at < ${to}` : Prisma.empty}`;
 
-    const [sales, collected, wallets, reconciliation, settlements, manualRefunds] = await this.prisma.$transaction([
+    const [sales, collected, wallets, reconciliation, settlements, manualRefunds, disputes] = await this.prisma.$transaction([
       this.prisma.$queryRaw<Array<{ paid_orders: bigint; active_packages: bigint; gmv: Money; shipping: Money; commission_earned: Money; commission_pending: Money }>>(Prisma.sql`
         SELECT COUNT(DISTINCT po.id) AS paid_orders,
                COUNT(so.id) FILTER (WHERE so.status NOT IN ('CANCELLED', 'REFUNDED')) AS active_packages,
@@ -41,19 +42,20 @@ export class FinancialService {
                SUM(credit_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS funded_by_credit,
                SUM(cash_amount) FILTER (WHERE purpose = 'INSTALLMENT_REPAYMENT') AS installments_collected
         FROM payments WHERE status = 'SUCCESSFUL' ${paymentWindow}`),
-      this.prisma.$queryRaw<Array<{ pending: Money; withdrawable: Money; hold: Money; withdrawn: Money }>>(Prisma.sql`
+      this.prisma.$queryRaw<Array<{ pending: Money; withdrawable: Money; hold: Money; dispute_hold: Money; withdrawn: Money }>>(Prisma.sql`
         SELECT SUM(pending_balance) AS pending, SUM(withdrawable_balance) AS withdrawable,
-               SUM(settlement_hold_balance) AS hold, SUM(total_withdrawn_amount) AS withdrawn
+               SUM(settlement_hold_balance) AS hold, SUM(dispute_hold_balance) AS dispute_hold, SUM(total_withdrawn_amount) AS withdrawn
         FROM vendor_wallets`),
       this.prisma.$queryRaw<Array<{ inconsistent: bigint }>>(Prisma.sql`
         SELECT COUNT(*) AS inconsistent FROM (
           SELECT w.id
           FROM vendor_wallets w
           LEFT JOIN wallet_transactions t ON t.wallet_id = w.id
-          GROUP BY w.id, w.pending_balance, w.withdrawable_balance, w.settlement_hold_balance
+          GROUP BY w.id, w.pending_balance, w.withdrawable_balance, w.settlement_hold_balance, w.dispute_hold_balance
           HAVING COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'PENDING'), 0) <> w.pending_balance
               OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'WITHDRAWABLE'), 0) <> w.withdrawable_balance
               OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'SETTLEMENT_HOLD'), 0) <> w.settlement_hold_balance
+              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'DISPUTE_HOLD'), 0) <> w.dispute_hold_balance
         ) AS drift`),
       this.prisma.$queryRaw<Array<{ pending_count: bigint; pending_amount: Money; paid_count: bigint; paid_amount: Money }>>(Prisma.sql`
         SELECT COUNT(*) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS pending_count,
@@ -63,7 +65,15 @@ export class FinancialService {
         FROM settlement_requests`),
       this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
         SELECT COUNT(*) AS count FROM payments WHERE status = 'SUCCESSFUL' AND metadata ->> 'requiresManualRefund' = 'true'`),
+      this.prisma.$queryRaw<Array<{ open_count: bigint; arbitration_count: bigint; buyer_favor_count: bigint; refunds_owed: Money; unrecovered: Money }>>(Prisma.sql`
+        SELECT COUNT(*) FILTER (WHERE status IN ('OPEN', 'VENDOR_RESPONDED')) AS open_count,
+               COUNT(*) FILTER (WHERE status = 'UNDER_ARBITRATION') AS arbitration_count,
+               COUNT(*) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS buyer_favor_count,
+               SUM(refund_amount) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS refunds_owed,
+               SUM(refund_unrecovered_amount) FILTER (WHERE status = 'RESOLVED_BUYER_FAVOR' ${resolvedWindow}) AS unrecovered
+        FROM disputes`),
     ]);
+    const dq = disputes[0];
 
     const s = sales[0];
     const w = wallets[0];
@@ -90,6 +100,7 @@ export class FinancialService {
         escrowHeld: money(w?.pending ?? null),
         withdrawable: money(w?.withdrawable ?? null),
         settlementHold: money(w?.hold ?? null),
+        disputeHold: money(w?.dispute_hold ?? null),
         totalWithdrawn: money(w?.withdrawn ?? null),
         ledgerConsistent: inconsistentWallets === 0,
         inconsistentWallets,
@@ -101,6 +112,13 @@ export class FinancialService {
         paidAmount: money(st?.paid_amount ?? null),
       },
       paymentsRequiringManualRefund: Number(manualRefunds[0]?.count ?? 0),
+      disputes: {
+        open: Number(dq?.open_count ?? 0),
+        underArbitration: Number(dq?.arbitration_count ?? 0),
+        resolvedForBuyer: Number(dq?.buyer_favor_count ?? 0),
+        refundsOwedToCustomers: money(dq?.refunds_owed ?? null),
+        unrecoveredVendorEarnings: money(dq?.unrecovered ?? null),
+      },
     };
   }
 }
diff --git a/apps/backend/src/modules/media/media.controller.ts b/apps/backend/src/modules/media/media.controller.ts
index 4d3c48c..0aef6b6 100644
--- a/apps/backend/src/modules/media/media.controller.ts
+++ b/apps/backend/src/modules/media/media.controller.ts
@@ -58,6 +58,8 @@ const DOCUMENT_PURPOSES = new Set([
   'kyc_national_id',
   'kyc_business_license',
   'kyc_bank_proof',
+  /** Proof attached to a dispute (Phase 9): private; readable by the dispute's buyer, vendor and staff. */
+  'dispute_evidence',
   'other',
 ]);
 
diff --git a/apps/backend/src/modules/media/media.service.spec.ts b/apps/backend/src/modules/media/media.service.spec.ts
index 72affa6..58cb0ba 100644
--- a/apps/backend/src/modules/media/media.service.spec.ts
+++ b/apps/backend/src/modules/media/media.service.spec.ts
@@ -57,8 +57,11 @@ function createPrismaFake(): {
   service: PrismaService;
   rows: Map<string, AssetRow>;
   setOwner: (id: string, ownerUserId: string) => void;
+  shareAsEvidence: (mediaAssetId: string, partyUserIds: string[]) => void;
 } {
   const rows = new Map<string, AssetRow>();
+  /** `dispute_evidence` rows: asset → user ids of the dispute's parties (customer, store owner). */
+  const evidence: Array<{ mediaAssetId: string; parties: string[] }> = [];
   const owners = new Map<string, string>();
   let counter = 0;
 
@@ -66,6 +69,13 @@ function createPrismaFake(): {
     owners.has(row.id) ? { ...row, ownerUserId: owners.get(row.id) ?? null } : row;
 
   const service = {
+    disputeEvidence: {
+      count: (args: { where: { mediaAssetId: string; dispute: { OR: Array<{ raisedByUserId?: string; vendor?: { userId: string } }> } } }): Promise<number> => {
+        const callers = args.where.dispute.OR.map((clause) => clause.raisedByUserId ?? clause.vendor?.userId);
+        const hits = evidence.filter((row) => row.mediaAssetId === args.where.mediaAssetId && row.parties.some((party) => callers.includes(party)));
+        return Promise.resolve(hits.length);
+      },
+    },
     mediaAsset: {
       create: (args: { data: Record<string, unknown> }): Promise<AssetRow> => {
         counter += 1;
@@ -131,6 +141,9 @@ function createPrismaFake(): {
     setOwner: (id: string, ownerUserId: string): void => {
       owners.set(id, ownerUserId);
     },
+    shareAsEvidence: (mediaAssetId: string, partyUserIds: string[]): void => {
+      evidence.push({ mediaAssetId, parties: partyUserIds });
+    },
   };
 }
 
@@ -521,6 +534,19 @@ describe('MediaService (real Sharp, real filesystem, fake Prisma)', () => {
     ).toBe(false);
   });
 
+  it('grants dispute evidence to both parties of the dispute and to nobody else (Phase 9)', async () => {
+    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x20)]);
+    const uploaded = await service.uploadDocument(upload(pdf, 'photo.pdf', 'application/pdf'), { ownerUserId: OWNER, purpose: 'dispute_evidence' });
+    const asset = (await service.findAsset(uploaded.id)) as MediaAssetView;
+    prismaFake.setOwner(asset.id, OWNER);
+
+    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'store-owner', role: UserRole.VENDOR } })).toBe(false);
+    prismaFake.shareAsEvidence(asset.id, [OWNER, 'store-owner']);
+    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'store-owner', role: UserRole.VENDOR } })).toBe(true);
+    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'other-store', role: UserRole.VENDOR } })).toBe(false);
+    expect(await service.canAccessPrivateAsset({ asset, user: { id: 'other-customer', role: UserRole.CUSTOMER } })).toBe(false);
+  });
+
   it('serves a public file as cacheable and a private one as no-store, with hardening headers', async () => {
     const source = await png(500, 500);
     const uploaded = await service.uploadImage(upload(source, 'logo.png', 'image/png'), {
diff --git a/apps/backend/src/modules/media/media.service.ts b/apps/backend/src/modules/media/media.service.ts
index e0678ce..e19a315 100644
--- a/apps/backend/src/modules/media/media.service.ts
+++ b/apps/backend/src/modules/media/media.service.ts
@@ -390,7 +390,19 @@ export class MediaService {
       return true;
     }
 
-    return STAFF_ROLES_WITH_KYC_ACCESS.has(params.user.role);
+    if (STAFF_ROLES_WITH_KYC_ACCESS.has(params.user.role)) {
+      return true;
+    }
+
+    // Dispute evidence (Phase 9): both parties of the dispute may read it — the
+    // customer who raised it and the owner of the store it is against.
+    const sharedAsEvidence = await this.prisma.disputeEvidence.count({
+      where: {
+        mediaAssetId: params.asset.id,
+        dispute: { OR: [{ raisedByUserId: params.user.id }, { vendor: { userId: params.user.id } }] },
+      },
+    });
+    return sharedAsEvidence > 0;
   }
 
   /**
diff --git a/apps/backend/src/modules/orders/dto/order-response.dto.ts b/apps/backend/src/modules/orders/dto/order-response.dto.ts
index 584e3c6..236c2c4 100644
--- a/apps/backend/src/modules/orders/dto/order-response.dto.ts
+++ b/apps/backend/src/modules/orders/dto/order-response.dto.ts
@@ -1,3 +1,4 @@
+import type { WalletAction } from '../order-lifecycle.service';
 import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
 import { ParentOrderPaymentStatus, PaymentMethod, SubOrderStatus } from '@prisma/client';
 
@@ -187,12 +188,13 @@ export class SubOrderTransitionResultDto {
   @ApiProperty({ enum: ['RESTOCKED', 'NONE'], description: 'What happened to the stock of the package lines.' })
   stockAction!: 'RESTOCKED' | 'NONE';
   @ApiProperty({
-    enum: ['ESCROW_RELEASED', 'ESCROW_REVERSED', 'EARNINGS_REVERSED', 'NONE'],
+    enum: ['ESCROW_RELEASED', 'ESCROW_REVERSED', 'EARNINGS_REVERSED', 'DISPUTE_HOLD_REFUNDED', 'DISPUTE_HOLD_RELEASED', 'NONE'],
     description:
       'Wallet consequence: ESCROW_RELEASED (delivered → withdrawable), ESCROW_REVERSED (cancel/refund before delivery, out of escrow), ' +
-      'EARNINGS_REVERSED (refund after delivery, out of the withdrawable balance), NONE.',
+      'EARNINGS_REVERSED (refund after delivery, out of the withdrawable balance), NONE. The DISPUTE_HOLD_* values are produced only by ' +
+      'dispute resolutions (Phase 9): the frozen earnings were refunded or released to the vendor.',
   })
-  walletAction!: 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'NONE';
+  walletAction!: WalletAction;
   @ApiProperty({ format: 'uuid' }) auditLogId!: string;
 }
 
diff --git a/apps/backend/src/modules/orders/order-audit.ts b/apps/backend/src/modules/orders/order-audit.ts
index 574ab53..97c3af9 100644
--- a/apps/backend/src/modules/orders/order-audit.ts
+++ b/apps/backend/src/modules/orders/order-audit.ts
@@ -23,7 +23,7 @@ export async function writeOrderAudit(
   actor: OrderActor,
   entry: {
     action: AuditAction;
-    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest' | 'CreditApplication' | 'CreditAccount' | 'InstallmentSchedule';
+    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest' | 'CreditApplication' | 'CreditAccount' | 'InstallmentSchedule' | 'Dispute';
     entityId: string;
     oldValue?: Record<string, unknown>;
     newValue: Record<string, unknown>;
diff --git a/apps/backend/src/modules/orders/order-lifecycle.service.ts b/apps/backend/src/modules/orders/order-lifecycle.service.ts
index ec3e88e..b1a599d 100644
--- a/apps/backend/src/modules/orders/order-lifecycle.service.ts
+++ b/apps/backend/src/modules/orders/order-lifecycle.service.ts
@@ -1,6 +1,6 @@
 import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { ConfigService } from '@nestjs/config';
-import { AuditAction, ParentOrderPaymentStatus, PaymentMethod, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
+import { AuditAction, DisputeStatus, ParentOrderPaymentStatus, PaymentMethod, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
 import { conflictWith } from '../../common/http-errors';
 import type { EnvironmentVariables } from '../../config/env.validation';
 import { PrismaService } from '../../infra/prisma/prisma.service';
@@ -22,15 +22,39 @@ const UNPAID_OUTCOME: Record<UnpaidOutcome, { status: ParentOrderPaymentStatus;
   PAYMENT_EXPIRED: { status: ParentOrderPaymentStatus.CANCELLED, role: 'SYSTEM', defaultReason: 'Payment was not completed in time' },
 };
 
+/**
+ * Wallet consequence of a package transition: escrow released on delivery, the
+ * vendor's earnings reversed on cancel/refund, or — for dispute resolutions
+ * (Phase 9) — the frozen earnings refunded or released.
+ */
+export type WalletAction = 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'DISPUTE_HOLD_REFUNDED' | 'DISPUTE_HOLD_RELEASED' | 'NONE';
+
 export interface TransitionResult {
   subOrderId: string;
   previousStatus: SubOrderStatus;
   stockAction: 'RESTOCKED' | 'NONE';
-  /** Wallet consequence: escrow released on delivery, or the vendor's earnings reversed on cancel/refund. */
-  walletAction: 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'NONE';
+  walletAction: WalletAction;
   auditLogId: string;
 }
 
+/** Disputes that still freeze their package (Phase 9). */
+export const ACTIVE_DISPUTE_STATUSES: readonly DisputeStatus[] = [DisputeStatus.OPEN, DisputeStatus.VENDOR_RESPONDED, DisputeStatus.UNDER_ARBITRATION];
+
+/** Package fields a dispute resolution receives (the row read under the parent-order lock). */
+export type DisputedPackage = TransitionRow;
+
+/**
+ * How a dispute resolution overrides the default consequences of a transition:
+ * the stock decision and the wallet movement come from the dispute, not from
+ * the status change (the escrow is frozen in DISPUTE_HOLD, which the default
+ * release/reverse refuse to touch).
+ */
+export interface DisputeOutcome {
+  restock: boolean;
+  wallet: (tx: Tx, sub: DisputedPackage) => Promise<WalletAction>;
+  audit: Record<string, unknown>;
+}
+
 /** What confirming a payment did; `applied: false` means the order was no longer PENDING. */
 export interface PaymentApplication {
   applied: boolean;
@@ -308,6 +332,50 @@ export class OrderLifecycleService {
     });
   }
 
+  // ─── disputes (Phase 9) ─────────────────────────────────────────────────
+
+  /**
+   * Applies a dispute decision to its package, inside the caller's transaction
+   * (which already holds the parent-order lock): REFUNDED for the buyer,
+   * DELIVERED for the vendor. A package that is already DELIVERED keeps its
+   * status; only the wallet movement and the audit row are written.
+   *
+   * Credit-funded packages cannot be refunded yet (CREDIT_ORDER_REFUND_UNSUPPORTED,
+   * same rule as every other refund path).
+   */
+  async applyDisputeOutcomeLocked(
+    tx: Tx,
+    subOrderId: string,
+    target: typeof SubOrderStatus.REFUNDED | typeof SubOrderStatus.DELIVERED,
+    meta: { role: ActorRole; note: string; actor: OrderActor },
+    outcome: DisputeOutcome,
+  ): Promise<TransitionResult> {
+    const sub = await this.loadForTransition(tx, subOrderId);
+    if (!sub) {
+      throw new NotFoundException('Sub-order not found');
+    }
+    if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID) {
+      throw conflictWith('ORDER_NOT_PAID', 'Only packages of paid orders can be resolved', { paymentStatus: sub.parentOrder.paymentStatus });
+    }
+    if (sub.status === target) {
+      const walletAction = await outcome.wallet(tx, sub);
+      const auditLogId = await writeOrderAudit(tx, meta.actor, {
+        action: AuditAction.DISPUTE_RESOLUTION,
+        entityName: 'SubOrder',
+        entityId: sub.id,
+        oldValue: { status: sub.status },
+        newValue: { status: target, subOrderNumber: sub.subOrderNumber, actorRole: meta.role, note: meta.note, stockAction: 'NONE', walletAction, ...outcome.audit },
+      });
+      return { subOrderId: sub.id, previousStatus: sub.status, stockAction: 'NONE', walletAction, auditLogId };
+    }
+    if (!canStaffForce(sub.status, target)) {
+      throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be resolved to ${target}`, { currentStatus: sub.status });
+    }
+    const data: Prisma.SubOrderUpdateManyMutationInput =
+      target === SubOrderStatus.DELIVERED ? { status: target, deliveredAt: new Date() } : { status: target };
+    return this.applyTransition(tx, sub, target, data, meta, outcome);
+  }
+
   // ─── internals ────────────────────────────────────────────────────────────
 
   private async lockPending(tx: Tx, parentOrderId: string): Promise<{ id: string; paymentExpiresAt: Date | null } | null> {
@@ -398,7 +466,18 @@ export class OrderLifecycleService {
     target: SubOrderStatus,
     data: Prisma.SubOrderUpdateManyMutationInput,
     meta: { role: ActorRole; note: string | null; actor: OrderActor },
+    dispute?: DisputeOutcome,
   ): Promise<TransitionResult> {
+    if (!dispute) {
+      // Escrow freeze (Phase 9): while a dispute is active, the package changes only through the dispute.
+      const active = await tx.dispute.findFirst({ where: { subOrderId: sub.id, status: { in: [...ACTIVE_DISPUTE_STATUSES] } }, select: { id: true, status: true } });
+      if (active) {
+        throw conflictWith('SUB_ORDER_UNDER_DISPUTE', 'This package has an active dispute; it can only change through the dispute resolution', {
+          disputeId: active.id,
+          disputeStatus: active.status,
+        });
+      }
+    }
     if ((target === SubOrderStatus.CANCELLED || target === SubOrderStatus.REFUNDED) && sub.parentOrder.paymentMethod !== PaymentMethod.CASH_IPG) {
       // Returning bank credit (REFUND_RESTORE, schedule adjustment, provider refund API) is not in the Phase 8 scope.
       throw conflictWith(
@@ -412,18 +491,18 @@ export class OrderLifecycleService {
     if (updated.count !== 1) {
       throw conflictWith('CONCURRENT_UPDATE', 'The package was changed by someone else; reload and try again');
     }
-    const restock = paidStockEffect(sub.status, target) === 'RESTOCK';
+    const restock = dispute ? dispute.restock : paidStockEffect(sub.status, target) === 'RESTOCK';
     if (restock) {
       for (const move of stockMovements(sub.items)) {
         await this.inventory.adjustStock(move.variantId, move.quantity, tx);
       }
     }
-    const walletAction = await this.applyWalletEffect(tx, sub, target, meta.note);
+    const walletAction = dispute ? await dispute.wallet(tx, sub) : await this.applyWalletEffect(tx, sub, target, meta.note);
     await tx.subOrderStatusHistory.create({
       data: { subOrderId: sub.id, fromStatus: sub.status, toStatus: target, actorUserId: meta.actor.actorId, actorRole: meta.role, note: meta.note },
     });
     const auditLogId = await writeOrderAudit(tx, meta.actor, {
-      action: AuditAction.STATUS_CHANGE,
+      action: dispute ? AuditAction.DISPUTE_RESOLUTION : AuditAction.STATUS_CHANGE,
       entityName: 'SubOrder',
       entityId: sub.id,
       oldValue: { status: sub.status },
@@ -436,13 +515,14 @@ export class OrderLifecycleService {
         walletAction,
         ...(walletAction !== 'NONE' ? { vendorEarningsAmount: sub.vendorEarningsAmount.toFixed(2) } : {}),
         ...(restock ? { restockedLines: stockMovements(sub.items) } : {}),
+        ...(dispute ? dispute.audit : {}),
       },
     });
     return { subOrderId: sub.id, previousStatus: sub.status, stockAction: restock ? 'RESTOCKED' : 'NONE', walletAction, auditLogId };
   }
 
   /** Escrow consequence of a transition on a paid package; runs under the parent lock, before the audit row. */
-  private async applyWalletEffect(tx: Tx, sub: TransitionRow, target: SubOrderStatus, note: string | null): Promise<TransitionResult['walletAction']> {
+  private async applyWalletEffect(tx: Tx, sub: TransitionRow, target: SubOrderStatus, note: string | null): Promise<WalletAction> {
     if (target === SubOrderStatus.DELIVERED) {
       const released = await this.ledger.releaseEscrow(tx, sub);
       if (released) {
diff --git a/apps/backend/src/modules/wallet/dto/wallet.dto.ts b/apps/backend/src/modules/wallet/dto/wallet.dto.ts
index e01fd43..05c0126 100644
--- a/apps/backend/src/modules/wallet/dto/wallet.dto.ts
+++ b/apps/backend/src/modules/wallet/dto/wallet.dto.ts
@@ -12,7 +12,12 @@ export class WalletSummaryDto {
   @ApiProperty(MONEY) withdrawableBalance!: string;
   @ApiProperty({ ...MONEY, description: 'Reserved by open settlement requests awaiting the finance team (IRR).' })
   settlementHoldBalance!: string;
-  @ApiProperty({ ...MONEY, description: 'Earnings released on delivery, net of refunds of delivered packages (IRR).' })
+  @ApiProperty({ ...MONEY, description: 'Earnings frozen by open disputes about your packages; released or refunded when the dispute is decided (IRR).' })
+  disputeHoldBalance!: string;
+  @ApiProperty({
+    ...MONEY,
+    description: 'Earnings that left escrow (delivered, or frozen by a dispute), net of refunds (IRR). Equals withdrawable + settlement hold + dispute hold + withdrawn.',
+  })
   totalEarnedBalance!: string;
   @ApiProperty({ ...MONEY, description: 'Lifetime amount paid out by PAYA (IRR).' })
   totalWithdrawnAmount!: string;
diff --git a/apps/backend/src/modules/wallet/wallet-ledger.service.ts b/apps/backend/src/modules/wallet/wallet-ledger.service.ts
index 9937bf8..a228a6f 100644
--- a/apps/backend/src/modules/wallet/wallet-ledger.service.ts
+++ b/apps/backend/src/modules/wallet/wallet-ledger.service.ts
@@ -5,7 +5,8 @@ import { InsufficientBalanceError, escrowStateOf, planEntries, type BucketBalanc
 
 type Tx = Prisma.TransactionClient;
 
-const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD } = WalletBalanceBucket;
+const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD, DISPUTE_HOLD } = WalletBalanceBucket;
+const ZERO = new Prisma.Decimal(0);
 
 /** Package fields the escrow operations need. */
 export interface EscrowSubOrder {
@@ -27,12 +28,37 @@ interface WalletRow {
   pending_balance: Prisma.Decimal;
   withdrawable_balance: Prisma.Decimal;
   settlement_hold_balance: Prisma.Decimal;
+  dispute_hold_balance: Prisma.Decimal;
   total_earned_balance: Prisma.Decimal;
   total_withdrawn_amount: Prisma.Decimal;
 }
 
 export type ReverseOutcome = 'NONE' | 'FROM_PENDING' | 'FROM_WITHDRAWABLE';
 
+/** What opening a dispute froze (Phase 9). `source` is null when nothing could be frozen. */
+export interface DisputeFreeze {
+  source: typeof PENDING | typeof WITHDRAWABLE | null;
+  amount: Prisma.Decimal;
+  /** Delivered packages only: earnings the vendor had already moved out of WITHDRAWABLE. */
+  shortfall: Prisma.Decimal;
+}
+
+/** The frozen position of a dispute, as recorded on the dispute row. */
+export interface DisputeHoldPosition {
+  id: string;
+  holdSource: WalletBalanceBucket | null;
+  holdAmount: Prisma.Decimal;
+  holdShortfall: Prisma.Decimal;
+}
+
+export interface DisputeRefund {
+  fromHold: Prisma.Decimal;
+  /** Part of the shortfall recovered from the vendor's current WITHDRAWABLE balance. */
+  fromWithdrawable: Prisma.Decimal;
+  /** Earnings that could not be recovered at all (vendor debt, reported to staff). */
+  unrecovered: Prisma.Decimal;
+}
+
 /**
  * The only writer of vendor wallets. Every method runs inside the caller's
  * transaction, locks the wallet row (`SELECT … FOR UPDATE`, creating the wallet
@@ -71,7 +97,9 @@ export class WalletLedgerService {
   /** Package delivered: escrow moves to WITHDRAWABLE once. Returns false if there is nothing held to release. */
   async releaseEscrow(tx: Tx, sub: EscrowSubOrder): Promise<boolean> {
     const wallet = await this.lock(tx, sub.vendorId);
-    if ((await this.escrowState(tx, sub.id)) !== 'HELD') return false;
+    const state = await this.escrowState(tx, sub.id);
+    if (state === 'FROZEN') throw frozenError(sub);
+    if (state !== 'HELD') return false;
     const description = `Escrow released on delivery of package ${sub.subOrderNumber}`;
     await this.post(
       tx,
@@ -95,6 +123,7 @@ export class WalletLedgerService {
   async reverseEscrow(tx: Tx, sub: EscrowSubOrder, reason: string): Promise<ReverseOutcome> {
     const wallet = await this.lock(tx, sub.vendorId);
     const state = await this.escrowState(tx, sub.id);
+    if (state === 'FROZEN') throw frozenError(sub);
     if (state === 'NONE' || state === 'REVERSED') return 'NONE';
     const fromWithdrawable = state === 'RELEASED';
     await this.post(
@@ -114,6 +143,112 @@ export class WalletLedgerService {
     return fromWithdrawable ? 'FROM_WITHDRAWABLE' : 'FROM_PENDING';
   }
 
+  // ─── disputes (Phase 9) ─────────────────────────────────────────────────
+
+  /**
+   * A dispute was opened: the package's earnings move into DISPUTE_HOLD, where
+   * no delivery confirmation, cancellation or settlement can touch them.
+   *
+   * - Not delivered (escrow HELD): the full earnings, PENDING → DISPUTE_HOLD.
+   *   They leave escrow here, so `totalEarned` grows by the same amount — this
+   *   keeps `totalEarned ≥ withdrawn + withdrawable + disputeHold` exact.
+   * - Delivered (escrow RELEASED): `min(earnings, withdrawable)`, WITHDRAWABLE →
+   *   DISPUTE_HOLD; the rest is the shortfall the vendor already requested or
+   *   withdrew. `totalEarned` is unchanged (the money was already counted).
+   * - Zero earnings (nothing was escrowed): nothing to freeze.
+   */
+  async freezeForDispute(tx: Tx, sub: EscrowSubOrder, disputeId: string): Promise<DisputeFreeze> {
+    const wallet = await this.lock(tx, sub.vendorId);
+    const state = await this.escrowState(tx, sub.id);
+    const earnings = sub.vendorEarningsAmount;
+    const description = `Frozen by a dispute on package ${sub.subOrderNumber}`;
+    if (state === 'NONE') return { source: null, amount: ZERO, shortfall: ZERO };
+    if (state === 'HELD') {
+      await this.post(
+        tx,
+        wallet,
+        [
+          { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: PENDING, amount: earnings.negated(), subOrderId: sub.id, disputeId, description },
+          { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: DISPUTE_HOLD, amount: earnings, subOrderId: sub.id, disputeId, description },
+        ],
+        { earned: earnings },
+      );
+      return { source: PENDING, amount: earnings, shortfall: ZERO };
+    }
+    if (state === 'RELEASED') {
+      const available = wallet.balances[WITHDRAWABLE];
+      const amount = Prisma.Decimal.min(earnings, available);
+      const shortfall = earnings.minus(amount);
+      if (!amount.greaterThan(0)) return { source: null, amount: ZERO, shortfall };
+      await this.post(tx, wallet, [
+        { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: WITHDRAWABLE, amount: amount.negated(), subOrderId: sub.id, disputeId, description },
+        { type: WalletTransactionType.DISPUTE_HOLD_LOCK, bucket: DISPUTE_HOLD, amount, subOrderId: sub.id, disputeId, description },
+      ]);
+      return { source: WITHDRAWABLE, amount, shortfall };
+    }
+    throw conflictWith('ESCROW_NOT_FREEZABLE', `The earnings of package ${sub.subOrderNumber} are ${state.toLowerCase()} and cannot be frozen`, { escrowState: state });
+  }
+
+  /**
+   * Buyer-favour resolution: the frozen amount is deducted (REFUND_DEDUCTION on
+   * DISPUTE_HOLD). A shortfall recorded at opening is recovered from whatever
+   * WITHDRAWABLE balance the vendor has now; anything left is returned as
+   * `unrecovered` (balances never go negative). `totalEarned` shrinks by all
+   * that was deducted.
+   */
+  async refundDisputeHold(tx: Tx, sub: EscrowSubOrder, dispute: DisputeHoldPosition, reason: string): Promise<DisputeRefund> {
+    const wallet = await this.lock(tx, sub.vendorId);
+    const state = await this.escrowState(tx, sub.id);
+    if (dispute.holdAmount.greaterThan(0) && state !== 'FROZEN') {
+      throw conflictWith('ESCROW_NOT_FROZEN', `The earnings of package ${sub.subOrderNumber} are not frozen (${state})`, { escrowState: state });
+    }
+    const description = `Refund of package ${sub.subOrderNumber} (dispute): ${reason}`.slice(0, 255);
+    const entries: LedgerEntry[] = [];
+    if (dispute.holdAmount.greaterThan(0)) {
+      entries.push({ type: WalletTransactionType.REFUND_DEDUCTION, bucket: DISPUTE_HOLD, amount: dispute.holdAmount.negated(), subOrderId: sub.id, disputeId: dispute.id, description });
+    }
+    const fromWithdrawable = Prisma.Decimal.min(dispute.holdShortfall, wallet.balances[WITHDRAWABLE]);
+    if (fromWithdrawable.greaterThan(0)) {
+      entries.push({ type: WalletTransactionType.REFUND_DEDUCTION, bucket: WITHDRAWABLE, amount: fromWithdrawable.negated(), subOrderId: sub.id, disputeId: dispute.id, description });
+    }
+    const deducted = dispute.holdAmount.plus(fromWithdrawable);
+    if (entries.length > 0) {
+      await this.post(tx, wallet, entries, { earned: deducted.negated() });
+    }
+    return { fromHold: dispute.holdAmount, fromWithdrawable, unrecovered: dispute.holdShortfall.minus(fromWithdrawable) };
+  }
+
+  /**
+   * The frozen amount leaves DISPUTE_HOLD (DISPUTE_HOLD_RELEASE):
+   * - `WITHDRAWABLE`: vendor-favour resolution — released to the vendor;
+   * - `SOURCE`: the customer cancelled — back where it came from (PENDING for a
+   *   package not delivered yet, which un-counts it from `totalEarned`, or
+   *   WITHDRAWABLE for a delivered one).
+   * Returns the bucket credited, or null when nothing was frozen.
+   */
+  async releaseDisputeHold(tx: Tx, sub: EscrowSubOrder, dispute: DisputeHoldPosition, to: 'WITHDRAWABLE' | 'SOURCE'): Promise<WalletBalanceBucket | null> {
+    if (!dispute.holdAmount.greaterThan(0) || dispute.holdSource === null) return null;
+    const wallet = await this.lock(tx, sub.vendorId);
+    const state = await this.escrowState(tx, sub.id);
+    if (state !== 'FROZEN') {
+      throw conflictWith('ESCROW_NOT_FROZEN', `The earnings of package ${sub.subOrderNumber} are not frozen (${state})`, { escrowState: state });
+    }
+    const target = to === 'WITHDRAWABLE' ? WITHDRAWABLE : dispute.holdSource;
+    const amount = dispute.holdAmount;
+    const description =
+      target === WITHDRAWABLE ? `Dispute on package ${sub.subOrderNumber} closed: earnings released` : `Dispute on package ${sub.subOrderNumber} cancelled: back to escrow`;
+    await this.post(
+      tx,
+      wallet,
+      [
+        { type: WalletTransactionType.DISPUTE_HOLD_RELEASE, bucket: DISPUTE_HOLD, amount: amount.negated(), subOrderId: sub.id, disputeId: dispute.id, description },
+        { type: WalletTransactionType.DISPUTE_HOLD_RELEASE, bucket: target, amount, subOrderId: sub.id, disputeId: dispute.id, description },
+      ],
+      target === PENDING ? { earned: amount.negated() } : {},
+    );
+    return target;
+  }
+
   /** Settlement requested: the amount moves WITHDRAWABLE → SETTLEMENT_HOLD. */
   async holdForSettlement(tx: Tx, vendorId: string, settlementRequestId: string, amount: Prisma.Decimal): Promise<void> {
     const wallet = await this.lock(tx, vendorId);
@@ -159,7 +294,7 @@ export class WalletLedgerService {
       Prisma.sql`INSERT INTO vendor_wallets (id, vendor_id, updated_at) VALUES (gen_random_uuid(), ${vendorId}::uuid, now()) ON CONFLICT (vendor_id) DO NOTHING`,
     );
     const rows = await tx.$queryRaw<WalletRow[]>(
-      Prisma.sql`SELECT id, pending_balance, withdrawable_balance, settlement_hold_balance, total_earned_balance, total_withdrawn_amount
+      Prisma.sql`SELECT id, pending_balance, withdrawable_balance, settlement_hold_balance, dispute_hold_balance, total_earned_balance, total_withdrawn_amount
                  FROM vendor_wallets WHERE vendor_id = ${vendorId}::uuid FOR UPDATE`,
     );
     const row = rows[0];
@@ -172,6 +307,7 @@ export class WalletLedgerService {
         [PENDING]: new Prisma.Decimal(row.pending_balance),
         [WITHDRAWABLE]: new Prisma.Decimal(row.withdrawable_balance),
         [SETTLEMENT_HOLD]: new Prisma.Decimal(row.settlement_hold_balance),
+        [DISPUTE_HOLD]: new Prisma.Decimal(row.dispute_hold_balance),
       },
       totalEarned: new Prisma.Decimal(row.total_earned_balance),
       totalWithdrawn: new Prisma.Decimal(row.total_withdrawn_amount),
@@ -182,11 +318,19 @@ export class WalletLedgerService {
     const rows = await tx.walletTransaction.findMany({
       where: {
         subOrderId,
-        type: { in: [WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, WalletTransactionType.REFUND_DEDUCTION] },
+        type: {
+          in: [
+            WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
+            WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
+            WalletTransactionType.REFUND_DEDUCTION,
+            WalletTransactionType.DISPUTE_HOLD_LOCK,
+            WalletTransactionType.DISPUTE_HOLD_RELEASE,
+          ],
+        },
       },
-      select: { type: true },
+      select: { type: true, bucket: true, amount: true },
     });
-    return escrowStateOf(rows.map((row) => row.type));
+    return escrowStateOf(rows);
   }
 
   private async post(
@@ -217,6 +361,7 @@ export class WalletLedgerService {
         balanceAfter: entry.balanceAfter,
         subOrderId: entry.subOrderId ?? null,
         settlementRequestId: entry.settlementRequestId ?? null,
+        disputeId: entry.disputeId ?? null,
         description: entry.description,
       })),
     });
@@ -228,6 +373,7 @@ export class WalletLedgerService {
         pendingBalance: plan.balances[PENDING],
         withdrawableBalance: plan.balances[WITHDRAWABLE],
         settlementHoldBalance: plan.balances[SETTLEMENT_HOLD],
+        disputeHoldBalance: plan.balances[DISPUTE_HOLD],
         totalEarnedBalance: totalEarned,
         totalWithdrawnAmount: totalWithdrawn,
       },
@@ -238,3 +384,7 @@ export class WalletLedgerService {
     wallet.totalWithdrawn = totalWithdrawn;
   }
 }
+
+function frozenError(sub: EscrowSubOrder): Error {
+  return conflictWith('ESCROW_FROZEN_BY_DISPUTE', `The earnings of package ${sub.subOrderNumber} are frozen by an open dispute`, { subOrderId: sub.id });
+}
diff --git a/apps/backend/src/modules/wallet/wallet-math.spec.ts b/apps/backend/src/modules/wallet/wallet-math.spec.ts
index 57766ed..9883be9 100644
--- a/apps/backend/src/modules/wallet/wallet-math.spec.ts
+++ b/apps/backend/src/modules/wallet/wallet-math.spec.ts
@@ -1,8 +1,8 @@
 import { Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
-import { emptyBalances, escrowStateOf, InsufficientBalanceError, planEntries, sumByBucket } from './wallet-math';
+import { emptyBalances, escrowStateOf, InsufficientBalanceError, planEntries, sumByBucket, type EscrowRow } from './wallet-math';
 
 const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
-const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD } = WalletBalanceBucket;
+const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD, DISPUTE_HOLD } = WalletBalanceBucket;
 
 describe('wallet-math', () => {
   it('computes balanceAfter per bucket and the resulting balances', () => {
@@ -55,12 +55,40 @@ describe('wallet-math', () => {
     expect(plan.balances[WITHDRAWABLE].toFixed(2)).toBe('200.00');
   });
 
-  it('derives the escrow state of a package from its ledger rows', () => {
-    expect(escrowStateOf([])).toBe('NONE');
-    expect(escrowStateOf([WalletTransactionType.CREDIT_SALE_ESCROW_HOLD])).toBe('HELD');
-    expect(escrowStateOf([WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE])).toBe('RELEASED');
-    expect(
-      escrowStateOf([WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, WalletTransactionType.REFUND_DEDUCTION]),
-    ).toBe('REVERSED');
+  describe('escrowStateOf (net amount per bucket, order-independent)', () => {
+    const E = '5550000.00';
+    const row = (type: WalletTransactionType, bucket: WalletBalanceBucket, amount: string): EscrowRow => ({ type, bucket, amount: d(amount) });
+    const { CREDIT_SALE_ESCROW_HOLD: HOLD, ESCROW_RELEASE_TO_WITHDRAWABLE: RELEASE, REFUND_DEDUCTION: REFUND, DISPUTE_HOLD_LOCK: LOCK, DISPUTE_HOLD_RELEASE: UNLOCK } = WalletTransactionType;
+    const held = [row(HOLD, PENDING, E)];
+    const released = [...held, row(RELEASE, PENDING, `-${E}`), row(RELEASE, WITHDRAWABLE, E)];
+    const frozenFromPending = [...held, row(LOCK, PENDING, `-${E}`), row(LOCK, DISPUTE_HOLD, E)];
+
+    it('covers the Phase 7 life cycle', () => {
+      expect(escrowStateOf([])).toBe('NONE');
+      expect(escrowStateOf(held)).toBe('HELD');
+      expect(escrowStateOf(released)).toBe('RELEASED');
+      expect(escrowStateOf([...held, row(REFUND, PENDING, `-${E}`)])).toBe('REVERSED');
+      expect(escrowStateOf([...released, row(REFUND, WITHDRAWABLE, `-${E}`)])).toBe('REVERSED');
+    });
+
+    it('a dispute freezes the escrow; cancelling it returns to HELD; a vendor-favour decision releases it', () => {
+      expect(escrowStateOf(frozenFromPending)).toBe('FROZEN');
+      const cancelled = [...frozenFromPending, row(UNLOCK, DISPUTE_HOLD, `-${E}`), row(UNLOCK, PENDING, E)];
+      expect(escrowStateOf(cancelled)).toBe('HELD');
+      // a second dispute on the same package freezes it again
+      expect(escrowStateOf([...cancelled, row(LOCK, PENDING, `-${E}`), row(LOCK, DISPUTE_HOLD, E)])).toBe('FROZEN');
+      expect(escrowStateOf([...frozenFromPending, row(UNLOCK, DISPUTE_HOLD, `-${E}`), row(UNLOCK, WITHDRAWABLE, E)])).toBe('RELEASED');
+    });
+
+    it('freezing a delivered package takes from WITHDRAWABLE; a refund from the hold is terminal', () => {
+      const frozenDelivered = [...released, row(LOCK, WITHDRAWABLE, '-1000000.00'), row(LOCK, DISPUTE_HOLD, '1000000.00')];
+      expect(escrowStateOf(frozenDelivered)).toBe('FROZEN');
+      expect(escrowStateOf([...frozenDelivered, row(REFUND, DISPUTE_HOLD, '-1000000.00')])).toBe('REVERSED');
+    });
+
+    it('does not depend on row order (rows of one transaction share a timestamp)', () => {
+      expect(escrowStateOf([...frozenFromPending].reverse())).toBe('FROZEN');
+      expect(escrowStateOf([...released].reverse())).toBe('RELEASED');
+    });
   });
 });
diff --git a/apps/backend/src/modules/wallet/wallet-math.ts b/apps/backend/src/modules/wallet/wallet-math.ts
index cb2777a..fc67b1b 100644
--- a/apps/backend/src/modules/wallet/wallet-math.ts
+++ b/apps/backend/src/modules/wallet/wallet-math.ts
@@ -12,6 +12,7 @@ export interface LedgerEntry {
   amount: Prisma.Decimal;
   subOrderId?: string | null;
   settlementRequestId?: string | null;
+  disputeId?: string | null;
   description: string;
 }
 
@@ -41,6 +42,7 @@ export function emptyBalances(): BucketBalances {
     [WalletBalanceBucket.PENDING]: ZERO,
     [WalletBalanceBucket.WITHDRAWABLE]: ZERO,
     [WalletBalanceBucket.SETTLEMENT_HOLD]: ZERO,
+    [WalletBalanceBucket.DISPUTE_HOLD]: ZERO,
   };
 }
 
@@ -79,12 +81,34 @@ export function sumByBucket(rows: ReadonlyArray<{ bucket: WalletBalanceBucket; a
   return totals;
 }
 
-/** Escrow position of one package, derived from its ledger rows (the ledger is the source of truth). */
-export type EscrowState = 'NONE' | 'HELD' | 'RELEASED' | 'REVERSED';
+/**
+ * Escrow position of one package, derived from its own ledger rows (the ledger
+ * is the source of truth):
+ *
+ * - `NONE`     nothing was ever escrowed (unpaid, or zero earnings);
+ * - `HELD`     the earnings sit in PENDING (paid, not delivered);
+ * - `FROZEN`   the earnings sit in DISPUTE_HOLD (an open dispute, Phase 9);
+ * - `RELEASED` the earnings left escrow to WITHDRAWABLE (delivered, or a dispute
+ *              decided for the vendor);
+ * - `REVERSED` the earnings were deducted by a refund (terminal).
+ *
+ * Computed from the **net** amount per bucket, not from row order: rows written
+ * by one transaction share a timestamp, and a package can go HELD → FROZEN →
+ * HELD (dispute cancelled) → FROZEN (new dispute) any number of times.
+ */
+export type EscrowState = 'NONE' | 'HELD' | 'FROZEN' | 'RELEASED' | 'REVERSED';
+
+export interface EscrowRow {
+  type: WalletTransactionType;
+  bucket: WalletBalanceBucket;
+  amount: Prisma.Decimal;
+}
 
-export function escrowStateOf(types: ReadonlyArray<WalletTransactionType>): EscrowState {
-  if (types.includes('REFUND_DEDUCTION')) return 'REVERSED';
-  if (types.includes('ESCROW_RELEASE_TO_WITHDRAWABLE')) return 'RELEASED';
-  if (types.includes('CREDIT_SALE_ESCROW_HOLD')) return 'HELD';
-  return 'NONE';
+export function escrowStateOf(rows: ReadonlyArray<EscrowRow>): EscrowState {
+  if (rows.some((row) => row.type === 'REFUND_DEDUCTION')) return 'REVERSED';
+  if (!rows.some((row) => row.type === 'CREDIT_SALE_ESCROW_HOLD')) return 'NONE';
+  const net = sumByBucket(rows);
+  if (net[WalletBalanceBucket.DISPUTE_HOLD].greaterThan(0)) return 'FROZEN';
+  if (net[WalletBalanceBucket.PENDING].greaterThan(0)) return 'HELD';
+  return 'RELEASED';
 }
diff --git a/apps/backend/src/modules/wallet/wallet.service.ts b/apps/backend/src/modules/wallet/wallet.service.ts
index 0e745db..cdd0c1d 100644
--- a/apps/backend/src/modules/wallet/wallet.service.ts
+++ b/apps/backend/src/modules/wallet/wallet.service.ts
@@ -19,6 +19,7 @@ export class WalletService {
       pendingBalance: wallet?.pendingBalance.toFixed(2) ?? ZERO,
       withdrawableBalance: wallet?.withdrawableBalance.toFixed(2) ?? ZERO,
       settlementHoldBalance: wallet?.settlementHoldBalance.toFixed(2) ?? ZERO,
+      disputeHoldBalance: wallet?.disputeHoldBalance.toFixed(2) ?? ZERO,
       totalEarnedBalance: wallet?.totalEarnedBalance.toFixed(2) ?? ZERO,
       totalWithdrawnAmount: wallet?.totalWithdrawnAmount.toFixed(2) ?? ZERO,
       currency: 'IRR',
diff --git a/apps/backend/src/setup/app.setup.ts b/apps/backend/src/setup/app.setup.ts
index 6de1890..653505c 100644
--- a/apps/backend/src/setup/app.setup.ts
+++ b/apps/backend/src/setup/app.setup.ts
@@ -121,6 +121,9 @@ export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
       .addTag('credit-payments', 'Pay an order with bank credit (BANK_CREDIT) or credit + card (HYBRID)')
       .addTag('credit-installments', 'My instalments grouped by order, and paying an instalment by card')
       .addTag('admin-credit', 'Finance: credit applications, credit accounts and the aggregated credit exposure')
+      .addTag('customer-disputes', 'Disputes: open a dispute about a package (escrow is frozen), follow it, cancel it')
+      .addTag('vendor-disputes', 'Disputes against my store: read the complaint and evidence, accept the return or defend')
+      .addTag('admin-disputes', 'Trust & Safety: dispute dossiers and arbitration with automatic financial resolution')
       .build(),
   );
 }
diff --git a/apps/backend/test/finance.e2e-spec.ts b/apps/backend/test/finance.e2e-spec.ts
index 93768bd..de9934d 100644
--- a/apps/backend/test/finance.e2e-spec.ts
+++ b/apps/backend/test/finance.e2e-spec.ts
@@ -307,6 +307,7 @@ describe('Phase 7 — payments, escrow wallet and settlements (live stack)', ()
       PENDING: w.pendingBalance,
       WITHDRAWABLE: w.withdrawableBalance,
       SETTLEMENT_HOLD: w.settlementHoldBalance,
+      DISPUTE_HOLD: w.disputeHoldBalance,
     };
     for (const bucket of Object.values(WalletBalanceBucket)) {
       const inBucket = rows.filter((row) => row.bucket === bucket);
diff --git a/apps/backend/test/schema-integrity.e2e-spec.ts b/apps/backend/test/schema-integrity.e2e-spec.ts
index 1aff769..263086a 100644
--- a/apps/backend/test/schema-integrity.e2e-spec.ts
+++ b/apps/backend/test/schema-integrity.e2e-spec.ts
@@ -274,6 +274,8 @@ describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
         const dispute = await tx.dispute.create({
           data: {
             subOrderId: subOrder.id,
+            vendorId: subOrder.vendorId,
+            subOrderStatusAtOpen: SubOrderStatus.DELIVERED,
             raisedByUserId: customer.id,
             reason: DisputeReason.DAMAGED,
             description: 'بسته با آسیب فیزیکی تحویل داده شد.',
```
