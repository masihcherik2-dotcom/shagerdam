# Shopino — Phase 7 deliverable

**Scope:** pluggable IPG payment gateway, payment callback processing, escrow wallet ledger, escrow release on delivery, vendor settlements (Paya payouts), financial overview.

**Base:** Phase 6 (`19577a2`, approved). **TM decision applied:** the Phase 6 state machine is preserved completely. After payment, packages appear to vendors in `PENDING_APPROVAL`, not `PROCESSING`.

**Active provider in this environment:** `PAYMENT_GATEWAY_PROVIDER=sandbox`. This is a development/test provider that moves no money. The application **refuses to boot** with it when `NODE_ENV=production`. The Zarinpal provider is implemented against the official v4 API, but it has **not** been exercised against the real bank; see §9.

---

## 1. Module layout

```
apps/backend/src/modules/
├── payments/
│   ├── gateway/
│   │   ├── payment-gateway.interface.ts          PaymentGatewayProvider contract + DI token
│   │   ├── sandbox-payment-gateway.provider.ts   simulated bank (Redis sessions, SBX authority, 12-digit RRN)
│   │   ├── zarinpal-payment-gateway.provider.ts  Zarinpal v4 request/verify (IRR, timeout, code 100/101)
│   │   └── zarinpal-payment-gateway.provider.spec.ts
│   ├── dto/payment.dto.ts, dto/sandbox.dto.ts
│   ├── payments.service.ts                       initiate / callback (verify outside tx, apply under order lock)
│   ├── payments.controller.ts                    POST initiate, GET+POST callback
│   ├── sandbox-bank.controller.ts                dev-only mock bank page + decision → 303 to callback
│   └── payments.module.ts                        provider chosen by env (factory)
├── wallet/
│   ├── wallet-math.ts (+ spec)                   exact decimal arithmetic for bucket movements
│   ├── wallet-ledger.service.ts                  the only writer of wallet balances + ledger rows
│   ├── wallet.service.ts, vendor-store.ts
│   ├── vendor-wallet.controller.ts               GET vendor/wallet, GET vendor/wallet/transactions
│   ├── dto/wallet.dto.ts
│   └── wallet.module.ts
├── settlements/
│   ├── settlements.service.ts                    request (immediate hold) / process (APPROVE|REJECT) / payout
│   ├── vendor-settlements.controller.ts          POST+GET vendor/wallet/settlements
│   ├── admin-settlements.controller.ts           GET admin/settlements, PATCH :id/process, POST :id/payout
│   ├── dto/settlement.dto.ts
│   └── settlements.module.ts
└── financial/
    ├── financial.service.ts                      GMV, commission, escrow, settlements (raw SQL aggregates)
    ├── admin-financial.controller.ts             GET admin/financial/overview
    ├── dto/financial.dto.ts
    └── financial.module.ts
```

**Changed (Phase 6 files):**

- `orders/order-lifecycle.service.ts`:
  - payment application (`applyPaymentLocked`) with escrow hold;
  - escrow release on DELIVERED;
  - escrow reversal on cancel/refund;
  - `confirmDeliveryByCustomer`;
  - the expiry sweeper spares in-flight payments.
- `orders/order-audit.ts`, `orders/customer-orders.controller.ts` (confirm-delivery route), `orders/*-orders.controller.ts`, `orders/dto/order-response.dto.ts`, `orders/orders.module.ts`.
- `config/env.validation.ts` (+ spec), `app.module.ts`, `setup/app.setup.ts` (Swagger tags), `prisma/schema.prisma`, `.env.example`.
- Tests: `test/finance.e2e-spec.ts` (new), plus `test/orders.e2e-spec.ts` and `test/schema-integrity.e2e-spec.ts` adapted to the bucket model.

## 2. Endpoints (`/api/v1`)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| POST | `payments/initiate` | CUSTOMER (owner) | `{parentOrderId}` → Payment INITIATED; returns `{paymentId, redirectUrl, gatewayName, amount, currency, orderNumber, paymentExpiresAt}` |
| GET / POST | `payments/callback` | public | Gateway return (query string, or form/JSON body). Verifies server-to-server, then applies. JSON outcome, or 303 to `PAYMENT_RESULT_REDIRECT_URL` when configured |
| GET | `sandbox/payment-page/:paymentId` | public, **sandbox only** | Mock bank HTML page (amount, order number, PAY / DECLINE) |
| POST | `sandbox/payment-page/:paymentId/decision` | public, **sandbox only** | `{decision: PAY\|DECLINE}` → 303 to the callback with `Authority` and `Status=OK\|NOK` |
| POST | `customer/orders/:id/sub-orders/:subOrderId/confirm-delivery` | CUSTOMER (owner) | SHIPPED → DELIVERED + escrow release |
| GET | `vendor/wallet` | VENDOR | pending, withdrawable, settlementHold, totalEarned, totalWithdrawn |
| GET | `vendor/wallet/transactions` | VENDOR | paginated ledger (type, bucket, amount, balanceAfter, subOrder, settlement, description, createdAt) |
| POST | `vendor/wallet/settlements` | VENDOR | `{amount, targetIban}` → REQUESTED; amount held immediately |
| GET | `vendor/wallet/settlements` | VENDOR | own requests, paginated, status filter |
| GET | `admin/settlements` | FINANCIAL_OFFICER, SUPER_ADMIN, ADMIN | all requests; `status`, `vendorId` filters |
| PATCH | `admin/settlements/:id/process` | FINANCIAL_OFFICER, SUPER_ADMIN | `{action: APPROVE, payaReferenceNumber}` or `{action: REJECT, rejectionReason}` |
| POST | `admin/settlements/:id/payout` | FINANCIAL_OFFICER, SUPER_ADMIN | `{payaReferenceNumber}`, the same as APPROVE (named in the brief's rules) |
| GET | `admin/financial/overview` | FINANCIAL_OFFICER, SUPER_ADMIN, ADMIN | GMV, commission, shipping, escrow held, withdrawable, settlements by status, ledger consistency |

Every route is documented in Swagger under the tags `payments`, `sandbox-payments`, `vendor-wallet`, `admin-settlements` and `admin-financial`, with at least two responses each (asserted by the e2e suite).

## 3. Payment flow

1. **Initiate** (under the parent order row lock):
   - ownership check; the order must be `PENDING` and unpaid;
   - the payment window must still be open (`paymentExpiresAt`);
   - ≤ 5 open INITIATED attempts, otherwise 429.
   - The gateway is called with the **stored** `grandTotal` (IRR integer). A gateway failure returns 502 and leaves nothing half-written.
2. **Bank:**
   - sandbox: the mock page; `PAY` generates a realistic 12-digit RRN, `DECLINE` fails the session;
   - Zarinpal: `StartPay/{authority}`.
3. **Callback:**
   - The redirect parameters are **never trusted**. `verifyPayment` is always called server-to-server for the stored amount. A forged `Status=OK` for an unpaid session is verified and rejected (tested).
   - Verification runs **outside** the DB transaction, so a slow bank never holds row locks. The result is then applied under `lockParentOrder`:
     - **success on a payable order:** Payment `SUCCESSFUL` (bankRrn, paidAt) → parent `paymentStatus=PAID` → every sub-order `PENDING_PAYMENT → PENDING_APPROVAL` → stock committed (`stock -= q`, `reserved -= q`) → escrow hold per package. All in **one transaction**.
     - **failure:** Payment `FAILED` (metadata `code`). The order stays `PENDING` with its stock reserved, and the customer may retry until `paymentExpiresAt`. The expiry sweeper then releases the stock as in Phase 6.
     - **replay** (same token again, GET or POST): the stored outcome is returned with no second verification and no second application.
     - **late success** (order already expired, cancelled or paid by another attempt): Payment `SUCCESSFUL` with `metadata.requiresManualRefund=true`. The order is not resurrected.
   - **Concurrency:** parallel callbacks for one payment are serialised by the order row lock. The partial unique index `payments_gateway_token_key` and the ledger unique indexes make a double application impossible even if the service check were bypassed (tested with concurrent requests).
4. **Expiry grace:** the Phase 6 sweeper skips orders that have an INITIATED payment younger than `PAYMENT_CALLBACK_GRACE_MINUTES` (20). A customer who is on the bank page when the window closes is therefore not expired from under the bank.

## 4. Escrow wallet ledger

**Balance buckets:** `PENDING` (escrow), `WITHDRAWABLE`, `SETTLEMENT_HOLD`. Every ledger row records its `bucket`, a signed `amount` and the bucket's `balanceAfter`. `WalletLedgerService` is the only writer. It locks the wallet row (`SELECT … FOR UPDATE`), computes with exact decimals, and writes the balance update and the ledger row in the caller's transaction.

| Event | Ledger rows | Balance effect |
|---|---|---|
| Payment success (per package) | `CREDIT_SALE_ESCROW_HOLD` / PENDING `+earnings` | pending += earnings |
| DELIVERED (customer confirmation or staff force-status) | `ESCROW_RELEASE_TO_WITHDRAWABLE` / PENDING `−e`, and / WITHDRAWABLE `+e` | pending −= e, withdrawable += e, totalEarned += e, `escrowReleasedAt` set |
| Cancel/refund before release | `REFUND_DEDUCTION` / PENDING `−e` | pending −= e |
| Refund after release | `REFUND_DEDUCTION` / WITHDRAWABLE `−e` | only if withdrawable ≥ e; otherwise **409, and nothing changes** |
| Settlement request | `SETTLEMENT_HOLD` / WITHDRAWABLE `−a`, and / SETTLEMENT_HOLD `+a` | withdrawable −= a, hold += a |
| Reject | `SETTLEMENT_HOLD_RELEASE` / SETTLEMENT_HOLD `−a`, and / WITHDRAWABLE `+a` | restored |
| Approve / payout | `SETTLEMENT_PAYOUT` / SETTLEMENT_HOLD `−a` | hold −= a, totalWithdrawn += a |

- `earnings` = `SubOrder.vendorEarningsAmount` = items subtotal − commission (the Phase 6 rule, unchanged).
- **Idempotency:** release is guarded by `escrowReleasedAt` in the service **and** by the partial unique index `(sub_order_id, type, bucket)` in the database.
- **Integrity in PG:** CHECK constraints keep every balance ≥ 0, every ledger amount ≠ 0 and every `balance_after` ≥ 0; a PAID_PAYA request must have a reference; a REJECTED request must have a reason.

## 5. Settlements

- **Request:**
  - amount must be ≥ `commerce.settlementMinimumAmount` (400 `AMOUNT_BELOW_MINIMUM`) and ≤ withdrawable (409 `INSUFFICIENT_WALLET_BALANCE` with `available` and `bucket`);
  - `targetIban` must be a valid Sheba (400) and must equal the vendor's verified bank account (409 `IBAN_MISMATCH` / `BANK_ACCOUNT_MISSING`);
  - the amount is held in the same transaction, so two parallel requests cannot overdraw.
- **Process / payout** (under the settlement row lock):
  - only `REQUESTED` or `PROCESSING` requests can be processed; otherwise 409 `SETTLEMENT_ALREADY_PROCESSED`;
  - a Paya reference can be used only once (409 `PAYA_REFERENCE_IN_USE`);
  - an audit log row with the actor, before/after status and amount is written in the same transaction.
- The minimum is read **only** from `system_configs`. A missing or invalid value returns 503 instead of a guessed default.

## 6. Financial overview

`GET admin/financial/overview?from=&to=` aggregates directly in PG (optional time window):

- `sales`: paid orders, active packages, GMV, shipping fees, amount collected by the gateway;
- `commission`: earned (delivered packages), pending (paid but not delivered yet), total;
- `wallets`: escrow held (sum of pending balances), withdrawable, settlement hold, total withdrawn;
- `wallets.ledgerConsistent` and `inconsistentWallets`: every wallet's bucket balances equal the sums of its ledger rows;
- `settlements`: pending count and amount, paid count and amount;
- `paymentsRequiringManualRefund`.

The e2e suite checks every figure against independent SQL aggregates.

## 7. Configuration

| Variable | Default | Notes |
|---|---|---|
| `PAYMENT_GATEWAY_PROVIDER` | `sandbox` | `sandbox` \| `zarinpal`; sandbox is forbidden in production |
| `ZARINPAL_MERCHANT_ID` | — | required when provider = zarinpal (36-char id) |
| `ZARINPAL_API_BASE_URL` | `https://payment.zarinpal.com` | set to `https://sandbox.zarinpal.com` for Zarinpal's own sandbox |
| `PAYMENT_GATEWAY_TIMEOUT_MS` | 15000 | abort for gateway HTTP calls |
| `PUBLIC_API_ORIGIN` | — (required) | builds the absolute callback URL given to the bank |
| `PAYMENT_RESULT_REDIRECT_URL` | unset | when set, the callback answers 303 to the storefront result page |
| `PAYMENT_CALLBACK_GRACE_MINUTES` | 20 | the expiry sweeper spares in-flight payments this long |

`system_configs` keys used: `commerce.settlementMinimumAmount` (seed 5,000,000.00 IRR) and `platform.currency` (IRR).

## 8. Schema changes (migration `20260929090000_phase7_finance`)

- `VendorWallet`: `settlementHoldBalance`, `totalWithdrawnAmount`.
- `WalletTransaction`: `bucket` (new enum `WalletBalanceBucket`) + index `(walletId, bucket)`.
- `SettlementRequest`: `rejectionReason`.
- Enum `WalletTransactionType`: `SETTLEMENT_HOLD`, `SETTLEMENT_HOLD_RELEASE`.
- CHECK constraints and partial unique indexes as listed in §4 and §5, plus `payments_gateway_token_key`.
- The new enum values are only *added* in this migration; PG forbids using them in the same transaction.

## 9. Not done in this phase (stated honestly)

- **Zarinpal has not been run against the real bank.** It has 9 unit tests against the official v4 contract (fake `fetch`). Going live needs a merchant ID and one real sandbox or small-amount test.
- **No reconciliation job** for INITIATED payments whose callback never arrives (the customer closed the browser after paying). Zarinpal supports verifying later by authority. This needs a scheduled reconcile, proposed for the next phase.
- **Automatic bank refunds are not implemented.** `requiresManualRefund` payments are flagged and counted in the overview; refunds are manual.
- **Shipping fees are not credited to any vendor wallet.** Following Phase 6, earnings = items − commission. Who owns the shipping money needs a TM decision.
- **`commerce.escrowHoldDays=7` is not used.** Escrow is released immediately on DELIVERED, as the brief specifies. If a hold period after delivery is wanted, that needs a TM decision.
- **Paya transfers are recorded, not executed.** The finance officer performs the transfer in the bank and enters its reference. No bank API integration.
- **BNPL / credit payments** (`creditAmount`) are out of scope; `creditAmount` is always 0 in this phase.
- **No frontend pages** for payment, wallet or settlements (backend phase).


## 10. Complete source files

New files are listed in full. For changed Phase 6 files, the full current content is listed and the exact diff against `19577a2` follows in §11.

### `.env.example`

```bash
# ============================================================================
# Shopino — environment template
# ----------------------------------------------------------------------------
# Copy to `.env` and fill in real values:      cp .env.example .env
# `.env` is git-ignored and must never be committed.
#
# The values below are DEVELOPMENT placeholders. They are safe only on a local
# machine and MUST be replaced before any shared or production deployment.
# The backend refuses to boot in production when a required secret is missing
# (see apps/backend/src/config/env.validation.ts).
# ============================================================================

# ─── Runtime ────────────────────────────────────────────────────────────────
# development | test | production
NODE_ENV=development
# Public port of the backend API.
PORT=4000
# Bind address. 0.0.0.0 is required inside containers and remote dev sandboxes;
# use 127.0.0.1 to restrict the API to the local machine.
HOST=0.0.0.0
# Comma-separated list of browser origins allowed to call the API (CORS).
# In development, localhost and *.e2b.app preview origins are additionally
# allowed automatically; production uses exactly this list.
CORS_ORIGINS=http://localhost:3000
# error | warn | log | debug | verbose
LOG_LEVEL=debug

# ─── PostgreSQL 16 (docker-compose service: postgres) ───────────────────────
POSTGRES_USER=shopino
POSTGRES_PASSWORD=replace-with-a-strong-password
POSTGRES_DB=shopino_db
POSTGRES_PORT=5432

# Prisma runtime connection (application queries).
# In production this points at the pooled endpoint (PgBouncer / managed pooler).
DATABASE_URL=postgresql://shopino:replace-with-a-strong-password@127.0.0.1:5432/shopino_db?schema=public&connection_limit=10&pool_timeout=20
# Prisma migration/introspection connection. Must bypass the pooler; identical
# to DATABASE_URL when no pooler is used.
DIRECT_URL=postgresql://shopino:replace-with-a-strong-password@127.0.0.1:5432/shopino_db?schema=public

# ─── Redis 7 (docker-compose service: redis) ───────────────────────────────
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=replace-with-a-strong-password
# Logical database index (0-15).
REDIS_DB=0

# ─── Authentication (JWT) ──────────────────────────────────────────────────
# REQUIRED: the API signs real tokens, so it refuses to start when either secret
# is empty or shorter than 32 characters — in every environment, development
# included. A missing secret is a service that cannot authenticate anyone.
# Generate with:  openssl rand -base64 48
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=

# Token lifetimes. The access token is deliberately short-lived and stateless;
# the refresh token is persistent and tracked server-side in Redis so it can be
# revoked instantly. Both accept the `30s`/`15m`/`12h`/`7d` shorthand.
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# ─── OTP policy ────────────────────────────────────────────────────────────
# Validity of a generated login code, and how many digits it has.
OTP_TTL_SECONDS=120
OTP_LENGTH=5
# Minimum delay between two code requests for the same number.
OTP_REQUEST_COOLDOWN_SECONDS=120
# Wrong codes tolerated before the number is locked, and for how long.
OTP_MAX_VERIFY_ATTEMPTS=5
OTP_LOCK_SECONDS=900
# Ceilings per rolling hour: per number, and per client IP (the second one stops
# an attacker from enumerating many numbers from a single host).
OTP_MAX_REQUESTS_PER_HOUR=5
OTP_MAX_REQUESTS_PER_IP_PER_HOUR=20

# ─── Password login policy ─────────────────────────────────────────────────
# Failed attempts tolerated per identifier (e-mail or mobile) before it is
# locked for AUTH_LOCK_SECONDS. Counted in Redis, so it holds across instances.
AUTH_MAX_LOGIN_ATTEMPTS=5
AUTH_LOCK_SECONDS=900

# ─── SMS provider ──────────────────────────────────────────────────────────
# sandbox    → development/test provider: prints the code to the log and keeps
#              the last 50 dispatches in memory. NEVER delivers a real message,
#              and the API refuses to boot with it when NODE_ENV=production.
# kavenegar  → production provider: real delivery through the Kavenegar HTTP API
#              (verify/lookup for OTP, sms/send for transactional). Requires the
#              three credentials below; a missing one fails the boot.
SMS_PROVIDER=sandbox

# Only meaningful for the sandbox provider: print the generated code so a
# developer can complete the login flow locally. Keep it false on any shared host.
SMS_SANDBOX_LOG_CODES=true

# Kavenegar credentials (production). The API key travels in the request path of
# the gateway, so treat it as a secret: never commit it, inject it from the
# secret manager, and rotate it if it ever leaves one.
SMS_KAVENEGAR_API_KEY=
# Sender line number configured in the Kavenegar panel.
SMS_KAVENEGAR_SENDER=
# Name of the approved "lookup" template used for login codes.
SMS_KAVENEGAR_OTP_TEMPLATE=

# ─── File storage (Phase 4) ────────────────────────────────────────────────
# `local` writes uploads to STORAGE_LOCAL_ROOT on this host and serves them
# through the API (development default). `s3` talks to any S3-compatible object
# store: AWS S3, ArvanCloud, Liara, MinIO. Selection happens at boot inside
# StorageModule, so no business code branches on it.
STORAGE_PROVIDER=local
# Uploads root for the local provider (relative to the backend app directory).
STORAGE_LOCAL_ROOT=uploads
# Base URL stored objects are published under. The default points at the API's
# own file route; set it to a CDN origin in production.
STORAGE_PUBLIC_BASE_URL=/api/v1/media/files

# S3 settings — only read when STORAGE_PROVIDER=s3, and the API refuses to boot
# with `s3` selected while the bucket or the keys are missing.
S3_ENDPOINT=
S3_REGION=ir-thr-at1
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
# Path-style addressing (endpoint/bucket/key). Required by ArvanCloud and Liara;
# AWS deprecated it, so set false when talking to AWS directly.
S3_FORCE_PATH_STYLE=true
# CDN/custom domain in front of the bucket. Empty falls back to endpoint/bucket.
S3_PUBLIC_BASE_URL=

# ─── Media limits (Phase 4) ────────────────────────────────────────────────
# Ceiling for an uploaded image and document, in bytes.
MEDIA_MAX_IMAGE_BYTES=5242880
MEDIA_MAX_DOCUMENT_BYTES=10485760

# ─── Seed master data (apps/backend/prisma/seed.ts) ────────────────────────
# Credentials of the super-admin account created by `pnpm db:seed`.
# The seed never invents credentials: it fails when these are missing.
# REQUIRED IN PRODUCTION: replace the development values before deploying.
# Password policy: at least 12 characters. Generate with: openssl rand -base64 24
SUPER_ADMIN_EMAIL=admin@shopino.local
SUPER_ADMIN_PASSWORD=
# Display name stored on the super-admin account.
SUPER_ADMIN_FULL_NAME=مدیر ارشد پلتفرم
# Set to true only when the admin password must be rotated deliberately;
# the seed never overwrites an existing password otherwise.
SEED_RESET_ADMIN_PASSWORD=false
# Dev/test password for the seeded staff accounts (support + financial officer).
# REQUIRED IN PRODUCTION: replace before deploying; dev value may be generated
# with: openssl rand -base64 24
SEED_STAFF_PASSWORD=
# Dev/test password for the owner account of the sample vendor shop.
SEED_VENDOR_PASSWORD=

# ─── Frontend (Next.js) ────────────────────────────────────────────────────
# Base URL the browser uses for API calls. Relative, so requests hit the
# Next.js origin and are proxied server-side (no CORS, works behind one domain).
NEXT_PUBLIC_API_BASE_URL=/api/v1
# Internal URL the Next.js server uses to reach the backend (rewrites and
# server-side rendering). Never exposed to the browser.
BACKEND_INTERNAL_URL=http://127.0.0.1:4000
# Comma-separated extra origins allowed to load Next.js dev assets
# (remote dev sandboxes / tunnels). Production builds ignore this.
NEXT_ALLOWED_DEV_ORIGINS=

# ─── Commerce: shipping & order lifecycle (Phase 6) ─────────────────────────
# Amounts are in the platform currency (system_configs platform.currency = IRR, rial).
# These are fallbacks: system_configs keys shipping.default_fee_per_vendor and
# shipping.free_threshold_per_vendor take precedence; a store's own
# shippingFeeOverride / freeShippingThreshold take precedence over both.
# 500000 IRR = 50,000 toman · 10000000 IRR = 1,000,000 toman. 0 threshold = never free.
SHIPPING_DEFAULT_FEE_PER_VENDOR=500000
SHIPPING_FREE_THRESHOLD_PER_VENDOR=10000000
# Unpaid orders release their stock reservation after this many minutes.
ORDER_PAYMENT_TIMEOUT_MINUTES=30
# Expiry sweeper period in seconds (0 disables it on this instance).
ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=60

# ─── Payments (Phase 7) ────────────────────────────────────────────────────
# Origin the customer's browser and the bank reach this API on (no path). The
# gateway callback is ${PUBLIC_API_ORIGIN}/api/v1/payments/callback.
PUBLIC_API_ORIGIN=http://localhost:4000
# `sandbox` = built-in simulated bank page (development/test ONLY; the API
# refuses to boot with it in production). `zarinpal` = Zarinpal IPG v4.
PAYMENT_GATEWAY_PROVIDER=sandbox
# Required when PAYMENT_GATEWAY_PROVIDER=zarinpal. Never commit a real value.
ZARINPAL_MERCHANT_ID=
# https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com (Zarinpal test host).
ZARINPAL_API_BASE_URL=https://payment.zarinpal.com
# Timeout of one gateway API call, in milliseconds.
PAYMENT_GATEWAY_TIMEOUT_MS=15000
# Optional frontend result page; empty = the callback answers with JSON.
PAYMENT_RESULT_REDIRECT_URL=
# An INITIATED payment protects its order from the expiry sweeper this long.
PAYMENT_CALLBACK_GRACE_MINUTES=20
```

### `apps/backend/prisma/migrations/20260929090000_phase7_finance/migration.sql`

```sql
-- Phase 7: payments, escrow wallet ledger and vendor settlements.
--
-- The new enum values are only *added* here; no statement in this migration
-- uses them (PostgreSQL forbids using an enum value in the transaction that
-- added it), so the partial indexes below reference pre-existing values only.

-- CreateEnum
CREATE TYPE "WalletBalanceBucket" AS ENUM ('PENDING', 'WITHDRAWABLE', 'SETTLEMENT_HOLD');

-- AlterEnum
ALTER TYPE "WalletTransactionType" ADD VALUE 'SETTLEMENT_HOLD';
ALTER TYPE "WalletTransactionType" ADD VALUE 'SETTLEMENT_HOLD_RELEASE';

-- AlterTable
ALTER TABLE "settlement_requests" ADD COLUMN "rejection_reason" VARCHAR(500);

-- AlterTable
ALTER TABLE "vendor_wallets"
  ADD COLUMN "settlement_hold_balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN "total_withdrawn_amount" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- AlterTable
-- No ledger rows were written before Phase 7 (nothing credited wallets), so the
-- column can be added as NOT NULL. If rows ever exist, this statement fails
-- loudly instead of guessing their bucket.
ALTER TABLE "wallet_transactions" ADD COLUMN "bucket" "WalletBalanceBucket" NOT NULL;

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_id_bucket_idx" ON "wallet_transactions"("wallet_id", "bucket");

-- ─── Integrity rules the Prisma schema language cannot express ───────────────

-- Balances never go negative: every debit is checked by the service under a row
-- lock, and the database refuses the write if that check is ever bypassed.
ALTER TABLE "vendor_wallets"
  ADD CONSTRAINT "vendor_wallets_balances_non_negative" CHECK (
    "pending_balance" >= 0
    AND "withdrawable_balance" >= 0
    AND "settlement_hold_balance" >= 0
    AND "total_earned_balance" >= 0
    AND "total_withdrawn_amount" >= 0
  );

-- A ledger row always moves money, and never leaves its bucket negative.
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_amount_non_zero" CHECK ("amount" <> 0),
  ADD CONSTRAINT "wallet_transactions_balance_after_non_negative" CHECK ("balance_after" >= 0);

-- Idempotency at the database level: a package is escrowed, released and
-- refunded at most once per bucket; a settlement request moves money at most
-- once per type and bucket (hold, release, payout).
CREATE UNIQUE INDEX "wallet_transactions_sub_order_movement_key"
  ON "wallet_transactions"("sub_order_id", "type", "bucket")
  WHERE "sub_order_id" IS NOT NULL
    AND "type" IN ('CREDIT_SALE_ESCROW_HOLD', 'ESCROW_RELEASE_TO_WITHDRAWABLE', 'REFUND_DEDUCTION');

CREATE UNIQUE INDEX "wallet_transactions_settlement_movement_key"
  ON "wallet_transactions"("settlement_request_id", "type", "bucket")
  WHERE "settlement_request_id" IS NOT NULL;

ALTER TABLE "settlement_requests"
  ADD CONSTRAINT "settlement_requests_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "settlement_requests_paid_has_reference" CHECK (
    "status" <> 'PAID_PAYA' OR ("bank_paya_reference" IS NOT NULL AND "processed_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "settlement_requests_rejected_has_reason" CHECK (
    "status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND "processed_at" IS NOT NULL)
  );

-- One gateway token identifies one payment attempt (callbacks look it up).
CREATE UNIQUE INDEX "payments_gateway_token_key"
  ON "payments"("gateway_name", "gateway_tracking_token")
  WHERE "gateway_tracking_token" IS NOT NULL;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amounts_non_negative" CHECK ("cash_amount" >= 0 AND "credit_amount" >= 0),
  ADD CONSTRAINT "payments_successful_has_paid_at" CHECK ("status" <> 'SUCCESSFUL' OR "paid_at" IS NOT NULL);
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

  productMedia ProductMedia[]

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
}

/// Balance bucket of a vendor wallet a ledger row moves money in.
enum WalletBalanceBucket {
  PENDING
  WITHDRAWABLE
  SETTLEMENT_HOLD
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
  id                   String        @id @default(uuid()) @db.Uuid
  parentOrderId        String        @map("parent_order_id") @db.Uuid
  parentOrder          ParentOrder   @relation(fields: [parentOrderId], references: [id], onDelete: Restrict)
  gatewayName          String        @map("gateway_name") @db.VarChar(40)
  gatewayTrackingToken String?       @map("gateway_tracking_token") @db.VarChar(120)
  bankRrn              String?       @map("bank_rrn") @db.VarChar(40)
  cashAmount           Decimal       @default(0) @map("cash_amount") @db.Decimal(15, 2)
  creditAmount         Decimal       @default(0) @map("credit_amount") @db.Decimal(15, 2)
  status               PaymentStatus @default(INITIATED)
  paidAt               DateTime?     @map("paid_at") @db.Timestamptz(3)
  metadata             Json?
  createdAt            DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt            DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([parentOrderId, status])
  @@index([status, createdAt])
  @@index([gatewayTrackingToken])
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

/// Complaint raised by a customer about one vendor's slice of an order.
/// Disputes live as long as the sub-order they belong to.
model Dispute {
  id              String        @id @default(uuid()) @db.Uuid
  subOrderId      String        @map("sub_order_id") @db.Uuid
  subOrder        SubOrder      @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
  raisedByUserId  String        @map("raised_by_user_id") @db.Uuid
  raisedBy        User          @relation(fields: [raisedByUserId], references: [id], onDelete: Restrict)
  reason          DisputeReason
  description     String        @db.Text
  status          DisputeStatus @default(OPEN)
  resolutionNotes String?       @map("resolution_notes") @db.Text
  resolvedAt      DateTime?     @map("resolved_at") @db.Timestamptz(3)
  createdAt       DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)

  evidence DisputeEvidence[]

  @@index([subOrderId])
  @@index([status, createdAt])
  @@index([raisedByUserId, createdAt])
  @@map("disputes")
}

/// Uploaded proof for a dispute (photo, invoice, chat export). The uploader is
/// recorded separately from the raiser because staff and vendors may add files.
model DisputeEvidence {
  id               String   @id @default(uuid()) @db.Uuid
  disputeId        String   @map("dispute_id") @db.Uuid
  dispute          Dispute  @relation(fields: [disputeId], references: [id], onDelete: Cascade)
  uploadedByUserId String   @map("uploaded_by_user_id") @db.Uuid
  uploadedBy       User     @relation(fields: [uploadedByUserId], references: [id], onDelete: Restrict)
  fileUrl          String   @map("file_url") @db.VarChar(512)
  fileType         String?  @map("file_type") @db.VarChar(40)
  caption          String?  @db.VarChar(255)
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([disputeId, createdAt])
  @@index([uploadedByUserId])
  @@map("dispute_evidence")
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

### `apps/backend/src/config/env.validation.spec.ts`

```ts
import type { ConfigService } from '@nestjs/config';
import { validateEnvironment, NodeEnvironment } from './env.validation';
import { resolveLogLevels } from './logger.config';
import { buildCorsOptions, parseOriginList } from './cors.config';

const VALID_ENV: Record<string, unknown> = {
  NODE_ENV: 'development',
  PORT: '4000',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgresql://shopino:secret@127.0.0.1:5432/shopino_db?schema=public',
  DIRECT_URL: 'postgresql://shopino:secret@127.0.0.1:5432/shopino_db?schema=public',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'redis-secret',
  REDIS_DB: '0',
  CORS_ORIGINS: 'http://localhost:3000',
  LOG_LEVEL: 'debug',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
  SHIPPING_DEFAULT_FEE_PER_VENDOR: '500000',
  SHIPPING_FREE_THRESHOLD_PER_VENDOR: '10000000',
  PUBLIC_API_ORIGIN: 'http://localhost:4000',
};

const MERCHANT_ID = '1344b5d4-0048-11e8-94db-005056a205be';

describe('validateEnvironment', () => {
  it('requires the shipping fee settings and validates the order lifecycle timings', () => {
    const withoutFee: Record<string, unknown> = { ...VALID_ENV };
    delete withoutFee.SHIPPING_DEFAULT_FEE_PER_VENDOR;
    expect(() => validateEnvironment(withoutFee)).toThrow(/SHIPPING_DEFAULT_FEE_PER_VENDOR/);
    expect(() => validateEnvironment({ ...VALID_ENV, SHIPPING_FREE_THRESHOLD_PER_VENDOR: '-1' })).toThrow(
      /SHIPPING_FREE_THRESHOLD_PER_VENDOR/,
    );
    expect(() => validateEnvironment({ ...VALID_ENV, ORDER_PAYMENT_TIMEOUT_MINUTES: '1' })).toThrow(
      /ORDER_PAYMENT_TIMEOUT_MINUTES/,
    );

    const config = validateEnvironment(VALID_ENV);
    expect(config.SHIPPING_DEFAULT_FEE_PER_VENDOR).toBe(500_000);
    expect(config.SHIPPING_FREE_THRESHOLD_PER_VENDOR).toBe(10_000_000);
    expect(config.ORDER_PAYMENT_TIMEOUT_MINUTES).toBe(30);
    expect(config.ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS).toBe(60);
  });

  it('accepts a complete configuration and coerces numeric values', () => {
    const config = validateEnvironment(VALID_ENV);

    expect(config.NODE_ENV).toBe(NodeEnvironment.Development);
    expect(config.PORT).toBe(4000);
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.REDIS_DB).toBe(0);
  });

  it('rejects a configuration without a database connection string', () => {
    const withoutDatabase: Record<string, unknown> = { ...VALID_ENV };
    delete withoutDatabase.DATABASE_URL;

    expect(() => validateEnvironment(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('rejects a database URL that is not a postgres connection string', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, DATABASE_URL: 'mysql://host/db' })).toThrow(
      /postgresql:\/\//,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, PORT: '70000' })).toThrow(/PORT/);
  });

  it('fails when JWT secrets are missing, in every environment', () => {
    // From Phase 3 on the API signs real tokens, so a missing secret is a service
    // that cannot authenticate anyone — a boot failure, not a warning.
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(() =>
        validateEnvironment(
          { ...VALID_ENV, NODE_ENV: nodeEnv, JWT_ACCESS_SECRET: '', JWT_REFRESH_SECRET: '   ' },
          { logger: { warn: jest.fn() } },
        ),
      ).toThrow(/Missing required secrets: JWT_ACCESS_SECRET, JWT_REFRESH_SECRET/);
    }
  });

  it('fails when only one of the two secrets is present', () => {
    expect(() =>
      validateEnvironment({ ...VALID_ENV, JWT_REFRESH_SECRET: '' }),
    ).toThrow(/Missing required secrets: JWT_REFRESH_SECRET/);
  });

  it('applies the authentication and OTP defaults', () => {
    const config = validateEnvironment(VALID_ENV);

    expect(config.JWT_ACCESS_TTL).toBe('15m');
    expect(config.JWT_REFRESH_TTL).toBe('7d');
    expect(config.OTP_TTL_SECONDS).toBe(120);
    expect(config.OTP_LENGTH).toBe(5);
    expect(config.OTP_REQUEST_COOLDOWN_SECONDS).toBe(120);
    expect(config.OTP_MAX_VERIFY_ATTEMPTS).toBe(5);
    expect(config.OTP_LOCK_SECONDS).toBe(900);
    expect(config.SMS_PROVIDER).toBe('sandbox');
  });

  it('coerces the numeric OTP policy overrides', () => {
    const config = validateEnvironment({
      ...VALID_ENV,
      OTP_TTL_SECONDS: '180',
      OTP_LENGTH: '6',
      AUTH_MAX_LOGIN_ATTEMPTS: '3',
    });

    expect(config.OTP_TTL_SECONDS).toBe(180);
    expect(config.OTP_LENGTH).toBe(6);
    expect(config.AUTH_MAX_LOGIN_ATTEMPTS).toBe(3);
  });

  it('rejects a JWT lifetime it cannot interpret', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, JWT_ACCESS_TTL: 'fifteen minutes' })).toThrow(
      /JWT_ACCESS_TTL/,
    );
  });

  it('rejects an OTP policy outside the safe bounds', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, OTP_LENGTH: '2' })).toThrow(/OTP_LENGTH/);
    expect(() => validateEnvironment({ ...VALID_ENV, OTP_MAX_VERIFY_ATTEMPTS: '50' })).toThrow(
      /OTP_MAX_VERIFY_ATTEMPTS/,
    );
    expect(() => validateEnvironment({ ...VALID_ENV, OTP_TTL_SECONDS: '5' })).toThrow(/OTP_TTL_SECONDS/);
  });

  it('refuses the sandbox SMS provider in production', () => {
    expect(() =>
      validateEnvironment({ ...VALID_ENV, NODE_ENV: 'production', SMS_PROVIDER: 'sandbox' }),
    ).toThrow(/sandbox cannot be used in production/);
  });

  it('requires the gateway credentials when the real provider is selected', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, SMS_PROVIDER: 'kavenegar' })).toThrow(
      /SMS_PROVIDER=kavenegar requires SMS_KAVENEGAR_API_KEY, SMS_KAVENEGAR_SENDER, SMS_KAVENEGAR_OTP_TEMPLATE/,
    );
  });

  it('accepts the real provider once its credentials are present', () => {
    const config = validateEnvironment({
      ...VALID_ENV,
      SMS_PROVIDER: 'kavenegar',
      SMS_KAVENEGAR_API_KEY: 'a-real-key',
      SMS_KAVENEGAR_SENDER: '10004346',
      SMS_KAVENEGAR_OTP_TEMPLATE: 'shopino-otp',
    });

    expect(config.SMS_PROVIDER).toBe('kavenegar');
  });

  it('rejects an unknown SMS provider name', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, SMS_PROVIDER: 'twilio' })).toThrow(/SMS_PROVIDER/);
  });

  it('rejects JWT secrets that are too short to be safe', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects an unsupported log level', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  // ── Phase 4: storage configuration ─────────────────────────────────────────

  it('defaults to the local storage provider with an API-hosted public base URL', () => {
    const config = validateEnvironment(VALID_ENV);

    expect(config.STORAGE_PROVIDER).toBe('local');
    expect(config.STORAGE_LOCAL_ROOT).toBe('uploads');
    expect(config.STORAGE_PUBLIC_BASE_URL).toBe('/api/v1/media/files');
    expect(config.MEDIA_MAX_IMAGE_BYTES).toBe(5_242_880);
    expect(config.MEDIA_MAX_DOCUMENT_BYTES).toBe(10_485_760);
  });

  it('coerces the media size ceilings from the environment', () => {
    const config = validateEnvironment({
      ...VALID_ENV,
      MEDIA_MAX_IMAGE_BYTES: '1048576',
      MEDIA_MAX_DOCUMENT_BYTES: '20971520',
    });

    expect(config.MEDIA_MAX_IMAGE_BYTES).toBe(1_048_576);
    expect(config.MEDIA_MAX_DOCUMENT_BYTES).toBe(20_971_520);
  });

  it('rejects an unknown storage provider and an absurd size ceiling', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, STORAGE_PROVIDER: 'ftp' })).toThrow(
      /STORAGE_PROVIDER must be one of: local, s3/,
    );
    expect(() => validateEnvironment({ ...VALID_ENV, MEDIA_MAX_IMAGE_BYTES: '10' })).toThrow(
      /MEDIA_MAX_IMAGE_BYTES/,
    );
  });

  it('refuses to boot with s3 selected while the bucket or keys are missing', () => {
    expect(() =>
      validateEnvironment({ ...VALID_ENV, STORAGE_PROVIDER: 's3' }, { logger: { warn: jest.fn() } }),
    ).toThrow(/STORAGE_PROVIDER=s3 requires S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY/);
  });

  it('accepts s3 once the bucket and keys are present', () => {
    const config = validateEnvironment(
      {
        ...VALID_ENV,
        STORAGE_PROVIDER: 's3',
        S3_BUCKET: 'shopino-media',
        S3_ACCESS_KEY_ID: 'AKIAEXAMPLE',
        S3_SECRET_ACCESS_KEY: 'secret-value',
        S3_ENDPOINT: 'https://s3.ir-thr-at1.arvanstorage.ir',
      },
      { logger: { warn: jest.fn() } },
    );

    expect(config.STORAGE_PROVIDER).toBe('s3');
    expect(config.S3_BUCKET).toBe('shopino-media');
    expect(config.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('parses boolean flags instead of letting every non-empty string be truthy', () => {
    // `Boolean('false')` is `true`: this is the exact regression the explicit
    // transform exists to prevent, so both directions are asserted.
    const off = validateEnvironment({
      ...VALID_ENV,
      SMS_SANDBOX_LOG_CODES: 'false',
      S3_FORCE_PATH_STYLE: 'false',
    });
    expect(off.SMS_SANDBOX_LOG_CODES).toBe(false);
    expect(off.S3_FORCE_PATH_STYLE).toBe(false);

    const on = validateEnvironment({
      ...VALID_ENV,
      SMS_SANDBOX_LOG_CODES: 'true',
      S3_FORCE_PATH_STYLE: '1',
    });
    expect(on.SMS_SANDBOX_LOG_CODES).toBe(true);
    expect(on.S3_FORCE_PATH_STYLE).toBe(true);

    expect(() => validateEnvironment({ ...VALID_ENV, S3_FORCE_PATH_STYLE: 'maybe' })).toThrow(
      /S3_FORCE_PATH_STYLE/,
    );
  });
});

describe('validateEnvironment — payment gateway', () => {
  it('defaults to the sandbox gateway in development and says so in the log', () => {
    const warn = jest.fn();
    const config = validateEnvironment(VALID_ENV, { logger: { warn } });
    expect(config.PAYMENT_GATEWAY_PROVIDER).toBe('sandbox');
    expect(config.PAYMENT_CALLBACK_GRACE_MINUTES).toBe(20);
    expect(config.ZARINPAL_API_BASE_URL).toBe('https://payment.zarinpal.com');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PAYMENT_GATEWAY_PROVIDER=sandbox/));
  });

  it('requires an absolute public API origin without a path', () => {
    const without: Record<string, unknown> = { ...VALID_ENV };
    delete without.PUBLIC_API_ORIGIN;
    expect(() => validateEnvironment(without)).toThrow(/PUBLIC_API_ORIGIN/);
    expect(() => validateEnvironment({ ...VALID_ENV, PUBLIC_API_ORIGIN: 'https://api.shopino.ir/api/v1' })).toThrow(/PUBLIC_API_ORIGIN/);
    expect(() => validateEnvironment({ ...VALID_ENV, PUBLIC_API_ORIGIN: 'api.shopino.ir' })).toThrow(/PUBLIC_API_ORIGIN/);
  });

  it('refuses the sandbox gateway in production', () => {
    const production = { ...VALID_ENV, NODE_ENV: 'production', SMS_PROVIDER: 'kavenegar', SMS_KAVENEGAR_API_KEY: 'k', SMS_KAVENEGAR_SENDER: 's', SMS_KAVENEGAR_OTP_TEMPLATE: 't' };
    expect(() => validateEnvironment({ ...production, PAYMENT_GATEWAY_PROVIDER: 'sandbox' }, { logger: { warn: jest.fn() } })).toThrow(
      /PAYMENT_GATEWAY_PROVIDER=sandbox cannot be used in production/,
    );
    const config = validateEnvironment({ ...production, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID }, { logger: { warn: jest.fn() } });
    expect(config.PAYMENT_GATEWAY_PROVIDER).toBe('zarinpal');
  });

  it('requires a well-formed merchant id for zarinpal, and treats a blank one as missing', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal' })).toThrow(/requires ZARINPAL_MERCHANT_ID/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: '  ' })).toThrow(/requires ZARINPAL_MERCHANT_ID/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: 'short' })).toThrow(/ZARINPAL_MERCHANT_ID must be/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID, ZARINPAL_API_BASE_URL: 'http://payment.zarinpal.com' })).toThrow(
      /ZARINPAL_API_BASE_URL/,
    );
  });

  it('rejects an unknown gateway and an invalid result redirect', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'mellat' })).toThrow(/PAYMENT_GATEWAY_PROVIDER must be one of/);
    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_RESULT_REDIRECT_URL: 'javascript:alert(1)' })).toThrow(/PAYMENT_RESULT_REDIRECT_URL/);
    const config = validateEnvironment({ ...VALID_ENV, PAYMENT_RESULT_REDIRECT_URL: '/checkout/result' }, { logger: { warn: jest.fn() } });
    expect(config.PAYMENT_RESULT_REDIRECT_URL).toBe('/checkout/result');
  });
});

describe('resolveLogLevels', () => {
  it('enables the requested level and everything more severe', () => {
    expect(resolveLogLevels('error')).toEqual(['error']);
    expect(resolveLogLevels('warn')).toEqual(['error', 'warn']);
    expect(resolveLogLevels('debug')).toEqual(['error', 'warn', 'log', 'debug']);
    expect(resolveLogLevels('verbose')).toEqual(['error', 'warn', 'log', 'debug', 'verbose']);
  });
});

describe('buildCorsOptions', () => {
  const createConfigService = (values: Record<string, unknown>): ConfigService =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  const isAllowed = (options: ReturnType<typeof buildCorsOptions>, origin: string): boolean => {
    const originOption = options.origin;
    if (typeof originOption !== 'function') {
      throw new Error('CORS origin option must be a callback function');
    }

    let allowed = false;
    originOption(origin, (_error: Error | null, result?: unknown) => {
      allowed = result === true;
    });
    return allowed;
  };

  it('allows configured origins in production and refuses unknown ones', () => {
    const options = buildCorsOptions(
      createConfigService({ NODE_ENV: 'production', CORS_ORIGINS: 'https://shopino.ir' }),
    );

    expect(isAllowed(options, 'https://shopino.ir')).toBe(true);
    expect(isAllowed(options, 'https://evil.example')).toBe(false);
  });

  it('allows local origins in development even when CORS_ORIGINS is empty', () => {
    const options = buildCorsOptions(createConfigService({ NODE_ENV: 'development', CORS_ORIGINS: '' }));

    expect(isAllowed(options, 'http://localhost:3000')).toBe(true);
    expect(isAllowed(options, 'https://3000-abc123.e2b.app')).toBe(true);
    expect(isAllowed(options, 'https://evil.example')).toBe(false);
  });

  it('parses a comma separated allow-list and ignores blank entries', () => {
    expect(parseOriginList(' https://a.example , ,https://b.example ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
```

### `apps/backend/src/config/env.validation.ts`

```ts
import { Logger } from '@nestjs/common';
import { plainToInstance, Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
  type ValidationError,
} from 'class-validator';

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** Values accepted by `LOG_LEVEL`, ordered from most to least severe. */
export const LOG_LEVELS = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

/** JWT secrets shorter than this are considered unusable. */
export const MIN_SECRET_LENGTH = 32;

/** SMS providers the API can be configured with. */
export const SMS_PROVIDERS = ['sandbox', 'kavenegar'] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

/** Card-payment (IPG) gateways the API can be configured with. */
export const PAYMENT_GATEWAY_PROVIDERS = ['sandbox', 'zarinpal'] as const;
export type PaymentGatewayProviderName = (typeof PAYMENT_GATEWAY_PROVIDERS)[number];

/** Storage backends the API can be configured with. */
export const STORAGE_PROVIDERS = ['local', 's3'] as const;
export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/\S+$/;

/** JWT lifetimes accept the `@nestjs/jwt` shorthand, e.g. `15m`, `7d`, `12h`. */
const DURATION_PATTERN = /^[1-9][0-9]*[smhd]$/;

const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;
const OPTIONAL_KEYS: readonly string[] = [
  ...SECRET_KEYS,
  'CORS_ORIGINS',
  'LOG_LEVEL',
  'SMS_KAVENEGAR_API_KEY',
  'SMS_KAVENEGAR_SENDER',
  'SMS_KAVENEGAR_OTP_TEMPLATE',
  // S3 settings are blank in `.env` while STORAGE_PROVIDER=local; treating those
  // blanks as "not set" is what keeps the local provider bootable. When
  // STORAGE_PROVIDER=s3 they become mandatory, which `assertStorageConfiguration`
  // enforces with a message that names exactly what is missing.
  'S3_ENDPOINT',
  'S3_BUCKET',
  'S3_ACCESS_KEY_ID',
  'S3_SECRET_ACCESS_KEY',
  'S3_PUBLIC_BASE_URL',
  'ZARINPAL_MERCHANT_ID',
  'PAYMENT_RESULT_REDIRECT_URL',
];

/** Shape of the validated configuration object exposed through `ConfigService`. */
export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 4000;

  @IsString()
  @MinLength(1)
  HOST: string = '0.0.0.0';

  @IsString()
  @Matches(POSTGRES_URL_PATTERN, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL!: string;

  @IsString()
  @Matches(POSTGRES_URL_PATTERN, {
    message: 'DIRECT_URL must be a postgresql:// connection string',
  })
  DIRECT_URL!: string;

  @IsString()
  @MinLength(1)
  REDIS_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  REDIS_PORT!: number;

  @IsString()
  @MinLength(1)
  REDIS_PASSWORD!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(15)
  REDIS_DB: number = 0;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  // ─── Authentication ───────────────────────────────────────────────────────
  // Mandatory from Phase 3 on: the API signs real tokens, so a missing secret is
  // no longer a warning, it is a service that cannot authenticate anyone.
  //
  // `@IsOptional()` here is about *message quality*, not leniency: a blank value
  // is normalized to "not set" and reported by `assertSecrets` with the exact
  // command to generate one. The boot still fails — see the unit tests.
  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
  })
  JWT_ACCESS_SECRET?: string;

  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
  })
  JWT_REFRESH_SECRET?: string;

  /** Access-token lifetime. Short by design; refresh tokens carry the session. */
  @IsString()
  @Matches(DURATION_PATTERN, { message: 'JWT_ACCESS_TTL must look like 15m, 1h or 7d' })
  JWT_ACCESS_TTL: string = '15m';

  /** Refresh-token lifetime. Persistent session length. */
  @IsString()
  @Matches(DURATION_PATTERN, { message: 'JWT_REFRESH_TTL must look like 15m, 1h or 7d' })
  JWT_REFRESH_TTL: string = '7d';

  // ─── OTP policy ───────────────────────────────────────────────────────────
  /** Validity of a generated code. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(600)
  OTP_TTL_SECONDS: number = 120;

  /** Digits in the generated code (cryptographically secure, never sequential). */
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(8)
  OTP_LENGTH: number = 5;

  /** Minimum delay between two OTP requests for the same mobile number. */
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(600)
  OTP_REQUEST_COOLDOWN_SECONDS: number = 120;

  /** Wrong codes tolerated per mobile number before the account is locked. */
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(10)
  OTP_MAX_VERIFY_ATTEMPTS: number = 5;

  /** How long a number stays locked after exceeding the attempt budget. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86_400)
  OTP_LOCK_SECONDS: number = 900;

  /** Ceiling per mobile number per hour, independent of the cooldown. */
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(100)
  OTP_MAX_REQUESTS_PER_HOUR: number = 5;

  /** Ceiling per client IP per hour; stops distributed enumeration of numbers. */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(500)
  OTP_MAX_REQUESTS_PER_IP_PER_HOUR: number = 20;

  // ─── Password login policy ────────────────────────────────────────────────
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(20)
  AUTH_MAX_LOGIN_ATTEMPTS: number = 5;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86_400)
  AUTH_LOCK_SECONDS: number = 900;

  // ─── SMS provider ─────────────────────────────────────────────────────────
  @IsIn(SMS_PROVIDERS, { message: `SMS_PROVIDER must be one of: ${SMS_PROVIDERS.join(', ')}` })
  SMS_PROVIDER: SmsProviderName = 'sandbox';

  /** Prints OTP codes to the log. Only meaningful for the sandbox provider. */
  @Transform(toBoolean)
  @IsBoolean()
  SMS_SANDBOX_LOG_CODES: boolean = true;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_API_KEY?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_SENDER?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_OTP_TEMPLATE?: string;

  // ─── File storage ─────────────────────────────────────────────────────────
  /**
   * `local` writes to {@link STORAGE_LOCAL_ROOT} and serves the files through the
   * API; `s3` talks to any S3-compatible object store (AWS, ArvanCloud, Liara,
   * MinIO). Selected once at boot by `StorageModule`.
   */
  @IsIn(STORAGE_PROVIDERS, { message: `STORAGE_PROVIDER must be one of: ${STORAGE_PROVIDERS.join(', ')}` })
  STORAGE_PROVIDER: StorageProviderName = 'local';

  /** Uploads root for the local provider. Relative paths resolve from the app cwd. */
  @IsString()
  @MinLength(1)
  STORAGE_LOCAL_ROOT: string = 'uploads';

  /**
   * Base URL the stored objects are published under. The default points at the
   * API's own file route, so a fresh checkout serves uploads without any extra
   * configuration; set it to a CDN origin in production.
   */
  @IsString()
  @MinLength(1)
  STORAGE_PUBLIC_BASE_URL: string = '/api/v1/media/files';

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_ENDPOINT?: string;

  @IsString()
  @MinLength(1)
  S3_REGION: string = 'ir-thr-at1';

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_BUCKET?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_ACCESS_KEY_ID?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_SECRET_ACCESS_KEY?: string;

  /**
   * Path-style addressing (`endpoint/bucket/key`). Required by ArvanCloud and
   * Liara with a custom endpoint; AWS deprecated it, hence the `false` default.
   */
  @Transform(toBoolean)
  @IsBoolean()
  S3_FORCE_PATH_STYLE: boolean = true;

  /** CDN or custom domain in front of the bucket; falls back to endpoint/bucket. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  S3_PUBLIC_BASE_URL?: string;

  // ─── Media limits ─────────────────────────────────────────────────────────
  /** Ceiling for an uploaded image (default 5 MiB). */
  @Type(() => Number)
  @IsInt()
  @Min(64 * 1024)
  @Max(50 * 1024 * 1024)
  MEDIA_MAX_IMAGE_BYTES: number = 5_242_880;

  /** Ceiling for an uploaded document (default 10 MiB). */
  @Type(() => Number)
  @IsInt()
  @Min(64 * 1024)
  @Max(100 * 1024 * 1024)
  MEDIA_MAX_DOCUMENT_BYTES: number = 10_485_760;

  // ─── Commerce: shipping and order lifecycle ────────────────────────────────
  /**
   * Platform default shipping fee per store package, in the platform currency
   * (`platform.currency`, IRR). Fallback when the `system_configs` key
   * `shipping.default_fee_per_vendor` is absent. Required: the fee is a business
   * value and has no code default.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  SHIPPING_DEFAULT_FEE_PER_VENDOR!: number;

  /**
   * Store-package subtotal at which shipping becomes free (platform currency);
   * `0` disables free shipping. Fallback for `shipping.free_threshold_per_vendor`.
   */
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  SHIPPING_FREE_THRESHOLD_PER_VENDOR!: number;

  /** Minutes an unpaid order keeps its stock reservation before it is cancelled. */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(24 * 60)
  ORDER_PAYMENT_TIMEOUT_MINUTES: number = 30;

  /** How often the expiry sweeper runs, in seconds; `0` disables it on this instance. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3600)
  ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS: number = 60;

  /**
   * Absolute origin the *customer's browser* and the bank reach this API on
   * (scheme + host [+ port], no path). Used to build the gateway callback URL
   * and the sandbox bank page URL.
   */
  @Matches(/^https?:\/\/[^/\s]+$/, { message: 'PUBLIC_API_ORIGIN must be an absolute origin such as https://api.example.com (no path, no trailing slash)' })
  PUBLIC_API_ORIGIN!: string;

  @IsIn(PAYMENT_GATEWAY_PROVIDERS, { message: `PAYMENT_GATEWAY_PROVIDER must be one of: ${PAYMENT_GATEWAY_PROVIDERS.join(', ')}` })
  PAYMENT_GATEWAY_PROVIDER: PaymentGatewayProviderName = 'sandbox';

  /** Zarinpal merchant id (36-character UUID). Required when PAYMENT_GATEWAY_PROVIDER=zarinpal. */
  @IsOptional()
  @Matches(/^[0-9a-fA-F-]{36}$/, { message: 'ZARINPAL_MERCHANT_ID must be the 36-character merchant id issued by Zarinpal' })
  ZARINPAL_MERCHANT_ID?: string;

  /** Zarinpal host: https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com (Zarinpal's own test host). */
  @Matches(/^https:\/\/[^/\s]+$/, { message: 'ZARINPAL_API_BASE_URL must be an https origin without a path' })
  ZARINPAL_API_BASE_URL: string = 'https://payment.zarinpal.com';

  /** Timeout of one call to the gateway API, in milliseconds. */
  @Type(() => Number)
  @IsInt()
  @Min(1000)
  @Max(60_000)
  PAYMENT_GATEWAY_TIMEOUT_MS: number = 15_000;

  /**
   * Optional frontend page the payment callback redirects the browser to
   * (`?orderNumber=…&status=…`). When unset the callback answers with JSON.
   */
  @IsOptional()
  @Matches(/^(https?:\/\/\S+|\/\S*)$/, { message: 'PAYMENT_RESULT_REDIRECT_URL must be an absolute URL or a path starting with /' })
  PAYMENT_RESULT_REDIRECT_URL?: string;

  /**
   * Minutes after which an INITIATED payment no longer protects its order from
   * the expiry sweeper (the customer is assumed to have abandoned the bank page).
   */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(120)
  PAYMENT_CALLBACK_GRACE_MINUTES: number = 20;

  @IsOptional()
  @IsIn(LOG_LEVELS, { message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
  LOG_LEVEL?: LogLevelName;
}

export interface EnvironmentValidationOptions {
  /** Injected in tests; defaults to a Nest logger scoped to this module. */
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Validates the raw process environment (and `.env` contents) for
 * `ConfigModule.forRoot({ validate })`.
 *
 * Structural problems always fail the boot, and so does anything that would
 * silently degrade security: missing JWT secrets, an SMS provider that cannot
 * deliver, or a test provider in production.
 */
export function validateEnvironment(
  raw: Record<string, unknown>,
  options: EnvironmentValidationOptions = {},
): EnvironmentVariables {
  const logger = options.logger ?? new Logger('EnvironmentValidation');
  const config = plainToInstance(EnvironmentVariables, normalizeEmptyValues(raw));
  const errors = validateSync(config, { forbidUnknownValues: false, whitelist: false });

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n${formatValidationErrors(errors)}`);
  }

  assertSecrets(config);
  assertSmsConfiguration(config, logger);
  assertStorageConfiguration(config, logger);
  assertPaymentConfiguration(config, logger);
  return config;
}

/**
 * Parses a boolean environment variable.
 *
 * `@Type(() => Boolean)` is wrong for this job: `Boolean('false')` is `true`, so
 * `SMS_SANDBOX_LOG_CODES=false` would silently turn logging *on*. Every value the
 * dotenv file can contain is handled explicitly, and anything unrecognized is
 * passed through so `@IsBoolean()` rejects it with a clear message instead of
 * guessing.
 */
function toBoolean({ value }: { value: unknown }): unknown {
  if (typeof value === 'boolean' || value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }
    if (['false', '0', 'no', 'off', ''].includes(normalized)) {
      return false;
    }
  }
  return value;
}

/** Treats blank values (`KEY=`) as "not set" so optional keys stay optional. */
function normalizeEmptyValues(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw };
  for (const key of OPTIONAL_KEYS) {
    const value = normalized[key];
    if (typeof value === 'string' && value.trim() === '') {
      delete normalized[key];
    }
  }
  return normalized;
}

/**
 * Secrets are required in every environment from Phase 3 on. Development still
 * gets its values from `.env` (generated with `openssl rand -base64 48`), so the
 * absence of one means a broken checkout, and a broken checkout must not boot
 * with an API that silently cannot authenticate anyone.
 */
function assertSecrets(config: EnvironmentVariables): void {
  const missing = SECRET_KEYS.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}. ` +
        'Generate values with "openssl rand -base64 48" and add them to .env (never commit them).',
    );
  }
}

/** Cross-field checks that a per-property validator cannot express. */
function assertSmsConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  if (config.SMS_PROVIDER === 'kavenegar') {
    const required = [
      'SMS_KAVENEGAR_API_KEY',
      'SMS_KAVENEGAR_SENDER',
      'SMS_KAVENEGAR_OTP_TEMPLATE',
    ] as const;
    const missing = required.filter((key) => {
      const value = config[key];
      return typeof value !== 'string' || value.trim() === '';
    });

    if (missing.length > 0) {
      throw new Error(
        `SMS_PROVIDER=kavenegar requires ${missing.join(', ')}. ` +
          'Provide the real gateway credentials, or use SMS_PROVIDER=sandbox in development.',
      );
    }
    return;
  }

  if (config.NODE_ENV === NodeEnvironment.Production) {
    throw new Error(
      'SMS_PROVIDER=sandbox cannot be used in production: it logs codes instead of delivering them. ' +
        'Configure SMS_PROVIDER=kavenegar with real credentials.',
    );
  }

  if (config.SMS_SANDBOX_LOG_CODES) {
    logger.warn(
      'SMS_PROVIDER=sandbox — OTP codes are written to the application log and not delivered by SMS. ' +
        'This is a development/test provider only.',
    );
  }
}

/**
 * Cross-field checks for the storage configuration.
 *
 * `s3` without credentials must fail at boot: discovering it at the first upload
 * would mean a vendor submits KYC documents and gets a 503 they cannot act on.
 */
function assertStorageConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  if (config.STORAGE_PROVIDER === 's3') {
    const required = ['S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'] as const;
    const missing = required.filter((key) => {
      const value = config[key];
      return typeof value !== 'string' || value.trim() === '';
    });

    if (missing.length > 0) {
      throw new Error(
        `STORAGE_PROVIDER=s3 requires ${missing.join(', ')}. ` +
          'Provide the object-storage credentials, or use STORAGE_PROVIDER=local in development.',
      );
    }
    return;
  }

  if (config.NODE_ENV === NodeEnvironment.Production) {
    logger.warn(
      `STORAGE_PROVIDER=local in production: uploads are written to "${config.STORAGE_LOCAL_ROOT}" on this host. ` +
        'This is only safe for a single-node deployment with a persistent volume — use s3 otherwise.',
    );
  }
}

/**
 * The sandbox gateway simulates the bank inside this API and would mark orders
 * paid without any money moving, so it can never run in production; Zarinpal
 * needs its merchant id at boot, not at the first checkout.
 */
function assertPaymentConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  if (config.PAYMENT_GATEWAY_PROVIDER === 'zarinpal') {
    if (config.ZARINPAL_MERCHANT_ID === undefined) {
      throw new Error(
        'PAYMENT_GATEWAY_PROVIDER=zarinpal requires ZARINPAL_MERCHANT_ID. ' +
          'Provide the merchant id issued by Zarinpal, or use PAYMENT_GATEWAY_PROVIDER=sandbox in development.',
      );
    }
    return;
  }

  if (config.NODE_ENV === NodeEnvironment.Production) {
    throw new Error(
      'PAYMENT_GATEWAY_PROVIDER=sandbox cannot be used in production: it simulates the bank and confirms payments without moving money. ' +
        'Configure PAYMENT_GATEWAY_PROVIDER=zarinpal with a real merchant id.',
    );
  }

  logger.warn(
    'PAYMENT_GATEWAY_PROVIDER=sandbox — card payments are simulated by the built-in sandbox bank page; no money moves. ' +
      'This is a development/test provider only.',
  );
}

function formatValidationErrors(errors: readonly ValidationError[], parentPath = ''): string {
  return errors
    .flatMap((error) => {
      const path = parentPath ? `${parentPath}.${error.property}` : error.property;
      const ownMessages = error.constraints ? Object.values(error.constraints) : [];
      const childMessages = error.children?.length ? [formatValidationErrors(error.children, path)] : [];
      return [...ownMessages, ...childMessages];
    })
    .join('\n');
}
```

### `apps/backend/src/modules/financial/admin-financial.controller.ts`

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { FinancialOverviewDto, FinancialOverviewQueryDto } from './dto/financial.dto';
import { FinancialService } from './financial.service';

@ApiTags('admin-financial')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Finance staff and admins only' })
@Controller('admin/financial')
export class AdminFinancialController {
  constructor(private readonly financial: FinancialService) {}

  @Get('overview')
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Platform financial overview',
    description:
      'GMV, shipping, cash collected, commission (earned on delivery vs pending), wallet totals (escrow held, withdrawable, ' +
      'held for settlement, paid out) with a live ledger reconciliation check, and settlement figures. Optional from/to window ' +
      'applies to sales (order paidAt), captured payments (paidAt) and paid settlements (processedAt); balances are current.',
  })
  @ApiOkResponse({ type: FinancialOverviewDto })
  @ApiBadRequestResponse({ description: 'Invalid window' })
  overview(@Query() query: FinancialOverviewQueryDto): Promise<FinancialOverviewDto> {
    return this.financial.overview(query);
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
  @ApiProperty({ ...MONEY, description: 'Cash captured by the gateway (SUCCESSFUL payments), including captures awaiting manual refund.' })
  collectedByGateway!: string;
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
}
```

### `apps/backend/src/modules/financial/financial.module.ts`

```ts
import { Module } from '@nestjs/common';
import { AdminFinancialController } from './admin-financial.controller';
import { FinancialService } from './financial.service';

@Module({
  controllers: [AdminFinancialController],
  providers: [FinancialService],
})
export class FinancialModule {}
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
    const paymentWindow = Prisma.sql`${from ? Prisma.sql`AND paid_at >= ${from}` : Prisma.empty} ${to ? Prisma.sql`AND paid_at < ${to}` : Prisma.empty}`;

    const [sales, collected, wallets, reconciliation, settlements, manualRefunds] = await this.prisma.$transaction([
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
      this.prisma.$queryRaw<Array<{ collected: Money }>>(Prisma.sql`
        SELECT SUM(cash_amount) AS collected FROM payments WHERE status = 'SUCCESSFUL' ${paymentWindow}`),
      this.prisma.$queryRaw<Array<{ pending: Money; withdrawable: Money; hold: Money; withdrawn: Money }>>(Prisma.sql`
        SELECT SUM(pending_balance) AS pending, SUM(withdrawable_balance) AS withdrawable,
               SUM(settlement_hold_balance) AS hold, SUM(total_withdrawn_amount) AS withdrawn
        FROM vendor_wallets`),
      this.prisma.$queryRaw<Array<{ inconsistent: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS inconsistent FROM (
          SELECT w.id
          FROM vendor_wallets w
          LEFT JOIN wallet_transactions t ON t.wallet_id = w.id
          GROUP BY w.id, w.pending_balance, w.withdrawable_balance, w.settlement_hold_balance
          HAVING COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'PENDING'), 0) <> w.pending_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'WITHDRAWABLE'), 0) <> w.withdrawable_balance
              OR COALESCE(SUM(t.amount) FILTER (WHERE t.bucket = 'SETTLEMENT_HOLD'), 0) <> w.settlement_hold_balance
        ) AS drift`),
      this.prisma.$queryRaw<Array<{ pending_count: bigint; pending_amount: Money; paid_count: bigint; paid_amount: Money }>>(Prisma.sql`
        SELECT COUNT(*) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS pending_count,
               SUM(amount) FILTER (WHERE status IN ('REQUESTED', 'PROCESSING')) AS pending_amount,
               COUNT(*) FILTER (WHERE status = 'PAID_PAYA' ${processedWindow}) AS paid_count,
               SUM(amount) FILTER (WHERE status = 'PAID_PAYA' ${processedWindow}) AS paid_amount
        FROM settlement_requests`),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS count FROM payments WHERE status = 'SUCCESSFUL' AND metadata ->> 'requiresManualRefund' = 'true'`),
    ]);

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
      },
      commission: { earned: earned.toFixed(2), pending: pending.toFixed(2), total: earned.plus(pending).toFixed(2) },
      wallets: {
        escrowHeld: money(w?.pending ?? null),
        withdrawable: money(w?.withdrawable ?? null),
        settlementHold: money(w?.hold ?? null),
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
    };
  }
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
      walletAction: result.walletAction,
      auditLogId: result.auditLogId,
      subOrder: await this.queries.subOrderForStaff(id),
    };
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
import { CancelOrderResponseDto, CustomerDeliveryConfirmationDto, CustomerOrderDetailDto, PaginatedCustomerOrdersDto } from './dto/order-response.dto';
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

  @Post(':id/sub-orders/:subOrderId/confirm-delivery')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Confirm receipt of a shipped package',
    description:
      'Moves a SHIPPED package of a paid order to DELIVERED. In the same transaction the store’s earnings for the package are ' +
      'released from escrow to its withdrawable balance (once; repeated calls are rejected).',
  })
  @ApiOkResponse({ type: CustomerDeliveryConfirmationDto })
  @ApiNotFoundResponse({ description: 'Unknown order/package or not the caller’s' })
  @ApiConflictResponse({ description: 'INVALID_STATUS_TRANSITION (only SHIPPED packages can be confirmed)' })
  async confirmDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UUID) id: string,
    @Param('subOrderId', UUID) subOrderId: string,
    @ClientContext() context: RequestContext,
  ): Promise<CustomerDeliveryConfirmationDto> {
    const result = await this.lifecycle.confirmDeliveryByCustomer(user.id, id, subOrderId, { actorId: user.id, context });
    return {
      previousStatus: result.previousStatus,
      stockAction: result.stockAction,
      walletAction: result.walletAction,
      auditLogId: result.auditLogId,
      order: await this.queries.detailForCustomer(user.id, id),
    };
  }
}
```

### `apps/backend/src/modules/orders/dto/order-response.dto.ts`

```ts
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
    enum: ['ESCROW_RELEASED', 'ESCROW_REVERSED', 'EARNINGS_REVERSED', 'NONE'],
    description:
      'Wallet consequence: ESCROW_RELEASED (delivered → withdrawable), ESCROW_REVERSED (cancel/refund before delivery, out of escrow), ' +
      'EARNINGS_REVERSED (refund after delivery, out of the withdrawable balance), NONE.',
  })
  walletAction!: 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'NONE';
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
    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest';
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
import { AuditAction, ParentOrderPaymentStatus, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
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

export interface TransitionResult {
  subOrderId: string;
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  /** Wallet consequence: escrow released on delivery, or the vendor's earnings reversed on cancel/refund. */
  walletAction: 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'NONE';
  auditLogId: string;
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
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.paymentGraceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

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
   * to vendors because the parent is now PAID.
   */
  async applyPaymentLocked(tx: Tx, parentOrderId: string, actor: OrderActor, payment: { paymentId?: string; bankRrn?: string }): Promise<PaymentApplication> {
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
      data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt },
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
        const done = await this.prisma.$transaction(async (tx) => {
          const order = await this.lockPending(tx, id);
          if (!order || order.paymentExpiresAt === null || order.paymentExpiresAt > now) return false;
          if ((await tx.parentOrder.count({ where: { id, ...inFlight } })) > 0) return false;
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
    const walletAction = await this.applyWalletEffect(tx, sub, target, meta.note);
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
        walletAction,
        ...(walletAction !== 'NONE' ? { vendorEarningsAmount: sub.vendorEarningsAmount.toFixed(2) } : {}),
        ...(restock ? { restockedLines: stockMovements(sub.items) } : {}),
      },
    });
    return { subOrderId: sub.id, previousStatus: sub.status, stockAction: restock ? 'RESTOCKED' : 'NONE', walletAction, auditLogId };
  }

  /** Escrow consequence of a transition on a paid package; runs under the parent lock, before the audit row. */
  private async applyWalletEffect(tx: Tx, sub: TransitionRow, target: SubOrderStatus, note: string | null): Promise<TransitionResult['walletAction']> {
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
  parentOrder: { select: { paymentStatus: true, userId: true } },
  items: { select: { productVariantId: true, quantity: true } },
} satisfies Prisma.SubOrderSelect;

type TransitionRow = Prisma.SubOrderGetPayload<{ select: typeof transitionSelect }>;
```

### `apps/backend/src/modules/orders/orders.module.ts`

```ts
import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CategoriesModule } from '../categories/categories.module';
import { ProductsModule } from '../products/products.module';
import { ShippingModule } from '../shipping/shipping.module';
import { WalletModule } from '../wallet/wallet.module';
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
 * `OrderLifecycleService` is exported for the payment module
 * (applyPaymentLocked / markPaid); it moves wallet money through
 * `WalletLedgerService` inside its own transactions.
 */
@Module({
  imports: [CartModule, CategoriesModule, ProductsModule, ShippingModule, WalletModule],
  controllers: [CheckoutController, CustomerOrdersController, VendorOrdersController, AdminOrdersController],
  providers: [CheckoutService, OrderLifecycleService, OrderQueriesService, OrderExpiryScheduler],
  exports: [OrderLifecycleService],
})
export class OrdersModule {}
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
      walletAction: result.walletAction,
      auditLogId: result.auditLogId,
      subOrder: await this.queries.detailForVendor(user.id, id),
    };
  }
}
```

### `apps/backend/src/modules/payments/dto/payment.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, PaymentStatus } from '@prisma/client';
import { IsUUID } from 'class-validator';

const MONEY = { type: String, example: '5750000.00', description: 'IRR (Rial), 2 decimals, as a string.' } as const;

export class InitiatePaymentDto {
  @ApiProperty({ format: 'uuid', description: 'An unpaid (PENDING) order of the caller.' })
  @IsUUID('4')
  parentOrderId!: string;
}

export class InitiatePaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ description: 'Send the customer’s browser here to pay.', example: 'https://payment.zarinpal.com/pg/StartPay/A00000000000000000000000000217885159' })
  redirectUrl!: string;
  @ApiProperty({ enum: ['SANDBOX', 'ZARINPAL'], description: 'Active gateway. SANDBOX = simulated bank, development/test only.' })
  gatewayName!: 'SANDBOX' | 'ZARINPAL';
  @ApiProperty(MONEY) amount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ nullable: true, type: Date, description: 'The order is cancelled and its stock released if unpaid by then.' })
  paymentExpiresAt!: Date | null;
}

export const PAYMENT_OUTCOMES = ['PAID', 'FAILED', 'VERIFICATION_PENDING', 'PAID_REQUIRES_REFUND'] as const;
export type PaymentOutcome = (typeof PAYMENT_OUTCOMES)[number];

export class PaymentOutcomeDto {
  @ApiProperty({
    enum: PAYMENT_OUTCOMES,
    description:
      'PAID = verified and the order is paid. FAILED = not paid (see canRetry). VERIFICATION_PENDING = the gateway could not be reached; ' +
      'the payment stays INITIATED and the same callback can be retried. PAID_REQUIRES_REFUND = the bank captured the money but the order ' +
      'had already been paid or closed; finance must refund it manually.',
  })
  outcome!: PaymentOutcome;
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ enum: PaymentStatus }) paymentStatus!: PaymentStatus;
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) orderPaymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ nullable: true, type: String, example: '712345678901', description: 'Bank reference number of a successful payment.' })
  bankRrn!: string | null;
  @ApiProperty() message!: string;
  @ApiProperty({ description: 'True when the order is still unpaid and inside its payment window: a new payment can be initiated.' })
  canRetry!: boolean;
  @ApiProperty({ nullable: true, type: Date }) paymentExpiresAt!: Date | null;
}
```

### `apps/backend/src/modules/payments/dto/sandbox.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class SandboxDecisionDto {
  @ApiProperty({ enum: ['PAY', 'DECLINE'], description: 'The simulated payer’s choice on the sandbox bank page.' })
  @IsIn(['PAY', 'DECLINE'])
  decision!: 'PAY' | 'DECLINE';
}
```

### `apps/backend/src/modules/payments/gateway/payment-gateway.interface.ts`

```ts
import type { Prisma } from '@prisma/client';

/** DI token of the active `PaymentGatewayProvider` (selected by PAYMENT_GATEWAY_PROVIDER at boot). */
export const PAYMENT_GATEWAY = Symbol('PAYMENT_GATEWAY');

/** Name stored in `payments.gateway_name`; callbacks are matched on (name, token). */
export type PaymentGatewayName = 'SANDBOX' | 'ZARINPAL';

/** What a gateway needs to open a payment session for an order. */
export interface GatewayOrder {
  paymentId: string;
  orderNumber: string;
  /** Amount to charge, in IRR (the platform currency). Must be a whole number of rials. */
  amount: Prisma.Decimal;
  description: string;
  customerMobile: string | null;
}

export interface GatewayInitiation {
  /** Gateway session token (Zarinpal "authority"); comes back in the callback. */
  gatewayToken: string;
  /** Where the customer's browser is sent to pay. */
  redirectUrl: string;
  /** Non-sensitive gateway data kept in `payments.metadata` (fees etc.). */
  details: Record<string, unknown>;
}

/** The fields a callback carries, normalised across gateways. */
export interface GatewayCallback {
  gatewayToken: string | null;
  /** The bank's own verdict in the redirect (`OK` / `NOK`); never trusted without `verifyPayment`. */
  bankStatus: 'OK' | 'NOK' | null;
}

export interface GatewayVerification {
  /** True only when the gateway confirmed the money was captured for exactly this amount. */
  success: boolean;
  /** Gateway said "already verified" (Zarinpal 101): still a success, returned on repeat calls. */
  alreadyVerified: boolean;
  /** Bank reference (RRN / Zarinpal ref_id) of a successful payment. */
  bankRrn: string | null;
  /** Masked card number, e.g. 502229******5995 (never the full PAN). */
  cardPanMasked: string | null;
  code: string;
  message: string;
}

/**
 * A card-payment gateway (IPG). Implementations must be stateless apart from
 * the gateway itself: the payment service persists everything that matters.
 *
 * - `initiatePayment` opens a bank session and returns where to send the customer.
 * - `parseCallback` extracts the session token and the bank's redirect status.
 * - `verifyPayment` asks the gateway server-to-server whether the money was
 *   captured; it is the only source of truth for success.
 *
 * Transport problems (timeout, 5xx, unreadable answer) throw a retryable
 * `PaymentGatewayError`; a definitive "not paid" is a `success: false` result.
 */
export interface PaymentGatewayProvider {
  readonly name: PaymentGatewayName;
  initiatePayment(order: GatewayOrder, callbackUrl: string): Promise<GatewayInitiation>;
  parseCallback(params: Record<string, unknown>): GatewayCallback;
  verifyPayment(gatewayToken: string, params: { amount: Prisma.Decimal; bankStatus: 'OK' | 'NOK' | null }): Promise<GatewayVerification>;
}

/** A gateway call failed. `retryable` = transport problem, the outcome is unknown. */
export class PaymentGatewayError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}

/** IRR amount as the integer gateways expect; refuses fractions instead of rounding money. */
export function toWholeRials(amount: Prisma.Decimal): number {
  if (!amount.isInteger() || !amount.isPositive()) {
    throw new PaymentGatewayError(`Amount ${amount.toFixed(2)} is not a positive whole number of rials`, 'INVALID_AMOUNT', false);
  }
  const value = amount.toNumber();
  if (!Number.isSafeInteger(value)) {
    throw new PaymentGatewayError(`Amount ${amount.toFixed(0)} is too large`, 'INVALID_AMOUNT', false);
  }
  return value;
}

export function firstString(value: unknown): string | null {
  const candidate = Array.isArray(value) ? (value[0] as unknown) : value;
  return typeof candidate === 'string' && candidate.trim() !== '' ? candidate.trim() : null;
}

export function bankStatusOf(value: unknown): 'OK' | 'NOK' | null {
  const status = firstString(value)?.toUpperCase();
  return status === 'OK' || status === 'NOK' ? status : null;
}
```

### `apps/backend/src/modules/payments/gateway/sandbox-payment-gateway.provider.ts`

```ts
import { Prisma } from '@prisma/client';
import { randomBytes, randomInt } from 'node:crypto';
import type { RedisService } from '../../../infra/redis/redis.service';
import {
  bankStatusOf,
  firstString,
  PaymentGatewayError,
  toWholeRials,
  type GatewayCallback,
  type GatewayInitiation,
  type GatewayOrder,
  type GatewayVerification,
  type PaymentGatewayProvider,
} from './payment-gateway.interface';

/** Bank session lifetime; longer than any order payment window. */
export const SANDBOX_SESSION_TTL_SECONDS = 2 * 60 * 60;

const SESSION_KEY = (authority: string): string => `payment:sandbox:session:${authority}`;
const PAYMENT_KEY = (paymentId: string): string => `payment:sandbox:payment:${paymentId}`;

export type SandboxSessionStatus = 'AWAITING_PAYER' | 'PAID' | 'DECLINED';

/** State of one simulated bank session, as the "bank" (Redis) keeps it. */
export interface SandboxSession {
  authority: string;
  paymentId: string;
  orderNumber: string;
  amount: string;
  callbackUrl: string;
  status: SandboxSessionStatus;
  bankRrn: string | null;
  cardPanMasked: string | null;
  verifiedAt: string | null;
  createdAt: string;
}

/**
 * DEVELOPMENT / TEST ONLY. A self-contained simulated bank that follows the
 * Zarinpal-style flow end to end, so the whole payment path (initiate →
 * redirect → payer decision → callback → server-side verify) runs for real
 * without a merchant account:
 *
 * - `initiatePayment` opens a session in Redis and returns the URL of the
 *   built-in bank page (`GET /api/v1/sandbox/payment-page/:paymentId`);
 * - the page's Pay / Decline buttons settle the session (with a random 12-digit
 *   RRN on success) and redirect the browser to the callback with
 *   `Authority` + `Status=OK|NOK`;
 * - `verifyPayment` checks the session state *and the amount*, like a bank:
 *   100 on the first verify, 101 afterwards.
 *
 * No money moves. The API refuses to boot with this provider in production
 * (env.validation.ts) and the bank page answers 404 unless it is active.
 */
export class SandboxPaymentGatewayProvider implements PaymentGatewayProvider {
  readonly name = 'SANDBOX' as const;

  constructor(
    private readonly redis: RedisService,
    private readonly publicApiOrigin: string,
  ) {}

  async initiatePayment(order: GatewayOrder, callbackUrl: string): Promise<GatewayInitiation> {
    const amount = toWholeRials(order.amount);
    const authority = `SBX${randomBytes(16).toString('hex').toUpperCase()}`;
    const session: SandboxSession = {
      authority,
      paymentId: order.paymentId,
      orderNumber: order.orderNumber,
      amount: String(amount),
      callbackUrl,
      status: 'AWAITING_PAYER',
      bankRrn: null,
      cardPanMasked: null,
      verifiedAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.redis.client
      .multi()
      .set(SESSION_KEY(authority), JSON.stringify(session), 'EX', SANDBOX_SESSION_TTL_SECONDS)
      .set(PAYMENT_KEY(order.paymentId), authority, 'EX', SANDBOX_SESSION_TTL_SECONDS)
      .exec();
    return {
      gatewayToken: authority,
      redirectUrl: `${this.publicApiOrigin}/api/v1/sandbox/payment-page/${order.paymentId}`,
      details: { simulated: true },
    };
  }

  parseCallback(params: Record<string, unknown>): GatewayCallback {
    return { gatewayToken: firstString(params['Authority']), bankStatus: bankStatusOf(params['Status']) };
  }

  async verifyPayment(gatewayToken: string, params: { amount: Prisma.Decimal; bankStatus: 'OK' | 'NOK' | null }): Promise<GatewayVerification> {
    if (params.bankStatus !== 'OK') {
      return failure('NOK', 'The payment was cancelled or declined at the (sandbox) bank');
    }
    const session = await this.sessionByAuthority(gatewayToken);
    if (!session) {
      return failure('SESSION_NOT_FOUND', 'Unknown or expired sandbox bank session');
    }
    if (session.status !== 'PAID') {
      return failure('NOT_PAID', `The sandbox bank session is ${session.status}`);
    }
    if (!new Prisma.Decimal(session.amount).equals(params.amount)) {
      return failure('AMOUNT_MISMATCH', `Verified amount ${params.amount.toFixed(0)} does not match the paid amount ${session.amount}`);
    }
    const alreadyVerified = session.verifiedAt !== null;
    if (!alreadyVerified) {
      await this.save({ ...session, verifiedAt: new Date().toISOString() });
    }
    return {
      success: true,
      alreadyVerified,
      bankRrn: session.bankRrn,
      cardPanMasked: session.cardPanMasked,
      code: alreadyVerified ? '101' : '100',
      message: alreadyVerified ? 'Already verified' : 'Verified',
    };
  }

  // ─── used by the sandbox bank page ────────────────────────────────────────

  async sessionByPayment(paymentId: string): Promise<SandboxSession | null> {
    const authority = await this.redis.client.get(PAYMENT_KEY(paymentId));
    return authority ? this.sessionByAuthority(authority) : null;
  }

  /**
   * The payer's decision on the bank page. Only an AWAITING_PAYER session can be
   * settled (a second click cannot turn a decline into a payment). Returns the
   * callback URL the browser must be sent to.
   */
  async settle(paymentId: string, decision: 'PAY' | 'DECLINE'): Promise<{ session: SandboxSession; redirectTo: string }> {
    const session = await this.sessionByPayment(paymentId);
    if (!session) {
      throw new PaymentGatewayError('Unknown or expired sandbox bank session', 'SESSION_NOT_FOUND', false);
    }
    let settled = session;
    if (session.status === 'AWAITING_PAYER') {
      settled =
        decision === 'PAY'
          ? { ...session, status: 'PAID', bankRrn: randomRrn(), cardPanMasked: `603799******${String(randomInt(0, 10_000)).padStart(4, '0')}` }
          : { ...session, status: 'DECLINED' };
      await this.save(settled);
    }
    const url = new URL(settled.callbackUrl);
    url.searchParams.set('Authority', settled.authority);
    url.searchParams.set('Status', settled.status === 'PAID' ? 'OK' : 'NOK');
    return { session: settled, redirectTo: url.toString() };
  }

  private async sessionByAuthority(authority: string): Promise<SandboxSession | null> {
    const raw = await this.redis.client.get(SESSION_KEY(authority));
    return raw ? (JSON.parse(raw) as SandboxSession) : null;
  }

  private async save(session: SandboxSession): Promise<void> {
    await this.redis.client.set(SESSION_KEY(session.authority), JSON.stringify(session), 'KEEPTTL');
  }
}

function failure(code: string, message: string): GatewayVerification {
  return { success: false, alreadyVerified: false, bankRrn: null, cardPanMasked: null, code, message };
}

/** 12-digit retrieval reference number, the format Shaparak RRNs have. */
function randomRrn(): string {
  return `${randomInt(1, 10)}${String(randomInt(0, 100_000)).padStart(5, '0')}${String(randomInt(0, 1_000_000)).padStart(6, '0')}`;
}
```

### `apps/backend/src/modules/payments/gateway/zarinpal-payment-gateway.provider.spec.ts`

```ts
import { Prisma } from '@prisma/client';
import { PaymentGatewayError } from './payment-gateway.interface';
import { ZarinpalPaymentGatewayProvider, type FetchLike } from './zarinpal-payment-gateway.provider';

/**
 * Unit tests with an injected HTTP transport returning the response shapes
 * published in Zarinpal's v4 documentation. They pin the request contract and
 * the interpretation of every answer; they do NOT prove connectivity with
 * Zarinpal's servers (no merchant id exists in this environment).
 */
const MERCHANT = '1344b5d4-0048-11e8-94db-005056a205be';
const AUTHORITY = 'A00000000000000000000000000217885159';

function transport(status: number, body: unknown): { fetch: FetchLike; calls: Array<{ url: string; body: Record<string, unknown> }> } {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) as Record<string, unknown> });
    return Promise.resolve({ status, text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)) });
  };
  return { fetch, calls };
}

function provider(fetch: FetchLike): ZarinpalPaymentGatewayProvider {
  return new ZarinpalPaymentGatewayProvider({ merchantId: MERCHANT, apiBaseUrl: 'https://payment.zarinpal.com', timeoutMs: 5000, fetch });
}

const order = {
  paymentId: 'b3c7d3a4-8b2f-4a57-9a55-1f7d0f1c2e3a',
  orderNumber: 'SHP-100000001',
  amount: new Prisma.Decimal('5750000.00'),
  description: 'پرداخت سفارش',
  customerMobile: '+989121234567',
};

describe('ZarinpalPaymentGatewayProvider', () => {
  it('requests a payment in IRR and builds the StartPay URL', async () => {
    const { fetch, calls } = transport(200, { data: { code: 100, message: 'Success', authority: AUTHORITY, fee_type: 'Merchant', fee: 100 }, errors: [] });
    const result = await provider(fetch).initiatePayment(order, 'https://api.shopino.ir/api/v1/payments/callback');

    expect(calls[0]?.url).toBe('https://payment.zarinpal.com/pg/v4/payment/request.json');
    expect(calls[0]?.body).toEqual({
      merchant_id: MERCHANT,
      amount: 5_750_000,
      currency: 'IRR',
      callback_url: 'https://api.shopino.ir/api/v1/payments/callback',
      description: 'پرداخت سفارش',
      metadata: { order_id: 'SHP-100000001', mobile: '09121234567' },
    });
    expect(result.gatewayToken).toBe(AUTHORITY);
    expect(result.redirectUrl).toBe(`https://payment.zarinpal.com/pg/StartPay/${AUTHORITY}`);
  });

  it('refuses fractional rial amounts instead of rounding money', async () => {
    const { fetch, calls } = transport(200, {});
    await expect(provider(fetch).initiatePayment({ ...order, amount: new Prisma.Decimal('1000.50') }, 'https://x/cb')).rejects.toMatchObject({
      code: 'INVALID_AMOUNT',
    });
    expect(calls).toHaveLength(0);
  });

  it('turns a documented error envelope into a non-retryable gateway error', async () => {
    const { fetch } = transport(400, { data: [], errors: { code: -9, message: 'The input params invalid, validation error.', validations: [] } });
    const error = (await provider(fetch).initiatePayment(order, 'https://x/cb').catch((e: unknown) => e)) as PaymentGatewayError;
    expect(error).toBeInstanceOf(PaymentGatewayError);
    expect(error.code).toBe('ZARINPAL_-9');
    expect(error.retryable).toBe(false);
  });

  it('treats transport failures and 5xx as retryable (outcome unknown)', async () => {
    const down: FetchLike = () => Promise.reject(new Error('ECONNRESET'));
    await expect(provider(down).initiatePayment(order, 'https://x/cb')).rejects.toMatchObject({ code: 'GATEWAY_UNREACHABLE', retryable: true });
    const { fetch } = transport(502, '<html>Bad gateway</html>');
    await expect(provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' })).rejects.toMatchObject({
      code: 'GATEWAY_UNAVAILABLE',
      retryable: true,
    });
  });

  it('verifies with the stored amount: 100 = verified, with ref_id and masked card', async () => {
    const { fetch, calls } = transport(200, {
      data: { code: 100, message: 'Verified', card_hash: '1EBE3EBEBE35C7EC0F8D6EE4F2F859107A87822CA179BC9528767EA7B5489B69', card_pan: '502229******5995', ref_id: 201, fee_type: 'Merchant', fee: 0 },
      errors: [],
    });
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' });
    expect(calls[0]?.url).toBe('https://payment.zarinpal.com/pg/v4/payment/verify.json');
    expect(calls[0]?.body).toEqual({ merchant_id: MERCHANT, amount: 5_750_000, authority: AUTHORITY });
    expect(result).toMatchObject({ success: true, alreadyVerified: false, bankRrn: '201', cardPanMasked: '502229******5995', code: '100' });
  });

  it('treats 101 (already verified) as success on repeated verification', async () => {
    const { fetch } = transport(200, { data: { code: 101, message: 'Verified', card_pan: '502229******5995', ref_id: 201 }, errors: [] });
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' });
    expect(result).toMatchObject({ success: true, alreadyVerified: true, bankRrn: '201' });
  });

  it('does not call verify when the bank redirected with Status=NOK', async () => {
    const { fetch, calls } = transport(200, {});
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'NOK' });
    expect(result).toMatchObject({ success: false, code: 'NOK' });
    expect(calls).toHaveLength(0);
  });

  it('reports a definitive verification refusal as an unsuccessful result', async () => {
    const { fetch } = transport(400, { data: [], errors: { code: -51, message: 'Session is not valid, session is not active paid try.' } });
    const result = await provider(fetch).verifyPayment(AUTHORITY, { amount: order.amount, bankStatus: 'OK' });
    expect(result).toMatchObject({ success: false, code: 'ZARINPAL_-51' });
  });

  it('parses the callback query', () => {
    const { fetch } = transport(200, {});
    expect(provider(fetch).parseCallback({ Authority: AUTHORITY, Status: 'OK' })).toEqual({ gatewayToken: AUTHORITY, bankStatus: 'OK' });
    expect(provider(fetch).parseCallback({ Authority: ['x', 'y'], Status: 'nok' })).toEqual({ gatewayToken: 'x', bankStatus: 'NOK' });
    expect(provider(fetch).parseCallback({ Status: 'BOGUS' })).toEqual({ gatewayToken: null, bankStatus: null });
  });
});
```

### `apps/backend/src/modules/payments/gateway/zarinpal-payment-gateway.provider.ts`

```ts
import type { Prisma } from '@prisma/client';
import {
  bankStatusOf,
  firstString,
  PaymentGatewayError,
  toWholeRials,
  type GatewayCallback,
  type GatewayInitiation,
  type GatewayOrder,
  type GatewayVerification,
  type PaymentGatewayProvider,
} from './payment-gateway.interface';

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{
  status: number;
  text(): Promise<string>;
}>;

export interface ZarinpalOptions {
  merchantId: string;
  /** https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com. */
  apiBaseUrl: string;
  timeoutMs: number;
  fetch: FetchLike;
}

interface ZarinpalEnvelope {
  data?: unknown;
  errors?: unknown;
}

const OK = 100;
const ALREADY_VERIFIED = 101;

/**
 * Zarinpal IPG, REST API v4 (https://www.zarinpal.com/docs/paymentGateway/).
 *
 * - request: POST {base}/pg/v4/payment/request.json → `authority`, then the
 *   customer goes to {base}/pg/StartPay/{authority};
 * - callback: GET with `Authority` and `Status=OK|NOK`;
 * - verify:  POST {base}/pg/v4/payment/verify.json → code 100 (verified) or
 *   101 (already verified), `ref_id`, `card_pan`.
 *
 * Amounts are sent in IRR with `currency: "IRR"` explicitly, matching the
 * platform currency, so no Toman conversion can go wrong. A payment that is
 * never verified is reversed to the payer by the bank.
 *
 * Status: implemented against the published documentation and unit-tested
 * with recorded response shapes; NOT yet exercised against Zarinpal's servers
 * (no merchant id is configured in this environment).
 */
export class ZarinpalPaymentGatewayProvider implements PaymentGatewayProvider {
  readonly name = 'ZARINPAL' as const;

  constructor(private readonly options: ZarinpalOptions) {}

  async initiatePayment(order: GatewayOrder, callbackUrl: string): Promise<GatewayInitiation> {
    const body = {
      merchant_id: this.options.merchantId,
      amount: toWholeRials(order.amount),
      currency: 'IRR',
      callback_url: callbackUrl,
      description: order.description.slice(0, 500),
      metadata: {
        order_id: order.orderNumber,
        ...(order.customerMobile ? { mobile: toLocalMobile(order.customerMobile) } : {}),
      },
    };
    const data = await this.call('/pg/v4/payment/request.json', body);
    const code = numberField(data, 'code');
    const authority = stringField(data, 'authority');
    if (code !== OK || authority === null) {
      throw new PaymentGatewayError(`Zarinpal refused the payment request (code ${String(code)})`, `ZARINPAL_${String(code)}`, false);
    }
    return {
      gatewayToken: authority,
      redirectUrl: `${this.options.apiBaseUrl}/pg/StartPay/${encodeURIComponent(authority)}`,
      details: { feeType: stringField(data, 'fee_type'), fee: numberField(data, 'fee') },
    };
  }

  parseCallback(params: Record<string, unknown>): GatewayCallback {
    return { gatewayToken: firstString(params['Authority']), bankStatus: bankStatusOf(params['Status']) };
  }

  async verifyPayment(gatewayToken: string, params: { amount: Prisma.Decimal; bankStatus: 'OK' | 'NOK' | null }): Promise<GatewayVerification> {
    if (params.bankStatus !== 'OK') {
      // Zarinpal: verify only when Status=OK; NOK means the payer cancelled or the bank declined.
      return failure('NOK', 'The payment was cancelled or declined at the bank');
    }
    let data: Record<string, unknown>;
    try {
      data = await this.call('/pg/v4/payment/verify.json', {
        merchant_id: this.options.merchantId,
        amount: toWholeRials(params.amount),
        authority: gatewayToken,
      });
    } catch (error) {
      if (error instanceof PaymentGatewayError && !error.retryable) {
        return failure(error.code, error.message);
      }
      throw error;
    }
    const code = numberField(data, 'code');
    if (code === OK || code === ALREADY_VERIFIED) {
      const refId = data['ref_id'];
      return {
        success: true,
        alreadyVerified: code === ALREADY_VERIFIED,
        bankRrn: typeof refId === 'number' || typeof refId === 'string' ? String(refId) : null,
        cardPanMasked: stringField(data, 'card_pan'),
        code: String(code),
        message: stringField(data, 'message') ?? 'Verified',
      };
    }
    return failure(`ZARINPAL_${String(code)}`, stringField(data, 'message') ?? 'Payment not verified');
  }

  /** POSTs JSON; returns `data` on a well-formed answer, throws otherwise. */
  private async call(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await this.options.fetch(`${this.options.apiBaseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      status = response.status;
      text = await response.text();
    } catch (error) {
      throw new PaymentGatewayError(
        `Zarinpal is unreachable: ${error instanceof Error ? error.message : String(error)}`,
        'GATEWAY_UNREACHABLE',
        true,
      );
    } finally {
      clearTimeout(timer);
    }
    if (status >= 500) {
      throw new PaymentGatewayError(`Zarinpal answered HTTP ${status}`, 'GATEWAY_UNAVAILABLE', true);
    }
    let envelope: ZarinpalEnvelope;
    try {
      envelope = JSON.parse(text) as ZarinpalEnvelope;
    } catch {
      throw new PaymentGatewayError(`Zarinpal answered HTTP ${status} with a non-JSON body`, 'GATEWAY_BAD_RESPONSE', true);
    }
    // Errors come back as { data: [], errors: { code, message } } (HTTP 4xx).
    if (isRecord(envelope.errors) && typeof envelope.errors['code'] === 'number') {
      const code = envelope.errors['code'];
      const message = typeof envelope.errors['message'] === 'string' ? envelope.errors['message'] : 'Zarinpal error';
      throw new PaymentGatewayError(`Zarinpal error ${code}: ${message}`, `ZARINPAL_${code}`, false);
    }
    if (!isRecord(envelope.data)) {
      throw new PaymentGatewayError(`Zarinpal answered HTTP ${status} without data`, 'GATEWAY_BAD_RESPONSE', true);
    }
    return envelope.data;
  }
}

function failure(code: string, message: string): GatewayVerification {
  return { success: false, alreadyVerified: false, bankRrn: null, cardPanMasked: null, code, message };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberField(data: Record<string, unknown>, key: string): number | null {
  const value = data[key];
  return typeof value === 'number' ? value : null;
}

function stringField(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Zarinpal expects the local 09… form. */
function toLocalMobile(e164: string): string {
  return e164.startsWith('+98') ? `0${e164.slice(3)}` : e164;
}
```

### `apps/backend/src/modules/payments/payments.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import type { EnvironmentVariables } from '../../config/env.validation';
import { SkipAudit } from '../audit/audit.decorator';
import { InitiatePaymentDto, InitiatePaymentResponseDto, PaymentOutcomeDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

const CALLBACK_DESCRIPTION =
  'Where the bank sends the customer’s browser after the payment page (Zarinpal: `Authority` + `Status=OK|NOK`). ' +
  'The redirect parameters are never trusted: the payment is verified server-to-server with the gateway for the stored amount. ' +
  'On success the order becomes PAID in one transaction (stock committed, each store’s earnings held in escrow, packages visible to ' +
  'vendors as PENDING_APPROVAL, Payment SUCCESSFUL with the bank RRN). On failure the Payment becomes FAILED and the order stays ' +
  'PENDING with its stock reserved, so the customer can retry until the payment window closes. Repeated callbacks return the same ' +
  'outcome without a second verification. Answers JSON, or a 303 redirect to PAYMENT_RESULT_REDIRECT_URL when that is configured.';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly resultRedirectUrl: string | null;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.resultRedirectUrl = config.get<string | undefined>('PAYMENT_RESULT_REDIRECT_URL') ?? null;
  }

  @Post('initiate')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth('access-token')
  @SkipAudit() // audited inside the transaction that creates the payment
  @ApiOperation({
    summary: 'Start paying an unpaid order',
    description:
      'Creates an INITIATED payment for the order’s payable amount and opens a session with the active gateway. ' +
      'Redirect the customer to `redirectUrl`. Allowed while the order is PENDING and inside its payment window; ' +
      'after a failed attempt a new one can be initiated.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: InitiatePaymentResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiNotFoundResponse({ description: 'Unknown order or not the caller’s' })
  @ApiConflictResponse({ description: 'ORDER_NOT_PAYABLE (already paid, cancelled or failed) or ORDER_PAYMENT_EXPIRED' })
  @ApiTooManyRequestsResponse({ description: 'Too many open payment attempts for this order' })
  @ApiResponse({ status: HttpStatus.BAD_GATEWAY, description: 'GATEWAY_UNAVAILABLE: the gateway refused or could not be reached' })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiatePaymentDto,
    @ClientContext() context: RequestContext,
  ): Promise<InitiatePaymentResponseDto> {
    return this.payments.initiate(user.id, dto.parentOrderId, { actorId: user.id, context });
  }

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Bank callback (GET)', description: CALLBACK_DESCRIPTION })
  @ApiQuery({ name: 'Authority', required: true, description: 'Gateway session token' })
  @ApiQuery({ name: 'Status', required: false, enum: ['OK', 'NOK'] })
  @ApiOkResponse({ type: PaymentOutcomeDto })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to PAYMENT_RESULT_REDIRECT_URL?orderNumber=…&outcome=…&paymentId=… (when configured)' })
  @ApiBadRequestResponse({ description: 'INVALID_CALLBACK: no payment token' })
  @ApiNotFoundResponse({ description: 'Unknown payment token' })
  async callbackGet(
    @Query() query: Record<string, unknown>,
    @ClientContext() context: RequestContext,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.respond(reply, await this.payments.handleCallback(query, { actorId: null, context }));
  }

  @Post('callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the settlement transaction
  @ApiOperation({ summary: 'Bank callback (POST, form or JSON body)', description: CALLBACK_DESCRIPTION })
  @ApiOkResponse({ type: PaymentOutcomeDto })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to PAYMENT_RESULT_REDIRECT_URL (when configured)' })
  @ApiBadRequestResponse({ description: 'INVALID_CALLBACK: no payment token' })
  @ApiNotFoundResponse({ description: 'Unknown payment token' })
  async callbackPost(
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown> | undefined,
    @ClientContext() context: RequestContext,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const params = { ...query, ...(typeof body === 'object' && body !== null ? body : {}) };
    await this.respond(reply, await this.payments.handleCallback(params, { actorId: null, context }));
  }

  private async respond(reply: FastifyReply, outcome: PaymentOutcomeDto): Promise<void> {
    void reply.header('Cache-Control', 'no-store');
    if (this.resultRedirectUrl) {
      const separator = this.resultRedirectUrl.includes('?') ? '&' : '?';
      const query = new URLSearchParams({ orderNumber: outcome.orderNumber, outcome: outcome.outcome, paymentId: outcome.paymentId });
      await reply.status(HttpStatus.SEE_OTHER).header('Location', `${this.resultRedirectUrl}${separator}${query.toString()}`).send();
      return;
    }
    await reply.status(HttpStatus.OK).send(outcome);
  }
}
```

### `apps/backend/src/modules/payments/payments.module.ts`

```ts
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { OrdersModule } from '../orders/orders.module';
import { PAYMENT_GATEWAY, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';
import { SandboxPaymentGatewayProvider } from './gateway/sandbox-payment-gateway.provider';
import { ZarinpalPaymentGatewayProvider } from './gateway/zarinpal-payment-gateway.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SandboxBankController } from './sandbox-bank.controller';

/**
 * Selects the gateway once, at boot, from PAYMENT_GATEWAY_PROVIDER (validated
 * in env.validation.ts: zarinpal needs a merchant id, sandbox is refused in
 * production). No business code branches on the provider.
 */
const gatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  inject: [ConfigService, RedisService],
  useFactory: (config: ConfigService<EnvironmentVariables, true>, redis: RedisService): PaymentGatewayProvider => {
    if (config.getOrThrow<string>('PAYMENT_GATEWAY_PROVIDER') === 'zarinpal') {
      return new ZarinpalPaymentGatewayProvider({
        merchantId: config.getOrThrow<string>('ZARINPAL_MERCHANT_ID'),
        apiBaseUrl: config.getOrThrow<string>('ZARINPAL_API_BASE_URL'),
        timeoutMs: config.getOrThrow<number>('PAYMENT_GATEWAY_TIMEOUT_MS'),
        fetch: (url, init) => fetch(url, init),
      });
    }
    return new SandboxPaymentGatewayProvider(redis, config.getOrThrow<string>('PUBLIC_API_ORIGIN'));
  },
};

@Module({
  imports: [OrdersModule],
  controllers: [PaymentsController, SandboxBankController],
  providers: [gatewayProvider, PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
```

### `apps/backend/src/modules/payments/payments.service.ts`

```ts
import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, ParentOrderPaymentStatus, PaymentStatus, Prisma } from '@prisma/client';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import type { InitiatePaymentResponseDto, PaymentOutcome, PaymentOutcomeDto } from './dto/payment.dto';
import { PAYMENT_GATEWAY, PaymentGatewayError, type GatewayVerification, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';

type Tx = Prisma.TransactionClient;

/** Open attempts one order may have inside the grace window (each one opens a bank session). */
export const MAX_OPEN_ATTEMPTS = 5;

const paymentSelect = {
  id: true,
  status: true,
  cashAmount: true,
  bankRrn: true,
  metadata: true,
  gatewayTrackingToken: true,
  parentOrder: { select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

/**
 * Card payments through the active IPG.
 *
 * Money safety rules:
 * - success is decided only by the gateway's server-to-server verify, never by
 *   the redirect parameters, and verify always sends the amount *we* stored;
 * - the gateway is called outside database transactions; the result is then
 *   applied in one transaction that locks the parent order (the same lock the
 *   expiry sweeper, cancellations and vendors use) and re-reads the payment,
 *   so concurrent or repeated callbacks apply at most once;
 * - order completion (stock commit, escrow holds, PAID) and Payment SUCCESSFUL
 *   commit together or not at all;
 * - a captured payment for an order that is no longer payable is recorded as
 *   SUCCESSFUL with `requiresManualRefund` and audited — never dropped.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly callbackUrl: string;
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayProvider,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.callbackUrl = `${config.getOrThrow<string>('PUBLIC_API_ORIGIN')}/api/v1/payments/callback`;
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  get gatewayName(): PaymentGatewayProvider['name'] {
    return this.gateway.name;
  }

  async initiate(userId: string, parentOrderId: string, actor: OrderActor): Promise<InitiatePaymentResponseDto> {
    const now = new Date();
    const order = await this.prisma.parentOrder.findFirst({
      where: { id: parentOrderId, userId },
      select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true, finalPayableAmount: true, user: { select: { mobile: true } } },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
      throw conflictWith('ORDER_NOT_PAYABLE', `This order is ${order.paymentStatus}; only PENDING orders can be paid`, {
        paymentStatus: order.paymentStatus,
      });
    }
    if (order.paymentExpiresAt !== null && order.paymentExpiresAt <= now) {
      throw conflictWith('ORDER_PAYMENT_EXPIRED', 'The payment window of this order has closed; place the order again', {
        paymentExpiresAt: order.paymentExpiresAt,
      });
    }
    const open = await this.prisma.payment.count({
      where: { parentOrderId, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(now.getTime() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this order; finish or wait for one of them', this.graceMs / 1000);
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: { parentOrderId, gatewayName: this.gateway.name, cashAmount: order.finalPayableAmount, creditAmount: 0, status: PaymentStatus.INITIATED },
        select: { id: true },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Payment',
        entityId: created.id,
        newValue: { parentOrderId, orderNumber: order.orderNumber, gatewayName: this.gateway.name, amount: order.finalPayableAmount.toFixed(2) },
      });
      return created;
    });

    let initiation;
    try {
      initiation = await this.gateway.initiatePayment(
        {
          paymentId: payment.id,
          orderNumber: order.orderNumber,
          amount: order.finalPayableAmount,
          description: `پرداخت سفارش ${order.orderNumber} — شاپینو`,
          customerMobile: order.user.mobile,
        },
        this.callbackUrl,
      );
    } catch (error) {
      const gatewayError = error instanceof PaymentGatewayError ? error : new PaymentGatewayError(String(error), 'GATEWAY_ERROR', true);
      await this.prisma.payment.update({
        where: { id: payment.id },
        data: { status: PaymentStatus.FAILED, metadata: { stage: 'initiate', code: gatewayError.code, message: gatewayError.message.slice(0, 500) } },
      });
      this.logger.warn(`Gateway ${this.gateway.name} refused to open a session for payment ${payment.id}: ${gatewayError.message}`);
      throw new HttpException(
        { statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', code: 'GATEWAY_UNAVAILABLE', message: 'The payment gateway could not open a payment session; try again', gatewayCode: gatewayError.code },
        HttpStatus.BAD_GATEWAY,
      );
    }

    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { gatewayTrackingToken: initiation.gatewayToken, metadata: { stage: 'initiated', gateway: initiation.details } as Prisma.InputJsonValue },
    });
    return {
      paymentId: payment.id,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.gateway.name,
      amount: order.finalPayableAmount.toFixed(2),
      currency: 'IRR',
      orderNumber: order.orderNumber,
      paymentExpiresAt: order.paymentExpiresAt,
    };
  }

  /** Public bank callback (GET query or POST form/JSON). Idempotent. */
  async handleCallback(params: Record<string, unknown>, actor: OrderActor): Promise<PaymentOutcomeDto> {
    const callback = this.gateway.parseCallback(params);
    if (callback.gatewayToken === null) {
      throw badRequestWith('INVALID_CALLBACK', 'The callback does not carry a payment token');
    }
    const found = await this.prisma.payment.findFirst({
      where: { gatewayName: this.gateway.name, gatewayTrackingToken: callback.gatewayToken },
      select: paymentSelect,
    });
    if (!found) {
      throw new NotFoundException('Unknown payment');
    }
    if (found.status !== PaymentStatus.INITIATED) {
      return this.outcomeOf(found); // repeated callback: same answer, no second verify
    }

    let verification: GatewayVerification;
    try {
      verification = await this.gateway.verifyPayment(callback.gatewayToken, { amount: found.cashAmount, bankStatus: callback.bankStatus });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Verify of payment ${found.id} failed; it stays INITIATED: ${message}`);
      return {
        ...this.outcomeOf(found),
        outcome: 'VERIFICATION_PENDING',
        message: 'The bank could not confirm the payment yet. If money was taken, retry this page shortly; unconfirmed payments are reversed by the bank.',
      };
    }

    const settled = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, found.parentOrder.id);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: found.id }, select: paymentSelect });
      if (current.status !== PaymentStatus.INITIATED) {
        return current; // another callback won the race
      }
      return verification.success ? this.applySuccess(tx, current, verification, actor) : this.applyFailure(tx, current, verification, actor);
    });
    return this.outcomeOf(settled);
  }

  private async applySuccess(tx: Tx, payment: PaymentRow, verification: GatewayVerification, actor: OrderActor): Promise<PaymentRow> {
    const paidAt = new Date();
    const application = await this.lifecycle.applyPaymentLocked(tx, payment.parentOrder.id, actor, {
      paymentId: payment.id,
      ...(verification.bankRrn ? { bankRrn: verification.bankRrn } : {}),
    });
    const requiresManualRefund = !application.applied;
    const metadata = {
      ...asObject(payment.metadata),
      stage: 'verified',
      verifyCode: verification.code,
      alreadyVerified: verification.alreadyVerified,
      cardPanMasked: verification.cardPanMasked,
      ...(requiresManualRefund
        ? { requiresManualRefund: true, orderStatusAtCapture: payment.parentOrder.paymentStatus }
        : { escrowHeld: application.escrowHeld }),
    };
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.SUCCESSFUL, paidAt, bankRrn: verification.bankRrn, metadata: metadata },
      select: paymentSelect,
    });
    await writeOrderAudit(tx, actor, {
      action: AuditAction.PAYMENT_CAPTURE,
      entityName: 'Payment',
      entityId: payment.id,
      oldValue: { status: PaymentStatus.INITIATED },
      newValue: {
        status: PaymentStatus.SUCCESSFUL,
        orderNumber: payment.parentOrder.orderNumber,
        amount: payment.cashAmount.toFixed(2),
        bankRrn: verification.bankRrn,
        verifyCode: verification.code,
        ...(requiresManualRefund ? { requiresManualRefund: true, orderPaymentStatus: updated.parentOrder.paymentStatus } : {}),
      },
    });
    if (requiresManualRefund) {
      this.logger.error(
        `Payment ${payment.id} (RRN ${verification.bankRrn ?? '-'}) was captured for order ${payment.parentOrder.orderNumber}, ` +
          `which is ${updated.parentOrder.paymentStatus}: MANUAL REFUND REQUIRED`,
      );
    }
    return updated;
  }

  private async applyFailure(tx: Tx, payment: PaymentRow, verification: GatewayVerification, actor: OrderActor): Promise<PaymentRow> {
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        metadata: { ...asObject(payment.metadata), stage: 'failed', code: verification.code, message: verification.message.slice(0, 500) },
      },
      select: paymentSelect,
    });
    // The order itself stays PENDING with its stock reserved: the customer can
    // try again until paymentExpiresAt, then the expiry sweeper releases it.
    await writeOrderAudit(tx, actor, {
      action: AuditAction.STATUS_CHANGE,
      entityName: 'Payment',
      entityId: payment.id,
      oldValue: { status: PaymentStatus.INITIATED },
      newValue: { status: PaymentStatus.FAILED, orderNumber: payment.parentOrder.orderNumber, code: verification.code, message: verification.message },
    });
    return updated;
  }

  private outcomeOf(payment: PaymentRow): PaymentOutcomeDto {
    const order = payment.parentOrder;
    const canRetry =
      order.paymentStatus === ParentOrderPaymentStatus.PENDING && (order.paymentExpiresAt === null || order.paymentExpiresAt > new Date());
    const metadata = asObject(payment.metadata);
    let outcome: PaymentOutcome;
    let message: string;
    if (payment.status === PaymentStatus.SUCCESSFUL) {
      outcome = metadata['requiresManualRefund'] === true ? 'PAID_REQUIRES_REFUND' : 'PAID';
      message =
        outcome === 'PAID'
          ? 'Payment confirmed; the order is paid'
          : 'The bank captured this payment but the order had already been paid or closed; it will be refunded by our finance team';
    } else if (payment.status === PaymentStatus.INITIATED) {
      outcome = 'VERIFICATION_PENDING';
      message = 'The payment has not been confirmed yet';
    } else {
      outcome = 'FAILED';
      message = canRetry ? 'The payment was not completed; you can try again' : 'The payment was not completed';
    }
    return {
      outcome,
      paymentId: payment.id,
      paymentStatus: payment.status,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      orderPaymentStatus: order.paymentStatus,
      bankRrn: payment.bankRrn,
      message,
      canRetry: outcome === 'FAILED' && canRetry,
      paymentExpiresAt: order.paymentExpiresAt,
    };
  }
}

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value) : {};
}
```

### `apps/backend/src/modules/payments/sandbox-bank.controller.ts`

```ts
import { Body, Controller, Get, HttpStatus, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../audit/audit.decorator';
import { SandboxDecisionDto } from './dto/sandbox.dto';
import { PAYMENT_GATEWAY, PaymentGatewayError, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';
import { SandboxPaymentGatewayProvider, type SandboxSession } from './gateway/sandbox-payment-gateway.provider';

const UUID = new ParseUUIDPipe({ version: '4' });

/**
 * DEVELOPMENT / TEST ONLY — the simulated bank page of the sandbox gateway.
 * Every route answers 404 unless PAYMENT_GATEWAY_PROVIDER=sandbox, and the API
 * cannot boot with the sandbox provider in production, so this page never
 * exists in production.
 */
@ApiTags('sandbox-payments')
@Public()
@Controller('sandbox/payment-page')
export class SandboxBankController {
  private readonly sandbox: SandboxPaymentGatewayProvider | null;

  constructor(@Inject(PAYMENT_GATEWAY) gateway: PaymentGatewayProvider) {
    this.sandbox = gateway instanceof SandboxPaymentGatewayProvider ? gateway : null;
  }

  @Get(':paymentId')
  @ApiOperation({ summary: 'Simulated bank payment page (HTML)', description: 'Shows the order and amount with “Pay” and “Decline” buttons.' })
  @ApiProduces('text/html')
  @ApiResponse({ status: HttpStatus.OK, description: 'HTML page' })
  @ApiNotFoundResponse({ description: 'Sandbox gateway not active, or unknown/expired session' })
  async page(@Param('paymentId', UUID) paymentId: string, @Res() reply: FastifyReply): Promise<void> {
    const session = await this.requireSandbox().sessionByPayment(paymentId);
    if (!session) {
      throw new NotFoundException('Unknown or expired sandbox bank session');
    }
    await reply
      .status(HttpStatus.OK)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .send(renderPage(session));
  }

  @Post(':paymentId/decision')
  @SkipAudit() // the resulting callback is audited
  @ApiOperation({
    summary: 'Simulated payer decision',
    description: 'PAY settles the session with a 12-digit RRN, DECLINE fails it; then 303-redirects the browser to the payment callback with Authority and Status=OK|NOK.',
  })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to /api/v1/payments/callback?Authority=…&Status=OK|NOK' })
  @ApiBadRequestResponse({ description: 'decision must be PAY or DECLINE' })
  @ApiNotFoundResponse({ description: 'Sandbox gateway not active, or unknown/expired session' })
  async decide(@Param('paymentId', UUID) paymentId: string, @Body() dto: SandboxDecisionDto, @Res() reply: FastifyReply): Promise<void> {
    try {
      const { redirectTo } = await this.requireSandbox().settle(paymentId, dto.decision);
      await reply.status(HttpStatus.SEE_OTHER).header('Location', redirectTo).header('Cache-Control', 'no-store').send();
    } catch (error) {
      if (error instanceof PaymentGatewayError && error.code === 'SESSION_NOT_FOUND') {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  private requireSandbox(): SandboxPaymentGatewayProvider {
    if (!this.sandbox) {
      throw new NotFoundException();
    }
    return this.sandbox;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function renderPage(session: SandboxSession): string {
  const amount = new Intl.NumberFormat('fa-IR').format(Number(session.amount));
  const action = `/api/v1/sandbox/payment-page/${encodeURIComponent(session.paymentId)}/decision`;
  const settled = session.status !== 'AWAITING_PAYER';
  const statusText = session.status === 'PAID' ? 'پرداخت شده' : session.status === 'DECLINED' ? 'رد شده' : 'در انتظار پرداخت';
  const buttons = settled
    ? `<form method="post" action="${action}"><input type="hidden" name="decision" value="PAY"><button class="btn secondary" type="submit">بازگشت به فروشگاه</button></form>`
    : `<form method="post" action="${action}"><input type="hidden" name="decision" value="PAY"><button class="btn pay" type="submit">پرداخت موفق</button></form>
       <form method="post" action="${action}"><input type="hidden" name="decision" value="DECLINE"><button class="btn fail" type="submit">انصراف / پرداخت ناموفق</button></form>`;
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>درگاه پرداخت آزمایشی شاپینو</title>
<style>
  body { margin: 0; font-family: Tahoma, "Segoe UI", sans-serif; background: #f1f5f9; color: #0f172a; }
  .banner { background: #b45309; color: #fff; text-align: center; padding: 10px; font-size: 14px; }
  .card { max-width: 420px; margin: 40px auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(15,23,42,.08); padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 20px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; margin: 0 0 24px; }
  dt { color: #64748b; } dd { margin: 0; font-weight: bold; direction: ltr; text-align: left; }
  .amount { font-size: 22px; color: #047857; }
  form { margin: 0 0 10px; }
  .btn { width: 100%; border: 0; border-radius: 8px; padding: 14px; font-size: 16px; cursor: pointer; font-family: inherit; }
  .pay { background: #059669; color: #fff; } .fail { background: #e2e8f0; color: #b91c1c; } .secondary { background: #1d4ed8; color: #fff; }
</style>
</head>
<body>
<div class="banner">محیط آزمایشی (SANDBOX) — هیچ پولی جابه‌جا نمی‌شود. این صفحه فقط در محیط توسعه وجود دارد.</div>
<main class="card">
  <h1>درگاه پرداخت آزمایشی</h1>
  <dl>
    <dt>پذیرنده</dt><dd>Shopino (sandbox)</dd>
    <dt>شماره سفارش</dt><dd>${escapeHtml(session.orderNumber)}</dd>
    <dt>مبلغ</dt><dd class="amount">${escapeHtml(amount)} ریال</dd>
    <dt>وضعیت</dt><dd>${escapeHtml(statusText)}</dd>
    ${session.bankRrn ? `<dt>شماره مرجع</dt><dd>${escapeHtml(session.bankRrn)}</dd>` : ''}
  </dl>
  ${buttons}
</main>
</body>
</html>`;
}
```

### `apps/backend/src/modules/settlements/admin-settlements.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
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
import {
  AdminSettlementQueryDto,
  PaginatedSettlementRequestsDto,
  PayoutSettlementDto,
  ProcessSettlementDto,
  SettlementProcessResultDto,
} from './dto/settlement.dto';
import { SettlementsService } from './settlements.service';

const UUID = new ParseUUIDPipe({ version: '4' });

@ApiTags('admin-settlements')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Finance staff only' })
@Controller('admin/settlements')
export class AdminSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Settlement requests, newest first', description: 'Filter by status (REQUESTED / PROCESSING / PAID_PAYA / REJECTED) and store.' })
  @ApiOkResponse({ type: PaginatedSettlementRequestsDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  list(@Query() query: AdminSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    return this.settlements.listForStaff(query);
  }

  @Patch(':id/process')
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Approve (paid by PAYA) or reject a settlement request',
    description:
      'APPROVE needs payaReferenceNumber: the held amount leaves the wallet (SETTLEMENT_PAYOUT) and the request becomes PAID_PAYA. ' +
      'REJECT needs rejectionReason: the held amount returns to the withdrawable balance. Only REQUESTED requests can be processed.',
  })
  @ApiOkResponse({ type: SettlementProcessResultDto })
  @ApiBadRequestResponse({ description: 'Missing payaReferenceNumber / rejectionReason' })
  @ApiNotFoundResponse({ description: 'Unknown settlement request' })
  @ApiConflictResponse({ description: 'SETTLEMENT_ALREADY_PROCESSED or PAYA_REFERENCE_IN_USE' })
  process(
    @Param('id', UUID) id: string,
    @Body() dto: ProcessSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<SettlementProcessResultDto> {
    return this.settlements.process(id, dto, { actorId: user.id, context });
  }

  @Post(':id/payout')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({ summary: 'Record the PAYA payout of a settlement request', description: 'Shortcut for PATCH …/process with action=APPROVE.' })
  @ApiOkResponse({ type: SettlementProcessResultDto })
  @ApiBadRequestResponse({ description: 'Missing or invalid payaReferenceNumber' })
  @ApiNotFoundResponse({ description: 'Unknown settlement request' })
  @ApiConflictResponse({ description: 'SETTLEMENT_ALREADY_PROCESSED or PAYA_REFERENCE_IN_USE' })
  payout(
    @Param('id', UUID) id: string,
    @Body() dto: PayoutSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<SettlementProcessResultDto> {
    return this.settlements.process(id, { action: 'APPROVE', payaReferenceNumber: dto.payaReferenceNumber }, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/settlements/dto/settlement.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SettlementStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsIn, IsNumber, IsOptional, IsPositive, IsString, IsUUID, Length, Matches, Max, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsIranianSheba } from '../../../common/validators/is-iranian-sheba.decorator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { MONEY } from '../../wallet/dto/wallet.dto';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
/** Upper bound of DECIMAL(15,2). */
const MAX_AMOUNT = 9_999_999_999_999.99;
const PAYA_REFERENCE = /^[A-Za-z0-9-]+$/;

export class CreateSettlementRequestDto {
  @ApiProperty({ example: 5000000, description: 'IRR, up to 2 decimals. At least `commerce.settlementMinimumAmount` and at most the withdrawable balance.' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Max(MAX_AMOUNT)
  amount!: number;

  @ApiProperty({ example: 'IR820540102680020817909002', description: 'Must be the IBAN registered on the store profile (the account holder is verified at KYC).' })
  @Transform(trim)
  @IsString()
  @IsIranianSheba()
  targetIban!: string;
}

export const SETTLEMENT_ACTIONS = ['APPROVE', 'REJECT'] as const;
export type SettlementAction = (typeof SETTLEMENT_ACTIONS)[number];

export class ProcessSettlementDto {
  @ApiProperty({ enum: SETTLEMENT_ACTIONS, description: 'APPROVE = the PAYA transfer was made (status PAID_PAYA); REJECT = the held amount returns to the vendor.' })
  @IsIn(SETTLEMENT_ACTIONS)
  action!: SettlementAction;

  @ApiPropertyOptional({ example: 'PAYA-14050707-000123', description: 'Required for APPROVE: the bank’s PAYA transfer reference.' })
  @ValidateIf((dto: ProcessSettlementDto) => dto.action === 'APPROVE' || dto.payaReferenceNumber !== undefined)
  @Transform(trim)
  @IsString()
  @Length(4, 60)
  @Matches(PAYA_REFERENCE, { message: 'payaReferenceNumber may contain only latin letters, digits and dashes' })
  payaReferenceNumber?: string;

  @ApiPropertyOptional({ maxLength: 500, description: 'Required for REJECT; shown to the vendor.' })
  @ValidateIf((dto: ProcessSettlementDto) => dto.action === 'REJECT' || dto.rejectionReason !== undefined)
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  rejectionReason?: string;
}

export class PayoutSettlementDto {
  @ApiProperty({ example: 'PAYA-14050707-000123', description: 'The bank’s PAYA transfer reference.' })
  @Transform(trim)
  @IsString()
  @Length(4, 60)
  @Matches(PAYA_REFERENCE, { message: 'payaReferenceNumber may contain only latin letters, digits and dashes' })
  payaReferenceNumber!: string;
}

export class VendorSettlementQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: SettlementStatus })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;
}

export class AdminSettlementQueryDto extends VendorSettlementQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID('4')
  vendorId?: string;
}

export class SettlementProcessorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: String }) fullName!: string | null;
}

export class SettlementRequestDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) vendorId!: string;
  @ApiProperty() storeName!: string;
  @ApiProperty(MONEY) amount!: string;
  @ApiProperty({ example: 'IR820540102680020817909002' }) targetIban!: string;
  @ApiProperty({ enum: SettlementStatus }) status!: SettlementStatus;
  @ApiProperty({ nullable: true, type: String }) bankPayaReference!: string | null;
  @ApiProperty({ nullable: true, type: String }) rejectionReason!: string | null;
  @ApiProperty({ nullable: true, type: Date }) processedAt!: Date | null;
  @ApiProperty({ nullable: true, type: SettlementProcessorDto }) processedBy!: SettlementProcessorDto | null;
  @ApiProperty() createdAt!: Date;
}

export class PaginatedSettlementRequestsDto {
  @ApiProperty({ type: [SettlementRequestDto] }) items!: SettlementRequestDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class SettlementProcessResultDto extends SettlementRequestDto {
  @ApiProperty({ format: 'uuid' }) auditLogId!: string;
}
```

### `apps/backend/src/modules/settlements/settlements.module.ts`

```ts
import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module';
import { AdminSettlementsController } from './admin-settlements.controller';
import { SettlementsService } from './settlements.service';
import { VendorSettlementsController } from './vendor-settlements.controller';

@Module({
  imports: [WalletModule],
  controllers: [VendorSettlementsController, AdminSettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
```

### `apps/backend/src/modules/settlements/settlements.service.ts`

```ts
import { ForbiddenException, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AuditAction, Prisma, SettlementStatus, VendorStatus } from '@prisma/client';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { normalizeSheba } from '../../common/validators/iranian-sheba';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { requireStore } from '../wallet/vendor-store';
import { WalletLedgerService } from '../wallet/wallet-ledger.service';
import type {
  AdminSettlementQueryDto,
  CreateSettlementRequestDto,
  PaginatedSettlementRequestsDto,
  ProcessSettlementDto,
  SettlementProcessResultDto,
  SettlementRequestDto,
  VendorSettlementQueryDto,
} from './dto/settlement.dto';

/** `system_configs` key of the minimum settlement amount (IRR), seeded in Phase 2. */
export const SETTLEMENT_MIN_AMOUNT_KEY = 'commerce.settlementMinimumAmount';
const MONEY_PATTERN = /^\d{1,13}(\.\d{1,2})?$/;

const settlementSelect = {
  id: true,
  vendorId: true,
  amount: true,
  targetIban: true,
  status: true,
  bankPayaReference: true,
  rejectionReason: true,
  processedAt: true,
  createdAt: true,
  vendor: { select: { storeName: true } },
  processedBy: { select: { id: true, fullName: true } },
} satisfies Prisma.SettlementRequestSelect;

type SettlementRow = Prisma.SettlementRequestGetPayload<{ select: typeof settlementSelect }>;

/**
 * Vendor payouts (PAYA transfers).
 *
 * - request: the amount moves WITHDRAWABLE → SETTLEMENT_HOLD immediately, so it
 *   cannot be requested twice or consumed by a refund while finance reviews it;
 * - approve: the held amount leaves the wallet (SETTLEMENT_PAYOUT) and the
 *   request becomes PAID_PAYA with the bank reference;
 * - reject: the held amount returns to WITHDRAWABLE.
 *
 * Every step is one transaction: wallet row lock → settlement row lock →
 * status check → ledger → status update → audit.
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: WalletLedgerService,
  ) {}

  async request(userId: string, dto: CreateSettlementRequestDto, actor: OrderActor): Promise<SettlementRequestDto> {
    const store = await requireStore(this.prisma, userId);
    if (store.status !== VendorStatus.APPROVED) {
      throw new ForbiddenException(`The store is ${store.status}; only approved stores can request a settlement`);
    }
    if (!store.bankIban) {
      throw conflictWith('BANK_ACCOUNT_MISSING', 'Register the store’s bank IBAN on the store profile first');
    }
    const targetIban = normalizeSheba(dto.targetIban);
    if (targetIban !== normalizeSheba(store.bankIban)) {
      throw conflictWith('IBAN_MISMATCH', 'Settlements are paid only to the IBAN registered on the store profile');
    }
    const amount = new Prisma.Decimal(dto.amount);
    const minimum = await this.minimumAmount();
    if (amount.lessThan(minimum)) {
      throw badRequestWith('AMOUNT_BELOW_MINIMUM', `The minimum settlement amount is ${minimum.toFixed(2)} IRR`, {
        minimumAmount: minimum.toFixed(2),
      });
    }

    const id = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, store.id); // wallet first, as in every money path
      const created = await tx.settlementRequest.create({
        data: { vendorId: store.id, amount, targetIban, status: SettlementStatus.REQUESTED },
        select: { id: true },
      });
      await this.ledger.holdForSettlement(tx, store.id, created.id, amount); // 409 INSUFFICIENT_WALLET_BALANCE
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'SettlementRequest',
        entityId: created.id,
        newValue: { vendorId: store.id, amount: amount.toFixed(2), status: SettlementStatus.REQUESTED },
      });
      return created.id;
    });
    return this.toDto(await this.prisma.settlementRequest.findUniqueOrThrow({ where: { id }, select: settlementSelect }));
  }

  async listForVendor(userId: string, query: VendorSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    const store = await requireStore(this.prisma, userId);
    return this.list({ vendorId: store.id, ...(query.status ? { status: query.status } : {}) }, query);
  }

  async listForStaff(query: AdminSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    return this.list({ ...(query.vendorId ? { vendorId: query.vendorId } : {}), ...(query.status ? { status: query.status } : {}) }, query);
  }

  async process(id: string, dto: ProcessSettlementDto, actor: OrderActor & { actorId: string }): Promise<SettlementProcessResultDto> {
    const target = await this.prisma.settlementRequest.findUnique({ where: { id }, select: { vendorId: true } });
    if (!target) {
      throw new NotFoundException('Settlement request not found');
    }
    const auditLogId = await this.prisma.$transaction(async (tx) => {
      await this.ledger.lock(tx, target.vendorId);
      const rows = await tx.$queryRaw<Array<{ status: SettlementStatus; amount: Prisma.Decimal }>>(
        Prisma.sql`SELECT status, amount FROM settlement_requests WHERE id = ${id}::uuid FOR UPDATE`,
      );
      const current = rows[0];
      if (!current) {
        throw new NotFoundException('Settlement request not found');
      }
      if (current.status !== SettlementStatus.REQUESTED) {
        throw conflictWith('SETTLEMENT_ALREADY_PROCESSED', `This request is already ${current.status}`, { status: current.status });
      }
      const amount = new Prisma.Decimal(current.amount);
      const processedAt = new Date();

      if (dto.action === 'APPROVE') {
        const reference = dto.payaReferenceNumber!;
        const reused = await tx.settlementRequest.count({ where: { bankPayaReference: reference, status: SettlementStatus.PAID_PAYA } });
        if (reused > 0) {
          throw conflictWith('PAYA_REFERENCE_IN_USE', 'This PAYA reference is already recorded on another settlement');
        }
        await this.ledger.payoutSettlement(tx, target.vendorId, id, amount, reference);
        await tx.settlementRequest.update({
          where: { id },
          data: { status: SettlementStatus.PAID_PAYA, bankPayaReference: reference, processedByUserId: actor.actorId, processedAt },
        });
      } else {
        await this.ledger.releaseSettlementHold(tx, target.vendorId, id, amount);
        await tx.settlementRequest.update({
          where: { id },
          data: { status: SettlementStatus.REJECTED, rejectionReason: dto.rejectionReason!, processedByUserId: actor.actorId, processedAt },
        });
      }
      return writeOrderAudit(tx, actor, {
        action: AuditAction.SETTLEMENT_TRIGGER,
        entityName: 'SettlementRequest',
        entityId: id,
        oldValue: { status: SettlementStatus.REQUESTED },
        newValue: {
          status: dto.action === 'APPROVE' ? SettlementStatus.PAID_PAYA : SettlementStatus.REJECTED,
          vendorId: target.vendorId,
          amount: amount.toFixed(2),
          ...(dto.action === 'APPROVE' ? { bankPayaReference: dto.payaReferenceNumber } : { rejectionReason: dto.rejectionReason }),
        },
      });
    });
    const row = await this.prisma.settlementRequest.findUniqueOrThrow({ where: { id }, select: settlementSelect });
    return { ...this.toDto(row), auditLogId };
  }

  /** Minimum from `system_configs`; a missing or invalid value fails closed (503), like the shipping policy. */
  async minimumAmount(): Promise<Prisma.Decimal> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: SETTLEMENT_MIN_AMOUNT_KEY }, select: { value: true } });
    const raw = row?.value.trim();
    if (raw === undefined || !MONEY_PATTERN.test(raw)) {
      this.logger.error(`system_configs "${SETTLEMENT_MIN_AMOUNT_KEY}" is missing or invalid (${JSON.stringify(row?.value ?? null)})`);
      throw new ServiceUnavailableException('Settlements are temporarily unavailable: the settlement configuration is invalid');
    }
    return new Prisma.Decimal(raw);
  }

  private async list(where: Prisma.SettlementRequestWhereInput, query: { page: number; pageSize: number }): Promise<PaginatedSettlementRequestsDto> {
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.settlementRequest.count({ where }),
      this.prisma.settlementRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: settlementSelect,
      }),
    ]);
    return { items: rows.map((row) => this.toDto(row)), page: query.page, pageSize: query.pageSize, total, totalPages: Math.ceil(total / query.pageSize) };
  }

  private toDto(row: SettlementRow): SettlementRequestDto {
    return {
      id: row.id,
      vendorId: row.vendorId,
      storeName: row.vendor.storeName,
      amount: row.amount.toFixed(2),
      targetIban: row.targetIban,
      status: row.status,
      bankPayaReference: row.bankPayaReference,
      rejectionReason: row.rejectionReason,
      processedAt: row.processedAt,
      processedBy: row.processedBy ? { id: row.processedBy.id, fullName: row.processedBy.fullName } : null,
      createdAt: row.createdAt,
    };
  }
}
```

### `apps/backend/src/modules/settlements/vendor-settlements.controller.ts`

```ts
import { Body, Controller, Get, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { CreateSettlementRequestDto, PaginatedSettlementRequestsDto, SettlementRequestDto, VendorSettlementQueryDto } from './dto/settlement.dto';
import { SettlementsService } from './settlements.service';

@ApiTags('vendor-wallet')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Vendors with a store only (requests: approved stores only)' })
@Controller('vendor/wallet/settlements')
export class VendorSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Post()
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Request a payout (settlement) to the store’s bank account',
    description:
      'The amount is taken from the withdrawable balance immediately and held until finance approves (PAYA transfer) or rejects ' +
      '(returned). Must be ≥ commerce.settlementMinimumAmount and ≤ withdrawableBalance; targetIban must be the IBAN on the store profile.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: SettlementRequestDto })
  @ApiBadRequestResponse({ description: 'Validation error or AMOUNT_BELOW_MINIMUM' })
  @ApiConflictResponse({ description: 'INSUFFICIENT_WALLET_BALANCE, IBAN_MISMATCH or BANK_ACCOUNT_MISSING' })
  @ApiServiceUnavailableResponse({ description: 'The settlement minimum in system_configs is missing or invalid' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSettlementRequestDto,
    @ClientContext() context: RequestContext,
  ): Promise<SettlementRequestDto> {
    return this.settlements.request(user.id, dto, { actorId: user.id, context });
  }

  @Get()
  @ApiOperation({ summary: 'My settlement requests, newest first' })
  @ApiOkResponse({ type: PaginatedSettlementRequestsDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: VendorSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    return this.settlements.listForVendor(user.id, query);
  }
}
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
  @ApiProperty({ ...MONEY, description: 'Earnings released on delivery, net of refunds of delivered packages (IRR).' })
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

### `apps/backend/src/modules/wallet/vendor-store.ts`

```ts
import { ForbiddenException } from '@nestjs/common';
import type { VendorStatus } from '@prisma/client';
import type { PrismaService } from '../../infra/prisma/prisma.service';

export interface VendorStore {
  id: string;
  status: VendorStatus;
  bankIban: string | null;
  bankAccountHolder: string | null;
}

/** The caller's store; 403 when the VENDOR account has no store (registration not started). */
export async function requireStore(prisma: PrismaService, userId: string): Promise<VendorStore> {
  const store = await prisma.vendor.findUnique({
    where: { userId },
    select: { id: true, status: true, bankIban: true, bankAccountHolder: true },
  });
  if (!store) {
    throw new ForbiddenException('This account has no store');
  }
  return store;
}
```

### `apps/backend/src/modules/wallet/vendor-wallet.controller.ts`

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PaginatedWalletTransactionsDto, WalletSummaryDto, WalletTransactionQueryDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

@ApiTags('vendor-wallet')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Vendors with a store only' })
@Controller('vendor/wallet')
export class VendorWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @ApiOperation({
    summary: 'My wallet balances',
    description:
      'pendingBalance = escrow of paid, undelivered packages; withdrawableBalance = released on delivery and requestable; ' +
      'settlementHoldBalance = reserved by open settlement requests. Amounts in IRR.',
  })
  @ApiOkResponse({ type: WalletSummaryDto })
  summary(@CurrentUser() user: AuthenticatedUser): Promise<WalletSummaryDto> {
    return this.wallet.summaryForVendor(user.id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'My wallet ledger, newest first', description: 'Every balance movement with its signed amount and the bucket balance after it.' })
  @ApiOkResponse({ type: PaginatedWalletTransactionsDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  transactions(@CurrentUser() user: AuthenticatedUser, @Query() query: WalletTransactionQueryDto): Promise<PaginatedWalletTransactionsDto> {
    return this.wallet.transactionsForVendor(user.id, query);
  }
}
```

### `apps/backend/src/modules/wallet/wallet-ledger.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import { InsufficientBalanceError, escrowStateOf, planEntries, type BucketBalances, type EscrowState, type LedgerEntry } from './wallet-math';

type Tx = Prisma.TransactionClient;

const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD } = WalletBalanceBucket;

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
  total_earned_balance: Prisma.Decimal;
  total_withdrawn_amount: Prisma.Decimal;
}

export type ReverseOutcome = 'NONE' | 'FROM_PENDING' | 'FROM_WITHDRAWABLE';

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
    if (!sub.vendorEarningsAmount.isPositive()) return false;
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
    if ((await this.escrowState(tx, sub.id)) !== 'HELD') return false;
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
      Prisma.sql`SELECT id, pending_balance, withdrawable_balance, settlement_hold_balance, total_earned_balance, total_withdrawn_amount
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
      },
      totalEarned: new Prisma.Decimal(row.total_earned_balance),
      totalWithdrawn: new Prisma.Decimal(row.total_withdrawn_amount),
    };
  }

  private async escrowState(tx: Tx, subOrderId: string): Promise<EscrowState> {
    const rows = await tx.walletTransaction.findMany({
      where: {
        subOrderId,
        type: { in: [WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, WalletTransactionType.REFUND_DEDUCTION] },
      },
      select: { type: true },
    });
    return escrowStateOf(rows.map((row) => row.type));
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
```

### `apps/backend/src/modules/wallet/wallet-math.spec.ts`

```ts
import { Prisma, WalletBalanceBucket, WalletTransactionType } from '@prisma/client';
import { emptyBalances, escrowStateOf, InsufficientBalanceError, planEntries, sumByBucket } from './wallet-math';

const d = (value: string): Prisma.Decimal => new Prisma.Decimal(value);
const { PENDING, WITHDRAWABLE, SETTLEMENT_HOLD } = WalletBalanceBucket;

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

  it('derives the escrow state of a package from its ledger rows', () => {
    expect(escrowStateOf([])).toBe('NONE');
    expect(escrowStateOf([WalletTransactionType.CREDIT_SALE_ESCROW_HOLD])).toBe('HELD');
    expect(escrowStateOf([WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE])).toBe('RELEASED');
    expect(
      escrowStateOf([WalletTransactionType.CREDIT_SALE_ESCROW_HOLD, WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE, WalletTransactionType.REFUND_DEDUCTION]),
    ).toBe('REVERSED');
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
    if (after.isNegative()) {
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

/** Escrow position of one package, derived from its ledger rows (the ledger is the source of truth). */
export type EscrowState = 'NONE' | 'HELD' | 'RELEASED' | 'REVERSED';

export function escrowStateOf(types: ReadonlyArray<WalletTransactionType>): EscrowState {
  if (types.includes('REFUND_DEDUCTION')) return 'REVERSED';
  if (types.includes('ESCROW_RELEASE_TO_WITHDRAWABLE')) return 'RELEASED';
  if (types.includes('CREDIT_SALE_ESCROW_HOLD')) return 'HELD';
  return 'NONE';
}
```

### `apps/backend/src/modules/wallet/wallet.module.ts`

```ts
import { Module } from '@nestjs/common';
import { VendorWalletController } from './vendor-wallet.controller';
import { WalletLedgerService } from './wallet-ledger.service';
import { WalletService } from './wallet.service';

/**
 * Vendor escrow wallets. `WalletLedgerService` is exported for the modules that
 * move money (orders lifecycle, settlements); it depends on nothing but the
 * caller's transaction, so no module cycle is possible.
 */
@Module({
  controllers: [VendorWalletController],
  providers: [WalletLedgerService, WalletService],
  exports: [WalletLedgerService, WalletService],
})
export class WalletModule {}
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
      const collected = await prisma.payment.aggregate({ where: { status: 'SUCCESSFUL' }, _sum: { cashAmount: true } });
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
 * This suite isolates the order lifecycle: it moves orders to PAID with the
 * real `OrderLifecycleService.markPaid` (same code path the payment callback
 * runs, including escrow). The full gateway path — initiate, bank page,
 * callback — is covered by test/finance.e2e-spec.ts.
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
        expect((await lifecycle.markPaid(order.parentOrderId)).applied).toBe(true);
        expect((await lifecycle.markPaid(order.parentOrderId)).applied).toBe(false); // idempotent
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
        expect((await lifecycle.markPaid(placed.body.parentOrderId)).applied).toBe(false);
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
        expect((await lifecycle.markPaid(placed.body.parentOrderId)).applied).toBe(false);
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

        // ── payment: hybrid split must add up to the payable amount ──────────
        const cashAmount = finalPayable.mul('0.4').toDecimalPlaces(2);
        const creditAmount = finalPayable.sub(cashAmount);
        await tx.payment.create({
          data: {
            parentOrderId: order.id,
            gatewayName: 'SANDBOX',
            gatewayTrackingToken: 'SBX-TRACK-0001',
            bankRrn: '123456789012',
            cashAmount,
            creditAmount,
            status: PaymentStatus.SUCCESSFUL,
            paidAt: new Date(),
          },
        });
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

## 11. Diff of changed Phase 6 files (vs `19577a2`)

```diff
diff --git a/.env.example b/.env.example
index 29dffec..f15885f 100644
--- a/.env.example
+++ b/.env.example
@@ -173,3 +173,21 @@ SHIPPING_FREE_THRESHOLD_PER_VENDOR=10000000
 ORDER_PAYMENT_TIMEOUT_MINUTES=30
 # Expiry sweeper period in seconds (0 disables it on this instance).
 ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=60
+
+# ─── Payments (Phase 7) ────────────────────────────────────────────────────
+# Origin the customer's browser and the bank reach this API on (no path). The
+# gateway callback is ${PUBLIC_API_ORIGIN}/api/v1/payments/callback.
+PUBLIC_API_ORIGIN=http://localhost:4000
+# `sandbox` = built-in simulated bank page (development/test ONLY; the API
+# refuses to boot with it in production). `zarinpal` = Zarinpal IPG v4.
+PAYMENT_GATEWAY_PROVIDER=sandbox
+# Required when PAYMENT_GATEWAY_PROVIDER=zarinpal. Never commit a real value.
+ZARINPAL_MERCHANT_ID=
+# https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com (Zarinpal test host).
+ZARINPAL_API_BASE_URL=https://payment.zarinpal.com
+# Timeout of one gateway API call, in milliseconds.
+PAYMENT_GATEWAY_TIMEOUT_MS=15000
+# Optional frontend result page; empty = the callback answers with JSON.
+PAYMENT_RESULT_REDIRECT_URL=
+# An INITIATED payment protects its order from the expiry sweeper this long.
+PAYMENT_CALLBACK_GRACE_MINUTES=20
diff --git a/apps/backend/prisma/schema.prisma b/apps/backend/prisma/schema.prisma
index 6a309fa..861d519 100644
--- a/apps/backend/prisma/schema.prisma
+++ b/apps/backend/prisma/schema.prisma
@@ -604,6 +604,17 @@ enum WalletTransactionType {
   COMMISSION_DEDUCTION
   SETTLEMENT_PAYOUT
   REFUND_DEDUCTION
+  /// Withdrawable → settlement hold when a vendor requests a payout.
+  SETTLEMENT_HOLD
+  /// Settlement hold → withdrawable when finance rejects the request.
+  SETTLEMENT_HOLD_RELEASE
+}
+
+/// Balance bucket of a vendor wallet a ledger row moves money in.
+enum WalletBalanceBucket {
+  PENDING
+  WITHDRAWABLE
+  SETTLEMENT_HOLD
 }
 
 enum SettlementStatus {
@@ -639,22 +650,29 @@ model Payment {
   @@map("payments")
 }
 
-/// Escrow wallet of a vendor. Balance semantics:
-///   pendingBalance      — earned but still held in escrow (order not delivered
-///                         or within the return window),
-///   withdrawableBalance — released and available for a settlement request,
-///   totalEarnedBalance  — lifetime gross earnings, monotonically increasing.
-/// `WalletTransaction` is the ledger of record; these columns are the projection
-/// maintained in the same database transaction as every ledger write.
+/// Escrow wallet of a vendor. The balance columns are the projection of the
+/// ledger (`WalletTransaction`), maintained in the same database transaction as
+/// every ledger write, one column per ledger bucket:
+///   pendingBalance         — PENDING bucket: vendor earnings of paid packages
+///                            that are not delivered yet (escrow),
+///   withdrawableBalance    — WITHDRAWABLE bucket: released, requestable,
+///   settlementHoldBalance  — SETTLEMENT_HOLD bucket: reserved by open
+///                            settlement requests awaiting finance,
+///   totalEarnedBalance     — earnings released on delivery (minus refunds of
+///                            delivered packages),
+///   totalWithdrawnAmount   — lifetime amount paid out by PAYA.
+/// CHECK constraints keep every balance >= 0 (migration phase7_finance).
 model VendorWallet {
-  id                  String   @id @default(uuid()) @db.Uuid
-  vendorId            String   @unique @map("vendor_id") @db.Uuid
-  vendor              Vendor   @relation(fields: [vendorId], references: [id], onDelete: Restrict)
-  pendingBalance      Decimal  @default(0) @map("pending_balance") @db.Decimal(15, 2)
-  withdrawableBalance Decimal  @default(0) @map("withdrawable_balance") @db.Decimal(15, 2)
-  totalEarnedBalance  Decimal  @default(0) @map("total_earned_balance") @db.Decimal(15, 2)
-  createdAt           DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
-  updatedAt           DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
+  id                    String   @id @default(uuid()) @db.Uuid
+  vendorId              String   @unique @map("vendor_id") @db.Uuid
+  vendor                Vendor   @relation(fields: [vendorId], references: [id], onDelete: Restrict)
+  pendingBalance        Decimal  @default(0) @map("pending_balance") @db.Decimal(15, 2)
+  withdrawableBalance   Decimal  @default(0) @map("withdrawable_balance") @db.Decimal(15, 2)
+  settlementHoldBalance Decimal  @default(0) @map("settlement_hold_balance") @db.Decimal(15, 2)
+  totalEarnedBalance    Decimal  @default(0) @map("total_earned_balance") @db.Decimal(15, 2)
+  totalWithdrawnAmount  Decimal  @default(0) @map("total_withdrawn_amount") @db.Decimal(15, 2)
+  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
+  updatedAt             DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)
 
   transactions WalletTransaction[]
 
@@ -662,10 +680,14 @@ model VendorWallet {
   @@map("vendor_wallets")
 }
 
-/// Append-only wallet ledger. `balanceAfter` records the withdrawable balance
-/// right after the entry, which makes the history auditable line by line without
-/// replaying it. Links to the sub-order or settlement that caused the movement
-/// are optional and SET NULL, so a deleted reference never destroys a ledger row.
+/// Append-only wallet ledger. Every row moves money in exactly one bucket of
+/// the wallet: `amount` is the signed change (negative = debit) and
+/// `balanceAfter` is that bucket's balance right after the row, so for every
+/// wallet and bucket SUM(amount) equals the wallet column. A transfer between
+/// two buckets (escrow release, settlement hold/release) is written as a pair
+/// of rows with the same type that sum to zero.
+/// Partial unique indexes (migration phase7_finance) make each sub-order and
+/// settlement movement happen at most once per type and bucket.
 model WalletTransaction {
   id                  String                @id @default(uuid()) @db.Uuid
   walletId            String                @map("wallet_id") @db.Uuid
@@ -675,12 +697,14 @@ model WalletTransaction {
   settlementRequestId String?               @map("settlement_request_id") @db.Uuid
   settlementRequest   SettlementRequest?    @relation(fields: [settlementRequestId], references: [id], onDelete: SetNull)
   type                WalletTransactionType
+  bucket              WalletBalanceBucket
   amount              Decimal               @db.Decimal(15, 2)
   balanceAfter        Decimal               @map("balance_after") @db.Decimal(15, 2)
   description         String?               @db.VarChar(255)
   createdAt           DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)
 
   @@index([walletId, createdAt])
+  @@index([walletId, bucket])
   @@index([subOrderId])
   @@index([settlementRequestId])
   @@map("wallet_transactions")
@@ -700,6 +724,7 @@ model SettlementRequest {
   processedByUserId String?          @map("processed_by_user_id") @db.Uuid
   processedBy       User?            @relation("SettlementProcessor", fields: [processedByUserId], references: [id], onDelete: SetNull)
   processedAt       DateTime?        @map("processed_at") @db.Timestamptz(3)
+  rejectionReason   String?          @map("rejection_reason") @db.VarChar(500)
   createdAt         DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
   updatedAt         DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)
 
diff --git a/apps/backend/src/app.module.ts b/apps/backend/src/app.module.ts
index 3cd9416..c1da2dc 100644
--- a/apps/backend/src/app.module.ts
+++ b/apps/backend/src/app.module.ts
@@ -21,7 +21,11 @@ import { ProductsModule } from './modules/products/products.module';
 import { ShippingModule } from './modules/shipping/shipping.module';
 import { AddressesModule } from './modules/addresses/addresses.module';
 import { CartModule } from './modules/cart/cart.module';
+import { FinancialModule } from './modules/financial/financial.module';
 import { OrdersModule } from './modules/orders/orders.module';
+import { PaymentsModule } from './modules/payments/payments.module';
+import { SettlementsModule } from './modules/settlements/settlements.module';
+import { WalletModule } from './modules/wallet/wallet.module';
 
 @Module({
   imports: [
@@ -52,6 +56,10 @@ import { OrdersModule } from './modules/orders/orders.module';
     AddressesModule,
     CartModule,
     OrdersModule,
+    WalletModule,
+    PaymentsModule,
+    SettlementsModule,
+    FinancialModule,
   ],
   providers: [
     // Order matters: authentication runs first and populates `request.user`,
diff --git a/apps/backend/src/config/env.validation.spec.ts b/apps/backend/src/config/env.validation.spec.ts
index f6598db..37ace24 100644
--- a/apps/backend/src/config/env.validation.spec.ts
+++ b/apps/backend/src/config/env.validation.spec.ts
@@ -19,8 +19,11 @@ const VALID_ENV: Record<string, unknown> = {
   JWT_REFRESH_SECRET: 'b'.repeat(48),
   SHIPPING_DEFAULT_FEE_PER_VENDOR: '500000',
   SHIPPING_FREE_THRESHOLD_PER_VENDOR: '10000000',
+  PUBLIC_API_ORIGIN: 'http://localhost:4000',
 };
 
+const MERCHANT_ID = '1344b5d4-0048-11e8-94db-005056a205be';
+
 describe('validateEnvironment', () => {
   it('requires the shipping fee settings and validates the order lifecycle timings', () => {
     const withoutFee: Record<string, unknown> = { ...VALID_ENV };
@@ -244,6 +247,50 @@ describe('validateEnvironment', () => {
   });
 });
 
+describe('validateEnvironment — payment gateway', () => {
+  it('defaults to the sandbox gateway in development and says so in the log', () => {
+    const warn = jest.fn();
+    const config = validateEnvironment(VALID_ENV, { logger: { warn } });
+    expect(config.PAYMENT_GATEWAY_PROVIDER).toBe('sandbox');
+    expect(config.PAYMENT_CALLBACK_GRACE_MINUTES).toBe(20);
+    expect(config.ZARINPAL_API_BASE_URL).toBe('https://payment.zarinpal.com');
+    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/PAYMENT_GATEWAY_PROVIDER=sandbox/));
+  });
+
+  it('requires an absolute public API origin without a path', () => {
+    const without: Record<string, unknown> = { ...VALID_ENV };
+    delete without.PUBLIC_API_ORIGIN;
+    expect(() => validateEnvironment(without)).toThrow(/PUBLIC_API_ORIGIN/);
+    expect(() => validateEnvironment({ ...VALID_ENV, PUBLIC_API_ORIGIN: 'https://api.shopino.ir/api/v1' })).toThrow(/PUBLIC_API_ORIGIN/);
+    expect(() => validateEnvironment({ ...VALID_ENV, PUBLIC_API_ORIGIN: 'api.shopino.ir' })).toThrow(/PUBLIC_API_ORIGIN/);
+  });
+
+  it('refuses the sandbox gateway in production', () => {
+    const production = { ...VALID_ENV, NODE_ENV: 'production', SMS_PROVIDER: 'kavenegar', SMS_KAVENEGAR_API_KEY: 'k', SMS_KAVENEGAR_SENDER: 's', SMS_KAVENEGAR_OTP_TEMPLATE: 't' };
+    expect(() => validateEnvironment({ ...production, PAYMENT_GATEWAY_PROVIDER: 'sandbox' }, { logger: { warn: jest.fn() } })).toThrow(
+      /PAYMENT_GATEWAY_PROVIDER=sandbox cannot be used in production/,
+    );
+    const config = validateEnvironment({ ...production, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID }, { logger: { warn: jest.fn() } });
+    expect(config.PAYMENT_GATEWAY_PROVIDER).toBe('zarinpal');
+  });
+
+  it('requires a well-formed merchant id for zarinpal, and treats a blank one as missing', () => {
+    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal' })).toThrow(/requires ZARINPAL_MERCHANT_ID/);
+    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: '  ' })).toThrow(/requires ZARINPAL_MERCHANT_ID/);
+    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: 'short' })).toThrow(/ZARINPAL_MERCHANT_ID must be/);
+    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'zarinpal', ZARINPAL_MERCHANT_ID: MERCHANT_ID, ZARINPAL_API_BASE_URL: 'http://payment.zarinpal.com' })).toThrow(
+      /ZARINPAL_API_BASE_URL/,
+    );
+  });
+
+  it('rejects an unknown gateway and an invalid result redirect', () => {
+    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_GATEWAY_PROVIDER: 'mellat' })).toThrow(/PAYMENT_GATEWAY_PROVIDER must be one of/);
+    expect(() => validateEnvironment({ ...VALID_ENV, PAYMENT_RESULT_REDIRECT_URL: 'javascript:alert(1)' })).toThrow(/PAYMENT_RESULT_REDIRECT_URL/);
+    const config = validateEnvironment({ ...VALID_ENV, PAYMENT_RESULT_REDIRECT_URL: '/checkout/result' }, { logger: { warn: jest.fn() } });
+    expect(config.PAYMENT_RESULT_REDIRECT_URL).toBe('/checkout/result');
+  });
+});
+
 describe('resolveLogLevels', () => {
   it('enables the requested level and everything more severe', () => {
     expect(resolveLogLevels('error')).toEqual(['error']);
diff --git a/apps/backend/src/config/env.validation.ts b/apps/backend/src/config/env.validation.ts
index 32cd4b9..e05264a 100644
--- a/apps/backend/src/config/env.validation.ts
+++ b/apps/backend/src/config/env.validation.ts
@@ -33,6 +33,10 @@ export const MIN_SECRET_LENGTH = 32;
 export const SMS_PROVIDERS = ['sandbox', 'kavenegar'] as const;
 export type SmsProviderName = (typeof SMS_PROVIDERS)[number];
 
+/** Card-payment (IPG) gateways the API can be configured with. */
+export const PAYMENT_GATEWAY_PROVIDERS = ['sandbox', 'zarinpal'] as const;
+export type PaymentGatewayProviderName = (typeof PAYMENT_GATEWAY_PROVIDERS)[number];
+
 /** Storage backends the API can be configured with. */
 export const STORAGE_PROVIDERS = ['local', 's3'] as const;
 export type StorageProviderName = (typeof STORAGE_PROVIDERS)[number];
@@ -59,6 +63,8 @@ const OPTIONAL_KEYS: readonly string[] = [
   'S3_ACCESS_KEY_ID',
   'S3_SECRET_ACCESS_KEY',
   'S3_PUBLIC_BASE_URL',
+  'ZARINPAL_MERCHANT_ID',
+  'PAYMENT_RESULT_REDIRECT_URL',
 ];
 
 /** Shape of the validated configuration object exposed through `ConfigService`. */
@@ -341,6 +347,51 @@ export class EnvironmentVariables {
   @Max(3600)
   ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS: number = 60;
 
+  /**
+   * Absolute origin the *customer's browser* and the bank reach this API on
+   * (scheme + host [+ port], no path). Used to build the gateway callback URL
+   * and the sandbox bank page URL.
+   */
+  @Matches(/^https?:\/\/[^/\s]+$/, { message: 'PUBLIC_API_ORIGIN must be an absolute origin such as https://api.example.com (no path, no trailing slash)' })
+  PUBLIC_API_ORIGIN!: string;
+
+  @IsIn(PAYMENT_GATEWAY_PROVIDERS, { message: `PAYMENT_GATEWAY_PROVIDER must be one of: ${PAYMENT_GATEWAY_PROVIDERS.join(', ')}` })
+  PAYMENT_GATEWAY_PROVIDER: PaymentGatewayProviderName = 'sandbox';
+
+  /** Zarinpal merchant id (36-character UUID). Required when PAYMENT_GATEWAY_PROVIDER=zarinpal. */
+  @IsOptional()
+  @Matches(/^[0-9a-fA-F-]{36}$/, { message: 'ZARINPAL_MERCHANT_ID must be the 36-character merchant id issued by Zarinpal' })
+  ZARINPAL_MERCHANT_ID?: string;
+
+  /** Zarinpal host: https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com (Zarinpal's own test host). */
+  @Matches(/^https:\/\/[^/\s]+$/, { message: 'ZARINPAL_API_BASE_URL must be an https origin without a path' })
+  ZARINPAL_API_BASE_URL: string = 'https://payment.zarinpal.com';
+
+  /** Timeout of one call to the gateway API, in milliseconds. */
+  @Type(() => Number)
+  @IsInt()
+  @Min(1000)
+  @Max(60_000)
+  PAYMENT_GATEWAY_TIMEOUT_MS: number = 15_000;
+
+  /**
+   * Optional frontend page the payment callback redirects the browser to
+   * (`?orderNumber=…&status=…`). When unset the callback answers with JSON.
+   */
+  @IsOptional()
+  @Matches(/^(https?:\/\/\S+|\/\S*)$/, { message: 'PAYMENT_RESULT_REDIRECT_URL must be an absolute URL or a path starting with /' })
+  PAYMENT_RESULT_REDIRECT_URL?: string;
+
+  /**
+   * Minutes after which an INITIATED payment no longer protects its order from
+   * the expiry sweeper (the customer is assumed to have abandoned the bank page).
+   */
+  @Type(() => Number)
+  @IsInt()
+  @Min(5)
+  @Max(120)
+  PAYMENT_CALLBACK_GRACE_MINUTES: number = 20;
+
   @IsOptional()
   @IsIn(LOG_LEVELS, { message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
   LOG_LEVEL?: LogLevelName;
@@ -374,6 +425,7 @@ export function validateEnvironment(
   assertSecrets(config);
   assertSmsConfiguration(config, logger);
   assertStorageConfiguration(config, logger);
+  assertPaymentConfiguration(config, logger);
   return config;
 }
 
@@ -501,6 +553,35 @@ function assertStorageConfiguration(config: EnvironmentVariables, logger: Pick<L
   }
 }
 
+/**
+ * The sandbox gateway simulates the bank inside this API and would mark orders
+ * paid without any money moving, so it can never run in production; Zarinpal
+ * needs its merchant id at boot, not at the first checkout.
+ */
+function assertPaymentConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
+  if (config.PAYMENT_GATEWAY_PROVIDER === 'zarinpal') {
+    if (config.ZARINPAL_MERCHANT_ID === undefined) {
+      throw new Error(
+        'PAYMENT_GATEWAY_PROVIDER=zarinpal requires ZARINPAL_MERCHANT_ID. ' +
+          'Provide the merchant id issued by Zarinpal, or use PAYMENT_GATEWAY_PROVIDER=sandbox in development.',
+      );
+    }
+    return;
+  }
+
+  if (config.NODE_ENV === NodeEnvironment.Production) {
+    throw new Error(
+      'PAYMENT_GATEWAY_PROVIDER=sandbox cannot be used in production: it simulates the bank and confirms payments without moving money. ' +
+        'Configure PAYMENT_GATEWAY_PROVIDER=zarinpal with a real merchant id.',
+    );
+  }
+
+  logger.warn(
+    'PAYMENT_GATEWAY_PROVIDER=sandbox — card payments are simulated by the built-in sandbox bank page; no money moves. ' +
+      'This is a development/test provider only.',
+  );
+}
+
 function formatValidationErrors(errors: readonly ValidationError[], parentPath = ''): string {
   return errors
     .flatMap((error) => {
diff --git a/apps/backend/src/modules/orders/admin-orders.controller.ts b/apps/backend/src/modules/orders/admin-orders.controller.ts
index 9c6b53f..eb6ebf6 100644
--- a/apps/backend/src/modules/orders/admin-orders.controller.ts
+++ b/apps/backend/src/modules/orders/admin-orders.controller.ts
@@ -67,6 +67,7 @@ export class AdminOrdersController {
     return {
       previousStatus: result.previousStatus,
       stockAction: result.stockAction,
+      walletAction: result.walletAction,
       auditLogId: result.auditLogId,
       subOrder: await this.queries.subOrderForStaff(id),
     };
diff --git a/apps/backend/src/modules/orders/customer-orders.controller.ts b/apps/backend/src/modules/orders/customer-orders.controller.ts
index b02d4dc..0687d9b 100644
--- a/apps/backend/src/modules/orders/customer-orders.controller.ts
+++ b/apps/backend/src/modules/orders/customer-orders.controller.ts
@@ -16,7 +16,7 @@ import type { AuthenticatedUser } from '../../common/types/authenticated-user';
 import type { RequestContext } from '../../common/types/request-context';
 import { SkipAudit } from '../audit/audit.decorator';
 import { CancelOrderDto, CustomerOrderQueryDto } from './dto/order-input.dto';
-import { CancelOrderResponseDto, CustomerOrderDetailDto, PaginatedCustomerOrdersDto } from './dto/order-response.dto';
+import { CancelOrderResponseDto, CustomerDeliveryConfirmationDto, CustomerOrderDetailDto, PaginatedCustomerOrdersDto } from './dto/order-response.dto';
 import { OrderLifecycleService } from './order-lifecycle.service';
 import { OrderQueriesService } from './order-queries.service';
 
@@ -68,4 +68,32 @@ export class CustomerOrdersController {
     const auditLogId = await this.lifecycle.cancelByCustomer(user.id, id, dto.reason, { actorId: user.id, context });
     return { ...(await this.queries.detailForCustomer(user.id, id)), auditLogId };
   }
+
+  @Post(':id/sub-orders/:subOrderId/confirm-delivery')
+  @HttpCode(HttpStatus.OK)
+  @SkipAudit() // audited inside the transaction
+  @ApiOperation({
+    summary: 'Confirm receipt of a shipped package',
+    description:
+      'Moves a SHIPPED package of a paid order to DELIVERED. In the same transaction the store’s earnings for the package are ' +
+      'released from escrow to its withdrawable balance (once; repeated calls are rejected).',
+  })
+  @ApiOkResponse({ type: CustomerDeliveryConfirmationDto })
+  @ApiNotFoundResponse({ description: 'Unknown order/package or not the caller’s' })
+  @ApiConflictResponse({ description: 'INVALID_STATUS_TRANSITION (only SHIPPED packages can be confirmed)' })
+  async confirmDelivery(
+    @CurrentUser() user: AuthenticatedUser,
+    @Param('id', UUID) id: string,
+    @Param('subOrderId', UUID) subOrderId: string,
+    @ClientContext() context: RequestContext,
+  ): Promise<CustomerDeliveryConfirmationDto> {
+    const result = await this.lifecycle.confirmDeliveryByCustomer(user.id, id, subOrderId, { actorId: user.id, context });
+    return {
+      previousStatus: result.previousStatus,
+      stockAction: result.stockAction,
+      walletAction: result.walletAction,
+      auditLogId: result.auditLogId,
+      order: await this.queries.detailForCustomer(user.id, id),
+    };
+  }
 }
diff --git a/apps/backend/src/modules/orders/dto/order-response.dto.ts b/apps/backend/src/modules/orders/dto/order-response.dto.ts
index 7d7ae7e..584e3c6 100644
--- a/apps/backend/src/modules/orders/dto/order-response.dto.ts
+++ b/apps/backend/src/modules/orders/dto/order-response.dto.ts
@@ -1,7 +1,7 @@
 import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
 import { ParentOrderPaymentStatus, PaymentMethod, SubOrderStatus } from '@prisma/client';
 
-const MONEY = { type: String, example: '1250000.00', description: 'Toman, 2 decimals, as a string.' } as const;
+const MONEY = { type: String, example: '1250000.00', description: 'IRR (Rial, `platform.currency`), 2 decimals, as a string.' } as const;
 
 export class AddressSnapshotDto {
   @ApiProperty({ example: 'تهران' }) province!: string;
@@ -186,6 +186,13 @@ export class SubOrderTransitionResultDto {
   @ApiProperty({ enum: SubOrderStatus }) previousStatus!: SubOrderStatus;
   @ApiProperty({ enum: ['RESTOCKED', 'NONE'], description: 'What happened to the stock of the package lines.' })
   stockAction!: 'RESTOCKED' | 'NONE';
+  @ApiProperty({
+    enum: ['ESCROW_RELEASED', 'ESCROW_REVERSED', 'EARNINGS_REVERSED', 'NONE'],
+    description:
+      'Wallet consequence: ESCROW_RELEASED (delivered → withdrawable), ESCROW_REVERSED (cancel/refund before delivery, out of escrow), ' +
+      'EARNINGS_REVERSED (refund after delivery, out of the withdrawable balance), NONE.',
+  })
+  walletAction!: 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'NONE';
   @ApiProperty({ format: 'uuid' }) auditLogId!: string;
 }
 
@@ -236,3 +243,7 @@ export class AdminSubOrderTransitionDto extends SubOrderTransitionResultDto {
 export class CancelOrderResponseDto extends CustomerOrderDetailDto {
   @ApiPropertyOptional({ format: 'uuid' }) auditLogId?: string;
 }
+
+export class CustomerDeliveryConfirmationDto extends SubOrderTransitionResultDto {
+  @ApiProperty({ type: CustomerOrderDetailDto, description: 'The whole order after the confirmation.' }) order!: CustomerOrderDetailDto;
+}
diff --git a/apps/backend/src/modules/orders/order-audit.ts b/apps/backend/src/modules/orders/order-audit.ts
index fdf105d..ec2fb86 100644
--- a/apps/backend/src/modules/orders/order-audit.ts
+++ b/apps/backend/src/modules/orders/order-audit.ts
@@ -23,7 +23,7 @@ export async function writeOrderAudit(
   actor: OrderActor,
   entry: {
     action: AuditAction;
-    entityName: 'ParentOrder' | 'SubOrder';
+    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest';
     entityId: string;
     oldValue?: Record<string, unknown>;
     newValue: Record<string, unknown>;
diff --git a/apps/backend/src/modules/orders/order-lifecycle.service.ts b/apps/backend/src/modules/orders/order-lifecycle.service.ts
index bee1495..6db538b 100644
--- a/apps/backend/src/modules/orders/order-lifecycle.service.ts
+++ b/apps/backend/src/modules/orders/order-lifecycle.service.ts
@@ -1,8 +1,11 @@
 import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
-import { AuditAction, ParentOrderPaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
+import { ConfigService } from '@nestjs/config';
+import { AuditAction, ParentOrderPaymentStatus, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
 import { conflictWith } from '../../common/http-errors';
+import type { EnvironmentVariables } from '../../config/env.validation';
 import { PrismaService } from '../../infra/prisma/prisma.service';
 import { InventoryService } from '../products/inventory.service';
+import { WalletLedgerService, type ReverseOutcome } from '../wallet/wallet-ledger.service';
 import type { ForceSubOrderStatusDto, VendorUpdateSubOrderStatusDto } from './dto/order-input.dto';
 import { lockParentOrder, stockMovements, SYSTEM_ACTOR, writeOrderAudit, type OrderActor } from './order-audit';
 import type { ActorRole } from './order-views';
@@ -22,9 +25,18 @@ export interface TransitionResult {
   subOrderId: string;
   previousStatus: SubOrderStatus;
   stockAction: 'RESTOCKED' | 'NONE';
+  /** Wallet consequence: escrow released on delivery, or the vendor's earnings reversed on cancel/refund. */
+  walletAction: 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'NONE';
   auditLogId: string;
 }
 
+/** What confirming a payment did; `applied: false` means the order was no longer PENDING. */
+export interface PaymentApplication {
+  applied: boolean;
+  escrowHeld: string;
+  auditLogId: string | null;
+}
+
 /**
  * Every state change of an order after checkout. All operations lock the parent
  * order row first, so a payment callback, a customer cancel, the expiry sweeper
@@ -35,15 +47,27 @@ export interface TransitionResult {
  * - unpaid order cancelled / payment failed / payment expired → release reservation;
  * - payment confirmed → commit reservation (stock and reserved both drop);
  * - paid package cancelled by the vendor or refunded by staff before shipping → restock.
+ *
+ * Wallet rules (Phase 7, via `WalletLedgerService` in the same transaction):
+ * - payment confirmed → each package's vendorEarningsAmount is held in escrow (PENDING);
+ * - package DELIVERED (customer confirmation or staff/carrier) → escrow released to WITHDRAWABLE, once;
+ * - package CANCELLED / REFUNDED → the vendor's earnings are reversed (from escrow, or from the
+ *   withdrawable balance if already delivered; 409 when the vendor already withdrew it).
  */
 @Injectable()
 export class OrderLifecycleService {
   private readonly logger = new Logger(OrderLifecycleService.name);
 
+  private readonly paymentGraceMs: number;
+
   constructor(
     private readonly prisma: PrismaService,
     private readonly inventory: InventoryService,
-  ) {}
+    private readonly ledger: WalletLedgerService,
+    config: ConfigService<EnvironmentVariables, true>,
+  ) {
+    this.paymentGraceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
+  }
 
   // ─── unpaid orders ────────────────────────────────────────────────────────
 
@@ -81,46 +105,83 @@ export class OrderLifecycleService {
   }
 
   /**
-   * Payment confirmed: the order becomes PAID and each reservation is converted
-   * into a sale. Called by the payment module once a verified gateway callback
-   * arrives (no HTTP endpoint exposes it). Idempotent: returns `false` if the
-   * order is not PENDING (already paid, or cancelled/expired first).
+   * Payment confirmed: the order becomes PAID, each reservation is converted
+   * into a sale and each package's vendor earnings enter escrow. Idempotent:
+   * `applied: false` if the order is not PENDING (already paid, or
+   * cancelled/expired first).
    */
-  async markPaid(parentOrderId: string, actor: OrderActor = SYSTEM_ACTOR): Promise<boolean> {
+  async markPaid(parentOrderId: string, actor: OrderActor = SYSTEM_ACTOR): Promise<PaymentApplication> {
     return this.prisma.$transaction(async (tx) => {
-      const order = await this.lockPending(tx, parentOrderId);
-      if (!order) return false;
-      const items = await tx.orderItem.findMany({
-        where: { subOrder: { parentOrderId } },
-        select: { productVariantId: true, quantity: true },
-      });
-      for (const move of stockMovements(items)) {
-        await this.inventory.commitReservation(move.variantId, move.quantity, tx);
+      if (!(await lockParentOrder(tx, parentOrderId))) {
+        return { applied: false, escrowHeld: '0.00', auditLogId: null };
       }
-      const paidAt = new Date();
-      await tx.parentOrder.update({
-        where: { id: parentOrderId },
-        data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt },
-      });
-      await writeOrderAudit(tx, actor, {
-        action: AuditAction.PAYMENT_CAPTURE,
-        entityName: 'ParentOrder',
-        entityId: parentOrderId,
-        oldValue: { paymentStatus: ParentOrderPaymentStatus.PENDING },
-        newValue: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt: paidAt.toISOString() },
-      });
-      return true;
+      return this.applyPaymentLocked(tx, parentOrderId, actor, {});
     });
   }
 
+  /**
+   * `markPaid` for a caller that already runs the transaction and holds the
+   * parent-order lock (the payment callback, which updates the Payment row in
+   * the same transaction). Sub-orders keep PENDING_APPROVAL and become visible
+   * to vendors because the parent is now PAID.
+   */
+  async applyPaymentLocked(tx: Tx, parentOrderId: string, actor: OrderActor, payment: { paymentId?: string; bankRrn?: string }): Promise<PaymentApplication> {
+    const order = await tx.parentOrder.findFirst({
+      where: { id: parentOrderId, paymentStatus: ParentOrderPaymentStatus.PENDING },
+      select: { id: true },
+    });
+    if (!order) return { applied: false, escrowHeld: '0.00', auditLogId: null };
+
+    const subs = await tx.subOrder.findMany({
+      where: { parentOrderId },
+      select: { id: true, vendorId: true, subOrderNumber: true, vendorEarningsAmount: true, items: { select: { productVariantId: true, quantity: true } } },
+      orderBy: { vendorId: 'asc' }, // wallet lock order
+    });
+    for (const move of stockMovements(subs.flatMap((sub) => sub.items))) {
+      await this.inventory.commitReservation(move.variantId, move.quantity, tx);
+    }
+    const paidAt = new Date();
+    await tx.parentOrder.update({
+      where: { id: parentOrderId },
+      data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt },
+    });
+    let escrowHeld = new Prisma.Decimal(0);
+    for (const sub of subs) {
+      if (await this.ledger.holdSaleEscrow(tx, sub)) {
+        escrowHeld = escrowHeld.plus(sub.vendorEarningsAmount);
+      }
+    }
+    const auditLogId = await writeOrderAudit(tx, actor, {
+      action: AuditAction.PAYMENT_CAPTURE,
+      entityName: 'ParentOrder',
+      entityId: parentOrderId,
+      oldValue: { paymentStatus: ParentOrderPaymentStatus.PENDING },
+      newValue: {
+        paymentStatus: ParentOrderPaymentStatus.PAID,
+        paidAt: paidAt.toISOString(),
+        escrowHeld: escrowHeld.toFixed(2),
+        packages: subs.length,
+        ...(payment.paymentId ? { paymentId: payment.paymentId } : {}),
+        ...(payment.bankRrn ? { bankRrn: payment.bankRrn } : {}),
+      },
+    });
+    return { applied: true, escrowHeld: escrowHeld.toFixed(2), auditLogId };
+  }
+
   /**
    * Cancels unpaid orders whose payment window has passed and releases their
    * stock. Each order is handled in its own transaction (one bad row cannot
    * block the rest) and re-checked under lock (a payment that landed meanwhile wins).
    */
   async expireOverdue(now: Date = new Date(), batchSize = 100): Promise<number> {
+    // A customer who is on the bank page right now must not lose the order: an
+    // INITIATED payment younger than the grace window protects it.
+    const inFlightSince = new Date(now.getTime() - this.paymentGraceMs);
+    const inFlight: Prisma.ParentOrderWhereInput = {
+      payments: { some: { status: PaymentStatus.INITIATED, createdAt: { gt: inFlightSince } } },
+    };
     const due = await this.prisma.parentOrder.findMany({
-      where: { paymentStatus: ParentOrderPaymentStatus.PENDING, paymentExpiresAt: { lte: now } },
+      where: { paymentStatus: ParentOrderPaymentStatus.PENDING, paymentExpiresAt: { lte: now }, NOT: inFlight },
       select: { id: true },
       orderBy: { paymentExpiresAt: 'asc' },
       take: batchSize,
@@ -131,6 +192,7 @@ export class OrderLifecycleService {
         const done = await this.prisma.$transaction(async (tx) => {
           const order = await this.lockPending(tx, id);
           if (!order || order.paymentExpiresAt === null || order.paymentExpiresAt > now) return false;
+          if ((await tx.parentOrder.count({ where: { id, ...inFlight } })) > 0) return false;
           await this.closeUnpaid(tx, id, 'PAYMENT_EXPIRED', undefined, SYSTEM_ACTOR);
           return true;
         });
@@ -204,6 +266,30 @@ export class OrderLifecycleService {
     });
   }
 
+  /**
+   * The customer confirms receipt of a SHIPPED package: it becomes DELIVERED
+   * and the vendor's escrow is released to the withdrawable balance.
+   */
+  async confirmDeliveryByCustomer(userId: string, parentOrderId: string, subOrderId: string, actor: OrderActor): Promise<TransitionResult> {
+    return this.prisma.$transaction(async (tx) => {
+      const locked = await lockParentOrder(tx, parentOrderId);
+      const sub = locked ? await this.loadForTransition(tx, subOrderId) : null;
+      if (!sub || sub.parentOrderId !== parentOrderId || sub.parentOrder.userId !== userId) {
+        throw new NotFoundException('Order not found');
+      }
+      if (sub.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PAID || sub.status !== SubOrderStatus.SHIPPED) {
+        throw conflictWith('INVALID_STATUS_TRANSITION', `A ${sub.status} package cannot be confirmed as delivered; only SHIPPED packages can`, {
+          currentStatus: sub.status,
+        });
+      }
+      return this.applyTransition(tx, sub, SubOrderStatus.DELIVERED, { status: SubOrderStatus.DELIVERED, deliveredAt: new Date() }, {
+        role: 'CUSTOMER',
+        note: 'Receipt confirmed by the customer',
+        actor,
+      });
+    });
+  }
+
   // ─── internals ────────────────────────────────────────────────────────────
 
   private async lockPending(tx: Tx, parentOrderId: string): Promise<{ id: string; paymentExpiresAt: Date | null } | null> {
@@ -291,6 +377,7 @@ export class OrderLifecycleService {
         await this.inventory.adjustStock(move.variantId, move.quantity, tx);
       }
     }
+    const walletAction = await this.applyWalletEffect(tx, sub, target, meta.note);
     await tx.subOrderStatusHistory.create({
       data: { subOrderId: sub.id, fromStatus: sub.status, toStatus: target, actorUserId: meta.actor.actorId, actorRole: meta.role, note: meta.note },
     });
@@ -305,10 +392,28 @@ export class OrderLifecycleService {
         actorRole: meta.role,
         note: meta.note,
         stockAction: restock ? 'RESTOCKED' : 'NONE',
+        walletAction,
+        ...(walletAction !== 'NONE' ? { vendorEarningsAmount: sub.vendorEarningsAmount.toFixed(2) } : {}),
         ...(restock ? { restockedLines: stockMovements(sub.items) } : {}),
       },
     });
-    return { subOrderId: sub.id, previousStatus: sub.status, stockAction: restock ? 'RESTOCKED' : 'NONE', auditLogId };
+    return { subOrderId: sub.id, previousStatus: sub.status, stockAction: restock ? 'RESTOCKED' : 'NONE', walletAction, auditLogId };
+  }
+
+  /** Escrow consequence of a transition on a paid package; runs under the parent lock, before the audit row. */
+  private async applyWalletEffect(tx: Tx, sub: TransitionRow, target: SubOrderStatus, note: string | null): Promise<TransitionResult['walletAction']> {
+    if (target === SubOrderStatus.DELIVERED) {
+      const released = await this.ledger.releaseEscrow(tx, sub);
+      if (released) {
+        await tx.subOrder.update({ where: { id: sub.id }, data: { escrowReleasedAt: new Date() } });
+      }
+      return released ? 'ESCROW_RELEASED' : 'NONE';
+    }
+    if (target === SubOrderStatus.CANCELLED || target === SubOrderStatus.REFUNDED) {
+      const outcome: ReverseOutcome = await this.ledger.reverseEscrow(tx, sub, note ?? target);
+      return outcome === 'FROM_PENDING' ? 'ESCROW_REVERSED' : outcome === 'FROM_WITHDRAWABLE' ? 'EARNINGS_REVERSED' : 'NONE';
+    }
+    return 'NONE';
   }
 }
 
@@ -316,8 +421,10 @@ const transitionSelect = {
   id: true,
   vendorId: true,
   subOrderNumber: true,
+  parentOrderId: true,
+  vendorEarningsAmount: true,
   status: true,
-  parentOrder: { select: { paymentStatus: true } },
+  parentOrder: { select: { paymentStatus: true, userId: true } },
   items: { select: { productVariantId: true, quantity: true } },
 } satisfies Prisma.SubOrderSelect;
 
diff --git a/apps/backend/src/modules/orders/orders.module.ts b/apps/backend/src/modules/orders/orders.module.ts
index 69f56bd..608decf 100644
--- a/apps/backend/src/modules/orders/orders.module.ts
+++ b/apps/backend/src/modules/orders/orders.module.ts
@@ -3,6 +3,7 @@ import { CartModule } from '../cart/cart.module';
 import { CategoriesModule } from '../categories/categories.module';
 import { ProductsModule } from '../products/products.module';
 import { ShippingModule } from '../shipping/shipping.module';
+import { WalletModule } from '../wallet/wallet.module';
 import { AdminOrdersController } from './admin-orders.controller';
 import { CheckoutController } from './checkout.controller';
 import { CheckoutService } from './checkout.service';
@@ -14,11 +15,12 @@ import { VendorOrdersController } from './vendor-orders.controller';
 
 /**
  * Checkout, multi-vendor order splitting and the order lifecycle.
- * `OrderLifecycleService` is exported for the payment module (markPaid /
- * markPaymentFailed).
+ * `OrderLifecycleService` is exported for the payment module
+ * (applyPaymentLocked / markPaid); it moves wallet money through
+ * `WalletLedgerService` inside its own transactions.
  */
 @Module({
-  imports: [CartModule, CategoriesModule, ProductsModule, ShippingModule],
+  imports: [CartModule, CategoriesModule, ProductsModule, ShippingModule, WalletModule],
   controllers: [CheckoutController, CustomerOrdersController, VendorOrdersController, AdminOrdersController],
   providers: [CheckoutService, OrderLifecycleService, OrderQueriesService, OrderExpiryScheduler],
   exports: [OrderLifecycleService],
diff --git a/apps/backend/src/modules/orders/vendor-orders.controller.ts b/apps/backend/src/modules/orders/vendor-orders.controller.ts
index 407f20a..3974680 100644
--- a/apps/backend/src/modules/orders/vendor-orders.controller.ts
+++ b/apps/backend/src/modules/orders/vendor-orders.controller.ts
@@ -76,6 +76,7 @@ export class VendorOrdersController {
     return {
       previousStatus: result.previousStatus,
       stockAction: result.stockAction,
+      walletAction: result.walletAction,
       auditLogId: result.auditLogId,
       subOrder: await this.queries.detailForVendor(user.id, id),
     };
diff --git a/apps/backend/src/setup/app.setup.ts b/apps/backend/src/setup/app.setup.ts
index 89dd33a..8921251 100644
--- a/apps/backend/src/setup/app.setup.ts
+++ b/apps/backend/src/setup/app.setup.ts
@@ -112,6 +112,11 @@ export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
       .addTag('customer-orders', "A customer's orders, tracking and cancellation of unpaid orders")
       .addTag('vendor-orders', "A store's paid packages and fulfilment status")
       .addTag('admin-orders', 'Staff order search and forced package resolutions')
+      .addTag('payments', 'Card payment (IPG): initiate a payment and the public bank callback')
+      .addTag('sandbox-payments', 'DEVELOPMENT ONLY — simulated bank page of the sandbox gateway (404 unless PAYMENT_GATEWAY_PROVIDER=sandbox)')
+      .addTag('vendor-wallet', "A store's escrow wallet, ledger and settlement (payout) requests")
+      .addTag('admin-settlements', 'Finance: review and pay out vendor settlement requests')
+      .addTag('admin-financial', 'Finance: platform GMV, commission, escrow and settlement overview')
       .build(),
   );
 }
diff --git a/apps/backend/test/orders.e2e-spec.ts b/apps/backend/test/orders.e2e-spec.ts
index f48d513..da0a119 100644
--- a/apps/backend/test/orders.e2e-spec.ts
+++ b/apps/backend/test/orders.e2e-spec.ts
@@ -26,9 +26,10 @@ import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setu
  * stores are onboarded and approved over the API, products are created over the
  * vendor API, orders are placed over the checkout API.
  *
- * Payment confirmation has no HTTP endpoint yet (payment gateway = later
- * phase), so the suite calls the real `OrderLifecycleService.markPaid` — the
- * exact method the payment module will call — to move orders to PAID.
+ * This suite isolates the order lifecycle: it moves orders to PAID with the
+ * real `OrderLifecycleService.markPaid` (same code path the payment callback
+ * runs, including escrow). The full gateway path — initiate, bank page,
+ * callback — is covered by test/finance.e2e-spec.ts.
  *
  * The platform shipping policy is set for the duration of the suite through
  * real `system_configs` rows (restored afterwards).
@@ -842,8 +843,8 @@ describe('Phase 6 — cart, checkout, multi-vendor orders and lifecycle (live st
 
       it('commits the reservation when payment is confirmed (stock and reserved both drop)', async () => {
         const before = { A1: await stockOf(v.A1), B1: await stockOf(v.B1) };
-        expect(await lifecycle.markPaid(order.parentOrderId)).toBe(true);
-        expect(await lifecycle.markPaid(order.parentOrderId)).toBe(false); // idempotent
+        expect((await lifecycle.markPaid(order.parentOrderId)).applied).toBe(true);
+        expect((await lifecycle.markPaid(order.parentOrderId)).applied).toBe(false); // idempotent
         expect(await stockOf(v.A1)).toEqual({ stock: before.A1.stock - 2, reserved: before.A1.reserved - 2 });
         expect(await stockOf(v.B1)).toEqual({ stock: before.B1.stock - 1, reserved: before.B1.reserved - 1 });
         const detail = await request<OrderDetail>(`/customer/orders/${order.parentOrderId}`, { token: customer.token });
@@ -1018,7 +1019,7 @@ describe('Phase 6 — cart, checkout, multi-vendor orders and lifecycle (live st
         const detail = await request<OrderDetail>(`/customer/orders/${placed.body.parentOrderId}`, { token: customer2.token });
         expect(detail.body.paymentStatus).toBe('FAILED');
         expect(detail.body.timeline.map((event) => event.type)).toContain('PAYMENT_FAILED');
-        expect(await lifecycle.markPaid(placed.body.parentOrderId)).toBe(false);
+        expect((await lifecycle.markPaid(placed.body.parentOrderId)).applied).toBe(false);
       });
 
       it('cancels orders whose payment window passed and releases their stock', async () => {
@@ -1035,7 +1036,7 @@ describe('Phase 6 — cart, checkout, multi-vendor orders and lifecycle (live st
         expect(row.paymentStatus).toBe('CANCELLED');
         expect(row.cancellationReason).toBe('Payment was not completed in time');
         expect(row.subOrders.every((sub) => sub.status === 'CANCELLED')).toBe(true);
-        expect(await lifecycle.markPaid(placed.body.parentOrderId)).toBe(false);
+        expect((await lifecycle.markPaid(placed.body.parentOrderId)).applied).toBe(false);
       });
     });
   });
diff --git a/apps/backend/test/schema-integrity.e2e-spec.ts b/apps/backend/test/schema-integrity.e2e-spec.ts
index 855a8ef..24db5e2 100644
--- a/apps/backend/test/schema-integrity.e2e-spec.ts
+++ b/apps/backend/test/schema-integrity.e2e-spec.ts
@@ -7,6 +7,7 @@ import {
   Prisma,
   SubOrderStatus,
   UserRole,
+  WalletBalanceBucket,
   WalletTransactionType,
 } from '@prisma/client';
 import type { PrismaClient } from '@prisma/client';
@@ -174,21 +175,36 @@ describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
 
         // ── vendor escrow ledger ────────────────────────────────────────────
         const wallet = await tx.vendorWallet.findFirstOrThrow({ where: { vendorId: variant.product.vendorId } });
+        // Bucket ledger (Phase 7): the hold credits PENDING; the release is a
+        // pair of rows (PENDING −, WITHDRAWABLE +) that sums to zero.
         await tx.walletTransaction.create({
           data: {
             walletId: wallet.id,
             subOrderId: subOrder.id,
             type: WalletTransactionType.CREDIT_SALE_ESCROW_HOLD,
+            bucket: WalletBalanceBucket.PENDING,
             amount: vendorEarnings,
-            balanceAfter: wallet.withdrawableBalance,
+            balanceAfter: wallet.pendingBalance.add(vendorEarnings),
             description: 'نگه‌داری وجه فروش در حساب امانی',
           },
         });
+        await tx.walletTransaction.create({
+          data: {
+            walletId: wallet.id,
+            subOrderId: subOrder.id,
+            type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
+            bucket: WalletBalanceBucket.PENDING,
+            amount: vendorEarnings.negated(),
+            balanceAfter: wallet.pendingBalance,
+            description: 'آزادسازی وجه پس از تأیید تحویل',
+          },
+        });
         const released = await tx.walletTransaction.create({
           data: {
             walletId: wallet.id,
             subOrderId: subOrder.id,
             type: WalletTransactionType.ESCROW_RELEASE_TO_WITHDRAWABLE,
+            bucket: WalletBalanceBucket.WITHDRAWABLE,
             amount: vendorEarnings,
             balanceAfter: wallet.withdrawableBalance.add(vendorEarnings),
             description: 'آزادسازی وجه پس از تأیید تحویل',
```
