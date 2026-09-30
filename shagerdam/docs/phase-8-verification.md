# Shopino — Phase 8 verification report

**Environment:**
- Live stack from `docker compose`: PostgreSQL 16 and Redis 7.4.
- Backend: Node 22, NestJS 11 + Fastify 5, Prisma 6.19.3.
- Migration `20260930090000_phase8_credit` is applied; `prisma migrate status` reports "9 migrations found … Database schema is up to date".

**Providers under test:**
- Credit provider: `SANDBOX_BANK`, resolved from the DB.
- IPG: `PAYMENT_GATEWAY_PROVIDER=sandbox`.

The e2e suite drives the real HTTP API: OTP login, cart, checkout, credit application, credit initiate, the sandbox bank page decision, the 303 redirect, and the callback. Nothing inside the application is mocked. Both providers are development/test providers, not production-ready.

---

## 1. Acceptance criteria (TM brief)

| # | Criterion | Result | Evidence (credit e2e) |
|---|---|---|---|
| 1 | Invariant `totalLimit = used + reserved + available` across all operations | ✅ | "holds for every account touched by the suite and equals the replay of its ledger". After every step the stored row = replay of its `credit_transactions`, and the latest `balanceAfter` = available. A direct UPDATE breaking it is rejected by the DB CHECK `credit_accounts_limit_invariant`. |
| 2 | Apply → exact balance, one `CREDIT_ALLOCATION` | ✅ | "approves instantly…": total 20,000,000 = available, used 0, reserved 0, exactly one ALLOCATION row whose referenceCode is the application id. A rejection (score below threshold) opens no account. |
| 3 | BANK_CREDIT order PAID; schedule row count, amounts and dates correct; escrow credited | ✅ | "completes immediately…": order 6,450,000 on the 6 m / 9% plan → 6 rows of 1,075,000 + 96,750, due today(Tehran) + 30·k. Ledger HOLD + COMMIT. Sandbox reservation COMMITTED. Packages PENDING_APPROVAL. Stock committed. Vendor pending escrow +5,400,000. |
| 4 | HYBRID success → PAID, credit committed, cash recorded | ✅ | "a verified card part completes the order…": 15,450,000 = credit 13,550,000 + cash 1,900,000. Principals 4,516,666 × 2 + 4,516,668. Payment SUCCESSFUL with a 12-digit RRN. Escrow +13,500,000. |
| 5 | HYBRID IPG failure → reservation released | ✅ | "a failed card part rolls the credit reservation back…": Payment FAILED, `RESERVATION_RELEASE` row, available back to 13,550,000, sandbox RELEASED, order still payable (the subsequent payment succeeds). |
| 6 | Repayment restores available credit | ✅ | "paying an installment marks it PAID and restores its principal…": available +1,075,000, used −1,075,000, `INSTALLMENT_REPAYMENT_RESTORE`. The OVERDUE installment is payable too (+1,075,000 → 2,150,000). |
| 7 | Installments grouped by order with PENDING / PAID / OVERDUE | ✅ | "lists installments grouped by order"; "marks an installment whose due date has passed as OVERDUE" (a second sweep changes 0 rows). |
| 8 | Staff views and exposure | ✅ | Roles enforced (support, customer and vendor refused). National codes masked `******` + last 4. Exposure `outstandingInstallments` = 18,237,000, equal to an independent DB sum. |
| 9 | Full Swagger | ✅ | "documents every Phase 8 route under its tag" (≥ 2 responses each). The served `/api/docs-json` of the built server lists all 8 routes under the `credit`, `credit-payments`, `credit-installments` and `admin-credit` tags. |

**Additional edge cases (all passing):**
- `credit.enabled=false` → plans empty and operations return 503;
- duplicate account for one provider → 409; the same national code for another user → 409;
- an order cannot be paid twice;
- concurrent BANK_CREDIT submissions complete exactly once, and the loser's reservation is released;
- a vendor cannot cancel a credit order (409 `CREDIT_ORDER_REFUND_UNSUPPORTED`);
- a customer cancel with an in-flight HYBRID attempt releases the reservation, and a late capture is flagged `PAID_REQUIRES_REFUND` without re-using credit;
- a declined repayment leaves the installment payable;
- ownership and id checks on the pay endpoint;
- the financial overview separates card cash, credit-funded sales and installment collections.

## 2. Quality gates

| Gate | Command | Result |
|---|---|---|
| Type check | `pnpm typecheck` | ✅ 2/2 packages |
| Lint | `pnpm lint` | ✅ 0 errors, 0 warnings |
| Unit tests | `pnpm test` | ✅ **26 suites, 303/303** (Phase 7: 271; +32 = installment-math, credit-math, sandbox-bank provider) |
| E2E (live PG + Redis) | `pnpm test:e2e` | ✅ **9 suites, 248/248** (Phase 7: 219; +29 credit) |
| Build | `pnpm build` | ✅ backend + web |
| Served HTTP | `node dist/main.js` + curl | ✅ see below |

**Real-HTTP probes against the built server:**

| Request | Status |
|---|---|
| `GET credit/plans` (anonymous) | 200. `creditEnabled: true`, provider `SANDBOX_BANK` with `isSandbox: true`, plans 3 / 6 / 12 months |
| `GET credit/account`, `GET credit/installments`, `POST credit/applications`, `POST payments/credit/initiate`, `GET admin/credit/accounts`, `GET admin/credit/applications` (anonymous) | 401 each |
| `GET /api/docs-json`, `GET /api/docs` | 200 / 200 (72 paths) |
| Boot log | `Credit provider SANDBOX_BANK is a sandbox: no real credit is granted and no money moves` |

**Existing suites adapted to Phase 8 (intended behaviour changes, not regressions):**
- `finance.e2e-spec.ts`: the independent "collected" aggregate now filters `purpose = ORDER_CHECKOUT`, matching the new definition of `collectedByGateway`.
- `schema-integrity.e2e-spec.ts`: the Phase 2 fixture payment had a credit part without method, account, plan or reservation, and the new `payments_credit_part_shape` CHECK correctly refused it. It now uses the Phase 8 HYBRID shape.
- `seed.e2e-spec.ts`: `credit.enabled` is now `true`, because BNPL ships in this phase.

**Data hygiene:** after the suite, 0 test users, 0 credit accounts, 0 applications, 0 credit transactions and 0 installment schedules remain. `credit.enabled` is restored to `true`, and no `credit:sandbox:*` or `payment:sandbox:*` keys are left behind.

## 3. Test money used by the credit suite (exact figures)

- **Customer 1:** approved at 20,000,000.
  - **Order 1:** 2 × 3,000,000 + shipping 450,000 = 6,450,000, paid by BANK_CREDIT on the 6 m / 9% plan.
    - Interest 580,500; installments 1,171,750 × 6.
    - Available 13,550,000.
  - **Order 2:** 15,450,000 (5 × 3,000,000 + shipping), paid by HYBRID on the 3 m / 0% plan.
    - Credit 13,550,000, cash 1,900,000; available 0.
  - **Repayments:** installment #1 of order 1 → available 1,075,000; overdue #2 → 2,150,000.
  - **Outstanding:** 4 × 1,171,750 + 13,550,000 = 18,237,000.
- **Customer 3:** approved at 10,000,000; the concurrency order is 3,450,000.
- **Customer 2:** rejected (score below 600).

## 4. Credit e2e suite: output (29 tests)

```
PASS test/credit.e2e-spec.ts (9.3 s)
  Phase 8 — credit engine, BNPL checkout and instalments (live stack)
    instalment plans
      ✓ lists the active plans of the active (sandbox) provider publicly (11 ms)
      ✓ offers nothing and refuses credit operations while credit.enabled is false (12 ms)
    credit applications
      ✓ enforces authentication, role and validation (21 ms)
      ✓ records a rejection with its reason and opens no account (score below threshold) (32 ms)
      ✓ approves instantly: application, account with the exact limit and one CREDIT_ALLOCATION row, in one step (34 ms)
      ✓ GET /credit/account returns the balances and the active provider (8 ms)
      ✓ refuses a second account with the same provider and a national code of another user (15 ms)
      ✓ opens the account of the third customer (used by the concurrency test) (18 ms)
    BANK_CREDIT checkout
      ✓ prices the order as documented (6,450,000 IRR) (1 ms)
      ✓ validates the request: role, ownership, plan and method (42 ms)
      ✓ completes immediately: order PAID, packages PENDING_APPROVAL, credit committed, schedule written, escrow funded (96 ms)
      ✓ cannot be paid twice, and credit orders cannot be cancelled by the store yet (18 ms)
      ✓ concurrent BANK_CREDIT submissions for one order complete it exactly once (117 ms)
    HYBRID checkout
      ✓ prices the order (15,450,000) above the available credit; BANK_CREDIT is refused (14 ms)
      ✓ a failed card part rolls the credit reservation back; the order stays payable (64 ms)
      ✓ a verified card part completes the order: PAID, credit committed, cash recorded, schedule written (88 ms)
    instalments and repayment
      ✓ lists instalments grouped by order (11 ms)
      ✓ marks an instalment whose due date has passed as OVERDUE (17 ms)
      ✓ guards the pay endpoint: auth, ownership, id format (13 ms)
      ✓ a declined repayment leaves the instalment unpaid and payable (41 ms)
      ✓ paying an instalment marks it PAID and restores its principal to the credit line (62 ms)
      ✓ an OVERDUE instalment can be paid too (54 ms)
    unpaid order closure
      ✓ cancelling an order with a HYBRID attempt in flight releases the reservation; a late capture is flagged and never re-uses credit (116 ms)
    staff credit views
      ✓ are restricted to finance staff and admins (40 ms)
      ✓ lists applications with masked national codes and filters (20 ms)
      ✓ lists accounts with the aggregated exposure and a consistent ledger (19 ms)
      ✓ the financial overview separates card money, credit-funded sales and instalment collections (11 ms)
    credit invariant
      ✓ holds for every account touched by the suite and equals the replay of its ledger (270 ms)
    OpenAPI contract
      ✓ documents every Phase 8 route under its tag (96 ms)

Test Suites: 1 passed, 1 total
Tests:       29 passed, 29 total
Snapshots:   0 total
Time:        10.575 s
Ran all test suites matching /credit/i.
```

## 5. Known limitations (not failures)

- **Only `SANDBOX_BANK` exists.** No real bank credit API has been integrated or tested, and the provider is flagged as a sandbox everywhere.
- **Credit-order cancel/refund returns 409.** There is no reverse credit flow yet.
- **No late penalty** is charged on OVERDUE installments.
- **No calculator preview endpoint.**
- **The IPG-failure-at-session-start path is not covered by e2e.** It releases the reservation and returns 502; the sandbox IPG cannot be made to fail on demand, so this path is covered only by code review.
- `prisma:error` lines in the e2e log come from negative tests that expect a refused write (CHECK or unique violation); they are not failures.
