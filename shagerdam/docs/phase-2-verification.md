# Shopino — Phase 2 verification report

**Phase:** 2 — Comprehensive Prisma schema & database migrations
**Reported by:** AI Software Developer · **Date:** 2026-09-26
**Environment:** live PostgreSQL 16.15 (Docker) · Prisma 6.19.3 · Node 22.23.3 · pnpm 9.15.9
**Verdict:** every deliverable verified against the real database. No mock, fake, stub or
hard-coded data anywhere.

Secrets are never printed; the seeded passwords live only in the git-ignored `.env` and were
generated with `openssl rand`.

---

## 1. Deliverables — result

| # | Deliverable | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Complete `prisma/schema.prisma` (all 7 entity groups) | **PASS** | §2.1 (28 models / 17 enums / 872 lines, `prisma validate` → *valid*) |
| 2 | Migration `phase2_full_marketplace_schema` created **and applied** | **PASS** | §3 (`migrate status` → *Database schema is up to date!*; no drift) |
| 3 | Enriched seed (staff, category tree + commissions, verified vendor with products, active `SANDBOX_BANK` + 3/6/12-month plans) | **PASS** | §5 (seeded row census) |
| 4 | Idempotency proven by running `pnpm db:seed` twice | **PASS** | §6 (run 2 → `0 created, 4 updated`; `verify:seed` hash comparison) |
| 5 | SQL tables/relations of the live database as proof of 100 % schema integration | **PASS** | §4 (29 tables, 40 FKs, 50 unique indexes, 105 indexes, 17 enums) |

Quality gates (§7): typecheck **2/2**, lint **2/2**, unit tests **16/16**, e2e tests
**23/23**, production build **2/2 successful**.

---

## 2. Schema validation

```bash
cd apps/backend
pnpm exec prisma format
pnpm exec prisma validate
```

```text
The schema at prisma/schema.prisma is valid 🚀
```

### 2.1 Inventory

| Item | Count |
| --- | --- |
| `model` blocks | 28 |
| `enum` blocks | 17 |
| File length | 872 lines |

```text
models: 28  enums: 17  lines: 872

Address AuditLog Cart CartItem Category CreditAccount CreditApplication CreditProvider
CreditTransaction CustomerProfile Dispute DisputeEvidence InstallmentPlan InstallmentSchedule
OrderItem ParentOrder Payment Product ProductMedia ProductVariant SettlementRequest SubOrder
SystemConfig User Vendor VendorVerification VendorWallet WalletTransaction
```

All seven required entity groups are present: identity/access/audit (4), vendor (2),
catalogue (4), cart/orders (5), payments/escrow/settlement (4), BNPL (6), disputes (2) —
plus `SystemConfig` as the configuration registry. **27 required models + 1 platform
config model = 28** models, and 28 + `_prisma_migrations` = the 29 physical tables
reported below.

### 2.2 Unit-level schema assertions

`apps/backend/test/seed.e2e-spec.ts` runs against the live database and asserts, among others:

* the identity/credential contract (Argon2id hashes only, wrong password rejected),
* the category tree shape and per-node commission rates,
* the approved vendor with its wallet and verification,
* products → variants → stock and media links,
* `SANDBOX_BANK` active vs. the bank providers inactive,
* the 3 / 6 / 12-month plans with 0 % interest on the 3-month plan,
* idempotency of the seed,
* **zero** fabricated financial rows, zero wallet balances, `credit.enabled = false` and
  `credits.activeProvider` consistent with the provider table.

---

## 3. Migration state on the live database

```bash
pnpm exec prisma migrate status
```

```text
Datasource "db": PostgreSQL database "shopino_db", schema "public" at "127.0.0.1:5432"
2 migrations found in prisma/migrations
Database schema is up to date!
```

`prisma migrate dev` (drift check) reports:

```text
Already in sync, no schema change or pending migration was found.
```

### 3.1 Migration files

| Migration | Statements | Lines |
| --- | --- | --- |
| `20260926124703_init` | 9 DDL | 69 |
| `20260926130137_phase2_full_marketplace_schema` | 134 DDL (25 `CREATE TABLE`, 15 `CREATE TYPE`, 52 `CREATE INDEX`, 18 `CREATE UNIQUE INDEX`, 41 `ALTER TABLE`) | 834 |

### 3.2 Safety review of the generated SQL

Prisma's raw output was destructive and was corrected by hand before it was ever applied:

| Generated statement | Risk | What the committed migration does instead |
| --- | --- | --- |
| `ALTER TABLE categories DROP COLUMN title` | destroys existing category titles | `ALTER TABLE categories RENAME COLUMN title TO title_fa` — data-preserving |
| `ADD COLUMN default_commission_rate NOT NULL` | fails on populated tables | added with `DEFAULT 0` |
| `ALTER TABLE users ALTER COLUMN mobile SET NOT NULL` | fails on populated tables | wrapped in `DO $$ ... RAISE EXCEPTION` that aborts with an explicit message when `users` is not empty; the correct add-nullable → backfill → set-not-null sequence for a populated rollout is documented in the file |

Verification that nothing destructive remains in the committed migration:

```text
DROP COLUMN: 0     DROP TABLE: 0     DROP CONSTRAINT: 0
```

---

## 4. Proof of live schema integration (deliverable 5)

Every figure below was read out of the running PostgreSQL 16.15 instance
(`docker compose exec postgres psql -U shopino -d shopino_db`), not from the schema file.

### 4.1 Totals

```text
tables=29 | foreign_keys=40 | primary_keys=29 | unique_indexes=50 | indexes_total=105
| enums=17 | enum_values=82
```

### 4.2 Tables with column counts

```text
      table_name       | columns
-----------------------+---------
 _prisma_migrations    |       8
 addresses             |      13
 audit_logs            |      10
 cart_items            |       6
 carts                 |       5
 categories            |      10
 credit_accounts       |      11
 credit_applications   |      10
 credit_providers      |       7
 credit_transactions   |       8
 customer_profiles     |       8
 dispute_evidence      |       7
 disputes              |      10
 installment_plans     |       9
 installment_schedules |      16
 order_items           |      11
 parent_orders         |      12
 payments              |      12
 product_media         |       7
 product_variants      |      14
 products              |      11
 settlement_requests   |      10
 sub_orders            |      15
 system_configs        |       7
 users                 |      11
 vendor_verifications  |       8
 vendor_wallets        |       7
 vendors               |      13
 wallet_transactions   |       9
(29 rows)
```

### 4.3 Referential actions on the live database (40 FKs)

`RESTRICT` — financial and historical records cannot lose their parent:

```text
credit_accounts.user_id → users · credit_accounts.provider_id → credit_providers
credit_applications.user_id → users · credit_applications.provider_id → credit_providers
credit_transactions.credit_account_id → credit_accounts
installment_plans.provider_id → credit_providers
installment_schedules.parent_order_id → parent_orders · installment_schedules.credit_account_id → credit_accounts
parent_orders.user_id → users · payments.parent_order_id → parent_orders
products.category_id → categories · products.vendor_id → vendors
settlement_requests.vendor_id → vendors · sub_orders.vendor_id → vendors
disputes.raised_by_user_id → users · dispute_evidence.uploaded_by_user_id → users
vendor_wallets.vendor_id → vendors · vendors.user_id → users
```

`CASCADE` — owned children disappear with their parent:

```text
addresses.user_id → users · carts.user_id → users · customer_profiles.user_id → users
cart_items.cart_id → carts · cart_items.product_variant_id → product_variants
product_media.product_id → products · product_variants.product_id → products
sub_orders.parent_order_id → parent_orders · order_items.sub_order_id → sub_orders
disputes.sub_order_id → sub_orders · dispute_evidence.dispute_id → disputes
```

`SET NULL` — history survives:

```text
audit_logs.user_id · categories.parent_id · customer_profiles.default_address_id
order_items.product_variant_id · settlement_requests.processed_by_user_id
vendor_verifications.reviewed_by_user_id
wallet_transactions.sub_order_id · wallet_transactions.settlement_request_id
```

### 4.4 Unique indexes (50)

Business keys enforced by the database, not by application code:

```text
users → mobile · email · national_code          vendors → store_slug · user_id
products → slug                                 product_variants → sku
categories → slug                               parent_orders → order_number
sub_orders → sub_order_number                   system_configs → key
credit_providers → code                         vendor_wallets → vendor_id
cart_items → cart_id, product_variant_id        credit_accounts → user_id, provider_id
installment_plans → provider_id, duration_months
installment_schedules → parent_order_id, installment_number
customer_profiles → user_id · default_address_id  carts → user_id · session_token
```

### 4.5 Enum types (17 types / 82 values)

```text
AuditAction (10): CREATE, UPDATE, DELETE, LOGIN, LOGOUT, STATUS_CHANGE, SETTLEMENT_TRIGGER, PAYMENT_CAPTURE, CREDIT_DECISION, DISPUTE_RESOLUTION
ConfigValueType (4): STRING, NUMBER, BOOLEAN, JSON
CreditAccountStatus (3): ACTIVE, FROZEN, CLOSED
CreditApplicationStatus (5): DRAFT, PENDING_BANK_INQUIRY, DOCS_REQUIRED, APPROVED, REJECTED
CreditTransactionType (6): CREDIT_ALLOCATION, PURCHASE_RESERVE_HOLD, PURCHASE_COMMIT, RESERVATION_RELEASE, INSTALLMENT_REPAYMENT_RESTORE, REFUND_RESTORE
DisputeReason (5): WRONG_ITEM, DAMAGED, NOT_AS_DESCRIBED, NOT_DELIVERED, COUNTERFEIT
DisputeStatus (6): OPEN, VENDOR_RESPONDED, UNDER_ARBITRATION, RESOLVED_BUYER_FAVOR, RESOLVED_VENDOR_FAVOR, CANCELLED
Gender (3): MALE, FEMALE, OTHER
InstallmentStatus (4): PENDING, PAID, OVERDUE, WAIVED
ParentOrderPaymentStatus (4): PENDING, PAID, FAILED, CANCELLED
PaymentMethod (3): CASH_IPG, BANK_CREDIT, HYBRID
PaymentStatus (4): INITIATED, SUCCESSFUL, FAILED, REFUNDED
SettlementStatus (4): REQUESTED, PROCESSING, PAID_PAYA, REJECTED
SubOrderStatus (6): PENDING_APPROVAL, PROCESSING, SHIPPED, DELIVERED, CANCELLED, REFUNDED
UserRole (6): SUPER_ADMIN, ADMIN, VENDOR, CUSTOMER, FINANCIAL_OFFICER, SUPPORT
VendorStatus (4): PENDING, APPROVED, REJECTED, SUSPENDED
WalletTransactionType (5): CREDIT_SALE_ESCROW_HOLD, ESCROW_RELEASE_TO_WITHDRAWABLE, COMMISSION_DEDUCTION, SETTLEMENT_PAYOUT, REFUND_DEDUCTION
```

Every value the technical manager specified is present, including `SUPER_ADMIN`…`SUPPORT`,
`CASH_IPG`/`BANK_CREDIT`/`HYBRID`, the five wallet transaction types, the six credit
transaction types, the five dispute reasons and the six dispute statuses.

### 4.6 Index coverage

105 indexes across 29 tables — every foreign key is indexed, plus the search-critical
columns (`order_number`, `sku`, `slug`, status columns, `due_date`, `created_at`).
Highest coverage: `users` (6), `parent_orders` / `products` / `sub_orders` / `vendors` (5).

---

## 5. Seeded master data (deliverable 3)

Read back from PostgreSQL after `pnpm db:seed`:

```text
users: SUPPORT=1, SUPER_ADMIN=1, FINANCIAL_OFFICER=1, VENDOR=1

categories=19 roots=6 | vendors=1 approved=1 | products=3 variants=7 | media=4
| credit_providers=4 active=1 | plans=3 | configs=9

credit.enabled=false
credits.activeProvider=SANDBOX_BANK
```

Every role has a real account; the category tree has 6 roots with per-node commission
rates; exactly one vendor is `APPROVED` with 3 products / 7 variants / 4 media rows;
exactly one credit provider is active (`SANDBOX_BANK`) and exactly one active provider is
selected in the configuration — the two are consistent.

### 5.1 No fabricated financial data

```text
parent_orders=0 sub_orders=0 order_items=0 payments=0 wallet_tx=0 settlement_requests=0
credit_accounts=0 credit_tx=0 schedules=0 disputes=0
wallet_pending=0.00 wallet_withdrawable=0.00
```

This is a deliberate invariant, not an omission: no order, payment, credit limit, ledger
entry or wallet balance is invented by the seed.

---

## 6. Idempotency proof (deliverable 4)

```bash
pnpm db:seed     # run 1
pnpm db:seed     # run 2
```

| Run | Result |
| --- | --- |
| 1 | 4 users created, 19 categories, 1 vendor (+ wallet, verification), 3 products / 7 variants / 4 media, 4 credit providers / 3 plans, 9 configs |
| 2 | **`0 created, 4 updated`** — no duplication, no drift |

`pnpm verify:seed` performs a stronger check: it hashes the full master-data set, runs the
seed a second time and asserts no count or hash change, that every stored credential is
Argon2id (no plaintext anywhere), and that no financial row exists:

```text
users=4 categories=19 (roots=6) vendors=1 products=3 variants=7 media=4 providers=4 plans=3 configs=9
ok — deterministic and idempotent; credentials are Argon2id, no plaintext, no fabricated financial data
```

---

## 7. Quality gates

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `pnpm typecheck` | **PASS** — 2 packages, 0 errors |
| Lint | `pnpm lint` | **PASS** — 2 packages, 0 errors/warnings |
| Unit tests | `pnpm test` | **PASS** — backend 16/16, frontend suite green |
| E2E / integration | `cd apps/backend && pnpm run test:e2e` | **PASS** — 3 suites, **23/23** tests, 5.4 s |
| Production build | `pnpm build` | **PASS** — 2/2 tasks, `✓ Compiled successfully in 10.9s` |
| Schema validation | `pnpm db:validate` | **PASS** — *valid 🚀* |
| Migration state | `prisma migrate status` | **PASS** — up to date, no drift |

```text
Test Suites: 3 passed, 3 total
Tests:       23 passed, 23 total
```

### 7.1 Constraint-level integration suite (new in this phase)

`apps/backend/test/schema-integrity.e2e-spec.ts` exercises the Phase-2 schema against the
real database. Every scenario runs inside a transaction that is rolled back, so the suite
proves the schema **without leaving a single fabricated order behind** — the final test
asserts that all order/payment/ledger/dispute tables are still empty and the seeded rows
(4 users, 7 variants) are untouched.

Verified behaviours:

* full `User → Address → Cart → ParentOrder → SubOrder → OrderItem` graph builds successfully;
* monetary invariants hold in `Decimal` arithmetic with no floating point:
  `commission + vendorEarnings = itemsSubtotal`, `cashAmount + creditAmount = finalPayable`,
  `availableAmount + committed = totalLimit`;
* payload snapshots (`shippingAddressSnapshot`, `variantDetailsSnapshot`) persist as JSON;
* wallet escrow ledger: `CREDIT_SALE_ESCROW_HOLD` → `ESCROW_RELEASE_TO_WITHDRAWABLE` with
  per-entry `balanceAfter`, wallet balances updated, `escrowReleasedAt` set;
* credit ledger (`PURCHASE_RESERVE_HOLD`) plus a 3-instalment schedule written and counted;
* dispute + evidence and the audit trail persist correctly;
* **unique keys rejected at the SQL level**: duplicate `mobile`, `sku`, `store_slug`,
  category `slug`, cart line for the same variant, and duplicate
  `(parent_order_id, installment_number)`;
* **RESTRICT holds**: a vendor with products cannot be deleted; a parent order with a
  payment cannot be deleted — both raise real foreign-key violations;
* **CASCADE holds**: deleting a user removes their addresses; deleting a cart removes its items;
* **SET NULL holds**: deleting a product variant keeps the order line readable
  (`product_variant_id = NULL`, title and unit price still present in the snapshot).

This is the automated proof that the schema's relational guarantees are enforced by
PostgreSQL itself and not merely declared in a Prisma file.

---

## 8. Remaining issues and risks

| # | Item | Severity | Detail / mitigation |
| --- | --- | --- | --- |
| 1 | `users.mobile` NOT NULL rollout | Medium | Safe on the current empty database (guarded by `RAISE EXCEPTION`). A **populated** production database requires the documented three-step migration (add nullable → backfill from source system → set not null). Documented in the migration header. |
| 2 | Prisma 7 deprecation warning | Low | Prisma warns that `package.json#prisma` config is deprecated in favour of `prisma.config.ts`. Harmless today (Prisma 6.19.3); migrate before upgrading to Prisma 7. |
| 3 | Sandbox persistence caveat | Low (environment only) | The dev `.docker-data` Postgres cluster can come back empty after a sandbox reset because `pgdata` is uid 999 / mode 0700 and the snapshot runs unprivileged. Recovery: `pnpm db:deploy && pnpm db:seed`. Production uses named volumes and is unaffected. |
| 4 | Index tuning is provisional | Low | The 105 indexes cover every FK and the known search keys. Query plans will be revisited in the phase that implements the read APIs, based on real query patterns (`EXPLAIN ANALYZE`). |
| 5 | No application layer yet | Expected | Nothing reads or writes these tables over HTTP. This is the next phase's work, not a defect of Phase 2. |

---

## 9. What is still mock or incomplete

Honest status: **nothing in Phase 2 is mocked.** No fake table, no placeholder column, no
hard-coded business data, no TODO/FIXME in the schema, migration, seed or tests.

Explicitly not yet implemented (scope of later phases, not claimed as done):

* HTTP endpoints, DTOs, validation, guards and services that use the schema;
* real payment-gateway integration (`SANDBOX` is the active test gateway);
* real bank/BNPL integration (`SANDBOX_BANK` is the active test provider; the real banks are
  modelled but `isActive = false` until credentials exist);
* the credit engine is switched off (`credit.enabled = false`);
* no financial, order or credit data exists in the database by design.

---

## 10. What is needed for the next step

1. **Technical-manager approval of Phase 2** (completion gate: implementation +
   verification + testing — all three are now green).
2. Confirmation of the Phase-3 scope and its ordering. The natural first slice is the
   identity & access layer: `POST /auth/otp` with an `SmsProvider` interface
   (test/sandbox implementation in development), JWT access/refresh issuance, RBAC guards
   for all six roles, and the audit-log writer that feeds `audit_logs`.
3. A decision, when the catalogue APIs land, on whether the `OrderItem` snapshot also needs
   to freeze the vendor's `storeName` (currently `SubOrder.vendorId` + RESTRICT guarantees
   the vendor row still exists, so the name is always resolvable).
4. The Phase-2 work is committed as a reviewed diff; a repository/host decision is needed
   only when you want it pushed to a remote.
