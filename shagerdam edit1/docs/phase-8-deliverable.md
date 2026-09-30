# Shopino — Phase 8 deliverable

**Scope:**
- pluggable banking credit engine (provider adapter + registry);
- credit applications;
- credit ledger with an enforced invariant;
- installment calculator;
- BANK_CREDIT and HYBRID checkout;
- installment schedules, overdue marking and installment repayment;
- staff credit views.

**Base:** Phase 7 (`df3dd00`, approved).

**TM decisions applied:**
- **Interest Option A.** Only the principal consumes the credit line. Interest is `floor(creditAmount × rate / 100)` in whole rials and is spread evenly; any remainder goes to the last installment.
- **Doc names:** `docs/phase-8-deliverable.md` and `docs/phase-8-verification.md`.

**Active credit provider in this environment:** `SANDBOX_BANK`, taken from the DB (`credit_providers` + `system_configs.credits.activeProvider`).
- It is a **development/test provider**. No real credit is granted and no money moves. The API marks it `isSandbox: true`, and the registry logs this on use.
- **No real bank adapter is implemented;** see §9.
- The card part of HYBRID and installment repayments go through the Phase 7 IPG. The IPG here is also `sandbox`.

---

## 1. Module layout

```
apps/backend/src/modules/
├── credit/                                        credit line: providers, ledger, applications, staff views
│   ├── providers/
│   │   ├── credit-provider.interface.ts           CreditProviderAdapter contract (inquireEligibility, submitApplication,
│   │   │                                          reserveCredit, commitCredit, releaseCredit) + CreditProviderError
│   │   ├── credit-provider.registry.ts            resolves the adapter dynamically from DB (credit_providers row +
│   │   │                                          credits.activeProvider) — assertEnabled / requireActiveProvider / adapterFor
│   │   ├── sandbox-bank.provider.ts               SANDBOX_BANK: deterministic score, instant decision, Redis reservations
│   │   └── sandbox-bank.provider.spec.ts
│   ├── installment-math.ts (+ spec)               schedule calculator: principal/interest split, Tehran calendar dates, +30 days
│   ├── credit-math.ts (+ spec)                    payment split (BANK_CREDIT / HYBRID), invariant check, ledger replay
│   ├── credit-ledger.service.ts                   the ONLY writer of credit balances + credit_transactions (row lock)
│   ├── credit-order.service.ts                    commit credit + write the schedule for an order; release open reservations
│   ├── credit.service.ts                          POST credit/applications, GET credit/account, GET credit/plans
│   ├── admin-credit.service.ts                    staff lists + aggregated exposure
│   ├── credit-views.ts, dto/credit.dto.ts
│   ├── credit.controller.ts                       credit/applications, credit/account, credit/plans
│   ├── admin-credit.controller.ts                 admin/credit/applications, admin/credit/accounts
│   └── credit.module.ts
└── bnpl/                                          buy-now-pay-later flows on top of credit + payments
    ├── credit-checkout.service.ts                 POST payments/credit/initiate (BANK_CREDIT completes, HYBRID → IPG)
    ├── installments.service.ts                    list grouped by order, pay one installment via IPG, markOverdue
    ├── installment-overdue.scheduler.ts           periodic PENDING → OVERDUE sweep (Redis lock, unref'd interval)
    ├── credit-payments.controller.ts              payments/credit/initiate
    ├── installments.controller.ts                 credit/installments, credit/installments/:id/pay
    ├── dto/bnpl.dto.ts
    └── bnpl.module.ts
```

**Changed files (Phases 6 and 7):**

- `payments/payments.service.ts`:
  - The callback now dispatches on `purpose`:
    - `ORDER_CHECKOUT` → `applyCheckout`. For HYBRID it checks that the reservation is still HELD, commits the credit, writes the schedule, then runs `applyPaymentLocked` and releases the other open reservations.
    - `INSTALLMENT_REPAYMENT` → `applyRepayment`.
  - When the gateway fails at session start, a held reservation is released and the API returns 502.
- `payments/dto/payment.dto.ts`, `payments/gateway/payment-gateway.interface.ts`, `payments/payments.module.ts`.
- `orders/order-lifecycle.service.ts`:
  - `closeUnpaid` (customer cancel and expiry) releases the credit reservation of any in-flight HYBRID attempt.
  - Cancel or refund of a credit-funded order is refused with `CREDIT_ORDER_REFUND_UNSUPPORTED` (see §9).
- `orders/order-audit.ts`, `orders/orders.module.ts`.
- `financial/financial.service.ts`, `financial/dto/financial.dto.ts`:
  - `collectedByGateway` counts only order-checkout cash;
  - new fields `fundedByCredit` and `installmentsCollected`.
- `wallet/wallet-ledger.service.ts`, `wallet/wallet-math.ts` get the Decimal fix described in §8.
- `config/env.validation.ts`, `.env.example`, `app.module.ts`, `setup/app.setup.ts` (Swagger tags), `prisma/schema.prisma`, `prisma/seed.ts`.
- Tests:
  - `test/credit.e2e-spec.ts` is new.
  - `test/finance.e2e-spec.ts`: the collected aggregate is purpose-filtered.
  - `test/schema-integrity.e2e-spec.ts`: the Phase 2 fixture payment now has the Phase 8 HYBRID shape.
  - `test/seed.e2e-spec.ts`: `credit.enabled` is now `true`.

## 2. Endpoints (`/api/v1`)

| Method | Path | Roles | Purpose |
|---|---|---|---|
| GET | `credit/plans` | public | Active plans of the active provider; `creditEnabled` and provider info (`isSandbox`) |
| POST | `credit/applications` | CUSTOMER | `{requestedLimit, nationalCode, providerCode}`: checksum-validated national code, eligibility inquiry, application. The sandbox approves instantly → CreditAccount + `CREDIT_ALLOCATION` |
| GET | `credit/account` | CUSTOMER | totalLimit, used, reserved, available, status, provider, outstanding installments (404 without an account) |
| POST | `payments/credit/initiate` | CUSTOMER | `{parentOrderId, planId, paymentMethod: BANK_CREDIT\|HYBRID}` |
| GET | `credit/installments` | CUSTOMER | Installments grouped by order, with PENDING / PAID / OVERDUE, remaining totals and overdue counts |
| POST | `credit/installments/:id/pay` | CUSTOMER | Opens an IPG payment for the installment's amount due; returns `{paymentId, amount, installmentNumber, gatewayName, redirectUrl}` |
| GET | `admin/credit/applications` | FINANCIAL_OFFICER, ADMIN, SUPER_ADMIN | Paginated, with filters (`status`, `userId`, …); national codes masked `******1234` |
| GET | `admin/credit/accounts` | FINANCIAL_OFFICER, ADMIN, SUPER_ADMIN | Paginated accounts + aggregated exposure (limits, used, reserved, available, outstanding installments) |

**Error codes:**

| Status | Codes |
|---|---|
| 400 | validation errors; `INSTALLMENT_PLAN_NOT_AVAILABLE` |
| 409 | `ORDER_NOT_PAYABLE`, `ORDER_PAYMENT_EXPIRED`, `CREDIT_ACCOUNT_REQUIRED`, `CREDIT_ACCOUNT_NOT_ACTIVE`, `CREDIT_ACCOUNT_EXPIRED`, `INSUFFICIENT_CREDIT`, `HYBRID_NOT_REQUIRED`, `AMOUNT_NOT_WHOLE_RIALS`, `INSTALLMENT_NOT_PAYABLE`, `CREDIT_ORDER_REFUND_UNSUPPORTED`, plus duplicate-account and national-code conflicts |
| 429 | application quota (5/day) or too many open payment attempts |
| 502 | `CREDIT_PROVIDER_UNAVAILABLE` / `GATEWAY_UNAVAILABLE` |
| 503 | `CREDIT_DISABLED` (`credit.enabled != true`) |

## 3. Checkout flows

**Payment split (`credit-math.splitPayment`):**
- `CASH_IPG` is 100% cash (the Phase 7 route, unchanged).
- `BANK_CREDIT` is 100% credit and is allowed only if `available ≥ finalPayableAmount`.
- `HYBRID` uses `creditAmount = floor(available)` and `cashAmount = payable − creditAmount`. It is refused if the credit alone covers the order (`HYBRID_NOT_REQUIRED`) or if nothing is available.

**BANK_CREDIT is synchronous.**
1. The adapter's `reserveCredit` is called first.
2. Then one DB transaction runs:
   - lock parent order → credit account → stock → wallets;
   - ledger `PURCHASE_RESERVE_HOLD` + `PURCHASE_COMMIT`;
   - SUCCESSFUL Payment (`gatewayName` = provider code, cash 0);
   - installment schedule;
   - order PAID, packages `PENDING_APPROVAL`, stock committed, vendor escrow funded.
3. After the commit, the adapter's `commitCredit` is called.
4. If the transaction fails, the adapter's `releaseCredit` is called.
5. Response: `{status:"COMPLETED", orderNumber, …schedule}`. A concurrent second submission gets 409, and its reservation is released.

**HYBRID is asynchronous.**
1. Reserve with the adapter.
2. In one transaction: ledger `PURCHASE_RESERVE_HOLD` and an INITIATED Payment with `creditAmount`, `cashAmount`, `creditReservationRef` and `installmentPlanId`.
3. Open the IPG session and return `{status:"IPG_REQUIRED", redirectUrl, cashAmount, creditAmount, gatewayName, paymentExpiresAt}`.
4. The callback:
   - **verified:** commit the credit and write the schedule, then run the Phase 7 `applyPaymentLocked` (PAID, escrow, stock) in the same transaction;
   - **failed or declined:** `RESERVATION_RELEASE`; the order stays payable.
5. **"Timeout"** is the order's payment window (`ORDER_PAYMENT_TIMEOUT_MINUTES`).
   - Expiry or customer cancel → `closeUnpaid` releases the reservation.
   - A capture that arrives after that is flagged `PAID_REQUIRES_REFUND` / `requiresManualRefund`, and the credit is never re-used.

## 4. Credit ledger and invariant

- **Invariant:** `totalLimit = used + reserved + available`, all amounts ≥ 0. It is enforced **in the DB** by the CHECK `credit_accounts_limit_invariant`, and also in code.
- Every balance change writes exactly one `credit_transactions` row:

| Type | Effect | `referenceCode` |
|---|---|---|
| `CREDIT_ALLOCATION` | total += L, available += L | application id |
| `PURCHASE_RESERVE_HOLD` | available −= A, reserved += A | reservation ref |
| `PURCHASE_COMMIT` | reserved −= A, used += A | reservation ref |
| `RESERVATION_RELEASE` | reserved −= A, available += A | reservation ref |
| `INSTALLMENT_REPAYMENT_RESTORE` | used −= principal, available += principal | installment id |

- `balanceAfter` is the available balance after the movement.
- Idempotency is enforced by unique indexes:
  - `(type, reference_code)`;
  - one COMMIT **or** RELEASE per reservation (partial unique);
  - one payment per `credit_reservation_ref`.
- `credit-math.replayCreditLedger` rebuilds the balances from the ledger. The e2e suite checks that the replay equals the stored row for every account.

## 5. Installment calculator (`installment-math.ts`)

- **Principal:** `floor(credit / n)` for each installment; the remainder goes to the last one, so Σ principal = creditAmount exactly.
- **Interest (Option A):** `floor(credit × rate / 100)` in total, split the same way.
- **Due dates:** Tehran calendar date of the purchase + 30·k days (k = 1..n), stored as `DATE`.
- **Worked example (6,450,000, 6 months, 9%):** principal 1,075,000 × 6; interest 580,500 → 96,750 × 6; total per installment 1,171,750.

## 6. Installments and repayment

- **Overdue:** an installment becomes OVERDUE when its due date is before today (Tehran). It stays PENDING on the due date itself.
  - `InstallmentOverdueScheduler` sweeps every `INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS` (default 3600) under a Redis lock. The same logic is exercised directly in e2e.
- **Repayment:** `POST credit/installments/:id/pay` creates an `INSTALLMENT_REPAYMENT` payment for `totalAmount` (principal + interest) and redirects to the IPG.
  - On the verified callback, in one transaction: installment PAID + `paidAt`; `used −= principal`, `available += principal`; `INSTALLMENT_REPAYMENT_RESTORE`.
  - A declined payment leaves the installment payable. PENDING and OVERDUE installments are both payable; there is no late penalty yet (see §9).

## 7. Configuration

| Key | Where | Default | Meaning |
|---|---|---|---|
| `credit.enabled` | `system_configs` | `true` (seed) | Master switch; `false` → plans empty, credit operations 503 |
| `credits.activeProvider` | `system_configs` | `SANDBOX_BANK` | Code of the active `credit_providers` row |
| `credit_providers.config` (SANDBOX_BANK) | DB | `minApprovalScore` 600, `minRequestedLimit` 10,000,000, `maxApprovedLimit` 500,000,000 (IRR) | Sandbox decision rules; an invalid config → `PROVIDER_MISCONFIGURED` |
| installment plans | `installment_plans` (seed) | 3 m 0% · 6 m 9% · 12 m 18% (penalty 2%/month, not applied yet) | Offered plans |
| `INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS` | env | 3600 | Overdue sweep interval |

**Sandbox decision rules:**
- **Score:** `300 + sha256("shopino-sandbox-credit:" + nationalCode) mod 551`, which is deterministic.
- **Eligibility:** eligible if score ≥ `minApprovalScore`.
- **Decision:** a requested limit below `minRequestedLimit` is REJECTED; otherwise it is APPROVED at `min(requested, maxApprovedLimit)`.
- **Reservations:** stored in Redis under `credit:sandbox:reservation:<SBXR-…>` with state HELD, COMMITTED or RELEASED.

## 8. Schema changes (migration `20260930090000_phase8_credit`)

- **New enum:** `PaymentPurpose` (`ORDER_CHECKOUT`, `INSTALLMENT_REPAYMENT`).
- **New `payments` columns:** `purpose`, `payment_method`, `credit_account_id`, `installment_plan_id`, `credit_reservation_ref`, `installment_schedule_id`. They have FKs with `Restrict` and indexes.
- **New `credit_applications` columns:** `decision_reason`, `decided_at`.
- **CHECKs:**
  - on `credit_accounts`: non-negative amounts and the limit invariant;
  - on `credit_transactions`: amount > 0 and balance_after ≥ 0;
  - on `installment_schedules`: total = principal + interest, number in range, PAID ⇒ paid_at;
  - `installment_plans` terms;
  - on `payments`: method matches split, credit part shape, installment purpose shape.
- **Unique indexes:** `credit_transactions(type, reference_code)`; partial unique on reservation end; partial unique on `payments.credit_reservation_ref`.
- **Decimal fix (also in Phase 7 code):** decimal.js `new Decimal(0).isPositive()` returns **true**. All non-test uses of `isPositive()` / `isNegative()` were replaced by `greaterThan(0)` / `lessThan(0)`. This closes a zero-amount edge case in the Phase 7 wallet code.

## 9. Not done in this phase (stated honestly)

- **No real bank credit provider.** Only `SANDBOX_BANK` is implemented. Adding a bank means writing one `CreditProviderAdapter` and one registry entry; it needs the bank's API contract and credentials. The registry reports any other provider code as not implemented.
- **Cancel/refund of credit-funded orders is refused** (409 `CREDIT_ORDER_REFUND_UNSUPPORTED`). A reverse credit flow (restore principal, cancel schedules, refund the cash part) needs a TM decision.
- **Late penalty is not applied.** `penaltyRatePercentPerMonth` is stored and shown, but overdue installments are payable at their original amount.
- **No calculator preview endpoint.** The schedule is calculated at checkout, and plans expose rate and duration. A `GET credit/plans/:id/preview?amount=` can be added on request.
- **Documents in `submitApplication`** are passed through to the adapter; the sandbox ignores them. There is no upload flow for credit documents.
- **No reconcile job** for INITIATED HYBRID or repayment payments whose callback never arrives. Expiry still releases the credit, as in Phase 7.
- **No frontend pages** (backend phase).

## 10. Complete source files

New files are listed in full. For changed files the full current content is listed; the exact diff against `df3dd00` follows in §11.

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

# ─── Phase 8: BNPL instalments ───────────────────────────────────────────────
# How often due instalments are marked OVERDUE (seconds; 0 disables the timer).
INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=3600
```

### `apps/backend/prisma/migrations/20260930090000_phase8_credit/migration.sql`

```sql
-- Phase 8: banking credit engine, BNPL instalments and hybrid (credit + card) payments.
--
-- Only a new enum *type* is created here (usable in the same migration); no
-- value is added to an existing enum.

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('ORDER_CHECKOUT', 'INSTALLMENT_REPAYMENT');

-- AlterTable
ALTER TABLE "credit_applications" ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "decision_reason" VARCHAR(120);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "credit_account_id" UUID,
ADD COLUMN     "credit_reservation_ref" VARCHAR(80),
ADD COLUMN     "installment_plan_id" UUID,
ADD COLUMN     "installment_schedule_id" UUID,
ADD COLUMN     "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CASH_IPG',
ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL DEFAULT 'ORDER_CHECKOUT';

-- CreateIndex
CREATE INDEX "payments_installment_schedule_id_status_idx" ON "payments"("installment_schedule_id", "status");

-- CreateIndex
CREATE INDEX "payments_credit_account_id_idx" ON "payments"("credit_account_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_installment_plan_id_fkey" FOREIGN KEY ("installment_plan_id") REFERENCES "installment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_installment_schedule_id_fkey" FOREIGN KEY ("installment_schedule_id") REFERENCES "installment_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity rules the Prisma schema language cannot express ───────────────

-- Credit invariant, enforced by the database on every write:
--   totalLimit = usedAmount + reservedAmount + availableAmount, all ≥ 0.
ALTER TABLE "credit_accounts"
  ADD CONSTRAINT "credit_accounts_amounts_non_negative" CHECK (
    "total_limit" >= 0 AND "used_amount" >= 0 AND "reserved_amount" >= 0 AND "available_amount" >= 0
  ),
  ADD CONSTRAINT "credit_accounts_limit_invariant" CHECK (
    "total_limit" = "used_amount" + "reserved_amount" + "available_amount"
  );

-- A credit movement always moves money; the direction is carried by the type.
ALTER TABLE "credit_transactions"
  ADD CONSTRAINT "credit_transactions_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "credit_transactions_balance_after_non_negative" CHECK ("balance_after" >= 0);

-- Idempotency: one allocation per application, one hold / commit / release per
-- reservation, one repayment restore per instalment …
CREATE UNIQUE INDEX "credit_transactions_type_reference_key"
  ON "credit_transactions"("type", "reference_code");

-- … and a reservation ends exactly once: committed XOR released.
CREATE UNIQUE INDEX "credit_transactions_reservation_end_key"
  ON "credit_transactions"("reference_code")
  WHERE "type" IN ('PURCHASE_COMMIT', 'RESERVATION_RELEASE');

-- Instalment rows are whole rials (Iranian banking has no fractional unit) and
-- total = principal + interest.
ALTER TABLE "installment_schedules"
  ADD CONSTRAINT "installment_schedules_amounts_valid" CHECK (
    "principal_amount" >= 0 AND "interest_amount" >= 0 AND "penalty_amount" >= 0 AND "paid_amount" >= 0
    AND "total_amount" = "principal_amount" + "interest_amount"
    AND "principal_amount" = TRUNC("principal_amount") AND "interest_amount" = TRUNC("interest_amount")
  ),
  ADD CONSTRAINT "installment_schedules_number_in_range" CHECK (
    "installment_number" >= 1 AND "installment_number" <= "total_installments"
  ),
  ADD CONSTRAINT "installment_schedules_paid_has_paid_at" CHECK ("status" <> 'PAID' OR "paid_at" IS NOT NULL);

ALTER TABLE "installment_plans"
  ADD CONSTRAINT "installment_plans_terms_valid" CHECK (
    "duration_months" BETWEEN 1 AND 60 AND "interest_rate_percent" >= 0 AND "penalty_rate_percent_per_month" >= 0
  );

-- One reservation belongs to one payment attempt.
CREATE UNIQUE INDEX "payments_credit_reservation_ref_key"
  ON "payments"("credit_reservation_ref")
  WHERE "credit_reservation_ref" IS NOT NULL;

-- Shape of a payment by purpose and method.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_installment_purpose_shape" CHECK (
    ("purpose" = 'INSTALLMENT_REPAYMENT') = ("installment_schedule_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "payments_credit_part_shape" CHECK (
    ("credit_amount" > 0) = ("credit_account_id" IS NOT NULL AND "credit_reservation_ref" IS NOT NULL AND "installment_plan_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "payments_method_matches_split" CHECK (
    ("payment_method" = 'CASH_IPG' AND "credit_amount" = 0)
    OR ("payment_method" = 'BANK_CREDIT' AND "credit_amount" > 0 AND "cash_amount" = 0)
    OR ("payment_method" = 'HYBRID' AND "credit_amount" > 0 AND "cash_amount" > 0)
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

### `apps/backend/prisma/seed.ts`

```ts
/**
 * Deterministic master-data seed.
 *
 * Run with:  pnpm db:seed      (turbo → @shopino/backend → prisma/seed.ts)
 * Reset:     pnpm db:reset     (drops the schema, re-applies migrations, re-seeds)
 *
 * Purpose: after a development volume is wiped, or on a brand-new environment,
 * one command restores the data the platform cannot operate without — staff
 * accounts, a verified vendor with a real catalogue, the category tree with its
 * commission rates, the credit provider portfolio and the system configuration.
 *
 * Properties, by design:
 *   • Deterministic    — the same input always produces the same rows; every
 *                        entity is addressed by a stable natural key
 *                        (mobile / slug / sku / provider code / config key).
 *   • Idempotent       — running it any number of times leaves the same state;
 *                        safe to execute on every deploy.
 *   • Non-destructive  — existing rows are corrected, never deleted, and user
 *                        passwords are never rotated unless the corresponding
 *                        SEED_RESET_*_PASSWORD flag is set explicitly.
 *   • No fabricated financial data — no wallet balance, no credit line, no order
 *                        and no payment is invented here. Those rows are created
 *                        by the real business flows (checkout, settlement,
 *                        credit decision) and by nothing else.
 *
 * Credentials come from the environment; no secret is hard-coded. Passwords are
 * hashed with Argon2id before they reach the database.
 */
import { ConfigValueType, PrismaClient, UserRole, VendorStatus, type CreditProvider } from '@prisma/client';
import type { PrismaClient as PrismaClientInstance } from '@prisma/client';
import { hashPassword } from '../src/infra/security/password';

// ─── Seed inputs ─────────────────────────────────────────────────────────────

export interface SeedSummary {
  users: { created: string[]; updated: number };
  categories: { upserted: number; roots: number };
  vendor: { slug: string; created: boolean; products: number; variants: number };
  credit: { providers: number; plans: number };
  configs: number;
}

interface SeedUser {
  /**
   * Stable natural key — unique in the database.
   *
   * Stored in canonical E.164 (`+989XXXXXXXXX`) because that is the single format
   * the authentication layer reads and writes: the login flow normalizes every
   * input to it, and the unique index on `users.mobile` would not catch a number
   * registered under two different spellings. `09…` is presentation only.
   */
  mobile: string;
  email: string;
  fullName: string;
  role: UserRole;
  /** Environment variable holding the password; absent for non-login accounts. */
  passwordEnv?: string;
  resetPasswordEnv?: string;
}

const STAFF_USERS: readonly SeedUser[] = [
  {
    mobile: '+989120000001',
    email: 'admin@shopino.local',
    fullName: 'مدیر ارشد پلتفرم',
    role: UserRole.SUPER_ADMIN,
    passwordEnv: 'SUPER_ADMIN_PASSWORD',
    resetPasswordEnv: 'SEED_RESET_ADMIN_PASSWORD',
  },
  {
    mobile: '+989120000002',
    email: 'support@shopino.local',
    fullName: 'کارشناس پشتیبانی',
    role: UserRole.SUPPORT,
    passwordEnv: 'SEED_STAFF_PASSWORD',
  },
  {
    mobile: '+989120000003',
    email: 'finance@shopino.local',
    fullName: 'کارشناس مالی',
    role: UserRole.FINANCIAL_OFFICER,
    passwordEnv: 'SEED_STAFF_PASSWORD',
  },
];

/** Owner account of the sample vendor shop. */
const VENDOR_OWNER: SeedUser = {
  mobile: '+989120000010',
  email: 'vendor@shopino.local',
  fullName: 'مدیر فروشگاه نمونه',
  role: UserRole.VENDOR,
  passwordEnv: 'SEED_VENDOR_PASSWORD',
};

interface CategorySeed {
  slug: string;
  titleFa: string;
  titleEn: string;
  /** Platform commission for products in this category, in percent. */
  defaultCommissionRate: string;
  sortOrder: number;
  children: Omit<CategorySeed, 'children'>[];
}

/** Baseline taxonomy and the commission the platform charges per category. */
const CATEGORY_TREE: readonly CategorySeed[] = [
  {
    slug: 'digital',
    titleFa: 'کالای دیجیتال',
    titleEn: 'Digital Goods',
    defaultCommissionRate: '8.00',
    sortOrder: 10,
    children: [
      { slug: 'mobile', titleFa: 'گوشی موبایل', titleEn: 'Mobile Phones', defaultCommissionRate: '5.00', sortOrder: 10 },
      { slug: 'laptop', titleFa: 'لپ‌تاپ و کامپیوتر', titleEn: 'Laptops & Computers', defaultCommissionRate: '6.00', sortOrder: 20 },
      { slug: 'digital-accessories', titleFa: 'لوازم جانبی دیجیتال', titleEn: 'Digital Accessories', defaultCommissionRate: '12.00', sortOrder: 30 },
    ],
  },
  {
    slug: 'home-kitchen',
    titleFa: 'خانه و آشپزخانه',
    titleEn: 'Home & Kitchen',
    defaultCommissionRate: '10.00',
    sortOrder: 20,
    children: [
      { slug: 'home-appliances', titleFa: 'لوازم خانگی', titleEn: 'Home Appliances', defaultCommissionRate: '7.00', sortOrder: 10 },
      { slug: 'kitchenware', titleFa: 'ظروف و لوازم آشپزخانه', titleEn: 'Kitchenware', defaultCommissionRate: '15.00', sortOrder: 20 },
    ],
  },
  {
    slug: 'fashion',
    titleFa: 'مد و پوشاک',
    titleEn: 'Fashion',
    defaultCommissionRate: '14.00',
    sortOrder: 30,
    children: [
      { slug: 'mens-clothing', titleFa: 'پوشاک مردانه', titleEn: "Men's Clothing", defaultCommissionRate: '14.00', sortOrder: 10 },
      { slug: 'womens-clothing', titleFa: 'پوشاک زنانه', titleEn: "Women's Clothing", defaultCommissionRate: '14.00', sortOrder: 20 },
      { slug: 'bags-shoes', titleFa: 'کیف و کفش', titleEn: 'Bags & Shoes', defaultCommissionRate: '16.00', sortOrder: 30 },
    ],
  },
  {
    slug: 'beauty-health',
    titleFa: 'زیبایی و سلامت',
    titleEn: 'Beauty & Health',
    defaultCommissionRate: '13.00',
    sortOrder: 40,
    children: [
      { slug: 'skincare', titleFa: 'مراقبت از پوست', titleEn: 'Skincare', defaultCommissionRate: '13.00', sortOrder: 10 },
      { slug: 'personal-care', titleFa: 'بهداشت شخصی', titleEn: 'Personal Care', defaultCommissionRate: '11.00', sortOrder: 20 },
    ],
  },
  {
    slug: 'supermarket',
    titleFa: 'سوپرمارکت',
    titleEn: 'Supermarket',
    defaultCommissionRate: '9.00',
    sortOrder: 50,
    children: [
      { slug: 'food-beverage', titleFa: 'خواروبار و نوشیدنی', titleEn: 'Food & Beverage', defaultCommissionRate: '9.00', sortOrder: 10 },
      { slug: 'dairy', titleFa: 'لبنیات', titleEn: 'Dairy', defaultCommissionRate: '6.00', sortOrder: 20 },
    ],
  },
  {
    slug: 'books-stationery',
    titleFa: 'کتاب و لوازم‌التحریر',
    titleEn: 'Books & Stationery',
    defaultCommissionRate: '10.00',
    sortOrder: 60,
    children: [
      { slug: 'books', titleFa: 'کتاب', titleEn: 'Books', defaultCommissionRate: '10.00', sortOrder: 10 },
    ],
  },
];

interface VariantSeed {
  sku: string;
  colorName?: string;
  colorHex?: string;
  size?: string;
  guarantee?: string;
  price: string;
  compareAtPrice?: string;
  stockQuantity: number;
  weightGrams?: number;
}

interface MediaSeed {
  url: string;
  thumbnailUrl?: string;
  isPrimary: boolean;
  sortOrder: number;
}

interface ProductSeed {
  slug: string;
  title: string;
  description: string;
  brand: string;
  basePrice: string;
  categorySlug: string;
  isPublished: boolean;
  media: MediaSeed[];
  variants: VariantSeed[];
}

/**
 * Catalogue of the sample vendor. Prices are the real catalogue values the shop
 * sells at — the seed does not invent promotional numbers, and no stock figure
 * here is a placeholder for a database-backed counter.
 */
const VENDOR_PRODUCTS: readonly ProductSeed[] = [
  {
    slug: 'shopino-sample-smartphone-x1',
    title: 'گوشی موبایل نمونه X1',
    description: 'گوشی هوشمند با نمایشگر ۶.۷ اینچی، حافظهٔ ۲۵۶ گیگابایت و دوربین سه‌گانه.',
    brand: 'Shopino Sample',
    basePrice: '42500000.00',
    categorySlug: 'mobile',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-smartphone-x1/front.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-smartphone-x1/front-thumb.jpg', isPrimary: true, sortOrder: 10 },
      { url: 'https://cdn.shopino.local/products/sample-smartphone-x1/back.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-smartphone-x1/back-thumb.jpg', isPrimary: false, sortOrder: 20 },
    ],
    variants: [
      { sku: 'SHP-X1-256-BLK', colorName: 'مشکی', colorHex: '#111827', guarantee: '۱۸ ماه گارانتی شرکتی', price: '42500000.00', compareAtPrice: '45000000.00', stockQuantity: 12, weightGrams: 202 },
      { sku: 'SHP-X1-256-BLU', colorName: 'آبی', colorHex: '#1D4ED8', guarantee: '۱۸ ماه گارانتی شرکتی', price: '42900000.00', compareAtPrice: '45000000.00', stockQuantity: 7, weightGrams: 202 },
    ],
  },
  {
    slug: 'shopino-sample-laptop-pro14',
    title: 'لپ‌تاپ نمونه پرو ۱۴ اینچ',
    description: 'لپ‌تاپ ۱۴ اینچی با پردازندهٔ نسل جدید، ۱۶ گیگابایت رم و حافظهٔ SSD یک ترابایتی.',
    brand: 'Shopino Sample',
    basePrice: '78900000.00',
    categorySlug: 'laptop',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-laptop-pro14/main.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-laptop-pro14/main-thumb.jpg', isPrimary: true, sortOrder: 10 },
    ],
    variants: [
      { sku: 'SHP-PRO14-16-1T-SLV', colorName: 'نقره‌ای', colorHex: '#D1D5DB', guarantee: '۲۴ ماه گارانتی بین‌المللی', price: '78900000.00', stockQuantity: 5, weightGrams: 1450 },
      { sku: 'SHP-PRO14-16-1T-GRY', colorName: 'خاکستری', colorHex: '#4B5563', guarantee: '۲۴ ماه گارانتی بین‌المللی', price: '79900000.00', stockQuantity: 3, weightGrams: 1450 },
    ],
  },
  {
    slug: 'shopino-sample-cotton-tshirt',
    title: 'تی‌شرت نخی نمونه',
    description: 'تی‌شرت پنبه‌ای با دوخت صنعتی، مناسب استفادهٔ روزمره.',
    brand: 'Shopino Sample',
    basePrice: '890000.00',
    categorySlug: 'mens-clothing',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-cotton-tshirt/white.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-cotton-tshirt/white-thumb.jpg', isPrimary: true, sortOrder: 10 },
    ],
    variants: [
      { sku: 'SHP-TSHIRT-WHT-L', colorName: 'سفید', colorHex: '#FFFFFF', size: 'L', price: '890000.00', compareAtPrice: '1150000.00', stockQuantity: 40, weightGrams: 180 },
      { sku: 'SHP-TSHIRT-WHT-XL', colorName: 'سفید', colorHex: '#FFFFFF', size: 'XL', price: '890000.00', compareAtPrice: '1150000.00', stockQuantity: 25, weightGrams: 195 },
      { sku: 'SHP-TSHIRT-BLK-L', colorName: 'مشکی', colorHex: '#111827', size: 'L', price: '920000.00', stockQuantity: 18, weightGrams: 180 },
    ],
  },
];

const SAMPLE_VENDOR = {
  storeSlug: 'shopino-sample-store',
  storeName: 'فروشگاه نمونه شاپینو',
  instagramHandle: 'shopino.sample',
  bio: 'فروشگاه نمونهٔ پلتفرم با کاتالوگ واقعی برای توسعه و تست جریان‌های خرید.',
  bankIban: 'IR620170000000000000000001',
};

interface CreditProviderSeed {
  code: string;
  name: string;
  isActive: boolean;
  config: Record<string, string>;
  plans: { durationMonths: number; title: string; interestRatePercent: string; penaltyRatePercentPerMonth: string }[];
}

/**
 * Credit portfolio. Only the sandbox provider is active in development; the real
 * banks are seeded as inactive so that switching provider is a configuration
 * change (`credits.activeProvider` / provider row) rather than a code change.
 */
const CREDIT_PROVIDERS: readonly CreditProviderSeed[] = [
  {
    code: 'SANDBOX_BANK',
    name: 'بانک آزمایشی (Sandbox)',
    isActive: true,
    config: {
      environment: 'sandbox',
      baseUrl: 'https://sandbox.credit.local/api/v1',
      merchantId: 'shopino-sandbox-merchant',
      // Simulation rules of the development-only SandboxBankProvider (Phase 8):
      // approve when the simulated score (derived from the national code) is at
      // least minApprovalScore and the requested limit is at least
      // minRequestedLimit; the approved limit is capped at maxApprovedLimit.
      // Whole rials. Not business data of any real bank.
      minApprovalScore: '600',
      minRequestedLimit: '10000000',
      maxApprovedLimit: '500000000',
    },
    plans: [
      { durationMonths: 3, title: 'خرید اعتباری ۳ ماهه (بدون سود)', interestRatePercent: '0.00', penaltyRatePercentPerMonth: '2.00' },
      { durationMonths: 6, title: 'خرید اعتباری ۶ ماهه', interestRatePercent: '9.00', penaltyRatePercentPerMonth: '2.00' },
      { durationMonths: 12, title: 'خرید اعتباری ۱۲ ماهه', interestRatePercent: '18.00', penaltyRatePercentPerMonth: '2.50' },
    ],
  },
  {
    code: 'SAMAN_BANK',
    name: 'بانک سامان',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
  {
    code: 'BLUBANK',
    name: 'بلوبانک',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
  {
    code: 'DIGIPAY',
    name: 'دیجی‌پی',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
];

interface ConfigSeed {
  key: string;
  value: string;
  valueType: ConfigValueType;
  description: string;
}

/**
 * Baseline platform configuration. The BNPL flow exists since Phase 8, so
 * `credit.enabled` is true; `credits.activeProvider` names the sandbox
 * explicitly so the active (development-only) provider is always visible in
 * configuration. Production must point it at a real bank integration.
 */
const SYSTEM_CONFIGS: readonly ConfigSeed[] = [
  { key: 'platform.name', value: 'شاپینو', valueType: ConfigValueType.STRING, description: 'نام نمایشی پلتفرم' },
  { key: 'platform.currency', value: 'IRR', valueType: ConfigValueType.STRING, description: 'کد ارز پایه پلتفرم (ISO 4217)' },
  { key: 'platform.locale', value: 'fa-IR', valueType: ConfigValueType.STRING, description: 'زبان و قالب پیش‌فرض رابط کاربری' },
  { key: 'platform.timezone', value: 'Asia/Tehran', valueType: ConfigValueType.STRING, description: 'منطقهٔ زمانی مرجع برای گزارش‌ها و تسویه' },
  { key: 'credit.enabled', value: 'true', valueType: ConfigValueType.BOOLEAN, description: 'فعال بودن خرید اعتباری (BNPL). با false هیچ درخواست اعتبار یا خرید اعتباری جدیدی پذیرفته نمی‌شود.' },
  { key: 'credits.activeProvider', value: 'SANDBOX_BANK', valueType: ConfigValueType.STRING, description: 'کد ارائه‌دهندهٔ اعتبار فعال در محیط جاری' },
  { key: 'commerce.defaultCommissionRate', value: '12.00', valueType: ConfigValueType.NUMBER, description: 'نرخ کمیسیون پیش‌فرض پلتفرم (درصد) وقتی دسته‌بندی نرخ اختصاصی ندارد' },
  { key: 'commerce.escrowHoldDays', value: '7', valueType: ConfigValueType.NUMBER, description: 'مدت نگه‌داری وجه در حساب امانی پس از تحویل (روز)' },
  { key: 'commerce.settlementMinimumAmount', value: '5000000.00', valueType: ConfigValueType.NUMBER, description: 'حداقل مبلغ قابل درخواست تسویه (ریال)' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. Add it to the root .env (see .env.example) — the seed is not allowed to invent credentials.`,
    );
  }
  return value;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseBooleanFlag(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

// ─── Seed sections ───────────────────────────────────────────────────────────

async function seedUsers(
  prisma: PrismaClientInstance,
): Promise<{ created: string[]; updated: number }> {
  const created: string[] = [];
  let updated = 0;

  for (const user of [...STAFF_USERS, VENDOR_OWNER]) {
    const email = normalizeEmail(user.email);
    const existing = await prisma.user.findUnique({ where: { mobile: user.mobile } });
    const passwordHash =
      user.passwordEnv === undefined
        ? undefined
        : await hashPassword(requireEnv(user.passwordEnv));
    const resetPassword =
      user.resetPasswordEnv !== undefined && parseBooleanFlag(user.resetPasswordEnv);

    if (existing === null) {
      if (passwordHash === undefined) {
        throw new Error(`${email} has no password source configured; refusing to create a login account without one.`);
      }
      await prisma.user.create({
        data: {
          mobile: user.mobile,
          email,
          fullName: user.fullName,
          role: user.role,
          passwordHash,
          isActive: true,
        },
      });
      created.push(email);
      continue;
    }

    // Repair identity drift (name/role/email) without touching the credential.
    await prisma.user.update({
      where: { mobile: user.mobile },
      data: {
        email,
        fullName: user.fullName,
        role: user.role,
        isActive: true,
        ...(resetPassword && passwordHash !== undefined ? { passwordHash } : {}),
      },
    });
    updated += 1;
  }

  return { created, updated };
}

async function seedCategories(prisma: PrismaClientInstance): Promise<{ upserted: number; roots: number }> {
  let upserted = 0;

  for (const root of CATEGORY_TREE) {
    const parent = await prisma.category.upsert({
      where: { slug: root.slug },
      update: {
        titleFa: root.titleFa,
        titleEn: root.titleEn,
        defaultCommissionRate: root.defaultCommissionRate,
        sortOrder: root.sortOrder,
        isActive: true,
      },
      create: {
        slug: root.slug,
        titleFa: root.titleFa,
        titleEn: root.titleEn,
        defaultCommissionRate: root.defaultCommissionRate,
        sortOrder: root.sortOrder,
        isActive: true,
      },
    });
    upserted += 1;

    for (const child of root.children) {
      await prisma.category.upsert({
        where: { slug: child.slug },
        update: {
          titleFa: child.titleFa,
          titleEn: child.titleEn,
          defaultCommissionRate: child.defaultCommissionRate,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
        create: {
          slug: child.slug,
          titleFa: child.titleFa,
          titleEn: child.titleEn,
          defaultCommissionRate: child.defaultCommissionRate,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
      });
      upserted += 1;
    }
  }

  return { upserted, roots: CATEGORY_TREE.length };
}

async function seedVendor(
  prisma: PrismaClientInstance,
): Promise<{ slug: string; created: boolean; products: number; variants: number }> {
  const owner = await prisma.user.findUniqueOrThrow({ where: { mobile: VENDOR_OWNER.mobile } });

  const existingVendor = await prisma.vendor.findUnique({ where: { storeSlug: SAMPLE_VENDOR.storeSlug } });

  const vendor = await prisma.vendor.upsert({
    where: { storeSlug: SAMPLE_VENDOR.storeSlug },
    update: {
      storeName: SAMPLE_VENDOR.storeName,
      instagramHandle: SAMPLE_VENDOR.instagramHandle,
      bio: SAMPLE_VENDOR.bio,
      bankIban: SAMPLE_VENDOR.bankIban,
      status: VendorStatus.APPROVED,
    },
    create: {
      userId: owner.id,
      storeName: SAMPLE_VENDOR.storeName,
      storeSlug: SAMPLE_VENDOR.storeSlug,
      instagramHandle: SAMPLE_VENDOR.instagramHandle,
      bio: SAMPLE_VENDOR.bio,
      bankIban: SAMPLE_VENDOR.bankIban,
      status: VendorStatus.APPROVED,
      verifiedAt: new Date('2026-01-05T09:00:00.000Z'),
    },
  });

  // A wallet is created when the vendor is approved; balances stay at zero until
  // real sales move them (the seed never fabricates a balance).
  await prisma.vendorWallet.upsert({
    where: { vendorId: vendor.id },
    update: {},
    create: { vendorId: vendor.id },
  });

  // Verification dossier of the approved vendor, keyed by its national card file.
  const nationalCardDocUrl = 'https://cdn.shopino.local/vendor-docs/sample/national-card.jpg';
  const existingVerification = await prisma.vendorVerification.findFirst({
    where: { vendorId: vendor.id, nationalCardDocUrl },
  });
  if (existingVerification === null) {
    await prisma.vendorVerification.create({
      data: {
        vendorId: vendor.id,
        nationalCardDocUrl,
        businessDocUrl: 'https://cdn.shopino.local/vendor-docs/sample/business-license.jpg',
        reviewedAt: new Date('2026-01-05T09:00:00.000Z'),
      },
    });
  }

  let products = 0;
  let variants = 0;

  for (const product of VENDOR_PRODUCTS) {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: product.categorySlug } });

    const row = await prisma.product.upsert({
      where: { slug: product.slug },
      update: {
        title: product.title,
        description: product.description,
        brand: product.brand,
        basePrice: product.basePrice,
        categoryId: category.id,
        vendorId: vendor.id,
        isPublished: product.isPublished,
      },
      create: {
        vendorId: vendor.id,
        categoryId: category.id,
        title: product.title,
        slug: product.slug,
        description: product.description,
        brand: product.brand,
        basePrice: product.basePrice,
        isPublished: product.isPublished,
      },
    });
    products += 1;

    for (const variant of product.variants) {
      await prisma.productVariant.upsert({
        where: { sku: variant.sku },
        update: {
          productId: row.id,
          colorName: variant.colorName ?? null,
          colorHex: variant.colorHex ?? null,
          size: variant.size ?? null,
          guarantee: variant.guarantee ?? null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          stockQuantity: variant.stockQuantity,
          weightGrams: variant.weightGrams ?? null,
          isActive: true,
        },
        create: {
          productId: row.id,
          sku: variant.sku,
          colorName: variant.colorName ?? null,
          colorHex: variant.colorHex ?? null,
          size: variant.size ?? null,
          guarantee: variant.guarantee ?? null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          stockQuantity: variant.stockQuantity,
          weightGrams: variant.weightGrams ?? null,
          isActive: true,
        },
      });
      variants += 1;
    }

    for (const media of product.media) {
      const existingMedia = await prisma.productMedia.findFirst({
        where: { productId: row.id, url: media.url },
      });
      if (existingMedia === null) {
        await prisma.productMedia.create({
          data: {
            productId: row.id,
            url: media.url,
            thumbnailUrl: media.thumbnailUrl ?? null,
            isPrimary: media.isPrimary,
            sortOrder: media.sortOrder,
          },
        });
      }
    }
  }

  return {
    slug: vendor.storeSlug,
    created: existingVendor === null,
    products,
    variants,
  };
}

async function seedCreditPortfolio(
  prisma: PrismaClientInstance,
): Promise<{ providers: number; plans: number }> {
  let plans = 0;

  for (const provider of CREDIT_PROVIDERS) {
    const row: CreditProvider = await prisma.creditProvider.upsert({
      where: { code: provider.code },
      update: { name: provider.name, isActive: provider.isActive, config: provider.config },
      create: { code: provider.code, name: provider.name, isActive: provider.isActive, config: provider.config },
    });

    for (const plan of provider.plans) {
      await prisma.installmentPlan.upsert({
        where: { providerId_durationMonths: { providerId: row.id, durationMonths: plan.durationMonths } },
        update: {
          title: plan.title,
          interestRatePercent: plan.interestRatePercent,
          penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth,
          isActive: true,
        },
        create: {
          providerId: row.id,
          title: plan.title,
          durationMonths: plan.durationMonths,
          interestRatePercent: plan.interestRatePercent,
          penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth,
          isActive: true,
        },
      });
      plans += 1;
    }
  }

  return { providers: CREDIT_PROVIDERS.length, plans };
}

async function seedSystemConfigs(prisma: PrismaClientInstance): Promise<number> {
  for (const config of SYSTEM_CONFIGS) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: { value: config.value, valueType: config.valueType, description: config.description },
      create: {
        key: config.key,
        value: config.value,
        valueType: config.valueType,
        description: config.description,
      },
    });
  }
  return SYSTEM_CONFIGS.length;
}

/**
 * Seeds master data. Accepts a PrismaClient so tests and scripts can reuse the
 * exact same logic inside an existing connection or transaction scope.
 */
export async function seedDatabase(prisma: PrismaClientInstance): Promise<SeedSummary> {
  const users = await seedUsers(prisma);
  const categories = await seedCategories(prisma);
  const vendor = await seedVendor(prisma);
  const credit = await seedCreditPortfolio(prisma);
  const configs = await seedSystemConfigs(prisma);

  return { users, categories, vendor, credit, configs };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const summary = await seedDatabase(prisma);
    console.warn(
      `[seed] master data ready\n` +
        `  users          : ${summary.users.created.length} created (${summary.users.created.join(', ') || '—'}), ${summary.users.updated} updated\n` +
        `  categories     : ${summary.categories.upserted} rows (${summary.categories.roots} roots) with commission rates\n` +
        `  vendor         : ${summary.vendor.slug} (${summary.vendor.created ? 'created' : 'updated'}) — ${summary.vendor.products} products, ${summary.vendor.variants} variants\n` +
        `  credit         : ${summary.credit.providers} providers, ${summary.credit.plans} installment plans\n` +
        `  system configs : ${summary.configs} keys`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
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
   * How often PENDING instalments whose due date has passed are marked OVERDUE
   * (seconds; 0 disables the timer, e.g. when a dedicated worker runs it).
   */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(86_400)
  INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS: number = 3600;

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

### `apps/backend/src/modules/bnpl/bnpl.module.ts`

```ts
import { Module } from '@nestjs/common';
import { CreditModule } from '../credit/credit.module';
import { OrdersModule } from '../orders/orders.module';
import { PaymentsModule } from '../payments/payments.module';
import { CreditCheckoutService } from './credit-checkout.service';
import { CreditPaymentsController } from './credit-payments.controller';
import { InstallmentOverdueScheduler } from './installment-overdue.scheduler';
import { InstallmentsController } from './installments.controller';
import { InstallmentsService } from './installments.service';

/** Buy-now-pay-later flows: credit / hybrid checkout and instalment repayment. */
@Module({
  imports: [CreditModule, OrdersModule, PaymentsModule],
  controllers: [CreditPaymentsController, InstallmentsController],
  providers: [CreditCheckoutService, InstallmentsService, InstallmentOverdueScheduler],
})
export class BnplModule {}
```

### `apps/backend/src/modules/bnpl/credit-checkout.service.ts`

```ts
import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, CreditAccountStatus, ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from '../credit/credit-ledger.service';
import { splitPayment } from '../credit/credit-math';
import { CreditOrderService, type ProviderFollowUp, type ScheduleSummary } from '../credit/credit-order.service';
import { CreditProviderError, type CreditProviderAdapter, type CreditReservation } from '../credit/providers/credit-provider.interface';
import { CreditProviderRegistry } from '../credit/providers/credit-provider.registry';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { MAX_OPEN_ATTEMPTS, PaymentsService } from '../payments/payments.service';
import type { CreditPaymentInitiateResponseDto, InitiateCreditPaymentDto } from './dto/bnpl.dto';

/**
 * Credit and hybrid checkout (TM brief §3–4).
 *
 * Sequence: validate (order PENDING and payable, active account, active plan,
 * split) → provider `reserveCredit` (outside any transaction) → one transaction
 * that locks the parent order, then the credit account, writes the
 * PURCHASE_RESERVE_HOLD row and the Payment. BANK_CREDIT completes in that same
 * transaction: commit (PURCHASE_COMMIT), instalment schedule, order PAID via the
 * shared lifecycle (stock committed, vendor escrow funded, packages
 * PENDING_APPROVAL). HYBRID then opens a bank session for the card part; if the
 * gateway fails (now, or at the callback) the reservation is released.
 *
 * If the transaction fails after the provider reserved, the provider
 * reservation is released immediately (nothing was recorded locally).
 */
@Injectable()
export class CreditCheckoutService {
  private readonly logger = new Logger(CreditCheckoutService.name);
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CreditProviderRegistry,
    private readonly ledger: CreditLedgerService,
    private readonly creditOrders: CreditOrderService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  async initiate(userId: string, dto: InitiateCreditPaymentDto, actor: OrderActor): Promise<CreditPaymentInitiateResponseDto> {
    await this.registry.assertEnabled();
    const now = new Date();
    const order = await this.prisma.parentOrder.findFirst({
      where: { id: dto.parentOrderId, userId },
      select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true, finalPayableAmount: true, user: { select: { mobile: true } } },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    assertPayable(order, now);

    const provider = await this.registry.requireActiveProvider();
    const adapter = this.registry.adapterFor(provider);
    const account = await this.prisma.creditAccount.findUnique({
      where: { userId_providerId: { userId, providerId: provider.id } },
      select: { id: true, status: true, availableAmount: true, expiresAt: true },
    });
    if (!account) {
      throw conflictWith('CREDIT_ACCOUNT_REQUIRED', `You have no credit account with ${provider.code}; apply first`);
    }
    if (account.status !== CreditAccountStatus.ACTIVE) {
      throw conflictWith('CREDIT_ACCOUNT_NOT_ACTIVE', `The credit account is ${account.status}`, { accountStatus: account.status });
    }
    if (account.expiresAt !== null && account.expiresAt <= now) {
      throw conflictWith('CREDIT_ACCOUNT_EXPIRED', 'The credit account has expired', { expiresAt: account.expiresAt });
    }
    const plan = await this.prisma.installmentPlan.findFirst({
      where: { id: dto.planId, providerId: provider.id, isActive: true },
      select: { id: true, title: true, durationMonths: true, interestRatePercent: true },
    });
    if (!plan) {
      throw badRequestWith('INSTALLMENT_PLAN_NOT_AVAILABLE', 'This instalment plan is not offered by the active credit provider');
    }
    const split = splitPayment(dto.paymentMethod, order.finalPayableAmount, account.availableAmount);
    if ('rejected' in split) {
      throw this.rejection(split.rejected, order.finalPayableAmount, account.availableAmount);
    }
    const open = await this.prisma.payment.count({
      where: { parentOrderId: order.id, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(now.getTime() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this order; finish or wait for one of them', this.graceMs / 1000);
    }

    const reservation = await this.reserveAtProvider(adapter, account.id, split.creditAmount, order.id);
    const method = dto.paymentMethod;
    const followUps: ProviderFollowUp[] = [];
    let result: { paymentId: string; schedule: ScheduleSummary | null; orderPaymentStatus: ParentOrderPaymentStatus };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await lockParentOrder(tx, order.id);
        const current = await tx.parentOrder.findUniqueOrThrow({ where: { id: order.id }, select: { paymentStatus: true, paymentExpiresAt: true } });
        assertPayable(current, new Date());
        await this.ledger.hold(tx, account.id, split.creditAmount, reservation.reservationRef, order.id);
        const payment = await tx.payment.create({
          data: {
            parentOrderId: order.id,
            purpose: PaymentPurpose.ORDER_CHECKOUT,
            paymentMethod: method,
            creditAccountId: account.id,
            installmentPlanId: plan.id,
            creditReservationRef: reservation.reservationRef,
            // BANK_CREDIT never touches a card gateway: the "gateway" is the credit provider.
            gatewayName: method === PaymentMethod.BANK_CREDIT ? provider.code : this.payments.gatewayName,
            cashAmount: split.cashAmount,
            creditAmount: split.creditAmount,
            status: PaymentStatus.INITIATED,
            metadata: { stage: 'credit_reserved', provider: provider.code, reservation: reservation.details } as Prisma.InputJsonValue,
          },
          select: { id: true, parentOrderId: true, creditAmount: true, creditAccountId: true, creditReservationRef: true, installmentPlanId: true },
        });
        await writeOrderAudit(tx, actor, {
          action: AuditAction.CREATE,
          entityName: 'Payment',
          entityId: payment.id,
          newValue: {
            parentOrderId: order.id,
            orderNumber: order.orderNumber,
            paymentMethod: method,
            providerCode: provider.code,
            planId: plan.id,
            creditAmount: split.creditAmount.toFixed(2),
            cashAmount: split.cashAmount.toFixed(2),
            creditReservationRef: reservation.reservationRef,
          },
        });
        if (method !== PaymentMethod.BANK_CREDIT) {
          return { paymentId: payment.id, schedule: null, orderPaymentStatus: current.paymentStatus };
        }

        const paidAt = new Date();
        const committed = await this.creditOrders.commitAndScheduleLocked(tx, payment, paidAt);
        followUps.push(committed.followUp);
        const application = await this.lifecycle.applyPaymentLocked(tx, order.id, actor, { paymentId: payment.id, paymentMethod: PaymentMethod.BANK_CREDIT });
        if (!application.applied) {
          throw new Error(`Order ${order.id} was PENDING under lock but the credit payment could not be applied`);
        }
        followUps.push(...(await this.creditOrders.releaseOpenReservationsLocked(tx, order.id, payment.id)));
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESSFUL,
            paidAt,
            metadata: {
              stage: 'credit_committed',
              provider: provider.code,
              reservation: reservation.details,
              schedule: committed.schedule,
              escrowHeld: application.escrowHeld,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await writeOrderAudit(tx, actor, {
          action: AuditAction.PAYMENT_CAPTURE,
          entityName: 'Payment',
          entityId: payment.id,
          oldValue: { status: PaymentStatus.INITIATED },
          newValue: {
            status: PaymentStatus.SUCCESSFUL,
            orderNumber: order.orderNumber,
            paymentMethod: method,
            creditAmount: split.creditAmount.toFixed(2),
            creditReservationRef: reservation.reservationRef,
            installments: committed.schedule.installments,
            escrowHeld: application.escrowHeld,
          },
        });
        return { paymentId: payment.id, schedule: committed.schedule, orderPaymentStatus: ParentOrderPaymentStatus.PAID };
      });
    } catch (error) {
      // Nothing was recorded locally: undo the provider-side reservation now.
      await adapter.releaseCredit(reservation.reservationRef).catch((releaseError: unknown) => {
        this.logger.error(`Could not release provider reservation ${reservation.reservationRef} after a failed checkout: ${String(releaseError)}`);
      });
      throw error;
    }
    await this.creditOrders.followUp(followUps);

    const base = {
      paymentId: result.paymentId,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      paymentMethod: method,
      creditAmount: split.creditAmount.toFixed(2),
      cashAmount: split.cashAmount.toFixed(2),
      currency: 'IRR',
      plan: { id: plan.id, title: plan.title, durationMonths: plan.durationMonths, interestRatePercent: plan.interestRatePercent.toFixed(2) },
    };
    if (method === PaymentMethod.BANK_CREDIT) {
      return { ...base, status: 'COMPLETED', orderPaymentStatus: result.orderPaymentStatus, redirectUrl: null, gatewayName: null, paymentExpiresAt: null, schedule: result.schedule };
    }
    // HYBRID: open the bank session for the card part (on failure the reservation is released and 502 is thrown).
    const initiation = await this.payments.startGatewaySession({
      paymentId: result.paymentId,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      amount: split.cashAmount,
      description: `پرداخت نقدی سفارش ${order.orderNumber} (ترکیبی با اعتبار) — شاپینو`,
      customerMobile: order.user.mobile,
    });
    return {
      ...base,
      status: 'IPG_REQUIRED',
      orderPaymentStatus: result.orderPaymentStatus,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.payments.gatewayName,
      paymentExpiresAt: order.paymentExpiresAt,
      schedule: null,
    };
  }

  private async reserveAtProvider(adapter: CreditProviderAdapter, accountId: string, amount: Prisma.Decimal, parentOrderId: string): Promise<CreditReservation> {
    try {
      return await adapter.reserveCredit(accountId, amount, parentOrderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Provider ${adapter.code} could not reserve credit for order ${parentOrderId}: ${message}`);
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        code: 'CREDIT_PROVIDER_UNAVAILABLE',
        message: 'The credit provider could not reserve the credit; try again later',
        providerCode: error instanceof CreditProviderError ? error.code : 'PROVIDER_ERROR',
      });
    }
  }

  private rejection(reason: 'INSUFFICIENT_CREDIT' | 'HYBRID_NOT_REQUIRED' | 'AMOUNT_NOT_WHOLE_RIALS', payable: Prisma.Decimal, available: Prisma.Decimal): Error {
    const details = { finalPayableAmount: payable.toFixed(2), availableAmount: available.toFixed(2) };
    switch (reason) {
      case 'INSUFFICIENT_CREDIT':
        return conflictWith('INSUFFICIENT_CREDIT', 'Your available credit does not cover this payment method; use HYBRID or card', details);
      case 'HYBRID_NOT_REQUIRED':
        return conflictWith('HYBRID_NOT_REQUIRED', 'Your available credit covers the whole order; use BANK_CREDIT', details);
      case 'AMOUNT_NOT_WHOLE_RIALS':
        return conflictWith('AMOUNT_NOT_WHOLE_RIALS', 'The order amount is not in whole rials and cannot be financed', details);
    }
  }
}

function assertPayable(order: { paymentStatus: ParentOrderPaymentStatus; paymentExpiresAt: Date | null }, now: Date): void {
  if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
    throw conflictWith('ORDER_NOT_PAYABLE', `This order is ${order.paymentStatus}; only PENDING orders can be paid`, { paymentStatus: order.paymentStatus });
  }
  if (order.paymentExpiresAt !== null && order.paymentExpiresAt <= now) {
    throw conflictWith('ORDER_PAYMENT_EXPIRED', 'The payment window of this order has closed; place the order again', { paymentExpiresAt: order.paymentExpiresAt });
  }
}
```

### `apps/backend/src/modules/bnpl/credit-payments.controller.ts`

```ts
import { Body, Controller, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
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
import { CreditCheckoutService } from './credit-checkout.service';
import { CreditPaymentInitiateResponseDto, InitiateCreditPaymentDto } from './dto/bnpl.dto';

@ApiTags('credit-payments')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@Controller('payments/credit')
export class CreditPaymentsController {
  constructor(private readonly checkout: CreditCheckoutService) {}

  @Post('initiate')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Pay a PENDING order with bank credit (BANK_CREDIT) or credit + card (HYBRID)',
    description:
      'BANK_CREDIT (available ≥ finalPayableAmount): credit is reserved and committed at once — the order becomes PAID, its packages ' +
      'PENDING_APPROVAL, stock is committed, each store’s earnings enter escrow and the instalment schedule of the plan is created. ' +
      'Returns `status: COMPLETED`. HYBRID (available < finalPayableAmount): all available credit (whole rials) is reserved and a Payment ' +
      'with creditAmount + cashAmount is INITIATED; returns `status: IPG_REQUIRED` with the bank page for cashAmount. When the card part ' +
      'is verified (`/payments/callback`) the credit is committed and the schedule created; if it fails, the gateway cannot open a session, ' +
      'or the order expires/is cancelled first, the reservation is released. Every balance change writes a credit ledger row.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreditPaymentInitiateResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error or INSTALLMENT_PLAN_NOT_AVAILABLE' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiNotFoundResponse({ description: 'Order not found (or not yours)' })
  @ApiConflictResponse({
    description:
      'ORDER_NOT_PAYABLE, ORDER_PAYMENT_EXPIRED, CREDIT_ACCOUNT_REQUIRED, CREDIT_ACCOUNT_NOT_ACTIVE, CREDIT_ACCOUNT_EXPIRED, ' +
      'INSUFFICIENT_CREDIT, HYBRID_NOT_REQUIRED or AMOUNT_NOT_WHOLE_RIALS',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many open payment attempts for this order' })
  @ApiBadGatewayResponse({ description: 'CREDIT_PROVIDER_UNAVAILABLE (reservation failed) or GATEWAY_UNAVAILABLE (HYBRID card session; credit released)' })
  @ApiServiceUnavailableResponse({ description: 'CREDIT_DISABLED or the active provider is unavailable / not implemented / misconfigured' })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiateCreditPaymentDto,
    @ClientContext() context: RequestContext,
  ): Promise<CreditPaymentInitiateResponseDto> {
    return this.checkout.initiate(user.id, dto, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/bnpl/dto/bnpl.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { InstallmentStatus, ParentOrderPaymentStatus, PaymentMethod } from '@prisma/client';
import { IsIn, IsUUID } from 'class-validator';
import { MONEY } from '../../wallet/dto/wallet.dto';

export const CREDIT_PAYMENT_METHODS = [PaymentMethod.BANK_CREDIT, PaymentMethod.HYBRID] as const;
export type CreditPaymentMethod = (typeof CREDIT_PAYMENT_METHODS)[number];

// ─── input ──────────────────────────────────────────────────────────────────

export class InitiateCreditPaymentDto {
  @ApiProperty({ format: 'uuid', description: 'A PENDING order of yours (from `POST /checkout`).' })
  @IsUUID()
  parentOrderId!: string;

  @ApiProperty({ format: 'uuid', description: 'An active plan of the active provider (`GET /credit/plans`).' })
  @IsUUID()
  planId!: string;

  @ApiProperty({
    enum: CREDIT_PAYMENT_METHODS,
    description:
      'BANK_CREDIT: the whole amount on credit (available ≥ finalPayableAmount). HYBRID: all available credit (whole rials) + the rest by ' +
      'card; only when available < finalPayableAmount.',
  })
  @IsIn(CREDIT_PAYMENT_METHODS)
  paymentMethod!: CreditPaymentMethod;
}

// ─── output ─────────────────────────────────────────────────────────────────

export class ScheduleSummaryDto {
  @ApiProperty({ example: 6 }) installments!: number;
  @ApiProperty(MONEY) creditAmount!: string;
  @ApiProperty(MONEY) totalInterest!: string;
  @ApiProperty(MONEY) totalPayable!: string;
  @ApiProperty({ example: '2026-10-27' }) firstDueDate!: string;
  @ApiProperty({ example: '2027-03-26' }) lastDueDate!: string;
}

export class InstallmentPlanRefDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() title!: string;
  @ApiProperty() durationMonths!: number;
  @ApiProperty({ example: '9.00' }) interestRatePercent!: string;
}

export const CREDIT_INITIATE_STATUSES = ['COMPLETED', 'IPG_REQUIRED'] as const;

export class CreditPaymentInitiateResponseDto {
  @ApiProperty({
    enum: CREDIT_INITIATE_STATUSES,
    description: 'COMPLETED: BANK_CREDIT — the order is PAID now. IPG_REQUIRED: HYBRID — credit is reserved; send the customer to `redirectUrl` for the card part.',
  })
  status!: (typeof CREDIT_INITIATE_STATUSES)[number];
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ enum: CREDIT_PAYMENT_METHODS }) paymentMethod!: CreditPaymentMethod;
  @ApiProperty(MONEY) creditAmount!: string;
  @ApiProperty(MONEY) cashAmount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ type: InstallmentPlanRefDto }) plan!: InstallmentPlanRefDto;
  @ApiProperty({ enum: ParentOrderPaymentStatus }) orderPaymentStatus!: ParentOrderPaymentStatus;
  @ApiProperty({ nullable: true, type: String, description: 'IPG_REQUIRED only: the bank payment page for cashAmount.' }) redirectUrl!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'sandbox', description: 'IPG_REQUIRED only.' }) gatewayName!: string | null;
  @ApiProperty({ nullable: true, type: Date, description: 'IPG_REQUIRED only: the card part must be paid before this.' }) paymentExpiresAt!: Date | null;
  @ApiProperty({ type: ScheduleSummaryDto, nullable: true, description: 'COMPLETED only: the instalment schedule created (HYBRID: created when the card part is verified).' })
  schedule!: ScheduleSummaryDto | null;
}

export class InstallmentDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 1 }) installmentNumber!: number;
  @ApiProperty({ example: 6 }) totalInstallments!: number;
  @ApiProperty({ example: '2026-10-27', description: 'Calendar date (Asia/Tehran).' }) dueDate!: string;
  @ApiProperty(MONEY) principalAmount!: string;
  @ApiProperty(MONEY) interestAmount!: string;
  @ApiProperty({ ...MONEY, description: 'Late penalty (not applied automatically in this phase: always 0).' }) penaltyAmount!: string;
  @ApiProperty(MONEY) totalAmount!: string;
  @ApiProperty(MONEY) paidAmount!: string;
  @ApiProperty({ ...MONEY, description: 'What `POST /credit/installments/{id}/pay` charges now (0 when settled).' }) amountDue!: string;
  @ApiProperty({ enum: InstallmentStatus, description: 'PENDING, PAID or OVERDUE (due date passed unpaid). WAIVED is reserved for staff.' })
  status!: InstallmentStatus;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
}

export class OrderInstallmentsDto {
  @ApiProperty({ format: 'uuid' }) parentOrderId!: string;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty({ nullable: true, type: Date }) paidAt!: Date | null;
  @ApiProperty({ type: InstallmentPlanRefDto, nullable: true }) plan!: InstallmentPlanRefDto | null;
  @ApiProperty({ ...MONEY, description: 'Financed principal (sum of instalment principals).' }) creditAmount!: string;
  @ApiProperty(MONEY) totalInterest!: string;
  @ApiProperty(MONEY) totalPayable!: string;
  @ApiProperty(MONEY) paidAmount!: string;
  @ApiProperty(MONEY) remainingAmount!: string;
  @ApiProperty() paidCount!: number;
  @ApiProperty() overdueCount!: number;
  @ApiProperty({ type: [InstallmentDto] }) installments!: InstallmentDto[];
}

export class InstallmentsOverviewDto {
  @ApiProperty({ type: [OrderInstallmentsDto], description: 'Credit-financed orders, newest first.' }) orders!: OrderInstallmentsDto[];
  @ApiProperty({ ...MONEY, description: 'Unpaid amount over all orders.' }) totalRemaining!: string;
  @ApiProperty() overdueCount!: number;
}

export class InstallmentPaymentResponseDto {
  @ApiProperty({ format: 'uuid' }) paymentId!: string;
  @ApiProperty({ format: 'uuid' }) installmentId!: string;
  @ApiProperty() installmentNumber!: number;
  @ApiProperty() totalInstallments!: number;
  @ApiProperty({ example: 'SHP-100000012' }) orderNumber!: string;
  @ApiProperty({ description: 'Bank payment page; the instalment becomes PAID when the bank callback is verified.' }) redirectUrl!: string;
  @ApiProperty({ example: 'sandbox' }) gatewayName!: string;
  @ApiProperty(MONEY) amount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
}
```

### `apps/backend/src/modules/bnpl/installment-overdue.scheduler.ts`

```ts
import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { InstallmentsService } from './installments.service';

const LOCK_KEY = 'lock:credit:installment-overdue-sweep';

/**
 * Periodically marks PENDING instalments whose due date (Asia/Tehran) has passed
 * as OVERDUE. Several API instances may run this timer; a Redis `SET NX PX` lock
 * lets only one of them sweep at a time (the update itself is idempotent).
 * Late penalties are not computed in this phase.
 *
 * `INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=0` disables the timer (e.g. when a
 * dedicated worker takes over).
 */
@Injectable()
export class InstallmentOverdueScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InstallmentOverdueScheduler.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly installments: InstallmentsService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS') * 1000;
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('Instalment overdue sweep is disabled (INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=0)');
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

  /** One sweep; returns the number of instalments marked OVERDUE (0 when another instance holds the lock). */
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
          const marked = await this.installments.markOverdue();
          if (marked > 0) this.logger.log(`Marked ${marked} instalment(s) OVERDUE`);
          return marked;
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
        this.logger.error(`Instalment overdue sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
```

### `apps/backend/src/modules/bnpl/installments.controller.ts`

```ts
import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
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
import { InstallmentPaymentResponseDto, InstallmentsOverviewDto } from './dto/bnpl.dto';
import { InstallmentsService } from './installments.service';

@ApiTags('credit-installments')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Customers only' })
@Controller('credit/installments')
export class InstallmentsController {
  constructor(private readonly installments: InstallmentsService) {}

  @Get()
  @ApiOperation({
    summary: 'My instalments, grouped by order',
    description: 'Status PENDING, PAID or OVERDUE (a PENDING instalment whose due date — Asia/Tehran — has passed is marked OVERDUE).',
  })
  @ApiOkResponse({ type: InstallmentsOverviewDto })
  list(@CurrentUser() user: AuthenticatedUser): Promise<InstallmentsOverviewDto> {
    return this.installments.overview(user.id);
  }

  @Post(':id/pay')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Pay one instalment by card',
    description:
      'Opens a bank payment (the active IPG) for the amount due of a PENDING or OVERDUE instalment and returns its page. When the bank ' +
      'callback (`/payments/callback`) is verified, in one transaction the instalment becomes PAID with paidAt, and its principal returns ' +
      'to the credit line (used −= principal, available += principal) with an INSTALLMENT_REPAYMENT_RESTORE ledger row.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: InstallmentPaymentResponseDto })
  @ApiBadRequestResponse({ description: 'The id is not a UUID' })
  @ApiNotFoundResponse({ description: 'Instalment not found (or not yours)' })
  @ApiConflictResponse({ description: 'INSTALLMENT_NOT_PAYABLE (already PAID or WAIVED)' })
  @ApiTooManyRequestsResponse({ description: 'Too many open payment attempts for this instalment' })
  @ApiBadGatewayResponse({ description: 'GATEWAY_UNAVAILABLE: the payment gateway could not open a session' })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ClientContext() context: RequestContext,
  ): Promise<InstallmentPaymentResponseDto> {
    return this.installments.pay(user.id, id, { actorId: user.id, context });
  }
}
```

### `apps/backend/src/modules/bnpl/installments.service.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, InstallmentStatus, PaymentMethod, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { amountDue } from '../credit/credit-order.service';
import { calendarDateToDb, dbDateToCalendar, platformDate } from '../credit/installment-math';
import { writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { MAX_OPEN_ATTEMPTS, PaymentsService } from '../payments/payments.service';
import type { InstallmentDto, InstallmentPaymentResponseDto, InstallmentsOverviewDto, OrderInstallmentsDto } from './dto/bnpl.dto';

const ZERO = new Prisma.Decimal(0);

const installmentSelect = {
  id: true,
  parentOrderId: true,
  installmentNumber: true,
  totalInstallments: true,
  dueDate: true,
  principalAmount: true,
  interestAmount: true,
  penaltyAmount: true,
  totalAmount: true,
  paidAmount: true,
  status: true,
  paidAt: true,
} satisfies Prisma.InstallmentScheduleSelect;

type InstallmentRow = Prisma.InstallmentScheduleGetPayload<{ select: typeof installmentSelect }>;

/**
 * Instalments of a customer's credit purchases, and their repayment.
 *
 * Repayment goes through the platform card gateway (Phase 7 IPG): `pay` opens a
 * bank session for the amount due; the verified bank callback marks the
 * instalment PAID and restores its principal to the credit line
 * (INSTALLMENT_REPAYMENT_RESTORE) in one transaction — see PaymentsService.
 */
@Injectable()
export class InstallmentsService {
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  /**
   * PENDING instalments whose due date (Asia/Tehran calendar) has passed become
   * OVERDUE. Due on the due date itself is still PENDING. Optionally limited to
   * one customer's accounts (used before listing them).
   */
  async markOverdue(now: Date = new Date(), userId?: string): Promise<number> {
    const today = calendarDateToDb(platformDate(now));
    const result = await this.prisma.installmentSchedule.updateMany({
      where: { status: InstallmentStatus.PENDING, dueDate: { lt: today }, ...(userId ? { creditAccount: { userId } } : {}) },
      data: { status: InstallmentStatus.OVERDUE },
    });
    return result.count;
  }

  async overview(userId: string): Promise<InstallmentsOverviewDto> {
    await this.markOverdue(new Date(), userId);
    const rows = await this.prisma.installmentSchedule.findMany({
      where: { creditAccount: { userId } },
      select: installmentSelect,
      orderBy: [{ parentOrderId: 'asc' }, { installmentNumber: 'asc' }],
    });
    const orderIds = [...new Set(rows.map((row) => row.parentOrderId))];
    const [orders, creditPayments] = await Promise.all([
      this.prisma.parentOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, paymentMethod: true, paidAt: true } }),
      this.prisma.payment.findMany({
        where: { parentOrderId: { in: orderIds }, purpose: PaymentPurpose.ORDER_CHECKOUT, status: PaymentStatus.SUCCESSFUL, installmentPlanId: { not: null } },
        select: { parentOrderId: true, installmentPlan: { select: { id: true, title: true, durationMonths: true, interestRatePercent: true } } },
      }),
    ]);
    const planByOrder = new Map(creditPayments.map((payment) => [payment.parentOrderId, payment.installmentPlan]));
    const byOrder = new Map<string, InstallmentRow[]>();
    for (const row of rows) {
      byOrder.set(row.parentOrderId, [...(byOrder.get(row.parentOrderId) ?? []), row]);
    }
    const groups: OrderInstallmentsDto[] = orders
      .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0))
      .map((order) => {
        const lines = byOrder.get(order.id) ?? [];
        const sum = (pick: (row: InstallmentRow) => Prisma.Decimal): Prisma.Decimal => lines.reduce((acc, row) => acc.plus(pick(row)), ZERO);
        const remaining = lines.reduce((acc, row) => acc.plus(isOpen(row.status) ? amountDue(row) : ZERO), ZERO);
        const plan = planByOrder.get(order.id) ?? null;
        return {
          parentOrderId: order.id,
          orderNumber: order.orderNumber,
          paymentMethod: order.paymentMethod,
          paidAt: order.paidAt,
          plan: plan ? { id: plan.id, title: plan.title, durationMonths: plan.durationMonths, interestRatePercent: plan.interestRatePercent.toFixed(2) } : null,
          creditAmount: sum((row) => row.principalAmount).toFixed(2),
          totalInterest: sum((row) => row.interestAmount).toFixed(2),
          totalPayable: sum((row) => row.totalAmount.plus(row.penaltyAmount)).toFixed(2),
          paidAmount: sum((row) => row.paidAmount).toFixed(2),
          remainingAmount: remaining.toFixed(2),
          paidCount: lines.filter((row) => row.status === InstallmentStatus.PAID).length,
          overdueCount: lines.filter((row) => row.status === InstallmentStatus.OVERDUE).length,
          installments: lines.map(toInstallmentDto),
        };
      });
    return {
      orders: groups,
      totalRemaining: groups.reduce((acc, group) => acc.plus(group.remainingAmount), ZERO).toFixed(2),
      overdueCount: groups.reduce((acc, group) => acc + group.overdueCount, 0),
    };
  }

  /** Opens a card payment for the amount due of one PENDING or OVERDUE instalment. */
  async pay(userId: string, installmentId: string, actor: OrderActor): Promise<InstallmentPaymentResponseDto> {
    const installment = await this.prisma.installmentSchedule.findFirst({
      where: { id: installmentId, creditAccount: { userId } },
      select: { ...installmentSelect, parentOrder: { select: { orderNumber: true, user: { select: { mobile: true } } } } },
    });
    if (!installment) {
      throw new NotFoundException('Instalment not found');
    }
    if (!isOpen(installment.status)) {
      throw conflictWith('INSTALLMENT_NOT_PAYABLE', `This instalment is ${installment.status}`, { installmentStatus: installment.status });
    }
    const due = amountDue(installment);
    if (!due.greaterThan(0)) {
      throw conflictWith('INSTALLMENT_NOT_PAYABLE', 'Nothing is due on this instalment', { installmentStatus: installment.status });
    }
    const open = await this.prisma.payment.count({
      where: { installmentScheduleId: installment.id, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(Date.now() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this instalment; finish or wait for one of them', this.graceMs / 1000);
    }
    const orderNumber = installment.parentOrder.orderNumber;
    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          parentOrderId: installment.parentOrderId,
          purpose: PaymentPurpose.INSTALLMENT_REPAYMENT,
          paymentMethod: PaymentMethod.CASH_IPG,
          installmentScheduleId: installment.id,
          gatewayName: this.payments.gatewayName,
          cashAmount: due,
          creditAmount: 0,
          status: PaymentStatus.INITIATED,
        },
        select: { id: true },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Payment',
        entityId: created.id,
        newValue: {
          purpose: PaymentPurpose.INSTALLMENT_REPAYMENT,
          installmentScheduleId: installment.id,
          installmentNumber: installment.installmentNumber,
          orderNumber,
          amount: due.toFixed(2),
          gatewayName: this.payments.gatewayName,
        },
      });
      return created;
    });
    const initiation = await this.payments.startGatewaySession({
      paymentId: payment.id,
      parentOrderId: installment.parentOrderId,
      orderNumber,
      amount: due,
      description: `پرداخت قسط ${installment.installmentNumber} از ${installment.totalInstallments} سفارش ${orderNumber} — شاپینو`,
      customerMobile: installment.parentOrder.user.mobile,
    });
    return {
      paymentId: payment.id,
      installmentId: installment.id,
      installmentNumber: installment.installmentNumber,
      totalInstallments: installment.totalInstallments,
      orderNumber,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.payments.gatewayName,
      amount: due.toFixed(2),
      currency: 'IRR',
    };
  }
}

function isOpen(status: InstallmentStatus): boolean {
  return status === InstallmentStatus.PENDING || status === InstallmentStatus.OVERDUE;
}

function toInstallmentDto(row: InstallmentRow): InstallmentDto {
  return {
    id: row.id,
    installmentNumber: row.installmentNumber,
    totalInstallments: row.totalInstallments,
    dueDate: dbDateToCalendar(row.dueDate),
    principalAmount: row.principalAmount.toFixed(2),
    interestAmount: row.interestAmount.toFixed(2),
    penaltyAmount: row.penaltyAmount.toFixed(2),
    totalAmount: row.totalAmount.toFixed(2),
    paidAmount: row.paidAmount.toFixed(2),
    amountDue: (isOpen(row.status) ? amountDue(row) : ZERO).toFixed(2),
    status: row.status,
    paidAt: row.paidAt,
  };
}
```

### `apps/backend/src/modules/credit/admin-credit.controller.ts`

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminCreditService } from './admin-credit.service';
import { AdminCreditAccountPageDto, AdminCreditAccountsQueryDto, AdminCreditApplicationPageDto, AdminCreditApplicationsQueryDto } from './dto/credit.dto';

@ApiTags('admin-credit')
@ApiBearerAuth('access-token')
@Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN, UserRole.ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Finance officers and administrators only' })
@Controller('admin/credit')
export class AdminCreditController {
  constructor(private readonly credit: AdminCreditService) {}

  @Get('applications')
  @ApiOperation({ summary: 'Credit applications, newest first', description: 'National codes are masked (last 4 digits).' })
  @ApiOkResponse({ type: AdminCreditApplicationPageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  applications(@Query() query: AdminCreditApplicationsQueryDto): Promise<AdminCreditApplicationPageDto> {
    return this.credit.applications(query);
  }

  @Get('accounts')
  @ApiOperation({
    summary: 'Credit accounts with the aggregated credit exposure',
    description:
      '`exposure` aggregates all accounts matching the filters: limits, outstanding principal (used), reservations, unpaid and ' +
      'overdue instalments, and `ledgerConsistent` — every account satisfies the invariant and equals the replay of its credit ledger.',
  })
  @ApiOkResponse({ type: AdminCreditAccountPageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  accounts(@Query() query: AdminCreditAccountsQueryDto): Promise<AdminCreditAccountPageDto> {
    return this.credit.accounts(query);
  }
}
```

### `apps/backend/src/modules/credit/admin-credit.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { CreditTransactionType, InstallmentStatus, Prisma } from '@prisma/client';
import { toE164 } from '../../common/validators/iranian-mobile';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { accountSelect, applicationSelect, outstandingByAccount, toAccountDto, toApplicationDto, userSummary, userSummarySelect } from './credit-views';
import type {
  AdminCreditAccountPageDto,
  AdminCreditAccountsQueryDto,
  AdminCreditApplicationPageDto,
  AdminCreditApplicationsQueryDto,
  CreditExposureDto,
} from './dto/credit.dto';

interface ExposureRow {
  accounts: bigint;
  total_limit: Prisma.Decimal | null;
  used: Prisma.Decimal | null;
  reserved: Prisma.Decimal | null;
  available: Prisma.Decimal | null;
  inconsistent: bigint;
}

interface InstallmentExposureRow {
  outstanding: Prisma.Decimal | null;
  overdue_count: bigint;
  overdue_amount: Prisma.Decimal | null;
}

/** Staff views of the credit book: applications and accounts with the platform's aggregated exposure. */
@Injectable()
export class AdminCreditService {
  constructor(private readonly prisma: PrismaService) {}

  async applications(query: AdminCreditApplicationsQueryDto): Promise<AdminCreditApplicationPageDto> {
    const where: Prisma.CreditApplicationWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.providerCode ? { provider: { code: query.providerCode } } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.creditApplication.findMany({
        where,
        select: { ...applicationSelect, user: { select: userSummarySelect } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.creditApplication.count({ where }),
    ]);
    // An approved application is linked to its account by the CREDIT_ALLOCATION row (referenceCode = application id).
    const allocations = await this.prisma.creditTransaction.findMany({
      where: { type: CreditTransactionType.CREDIT_ALLOCATION, referenceCode: { in: rows.map((row) => row.id) } },
      select: { referenceCode: true, creditAccountId: true },
    });
    const accounts = await this.prisma.creditAccount.findMany({ where: { id: { in: allocations.map((a) => a.creditAccountId) } }, select: accountSelect });
    const outstanding = await outstandingByAccount(this.prisma, accounts.map((account) => account.id));
    const accountById = new Map(accounts.map((account) => [account.id, toAccountDto(account, outstanding)]));
    const accountByApplication = new Map(allocations.map((a) => [a.referenceCode, accountById.get(a.creditAccountId) ?? null]));
    return {
      items: rows.map((row) => ({ ...toApplicationDto(row, accountByApplication.get(row.id) ?? null), user: userSummary(row.user) })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
    };
  }

  async accounts(query: AdminCreditAccountsQueryDto): Promise<AdminCreditAccountPageDto> {
    const search = query.search?.trim();
    const mobile = search ? toE164(search) : null;
    const where: Prisma.CreditAccountWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.providerCode ? { provider: { code: query.providerCode } } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(search
        ? { user: { OR: [{ fullName: { contains: search, mode: 'insensitive' } }, { mobile: { contains: mobile ?? search } }] } }
        : {}),
    };
    const [rows, total, ids] = await this.prisma.$transaction([
      this.prisma.creditAccount.findMany({
        where,
        select: { ...accountSelect, user: { select: userSummarySelect } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.creditAccount.count({ where }),
      this.prisma.creditAccount.findMany({ where, select: { id: true } }),
    ]);
    const outstanding = await outstandingByAccount(this.prisma, rows.map((row) => row.id));
    return {
      items: rows.map((row) => ({ ...toAccountDto(row, outstanding), user: userSummary(row.user) })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.ceil(total / query.pageSize),
      exposure: await this.exposure(ids.map((row) => row.id)),
    };
  }

  /**
   * Aggregates over the given accounts. `inconsistent` counts accounts that break
   * the invariant or whose stored balances differ from the replay of their
   * credit_transactions (the ledger is the source of truth).
   */
  private async exposure(accountIds: string[]): Promise<CreditExposureDto> {
    if (accountIds.length === 0) {
      return { accounts: 0, totalLimit: '0.00', used: '0.00', reserved: '0.00', available: '0.00', outstandingInstallments: '0.00', overdueInstallments: 0, overdueAmount: '0.00', ledgerConsistent: true, inconsistentAccounts: 0 };
    }
    const ids = Prisma.join(accountIds.map((id) => Prisma.sql`${id}::uuid`));
    const [balances] = await this.prisma.$queryRaw<ExposureRow[]>(Prisma.sql`
      WITH replay AS (
        SELECT credit_account_id,
          COALESCE(SUM(amount) FILTER (WHERE type = 'CREDIT_ALLOCATION'), 0) AS total_limit,
          COALESCE(SUM(amount) FILTER (WHERE type = 'PURCHASE_COMMIT'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE type IN ('INSTALLMENT_REPAYMENT_RESTORE', 'REFUND_RESTORE')), 0) AS used,
          COALESCE(SUM(amount) FILTER (WHERE type = 'PURCHASE_RESERVE_HOLD'), 0)
            - COALESCE(SUM(amount) FILTER (WHERE type IN ('PURCHASE_COMMIT', 'RESERVATION_RELEASE')), 0) AS reserved
        FROM credit_transactions
        WHERE credit_account_id IN (${ids})
        GROUP BY credit_account_id
      )
      SELECT COUNT(*)::bigint AS accounts,
        SUM(a.total_limit) AS total_limit, SUM(a.used_amount) AS used,
        SUM(a.reserved_amount) AS reserved, SUM(a.available_amount) AS available,
        COUNT(*) FILTER (WHERE
          a.total_limit <> a.used_amount + a.reserved_amount + a.available_amount
          OR r.credit_account_id IS NULL
          OR a.total_limit <> r.total_limit OR a.used_amount <> r.used OR a.reserved_amount <> r.reserved
          OR a.available_amount <> r.total_limit - r.used - r.reserved
        )::bigint AS inconsistent
      FROM credit_accounts a
      LEFT JOIN replay r ON r.credit_account_id = a.id
      WHERE a.id IN (${ids})`);
    const [installments] = await this.prisma.$queryRaw<InstallmentExposureRow[]>(Prisma.sql`
      SELECT SUM(total_amount + penalty_amount - paid_amount) AS outstanding,
        COUNT(*) FILTER (WHERE status = ${InstallmentStatus.OVERDUE}::"InstallmentStatus")::bigint AS overdue_count,
        SUM(total_amount + penalty_amount - paid_amount) FILTER (WHERE status = ${InstallmentStatus.OVERDUE}::"InstallmentStatus") AS overdue_amount
      FROM installment_schedules
      WHERE credit_account_id IN (${ids})
        AND status IN (${InstallmentStatus.PENDING}::"InstallmentStatus", ${InstallmentStatus.OVERDUE}::"InstallmentStatus")`);
    const money = (value: Prisma.Decimal | null | undefined): string => new Prisma.Decimal(value ?? 0).toFixed(2);
    const inconsistent = Number(balances?.inconsistent ?? 0n);
    return {
      accounts: Number(balances?.accounts ?? 0n),
      totalLimit: money(balances?.total_limit),
      used: money(balances?.used),
      reserved: money(balances?.reserved),
      available: money(balances?.available),
      outstandingInstallments: money(installments?.outstanding),
      overdueInstallments: Number(installments?.overdue_count ?? 0n),
      overdueAmount: money(installments?.overdue_amount),
      ledgerConsistent: inconsistent === 0,
      inconsistentAccounts: inconsistent,
    };
  }
}
```

### `apps/backend/src/modules/credit/credit-ledger.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { CreditAccountStatus, CreditTransactionType, Prisma } from '@prisma/client';
import { conflictWith } from '../../common/http-errors';
import { applyCreditMovement, InsufficientCreditError, reservationStateOf, zeroBalances, type CreditBalances, type ReservationState } from './credit-math';

type Tx = Prisma.TransactionClient;

export interface LockedCreditAccount {
  id: string;
  userId: string;
  providerId: string;
  status: CreditAccountStatus;
  balances: CreditBalances;
}

interface AccountRow {
  id: string;
  user_id: string;
  provider_id: string;
  status: CreditAccountStatus;
  total_limit: Prisma.Decimal;
  used_amount: Prisma.Decimal;
  reserved_amount: Prisma.Decimal;
  available_amount: Prisma.Decimal;
}

/**
 * The only writer of credit accounts (TM brief §2). Every method runs in the
 * caller's transaction, locks the account row (`SELECT … FOR UPDATE`), applies
 * the movement with the pure `applyCreditMovement` (which refuses to take more
 * than a bucket holds) and writes the new balances and one `CreditTransaction`
 * row together — so the ledger and the projection commit or roll back as one.
 *
 * Guarantees, each also enforced by PostgreSQL (migration phase8_credit):
 * - invariant totalLimit = used + reserved + available, all ≥ 0 (CHECK);
 * - one row per (type, referenceCode): a reservation is held, committed or
 *   released at most once, an instalment restores credit at most once (UNIQUE);
 * - a reservation ends once: commit XOR release (partial UNIQUE).
 *
 * Lock order across the platform: parent order → credit account → stock rows →
 * vendor wallets. Callers must follow it.
 */
@Injectable()
export class CreditLedgerService {
  async lock(tx: Tx, creditAccountId: string): Promise<LockedCreditAccount> {
    const rows = await tx.$queryRaw<AccountRow[]>(Prisma.sql`
      SELECT id, user_id, provider_id, status, total_limit, used_amount, reserved_amount, available_amount
      FROM credit_accounts WHERE id = ${creditAccountId}::uuid FOR UPDATE`);
    const row = rows[0];
    if (!row) {
      throw new Error(`Credit account ${creditAccountId} does not exist`);
    }
    return {
      id: row.id,
      userId: row.user_id,
      providerId: row.provider_id,
      status: row.status,
      balances: {
        totalLimit: new Prisma.Decimal(row.total_limit),
        usedAmount: new Prisma.Decimal(row.used_amount),
        reservedAmount: new Prisma.Decimal(row.reserved_amount),
        availableAmount: new Prisma.Decimal(row.available_amount),
      },
    };
  }

  /** Opens a credit line with its CREDIT_ALLOCATION row (reference = the approved application). */
  async openAccount(tx: Tx, input: { userId: string; providerId: string; limit: Prisma.Decimal; applicationId: string; expiresAt: Date | null }): Promise<string> {
    const balances = applyCreditMovement(zeroBalances(), CreditTransactionType.CREDIT_ALLOCATION, input.limit);
    const account = await tx.creditAccount.create({
      data: {
        userId: input.userId,
        providerId: input.providerId,
        totalLimit: balances.totalLimit,
        usedAmount: balances.usedAmount,
        reservedAmount: balances.reservedAmount,
        availableAmount: balances.availableAmount,
        status: CreditAccountStatus.ACTIVE,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });
    await tx.creditTransaction.create({
      data: {
        creditAccountId: account.id,
        type: CreditTransactionType.CREDIT_ALLOCATION,
        amount: input.limit,
        balanceAfter: balances.availableAmount,
        referenceCode: input.applicationId,
      },
    });
    return account.id;
  }

  /** Checkout: available → reserved. 409 INSUFFICIENT_CREDIT / CREDIT_ACCOUNT_NOT_ACTIVE. */
  async hold(tx: Tx, creditAccountId: string, amount: Prisma.Decimal, reservationRef: string, parentOrderId: string): Promise<CreditBalances> {
    const account = await this.lock(tx, creditAccountId);
    if (account.status !== CreditAccountStatus.ACTIVE) {
      throw conflictWith('CREDIT_ACCOUNT_NOT_ACTIVE', `The credit account is ${account.status}`, { accountStatus: account.status });
    }
    return this.post(tx, account, CreditTransactionType.PURCHASE_RESERVE_HOLD, amount, reservationRef, parentOrderId);
  }

  /**
   * Order paid: reserved → used. Returns false if already committed (idempotent);
   * 409 if the reservation was released meanwhile (the caller must not complete a
   * credit purchase whose hold is gone).
   */
  async commit(tx: Tx, creditAccountId: string, reservationRef: string): Promise<boolean> {
    const account = await this.lock(tx, creditAccountId);
    const { state, amount, parentOrderId } = await this.reservation(tx, creditAccountId, reservationRef);
    if (state === 'COMMITTED') return false;
    if (state !== 'HELD') {
      throw conflictWith('CREDIT_RESERVATION_NOT_HELD', `Credit reservation ${reservationRef} is ${state}`, { reservationState: state });
    }
    await this.post(tx, account, CreditTransactionType.PURCHASE_COMMIT, amount, reservationRef, parentOrderId);
    return true;
  }

  /** Checkout failed / cancelled / expired: reserved → available. Returns false if not held (already ended or never held). */
  async release(tx: Tx, creditAccountId: string, reservationRef: string): Promise<boolean> {
    const account = await this.lock(tx, creditAccountId);
    const { state, amount, parentOrderId } = await this.reservation(tx, creditAccountId, reservationRef);
    if (state !== 'HELD') return false;
    await this.post(tx, account, CreditTransactionType.RESERVATION_RELEASE, amount, reservationRef, parentOrderId);
    return true;
  }

  /** Instalment paid: used → available by its principal. Returns false if this instalment already restored credit. */
  async restoreRepayment(tx: Tx, creditAccountId: string, principal: Prisma.Decimal, installmentId: string, parentOrderId: string): Promise<boolean> {
    const account = await this.lock(tx, creditAccountId);
    const done = await tx.creditTransaction.count({
      where: { type: CreditTransactionType.INSTALLMENT_REPAYMENT_RESTORE, referenceCode: installmentId },
    });
    if (done > 0 || !principal.greaterThan(0)) return false;
    await this.post(tx, account, CreditTransactionType.INSTALLMENT_REPAYMENT_RESTORE, principal, installmentId, parentOrderId);
    return true;
  }

  async reservationState(tx: Tx, creditAccountId: string, reservationRef: string): Promise<ReservationState> {
    return (await this.reservation(tx, creditAccountId, reservationRef)).state;
  }

  private async reservation(
    tx: Tx,
    creditAccountId: string,
    reservationRef: string,
  ): Promise<{ state: ReservationState; amount: Prisma.Decimal; parentOrderId: string | null }> {
    const rows = await tx.creditTransaction.findMany({
      where: { creditAccountId, referenceCode: reservationRef },
      select: { type: true, amount: true, parentOrderId: true },
    });
    const hold = rows.find((row) => row.type === CreditTransactionType.PURCHASE_RESERVE_HOLD);
    return {
      state: reservationStateOf(rows.map((row) => row.type)),
      amount: hold?.amount ?? new Prisma.Decimal(0),
      parentOrderId: hold?.parentOrderId ?? null,
    };
  }

  private async post(
    tx: Tx,
    account: LockedCreditAccount,
    type: CreditTransactionType,
    amount: Prisma.Decimal,
    referenceCode: string,
    parentOrderId: string | null,
  ): Promise<CreditBalances> {
    let next: CreditBalances;
    try {
      next = applyCreditMovement(account.balances, type, amount);
    } catch (error) {
      if (error instanceof InsufficientCreditError) {
        throw conflictWith('INSUFFICIENT_CREDIT', `Not enough ${error.bucket} credit for this operation`, {
          bucket: error.bucket,
          available: error.available.toFixed(2),
          requested: error.requested.toFixed(2),
        });
      }
      throw error;
    }
    await tx.creditAccount.update({
      where: { id: account.id },
      data: { totalLimit: next.totalLimit, usedAmount: next.usedAmount, reservedAmount: next.reservedAmount, availableAmount: next.availableAmount },
    });
    await tx.creditTransaction.create({
      data: { creditAccountId: account.id, parentOrderId, type, amount, balanceAfter: next.availableAmount, referenceCode },
    });
    account.balances = next; // the lock is held: later movements in this transaction start from here
    return next;
  }
}
```

### `apps/backend/src/modules/credit/credit-math.spec.ts`

```ts
import { CreditTransactionType as T, Prisma } from '@prisma/client';
import { applyCreditMovement, holdsInvariant, InsufficientCreditError, replayCreditLedger, reservationStateOf, splitPayment, zeroBalances, type CreditBalances } from './credit-math';

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);
const view = (b: CreditBalances): string[] => [b.totalLimit, b.usedAmount, b.reservedAmount, b.availableAmount].map((v) => v.toFixed(0));

describe('applyCreditMovement', () => {
  it('moves money between buckets and keeps total = used + reserved + available at every step', () => {
    let b = applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(10_000_000));
    expect(view(b)).toEqual(['10000000', '0', '0', '10000000']);
    b = applyCreditMovement(b, T.PURCHASE_RESERVE_HOLD, D(4_000_000));
    expect(view(b)).toEqual(['10000000', '0', '4000000', '6000000']);
    expect(holdsInvariant(b)).toBe(true);
    b = applyCreditMovement(b, T.PURCHASE_COMMIT, D(4_000_000));
    expect(view(b)).toEqual(['10000000', '4000000', '0', '6000000']);
    b = applyCreditMovement(b, T.PURCHASE_RESERVE_HOLD, D(1_000_000));
    b = applyCreditMovement(b, T.RESERVATION_RELEASE, D(1_000_000));
    expect(view(b)).toEqual(['10000000', '4000000', '0', '6000000']);
    b = applyCreditMovement(b, T.INSTALLMENT_REPAYMENT_RESTORE, D(1_333_333));
    expect(view(b)).toEqual(['10000000', '2666667', '0', '7333333']);
    b = applyCreditMovement(b, T.REFUND_RESTORE, D(2_666_667));
    expect(view(b)).toEqual(['10000000', '0', '0', '10000000']);
    expect(holdsInvariant(b)).toBe(true);
  });

  it('never lets a bucket go negative', () => {
    const b = applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(100));
    expect(() => applyCreditMovement(b, T.PURCHASE_RESERVE_HOLD, D(101))).toThrow(InsufficientCreditError);
    expect(() => applyCreditMovement(b, T.PURCHASE_COMMIT, D(1))).toThrow(InsufficientCreditError);
    expect(() => applyCreditMovement(b, T.RESERVATION_RELEASE, D(1))).toThrow(InsufficientCreditError);
    expect(() => applyCreditMovement(b, T.INSTALLMENT_REPAYMENT_RESTORE, D(1))).toThrow(InsufficientCreditError);
  });

  it('rejects zero and negative amounts', () => {
    expect(() => applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(0))).toThrow();
    expect(() => applyCreditMovement(zeroBalances(), T.CREDIT_ALLOCATION, D(-5))).toThrow();
  });
});

describe('holdsInvariant / replayCreditLedger / reservationStateOf', () => {
  it('detects a broken invariant or a negative bucket', () => {
    expect(holdsInvariant({ totalLimit: D(10), usedAmount: D(3), reservedAmount: D(3), availableAmount: D(3) })).toBe(false);
    expect(holdsInvariant({ totalLimit: D(0), usedAmount: D(-1), reservedAmount: D(0), availableAmount: D(1) })).toBe(false);
  });

  it('rebuilds balances from the ledger', () => {
    const rows = [
      { type: T.CREDIT_ALLOCATION, amount: D(500) },
      { type: T.PURCHASE_RESERVE_HOLD, amount: D(200) },
      { type: T.PURCHASE_COMMIT, amount: D(200) },
      { type: T.PURCHASE_RESERVE_HOLD, amount: D(50) },
    ];
    expect(view(replayCreditLedger(rows))).toEqual(['500', '200', '50', '250']);
  });

  it('derives the reservation state from its ledger rows', () => {
    expect(reservationStateOf([])).toBe('NONE');
    expect(reservationStateOf([T.PURCHASE_RESERVE_HOLD])).toBe('HELD');
    expect(reservationStateOf([T.PURCHASE_RESERVE_HOLD, T.PURCHASE_COMMIT])).toBe('COMMITTED');
    expect(reservationStateOf([T.PURCHASE_RESERVE_HOLD, T.RESERVATION_RELEASE])).toBe('RELEASED');
  });
});

describe('splitPayment', () => {
  it('BANK_CREDIT takes the whole amount only when available ≥ payable', () => {
    const ok = splitPayment('BANK_CREDIT', D(5_000_000), D(5_000_000));
    expect(ok).toEqual({ creditAmount: D(5_000_000), cashAmount: D(0) });
    expect(splitPayment('BANK_CREDIT', D(5_000_000), D(4_999_999))).toEqual({ rejected: 'INSUFFICIENT_CREDIT' });
  });

  it('HYBRID uses all available credit (whole rials) and the card for the rest', () => {
    const split = splitPayment('HYBRID', D(5_000_000), D('3000000.00'));
    expect('rejected' in split).toBe(false);
    if (!('rejected' in split)) {
      expect(split.creditAmount.toFixed(0)).toBe('3000000');
      expect(split.cashAmount.toFixed(0)).toBe('2000000');
    }
  });

  it('HYBRID is refused when credit covers everything or nothing', () => {
    expect(splitPayment('HYBRID', D(5_000_000), D(5_000_000))).toEqual({ rejected: 'HYBRID_NOT_REQUIRED' });
    expect(splitPayment('HYBRID', D(5_000_000), D(0))).toEqual({ rejected: 'INSUFFICIENT_CREDIT' });
    expect(splitPayment('HYBRID', D(5_000_000), D('0.50'))).toEqual({ rejected: 'INSUFFICIENT_CREDIT' });
  });

  it('refuses amounts that are not whole rials', () => {
    expect(splitPayment('BANK_CREDIT', D('100.50'), D(1000))).toEqual({ rejected: 'AMOUNT_NOT_WHOLE_RIALS' });
  });
});
```

### `apps/backend/src/modules/credit/credit-math.ts`

```ts
import { CreditTransactionType, Prisma } from '@prisma/client';

/** The four amounts of a credit line. Invariant: totalLimit = used + reserved + available. */
export interface CreditBalances {
  totalLimit: Prisma.Decimal;
  usedAmount: Prisma.Decimal;
  reservedAmount: Prisma.Decimal;
  availableAmount: Prisma.Decimal;
}

export class InsufficientCreditError extends Error {
  constructor(
    readonly bucket: 'available' | 'reserved' | 'used',
    readonly available: Prisma.Decimal,
    readonly requested: Prisma.Decimal,
  ) {
    super(`Insufficient ${bucket} credit: ${available.toFixed(2)} < ${requested.toFixed(2)}`);
    this.name = 'InsufficientCreditError';
  }
}

const ZERO = new Prisma.Decimal(0);

export function zeroBalances(): CreditBalances {
  return { totalLimit: ZERO, usedAmount: ZERO, reservedAmount: ZERO, availableAmount: ZERO };
}

/**
 * Applies one ledger movement (amount always positive; the type is the
 * direction) and returns the new balances. Throws `InsufficientCreditError`
 * instead of letting any amount go negative. Pure: the ledger service and the
 * reconciliation (`replayCreditLedger`) share it, so both read the ledger the
 * same way.
 *
 *   CREDIT_ALLOCATION              total +a, available +a
 *   PURCHASE_RESERVE_HOLD          available −a, reserved +a
 *   PURCHASE_COMMIT                reserved −a, used +a
 *   RESERVATION_RELEASE            reserved −a, available +a
 *   INSTALLMENT_REPAYMENT_RESTORE  used −a, available +a
 *   REFUND_RESTORE                 used −a, available +a
 */
export function applyCreditMovement(balances: CreditBalances, type: CreditTransactionType, amount: Prisma.Decimal): CreditBalances {
  if (!amount.greaterThan(0)) {
    throw new Error(`Credit movement amount must be positive, got ${amount.toFixed(2)}`);
  }
  const take = (bucket: 'available' | 'reserved' | 'used', from: Prisma.Decimal): Prisma.Decimal => {
    if (from.lessThan(amount)) throw new InsufficientCreditError(bucket, from, amount);
    return from.minus(amount);
  };
  const b = balances;
  switch (type) {
    case CreditTransactionType.CREDIT_ALLOCATION:
      return { ...b, totalLimit: b.totalLimit.plus(amount), availableAmount: b.availableAmount.plus(amount) };
    case CreditTransactionType.PURCHASE_RESERVE_HOLD:
      return { ...b, availableAmount: take('available', b.availableAmount), reservedAmount: b.reservedAmount.plus(amount) };
    case CreditTransactionType.PURCHASE_COMMIT:
      return { ...b, reservedAmount: take('reserved', b.reservedAmount), usedAmount: b.usedAmount.plus(amount) };
    case CreditTransactionType.RESERVATION_RELEASE:
      return { ...b, reservedAmount: take('reserved', b.reservedAmount), availableAmount: b.availableAmount.plus(amount) };
    case CreditTransactionType.INSTALLMENT_REPAYMENT_RESTORE:
    case CreditTransactionType.REFUND_RESTORE:
      return { ...b, usedAmount: take('used', b.usedAmount), availableAmount: b.availableAmount.plus(amount) };
  }
}

/** True when totalLimit = used + reserved + available and nothing is negative. */
export function holdsInvariant(b: CreditBalances): boolean {
  const nonNegative = [b.totalLimit, b.usedAmount, b.reservedAmount, b.availableAmount].every((value) => !value.lessThan(0));
  return nonNegative && b.totalLimit.equals(b.usedAmount.plus(b.reservedAmount).plus(b.availableAmount));
}

/** Rebuilds the balances from ledger rows in chronological order (reconciliation / audit). */
export function replayCreditLedger(rows: ReadonlyArray<{ type: CreditTransactionType; amount: Prisma.Decimal }>): CreditBalances {
  return rows.reduce((balances, row) => applyCreditMovement(balances, row.type, row.amount), zeroBalances());
}

export type ReservationState = 'NONE' | 'HELD' | 'COMMITTED' | 'RELEASED';

/** State of one reservation from the types of the ledger rows carrying its reference. */
export function reservationStateOf(types: ReadonlyArray<CreditTransactionType>): ReservationState {
  if (types.includes(CreditTransactionType.PURCHASE_COMMIT)) return 'COMMITTED';
  if (types.includes(CreditTransactionType.RESERVATION_RELEASE)) return 'RELEASED';
  if (types.includes(CreditTransactionType.PURCHASE_RESERVE_HOLD)) return 'HELD';
  return 'NONE';
}

/**
 * Split of an order between credit and card for a credit-bearing method
 * (TM brief §3). Returns `{ rejected }` when the method does not apply:
 * - BANK_CREDIT: 100 % credit, only if available ≥ payable;
 * - HYBRID: creditAmount = the whole-rial part of available, cash = the rest;
 *   only when 0 < creditAmount < payable (otherwise BANK_CREDIT or card applies).
 */
export function splitPayment(
  method: 'BANK_CREDIT' | 'HYBRID',
  payable: Prisma.Decimal,
  available: Prisma.Decimal,
): { creditAmount: Prisma.Decimal; cashAmount: Prisma.Decimal } | { rejected: 'INSUFFICIENT_CREDIT' | 'HYBRID_NOT_REQUIRED' | 'AMOUNT_NOT_WHOLE_RIALS' } {
  if (!payable.isInteger() || !payable.greaterThan(0)) {
    return { rejected: 'AMOUNT_NOT_WHOLE_RIALS' };
  }
  if (method === 'BANK_CREDIT') {
    return available.greaterThanOrEqualTo(payable) ? { creditAmount: payable, cashAmount: ZERO } : { rejected: 'INSUFFICIENT_CREDIT' };
  }
  if (available.greaterThanOrEqualTo(payable)) {
    return { rejected: 'HYBRID_NOT_REQUIRED' };
  }
  const creditAmount = available.floor();
  if (!creditAmount.greaterThan(0)) {
    return { rejected: 'INSUFFICIENT_CREDIT' };
  }
  return { creditAmount, cashAmount: payable.minus(creditAmount) };
}
```

### `apps/backend/src/modules/credit/credit-order.service.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { InstallmentStatus, PaymentStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from './credit-ledger.service';
import { buildInstallmentSchedule, calendarDateToDb, platformDate } from './installment-math';
import { CreditProviderRegistry } from './providers/credit-provider.registry';

type Tx = Prisma.TransactionClient;

/** The credit part of a payment attempt (BANK_CREDIT or HYBRID). */
export interface CreditPart {
  id: string;
  parentOrderId: string;
  creditAmount: Prisma.Decimal;
  creditAccountId: string | null;
  creditReservationRef: string | null;
  installmentPlanId: string | null;
}

/**
 * A provider call that must happen after the database transaction committed
 * (the provider is an external system and cannot join the transaction).
 */
export interface ProviderFollowUp {
  paymentId: string;
  creditAccountId: string;
  reservationRef: string;
  action: 'COMMIT' | 'RELEASE';
}

export interface ScheduleSummary {
  installments: number;
  creditAmount: string;
  totalInterest: string;
  totalPayable: string;
  firstDueDate: string;
  lastDueDate: string;
}

export interface RepaymentApplication {
  applied: boolean;
  installmentStatus: InstallmentStatus;
  restoredPrincipal: string;
}

/**
 * Order-side credit operations shared by the card-payment callback, the BNPL
 * checkout and the order lifecycle. All `…Locked` methods run in the caller's
 * transaction, which must already hold the parent-order lock (or, for
 * repayments, nothing else: the instalment row is locked here).
 */
@Injectable()
export class CreditOrderService {
  private readonly logger = new Logger(CreditOrderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: CreditLedgerService,
    private readonly registry: CreditProviderRegistry,
  ) {}

  /**
   * The order is being paid: commit the reservation (reserved → used) and write
   * the instalment schedule of the chosen plan, in the same transaction.
   */
  async commitAndScheduleLocked(tx: Tx, part: CreditPart, paidAt: Date): Promise<{ followUp: ProviderFollowUp; schedule: ScheduleSummary }> {
    const { accountId, ref, planId } = requireCreditPart(part);
    await this.ledger.commit(tx, accountId, ref);
    const plan = await tx.installmentPlan.findUniqueOrThrow({ where: { id: planId }, select: { durationMonths: true, interestRatePercent: true } });
    const schedule = buildInstallmentSchedule({
      creditAmount: part.creditAmount,
      interestRatePercent: plan.interestRatePercent,
      durationMonths: plan.durationMonths,
      purchaseDate: platformDate(paidAt),
    });
    await tx.installmentSchedule.createMany({
      data: schedule.lines.map((line) => ({
        parentOrderId: part.parentOrderId,
        creditAccountId: accountId,
        installmentNumber: line.installmentNumber,
        totalInstallments: line.totalInstallments,
        dueDate: calendarDateToDb(line.dueDate),
        principalAmount: line.principalAmount,
        interestAmount: line.interestAmount,
        totalAmount: line.totalAmount,
        status: InstallmentStatus.PENDING,
      })),
    });
    return {
      followUp: { paymentId: part.id, creditAccountId: accountId, reservationRef: ref, action: 'COMMIT' },
      schedule: {
        installments: schedule.lines.length,
        creditAmount: schedule.creditAmount.toFixed(2),
        totalInterest: schedule.totalInterest.toFixed(2),
        totalPayable: schedule.totalPayable.toFixed(2),
        firstDueDate: schedule.lines[0]!.dueDate,
        lastDueDate: schedule.lines[schedule.lines.length - 1]!.dueDate,
      },
    };
  }

  /** Releases the reservation of one payment attempt if it is still held. */
  async releaseLocked(tx: Tx, part: CreditPart): Promise<ProviderFollowUp | null> {
    if (!part.creditAmount.greaterThan(0) || part.creditAccountId === null || part.creditReservationRef === null) {
      return null;
    }
    const released = await this.ledger.release(tx, part.creditAccountId, part.creditReservationRef);
    return released ? { paymentId: part.id, creditAccountId: part.creditAccountId, reservationRef: part.creditReservationRef, action: 'RELEASE' } : null;
  }

  /**
   * Releases every still-held reservation of an order's payment attempts
   * (order cancelled / expired, or paid by another attempt). Attempts whose
   * gateway session may still settle keep their status: a late capture is
   * then flagged for manual refund and never re-uses the released credit.
   */
  async releaseOpenReservationsLocked(tx: Tx, parentOrderId: string, exceptPaymentId?: string): Promise<ProviderFollowUp[]> {
    const attempts = await tx.payment.findMany({
      where: {
        parentOrderId,
        creditReservationRef: { not: null },
        status: { in: [PaymentStatus.INITIATED, PaymentStatus.FAILED] },
        ...(exceptPaymentId ? { id: { not: exceptPaymentId } } : {}),
      },
      select: { id: true, parentOrderId: true, creditAmount: true, creditAccountId: true, creditReservationRef: true, installmentPlanId: true },
      orderBy: { creditAccountId: 'asc' },
    });
    const followUps: ProviderFollowUp[] = [];
    for (const attempt of attempts) {
      const followUp = await this.releaseLocked(tx, attempt);
      if (followUp) followUps.push(followUp);
    }
    return followUps;
  }

  /**
   * A card payment for an instalment was verified: the instalment becomes PAID
   * and its principal returns to the credit line (INSTALLMENT_REPAYMENT_RESTORE).
   * `applied: false` when it was already paid (or waived) — the caller flags the
   * money for manual refund.
   */
  async applyRepaymentLocked(tx: Tx, installmentId: string, amountPaid: Prisma.Decimal, bank: { bankRrn: string | null; paidAt: Date }): Promise<RepaymentApplication> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`SELECT id FROM installment_schedules WHERE id = ${installmentId}::uuid FOR UPDATE`);
    if (rows.length !== 1) {
      throw new Error(`Instalment ${installmentId} does not exist`);
    }
    const installment = await tx.installmentSchedule.findUniqueOrThrow({
      where: { id: installmentId },
      select: { id: true, status: true, parentOrderId: true, creditAccountId: true, principalAmount: true, totalAmount: true, penaltyAmount: true, paidAmount: true },
    });
    if (installment.status !== InstallmentStatus.PENDING && installment.status !== InstallmentStatus.OVERDUE) {
      return { applied: false, installmentStatus: installment.status, restoredPrincipal: '0.00' };
    }
    const due = amountDue(installment);
    if (!amountPaid.equals(due)) {
      // The amount due is fixed at initiation; a mismatch means the instalment changed meanwhile.
      this.logger.error(`Instalment ${installmentId}: paid ${amountPaid.toFixed(2)} but ${due.toFixed(2)} is due; left unpaid for manual review`);
      return { applied: false, installmentStatus: installment.status, restoredPrincipal: '0.00' };
    }
    await tx.installmentSchedule.update({
      where: { id: installmentId },
      data: { status: InstallmentStatus.PAID, paidAmount: installment.paidAmount.plus(amountPaid), paidAt: bank.paidAt, bankTransactionId: bank.bankRrn },
    });
    const restored = await this.ledger.restoreRepayment(tx, installment.creditAccountId, installment.principalAmount, installment.id, installment.parentOrderId);
    return { applied: true, installmentStatus: InstallmentStatus.PAID, restoredPrincipal: restored ? installment.principalAmount.toFixed(2) : '0.00' };
  }

  /**
   * Performs the provider calls of committed transactions. A failure never
   * undoes the committed database state (the platform ledger is the record);
   * it is logged and stored on the payment (`metadata.providerSync`) for
   * reconciliation.
   */
  async followUp(actions: readonly ProviderFollowUp[]): Promise<void> {
    for (const action of actions) {
      try {
        const account = await this.prisma.creditAccount.findUniqueOrThrow({ where: { id: action.creditAccountId }, select: { providerId: true } });
        const adapter = await this.registry.adapterForProviderId(account.providerId);
        if (action.action === 'COMMIT') {
          await adapter.commitCredit(action.reservationRef);
        } else {
          await adapter.releaseCredit(action.reservationRef);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Provider ${action.action} of reservation ${action.reservationRef} (payment ${action.paymentId}) failed: ${message}`);
        await this.recordProviderSyncFailure(action, message);
      }
    }
  }

  private async recordProviderSyncFailure(action: ProviderFollowUp, message: string): Promise<void> {
    try {
      const payment = await this.prisma.payment.findUnique({ where: { id: action.paymentId }, select: { metadata: true } });
      const metadata = typeof payment?.metadata === 'object' && payment.metadata !== null && !Array.isArray(payment.metadata) ? payment.metadata : {};
      await this.prisma.payment.update({
        where: { id: action.paymentId },
        data: { metadata: { ...metadata, providerSync: { action: action.action, status: 'FAILED', message: message.slice(0, 300), at: new Date().toISOString() } } },
      });
    } catch (error) {
      this.logger.error(`Could not record the provider sync failure on payment ${action.paymentId}: ${String(error)}`);
    }
  }
}

/** What a customer owes for an instalment right now (penalties are not computed in Phase 8, so penaltyAmount is 0). */
export function amountDue(installment: { totalAmount: Prisma.Decimal; penaltyAmount: Prisma.Decimal; paidAmount: Prisma.Decimal }): Prisma.Decimal {
  return installment.totalAmount.plus(installment.penaltyAmount).minus(installment.paidAmount);
}

function requireCreditPart(part: CreditPart): { accountId: string; ref: string; planId: string } {
  if (!part.creditAmount.greaterThan(0) || part.creditAccountId === null || part.creditReservationRef === null || part.installmentPlanId === null) {
    throw new Error(`Payment ${part.id} has no credit part`);
  }
  return { accountId: part.creditAccountId, ref: part.creditReservationRef, planId: part.installmentPlanId };
}
```

### `apps/backend/src/modules/credit/credit-views.ts`

```ts
import { InstallmentStatus, Prisma, type PrismaClient } from '@prisma/client';
import type { CreditAccountDto, CreditApplicationDto, CreditProviderSummaryDto, CreditUserSummaryDto, OutstandingInstallmentsDto } from './dto/credit.dto';
import { dbDateToCalendar } from './installment-math';
import { SANDBOX_BANK_CODE } from './providers/sandbox-bank.provider';

type Db = PrismaClient | Prisma.TransactionClient;

export const accountSelect = {
  id: true,
  status: true,
  totalLimit: true,
  usedAmount: true,
  reservedAmount: true,
  availableAmount: true,
  expiresAt: true,
  createdAt: true,
  provider: { select: { code: true, name: true } },
} satisfies Prisma.CreditAccountSelect;

export type AccountRow = Prisma.CreditAccountGetPayload<{ select: typeof accountSelect }>;

export const applicationSelect = {
  id: true,
  status: true,
  requestedLimit: true,
  approvedLimit: true,
  bankApplicationTrackingCode: true,
  bankScoreResponse: true,
  decisionReason: true,
  decidedAt: true,
  createdAt: true,
  userId: true,
  providerId: true,
  provider: { select: { code: true, name: true } },
} satisfies Prisma.CreditApplicationSelect;

export type ApplicationRow = Prisma.CreditApplicationGetPayload<{ select: typeof applicationSelect }>;

export const userSummarySelect = { id: true, fullName: true, mobile: true, nationalCode: true } satisfies Prisma.UserSelect;

export function providerSummary(provider: { code: string; name: string }): CreditProviderSummaryDto {
  return { code: provider.code, name: provider.name, isSandbox: provider.code === SANDBOX_BANK_CODE };
}

export function maskNationalCode(nationalCode: string | null): string | null {
  return nationalCode === null ? null : `******${nationalCode.slice(-4)}`;
}

export function userSummary(user: Prisma.UserGetPayload<{ select: typeof userSummarySelect }>): CreditUserSummaryDto {
  return { id: user.id, fullName: user.fullName, mobile: user.mobile, nationalCodeMasked: maskNationalCode(user.nationalCode) };
}

const EMPTY_OUTSTANDING: OutstandingInstallmentsDto = { count: 0, overdueCount: 0, principal: '0.00', interest: '0.00', nextDueDate: null };

/** Unpaid-instalment summary per credit account. */
export async function outstandingByAccount(db: Db, accountIds: readonly string[]): Promise<Map<string, OutstandingInstallmentsDto>> {
  const result = new Map<string, OutstandingInstallmentsDto>();
  if (accountIds.length === 0) return result;
  const rows = await db.installmentSchedule.groupBy({
    by: ['creditAccountId', 'status'],
    where: { creditAccountId: { in: [...accountIds] }, status: { in: [InstallmentStatus.PENDING, InstallmentStatus.OVERDUE] } },
    _count: { _all: true },
    _sum: { principalAmount: true, interestAmount: true },
    _min: { dueDate: true },
  });
  for (const row of rows) {
    const current = result.get(row.creditAccountId) ?? { ...EMPTY_OUTSTANDING };
    const minDue = row._min.dueDate ? dbDateToCalendar(row._min.dueDate) : null;
    result.set(row.creditAccountId, {
      count: current.count + row._count._all,
      overdueCount: current.overdueCount + (row.status === InstallmentStatus.OVERDUE ? row._count._all : 0),
      principal: new Prisma.Decimal(current.principal).plus(row._sum.principalAmount ?? 0).toFixed(2),
      interest: new Prisma.Decimal(current.interest).plus(row._sum.interestAmount ?? 0).toFixed(2),
      nextDueDate: current.nextDueDate === null || (minDue !== null && minDue < current.nextDueDate) ? minDue : current.nextDueDate,
    });
  }
  return result;
}

export function toAccountDto(row: AccountRow, outstanding: Map<string, OutstandingInstallmentsDto>): CreditAccountDto {
  return {
    id: row.id,
    provider: providerSummary(row.provider),
    status: row.status,
    totalLimit: row.totalLimit.toFixed(2),
    usedAmount: row.usedAmount.toFixed(2),
    reservedAmount: row.reservedAmount.toFixed(2),
    availableAmount: row.availableAmount.toFixed(2),
    currency: 'IRR',
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    outstanding: outstanding.get(row.id) ?? { ...EMPTY_OUTSTANDING },
  };
}

export function toApplicationDto(row: ApplicationRow, account: CreditAccountDto | null): CreditApplicationDto {
  const response = typeof row.bankScoreResponse === 'object' && row.bankScoreResponse !== null && !Array.isArray(row.bankScoreResponse) ? row.bankScoreResponse : {};
  const inquiry = typeof response['inquiry'] === 'object' && response['inquiry'] !== null && !Array.isArray(response['inquiry']) ? response['inquiry'] : {};
  const score = inquiry['score'];
  return {
    id: row.id,
    status: row.status,
    provider: providerSummary(row.provider),
    requestedLimit: row.requestedLimit.toFixed(2),
    approvedLimit: row.approvedLimit?.toFixed(2) ?? null,
    trackingCode: row.bankApplicationTrackingCode,
    score: typeof score === 'number' ? score : null,
    decisionReason: row.decisionReason,
    decidedAt: row.decidedAt,
    createdAt: row.createdAt,
    account,
  };
}
```

### `apps/backend/src/modules/credit/credit.controller.ts`

```ts
import { Body, Controller, Get, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { CreditService, MAX_APPLICATIONS_PER_DAY } from './credit.service';
import { CreateCreditApplicationDto, CreditAccountDto, CreditApplicationDto, CreditPlansResponseDto } from './dto/credit.dto';

@ApiTags('credit')
@Controller('credit')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Post('applications')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth('access-token')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Apply for a credit line (BNPL) with the active provider',
    description:
      'Validates the national code (checksum), runs the provider’s eligibility/score inquiry and submits the application. ' +
      'The result is stored as a CreditApplication (APPROVED, REJECTED with `decisionReason`, or DOCS_REQUIRED). On approval a ' +
      'CreditAccount is opened with totalLimit = available = approvedLimit and a CREDIT_ALLOCATION ledger row, and the national ' +
      `code is saved to the profile — all in one transaction. At most ${MAX_APPLICATIONS_PER_DAY} applications per customer per 24 hours. ` +
      'With SANDBOX_BANK (development only) the decision is instant and derived deterministically from the national code; no real bank is contacted.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreditApplicationDto, description: 'The recorded application (also when REJECTED).' })
  @ApiBadRequestResponse({ description: 'Validation error (national code checksum, whole-rial limit) or INVALID_DOCUMENTS' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiConflictResponse({
    description: 'CREDIT_PROVIDER_NOT_ACTIVE, CREDIT_ACCOUNT_EXISTS, NATIONAL_CODE_MISMATCH, NATIONAL_CODE_IN_USE or CREDIT_APPLICATION_IN_PROGRESS',
  })
  @ApiTooManyRequestsResponse({ description: 'Daily application quota exhausted' })
  @ApiBadGatewayResponse({ description: 'CREDIT_PROVIDER_UNAVAILABLE: the provider did not answer (nothing recorded)' })
  @ApiServiceUnavailableResponse({ description: 'CREDIT_DISABLED, CREDIT_PROVIDER_UNAVAILABLE / NOT_IMPLEMENTED / MISCONFIGURED / NOT_ALLOWED' })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCreditApplicationDto,
    @ClientContext() context: RequestContext,
  ): Promise<CreditApplicationDto> {
    return this.credit.apply(user.id, dto, { actorId: user.id, context });
  }

  @Get('account')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'My credit line',
    description: 'totalLimit, used, reserved and available (invariant totalLimit = used + reserved + available), status, provider and unpaid instalments.',
  })
  @ApiOkResponse({ type: CreditAccountDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiNotFoundResponse({ description: 'CREDIT_ACCOUNT_NOT_FOUND' })
  account(@CurrentUser() user: AuthenticatedUser): Promise<CreditAccountDto> {
    return this.credit.account(user.id);
  }

  @Get('plans')
  @Public()
  @ApiOperation({
    summary: 'Instalment plans on offer',
    description:
      'Active plans of the active credit provider. Empty when `credit.enabled` is false, no provider is active, or the active ' +
      'provider has no integration in this build. Interest (Option A): totalInterest = floor(creditAmount × interestRatePercent / 100), ' +
      'principal and interest split evenly in whole rials with the remainder on the last instalment, due every 30 days.',
  })
  @ApiOkResponse({ type: CreditPlansResponseDto })
  @ApiServiceUnavailableResponse({ description: 'CREDIT_PROVIDER_MISCONFIGURED: the active provider’s configuration is invalid' })
  plans(): Promise<CreditPlansResponseDto> {
    return this.credit.plans();
  }
}
```

### `apps/backend/src/modules/credit/credit.module.ts`

```ts
import { Module } from '@nestjs/common';
import { AdminCreditController } from './admin-credit.controller';
import { AdminCreditService } from './admin-credit.service';
import { CreditLedgerService } from './credit-ledger.service';
import { CreditOrderService } from './credit-order.service';
import { CreditController } from './credit.controller';
import { CreditService } from './credit.service';
import { CreditProviderRegistry } from './providers/credit-provider.registry';

/**
 * Credit engine core: provider registry (adapters resolved from the database),
 * the credit ledger, applications/accounts/plans and the order-side credit
 * operations. It depends on no other feature module, so Orders, Payments and
 * BNPL can import it without cycles.
 */
@Module({
  controllers: [CreditController, AdminCreditController],
  providers: [CreditProviderRegistry, CreditLedgerService, CreditOrderService, CreditService, AdminCreditService],
  exports: [CreditProviderRegistry, CreditLedgerService, CreditOrderService],
})
export class CreditModule {}
```

### `apps/backend/src/modules/credit/credit.service.ts`

```ts
import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { AuditAction, CreditApplicationStatus, MediaKind, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { normalizeNationalCode } from '../../common/validators/iranian-national-code';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { CreditLedgerService } from './credit-ledger.service';
import { accountSelect, applicationSelect, outstandingByAccount, providerSummary, toAccountDto, toApplicationDto } from './credit-views';
import type { CreateCreditApplicationDto, CreditAccountDto, CreditApplicationDto, CreditPlansResponseDto } from './dto/credit.dto';
import { INSTALLMENT_INTERVAL_DAYS } from './installment-math';
import { CreditProviderError, type ApplicationDecision, type ApplicationDocument, type EligibilityResult } from './providers/credit-provider.interface';
import { CreditProviderRegistry } from './providers/credit-provider.registry';

/** Credit applications one customer may submit per rolling day (each one is a bank inquiry). */
export const MAX_APPLICATIONS_PER_DAY = 5;
const DAY_SECONDS = 24 * 60 * 60;
const APPLY_LOCK_MS = 60_000;

export const creditApplyCountKey = (userId: string): string => `credit:apply:count:${userId}`;
export const creditApplyLockKey = (userId: string): string => `credit:apply:lock:${userId}`;

/**
 * Customer side of the credit engine: applying for a credit line, reading it,
 * and the instalment plans on offer.
 *
 * Application flow (TM brief §1): validate → provider eligibility inquiry →
 * provider application → one transaction that records the CreditApplication and,
 * when approved, opens the CreditAccount with its CREDIT_ALLOCATION ledger row
 * (and saves the verified national code to the profile). Provider calls run
 * outside the transaction under a per-customer Redis lock, so parallel
 * submissions cannot race; the (user, provider) unique key backs it up.
 */
@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly registry: CreditProviderRegistry,
    private readonly ledger: CreditLedgerService,
  ) {}

  async apply(userId: string, dto: CreateCreditApplicationDto, actor: OrderActor): Promise<CreditApplicationDto> {
    await this.registry.assertEnabled();
    await this.consumeDailyQuota(userId);
    const lockToken = randomUUID();
    const locked = await this.redis.client.set(creditApplyLockKey(userId), lockToken, 'PX', APPLY_LOCK_MS, 'NX');
    if (locked !== 'OK') {
      throw conflictWith('CREDIT_APPLICATION_IN_PROGRESS', 'Another credit application of yours is being processed');
    }
    try {
      return await this.applyLocked(userId, dto, actor);
    } finally {
      const holder = await this.redis.client.get(creditApplyLockKey(userId));
      if (holder === lockToken) await this.redis.client.del(creditApplyLockKey(userId));
    }
  }

  private async applyLocked(userId: string, dto: CreateCreditApplicationDto, actor: OrderActor): Promise<CreditApplicationDto> {
    const provider = await this.registry.requireActiveProvider();
    if (provider.code !== dto.providerCode) {
      throw conflictWith('CREDIT_PROVIDER_NOT_ACTIVE', `Credit provider ${dto.providerCode} is not available; apply with the active provider`, {
        activeProvider: provider.code,
      });
    }
    const adapter = this.registry.adapterFor(provider);
    const nationalCode = normalizeNationalCode(dto.nationalCode);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { mobile: true, nationalCode: true } });
    if (user.nationalCode !== null && user.nationalCode !== nationalCode) {
      throw conflictWith('NATIONAL_CODE_MISMATCH', 'The national code differs from the one on your profile');
    }
    if (user.nationalCode === null) {
      const owner = await this.prisma.user.findUnique({ where: { nationalCode }, select: { id: true } });
      if (owner && owner.id !== userId) {
        throw conflictWith('NATIONAL_CODE_IN_USE', 'This national code belongs to another account');
      }
    }
    const existing = await this.prisma.creditAccount.findUnique({ where: { userId_providerId: { userId, providerId: provider.id } }, select: { id: true, status: true } });
    if (existing) {
      throw conflictWith('CREDIT_ACCOUNT_EXISTS', 'You already have a credit account with this provider', { accountId: existing.id, accountStatus: existing.status });
    }
    const docs = await this.resolveDocuments(userId, dto.documentIds ?? []);
    const requestedLimit = new Prisma.Decimal(dto.requestedLimit);

    let eligibility: EligibilityResult;
    let decision: ApplicationDecision | null = null;
    try {
      eligibility = await adapter.inquireEligibility(nationalCode, user.mobile);
      if (eligibility.eligible) {
        decision = await adapter.submitApplication(userId, requestedLimit, docs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = error instanceof CreditProviderError ? error.code : 'PROVIDER_ERROR';
      this.logger.warn(`Credit provider ${provider.code} failed for user ${userId}: ${message}`);
      throw new BadGatewayException({ statusCode: 502, error: 'Bad Gateway', code: 'CREDIT_PROVIDER_UNAVAILABLE', message: 'The credit provider did not answer; try again later', providerCode: code });
    }

    const approvedLimit = decision?.status === 'APPROVED' && decision.approvedLimit?.greaterThan(0) && decision.approvedLimit.isInteger() ? decision.approvedLimit : null;
    const status: CreditApplicationStatus =
      approvedLimit !== null
        ? CreditApplicationStatus.APPROVED
        : decision?.status === 'DOCS_REQUIRED'
          ? CreditApplicationStatus.DOCS_REQUIRED
          : CreditApplicationStatus.REJECTED;
    const decisionReason = eligibility.eligible ? (decision?.reason ?? null) : (eligibility.reason ?? 'NOT_ELIGIBLE');
    const bankScoreResponse = {
      inquiry: { ref: eligibility.inquiryRef, eligible: eligibility.eligible, score: eligibility.score, reason: eligibility.reason, details: eligibility.details },
      ...(decision
        ? { decision: { status: decision.status, trackingCode: decision.trackingCode, approvedLimit: decision.approvedLimit?.toFixed(2) ?? null, reason: decision.reason, details: decision.details } }
        : {}),
    };

    try {
      const applicationId = await this.prisma.$transaction(async (tx) => {
        const application = await tx.creditApplication.create({
          data: {
            userId,
            providerId: provider.id,
            requestedLimit,
            approvedLimit,
            status,
            bankApplicationTrackingCode: decision?.trackingCode ?? null,
            bankScoreResponse: bankScoreResponse as Prisma.InputJsonValue,
            decisionReason,
            decidedAt: status === CreditApplicationStatus.DOCS_REQUIRED ? null : new Date(),
          },
          select: { id: true },
        });
        let accountId: string | null = null;
        if (approvedLimit !== null) {
          accountId = await this.ledger.openAccount(tx, { userId, providerId: provider.id, limit: approvedLimit, applicationId: application.id, expiresAt: null });
          if (user.nationalCode === null) {
            await tx.user.update({ where: { id: userId }, data: { nationalCode } });
          }
        }
        await writeOrderAudit(tx, actor, {
          action: AuditAction.CREDIT_DECISION,
          entityName: 'CreditApplication',
          entityId: application.id,
          newValue: {
            status,
            providerCode: provider.code,
            requestedLimit: requestedLimit.toFixed(2),
            approvedLimit: approvedLimit?.toFixed(2) ?? null,
            score: eligibility.score,
            decisionReason,
            trackingCode: decision?.trackingCode ?? null,
            ...(accountId ? { creditAccountId: accountId } : {}),
          },
        });
        return application.id;
      });
      return await this.applicationDto(applicationId);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // A concurrent request recorded first (unique account per provider / unique national code).
        const rawTarget: unknown = error.meta?.['target'];
        const target = Array.isArray(rawTarget) ? rawTarget.map(String).join(',') : typeof rawTarget === 'string' ? rawTarget : '';
        throw target.includes('national_code')
          ? conflictWith('NATIONAL_CODE_IN_USE', 'This national code belongs to another account')
          : conflictWith('CREDIT_ACCOUNT_EXISTS', 'You already have a credit account with this provider');
      }
      throw error;
    }
  }

  /** The customer's credit line at the active provider (or, if none, their most recent one). */
  async account(userId: string): Promise<CreditAccountDto> {
    const active = await this.registry.findActiveProvider();
    const row =
      (active ? await this.prisma.creditAccount.findUnique({ where: { userId_providerId: { userId, providerId: active.id } }, select: accountSelect }) : null) ??
      (await this.prisma.creditAccount.findFirst({ where: { userId }, select: accountSelect, orderBy: { createdAt: 'desc' } }));
    if (!row) {
      throw new NotFoundException({ statusCode: 404, error: 'Not Found', code: 'CREDIT_ACCOUNT_NOT_FOUND', message: 'You have no credit account; apply first' });
    }
    return toAccountDto(row, await outstandingByAccount(this.prisma, [row.id]));
  }

  /** Active instalment plans of the active provider; empty when credit is disabled or the provider has no integration. */
  async plans(): Promise<CreditPlansResponseDto> {
    const creditEnabled = await this.registry.isEnabled();
    const provider = await this.registry.findActiveProvider();
    if (!provider) {
      return { creditEnabled, provider: null, items: [] };
    }
    const summary = providerSummary(provider);
    if (!creditEnabled || !this.registry.isImplemented(provider.code)) {
      return { creditEnabled, provider: summary, items: [] };
    }
    this.registry.adapterFor(provider); // 503 when the provider's configuration is invalid
    const plans = await this.prisma.installmentPlan.findMany({
      where: { providerId: provider.id, isActive: true },
      select: { id: true, title: true, durationMonths: true, interestRatePercent: true, penaltyRatePercentPerMonth: true },
      orderBy: { durationMonths: 'asc' },
    });
    return {
      creditEnabled,
      provider: summary,
      items: plans.map((plan) => ({
        id: plan.id,
        title: plan.title,
        durationMonths: plan.durationMonths,
        interestRatePercent: plan.interestRatePercent.toFixed(2),
        penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth.toFixed(2),
        installmentIntervalDays: INSTALLMENT_INTERVAL_DAYS,
      })),
    };
  }

  private async applicationDto(applicationId: string): Promise<CreditApplicationDto> {
    const row = await this.prisma.creditApplication.findUniqueOrThrow({ where: { id: applicationId }, select: applicationSelect });
    let account: CreditAccountDto | null = null;
    if (row.status === CreditApplicationStatus.APPROVED) {
      const accountRow = await this.prisma.creditAccount.findUnique({ where: { userId_providerId: { userId: row.userId, providerId: row.providerId } }, select: accountSelect });
      if (accountRow) account = toAccountDto(accountRow, await outstandingByAccount(this.prisma, [accountRow.id]));
    }
    return toApplicationDto(row, account);
  }

  private async resolveDocuments(userId: string, documentIds: readonly string[]): Promise<ApplicationDocument[]> {
    const unique = [...new Set(documentIds)];
    if (unique.length === 0) return [];
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: unique }, ownerUserId: userId, kind: MediaKind.DOCUMENT },
      select: { id: true, mimeType: true, sizeBytes: true },
    });
    if (assets.length !== unique.length) {
      throw badRequestWith('INVALID_DOCUMENTS', 'Every document must be a document you uploaded');
    }
    return assets.map((asset) => ({ mediaAssetId: asset.id, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes }));
  }

  private async consumeDailyQuota(userId: string): Promise<void> {
    const key = creditApplyCountKey(userId);
    const count = await this.redis.client.incr(key);
    if (count === 1) await this.redis.client.expire(key, DAY_SECONDS);
    if (count > MAX_APPLICATIONS_PER_DAY) {
      const ttl = await this.redis.client.ttl(key);
      throw new TooManyRequestsException('Too many credit applications; try again later', ttl > 0 ? ttl : DAY_SECONDS);
    }
  }
}
```

### `apps/backend/src/modules/credit/dto/credit.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CreditAccountStatus, CreditApplicationStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsPositive, IsString, IsUUID, Matches, Max, MaxLength } from 'class-validator';
import { IsIranianNationalCode } from '../../../common/validators/is-iranian-national-code.decorator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { MONEY } from '../../wallet/dto/wallet.dto';

const upperTrim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim().toUpperCase() : value);
/** Whole rials that fit DECIMAL(15,2). */
const MAX_WHOLE_RIALS = 9_999_999_999_999;
const PROVIDER_CODE = /^[A-Z0-9_]{2,40}$/;

// ─── input ──────────────────────────────────────────────────────────────────

export class CreateCreditApplicationDto {
  @ApiProperty({ example: 200000000, description: 'Requested credit limit in whole IRR (Shaparak has no fractional unit).' })
  @IsInt()
  @IsPositive()
  @Max(MAX_WHOLE_RIALS)
  requestedLimit!: number;

  @ApiProperty({
    example: '0499370899',
    description: 'Applicant national code (10 digits, checksum-validated). Must match the profile if one is set; otherwise it is saved to the profile on approval.',
  })
  @IsIranianNationalCode()
  nationalCode!: string;

  @ApiProperty({ example: 'SANDBOX_BANK', description: 'Code of the credit provider; must be the active provider (`GET /credit/plans`).' })
  @Transform(upperTrim)
  @IsString()
  @Matches(PROVIDER_CODE, { message: 'providerCode must be an upper-case provider code' })
  providerCode!: string;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: 10,
    description: 'Supporting documents the customer uploaded with `POST /media/upload/document` (forwarded to the provider).',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsUUID('4', { each: true })
  documentIds?: string[];
}

export class AdminCreditApplicationsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CreditApplicationStatus })
  @IsOptional()
  @IsEnum(CreditApplicationStatus)
  status?: CreditApplicationStatus;

  @ApiPropertyOptional({ example: 'SANDBOX_BANK' })
  @IsOptional()
  @Transform(upperTrim)
  @Matches(PROVIDER_CODE)
  providerCode?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;
}

export class AdminCreditAccountsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: CreditAccountStatus })
  @IsOptional()
  @IsEnum(CreditAccountStatus)
  status?: CreditAccountStatus;

  @ApiPropertyOptional({ example: 'SANDBOX_BANK' })
  @IsOptional()
  @Transform(upperTrim)
  @Matches(PROVIDER_CODE)
  providerCode?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Search by mobile or full name', maxLength: 60 })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  search?: string;
}

// ─── output ─────────────────────────────────────────────────────────────────

export class CreditProviderSummaryDto {
  @ApiProperty({ example: 'SANDBOX_BANK' }) code!: string;
  @ApiProperty({ example: 'بانک آزمایشی (Sandbox)' }) name!: string;
  @ApiProperty({ description: 'True for a development/test provider: no real credit, no money moves.' }) isSandbox!: boolean;
}

export class OutstandingInstallmentsDto {
  @ApiProperty({ description: 'Unpaid instalments (PENDING or OVERDUE).' }) count!: number;
  @ApiProperty({ description: 'Of which OVERDUE.' }) overdueCount!: number;
  @ApiProperty({ ...MONEY, description: 'Unpaid principal (equals usedAmount).' }) principal!: string;
  @ApiProperty({ ...MONEY, description: 'Unpaid interest (financing fee).' }) interest!: string;
  @ApiProperty({ nullable: true, type: String, example: '2026-10-27', description: 'Earliest unpaid due date.' }) nextDueDate!: string | null;
}

export class CreditAccountDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: CreditProviderSummaryDto }) provider!: CreditProviderSummaryDto;
  @ApiProperty({ enum: CreditAccountStatus }) status!: CreditAccountStatus;
  @ApiProperty({ ...MONEY, description: 'Invariant: totalLimit = usedAmount + reservedAmount + availableAmount.' }) totalLimit!: string;
  @ApiProperty({ ...MONEY, description: 'Principal of committed credit purchases not repaid yet.' }) usedAmount!: string;
  @ApiProperty({ ...MONEY, description: 'Held by checkouts awaiting completion.' }) reservedAmount!: string;
  @ApiProperty(MONEY) availableAmount!: string;
  @ApiProperty({ example: 'IRR' }) currency!: string;
  @ApiProperty({ nullable: true, type: Date }) expiresAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: OutstandingInstallmentsDto }) outstanding!: OutstandingInstallmentsDto;
}

export class CreditApplicationDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: CreditApplicationStatus }) status!: CreditApplicationStatus;
  @ApiProperty({ type: CreditProviderSummaryDto }) provider!: CreditProviderSummaryDto;
  @ApiProperty(MONEY) requestedLimit!: string;
  @ApiProperty({ ...MONEY, nullable: true }) approvedLimit!: string | null;
  @ApiProperty({ nullable: true, type: String, example: 'SBXA-1F2E3D4C5B6A7980' }) trackingCode!: string | null;
  @ApiProperty({ nullable: true, type: Number, example: 712, description: 'Credit score reported by the provider (if disclosed).' }) score!: number | null;
  @ApiProperty({ nullable: true, type: String, example: 'SCORE_BELOW_THRESHOLD' }) decisionReason!: string | null;
  @ApiProperty({ nullable: true, type: Date }) decidedAt!: Date | null;
  @ApiProperty() createdAt!: Date;
  @ApiProperty({ type: CreditAccountDto, nullable: true, description: 'The credit line opened by an APPROVED application.' })
  account!: CreditAccountDto | null;
}

export class InstallmentPlanDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'خرید اعتباری ۶ ماهه' }) title!: string;
  @ApiProperty({ example: 6 }) durationMonths!: number;
  @ApiProperty({ example: '9.00', description: 'Total interest rate of the whole plan duration (%). totalInterest = floor(creditAmount × rate / 100).' })
  interestRatePercent!: string;
  @ApiProperty({ example: '2.00', description: 'Late-payment penalty rate per month (%). Not applied automatically in this phase.' })
  penaltyRatePercentPerMonth!: string;
  @ApiProperty({ example: 30, description: 'Days between instalments.' }) installmentIntervalDays!: number;
}

export class CreditPlansResponseDto {
  @ApiProperty({ description: '`credit.enabled`: when false no credit purchase can start and `items` is empty.' }) creditEnabled!: boolean;
  @ApiProperty({ type: CreditProviderSummaryDto, nullable: true }) provider!: CreditProviderSummaryDto | null;
  @ApiProperty({ type: [InstallmentPlanDto] }) items!: InstallmentPlanDto[];
}

export class CreditUserSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ example: '+989121234567' }) mobile!: string;
  @ApiProperty({ nullable: true, type: String, example: '******0899', description: 'Masked national code (last 4 digits).' }) nationalCodeMasked!: string | null;
}

export class AdminCreditApplicationDto extends CreditApplicationDto {
  @ApiProperty({ type: CreditUserSummaryDto }) user!: CreditUserSummaryDto;
}

export class AdminCreditApplicationPageDto {
  @ApiProperty({ type: [AdminCreditApplicationDto] }) items!: AdminCreditApplicationDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
}

export class AdminCreditAccountDto extends CreditAccountDto {
  @ApiProperty({ type: CreditUserSummaryDto }) user!: CreditUserSummaryDto;
}

export class CreditExposureDto {
  @ApiProperty({ description: 'Accounts matching the filters.' }) accounts!: number;
  @ApiProperty(MONEY) totalLimit!: string;
  @ApiProperty({ ...MONEY, description: 'Outstanding principal (sum of usedAmount).' }) used!: string;
  @ApiProperty(MONEY) reserved!: string;
  @ApiProperty(MONEY) available!: string;
  @ApiProperty({ ...MONEY, description: 'Unpaid principal + interest of all unpaid instalments.' }) outstandingInstallments!: string;
  @ApiProperty() overdueInstallments!: number;
  @ApiProperty({ ...MONEY, description: 'Amount due of OVERDUE instalments.' }) overdueAmount!: string;
  @ApiProperty({ description: 'True when every account satisfies totalLimit = used + reserved + available and equals the replay of its ledger.' })
  ledgerConsistent!: boolean;
  @ApiProperty({ description: 'Accounts whose balances do not match their ledger (should always be 0).' }) inconsistentAccounts!: number;
}

export class AdminCreditAccountPageDto {
  @ApiProperty({ type: [AdminCreditAccountDto] }) items!: AdminCreditAccountDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty({ type: CreditExposureDto, description: 'Aggregated exposure over all accounts matching the filters (not only this page).' })
  exposure!: CreditExposureDto;
}
```

### `apps/backend/src/modules/credit/installment-math.spec.ts`

```ts
import { Prisma } from '@prisma/client';
import { addDays, buildInstallmentSchedule, calendarDateToDb, dbDateToCalendar, InstallmentMathError, platformDate } from './installment-math';

const D = (value: string | number): Prisma.Decimal => new Prisma.Decimal(value);

function sum(values: Prisma.Decimal[]): Prisma.Decimal {
  return values.reduce((acc, value) => acc.plus(value), D(0));
}

describe('buildInstallmentSchedule (Option A, whole rials)', () => {
  it('splits an evenly divisible amount into equal instalments with no interest (3-month plan, 0%)', () => {
    const schedule = buildInstallmentSchedule({ creditAmount: D(3_000_000), interestRatePercent: D(0), durationMonths: 3, purchaseDate: '2026-09-27' });
    expect(schedule.lines.map((l) => l.principalAmount.toFixed(0))).toEqual(['1000000', '1000000', '1000000']);
    expect(schedule.lines.every((l) => l.interestAmount.isZero())).toBe(true);
    expect(schedule.totalInterest.toFixed(0)).toBe('0');
    expect(schedule.totalPayable.toFixed(0)).toBe('3000000');
  });

  it('puts the principal and interest remainders on the last instalment; sums are exact', () => {
    // 1,000,001 over 6 months at 9%: interest = floor(90,000.09) = 90,000
    const schedule = buildInstallmentSchedule({ creditAmount: D(1_000_001), interestRatePercent: D('9.00'), durationMonths: 6, purchaseDate: '2026-09-27' });
    expect(schedule.totalInterest.toFixed(0)).toBe('90000');
    expect(schedule.lines).toHaveLength(6);
    expect(schedule.lines.slice(0, 5).every((l) => l.principalAmount.equals(166_666))).toBe(true);
    expect(schedule.lines[5]!.principalAmount.toFixed(0)).toBe('166671');
    expect(schedule.lines.every((l) => l.interestAmount.equals(15_000))).toBe(true);
    expect(sum(schedule.lines.map((l) => l.principalAmount)).equals(1_000_001)).toBe(true);
    expect(sum(schedule.lines.map((l) => l.interestAmount)).equals(schedule.totalInterest)).toBe(true);
    expect(sum(schedule.lines.map((l) => l.totalAmount)).equals(schedule.totalPayable)).toBe(true);
  });

  it('rounds the total interest down (customer-favourable) and keeps every amount whole', () => {
    // 12-month 18% on 7,777,777: 1,399,999.86 → 1,399,999
    const schedule = buildInstallmentSchedule({ creditAmount: D(7_777_777), interestRatePercent: D('18.00'), durationMonths: 12, purchaseDate: '2026-01-15' });
    expect(schedule.totalInterest.toFixed(0)).toBe('1399999');
    for (const line of schedule.lines) {
      expect(line.principalAmount.isInteger() && line.interestAmount.isInteger() && line.totalAmount.isInteger()).toBe(true);
      expect(line.totalAmount.equals(line.principalAmount.plus(line.interestAmount))).toBe(true);
    }
    expect(sum(schedule.lines.map((l) => l.principalAmount)).equals(7_777_777)).toBe(true);
  });

  it('holds the exact-sum property over many amounts and plans', () => {
    for (const months of [1, 3, 6, 12]) {
      for (const rate of ['0', '9', '18', '12.5']) {
        for (const amount of [1, 2, 11, 999_999, 1_234_567, 100_000_000]) {
          const s = buildInstallmentSchedule({ creditAmount: D(amount), interestRatePercent: D(rate), durationMonths: months, purchaseDate: '2026-02-01' });
          expect(sum(s.lines.map((l) => l.principalAmount)).equals(amount)).toBe(true);
          expect(sum(s.lines.map((l) => l.interestAmount)).equals(s.totalInterest)).toBe(true);
          expect(s.lines.every((l) => !l.principalAmount.lessThan(0))).toBe(true);
        }
      }
    }
  });

  it('dates instalment k at purchase date + 30·k days, across month and year ends', () => {
    const schedule = buildInstallmentSchedule({ creditAmount: D(600), interestRatePercent: D(0), durationMonths: 6, purchaseDate: '2026-11-20' });
    expect(schedule.lines.map((l) => l.dueDate)).toEqual(['2026-12-20', '2027-01-19', '2027-02-18', '2027-03-20', '2027-04-19', '2027-05-19']);
    expect(schedule.lines.map((l) => `${l.installmentNumber}/${l.totalInstallments}`)).toEqual(['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']);
  });

  it('rejects fractional or non-positive amounts, bad durations and negative rates', () => {
    const base = { interestRatePercent: D(0), durationMonths: 3, purchaseDate: '2026-09-27' };
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D('100.50') })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(0) })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(100), durationMonths: 0 })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(100), interestRatePercent: D(-1) })).toThrow(InstallmentMathError);
    expect(() => buildInstallmentSchedule({ ...base, creditAmount: D(100), purchaseDate: '27/09/2026' })).toThrow(InstallmentMathError);
  });
});

describe('calendar helpers', () => {
  it('platformDate uses the Asia/Tehran calendar day', () => {
    // 21:00 UTC on 27 Sep is already 28 Sep in Tehran (UTC+03:30).
    expect(platformDate(new Date('2026-09-27T21:00:00Z'))).toBe('2026-09-28');
    expect(platformDate(new Date('2026-09-27T19:00:00Z'))).toBe('2026-09-27');
  });

  it('addDays is pure calendar arithmetic (leap years included)', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-12-31', 30)).toBe('2027-01-30');
  });

  it('round-trips calendar dates through the DB representation', () => {
    expect(dbDateToCalendar(calendarDateToDb('2026-10-27'))).toBe('2026-10-27');
  });
});
```

### `apps/backend/src/modules/credit/installment-math.ts`

```ts
import { Prisma } from '@prisma/client';

/** Calendar used for instalment due dates (the platform operates in Iran). */
export const PLATFORM_TIME_ZONE = 'Asia/Tehran';

/** Days between two consecutive instalments (TM brief: "30 days apart"). */
export const INSTALLMENT_INTERVAL_DAYS = 30;

export interface InstallmentScheduleInput {
  /** Principal financed by credit, in whole rials. */
  creditAmount: Prisma.Decimal;
  /** Total interest rate of the whole plan duration (0 for 3 months, 9 for 6 months, …). */
  interestRatePercent: Prisma.Decimal;
  durationMonths: number;
  /** Calendar date (YYYY-MM-DD, platform time zone) the purchase was paid; instalment k is due k × 30 days later. */
  purchaseDate: string;
  intervalDays?: number;
}

export interface InstallmentLine {
  installmentNumber: number;
  totalInstallments: number;
  /** Due date as a calendar date (YYYY-MM-DD). */
  dueDate: string;
  principalAmount: Prisma.Decimal;
  interestAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

export interface InstallmentSchedule {
  creditAmount: Prisma.Decimal;
  totalInterest: Prisma.Decimal;
  totalPayable: Prisma.Decimal;
  lines: InstallmentLine[];
}

export class InstallmentMathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallmentMathError';
  }
}

/**
 * The TM-approved instalment arithmetic (Phase 8, "Option A — fixed plan
 * duration rate", whole-rial rounding):
 *
 *   totalInterest  = floor(creditAmount × interestRatePercent / 100)   — rounded down, in the customer's favour
 *   basePrincipal  = floor(creditAmount / n),  remainder → last instalment
 *   baseInterest   = floor(totalInterest / n), remainder → last instalment
 *
 * Every amount is a whole number of rials (Shaparak/Shetab have no fractional
 * unit); Σ principal = creditAmount and Σ interest = totalInterest exactly.
 * Only the principal consumes the credit line; the interest is a financing fee
 * paid with the instalments.
 */
export function buildInstallmentSchedule(input: InstallmentScheduleInput): InstallmentSchedule {
  const { creditAmount, interestRatePercent, durationMonths } = input;
  const intervalDays = input.intervalDays ?? INSTALLMENT_INTERVAL_DAYS;
  if (!creditAmount.isInteger() || !creditAmount.greaterThan(0)) {
    throw new InstallmentMathError(`creditAmount must be a positive whole number of rials, got ${creditAmount.toFixed(2)}`);
  }
  if (!Number.isInteger(durationMonths) || durationMonths < 1) {
    throw new InstallmentMathError(`durationMonths must be a positive integer, got ${durationMonths}`);
  }
  if (interestRatePercent.lessThan(0)) {
    throw new InstallmentMathError('interestRatePercent cannot be negative');
  }
  if (!Number.isInteger(intervalDays) || intervalDays < 1) {
    throw new InstallmentMathError('intervalDays must be a positive integer');
  }

  const n = new Prisma.Decimal(durationMonths);
  const totalInterest = creditAmount.times(interestRatePercent).dividedBy(100).floor();
  const basePrincipal = creditAmount.dividedBy(n).floor();
  const principalRemainder = creditAmount.minus(basePrincipal.times(n));
  const baseInterest = totalInterest.dividedBy(n).floor();
  const interestRemainder = totalInterest.minus(baseInterest.times(n));

  const lines: InstallmentLine[] = [];
  for (let k = 1; k <= durationMonths; k += 1) {
    const last = k === durationMonths;
    const principalAmount = last ? basePrincipal.plus(principalRemainder) : basePrincipal;
    const interestAmount = last ? baseInterest.plus(interestRemainder) : baseInterest;
    lines.push({
      installmentNumber: k,
      totalInstallments: durationMonths,
      dueDate: addDays(input.purchaseDate, k * intervalDays),
      principalAmount,
      interestAmount,
      totalAmount: principalAmount.plus(interestAmount),
    });
  }
  return { creditAmount, totalInterest, totalPayable: creditAmount.plus(totalInterest), lines };
}

/** Calendar date (YYYY-MM-DD) of an instant in the platform time zone. */
export function platformDate(instant: Date, timeZone = PLATFORM_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** Adds whole days to a calendar date (no time-zone or DST effects: pure calendar arithmetic in UTC). */
export function addDays(date: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) {
    throw new InstallmentMathError(`Not a calendar date: ${date}`);
  }
  const utc = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days);
  return new Date(utc).toISOString().slice(0, 10);
}

/** A calendar date as the Date Prisma writes to a `@db.Date` column (UTC midnight). */
export function calendarDateToDb(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

/** A `@db.Date` value back to YYYY-MM-DD. */
export function dbDateToCalendar(value: Date): string {
  return value.toISOString().slice(0, 10);
}
```

### `apps/backend/src/modules/credit/providers/credit-provider.interface.ts`

```ts
import type { Prisma } from '@prisma/client';

/** Result of the provider's credit/score inquiry for a person. */
export interface EligibilityResult {
  eligible: boolean;
  /** Credit score reported by the provider (null if it does not disclose one). */
  score: number | null;
  /** Highest limit the provider would grant (null = no cap disclosed). */
  maxEligibleLimit: Prisma.Decimal | null;
  /** Provider's inquiry reference. */
  inquiryRef: string;
  /** Machine-readable reason when not eligible. */
  reason: string | null;
  /** Non-sensitive provider answer, stored in `credit_applications.bank_score_response`. */
  details: Record<string, unknown>;
}

/** A supporting document the customer uploaded (media asset of kind DOCUMENT). */
export interface ApplicationDocument {
  mediaAssetId: string;
  mimeType: string;
  sizeBytes: number;
}

export type ProviderApplicationStatus = 'APPROVED' | 'REJECTED' | 'DOCS_REQUIRED';

export interface ApplicationDecision {
  status: ProviderApplicationStatus;
  /** Granted limit (whole rials) when APPROVED. */
  approvedLimit: Prisma.Decimal | null;
  /** Provider's application tracking code. */
  trackingCode: string;
  reason: string | null;
  details: Record<string, unknown>;
}

export interface CreditReservation {
  /** Provider reference of the hold; commit/release address it. */
  reservationRef: string;
  details: Record<string, unknown>;
}

/**
 * A bank / fintech credit provider (TM brief §1). Implementations talk to the
 * provider only; the platform's own ledger (`CreditLedgerService`) mirrors every
 * movement in the database.
 *
 * - `inquireEligibility` — credit/score inquiry for a national code + mobile;
 * - `submitApplication`  — asks for a credit line of `requestedLimit`;
 * - `reserveCredit`      — holds an amount of an open line for an order;
 * - `commitCredit`       — converts a hold into a purchase (idempotent);
 * - `releaseCredit`      — cancels a hold (idempotent).
 *
 * Transport problems throw a `CreditProviderError` with `retryable: true`;
 * a definitive refusal is either a result (`eligible: false`, `REJECTED`) or a
 * non-retryable error.
 */
export interface CreditProviderAdapter {
  /** `credit_providers.code` this adapter serves. */
  readonly code: string;
  /** True for development/test providers that move no money. */
  readonly isSandbox: boolean;
  inquireEligibility(nationalCode: string, mobile: string): Promise<EligibilityResult>;
  submitApplication(userId: string, requestedLimit: Prisma.Decimal, docs: readonly ApplicationDocument[]): Promise<ApplicationDecision>;
  reserveCredit(creditAccountId: string, amount: Prisma.Decimal, parentOrderId: string): Promise<CreditReservation>;
  commitCredit(reservationRef: string): Promise<void>;
  releaseCredit(reservationRef: string): Promise<void>;
}

export class CreditProviderError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'CreditProviderError';
  }
}
```

### `apps/backend/src/modules/credit/providers/credit-provider.registry.ts`

```ts
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { EnvironmentVariables } from '../../../config/env.validation';
import { NodeEnvironment } from '../../../config/env.validation';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { RedisService } from '../../../infra/redis/redis.service';
import { CreditProviderError, type CreditProviderAdapter } from './credit-provider.interface';
import { parseSandboxRules, SANDBOX_BANK_CODE, SandboxBankProvider } from './sandbox-bank.provider';

/** system_configs keys of the credit feature (seeded in Phase 2). */
export const CREDIT_CONFIG_KEYS = {
  enabled: 'credit.enabled',
  activeProvider: 'credits.activeProvider',
} as const;

export interface ProviderRow {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  config: Prisma.JsonValue | null;
}

type AdapterFactory = (row: ProviderRow) => CreditProviderAdapter;

export function serviceUnavailable(code: string, message: string): HttpException {
  return new HttpException({ statusCode: HttpStatus.SERVICE_UNAVAILABLE, error: 'Service Unavailable', code, message }, HttpStatus.SERVICE_UNAVAILABLE);
}

/**
 * Resolves credit providers dynamically from the database (TM brief §1):
 * `credit_providers` rows (code, isActive, config) + the `credits.activeProvider`
 * system config name the active provider; this registry maps a provider code to
 * its adapter implementation. Switching provider is a data change.
 *
 * Only SANDBOX_BANK has an implementation. The real banks seeded in Phase 2
 * (SAMAN_BANK, BLUBANK, DIGIPAY) have no adapter yet — their APIs have not been
 * provided — so selecting one answers 503 CREDIT_PROVIDER_NOT_IMPLEMENTED rather
 * than pretending. The sandbox is refused in production.
 */
@Injectable()
export class CreditProviderRegistry {
  private readonly logger = new Logger(CreditProviderRegistry.name);
  private readonly production: boolean;
  private readonly factories: ReadonlyMap<string, AdapterFactory>;

  constructor(
    private readonly prisma: PrismaService,
    redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.production = config.getOrThrow<NodeEnvironment>('NODE_ENV') === NodeEnvironment.Production;
    this.factories = new Map<string, AdapterFactory>([[SANDBOX_BANK_CODE, (row): CreditProviderAdapter => new SandboxBankProvider(redis, parseSandboxRules(row.config))]]);
  }

  /** Whether the credit feature is switched on (`credit.enabled = true`). */
  async isEnabled(): Promise<boolean> {
    const row = await this.prisma.systemConfig.findUnique({ where: { key: CREDIT_CONFIG_KEYS.enabled }, select: { value: true } });
    return row?.value.trim().toLowerCase() === 'true';
  }

  async assertEnabled(): Promise<void> {
    if (!(await this.isEnabled())) {
      throw serviceUnavailable('CREDIT_DISABLED', 'Credit purchases are currently disabled');
    }
  }

  /** The provider named by `credits.activeProvider`, if it exists and is active; null otherwise. */
  async findActiveProvider(): Promise<ProviderRow | null> {
    const setting = await this.prisma.systemConfig.findUnique({ where: { key: CREDIT_CONFIG_KEYS.activeProvider }, select: { value: true } });
    const code = setting?.value.trim();
    if (!code) return null;
    return this.prisma.creditProvider.findFirst({ where: { code, isActive: true }, select: providerSelect });
  }

  async requireActiveProvider(): Promise<ProviderRow> {
    const provider = await this.findActiveProvider();
    if (!provider) {
      throw serviceUnavailable('CREDIT_PROVIDER_UNAVAILABLE', 'No active credit provider is configured');
    }
    return provider;
  }

  async providerById(providerId: string): Promise<ProviderRow> {
    return this.prisma.creditProvider.findUniqueOrThrow({ where: { id: providerId }, select: providerSelect });
  }

  /** True when an adapter implementation exists for the code (and may be used in this environment). */
  isImplemented(code: string): boolean {
    return this.factories.has(code) && !(this.production && code === SANDBOX_BANK_CODE);
  }

  /** The adapter of a provider row; 503 when there is no implementation or its config is invalid. */
  adapterFor(row: ProviderRow): CreditProviderAdapter {
    if (this.production && row.code === SANDBOX_BANK_CODE) {
      throw serviceUnavailable('CREDIT_PROVIDER_NOT_ALLOWED', 'The SANDBOX_BANK credit provider cannot be used in production');
    }
    const factory = this.factories.get(row.code);
    if (!factory) {
      throw serviceUnavailable('CREDIT_PROVIDER_NOT_IMPLEMENTED', `No integration is implemented for credit provider ${row.code}`);
    }
    try {
      const adapter = factory(row);
      if (adapter.isSandbox) {
        this.logger.debug(`Credit provider ${row.code} is a sandbox: no real credit is granted and no money moves`);
      }
      return adapter;
    } catch (error) {
      if (error instanceof CreditProviderError) {
        this.logger.error(`Credit provider ${row.code} is misconfigured: ${error.message}`);
        throw serviceUnavailable('CREDIT_PROVIDER_MISCONFIGURED', `Credit provider ${row.code} is misconfigured`);
      }
      throw error;
    }
  }

  async adapterForProviderId(providerId: string): Promise<CreditProviderAdapter> {
    return this.adapterFor(await this.providerById(providerId));
  }
}

const providerSelect = { id: true, code: true, name: true, isActive: true, config: true } satisfies Prisma.CreditProviderSelect;
```

### `apps/backend/src/modules/credit/providers/sandbox-bank.provider.spec.ts`

```ts
import { Prisma } from '@prisma/client';
import type { RedisService } from '../../../infra/redis/redis.service';
import { CreditProviderError } from './credit-provider.interface';
import { parseSandboxRules, SandboxBankProvider, sandboxCreditScore } from './sandbox-bank.provider';

const RULES = { minApprovalScore: '600', minRequestedLimit: '10000000', maxApprovedLimit: '500000000' };
/** Eligibility and applications never touch Redis (only reservations do; those are covered by the e2e suite against real Redis). */
const NO_REDIS = {} as RedisService;

describe('sandboxCreditScore', () => {
  it('is deterministic and within 300–850', () => {
    for (const code of ['0499370899', '0012345679', '1234567891', '9876543210']) {
      const score = sandboxCreditScore(code);
      expect(score).toBe(sandboxCreditScore(code));
      expect(score).toBeGreaterThanOrEqual(300);
      expect(score).toBeLessThanOrEqual(850);
    }
  });
});

describe('parseSandboxRules', () => {
  it('parses the seeded configuration', () => {
    const rules = parseSandboxRules(RULES);
    expect(rules.minApprovalScore).toBe(600);
    expect(rules.minRequestedLimit.toFixed(0)).toBe('10000000');
    expect(rules.maxApprovedLimit.toFixed(0)).toBe('500000000');
  });

  it.each([
    [null],
    [{}],
    [{ ...RULES, minApprovalScore: '200' }],
    [{ ...RULES, minApprovalScore: '900' }],
    [{ ...RULES, maxApprovedLimit: '5' }],
    [{ ...RULES, minRequestedLimit: 'abc' }],
  ])('refuses an invalid configuration %#', (config) => {
    expect(() => parseSandboxRules(config as Prisma.JsonValue)).toThrow(CreditProviderError);
  });
});

describe('SandboxBankProvider decisions', () => {
  const provider = new SandboxBankProvider(NO_REDIS, parseSandboxRules(RULES));

  it('marks itself as a sandbox provider', () => {
    expect(provider.isSandbox).toBe(true);
    expect(provider.code).toBe('SANDBOX_BANK');
  });

  it('eligibility follows the score threshold', async () => {
    const codes = ['0499370899', '0012345679', '1234567891', '9876543210', '1111111111', '2222222222'];
    for (const code of codes) {
      const result = await provider.inquireEligibility(code, '+989121234567');
      expect(result.score).toBe(sandboxCreditScore(code));
      expect(result.eligible).toBe(sandboxCreditScore(code) >= 600);
      expect(result.reason).toBe(result.eligible ? null : 'SCORE_BELOW_THRESHOLD');
      expect(result.inquiryRef).toMatch(/^SBXQ-[0-9A-F]{16}$/);
    }
  });

  it('approves the requested limit, capped at the maximum', async () => {
    const approved = await provider.submitApplication('11111111-1111-4111-8111-111111111111', new Prisma.Decimal(200_000_000), []);
    expect(approved.status).toBe('APPROVED');
    expect(approved.approvedLimit?.toFixed(0)).toBe('200000000');
    const capped = await provider.submitApplication('11111111-1111-4111-8111-111111111111', new Prisma.Decimal(900_000_000), []);
    expect(capped.approvedLimit?.toFixed(0)).toBe('500000000');
    expect(capped.reason).toBe('CAPPED_AT_MAXIMUM');
  });

  it('rejects a request below the minimum limit', async () => {
    const rejected = await provider.submitApplication('11111111-1111-4111-8111-111111111111', new Prisma.Decimal(9_999_999), []);
    expect(rejected.status).toBe('REJECTED');
    expect(rejected.approvedLimit).toBeNull();
    expect(rejected.reason).toBe('BELOW_MINIMUM_LIMIT');
  });

  it('refuses fractional reservation amounts before touching storage', async () => {
    await expect(provider.reserveCredit('acc', new Prisma.Decimal('10.5'), 'order')).rejects.toBeInstanceOf(CreditProviderError);
  });
});
```

### `apps/backend/src/modules/credit/providers/sandbox-bank.provider.ts`

```ts
import { Prisma } from '@prisma/client';
import { createHash, randomBytes } from 'node:crypto';
import type { RedisService } from '../../../infra/redis/redis.service';
import {
  CreditProviderError,
  type ApplicationDecision,
  type ApplicationDocument,
  type CreditProviderAdapter,
  type CreditReservation,
  type EligibilityResult,
} from './credit-provider.interface';

export const SANDBOX_BANK_CODE = 'SANDBOX_BANK';

/** Reservations live longer than any payment window and callback grace. */
export const SANDBOX_RESERVATION_TTL_SECONDS = 30 * 24 * 60 * 60;

export const sandboxReservationKey = (ref: string): string => `credit:sandbox:reservation:${ref}`;

/** Decision rules of the simulated bank, read from `credit_providers.config` (never hard-coded). */
export interface SandboxBankRules {
  minApprovalScore: number;
  minRequestedLimit: Prisma.Decimal;
  maxApprovedLimit: Prisma.Decimal;
}

/** Parses and validates the sandbox rules; a missing or invalid rule is a configuration error (503 upstream). */
export function parseSandboxRules(config: Prisma.JsonValue | null): SandboxBankRules {
  const object = typeof config === 'object' && config !== null && !Array.isArray(config) ? config : {};
  const score = Number(object['minApprovalScore']);
  const min = decimalOrNull(object['minRequestedLimit']);
  const max = decimalOrNull(object['maxApprovedLimit']);
  if (!Number.isInteger(score) || score < 300 || score > 850 || min === null || max === null || !min.greaterThan(0) || max.lessThan(min)) {
    throw new CreditProviderError(
      'SANDBOX_BANK config must define minApprovalScore (300–850), minRequestedLimit and maxApprovedLimit (whole rials, max ≥ min)',
      'PROVIDER_MISCONFIGURED',
      false,
    );
  }
  return { minApprovalScore: score, minRequestedLimit: min, maxApprovedLimit: max };
}

/**
 * Deterministic simulated credit score (300–850) of a national code: the same
 * person always gets the same answer, so development and tests can reproduce
 * both an approval and a rejection.
 */
export function sandboxCreditScore(nationalCode: string): number {
  const digest = createHash('sha256').update(`shopino-sandbox-credit:${nationalCode}`).digest();
  return 300 + (digest.readUInt32BE(0) % 551);
}

type ReservationStatus = 'RESERVED' | 'COMMITTED' | 'RELEASED';

interface SandboxReservation {
  reservationRef: string;
  creditAccountId: string;
  parentOrderId: string;
  amount: string;
  status: ReservationStatus;
  createdAt: string;
  updatedAt: string;
}

/**
 * Atomic status transition of a reservation (the sandbox "bank core"). Returns
 * the previous status, `MISSING`, or `CONFLICT:<status>` when the requested
 * transition is not allowed (committing a released hold or vice versa).
 */
const TRANSITION_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 'MISSING' end
local r = cjson.decode(raw)
if r.status == ARGV[1] then return r.status end
if r.status ~= 'RESERVED' then return 'CONFLICT:' .. r.status end
r.status = ARGV[1]
r.updatedAt = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(r), 'KEEPTTL')
return 'RESERVED'
`;

/**
 * DEVELOPMENT / TEST ONLY — `credit_providers.code = SANDBOX_BANK`.
 *
 * A self-contained simulated bank that answers instantly:
 * - eligibility: deterministic score from the national code
 *   (`sandboxCreditScore`), eligible when ≥ `minApprovalScore`;
 * - application: approves min(requestedLimit, maxApprovedLimit), rejects a
 *   request below `minRequestedLimit`;
 * - reservations: kept in Redis with an atomic RESERVED → COMMITTED | RELEASED
 *   state machine; commit/release are idempotent, and crossing them fails.
 *
 * No money and no real credit exist behind it. The registry refuses to use it
 * when NODE_ENV=production.
 */
export class SandboxBankProvider implements CreditProviderAdapter {
  readonly code = SANDBOX_BANK_CODE;
  readonly isSandbox = true;

  constructor(
    private readonly redis: RedisService,
    private readonly rules: SandboxBankRules,
  ) {}

  inquireEligibility(nationalCode: string, mobile: string): Promise<EligibilityResult> {
    const score = sandboxCreditScore(nationalCode);
    const eligible = score >= this.rules.minApprovalScore;
    return Promise.resolve({
      eligible,
      score,
      maxEligibleLimit: eligible ? this.rules.maxApprovedLimit : null,
      inquiryRef: `SBXQ-${randomBytes(8).toString('hex').toUpperCase()}`,
      reason: eligible ? null : 'SCORE_BELOW_THRESHOLD',
      details: {
        provider: SANDBOX_BANK_CODE,
        sandbox: true,
        score,
        minApprovalScore: this.rules.minApprovalScore,
        mobileSuffix: mobile.slice(-4),
      },
    });
  }

  submitApplication(userId: string, requestedLimit: Prisma.Decimal, docs: readonly ApplicationDocument[]): Promise<ApplicationDecision> {
    const trackingCode = `SBXA-${randomBytes(8).toString('hex').toUpperCase()}`;
    const details = { provider: SANDBOX_BANK_CODE, sandbox: true, documentsReceived: docs.length, applicantRef: userId.slice(0, 8) };
    if (requestedLimit.lessThan(this.rules.minRequestedLimit)) {
      return Promise.resolve({
        status: 'REJECTED',
        approvedLimit: null,
        trackingCode,
        reason: 'BELOW_MINIMUM_LIMIT',
        details: { ...details, minRequestedLimit: this.rules.minRequestedLimit.toFixed(0) },
      });
    }
    const approvedLimit = Prisma.Decimal.min(requestedLimit, this.rules.maxApprovedLimit).floor();
    return Promise.resolve({
      status: 'APPROVED',
      approvedLimit,
      trackingCode,
      reason: approvedLimit.lessThan(requestedLimit) ? 'CAPPED_AT_MAXIMUM' : null,
      details: { ...details, maxApprovedLimit: this.rules.maxApprovedLimit.toFixed(0) },
    });
  }

  async reserveCredit(creditAccountId: string, amount: Prisma.Decimal, parentOrderId: string): Promise<CreditReservation> {
    if (!amount.isInteger() || !amount.greaterThan(0)) {
      throw new CreditProviderError(`Reservation amount must be a positive whole number of rials, got ${amount.toFixed(2)}`, 'INVALID_AMOUNT', false);
    }
    const reservationRef = `SBXR-${randomBytes(12).toString('hex').toUpperCase()}`;
    const now = new Date().toISOString();
    const record: SandboxReservation = { reservationRef, creditAccountId, parentOrderId, amount: amount.toFixed(0), status: 'RESERVED', createdAt: now, updatedAt: now };
    await this.redis.client.set(sandboxReservationKey(reservationRef), JSON.stringify(record), 'EX', SANDBOX_RESERVATION_TTL_SECONDS, 'NX');
    return { reservationRef, details: { provider: SANDBOX_BANK_CODE, sandbox: true } };
  }

  async commitCredit(reservationRef: string): Promise<void> {
    await this.transition(reservationRef, 'COMMITTED');
  }

  async releaseCredit(reservationRef: string): Promise<void> {
    await this.transition(reservationRef, 'RELEASED');
  }

  /** Current sandbox state of a reservation (tests and diagnostics). */
  async reservationStatus(reservationRef: string): Promise<ReservationStatus | null> {
    const raw = await this.redis.client.get(sandboxReservationKey(reservationRef));
    return raw ? (JSON.parse(raw) as SandboxReservation).status : null;
  }

  private async transition(reservationRef: string, target: 'COMMITTED' | 'RELEASED'): Promise<void> {
    const result = String(await this.redis.client.eval(TRANSITION_SCRIPT, 1, sandboxReservationKey(reservationRef), target, new Date().toISOString()));
    if (result === 'MISSING') {
      throw new CreditProviderError(`Unknown reservation ${reservationRef}`, 'RESERVATION_NOT_FOUND', false);
    }
    if (result.startsWith('CONFLICT:')) {
      throw new CreditProviderError(`Reservation ${reservationRef} is already ${result.slice('CONFLICT:'.length)}`, 'RESERVATION_STATE_CONFLICT', false);
    }
  }
}

function decimalOrNull(value: unknown): Prisma.Decimal | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const decimal = new Prisma.Decimal(value);
    return decimal.isFinite() && decimal.isInteger() ? decimal : null;
  } catch {
    return null;
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
      this.prisma.$queryRaw<Array<{ collected: Money; funded_by_credit: Money; installments_collected: Money }>>(Prisma.sql`
        SELECT SUM(cash_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS collected,
               SUM(credit_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS funded_by_credit,
               SUM(cash_amount) FILTER (WHERE purpose = 'INSTALLMENT_REPAYMENT') AS installments_collected
        FROM payments WHERE status = 'SUCCESSFUL' ${paymentWindow}`),
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
        fundedByCredit: money(collected[0]?.funded_by_credit ?? null),
        installmentsCollected: money(collected[0]?.installments_collected ?? null),
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
    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest' | 'CreditApplication' | 'CreditAccount' | 'InstallmentSchedule';
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
import { AuditAction, ParentOrderPaymentStatus, PaymentMethod, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
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
  ): Promise<TransitionResult> {
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
  parentOrder: { select: { paymentStatus: true, userId: true, paymentMethod: true } },
  items: { select: { productVariantId: true, quantity: true } },
} satisfies Prisma.SubOrderSelect;

type TransitionRow = Prisma.SubOrderGetPayload<{ select: typeof transitionSelect }>;
```

### `apps/backend/src/modules/orders/orders.module.ts`

```ts
import { Module } from '@nestjs/common';
import { CartModule } from '../cart/cart.module';
import { CategoriesModule } from '../categories/categories.module';
import { CreditModule } from '../credit/credit.module';
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
  imports: [CartModule, CategoriesModule, CreditModule, ProductsModule, ShippingModule, WalletModule],
  controllers: [CheckoutController, CustomerOrdersController, VendorOrdersController, AdminOrdersController],
  providers: [CheckoutService, OrderLifecycleService, OrderQueriesService, OrderExpiryScheduler],
  exports: [OrderLifecycleService],
})
export class OrdersModule {}
```

### `apps/backend/src/modules/payments/dto/payment.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus } from '@prisma/client';
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
  @ApiProperty({ enum: PaymentPurpose, description: 'ORDER_CHECKOUT (the order) or INSTALLMENT_REPAYMENT (one BNPL instalment).' })
  purpose!: PaymentPurpose;
  @ApiProperty({ enum: PaymentMethod, description: 'CASH_IPG = card only; BANK_CREDIT = credit only; HYBRID = credit + card.' })
  paymentMethod!: PaymentMethod;
  @ApiProperty({ type: String, example: '1500000.00', description: 'Card part (IRR).' }) cashAmount!: string;
  @ApiProperty({ type: String, example: '3000000.00', description: 'Credit part (IRR); 0 for CASH_IPG.' }) creditAmount!: string;
  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'The instalment an INSTALLMENT_REPAYMENT settles.' })
  installmentScheduleId!: string | null;
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
  if (!amount.isInteger() || !amount.greaterThan(0)) {
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

### `apps/backend/src/modules/payments/payments.module.ts`

```ts
import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { CreditModule } from '../credit/credit.module';
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
  imports: [CreditModule, OrdersModule],
  controllers: [PaymentsController, SandboxBankController],
  providers: [gatewayProvider, PaymentsService],
  exports: [PaymentsService, PAYMENT_GATEWAY],
})
export class PaymentsModule {}
```

### `apps/backend/src/modules/payments/payments.service.ts`

```ts
import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, InstallmentStatus, ParentOrderPaymentStatus, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from '../credit/credit-ledger.service';
import { CreditOrderService, type ProviderFollowUp } from '../credit/credit-order.service';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import type { InitiatePaymentResponseDto, PaymentOutcome, PaymentOutcomeDto } from './dto/payment.dto';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
  type GatewayInitiation,
  type GatewayVerification,
  type PaymentGatewayProvider,
} from './gateway/payment-gateway.interface';

type Tx = Prisma.TransactionClient;

/** Open attempts one order may have inside the grace window (each one opens a bank session). */
export const MAX_OPEN_ATTEMPTS = 5;

const paymentSelect = {
  id: true,
  status: true,
  parentOrderId: true,
  purpose: true,
  paymentMethod: true,
  cashAmount: true,
  creditAmount: true,
  creditAccountId: true,
  creditReservationRef: true,
  installmentPlanId: true,
  installmentScheduleId: true,
  installmentSchedule: { select: { status: true } },
  bankRrn: true,
  metadata: true,
  gatewayTrackingToken: true,
  parentOrder: { select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

/** What `startGatewaySession` needs to open a bank session for an already-created INITIATED payment. */
export interface GatewaySessionRequest {
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  amount: Prisma.Decimal;
  description: string;
  customerMobile: string;
}

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
 *
 * Phase 8 (credit): a HYBRID attempt carries a credit reservation next to its
 * card part. On a verified card payment the reservation is committed and the
 * instalment schedule written before the order completes (same transaction;
 * lock order parent → credit account → stock → wallets); on failure — or if the
 * gateway cannot even open a session — the reservation is released. When any
 * attempt pays the order, the still-held reservations of the other attempts are
 * released. INSTALLMENT_REPAYMENT payments settle one instalment and restore its
 * principal to the credit line. Provider calls follow after the commit.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly callbackUrl: string;
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly creditLedger: CreditLedgerService,
    private readonly creditOrders: CreditOrderService,
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

    const initiation = await this.startGatewaySession({
      paymentId: payment.id,
      parentOrderId,
      orderNumber: order.orderNumber,
      amount: order.finalPayableAmount,
      description: `پرداخت سفارش ${order.orderNumber} — شاپینو`,
      customerMobile: order.user.mobile,
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

  /**
   * Opens the bank session of an INITIATED payment (card-only, the card part of
   * a HYBRID attempt, or an instalment repayment). If the gateway refuses or
   * cannot be reached, the payment becomes FAILED, its credit reservation (if
   * any) is released, and 502 GATEWAY_UNAVAILABLE is thrown.
   */
  async startGatewaySession(request: GatewaySessionRequest): Promise<GatewayInitiation> {
    let initiation: GatewayInitiation;
    try {
      initiation = await this.gateway.initiatePayment(
        {
          paymentId: request.paymentId,
          orderNumber: request.orderNumber,
          amount: request.amount,
          description: request.description,
          customerMobile: request.customerMobile,
        },
        this.callbackUrl,
      );
    } catch (error) {
      const gatewayError = error instanceof PaymentGatewayError ? error : new PaymentGatewayError(String(error), 'GATEWAY_ERROR', true);
      const followUps = await this.prisma.$transaction(async (tx) => {
        await lockParentOrder(tx, request.parentOrderId);
        const current = await tx.payment.findUniqueOrThrow({ where: { id: request.paymentId }, select: paymentSelect });
        const released = current.status === PaymentStatus.INITIATED ? await this.creditOrders.releaseLocked(tx, current) : null;
        await tx.payment.update({
          where: { id: request.paymentId },
          data: {
            status: PaymentStatus.FAILED,
            metadata: {
              stage: 'initiate',
              code: gatewayError.code,
              message: gatewayError.message.slice(0, 500),
              ...(released ? { creditReservationReleased: true } : {}),
            },
          },
        });
        return released ? [released] : [];
      });
      await this.creditOrders.followUp(followUps);
      this.logger.warn(`Gateway ${this.gateway.name} refused to open a session for payment ${request.paymentId}: ${gatewayError.message}`);
      throw new HttpException(
        { statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', code: 'GATEWAY_UNAVAILABLE', message: 'The payment gateway could not open a payment session; try again', gatewayCode: gatewayError.code },
        HttpStatus.BAD_GATEWAY,
      );
    }
    await this.prisma.payment.update({
      where: { id: request.paymentId },
      data: { gatewayTrackingToken: initiation.gatewayToken, metadata: { stage: 'initiated', gateway: initiation.details } as Prisma.InputJsonValue },
    });
    return initiation;
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

    const followUps: ProviderFollowUp[] = [];
    const settled = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, found.parentOrder.id);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: found.id }, select: paymentSelect });
      if (current.status !== PaymentStatus.INITIATED) {
        return current; // another callback won the race
      }
      return verification.success
        ? this.applySuccess(tx, current, verification, actor, followUps)
        : this.applyFailure(tx, current, verification, actor, followUps);
    });
    await this.creditOrders.followUp(followUps);
    return this.outcomeOf(settled);
  }

  private async applySuccess(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<PaymentRow> {
    const paidAt = new Date();
    const effect =
      payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT
        ? await this.applyRepayment(tx, payment, verification, paidAt)
        : await this.applyCheckout(tx, payment, verification, actor, paidAt, followUps);
    const requiresManualRefund = !effect.applied;
    const metadata = {
      ...asObject(payment.metadata),
      stage: 'verified',
      verifyCode: verification.code,
      alreadyVerified: verification.alreadyVerified,
      cardPanMasked: verification.cardPanMasked,
      ...(requiresManualRefund
        ? { requiresManualRefund: true, orderStatusAtCapture: payment.parentOrder.paymentStatus, ...effect.details }
        : effect.details),
    } as Prisma.InputJsonValue;
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
        purpose: payment.purpose,
        paymentMethod: payment.paymentMethod,
        amount: payment.cashAmount.toFixed(2),
        creditAmount: payment.creditAmount.toFixed(2),
        bankRrn: verification.bankRrn,
        verifyCode: verification.code,
        ...(payment.installmentScheduleId ? { installmentScheduleId: payment.installmentScheduleId } : {}),
        ...(requiresManualRefund ? { requiresManualRefund: true, orderPaymentStatus: updated.parentOrder.paymentStatus, ...effect.details } : {}),
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

  /**
   * Card payment (or the card part of a HYBRID attempt) for an order. The order
   * must still be PENDING and, for HYBRID, the credit reservation still held;
   * then credit is committed + scheduled first and the order completes.
   */
  private async applyCheckout(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    paidAt: Date,
    followUps: ProviderFollowUp[],
  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
    const orderId = payment.parentOrder.id;
    if (payment.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
      return { applied: false, details: {} };
    }
    const details: Record<string, unknown> = {};
    if (payment.creditAmount.greaterThan(0)) {
      const state = await this.creditLedger.reservationState(tx, payment.creditAccountId!, payment.creditReservationRef!);
      if (state !== 'HELD') {
        // Defensive: a PENDING order whose hybrid reservation is gone cannot be completed with this card part.
        return { applied: false, details: { creditReservationState: state } };
      }
      const committed = await this.creditOrders.commitAndScheduleLocked(tx, payment, paidAt);
      followUps.push(committed.followUp);
      details['schedule'] = committed.schedule;
    }
    const application = await this.lifecycle.applyPaymentLocked(tx, orderId, actor, {
      paymentId: payment.id,
      paymentMethod: payment.paymentMethod,
      ...(verification.bankRrn ? { bankRrn: verification.bankRrn } : {}),
    });
    if (!application.applied) {
      throw new Error(`Order ${orderId} was PENDING under lock but the payment could not be applied`);
    }
    followUps.push(...(await this.creditOrders.releaseOpenReservationsLocked(tx, orderId, payment.id)));
    details['escrowHeld'] = application.escrowHeld;
    return { applied: true, details };
  }

  private async applyRepayment(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    paidAt: Date,
  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
    const result = await this.creditOrders.applyRepaymentLocked(tx, payment.installmentScheduleId!, payment.cashAmount, { bankRrn: verification.bankRrn, paidAt });
    return { applied: result.applied, details: { installmentStatus: result.installmentStatus, restoredPrincipal: result.restoredPrincipal } };
  }

  private async applyFailure(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<PaymentRow> {
    // HYBRID: the card part failed, so the credit reservation is rolled back.
    const released = await this.creditOrders.releaseLocked(tx, payment);
    if (released) followUps.push(released);
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        metadata: {
          ...asObject(payment.metadata),
          stage: 'failed',
          code: verification.code,
          message: verification.message.slice(0, 500),
          ...(released ? { creditReservationReleased: true } : {}),
        },
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
      newValue: {
        status: PaymentStatus.FAILED,
        orderNumber: payment.parentOrder.orderNumber,
        purpose: payment.purpose,
        paymentMethod: payment.paymentMethod,
        code: verification.code,
        message: verification.message,
        ...(released ? { creditReservationReleased: released.reservationRef } : {}),
      },
    });
    return updated;
  }

  private outcomeOf(payment: PaymentRow): PaymentOutcomeDto {
    const order = payment.parentOrder;
    const repayment = payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT;
    const canRetry = repayment
      ? payment.installmentSchedule?.status === InstallmentStatus.PENDING || payment.installmentSchedule?.status === InstallmentStatus.OVERDUE
      : order.paymentStatus === ParentOrderPaymentStatus.PENDING && (order.paymentExpiresAt === null || order.paymentExpiresAt > new Date());
    const metadata = asObject(payment.metadata);
    let outcome: PaymentOutcome;
    let message: string;
    if (payment.status === PaymentStatus.SUCCESSFUL) {
      outcome = metadata['requiresManualRefund'] === true ? 'PAID_REQUIRES_REFUND' : 'PAID';
      message = repayment
        ? outcome === 'PAID'
          ? 'Payment confirmed; the instalment is paid'
          : 'The bank captured this payment but the instalment was already settled; it will be refunded by our finance team'
        : outcome === 'PAID'
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
      purpose: payment.purpose,
      paymentMethod: payment.paymentMethod,
      cashAmount: payment.cashAmount.toFixed(2),
      creditAmount: payment.creditAmount.toFixed(2),
      installmentScheduleId: payment.installmentScheduleId,
    };
  }
}

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value) : {};
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

/** Escrow position of one package, derived from its ledger rows (the ledger is the source of truth). */
export type EscrowState = 'NONE' | 'HELD' | 'RELEASED' | 'REVERSED';

export function escrowStateOf(types: ReadonlyArray<WalletTransactionType>): EscrowState {
  if (types.includes('REFUND_DEDUCTION')) return 'REVERSED';
  if (types.includes('ESCROW_RELEASE_TO_WITHDRAWABLE')) return 'RELEASED';
  if (types.includes('CREDIT_SALE_ESCROW_HOLD')) return 'HELD';
  return 'NONE';
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

### `apps/backend/test/credit.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, CreditTransactionType, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { isValidNationalCode } from '../src/common/validators/iranian-national-code';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { InstallmentsService } from '../src/modules/bnpl/installments.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { holdsInvariant, replayCreditLedger } from '../src/modules/credit/credit-math';
import { creditApplyCountKey, creditApplyLockKey } from '../src/modules/credit/credit.service';
import { addDays, calendarDateToDb, dbDateToCalendar, platformDate } from '../src/modules/credit/installment-math';
import { CREDIT_CONFIG_KEYS } from '../src/modules/credit/providers/credit-provider.registry';
import { parseSandboxRules, sandboxCreditScore, sandboxReservationKey } from '../src/modules/credit/providers/sandbox-bank.provider';
import { SHIPPING_CONFIG_KEYS } from '../src/modules/shipping/shipping-calculator.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of Phase 8 — credit engine, credit applications,
 * instalment schedules, BANK_CREDIT / HYBRID checkout and instalment repayment —
 * against the real PostgreSQL 16 and Redis 7 of docker-compose.
 *
 * Providers: the credit provider is SANDBOX_BANK (development only; decisions
 * are derived deterministically from the national code, reservations live in
 * Redis) and the card gateway is the Phase 7 SANDBOX gateway, driven exactly as
 * a browser would (bank page → decision form → callback → server-side verify).
 * Nothing is stubbed inside the API.
 *
 * Money (IRR). One store, category commission 10 %, platform shipping 450,000
 * per package (free from 20,000,000):
 *   order 1  P × 2 =  6,000,000 + 450,000 =  6,450,000   BANK_CREDIT, 6-month plan (9 %)
 *            interest = floor(6,450,000 × 9 %) = 580,500; 6 × (1,075,000 + 96,750)
 *   order 2  P × 5 = 15,000,000 + 450,000 = 15,450,000   HYBRID, 3-month plan (0 %)
 *            credit = available 13,550,000; card 1,900,000; principal 4,516,666 × 2 + 4,516,668
 */

const TEST_UA = 'shopino-credit-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_MOBILE = '+989971160001';
const CUSTOMER_MOBILE = '+989971160002';
const CUSTOMER_2_MOBILE = '+989971160003';
const CUSTOMER_3_MOBILE = '+989971160004';
const SUITE_MOBILES = [VENDOR_MOBILE, CUSTOMER_MOBILE, CUSTOMER_2_MOBILE, CUSTOMER_3_MOBILE];
const VENDOR_IBAN = 'IR820540102680020817909002';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
const SEEDED_FINANCE_EMAIL = 'finance@shopino.local';

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

interface Account {
  id: string;
  provider: { code: string; name: string; isSandbox: boolean };
  status: string;
  totalLimit: string;
  usedAmount: string;
  reservedAmount: string;
  availableAmount: string;
  currency: string;
  outstanding: { count: number; overdueCount: number; principal: string; interest: string; nextDueDate: string | null };
}

interface Application {
  id: string;
  status: 'APPROVED' | 'REJECTED' | 'DOCS_REQUIRED';
  provider: { code: string; isSandbox: boolean };
  requestedLimit: string;
  approvedLimit: string | null;
  trackingCode: string | null;
  score: number | null;
  decisionReason: string | null;
  decidedAt: string | null;
  account: Account | null;
}

interface Plan {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
  installmentIntervalDays: number;
}

interface CreditInitiate {
  status: 'COMPLETED' | 'IPG_REQUIRED';
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: string;
  creditAmount: string;
  cashAmount: string;
  orderPaymentStatus: string;
  redirectUrl: string | null;
  gatewayName: string | null;
  schedule: { installments: number; creditAmount: string; totalInterest: string; totalPayable: string; firstDueDate: string; lastDueDate: string } | null;
}

interface Outcome {
  outcome: 'PAID' | 'FAILED' | 'VERIFICATION_PENDING' | 'PAID_REQUIRES_REFUND';
  paymentId: string;
  paymentStatus: string;
  orderPaymentStatus: string;
  bankRrn: string | null;
  canRetry: boolean;
  purpose: string;
  paymentMethod: string;
  cashAmount: string;
  creditAmount: string;
  installmentScheduleId: string | null;
}

interface Installment {
  id: string;
  installmentNumber: number;
  totalInstallments: number;
  dueDate: string;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
  paidAmount: string;
  amountDue: string;
  status: 'PENDING' | 'PAID' | 'OVERDUE' | 'WAIVED';
  paidAt: string | null;
}

interface InstallmentsOverview {
  orders: Array<{
    parentOrderId: string;
    orderNumber: string;
    paymentMethod: string;
    plan: { id: string; durationMonths: number } | null;
    creditAmount: string;
    totalInterest: string;
    totalPayable: string;
    paidAmount: string;
    remainingAmount: string;
    paidCount: number;
    overdueCount: number;
    installments: Installment[];
  }>;
  totalRemaining: string;
  overdueCount: number;
}

interface Page<T> {
  items: T[];
  total: number;
}

const d = (value: string | number | Prisma.Decimal): Prisma.Decimal => new Prisma.Decimal(value);

/** A random national code with a valid check digit whose sandbox score satisfies `wanted`. */
function generateNationalCode(wanted: (score: number) => boolean, exclude: Set<string>): string {
  for (let attempt = 0; attempt < 100_000; attempt += 1) {
    const nine = String(Math.floor(Math.random() * 1e9)).padStart(9, '0');
    let sum = 0;
    for (let i = 0; i < 9; i += 1) sum += Number(nine[i]) * (10 - i);
    const remainder = sum % 11;
    const code = `${nine}${remainder < 2 ? remainder : 11 - remainder}`;
    if (isValidNationalCode(code) && !exclude.has(code) && wanted(sandboxCreditScore(code))) {
      exclude.add(code);
      return code;
    }
  }
  throw new Error('Could not generate a national code');
}

describe('Phase 8 — credit engine, BNPL checkout and instalments (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;

  let adminToken: string;
  let supportToken: string;
  let financeToken: string;
  let vendor: { token: string; userId: string; vendorId: string };
  let customer: { token: string; userId: string };
  let customer2: { token: string; userId: string };
  let customer3: { token: string; userId: string };
  let categoryId: string;
  let variantId: string;
  let addressId: string;
  let address3Id: string;
  let minApprovalScore: number;
  const codes: Record<'approved' | 'rejected' | 'approved3', string> = {} as never;
  const plans: Record<3 | 6 | 12, Plan> = {} as never;
  let savedConfigs: Array<{ key: string; value: string; valueType: never; description: string | null }> = [];
  const paymentIds: string[] = [];

  let application: Application;
  let accountId: string;
  let creditOrder: Checkout; // order 1 — BANK_CREDIT
  let hybridOrder: Checkout; // order 2 — HYBRID

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

  const onboardStore = async (login: { token: string }, storeSlug: string): Promise<string> => {
    const registered = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token: login.token,
      body: { storeName: `فروشگاه آزمون اعتباری ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون فاز هشت', bankIban: VENDOR_IBAN, bankAccountHolder: 'شرکت آزمون اعتباری' },
    });
    expect(registered.status).toBe(201);
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% credit e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
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
      body: { status: 'APPROVED', rejectionReason: null, commissionRateOverride: null },
    });
    expect(verified.status).toBe(200);
    return registered.body.id;
  };

  const createAddress = async (token: string, recipientMobile: string): Promise<string> => {
    const address = await request<{ id: string }>('/customer/addresses', {
      method: 'POST',
      token,
      body: {
        province: 'تهران',
        city: 'تهران',
        postalAddress: 'خیابان انقلاب، پلاک ۸',
        postalCode: '1458889999',
        buildingNumber: '8',
        unitNumber: '1',
        recipientName: 'مشتری آزمون اعتباری',
        recipientMobile,
      },
    });
    expect(address.status).toBe(201);
    return address.body.id;
  };

  const placeOrder = async (quantity: number, token = customer.token, address = addressId): Promise<Checkout> => {
    expect((await request('/cart/clear', { method: 'POST', token })).status).toBe(200);
    expect((await request('/cart/items', { method: 'POST', token, body: { productVariantId: variantId, quantity } })).status).toBe(200);
    const placed = await request<Checkout>('/orders/checkout', { method: 'POST', token, body: { addressId: address } });
    expect(placed.status).toBe(201);
    return placed.body;
  };

  const creditInitiate = (parentOrderId: string, planId: string, paymentMethod: string, token = customer.token): Promise<HttpResult<CreditInitiate & ErrorBody>> =>
    request<CreditInitiate & ErrorBody>('/payments/credit/initiate', { method: 'POST', token, body: { parentOrderId, planId, paymentMethod } });

  /** The payer's decision on the sandbox bank page; returns the callback path the browser is redirected to. */
  const decide = async (paymentId: string, decision: 'PAY' | 'DECLINE'): Promise<string> => {
    paymentIds.push(paymentId);
    const response = await request(`/sandbox/payment-page/${paymentId}/decision`, { method: 'POST', form: { decision } });
    expect(response.status).toBe(303);
    const location = new URL(String(response.headers['location']));
    return `${location.pathname.slice(API.length)}${location.search}`;
  };

  const account = async (token = customer.token): Promise<Account> => {
    const response = await request<Account>('/credit/account', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  const installments = async (token = customer.token): Promise<InstallmentsOverview> => {
    const response = await request<InstallmentsOverview>('/credit/installments', { token });
    expect(response.status).toBe(200);
    return response.body;
  };

  /**
   * The acceptance invariant: the stored balances satisfy total = used + reserved
   * + available, equal the replay of the account's credit ledger, the latest
   * balanceAfter equals availableAmount, and match the expected figures.
   */
  const expectAccount = async (id: string, expected: { total: number; used: number; reserved: number; available: number }): Promise<void> => {
    const row = await prisma.creditAccount.findUniqueOrThrow({ where: { id } });
    const balances = { totalLimit: row.totalLimit, usedAmount: row.usedAmount, reservedAmount: row.reservedAmount, availableAmount: row.availableAmount };
    expect([row.totalLimit, row.usedAmount, row.reservedAmount, row.availableAmount].map((v) => v.toFixed(2))).toEqual(
      [expected.total, expected.used, expected.reserved, expected.available].map((v) => d(v).toFixed(2)),
    );
    expect(holdsInvariant(balances)).toBe(true);
    const ledgerRows = await prisma.creditTransaction.findMany({ where: { creditAccountId: id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    const replayed = replayCreditLedger(ledgerRows);
    expect([replayed.totalLimit, replayed.usedAmount, replayed.reservedAmount, replayed.availableAmount].map((v) => v.toFixed(2))).toEqual(
      [row.totalLimit, row.usedAmount, row.reservedAmount, row.availableAmount].map((v) => v.toFixed(2)),
    );
    // rows written by one transaction may share a timestamp: one of the latest rows carries the current available balance
    const latestAt = Math.max(...ledgerRows.map((r) => r.createdAt.getTime()));
    const latest = ledgerRows.filter((r) => r.createdAt.getTime() === latestAt).map((r) => r.balanceAfter.toFixed(2));
    expect(latest).toContain(row.availableAmount.toFixed(2));
  };

  const sandboxReservation = async (ref: string): Promise<string | null> => {
    const raw = await redis.client.get(sandboxReservationKey(ref));
    return raw ? (JSON.parse(raw) as { status: string }).status : null;
  };

  const setConfig = async (key: string, value: string, valueType: 'NUMBER' | 'BOOLEAN' = 'NUMBER'): Promise<void> => {
    await prisma.systemConfig.upsert({ where: { key }, update: { value }, create: { key, value, valueType, description: `credit e2e ${RUN}` } });
  };

  const vendorWallet = async (): Promise<{ pendingBalance: string }> => {
    const response = await request<{ pendingBalance: string }>('/vendor/wallet', { token: vendor.token });
    expect(response.status).toBe(200);
    return response.body;
  };

  // ─── lifecycle ─────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await resetKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = (await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword)).token;
    supportToken = (await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword)).token;
    financeToken = (await loginWithPassword(SEEDED_FINANCE_EMAIL, staffPassword)).token;

    const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), CREDIT_CONFIG_KEYS.enabled, CREDIT_CONFIG_KEYS.activeProvider];
    savedConfigs = (await prisma.systemConfig.findMany({ where: { key: { in: configKeys } }, select: { key: true, value: true, valueType: true, description: true } })) as never;
    await setConfig(SHIPPING_CONFIG_KEYS.defaultFeePerVendor, '450000');
    await setConfig(SHIPPING_CONFIG_KEYS.freeThresholdPerVendor, '20000000');
    await setConfig(CREDIT_CONFIG_KEYS.enabled, 'true', 'BOOLEAN');
    await prisma.systemConfig.update({ where: { key: CREDIT_CONFIG_KEYS.activeProvider }, data: { value: 'SANDBOX_BANK' } });

    const sandbox = await prisma.creditProvider.findUniqueOrThrow({ where: { code: 'SANDBOX_BANK' } });
    expect(sandbox.isActive).toBe(true);
    minApprovalScore = parseSandboxRules(sandbox.config).minApprovalScore;
    const taken = new Set((await prisma.user.findMany({ where: { nationalCode: { not: null } }, select: { nationalCode: true } })).map((u) => u.nationalCode!));
    codes.approved = generateNationalCode((score) => score >= minApprovalScore, taken);
    codes.approved3 = generateNationalCode((score) => score >= minApprovalScore, taken);
    codes.rejected = generateNationalCode((score) => score < minApprovalScore, taken);

    const category = await request<{ id: string }>('/admin/categories', {
      method: 'POST',
      token: adminToken,
      body: { slug: `e2e-credit-${RUN}`, titleFa: `دسته آزمون اعتباری ${RUN}`, defaultCommissionRate: 10 },
    });
    expect(category.status).toBe(201);
    categoryId = category.body.id;

    const v = await loginWithOtp(VENDOR_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    customer2 = await loginWithOtp(CUSTOMER_2_MOBILE);
    customer3 = await loginWithOtp(CUSTOMER_3_MOBILE);
    vendor = { ...v, vendorId: await onboardStore(v, `credit-e2e-${RUN}`) };
    const product = await request<{ variants: Array<{ id: string }> }>('/vendor/products', {
      method: 'POST',
      token: vendor.token,
      body: { title: `یخچال آزمون اعتباری ${RUN}`, categoryId, basePrice: 3_000_000, isPublished: true, variants: [{ sku: `CRD-${TAG}-P1`, price: 3_000_000, stockQuantity: 50 }] },
    });
    expect(product.status).toBe(201);
    variantId = product.body.variants[0]!.id;
    addressId = await createAddress(customer.token, '09971160002');
    address3Id = await createAddress(customer3.token, '09971160004');
  }, 180_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((row) => row.id);
      const orders = await prisma.parentOrder.findMany({ where: { userId: { in: userIds } }, select: { id: true, subOrders: { select: { id: true } } } });
      const orderIds = orders.map((row) => row.id);
      const subIds = orders.flatMap((row) => row.subOrders.map((sub) => sub.id));
      const payments = await prisma.payment.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true, creditReservationRef: true } });
      const accounts = await prisma.creditAccount.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const accountIds = accounts.map((row) => row.id);
      const applications = await prisma.creditApplication.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const schedules = await prisma.installmentSchedule.findMany({ where: { parentOrderId: { in: orderIds } }, select: { id: true } });
      const reservationRefs = (await prisma.creditTransaction.findMany({ where: { creditAccountId: { in: accountIds }, type: CreditTransactionType.PURCHASE_RESERVE_HOLD }, select: { referenceCode: true } })).map((r) => r.referenceCode);
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true, variants: { select: { id: true } } } });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const entityIds = [
        ...vendorIds,
        ...productIds,
        ...variantIds,
        ...orderIds,
        ...subIds,
        ...payments.map((p) => p.id),
        ...accountIds,
        ...applications.map((a) => a.id),
        ...schedules.map((s) => s.id),
        categoryId,
      ].filter(Boolean);

      await prisma.auditLog.deleteMany({ where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: entityIds } }] } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.payment.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.installmentSchedule.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.creditTransaction.deleteMany({ where: { creditAccountId: { in: accountIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });
      await prisma.creditAccount.deleteMany({ where: { id: { in: accountIds } } });
      await prisma.creditApplication.deleteMany({ where: { userId: { in: userIds } } });
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

      const configKeys = [...Object.values(SHIPPING_CONFIG_KEYS), CREDIT_CONFIG_KEYS.enabled, CREDIT_CONFIG_KEYS.activeProvider];
      await prisma.systemConfig.deleteMany({ where: { key: { in: configKeys } } });
      for (const row of savedConfigs) await prisma.systemConfig.create({ data: row });
      await app.get(CategoriesService).invalidateTree();

      for (const paymentId of [...new Set([...paymentIds, ...payments.map((p) => p.id)])]) {
        const authority = await redis.client.get(`payment:sandbox:payment:${paymentId}`);
        await redis.client.del(`payment:sandbox:payment:${paymentId}`, ...(authority ? [`payment:sandbox:session:${authority}`] : []));
      }
      const refs = [...new Set([...reservationRefs, ...payments.map((p) => p.creditReservationRef).filter((r): r is string => r !== null)])];
      if (refs.length > 0) await redis.client.del(...refs.map(sandboxReservationKey));
      // Reservations whose transaction rolled back (e.g. the loser of the concurrency test) never reach the DB:
      // find them by the suite's orders in the sandbox bank's own records.
      const suiteOrders = new Set(orderIds);
      for (const key of await redis.client.keys(sandboxReservationKey('*'))) {
        const raw = await redis.client.get(key);
        const record = raw === null ? null : (JSON.parse(raw) as { parentOrderId?: string });
        if (record?.parentOrderId !== undefined && suiteOrders.has(record.parentOrderId)) await redis.client.del(key);
      }
      if (userIds.length > 0) await redis.client.del(...userIds.flatMap((id) => [creditApplyCountKey(id), creditApplyLockKey(id)]));
      await resetKeys();
    }
    await app?.close();
  }, 120_000);

  async function resetKeys(): Promise<void> {
    const client = app.get(RedisService).client;
    const keys = [
      ...(await client.keys('auth:otp:hourly:ip:*')),
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
    if (keys.length > 0) await client.del(...keys);
  }

  // ─── 1. plans ──────────────────────────────────────────────────────────────

  describe('instalment plans', () => {
    it('lists the active plans of the active (sandbox) provider publicly', async () => {
      const response = await request<{ creditEnabled: boolean; provider: { code: string; isSandbox: boolean }; items: Plan[] }>('/credit/plans');
      expect(response.status).toBe(200);
      expect(response.body.creditEnabled).toBe(true);
      expect(response.body.provider).toMatchObject({ code: 'SANDBOX_BANK', isSandbox: true });
      expect(response.body.items.map((plan) => [plan.durationMonths, plan.interestRatePercent])).toEqual([
        [3, '0.00'],
        [6, '9.00'],
        [12, '18.00'],
      ]);
      expect(response.body.items.every((plan) => plan.installmentIntervalDays === 30)).toBe(true);
      for (const plan of response.body.items) plans[plan.durationMonths as 3 | 6 | 12] = plan;
    });

    it('offers nothing and refuses credit operations while credit.enabled is false', async () => {
      await setConfig(CREDIT_CONFIG_KEYS.enabled, 'false', 'BOOLEAN');
      try {
        const listed = await request<{ creditEnabled: boolean; items: Plan[] }>('/credit/plans');
        expect(listed.body).toMatchObject({ creditEnabled: false, items: [] });
        const applied = await request<ErrorBody>('/credit/applications', {
          method: 'POST',
          token: customer.token,
          body: { requestedLimit: 20_000_000, nationalCode: codes.approved, providerCode: 'SANDBOX_BANK' },
        });
        expect(applied.status).toBe(503);
        expect(applied.body.code).toBe('CREDIT_DISABLED');
      } finally {
        await setConfig(CREDIT_CONFIG_KEYS.enabled, 'true', 'BOOLEAN');
      }
    });
  });

  // ─── 2. applications ───────────────────────────────────────────────────────

  describe('credit applications', () => {
    const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      requestedLimit: 20_000_000,
      nationalCode: codes.approved,
      providerCode: 'SANDBOX_BANK',
      ...overrides,
    });

    it('enforces authentication, role and validation', async () => {
      expect((await request('/credit/applications', { method: 'POST', body: body() })).status).toBe(401);
      expect((await request('/credit/applications', { method: 'POST', token: vendor.token, body: body() })).status).toBe(403);
      const badChecksum = `${codes.approved.slice(0, 9)}${(Number(codes.approved[9]) + 1) % 10}`;
      expect((await request('/credit/applications', { method: 'POST', token: customer.token, body: body({ nationalCode: badChecksum }) })).status).toBe(400);
      expect((await request('/credit/applications', { method: 'POST', token: customer.token, body: body({ requestedLimit: 20_000_000.5 }) })).status).toBe(400);
      expect((await request('/credit/applications', { method: 'POST', token: customer.token, body: body({ requestedLimit: 0 }) })).status).toBe(400);
      const inactive = await request<ErrorBody>('/credit/applications', { method: 'POST', token: customer.token, body: body({ providerCode: 'BLUBANK' }) });
      expect(inactive.status).toBe(409);
      expect(inactive.body.code).toBe('CREDIT_PROVIDER_NOT_ACTIVE');
    });

    it('records a rejection with its reason and opens no account (score below threshold)', async () => {
      const response = await request<Application>('/credit/applications', { method: 'POST', token: customer2.token, body: body({ nationalCode: codes.rejected }) });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ status: 'REJECTED', decisionReason: 'SCORE_BELOW_THRESHOLD', approvedLimit: null, account: null, score: sandboxCreditScore(codes.rejected) });
      expect(response.body.provider).toMatchObject({ code: 'SANDBOX_BANK', isSandbox: true });
      expect(await prisma.creditAccount.count({ where: { userId: customer2.userId } })).toBe(0);
      expect((await prisma.user.findUniqueOrThrow({ where: { id: customer2.userId } })).nationalCode).toBeNull();
      const missing = await request<ErrorBody>('/credit/account', { token: customer2.token });
      expect(missing.status).toBe(404);
      expect(missing.body.code).toBe('CREDIT_ACCOUNT_NOT_FOUND');
    });

    it('approves instantly: application, account with the exact limit and one CREDIT_ALLOCATION row, in one step', async () => {
      const response = await request<Application>('/credit/applications', { method: 'POST', token: customer.token, body: body() });
      expect(response.status).toBe(201);
      application = response.body;
      expect(application).toMatchObject({ status: 'APPROVED', requestedLimit: '20000000.00', approvedLimit: '20000000.00', decisionReason: null, score: sandboxCreditScore(codes.approved) });
      expect(application.trackingCode).toMatch(/^SBXA-[0-9A-F]{16}$/);
      expect(application.account).toMatchObject({ status: 'ACTIVE', totalLimit: '20000000.00', usedAmount: '0.00', reservedAmount: '0.00', availableAmount: '20000000.00', currency: 'IRR' });
      accountId = application.account!.id;

      const ledgerRows = await prisma.creditTransaction.findMany({ where: { creditAccountId: accountId } });
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({ type: 'CREDIT_ALLOCATION', referenceCode: application.id });
      expect(ledgerRows[0]!.amount.toFixed(2)).toBe('20000000.00');
      expect(ledgerRows[0]!.balanceAfter.toFixed(2)).toBe('20000000.00');
      await expectAccount(accountId, { total: 20_000_000, used: 0, reserved: 0, available: 20_000_000 });

      expect((await prisma.user.findUniqueOrThrow({ where: { id: customer.userId } })).nationalCode).toBe(codes.approved);
      expect(await prisma.auditLog.count({ where: { entityName: 'CreditApplication', entityId: application.id, action: AuditAction.CREDIT_DECISION } })).toBe(1);
    });

    it('GET /credit/account returns the balances and the active provider', async () => {
      const current = await account();
      expect(current).toMatchObject({
        id: accountId,
        provider: { code: 'SANDBOX_BANK', isSandbox: true },
        status: 'ACTIVE',
        totalLimit: '20000000.00',
        usedAmount: '0.00',
        reservedAmount: '0.00',
        availableAmount: '20000000.00',
        outstanding: { count: 0, overdueCount: 0, principal: '0.00', interest: '0.00', nextDueDate: null },
      });
      expect((await request('/credit/account')).status).toBe(401);
    });

    it('refuses a second account with the same provider and a national code of another user', async () => {
      const again = await request<ErrorBody>('/credit/applications', { method: 'POST', token: customer.token, body: body() });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('CREDIT_ACCOUNT_EXISTS');
      const stolen = await request<ErrorBody>('/credit/applications', { method: 'POST', token: customer3.token, body: body() });
      expect(stolen.status).toBe(409);
      expect(stolen.body.code).toBe('NATIONAL_CODE_IN_USE');
    });

    it('opens the account of the third customer (used by the concurrency test)', async () => {
      const response = await request<Application>('/credit/applications', {
        method: 'POST',
        token: customer3.token,
        body: body({ nationalCode: codes.approved3, requestedLimit: 10_000_000 }),
      });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ status: 'APPROVED', approvedLimit: '10000000.00' });
    });
  });

  // ─── 3. BANK_CREDIT ────────────────────────────────────────────────────────

  describe('BANK_CREDIT checkout', () => {
    beforeAll(async () => {
      creditOrder = await placeOrder(2);
    });

    it('prices the order as documented (6,450,000 IRR)', () => {
      expect(creditOrder.finalPayableAmount).toBe('6450000.00');
    });

    it('validates the request: role, ownership, plan and method', async () => {
      const payload = { parentOrderId: creditOrder.parentOrderId, planId: plans[6].id, paymentMethod: 'BANK_CREDIT' };
      expect((await request('/payments/credit/initiate', { method: 'POST', body: payload })).status).toBe(401);
      expect((await request('/payments/credit/initiate', { method: 'POST', token: vendor.token, body: payload })).status).toBe(403);
      expect((await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'BANK_CREDIT', customer2.token)).status).toBe(404);
      expect((await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'CASH_IPG')).status).toBe(400);
      const unknownPlan = await creditInitiate(creditOrder.parentOrderId, '00000000-0000-4000-8000-000000000000', 'BANK_CREDIT');
      expect(unknownPlan.status).toBe(400);
      expect(unknownPlan.body.code).toBe('INSTALLMENT_PLAN_NOT_AVAILABLE');
      const hybrid = await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'HYBRID');
      expect(hybrid.status).toBe(409);
      expect(hybrid.body.code).toBe('HYBRID_NOT_REQUIRED');
      await expectAccount(accountId, { total: 20_000_000, used: 0, reserved: 0, available: 20_000_000 });
    });

    it('completes immediately: order PAID, packages PENDING_APPROVAL, credit committed, schedule written, escrow funded', async () => {
      const escrowBefore = d((await vendorWallet()).pendingBalance);
      const stockBefore = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      const response = await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'BANK_CREDIT');
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        status: 'COMPLETED',
        orderNumber: creditOrder.orderNumber,
        paymentMethod: 'BANK_CREDIT',
        creditAmount: '6450000.00',
        cashAmount: '0.00',
        orderPaymentStatus: 'PAID',
        redirectUrl: null,
        schedule: { installments: 6, creditAmount: '6450000.00', totalInterest: '580500.00', totalPayable: '7030500.00' },
      });

      const order = await prisma.parentOrder.findUniqueOrThrow({ where: { id: creditOrder.parentOrderId }, include: { subOrders: true } });
      expect(order).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'BANK_CREDIT' });
      expect(order.subOrders.map((sub) => sub.status)).toEqual(['PENDING_APPROVAL']);
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: response.body.paymentId } });
      expect(payment).toMatchObject({ status: 'SUCCESSFUL', paymentMethod: 'BANK_CREDIT', purpose: 'ORDER_CHECKOUT', gatewayName: 'SANDBOX_BANK', creditAccountId: accountId, installmentPlanId: plans[6].id });
      expect(payment.creditAmount.toFixed(2)).toBe('6450000.00');
      expect(payment.cashAmount.toFixed(2)).toBe('0.00');

      // Schedule: 6 rows, 30 days apart from the (Tehran) payment date, principal sum = creditAmount exactly.
      const rows = await prisma.installmentSchedule.findMany({ where: { parentOrderId: creditOrder.parentOrderId }, orderBy: { installmentNumber: 'asc' } });
      expect(rows).toHaveLength(6);
      const purchaseDate = platformDate(order.paidAt!);
      rows.forEach((row, index) => {
        expect(row.installmentNumber).toBe(index + 1);
        expect(row.totalInstallments).toBe(6);
        expect(row.status).toBe('PENDING');
        expect(row.creditAccountId).toBe(accountId);
        expect(dbDateToCalendar(row.dueDate)).toBe(addDays(purchaseDate, 30 * (index + 1)));
        expect(row.principalAmount.toFixed(2)).toBe('1075000.00');
        expect(row.interestAmount.toFixed(2)).toBe('96750.00');
        expect(row.totalAmount.toFixed(2)).toBe('1171750.00');
      });
      expect(rows.reduce((acc, row) => acc.plus(row.principalAmount), d(0)).toFixed(2)).toBe('6450000.00');
      expect(response.body.schedule).toMatchObject({ firstDueDate: addDays(purchaseDate, 30), lastDueDate: addDays(purchaseDate, 180) });

      // Credit: HOLD then COMMIT of the same reservation; provider side COMMITTED.
      const ref = payment.creditReservationRef!;
      const movements = await prisma.creditTransaction.findMany({ where: { creditAccountId: accountId, referenceCode: ref }, orderBy: { createdAt: 'asc' } });
      expect(movements.map((m) => m.type).sort()).toEqual(['PURCHASE_COMMIT', 'PURCHASE_RESERVE_HOLD']);
      expect(movements.every((m) => m.amount.equals(6_450_000) && m.parentOrderId === creditOrder.parentOrderId)).toBe(true);
      expect(await sandboxReservation(ref)).toBe('COMMITTED');
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 0, available: 13_550_000 });

      // Escrow: 6,000,000 − 10 % = 5,400,000; stock committed.
      expect(d((await vendorWallet()).pendingBalance).minus(escrowBefore).toFixed(2)).toBe('5400000.00');
      const stockAfter = await prisma.productVariant.findUniqueOrThrow({ where: { id: variantId } });
      expect(stockAfter.stockQuantity).toBe(stockBefore.stockQuantity - 2);
      expect(stockAfter.reservedQuantity).toBe(stockBefore.reservedQuantity - 2);
      expect(await prisma.auditLog.count({ where: { entityName: 'Payment', entityId: payment.id, action: AuditAction.PAYMENT_CAPTURE } })).toBe(1);

      const current = await account();
      expect(current.outstanding).toMatchObject({ count: 6, overdueCount: 0, principal: '6450000.00', interest: '580500.00', nextDueDate: addDays(purchaseDate, 30) });
    });

    it('cannot be paid twice, and credit orders cannot be cancelled by the store yet', async () => {
      const again = await creditInitiate(creditOrder.parentOrderId, plans[6].id, 'BANK_CREDIT');
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('ORDER_NOT_PAYABLE');
      const cancel = await request<ErrorBody>(`/vendor/orders/${creditOrder.subOrders[0]!.id}/status`, {
        method: 'PATCH',
        token: vendor.token,
        body: { status: 'CANCELLED', reason: 'ناموجود' },
      });
      expect(cancel.status).toBe(409);
      expect(cancel.body.code).toBe('CREDIT_ORDER_REFUND_UNSUPPORTED');
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 0, available: 13_550_000 });
    });

    it('concurrent BANK_CREDIT submissions for one order complete it exactly once', async () => {
      const order3 = await placeOrder(1, customer3.token, address3Id);
      expect(order3.finalPayableAmount).toBe('3450000.00');
      const results = await Promise.all([
        creditInitiate(order3.parentOrderId, plans[3].id, 'BANK_CREDIT', customer3.token),
        creditInitiate(order3.parentOrderId, plans[3].id, 'BANK_CREDIT', customer3.token),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const account3 = await prisma.creditAccount.findFirstOrThrow({ where: { userId: customer3.userId } });
      await expectAccount(account3.id, { total: 10_000_000, used: 3_450_000, reserved: 0, available: 6_550_000 });
      expect(await prisma.creditTransaction.count({ where: { creditAccountId: account3.id, type: 'PURCHASE_COMMIT' } })).toBe(1);
      expect(await prisma.installmentSchedule.count({ where: { parentOrderId: order3.parentOrderId } })).toBe(3);
    });
  });

  // ─── 4. HYBRID ─────────────────────────────────────────────────────────────

  describe('HYBRID checkout', () => {
    beforeAll(async () => {
      hybridOrder = await placeOrder(5);
    });

    it('prices the order (15,450,000) above the available credit; BANK_CREDIT is refused', async () => {
      expect(hybridOrder.finalPayableAmount).toBe('15450000.00');
      const refused = await creditInitiate(hybridOrder.parentOrderId, plans[3].id, 'BANK_CREDIT');
      expect(refused.status).toBe(409);
      expect(refused.body.code).toBe('INSUFFICIENT_CREDIT');
    });

    it('a failed card part rolls the credit reservation back; the order stays payable', async () => {
      const started = await creditInitiate(hybridOrder.parentOrderId, plans[3].id, 'HYBRID');
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ status: 'IPG_REQUIRED', paymentMethod: 'HYBRID', creditAmount: '13550000.00', cashAmount: '1900000.00', gatewayName: 'SANDBOX', orderPaymentStatus: 'PENDING', schedule: null });
      expect(started.body.redirectUrl).toMatch(new RegExp(`/api/v1/sandbox/payment-page/${started.body.paymentId}$`));
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: started.body.paymentId } });
      expect(payment).toMatchObject({ status: 'INITIATED', paymentMethod: 'HYBRID' });
      expect(payment.cashAmount.toFixed(2)).toBe('1900000.00');
      expect(payment.creditAmount.toFixed(2)).toBe('13550000.00');
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 13_550_000, available: 0 });
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('RESERVED');

      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'DECLINE'));
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'FAILED', paymentStatus: 'FAILED', orderPaymentStatus: 'PENDING', canRetry: true, paymentMethod: 'HYBRID', creditAmount: '13550000.00', cashAmount: '1900000.00' });
      await expectAccount(accountId, { total: 20_000_000, used: 6_450_000, reserved: 0, available: 13_550_000 });
      const release = await prisma.creditTransaction.findFirstOrThrow({ where: { type: 'RESERVATION_RELEASE', referenceCode: payment.creditReservationRef! } });
      expect(release.amount.toFixed(2)).toBe('13550000.00');
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('RELEASED');
      expect(await prisma.installmentSchedule.count({ where: { parentOrderId: hybridOrder.parentOrderId } })).toBe(0);
    });

    it('a verified card part completes the order: PAID, credit committed, cash recorded, schedule written', async () => {
      const escrowBefore = d((await vendorWallet()).pendingBalance);
      const started = await creditInitiate(hybridOrder.parentOrderId, plans[3].id, 'HYBRID');
      expect(started.status).toBe(201);
      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'PAY'));
      expect(outcome.status).toBe(200);
      expect(outcome.body).toMatchObject({ outcome: 'PAID', paymentStatus: 'SUCCESSFUL', orderPaymentStatus: 'PAID', purpose: 'ORDER_CHECKOUT', paymentMethod: 'HYBRID' });
      expect(outcome.body.bankRrn).toMatch(/^\d{12}$/);

      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: started.body.paymentId } });
      expect(payment.status).toBe('SUCCESSFUL');
      expect(payment.cashAmount.toFixed(2)).toBe('1900000.00');
      expect(payment.bankRrn).toBe(outcome.body.bankRrn);
      const order = await prisma.parentOrder.findUniqueOrThrow({ where: { id: hybridOrder.parentOrderId } });
      expect(order).toMatchObject({ paymentStatus: 'PAID', paymentMethod: 'HYBRID' });
      await expectAccount(accountId, { total: 20_000_000, used: 20_000_000, reserved: 0, available: 0 });
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('COMMITTED');

      const rows = await prisma.installmentSchedule.findMany({ where: { parentOrderId: hybridOrder.parentOrderId }, orderBy: { installmentNumber: 'asc' } });
      expect(rows.map((row) => row.principalAmount.toFixed(0))).toEqual(['4516666', '4516666', '4516668']);
      expect(rows.every((row) => row.interestAmount.isZero())).toBe(true);
      const purchaseDate = platformDate(order.paidAt!);
      expect(rows.map((row) => dbDateToCalendar(row.dueDate))).toEqual([30, 60, 90].map((days) => addDays(purchaseDate, days)));
      // 15,000,000 − 10 % = 13,500,000 into escrow
      expect(d((await vendorWallet()).pendingBalance).minus(escrowBefore).toFixed(2)).toBe('13500000.00');

      const repeated = await request<Outcome>(`/payments/callback?Authority=${payment.gatewayTrackingToken!}&Status=OK`);
      expect(repeated.body.outcome).toBe('PAID');
      expect(await prisma.creditTransaction.count({ where: { type: 'PURCHASE_COMMIT', referenceCode: payment.creditReservationRef! } })).toBe(1);
    });
  });

  // ─── 5. instalments ────────────────────────────────────────────────────────

  describe('instalments and repayment', () => {
    it('lists instalments grouped by order', async () => {
      const overview = await installments();
      expect(overview.orders.map((o) => o.orderNumber).sort()).toEqual([creditOrder.orderNumber, hybridOrder.orderNumber].sort());
      const first = overview.orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!;
      expect(first).toMatchObject({ paymentMethod: 'BANK_CREDIT', creditAmount: '6450000.00', totalInterest: '580500.00', totalPayable: '7030500.00', paidAmount: '0.00', remainingAmount: '7030500.00', paidCount: 0 });
      expect(first.plan).toMatchObject({ id: plans[6].id, durationMonths: 6 });
      expect(first.installments.map((i) => i.status)).toEqual(Array(6).fill('PENDING'));
      expect(first.installments[0]).toMatchObject({ amountDue: '1171750.00', paidAt: null });
      expect(overview.totalRemaining).toBe('20580500.00'); // 7,030,500 + 13,550,000
    });

    it('marks an instalment whose due date has passed as OVERDUE', async () => {
      const second = await prisma.installmentSchedule.findFirstOrThrow({ where: { parentOrderId: creditOrder.parentOrderId, installmentNumber: 2 } });
      await prisma.installmentSchedule.update({ where: { id: second.id }, data: { dueDate: calendarDateToDb(addDays(platformDate(new Date()), -1)) } });
      const overview = await installments();
      const first = overview.orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!;
      expect(first.installments.map((i) => i.status)).toEqual(['PENDING', 'OVERDUE', 'PENDING', 'PENDING', 'PENDING', 'PENDING']);
      expect(overview.overdueCount).toBe(1);
      // the scheduler's sweep is idempotent
      expect(await app.get(InstallmentsService).markOverdue()).toBe(0);
    });

    it('guards the pay endpoint: auth, ownership, id format', async () => {
      const target = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[0]!;
      expect((await request(`/credit/installments/${target.id}/pay`, { method: 'POST' })).status).toBe(401);
      expect((await request(`/credit/installments/${target.id}/pay`, { method: 'POST', token: customer2.token })).status).toBe(404);
      expect((await request('/credit/installments/not-a-uuid/pay', { method: 'POST', token: customer.token })).status).toBe(400);
    });

    it('a declined repayment leaves the instalment unpaid and payable', async () => {
      const target = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[2]!;
      const started = await request<{ paymentId: string; amount: string; redirectUrl: string }>(`/credit/installments/${target.id}/pay`, { method: 'POST', token: customer.token });
      expect(started.status).toBe(201);
      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'DECLINE'));
      expect(outcome.body).toMatchObject({ outcome: 'FAILED', purpose: 'INSTALLMENT_REPAYMENT', installmentScheduleId: target.id, canRetry: true });
      expect((await prisma.installmentSchedule.findUniqueOrThrow({ where: { id: target.id } })).status).toBe('PENDING');
      await expectAccount(accountId, { total: 20_000_000, used: 20_000_000, reserved: 0, available: 0 });
    });

    it('paying an instalment marks it PAID and restores its principal to the credit line', async () => {
      const target = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[0]!;
      const started = await request<{ paymentId: string; amount: string; redirectUrl: string; installmentNumber: number; gatewayName: string }>(
        `/credit/installments/${target.id}/pay`,
        { method: 'POST', token: customer.token },
      );
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ amount: '1171750.00', installmentNumber: 1, gatewayName: 'SANDBOX' });
      const outcome = await request<Outcome>(await decide(started.body.paymentId, 'PAY'));
      expect(outcome.body).toMatchObject({ outcome: 'PAID', paymentStatus: 'SUCCESSFUL', purpose: 'INSTALLMENT_REPAYMENT', paymentMethod: 'CASH_IPG', cashAmount: '1171750.00', installmentScheduleId: target.id });

      const row = await prisma.installmentSchedule.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.status).toBe('PAID');
      expect(row.paidAt).not.toBeNull();
      expect(row.paidAmount.toFixed(2)).toBe('1171750.00');
      expect(row.bankTransactionId).toBe(outcome.body.bankRrn);
      const restore = await prisma.creditTransaction.findFirstOrThrow({ where: { type: 'INSTALLMENT_REPAYMENT_RESTORE', referenceCode: target.id } });
      expect(restore.amount.toFixed(2)).toBe('1075000.00');
      await expectAccount(accountId, { total: 20_000_000, used: 18_925_000, reserved: 0, available: 1_075_000 });

      const again = await request<ErrorBody>(`/credit/installments/${target.id}/pay`, { method: 'POST', token: customer.token });
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('INSTALLMENT_NOT_PAYABLE');
    });

    it('an OVERDUE instalment can be paid too', async () => {
      const overdue = (await installments()).orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!.installments[1]!;
      expect(overdue.status).toBe('OVERDUE');
      const started = await request<{ paymentId: string }>(`/credit/installments/${overdue.id}/pay`, { method: 'POST', token: customer.token });
      expect(started.status).toBe(201);
      expect((await request<Outcome>(await decide(started.body.paymentId, 'PAY'))).body.outcome).toBe('PAID');
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 0, available: 2_150_000 });
      const overview = await installments();
      const first = overview.orders.find((o) => o.parentOrderId === creditOrder.parentOrderId)!;
      expect(first).toMatchObject({ paidCount: 2, overdueCount: 0, paidAmount: '2343500.00', remainingAmount: '4687000.00' });
    });
  });

  // ─── 6. cancellation releases credit ───────────────────────────────────────

  describe('unpaid order closure', () => {
    it('cancelling an order with a HYBRID attempt in flight releases the reservation; a late capture is flagged and never re-uses credit', async () => {
      const order = await placeOrder(1);
      const started = await creditInitiate(order.parentOrderId, plans[3].id, 'HYBRID');
      expect(started.status).toBe(201);
      expect(started.body).toMatchObject({ creditAmount: '2150000.00', cashAmount: '1300000.00' });
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 2_150_000, available: 0 });

      const cancelled = await request(`/customer/orders/${order.parentOrderId}/cancel`, { method: 'POST', token: customer.token, body: {} });
      expect(cancelled.status).toBe(200);
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 0, available: 2_150_000 });
      const payment = await prisma.payment.findUniqueOrThrow({ where: { id: started.body.paymentId } });
      expect(await sandboxReservation(payment.creditReservationRef!)).toBe('RELEASED');

      const late = await request<Outcome>(await decide(started.body.paymentId, 'PAY'));
      expect(late.body).toMatchObject({ outcome: 'PAID_REQUIRES_REFUND', orderPaymentStatus: 'CANCELLED' });
      await expectAccount(accountId, { total: 20_000_000, used: 17_850_000, reserved: 0, available: 2_150_000 });
      expect(await prisma.installmentSchedule.count({ where: { parentOrderId: order.parentOrderId } })).toBe(0);
    });
  });

  // ─── 7. staff views ────────────────────────────────────────────────────────

  describe('staff credit views', () => {
    it('are restricted to finance staff and admins', async () => {
      for (const path of ['/admin/credit/applications', '/admin/credit/accounts']) {
        expect((await request(path)).status).toBe(401);
        expect((await request(path, { token: supportToken })).status).toBe(403);
        expect((await request(path, { token: customer.token })).status).toBe(403);
        expect((await request(path, { token: adminToken })).status).toBe(200);
      }
    });

    it('lists applications with masked national codes and filters', async () => {
      const mine = await request<Page<Application & { user: { id: string; nationalCodeMasked: string | null } }>>(`/admin/credit/applications?userId=${customer.userId}`, { token: financeToken });
      expect(mine.status).toBe(200);
      expect(mine.body.total).toBe(1);
      expect(mine.body.items[0]).toMatchObject({ id: application.id, status: 'APPROVED', user: { id: customer.userId, nationalCodeMasked: `******${codes.approved.slice(-4)}` } });
      expect(mine.body.items[0]!.account).toMatchObject({ id: accountId });
      expect(JSON.stringify(mine.body)).not.toContain(codes.approved);
      const rejected = await request<Page<Application>>(`/admin/credit/applications?status=REJECTED&userId=${customer2.userId}`, { token: financeToken });
      expect(rejected.body.items.map((row) => row.decisionReason)).toEqual(['SCORE_BELOW_THRESHOLD']);
      expect((await request('/admin/credit/applications?status=NOPE', { token: financeToken })).status).toBe(400);
    });

    it('lists accounts with the aggregated exposure and a consistent ledger', async () => {
      const scoped = await request<Page<Account> & { exposure: Record<string, unknown> }>(`/admin/credit/accounts?userId=${customer.userId}`, { token: financeToken });
      expect(scoped.status).toBe(200);
      expect(scoped.body.items.map((row) => row.id)).toEqual([accountId]);
      expect(scoped.body.exposure).toMatchObject({
        accounts: 1,
        totalLimit: '20000000.00',
        used: '17850000.00',
        reserved: '0.00',
        available: '2150000.00',
        outstandingInstallments: '18237000.00', // order 1: 4 × 1,171,750 = 4,687,000; order 2: 13,550,000
        overdueInstallments: 0,
        ledgerConsistent: true,
        inconsistentAccounts: 0,
      });

      const all = await request<Page<Account> & { exposure: { accounts: number; totalLimit: string; used: string; ledgerConsistent: boolean } }>('/admin/credit/accounts', { token: financeToken });
      const totals = await prisma.creditAccount.aggregate({ _count: { _all: true }, _sum: { totalLimit: true, usedAmount: true } });
      expect(all.body.exposure.accounts).toBe(totals._count._all);
      expect(all.body.exposure.totalLimit).toBe(d(totals._sum.totalLimit ?? 0).toFixed(2));
      expect(all.body.exposure.used).toBe(d(totals._sum.usedAmount ?? 0).toFixed(2));
      expect(all.body.exposure.ledgerConsistent).toBe(true);
    });

    it('the financial overview separates card money, credit-funded sales and instalment collections', async () => {
      const response = await request<{ sales: { collectedByGateway: string; fundedByCredit: string; installmentsCollected: string } }>('/admin/financial/overview', { token: financeToken });
      expect(response.status).toBe(200);
      const sum = async (purpose: 'ORDER_CHECKOUT' | 'INSTALLMENT_REPAYMENT'): Promise<{ cash: string; credit: string }> => {
        const agg = await prisma.payment.aggregate({ where: { status: 'SUCCESSFUL', purpose }, _sum: { cashAmount: true, creditAmount: true } });
        return { cash: d(agg._sum.cashAmount ?? 0).toFixed(2), credit: d(agg._sum.creditAmount ?? 0).toFixed(2) };
      };
      const checkout = await sum('ORDER_CHECKOUT');
      const repayment = await sum('INSTALLMENT_REPAYMENT');
      expect(response.body.sales).toMatchObject({ collectedByGateway: checkout.cash, fundedByCredit: checkout.credit, installmentsCollected: repayment.cash });
      expect(d(response.body.sales.installmentsCollected).greaterThanOrEqualTo(2_343_500)).toBe(true);
    });
  });

  // ─── 8. invariant across everything ────────────────────────────────────────

  describe('credit invariant', () => {
    it('holds for every account touched by the suite and equals the replay of its ledger', async () => {
      const accounts = await prisma.creditAccount.findMany({ where: { user: { mobile: { in: SUITE_MOBILES } } }, select: { id: true } });
      expect(accounts).toHaveLength(2);
      for (const { id } of accounts) {
        const row = await prisma.creditAccount.findUniqueOrThrow({ where: { id } });
        await expectAccount(id, { total: row.totalLimit.toNumber(), used: row.usedAmount.toNumber(), reserved: row.reservedAmount.toNumber(), available: row.availableAmount.toNumber() });
      }
      // the database CHECK constraint refuses a write that would break it
      await expect(prisma.creditAccount.update({ where: { id: accountId }, data: { availableAmount: { increment: 1 } } })).rejects.toThrow();
    });
  });

  // ─── 9. contract ───────────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every Phase 8 route under its tag', () => {
      const document = buildOpenApiDocument(app) as unknown as { paths: Record<string, Record<string, { tags?: string[]; responses: Record<string, unknown> }>>; tags: Array<{ name: string }> };
      const expected: Array<[string, string, string]> = [
        ['/api/v1/credit/applications', 'post', 'credit'],
        ['/api/v1/credit/account', 'get', 'credit'],
        ['/api/v1/credit/plans', 'get', 'credit'],
        ['/api/v1/payments/credit/initiate', 'post', 'credit-payments'],
        ['/api/v1/credit/installments', 'get', 'credit-installments'],
        ['/api/v1/credit/installments/{id}/pay', 'post', 'credit-installments'],
        ['/api/v1/admin/credit/applications', 'get', 'admin-credit'],
        ['/api/v1/admin/credit/accounts', 'get', 'admin-credit'],
      ];
      for (const [path, method, tag] of expected) {
        const operation = document.paths[path]?.[method];
        expect({ path, method, documented: operation !== undefined }).toEqual({ path, method, documented: true });
        expect(operation!.tags).toContain(tag);
        expect(Object.keys(operation!.responses).length).toBeGreaterThanOrEqual(2);
      }
      const tags = document.tags.map((tag) => tag.name);
      for (const tag of ['credit', 'credit-payments', 'credit-installments', 'admin-credit']) expect(tags).toContain(tag);
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

### `apps/backend/test/seed.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { UserRole, VendorStatus } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { seedDatabase, normalizeEmail } from '../prisma/seed';
import { isArgon2idHash, verifyPassword } from '../src/infra/security/password';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Runs the deterministic seed against the real PostgreSQL instance and asserts
 * the guarantees the development workflow depends on: identity, catalogue,
 * commission rates, the credit portfolio and — most importantly — that no
 * fabricated financial data or credentials ever reach the database.
 *
 * Nothing is mocked: the seed is executed on the live database and the resulting
 * rows are read back through Prisma.
 */
describe('Seed (e2e, real PostgreSQL)', () => {
  let prisma: PrismaClient;
  const adminMobile = '+989120000001';
  const adminEmail = normalizeEmail(process.env.SUPER_ADMIN_EMAIL ?? '');

  beforeAll(() => {
    const config = new ConfigService(process.env);
    prisma = new PrismaService(config);
    if (adminEmail === '') {
      throw new Error('SUPER_ADMIN_EMAIL must be defined (the seed loads it from the root .env).');
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('identity and access', () => {
    it('creates the super admin with the mandatory mobile as its business key', async () => {
      await seedDatabase(prisma);

      const admin = await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } });

      expect(admin.role).toBe(UserRole.SUPER_ADMIN);
      expect(admin.isActive).toBe(true);
      expect(admin.email).toBe(adminEmail);
      expect(admin.nationalCode).toBeNull();
    });

    it('seeds the support and financial-officer staff accounts required by the flows', async () => {
      const [support, finance] = await Promise.all([
        prisma.user.findUnique({ where: { mobile: '+989120000002' } }),
        prisma.user.findUnique({ where: { mobile: '+989120000003' } }),
      ]);

      expect(support?.role).toBe(UserRole.SUPPORT);
      expect(finance?.role).toBe(UserRole.FINANCIAL_OFFICER);
    });

    it('stores credentials as Argon2id hashes that verify the configured password', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } });

      expect(admin.passwordHash).not.toBeNull();
      expect(isArgon2idHash(admin.passwordHash ?? '')).toBe(true);
      expect(admin.passwordHash).not.toContain(process.env.SUPER_ADMIN_PASSWORD ?? '__none__');
      await expect(
        verifyPassword(admin.passwordHash ?? '', process.env.SUPER_ADMIN_PASSWORD ?? ''),
      ).resolves.toBe(true);
    });

    it('rejects a login for an account whose credential does not match', async () => {
      const admin = await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } });

      await expect(verifyPassword(admin.passwordHash ?? '', 'definitely-not-the-password')).resolves.toBe(
        false,
      );
    });
  });

  describe('catalogue and categories', () => {
    it('seeds the category tree with commission rates on every row', async () => {
      const root = await prisma.category.findUniqueOrThrow({
        where: { slug: 'digital' },
        include: { children: true },
      });

      expect(root.titleFa).toBe('کالای دیجیتال');
      expect(root.children.length).toBeGreaterThan(0);
      expect(root.children.every((child) => child.parentId === root.id)).toBe(true);

      const withoutRate = await prisma.category.count({ where: { defaultCommissionRate: { lte: 0 } } });
      expect(withoutRate).toBe(0);
    });

    it('creates the sample vendor as an approved store owned by a VENDOR user with a wallet', async () => {
      const vendor = await prisma.vendor.findUniqueOrThrow({
        where: { storeSlug: 'shopino-sample-store' },
        include: { user: true, wallet: true, verifications: true, _count: { select: { products: true } } },
      });

      expect(vendor.status).toBe(VendorStatus.APPROVED);
      expect(vendor.verifiedAt).not.toBeNull();
      expect(vendor.user.role).toBe(UserRole.VENDOR);
      expect(vendor.wallet).not.toBeNull();
      expect(vendor.verifications.length).toBeGreaterThan(0);
      expect(vendor._count.products).toBeGreaterThan(0);
    });

    it('gives every product variants with stock and a category', async () => {
      const products = await prisma.product.findMany({
        include: { variants: true, media: true, category: true },
      });

      expect(products.length).toBeGreaterThan(0);
      for (const product of products) {
        expect(product.variants.length).toBeGreaterThan(0);
        expect(product.category.slug).not.toBe('');
        for (const variant of product.variants) {
          expect(variant.price.toString()).not.toBe('0');
          expect(variant.stockQuantity).toBeGreaterThan(0);
        }
      }
    });

    it('links product media to their product', async () => {
      const media = await prisma.productMedia.findFirst({ include: { product: true } });

      expect(media).not.toBeNull();
      expect(media?.product.id).toBe(media?.productId);
    });
  });

  describe('credit portfolio', () => {
    it('activates the sandbox provider and keeps real banks inactive', async () => {
      const sandbox = await prisma.creditProvider.findUniqueOrThrow({ where: { code: 'SANDBOX_BANK' } });
      const realBanks = await prisma.creditProvider.findMany({
        where: { code: { in: ['SAMAN_BANK', 'BLUBANK', 'DIGIPAY'] } },
      });

      expect(sandbox.isActive).toBe(true);
      expect(realBanks).toHaveLength(3);
      expect(realBanks.every((provider) => provider.isActive)).toBe(false);
    });

    it('publishes the 3 / 6 / 12 month plans, the 3-month one interest-free', async () => {
      const plans = await prisma.installmentPlan.findMany({
        where: { provider: { code: 'SANDBOX_BANK' }, isActive: true },
        orderBy: { durationMonths: 'asc' },
      });

      expect(plans.map((plan) => plan.durationMonths)).toEqual([3, 6, 12]);
      expect(plans[0]?.interestRatePercent.toString()).toBe('0');
      expect(plans[2]?.penaltyRatePercentPerMonth.toString()).not.toBe('0');
    });
  });

  describe('idempotency and integrity', () => {
    it('keeps every row count and the admin hash stable across a second run', async () => {
      const before = {
        users: await prisma.user.count(),
        categories: await prisma.category.count(),
        products: await prisma.product.count(),
        variants: await prisma.productVariant.count(),
        vendors: await prisma.vendor.count(),
        providers: await prisma.creditProvider.count(),
        plans: await prisma.installmentPlan.count(),
        configs: await prisma.systemConfig.count(),
        hash: (await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } })).passwordHash,
      };

      await seedDatabase(prisma);

      expect(await prisma.user.count()).toBe(before.users);
      expect(await prisma.category.count()).toBe(before.categories);
      expect(await prisma.product.count()).toBe(before.products);
      expect(await prisma.productVariant.count()).toBe(before.variants);
      expect(await prisma.vendor.count()).toBe(before.vendors);
      expect(await prisma.creditProvider.count()).toBe(before.providers);
      expect(await prisma.installmentPlan.count()).toBe(before.plans);
      expect(await prisma.systemConfig.count()).toBe(before.configs);
      expect((await prisma.user.findUniqueOrThrow({ where: { mobile: adminMobile } })).passwordHash).toBe(
        before.hash,
      );
    });

    it('fabricates no financial data', async () => {
      const [orders, payments, walletTx, settlements, creditAccounts, creditTx, schedules] = await Promise.all([
        prisma.parentOrder.count(),
        prisma.payment.count(),
        prisma.walletTransaction.count(),
        prisma.settlementRequest.count(),
        prisma.creditAccount.count(),
        prisma.creditTransaction.count(),
        prisma.installmentSchedule.count(),
      ]);

      expect([orders, payments, walletTx, settlements, creditAccounts, creditTx, schedules]).toEqual([
        0, 0, 0, 0, 0, 0, 0,
      ]);
    });

    it('keeps every vendor wallet at a zero balance', async () => {
      const wallets = await prisma.vendorWallet.findMany();

      for (const wallet of wallets) {
        expect(wallet.pendingBalance.toString()).toBe('0');
        expect(wallet.withdrawableBalance.toString()).toBe('0');
        expect(wallet.totalEarnedBalance.toString()).toBe('0');
      }
    });

    it('switches the credit feature flag on now that BNPL ships (Phase 8)', async () => {
      const flag = await prisma.systemConfig.findUniqueOrThrow({ where: { key: 'credit.enabled' } });

      expect(flag.value).toBe('true');
    });

    it('names the active credit provider explicitly in configuration', async () => {
      const config = await prisma.systemConfig.findUniqueOrThrow({ where: { key: 'credits.activeProvider' } });
      const provider = await prisma.creditProvider.findUnique({ where: { code: config.value } });

      expect(provider).not.toBeNull();
      expect(provider?.isActive).toBe(true);
    });
  });
});
```

## 11. Diff of changed files (vs `df3dd00`)

```diff
diff --git a/.env.example b/.env.example
index f15885f..6b852f1 100644
--- a/.env.example
+++ b/.env.example
@@ -191,3 +191,7 @@ PAYMENT_GATEWAY_TIMEOUT_MS=15000
 PAYMENT_RESULT_REDIRECT_URL=
 # An INITIATED payment protects its order from the expiry sweeper this long.
 PAYMENT_CALLBACK_GRACE_MINUTES=20
+
+# ─── Phase 8: BNPL instalments ───────────────────────────────────────────────
+# How often due instalments are marked OVERDUE (seconds; 0 disables the timer).
+INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=3600
diff --git a/apps/backend/prisma/schema.prisma b/apps/backend/prisma/schema.prisma
index 861d519..ce54444 100644
--- a/apps/backend/prisma/schema.prisma
+++ b/apps/backend/prisma/schema.prisma
@@ -591,6 +591,11 @@ model OrderItem {
 // 5. PAYMENTS, ESCROW & VENDOR SETTLEMENTS
 // ============================================================================
 
+enum PaymentPurpose {
+  ORDER_CHECKOUT
+  INSTALLMENT_REPAYMENT
+}
+
 enum PaymentStatus {
   INITIATED
   SUCCESSFUL
@@ -630,23 +635,40 @@ enum SettlementStatus {
 /// `gatewayName` is a string, not an enum: gateways are configuration, and
 /// adding one must not require a migration.
 model Payment {
-  id                   String        @id @default(uuid()) @db.Uuid
-  parentOrderId        String        @map("parent_order_id") @db.Uuid
-  parentOrder          ParentOrder   @relation(fields: [parentOrderId], references: [id], onDelete: Restrict)
-  gatewayName          String        @map("gateway_name") @db.VarChar(40)
-  gatewayTrackingToken String?       @map("gateway_tracking_token") @db.VarChar(120)
-  bankRrn              String?       @map("bank_rrn") @db.VarChar(40)
-  cashAmount           Decimal       @default(0) @map("cash_amount") @db.Decimal(15, 2)
-  creditAmount         Decimal       @default(0) @map("credit_amount") @db.Decimal(15, 2)
-  status               PaymentStatus @default(INITIATED)
-  paidAt               DateTime?     @map("paid_at") @db.Timestamptz(3)
-  metadata             Json?
-  createdAt            DateTime      @default(now()) @map("created_at") @db.Timestamptz(3)
-  updatedAt            DateTime      @updatedAt @map("updated_at") @db.Timestamptz(3)
+  id                    String               @id @default(uuid()) @db.Uuid
+  parentOrderId         String               @map("parent_order_id") @db.Uuid
+  parentOrder           ParentOrder          @relation(fields: [parentOrderId], references: [id], onDelete: Restrict)
+  /// What the money is for: the order itself, or one instalment of a BNPL order.
+  purpose               PaymentPurpose       @default(ORDER_CHECKOUT)
+  /// How this attempt splits the amount (CASH_IPG = card only, BANK_CREDIT = credit only, HYBRID = both).
+  paymentMethod         PaymentMethod        @default(CASH_IPG) @map("payment_method")
+  /// Credit line used by a BANK_CREDIT / HYBRID attempt.
+  creditAccountId       String?              @map("credit_account_id") @db.Uuid
+  creditAccount         CreditAccount?       @relation(fields: [creditAccountId], references: [id], onDelete: Restrict)
+  /// Instalment plan chosen for the credit part.
+  installmentPlanId     String?              @map("installment_plan_id") @db.Uuid
+  installmentPlan       InstallmentPlan?     @relation(fields: [installmentPlanId], references: [id], onDelete: Restrict)
+  /// Provider reservation reference of the credit part (reserve → commit | release).
+  creditReservationRef  String?              @map("credit_reservation_ref") @db.VarChar(80)
+  /// The instalment an INSTALLMENT_REPAYMENT payment settles.
+  installmentScheduleId String?              @map("installment_schedule_id") @db.Uuid
+  installmentSchedule   InstallmentSchedule? @relation(fields: [installmentScheduleId], references: [id], onDelete: Restrict)
+  gatewayName           String               @map("gateway_name") @db.VarChar(40)
+  gatewayTrackingToken  String?              @map("gateway_tracking_token") @db.VarChar(120)
+  bankRrn               String?              @map("bank_rrn") @db.VarChar(40)
+  cashAmount            Decimal              @default(0) @map("cash_amount") @db.Decimal(15, 2)
+  creditAmount          Decimal              @default(0) @map("credit_amount") @db.Decimal(15, 2)
+  status                PaymentStatus        @default(INITIATED)
+  paidAt                DateTime?            @map("paid_at") @db.Timestamptz(3)
+  metadata              Json?
+  createdAt             DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
+  updatedAt             DateTime             @updatedAt @map("updated_at") @db.Timestamptz(3)
 
   @@index([parentOrderId, status])
   @@index([status, createdAt])
   @@index([gatewayTrackingToken])
+  @@index([installmentScheduleId, status])
+  @@index([creditAccountId])
   @@map("payments")
 }
 
@@ -812,6 +834,7 @@ model CreditAccount {
 
   transactions         CreditTransaction[]
   installmentSchedules InstallmentSchedule[]
+  payments             Payment[]
 
   @@unique([userId, providerId])
   @@index([userId, status])
@@ -833,6 +856,9 @@ model CreditApplication {
   status                      CreditApplicationStatus @default(DRAFT)
   bankApplicationTrackingCode String?                 @map("bank_application_tracking_code") @db.VarChar(60)
   bankScoreResponse           Json?                   @map("bank_score_response")
+  /// Short machine-readable reason of a REJECTED decision (e.g. SCORE_BELOW_THRESHOLD).
+  decisionReason              String?                 @map("decision_reason") @db.VarChar(120)
+  decidedAt                   DateTime?               @map("decided_at") @db.Timestamptz(3)
   createdAt                   DateTime                @default(now()) @map("created_at") @db.Timestamptz(3)
   updatedAt                   DateTime                @updatedAt @map("updated_at") @db.Timestamptz(3)
 
@@ -851,6 +877,11 @@ model CreditApplication {
 ///   RESERVATION_RELEASE              → reserved −amount, available +amount
 ///   INSTALLMENT_REPAYMENT_RESTORE    → used −amount, available +amount
 ///   REFUND_RESTORE                   → used −amount, available +amount
+/// `amount` is always positive (the type carries the direction); `balanceAfter`
+/// is the account's availableAmount after the movement. `referenceCode` is the
+/// application id (allocation), the provider reservation ref (hold / commit /
+/// release) or the instalment id (repayment); (type, referenceCode) is unique,
+/// and a reservation ends at most once (commit XOR release) — migration phase8_credit.
 model CreditTransaction {
   id              String                @id @default(uuid()) @db.Uuid
   creditAccountId String                @map("credit_account_id") @db.Uuid
@@ -884,6 +915,8 @@ model InstallmentPlan {
   createdAt                  DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
   updatedAt                  DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)
 
+  payments Payment[]
+
   @@unique([providerId, durationMonths])
   @@index([providerId, isActive])
   @@map("installment_plans")
@@ -913,6 +946,8 @@ model InstallmentSchedule {
   createdAt         DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
   updatedAt         DateTime          @updatedAt @map("updated_at") @db.Timestamptz(3)
 
+  payments Payment[]
+
   @@unique([parentOrderId, installmentNumber])
   @@index([creditAccountId, status])
   @@index([status, dueDate])
diff --git a/apps/backend/prisma/seed.ts b/apps/backend/prisma/seed.ts
index 16e568c..ab9b350 100644
--- a/apps/backend/prisma/seed.ts
+++ b/apps/backend/prisma/seed.ts
@@ -292,6 +292,14 @@ const CREDIT_PROVIDERS: readonly CreditProviderSeed[] = [
       environment: 'sandbox',
       baseUrl: 'https://sandbox.credit.local/api/v1',
       merchantId: 'shopino-sandbox-merchant',
+      // Simulation rules of the development-only SandboxBankProvider (Phase 8):
+      // approve when the simulated score (derived from the national code) is at
+      // least minApprovalScore and the requested limit is at least
+      // minRequestedLimit; the approved limit is capped at maxApprovedLimit.
+      // Whole rials. Not business data of any real bank.
+      minApprovalScore: '600',
+      minRequestedLimit: '10000000',
+      maxApprovedLimit: '500000000',
     },
     plans: [
       { durationMonths: 3, title: 'خرید اعتباری ۳ ماهه (بدون سود)', interestRatePercent: '0.00', penaltyRatePercentPerMonth: '2.00' },
@@ -330,17 +338,17 @@ interface ConfigSeed {
 }
 
 /**
- * Baseline platform configuration. `credit.enabled` stays false and
- * `credits.activeProvider` names the sandbox explicitly: the platform must never
- * advertise a live credit feature before the BNPL flow is implemented, and the
- * active provider must always be visible in configuration.
+ * Baseline platform configuration. The BNPL flow exists since Phase 8, so
+ * `credit.enabled` is true; `credits.activeProvider` names the sandbox
+ * explicitly so the active (development-only) provider is always visible in
+ * configuration. Production must point it at a real bank integration.
  */
 const SYSTEM_CONFIGS: readonly ConfigSeed[] = [
   { key: 'platform.name', value: 'شاپینو', valueType: ConfigValueType.STRING, description: 'نام نمایشی پلتفرم' },
   { key: 'platform.currency', value: 'IRR', valueType: ConfigValueType.STRING, description: 'کد ارز پایه پلتفرم (ISO 4217)' },
   { key: 'platform.locale', value: 'fa-IR', valueType: ConfigValueType.STRING, description: 'زبان و قالب پیش‌فرض رابط کاربری' },
   { key: 'platform.timezone', value: 'Asia/Tehran', valueType: ConfigValueType.STRING, description: 'منطقهٔ زمانی مرجع برای گزارش‌ها و تسویه' },
-  { key: 'credit.enabled', value: 'false', valueType: ConfigValueType.BOOLEAN, description: 'فعال بودن خرید اعتباری (BNPL). تا زمان پیاده‌سازی این قابلیت خاموش است.' },
+  { key: 'credit.enabled', value: 'true', valueType: ConfigValueType.BOOLEAN, description: 'فعال بودن خرید اعتباری (BNPL). با false هیچ درخواست اعتبار یا خرید اعتباری جدیدی پذیرفته نمی‌شود.' },
   { key: 'credits.activeProvider', value: 'SANDBOX_BANK', valueType: ConfigValueType.STRING, description: 'کد ارائه‌دهندهٔ اعتبار فعال در محیط جاری' },
   { key: 'commerce.defaultCommissionRate', value: '12.00', valueType: ConfigValueType.NUMBER, description: 'نرخ کمیسیون پیش‌فرض پلتفرم (درصد) وقتی دسته‌بندی نرخ اختصاصی ندارد' },
   { key: 'commerce.escrowHoldDays', value: '7', valueType: ConfigValueType.NUMBER, description: 'مدت نگه‌داری وجه در حساب امانی پس از تحویل (روز)' },
diff --git a/apps/backend/src/app.module.ts b/apps/backend/src/app.module.ts
index c1da2dc..a2b5128 100644
--- a/apps/backend/src/app.module.ts
+++ b/apps/backend/src/app.module.ts
@@ -21,6 +21,8 @@ import { ProductsModule } from './modules/products/products.module';
 import { ShippingModule } from './modules/shipping/shipping.module';
 import { AddressesModule } from './modules/addresses/addresses.module';
 import { CartModule } from './modules/cart/cart.module';
+import { BnplModule } from './modules/bnpl/bnpl.module';
+import { CreditModule } from './modules/credit/credit.module';
 import { FinancialModule } from './modules/financial/financial.module';
 import { OrdersModule } from './modules/orders/orders.module';
 import { PaymentsModule } from './modules/payments/payments.module';
@@ -60,6 +62,8 @@ import { WalletModule } from './modules/wallet/wallet.module';
     PaymentsModule,
     SettlementsModule,
     FinancialModule,
+    CreditModule,
+    BnplModule,
   ],
   providers: [
     // Order matters: authentication runs first and populates `request.user`,
diff --git a/apps/backend/src/config/env.validation.ts b/apps/backend/src/config/env.validation.ts
index e05264a..64444c3 100644
--- a/apps/backend/src/config/env.validation.ts
+++ b/apps/backend/src/config/env.validation.ts
@@ -347,6 +347,16 @@ export class EnvironmentVariables {
   @Max(3600)
   ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS: number = 60;
 
+  /**
+   * How often PENDING instalments whose due date has passed are marked OVERDUE
+   * (seconds; 0 disables the timer, e.g. when a dedicated worker runs it).
+   */
+  @Type(() => Number)
+  @IsInt()
+  @Min(0)
+  @Max(86_400)
+  INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS: number = 3600;
+
   /**
    * Absolute origin the *customer's browser* and the bank reach this API on
    * (scheme + host [+ port], no path). Used to build the gateway callback URL
diff --git a/apps/backend/src/modules/financial/dto/financial.dto.ts b/apps/backend/src/modules/financial/dto/financial.dto.ts
index 4620e00..88995e0 100644
--- a/apps/backend/src/modules/financial/dto/financial.dto.ts
+++ b/apps/backend/src/modules/financial/dto/financial.dto.ts
@@ -20,8 +20,12 @@ export class SalesFiguresDto {
   @ApiProperty({ ...MONEY, description: 'GMV: items subtotal of active packages of paid orders (excludes shipping, cancelled and refunded packages).' })
   gmv!: string;
   @ApiProperty({ ...MONEY, description: 'Shipping fees of active packages of paid orders.' }) shippingFees!: string;
-  @ApiProperty({ ...MONEY, description: 'Cash captured by the gateway (SUCCESSFUL payments), including captures awaiting manual refund.' })
+  @ApiProperty({ ...MONEY, description: 'Cash captured by the gateway for orders (SUCCESSFUL ORDER_CHECKOUT payments; card part of HYBRID), including captures awaiting manual refund.' })
   collectedByGateway!: string;
+  @ApiProperty({ ...MONEY, description: 'Order amounts financed by bank credit (credit part of SUCCESSFUL BANK_CREDIT / HYBRID payments).' })
+  fundedByCredit!: string;
+  @ApiProperty({ ...MONEY, description: 'Instalment repayments captured by the gateway (SUCCESSFUL INSTALLMENT_REPAYMENT payments).' })
+  installmentsCollected!: string;
 }
 
 export class CommissionFiguresDto {
diff --git a/apps/backend/src/modules/financial/financial.service.ts b/apps/backend/src/modules/financial/financial.service.ts
index c88eb01..ea510b5 100644
--- a/apps/backend/src/modules/financial/financial.service.ts
+++ b/apps/backend/src/modules/financial/financial.service.ts
@@ -36,8 +36,11 @@ export class FinancialService {
         FROM parent_orders po
         JOIN sub_orders so ON so.parent_order_id = po.id
         WHERE po.payment_status = 'PAID' ${paidWindow}`),
-      this.prisma.$queryRaw<Array<{ collected: Money }>>(Prisma.sql`
-        SELECT SUM(cash_amount) AS collected FROM payments WHERE status = 'SUCCESSFUL' ${paymentWindow}`),
+      this.prisma.$queryRaw<Array<{ collected: Money; funded_by_credit: Money; installments_collected: Money }>>(Prisma.sql`
+        SELECT SUM(cash_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS collected,
+               SUM(credit_amount) FILTER (WHERE purpose = 'ORDER_CHECKOUT') AS funded_by_credit,
+               SUM(cash_amount) FILTER (WHERE purpose = 'INSTALLMENT_REPAYMENT') AS installments_collected
+        FROM payments WHERE status = 'SUCCESSFUL' ${paymentWindow}`),
       this.prisma.$queryRaw<Array<{ pending: Money; withdrawable: Money; hold: Money; withdrawn: Money }>>(Prisma.sql`
         SELECT SUM(pending_balance) AS pending, SUM(withdrawable_balance) AS withdrawable,
                SUM(settlement_hold_balance) AS hold, SUM(total_withdrawn_amount) AS withdrawn
@@ -79,6 +82,8 @@ export class FinancialService {
         gmv: money(s?.gmv ?? null),
         shippingFees: money(s?.shipping ?? null),
         collectedByGateway: money(collected[0]?.collected ?? null),
+        fundedByCredit: money(collected[0]?.funded_by_credit ?? null),
+        installmentsCollected: money(collected[0]?.installments_collected ?? null),
       },
       commission: { earned: earned.toFixed(2), pending: pending.toFixed(2), total: earned.plus(pending).toFixed(2) },
       wallets: {
diff --git a/apps/backend/src/modules/orders/order-audit.ts b/apps/backend/src/modules/orders/order-audit.ts
index ec2fb86..574ab53 100644
--- a/apps/backend/src/modules/orders/order-audit.ts
+++ b/apps/backend/src/modules/orders/order-audit.ts
@@ -23,7 +23,7 @@ export async function writeOrderAudit(
   actor: OrderActor,
   entry: {
     action: AuditAction;
-    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest';
+    entityName: 'ParentOrder' | 'SubOrder' | 'Payment' | 'SettlementRequest' | 'CreditApplication' | 'CreditAccount' | 'InstallmentSchedule';
     entityId: string;
     oldValue?: Record<string, unknown>;
     newValue: Record<string, unknown>;
diff --git a/apps/backend/src/modules/orders/order-lifecycle.service.ts b/apps/backend/src/modules/orders/order-lifecycle.service.ts
index 6db538b..ec3e88e 100644
--- a/apps/backend/src/modules/orders/order-lifecycle.service.ts
+++ b/apps/backend/src/modules/orders/order-lifecycle.service.ts
@@ -1,9 +1,10 @@
 import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { ConfigService } from '@nestjs/config';
-import { AuditAction, ParentOrderPaymentStatus, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
+import { AuditAction, ParentOrderPaymentStatus, PaymentMethod, PaymentStatus, Prisma, SubOrderStatus, VendorStatus } from '@prisma/client';
 import { conflictWith } from '../../common/http-errors';
 import type { EnvironmentVariables } from '../../config/env.validation';
 import { PrismaService } from '../../infra/prisma/prisma.service';
+import { CreditOrderService, type ProviderFollowUp } from '../credit/credit-order.service';
 import { InventoryService } from '../products/inventory.service';
 import { WalletLedgerService, type ReverseOutcome } from '../wallet/wallet-ledger.service';
 import type { ForceSubOrderStatusDto, VendorUpdateSubOrderStatusDto } from './dto/order-input.dto';
@@ -64,6 +65,7 @@ export class OrderLifecycleService {
     private readonly prisma: PrismaService,
     private readonly inventory: InventoryService,
     private readonly ledger: WalletLedgerService,
+    private readonly creditOrders: CreditOrderService,
     config: ConfigService<EnvironmentVariables, true>,
   ) {
     this.paymentGraceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
@@ -73,7 +75,8 @@ export class OrderLifecycleService {
 
   /** Customer cancels an order that has not been paid yet. */
   async cancelByCustomer(userId: string, parentOrderId: string, reason: string | undefined, actor: OrderActor): Promise<string> {
-    return this.prisma.$transaction(async (tx) => {
+    const followUps: ProviderFollowUp[] = [];
+    const auditLogId = await this.prisma.$transaction(async (tx) => {
       const locked = await lockParentOrder(tx, parentOrderId);
       const order = locked
         ? await tx.parentOrder.findFirst({ where: { id: parentOrderId, userId }, select: { id: true, paymentStatus: true } })
@@ -90,18 +93,23 @@ export class OrderLifecycleService {
           { paymentStatus: order.paymentStatus },
         );
       }
-      return this.closeUnpaid(tx, order.id, 'CUSTOMER_CANCEL', reason, actor);
+      return this.closeUnpaid(tx, order.id, 'CUSTOMER_CANCEL', reason, actor, followUps);
     });
+    await this.creditOrders.followUp(followUps);
+    return auditLogId;
   }
 
   /** Payment gateway reported failure for an unpaid order. Idempotent: returns `false` if not PENDING. */
   async markPaymentFailed(parentOrderId: string, reason?: string, actor: OrderActor = SYSTEM_ACTOR): Promise<boolean> {
-    return this.prisma.$transaction(async (tx) => {
+    const followUps: ProviderFollowUp[] = [];
+    const closed = await this.prisma.$transaction(async (tx) => {
       const order = await this.lockPending(tx, parentOrderId);
       if (!order) return false;
-      await this.closeUnpaid(tx, order.id, 'PAYMENT_FAILED', reason, actor);
+      await this.closeUnpaid(tx, order.id, 'PAYMENT_FAILED', reason, actor, followUps);
       return true;
     });
+    await this.creditOrders.followUp(followUps);
+    return closed;
   }
 
   /**
@@ -123,9 +131,16 @@ export class OrderLifecycleService {
    * `markPaid` for a caller that already runs the transaction and holds the
    * parent-order lock (the payment callback, which updates the Payment row in
    * the same transaction). Sub-orders keep PENDING_APPROVAL and become visible
-   * to vendors because the parent is now PAID.
+   * to vendors because the parent is now PAID. `paymentMethod` records how the
+   * order was paid (CASH_IPG, BANK_CREDIT or HYBRID; default CASH_IPG).
    */
-  async applyPaymentLocked(tx: Tx, parentOrderId: string, actor: OrderActor, payment: { paymentId?: string; bankRrn?: string }): Promise<PaymentApplication> {
+  async applyPaymentLocked(
+    tx: Tx,
+    parentOrderId: string,
+    actor: OrderActor,
+    payment: { paymentId?: string; bankRrn?: string; paymentMethod?: PaymentMethod },
+  ): Promise<PaymentApplication> {
+    const paymentMethod = payment.paymentMethod ?? PaymentMethod.CASH_IPG;
     const order = await tx.parentOrder.findFirst({
       where: { id: parentOrderId, paymentStatus: ParentOrderPaymentStatus.PENDING },
       select: { id: true },
@@ -143,7 +158,7 @@ export class OrderLifecycleService {
     const paidAt = new Date();
     await tx.parentOrder.update({
       where: { id: parentOrderId },
-      data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt },
+      data: { paymentStatus: ParentOrderPaymentStatus.PAID, paidAt, paymentMethod },
     });
     let escrowHeld = new Prisma.Decimal(0);
     for (const sub of subs) {
@@ -159,6 +174,7 @@ export class OrderLifecycleService {
       newValue: {
         paymentStatus: ParentOrderPaymentStatus.PAID,
         paidAt: paidAt.toISOString(),
+        paymentMethod,
         escrowHeld: escrowHeld.toFixed(2),
         packages: subs.length,
         ...(payment.paymentId ? { paymentId: payment.paymentId } : {}),
@@ -189,13 +205,15 @@ export class OrderLifecycleService {
     let expired = 0;
     for (const { id } of due) {
       try {
+        const followUps: ProviderFollowUp[] = [];
         const done = await this.prisma.$transaction(async (tx) => {
           const order = await this.lockPending(tx, id);
           if (!order || order.paymentExpiresAt === null || order.paymentExpiresAt > now) return false;
           if ((await tx.parentOrder.count({ where: { id, ...inFlight } })) > 0) return false;
-          await this.closeUnpaid(tx, id, 'PAYMENT_EXPIRED', undefined, SYSTEM_ACTOR);
+          await this.closeUnpaid(tx, id, 'PAYMENT_EXPIRED', undefined, SYSTEM_ACTOR, followUps);
           return true;
         });
+        await this.creditOrders.followUp(followUps);
         if (done) expired += 1;
       } catch (error) {
         this.logger.error(`Could not expire order ${id}: ${error instanceof Error ? error.message : String(error)}`);
@@ -302,11 +320,25 @@ export class OrderLifecycleService {
     });
   }
 
-  /** Unpaid order leaves the funnel: reservations released, every package CANCELLED. Parent row must be locked. */
-  private async closeUnpaid(tx: Tx, parentOrderId: string, outcome: UnpaidOutcome, reason: string | undefined, actor: OrderActor): Promise<string> {
+  /**
+   * Unpaid order leaves the funnel: credit reservations released (before stock,
+   * per the lock order parent → credit account → stock → wallets), stock
+   * reservations released, every package CANCELLED. Parent row must be locked;
+   * the provider-side releases are appended to `followUps` for after the commit.
+   */
+  private async closeUnpaid(
+    tx: Tx,
+    parentOrderId: string,
+    outcome: UnpaidOutcome,
+    reason: string | undefined,
+    actor: OrderActor,
+    followUps: ProviderFollowUp[],
+  ): Promise<string> {
     const rule = UNPAID_OUTCOME[outcome];
     const note = reason ?? rule.defaultReason;
     const now = new Date();
+    const creditReleases = await this.creditOrders.releaseOpenReservationsLocked(tx, parentOrderId);
+    followUps.push(...creditReleases);
     const subs = await tx.subOrder.findMany({
       where: { parentOrderId },
       select: { id: true, status: true, items: { select: { productVariantId: true, quantity: true } } },
@@ -342,6 +374,7 @@ export class OrderLifecycleService {
         outcome,
         reason: note,
         releasedLines: subs.reduce((count, sub) => count + sub.items.length, 0),
+        ...(creditReleases.length > 0 ? { creditReservationsReleased: creditReleases.map((r) => r.reservationRef) } : {}),
       },
     });
   }
@@ -366,6 +399,14 @@ export class OrderLifecycleService {
     data: Prisma.SubOrderUpdateManyMutationInput,
     meta: { role: ActorRole; note: string | null; actor: OrderActor },
   ): Promise<TransitionResult> {
+    if ((target === SubOrderStatus.CANCELLED || target === SubOrderStatus.REFUNDED) && sub.parentOrder.paymentMethod !== PaymentMethod.CASH_IPG) {
+      // Returning bank credit (REFUND_RESTORE, schedule adjustment, provider refund API) is not in the Phase 8 scope.
+      throw conflictWith(
+        'CREDIT_ORDER_REFUND_UNSUPPORTED',
+        `Packages of orders paid with ${sub.parentOrder.paymentMethod} cannot be cancelled or refunded yet; handle it with the credit provider manually`,
+        { paymentMethod: sub.parentOrder.paymentMethod },
+      );
+    }
     // Guarded by the status read under the parent lock; the WHERE makes it explicit.
     const updated = await tx.subOrder.updateMany({ where: { id: sub.id, status: sub.status }, data });
     if (updated.count !== 1) {
@@ -424,7 +465,7 @@ const transitionSelect = {
   parentOrderId: true,
   vendorEarningsAmount: true,
   status: true,
-  parentOrder: { select: { paymentStatus: true, userId: true } },
+  parentOrder: { select: { paymentStatus: true, userId: true, paymentMethod: true } },
   items: { select: { productVariantId: true, quantity: true } },
 } satisfies Prisma.SubOrderSelect;
 
diff --git a/apps/backend/src/modules/orders/orders.module.ts b/apps/backend/src/modules/orders/orders.module.ts
index 608decf..3a6dbd3 100644
--- a/apps/backend/src/modules/orders/orders.module.ts
+++ b/apps/backend/src/modules/orders/orders.module.ts
@@ -1,6 +1,7 @@
 import { Module } from '@nestjs/common';
 import { CartModule } from '../cart/cart.module';
 import { CategoriesModule } from '../categories/categories.module';
+import { CreditModule } from '../credit/credit.module';
 import { ProductsModule } from '../products/products.module';
 import { ShippingModule } from '../shipping/shipping.module';
 import { WalletModule } from '../wallet/wallet.module';
@@ -20,7 +21,7 @@ import { VendorOrdersController } from './vendor-orders.controller';
  * `WalletLedgerService` inside its own transactions.
  */
 @Module({
-  imports: [CartModule, CategoriesModule, ProductsModule, ShippingModule, WalletModule],
+  imports: [CartModule, CategoriesModule, CreditModule, ProductsModule, ShippingModule, WalletModule],
   controllers: [CheckoutController, CustomerOrdersController, VendorOrdersController, AdminOrdersController],
   providers: [CheckoutService, OrderLifecycleService, OrderQueriesService, OrderExpiryScheduler],
   exports: [OrderLifecycleService],
diff --git a/apps/backend/src/modules/payments/dto/payment.dto.ts b/apps/backend/src/modules/payments/dto/payment.dto.ts
index 8ea979f..f856ad3 100644
--- a/apps/backend/src/modules/payments/dto/payment.dto.ts
+++ b/apps/backend/src/modules/payments/dto/payment.dto.ts
@@ -1,5 +1,5 @@
 import { ApiProperty } from '@nestjs/swagger';
-import { ParentOrderPaymentStatus, PaymentStatus } from '@prisma/client';
+import { ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus } from '@prisma/client';
 import { IsUUID } from 'class-validator';
 
 const MONEY = { type: String, example: '5750000.00', description: 'IRR (Rial), 2 decimals, as a string.' } as const;
@@ -46,4 +46,12 @@ export class PaymentOutcomeDto {
   @ApiProperty({ description: 'True when the order is still unpaid and inside its payment window: a new payment can be initiated.' })
   canRetry!: boolean;
   @ApiProperty({ nullable: true, type: Date }) paymentExpiresAt!: Date | null;
+  @ApiProperty({ enum: PaymentPurpose, description: 'ORDER_CHECKOUT (the order) or INSTALLMENT_REPAYMENT (one BNPL instalment).' })
+  purpose!: PaymentPurpose;
+  @ApiProperty({ enum: PaymentMethod, description: 'CASH_IPG = card only; BANK_CREDIT = credit only; HYBRID = credit + card.' })
+  paymentMethod!: PaymentMethod;
+  @ApiProperty({ type: String, example: '1500000.00', description: 'Card part (IRR).' }) cashAmount!: string;
+  @ApiProperty({ type: String, example: '3000000.00', description: 'Credit part (IRR); 0 for CASH_IPG.' }) creditAmount!: string;
+  @ApiProperty({ nullable: true, type: String, format: 'uuid', description: 'The instalment an INSTALLMENT_REPAYMENT settles.' })
+  installmentScheduleId!: string | null;
 }
diff --git a/apps/backend/src/modules/payments/gateway/payment-gateway.interface.ts b/apps/backend/src/modules/payments/gateway/payment-gateway.interface.ts
index 736f9e3..50c0642 100644
--- a/apps/backend/src/modules/payments/gateway/payment-gateway.interface.ts
+++ b/apps/backend/src/modules/payments/gateway/payment-gateway.interface.ts
@@ -78,7 +78,7 @@ export class PaymentGatewayError extends Error {
 
 /** IRR amount as the integer gateways expect; refuses fractions instead of rounding money. */
 export function toWholeRials(amount: Prisma.Decimal): number {
-  if (!amount.isInteger() || !amount.isPositive()) {
+  if (!amount.isInteger() || !amount.greaterThan(0)) {
     throw new PaymentGatewayError(`Amount ${amount.toFixed(2)} is not a positive whole number of rials`, 'INVALID_AMOUNT', false);
   }
   const value = amount.toNumber();
diff --git a/apps/backend/src/modules/payments/payments.module.ts b/apps/backend/src/modules/payments/payments.module.ts
index 146f330..37147e2 100644
--- a/apps/backend/src/modules/payments/payments.module.ts
+++ b/apps/backend/src/modules/payments/payments.module.ts
@@ -2,6 +2,7 @@ import { Module, type Provider } from '@nestjs/common';
 import { ConfigService } from '@nestjs/config';
 import type { EnvironmentVariables } from '../../config/env.validation';
 import { RedisService } from '../../infra/redis/redis.service';
+import { CreditModule } from '../credit/credit.module';
 import { OrdersModule } from '../orders/orders.module';
 import { PAYMENT_GATEWAY, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';
 import { SandboxPaymentGatewayProvider } from './gateway/sandbox-payment-gateway.provider';
@@ -32,9 +33,9 @@ const gatewayProvider: Provider = {
 };
 
 @Module({
-  imports: [OrdersModule],
+  imports: [CreditModule, OrdersModule],
   controllers: [PaymentsController, SandboxBankController],
   providers: [gatewayProvider, PaymentsService],
-  exports: [PaymentsService],
+  exports: [PaymentsService, PAYMENT_GATEWAY],
 })
 export class PaymentsModule {}
diff --git a/apps/backend/src/modules/payments/payments.service.ts b/apps/backend/src/modules/payments/payments.service.ts
index cb0f77d..7e7dfeb 100644
--- a/apps/backend/src/modules/payments/payments.service.ts
+++ b/apps/backend/src/modules/payments/payments.service.ts
@@ -1,14 +1,22 @@
 import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
 import { ConfigService } from '@nestjs/config';
-import { AuditAction, ParentOrderPaymentStatus, PaymentStatus, Prisma } from '@prisma/client';
+import { AuditAction, InstallmentStatus, ParentOrderPaymentStatus, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
 import { badRequestWith, conflictWith } from '../../common/http-errors';
 import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
 import type { EnvironmentVariables } from '../../config/env.validation';
 import { PrismaService } from '../../infra/prisma/prisma.service';
+import { CreditLedgerService } from '../credit/credit-ledger.service';
+import { CreditOrderService, type ProviderFollowUp } from '../credit/credit-order.service';
 import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
 import { OrderLifecycleService } from '../orders/order-lifecycle.service';
 import type { InitiatePaymentResponseDto, PaymentOutcome, PaymentOutcomeDto } from './dto/payment.dto';
-import { PAYMENT_GATEWAY, PaymentGatewayError, type GatewayVerification, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';
+import {
+  PAYMENT_GATEWAY,
+  PaymentGatewayError,
+  type GatewayInitiation,
+  type GatewayVerification,
+  type PaymentGatewayProvider,
+} from './gateway/payment-gateway.interface';
 
 type Tx = Prisma.TransactionClient;
 
@@ -18,7 +26,16 @@ export const MAX_OPEN_ATTEMPTS = 5;
 const paymentSelect = {
   id: true,
   status: true,
+  parentOrderId: true,
+  purpose: true,
+  paymentMethod: true,
   cashAmount: true,
+  creditAmount: true,
+  creditAccountId: true,
+  creditReservationRef: true,
+  installmentPlanId: true,
+  installmentScheduleId: true,
+  installmentSchedule: { select: { status: true } },
   bankRrn: true,
   metadata: true,
   gatewayTrackingToken: true,
@@ -27,6 +44,16 @@ const paymentSelect = {
 
 type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;
 
+/** What `startGatewaySession` needs to open a bank session for an already-created INITIATED payment. */
+export interface GatewaySessionRequest {
+  paymentId: string;
+  parentOrderId: string;
+  orderNumber: string;
+  amount: Prisma.Decimal;
+  description: string;
+  customerMobile: string;
+}
+
 /**
  * Card payments through the active IPG.
  *
@@ -41,6 +68,15 @@ type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;
  *   commit together or not at all;
  * - a captured payment for an order that is no longer payable is recorded as
  *   SUCCESSFUL with `requiresManualRefund` and audited — never dropped.
+ *
+ * Phase 8 (credit): a HYBRID attempt carries a credit reservation next to its
+ * card part. On a verified card payment the reservation is committed and the
+ * instalment schedule written before the order completes (same transaction;
+ * lock order parent → credit account → stock → wallets); on failure — or if the
+ * gateway cannot even open a session — the reservation is released. When any
+ * attempt pays the order, the still-held reservations of the other attempts are
+ * released. INSTALLMENT_REPAYMENT payments settle one instalment and restore its
+ * principal to the credit line. Provider calls follow after the commit.
  */
 @Injectable()
 export class PaymentsService {
@@ -51,6 +87,8 @@ export class PaymentsService {
   constructor(
     private readonly prisma: PrismaService,
     private readonly lifecycle: OrderLifecycleService,
+    private readonly creditLedger: CreditLedgerService,
+    private readonly creditOrders: CreditOrderService,
     @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayProvider,
     config: ConfigService<EnvironmentVariables, true>,
   ) {
@@ -102,44 +140,76 @@ export class PaymentsService {
       return created;
     });
 
-    let initiation;
+    const initiation = await this.startGatewaySession({
+      paymentId: payment.id,
+      parentOrderId,
+      orderNumber: order.orderNumber,
+      amount: order.finalPayableAmount,
+      description: `پرداخت سفارش ${order.orderNumber} — شاپینو`,
+      customerMobile: order.user.mobile,
+    });
+    return {
+      paymentId: payment.id,
+      redirectUrl: initiation.redirectUrl,
+      gatewayName: this.gateway.name,
+      amount: order.finalPayableAmount.toFixed(2),
+      currency: 'IRR',
+      orderNumber: order.orderNumber,
+      paymentExpiresAt: order.paymentExpiresAt,
+    };
+  }
+
+  /**
+   * Opens the bank session of an INITIATED payment (card-only, the card part of
+   * a HYBRID attempt, or an instalment repayment). If the gateway refuses or
+   * cannot be reached, the payment becomes FAILED, its credit reservation (if
+   * any) is released, and 502 GATEWAY_UNAVAILABLE is thrown.
+   */
+  async startGatewaySession(request: GatewaySessionRequest): Promise<GatewayInitiation> {
+    let initiation: GatewayInitiation;
     try {
       initiation = await this.gateway.initiatePayment(
         {
-          paymentId: payment.id,
-          orderNumber: order.orderNumber,
-          amount: order.finalPayableAmount,
-          description: `پرداخت سفارش ${order.orderNumber} — شاپینو`,
-          customerMobile: order.user.mobile,
+          paymentId: request.paymentId,
+          orderNumber: request.orderNumber,
+          amount: request.amount,
+          description: request.description,
+          customerMobile: request.customerMobile,
         },
         this.callbackUrl,
       );
     } catch (error) {
       const gatewayError = error instanceof PaymentGatewayError ? error : new PaymentGatewayError(String(error), 'GATEWAY_ERROR', true);
-      await this.prisma.payment.update({
-        where: { id: payment.id },
-        data: { status: PaymentStatus.FAILED, metadata: { stage: 'initiate', code: gatewayError.code, message: gatewayError.message.slice(0, 500) } },
+      const followUps = await this.prisma.$transaction(async (tx) => {
+        await lockParentOrder(tx, request.parentOrderId);
+        const current = await tx.payment.findUniqueOrThrow({ where: { id: request.paymentId }, select: paymentSelect });
+        const released = current.status === PaymentStatus.INITIATED ? await this.creditOrders.releaseLocked(tx, current) : null;
+        await tx.payment.update({
+          where: { id: request.paymentId },
+          data: {
+            status: PaymentStatus.FAILED,
+            metadata: {
+              stage: 'initiate',
+              code: gatewayError.code,
+              message: gatewayError.message.slice(0, 500),
+              ...(released ? { creditReservationReleased: true } : {}),
+            },
+          },
+        });
+        return released ? [released] : [];
       });
-      this.logger.warn(`Gateway ${this.gateway.name} refused to open a session for payment ${payment.id}: ${gatewayError.message}`);
+      await this.creditOrders.followUp(followUps);
+      this.logger.warn(`Gateway ${this.gateway.name} refused to open a session for payment ${request.paymentId}: ${gatewayError.message}`);
       throw new HttpException(
         { statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', code: 'GATEWAY_UNAVAILABLE', message: 'The payment gateway could not open a payment session; try again', gatewayCode: gatewayError.code },
         HttpStatus.BAD_GATEWAY,
       );
     }
-
     await this.prisma.payment.update({
-      where: { id: payment.id },
+      where: { id: request.paymentId },
       data: { gatewayTrackingToken: initiation.gatewayToken, metadata: { stage: 'initiated', gateway: initiation.details } as Prisma.InputJsonValue },
     });
-    return {
-      paymentId: payment.id,
-      redirectUrl: initiation.redirectUrl,
-      gatewayName: this.gateway.name,
-      amount: order.finalPayableAmount.toFixed(2),
-      currency: 'IRR',
-      orderNumber: order.orderNumber,
-      paymentExpiresAt: order.paymentExpiresAt,
-    };
+    return initiation;
   }
 
   /** Public bank callback (GET query or POST form/JSON). Idempotent. */
@@ -172,24 +242,34 @@ export class PaymentsService {
       };
     }
 
+    const followUps: ProviderFollowUp[] = [];
     const settled = await this.prisma.$transaction(async (tx) => {
       await lockParentOrder(tx, found.parentOrder.id);
       const current = await tx.payment.findUniqueOrThrow({ where: { id: found.id }, select: paymentSelect });
       if (current.status !== PaymentStatus.INITIATED) {
         return current; // another callback won the race
       }
-      return verification.success ? this.applySuccess(tx, current, verification, actor) : this.applyFailure(tx, current, verification, actor);
+      return verification.success
+        ? this.applySuccess(tx, current, verification, actor, followUps)
+        : this.applyFailure(tx, current, verification, actor, followUps);
     });
+    await this.creditOrders.followUp(followUps);
     return this.outcomeOf(settled);
   }
 
-  private async applySuccess(tx: Tx, payment: PaymentRow, verification: GatewayVerification, actor: OrderActor): Promise<PaymentRow> {
+  private async applySuccess(
+    tx: Tx,
+    payment: PaymentRow,
+    verification: GatewayVerification,
+    actor: OrderActor,
+    followUps: ProviderFollowUp[],
+  ): Promise<PaymentRow> {
     const paidAt = new Date();
-    const application = await this.lifecycle.applyPaymentLocked(tx, payment.parentOrder.id, actor, {
-      paymentId: payment.id,
-      ...(verification.bankRrn ? { bankRrn: verification.bankRrn } : {}),
-    });
-    const requiresManualRefund = !application.applied;
+    const effect =
+      payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT
+        ? await this.applyRepayment(tx, payment, verification, paidAt)
+        : await this.applyCheckout(tx, payment, verification, actor, paidAt, followUps);
+    const requiresManualRefund = !effect.applied;
     const metadata = {
       ...asObject(payment.metadata),
       stage: 'verified',
@@ -197,9 +277,9 @@ export class PaymentsService {
       alreadyVerified: verification.alreadyVerified,
       cardPanMasked: verification.cardPanMasked,
       ...(requiresManualRefund
-        ? { requiresManualRefund: true, orderStatusAtCapture: payment.parentOrder.paymentStatus }
-        : { escrowHeld: application.escrowHeld }),
-    };
+        ? { requiresManualRefund: true, orderStatusAtCapture: payment.parentOrder.paymentStatus, ...effect.details }
+        : effect.details),
+    } as Prisma.InputJsonValue;
     const updated = await tx.payment.update({
       where: { id: payment.id },
       data: { status: PaymentStatus.SUCCESSFUL, paidAt, bankRrn: verification.bankRrn, metadata: metadata },
@@ -213,10 +293,14 @@ export class PaymentsService {
       newValue: {
         status: PaymentStatus.SUCCESSFUL,
         orderNumber: payment.parentOrder.orderNumber,
+        purpose: payment.purpose,
+        paymentMethod: payment.paymentMethod,
         amount: payment.cashAmount.toFixed(2),
+        creditAmount: payment.creditAmount.toFixed(2),
         bankRrn: verification.bankRrn,
         verifyCode: verification.code,
-        ...(requiresManualRefund ? { requiresManualRefund: true, orderPaymentStatus: updated.parentOrder.paymentStatus } : {}),
+        ...(payment.installmentScheduleId ? { installmentScheduleId: payment.installmentScheduleId } : {}),
+        ...(requiresManualRefund ? { requiresManualRefund: true, orderPaymentStatus: updated.parentOrder.paymentStatus, ...effect.details } : {}),
       },
     });
     if (requiresManualRefund) {
@@ -228,12 +312,78 @@ export class PaymentsService {
     return updated;
   }
 
-  private async applyFailure(tx: Tx, payment: PaymentRow, verification: GatewayVerification, actor: OrderActor): Promise<PaymentRow> {
+  /**
+   * Card payment (or the card part of a HYBRID attempt) for an order. The order
+   * must still be PENDING and, for HYBRID, the credit reservation still held;
+   * then credit is committed + scheduled first and the order completes.
+   */
+  private async applyCheckout(
+    tx: Tx,
+    payment: PaymentRow,
+    verification: GatewayVerification,
+    actor: OrderActor,
+    paidAt: Date,
+    followUps: ProviderFollowUp[],
+  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
+    const orderId = payment.parentOrder.id;
+    if (payment.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
+      return { applied: false, details: {} };
+    }
+    const details: Record<string, unknown> = {};
+    if (payment.creditAmount.greaterThan(0)) {
+      const state = await this.creditLedger.reservationState(tx, payment.creditAccountId!, payment.creditReservationRef!);
+      if (state !== 'HELD') {
+        // Defensive: a PENDING order whose hybrid reservation is gone cannot be completed with this card part.
+        return { applied: false, details: { creditReservationState: state } };
+      }
+      const committed = await this.creditOrders.commitAndScheduleLocked(tx, payment, paidAt);
+      followUps.push(committed.followUp);
+      details['schedule'] = committed.schedule;
+    }
+    const application = await this.lifecycle.applyPaymentLocked(tx, orderId, actor, {
+      paymentId: payment.id,
+      paymentMethod: payment.paymentMethod,
+      ...(verification.bankRrn ? { bankRrn: verification.bankRrn } : {}),
+    });
+    if (!application.applied) {
+      throw new Error(`Order ${orderId} was PENDING under lock but the payment could not be applied`);
+    }
+    followUps.push(...(await this.creditOrders.releaseOpenReservationsLocked(tx, orderId, payment.id)));
+    details['escrowHeld'] = application.escrowHeld;
+    return { applied: true, details };
+  }
+
+  private async applyRepayment(
+    tx: Tx,
+    payment: PaymentRow,
+    verification: GatewayVerification,
+    paidAt: Date,
+  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
+    const result = await this.creditOrders.applyRepaymentLocked(tx, payment.installmentScheduleId!, payment.cashAmount, { bankRrn: verification.bankRrn, paidAt });
+    return { applied: result.applied, details: { installmentStatus: result.installmentStatus, restoredPrincipal: result.restoredPrincipal } };
+  }
+
+  private async applyFailure(
+    tx: Tx,
+    payment: PaymentRow,
+    verification: GatewayVerification,
+    actor: OrderActor,
+    followUps: ProviderFollowUp[],
+  ): Promise<PaymentRow> {
+    // HYBRID: the card part failed, so the credit reservation is rolled back.
+    const released = await this.creditOrders.releaseLocked(tx, payment);
+    if (released) followUps.push(released);
     const updated = await tx.payment.update({
       where: { id: payment.id },
       data: {
         status: PaymentStatus.FAILED,
-        metadata: { ...asObject(payment.metadata), stage: 'failed', code: verification.code, message: verification.message.slice(0, 500) },
+        metadata: {
+          ...asObject(payment.metadata),
+          stage: 'failed',
+          code: verification.code,
+          message: verification.message.slice(0, 500),
+          ...(released ? { creditReservationReleased: true } : {}),
+        },
       },
       select: paymentSelect,
     });
@@ -244,22 +394,35 @@ export class PaymentsService {
       entityName: 'Payment',
       entityId: payment.id,
       oldValue: { status: PaymentStatus.INITIATED },
-      newValue: { status: PaymentStatus.FAILED, orderNumber: payment.parentOrder.orderNumber, code: verification.code, message: verification.message },
+      newValue: {
+        status: PaymentStatus.FAILED,
+        orderNumber: payment.parentOrder.orderNumber,
+        purpose: payment.purpose,
+        paymentMethod: payment.paymentMethod,
+        code: verification.code,
+        message: verification.message,
+        ...(released ? { creditReservationReleased: released.reservationRef } : {}),
+      },
     });
     return updated;
   }
 
   private outcomeOf(payment: PaymentRow): PaymentOutcomeDto {
     const order = payment.parentOrder;
-    const canRetry =
-      order.paymentStatus === ParentOrderPaymentStatus.PENDING && (order.paymentExpiresAt === null || order.paymentExpiresAt > new Date());
+    const repayment = payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT;
+    const canRetry = repayment
+      ? payment.installmentSchedule?.status === InstallmentStatus.PENDING || payment.installmentSchedule?.status === InstallmentStatus.OVERDUE
+      : order.paymentStatus === ParentOrderPaymentStatus.PENDING && (order.paymentExpiresAt === null || order.paymentExpiresAt > new Date());
     const metadata = asObject(payment.metadata);
     let outcome: PaymentOutcome;
     let message: string;
     if (payment.status === PaymentStatus.SUCCESSFUL) {
       outcome = metadata['requiresManualRefund'] === true ? 'PAID_REQUIRES_REFUND' : 'PAID';
-      message =
-        outcome === 'PAID'
+      message = repayment
+        ? outcome === 'PAID'
+          ? 'Payment confirmed; the instalment is paid'
+          : 'The bank captured this payment but the instalment was already settled; it will be refunded by our finance team'
+        : outcome === 'PAID'
           ? 'Payment confirmed; the order is paid'
           : 'The bank captured this payment but the order had already been paid or closed; it will be refunded by our finance team';
     } else if (payment.status === PaymentStatus.INITIATED) {
@@ -280,6 +443,11 @@ export class PaymentsService {
       message,
       canRetry: outcome === 'FAILED' && canRetry,
       paymentExpiresAt: order.paymentExpiresAt,
+      purpose: payment.purpose,
+      paymentMethod: payment.paymentMethod,
+      cashAmount: payment.cashAmount.toFixed(2),
+      creditAmount: payment.creditAmount.toFixed(2),
+      installmentScheduleId: payment.installmentScheduleId,
     };
   }
 }
diff --git a/apps/backend/src/modules/wallet/wallet-ledger.service.ts b/apps/backend/src/modules/wallet/wallet-ledger.service.ts
index 33e664b..9937bf8 100644
--- a/apps/backend/src/modules/wallet/wallet-ledger.service.ts
+++ b/apps/backend/src/modules/wallet/wallet-ledger.service.ts
@@ -53,7 +53,7 @@ export type ReverseOutcome = 'NONE' | 'FROM_PENDING' | 'FROM_WITHDRAWABLE';
 export class WalletLedgerService {
   /** Sale confirmed: the vendor's earnings enter escrow (PENDING). Returns false if already held or nothing to hold. */
   async holdSaleEscrow(tx: Tx, sub: EscrowSubOrder): Promise<boolean> {
-    if (!sub.vendorEarningsAmount.isPositive()) return false;
+    if (!sub.vendorEarningsAmount.greaterThan(0)) return false;
     const wallet = await this.lock(tx, sub.vendorId);
     if ((await this.escrowState(tx, sub.id)) !== 'NONE') return false;
     await this.post(tx, wallet, [
diff --git a/apps/backend/src/modules/wallet/wallet-math.ts b/apps/backend/src/modules/wallet/wallet-math.ts
index 4dcc5f6..cb2777a 100644
--- a/apps/backend/src/modules/wallet/wallet-math.ts
+++ b/apps/backend/src/modules/wallet/wallet-math.ts
@@ -61,7 +61,7 @@ export function planEntries(current: BucketBalances, entries: readonly LedgerEnt
       throw new Error(`Ledger entry ${entry.type}/${entry.bucket} has more than 2 decimals`);
     }
     const after = balances[entry.bucket].plus(entry.amount);
-    if (after.isNegative()) {
+    if (after.lessThan(0)) {
       throw new InsufficientBalanceError(entry.bucket, balances[entry.bucket], entry.amount.negated());
     }
     balances[entry.bucket] = after;
diff --git a/apps/backend/src/setup/app.setup.ts b/apps/backend/src/setup/app.setup.ts
index 8921251..6de1890 100644
--- a/apps/backend/src/setup/app.setup.ts
+++ b/apps/backend/src/setup/app.setup.ts
@@ -117,6 +117,10 @@ export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
       .addTag('vendor-wallet', "A store's escrow wallet, ledger and settlement (payout) requests")
       .addTag('admin-settlements', 'Finance: review and pay out vendor settlement requests')
       .addTag('admin-financial', 'Finance: platform GMV, commission, escrow and settlement overview')
+      .addTag('credit', 'Credit engine (BNPL): apply for a credit line, my credit account, instalment plans on offer')
+      .addTag('credit-payments', 'Pay an order with bank credit (BANK_CREDIT) or credit + card (HYBRID)')
+      .addTag('credit-installments', 'My instalments grouped by order, and paying an instalment by card')
+      .addTag('admin-credit', 'Finance: credit applications, credit accounts and the aggregated credit exposure')
       .build(),
   );
 }
diff --git a/apps/backend/test/finance.e2e-spec.ts b/apps/backend/test/finance.e2e-spec.ts
index d4e5ae3..93768bd 100644
--- a/apps/backend/test/finance.e2e-spec.ts
+++ b/apps/backend/test/finance.e2e-spec.ts
@@ -895,7 +895,7 @@ describe('Phase 7 — payments, escrow wallet and settlements (live stack)', ()
         _sum: { platformCommissionAmount: true },
       });
       const wallets = await prisma.vendorWallet.aggregate({ _sum: { pendingBalance: true, withdrawableBalance: true, settlementHoldBalance: true, totalWithdrawnAmount: true } });
-      const collected = await prisma.payment.aggregate({ where: { status: 'SUCCESSFUL' }, _sum: { cashAmount: true } });
+      const collected = await prisma.payment.aggregate({ where: { status: 'SUCCESSFUL', purpose: 'ORDER_CHECKOUT' }, _sum: { cashAmount: true } });
       const money = (value: Prisma.Decimal | null): string => d(value ?? 0).toFixed(2);
 
       expect(body.sales.gmv).toBe(money(gmv._sum.itemsSubtotal));
diff --git a/apps/backend/test/schema-integrity.e2e-spec.ts b/apps/backend/test/schema-integrity.e2e-spec.ts
index 24db5e2..1aff769 100644
--- a/apps/backend/test/schema-integrity.e2e-spec.ts
+++ b/apps/backend/test/schema-integrity.e2e-spec.ts
@@ -156,21 +156,9 @@ describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
           },
         });
 
-        // ── payment: hybrid split must add up to the payable amount ──────────
-        const cashAmount = finalPayable.mul('0.4').toDecimalPlaces(2);
+        // ── payment split: must add up to the payable amount (whole rials) ───
+        const cashAmount = finalPayable.mul('0.4').floor();
         const creditAmount = finalPayable.sub(cashAmount);
-        await tx.payment.create({
-          data: {
-            parentOrderId: order.id,
-            gatewayName: 'SANDBOX',
-            gatewayTrackingToken: 'SBX-TRACK-0001',
-            bankRrn: '123456789012',
-            cashAmount,
-            creditAmount,
-            status: PaymentStatus.SUCCESSFUL,
-            paidAt: new Date(),
-          },
-        });
         expect(cashAmount.add(creditAmount).toString()).toBe(finalPayable.toString());
 
         // ── vendor escrow ledger ────────────────────────────────────────────
@@ -250,6 +238,23 @@ describe('Phase-2 schema integrity (e2e, real PostgreSQL, rolled back)', () => {
         const plan = await tx.installmentPlan.findFirstOrThrow({
           where: { providerId: provider.id, durationMonths: 3 },
         });
+        // Phase 8 shape: a HYBRID attempt carries its credit part (account, plan, reservation ref).
+        await tx.payment.create({
+          data: {
+            parentOrderId: order.id,
+            paymentMethod: 'HYBRID',
+            creditAccountId: account.id,
+            installmentPlanId: plan.id,
+            creditReservationRef: 'SHP-990000001',
+            gatewayName: 'SANDBOX',
+            gatewayTrackingToken: 'SBX-TRACK-0001',
+            bankRrn: '123456789012',
+            cashAmount,
+            creditAmount,
+            status: PaymentStatus.SUCCESSFUL,
+            paidAt: new Date(),
+          },
+        });
         const perInstalment = creditAmount.div(plan.durationMonths).toDecimalPlaces(2);
         await tx.installmentSchedule.createMany({
           data: [1, 2, 3].map((number) => ({
diff --git a/apps/backend/test/seed.e2e-spec.ts b/apps/backend/test/seed.e2e-spec.ts
index 3f47e9d..56e527c 100644
--- a/apps/backend/test/seed.e2e-spec.ts
+++ b/apps/backend/test/seed.e2e-spec.ts
@@ -205,10 +205,10 @@ describe('Seed (e2e, real PostgreSQL)', () => {
       }
     });
 
-    it('keeps the credit feature flag off until BNPL ships', async () => {
+    it('switches the credit feature flag on now that BNPL ships (Phase 8)', async () => {
       const flag = await prisma.systemConfig.findUniqueOrThrow({ where: { key: 'credit.enabled' } });
 
-      expect(flag.value).toBe('false');
+      expect(flag.value).toBe('true');
     });
 
     it('names the active credit provider explicitly in configuration', async () => {
```
