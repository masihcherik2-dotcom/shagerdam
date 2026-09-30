# Shopino — Phase 9 verification report

**Environment:**
- Live stack from `docker compose`: PostgreSQL 16 and Redis 7.4.
- Backend: Node 22, NestJS 11 + Fastify 5, Prisma 6.19.3.
- Migrations `20261001090000_phase9_disputes` and `20261001090100_phase9_dispute_ledger_rules` are applied. `prisma migrate status` reports "11 migrations found … Database schema is up to date".
- `migrate diff` (DB → schema) shows no drift. The only line is the known spurious `DROP INDEX credit_transactions_type_reference_key`, a partial index Prisma cannot represent.

**Providers under test:** IPG `PAYMENT_GATEWAY_PROVIDER=sandbox` and SMS `SMS_PROVIDER=sandbox` (development providers).

The disputes suite drives the real HTTP API end to end:
- OTP login, store onboarding with a KYC document, product creation;
- cart, checkout, sandbox bank page decision, 303 redirect, verified callback;
- vendor transitions and customer delivery confirmation;
- evidence upload through the real multipart media route;
- disputes, responses, arbitration, settlements.

Nothing inside the application is stubbed.

---

## 1. Acceptance criteria (TM brief)

| # | Criterion | Result | Evidence (disputes e2e) |
|---|---|---|---|
| 1 | Ownership, order status and reason validated | ✅ | "refuses packages of unpaid orders, then packages the store has not accepted yet" (`ORDER_NOT_PAID`, `SUB_ORDER_NOT_DISPUTABLE`). "hides other customers' packages (404) and validates the body" (unknown reason, short description, bad uuid, foreign URL, missing `evidenceUrls` → 400). "accepts only the caller's own dispute_evidence uploads" (another customer's file and an own KYC file → 400 `EVIDENCE_NOT_ACCEPTED`). "allows one active dispute per package" (409 `DISPUTE_ALREADY_ACTIVE`). |
| 2 | Opening freezes escrow atomically | ✅ | PROCESSING package: pending 1,800,000 → 0, disputeHold 0 → 1,800,000, two `DISPUTE_HOLD_LOCK` rows, audit CREATE by the customer. DELIVERED package: withdrawable 900,000 → 0, disputeHold 900,000. |
| 3 | Delivery confirmation cannot release escrow during a dispute | ✅ | "delivery confirmation cannot release escrow while the dispute is active": 409 `SUB_ORDER_UNDER_DISPUTE`; withdrawable stays 0 and the hold stays 1,800,000. Vendor SHIPPED and staff force DELIVERED also get 409. |
| 4 | Vendor accept → auto refund | ✅ | "store ACCEPT_RETURN resolves for the buyer": package REFUNDED, `REFUND_DEDUCTION` DISPUTE_HOLD −1,800,000, stock +1, `refundAmount` 2,450,000, `decidedBy` VENDOR, timeline OPENED → VENDOR_ACCEPTED_RETURN → REFUND_NOTICE_SENT, `DISPUTE_RESOLUTION` audit on the Dispute and on the SubOrder. |
| 5 | Vendor defend → UNDER_ARBITRATION | ✅ | "store REJECT_WITH_DEFENSE with its own evidence": status UNDER_ARBITRATION, vendor evidence stored and readable by the customer, the hold untouched. |
| 6 | Staff BUYER_FAVOR → REFUNDED, deducted, restocked | ✅ | Shipped package without a returned item: REFUNDED, deducted, stock unchanged. Delivered package with `itemReturned: true`: REFUNDED, restocked, hold 500,000 deducted, 270,000 of the 400,000 shortfall recovered from later earnings, 130,000 reported as unrecovered. |
| 7 | Staff VENDOR_FAVOR → DELIVERED, withdrawable credited | ✅ | "VENDOR_FAVOR…": `DISPUTE_HOLD_RELEASE` DISPUTE_HOLD −900,000 / WITHDRAWABLE +900,000; package DELIVERED, `escrowReleasedAt` set, audited. |
| 8 | Customers and other vendors cannot arbitrate (401/403) | ✅ | "refuses arbitration to customers, stores, finance officers and anonymous callers": 401 anonymous; 403 for the customer, both vendors and FINANCIAL_OFFICER; a vendor reading the admin dossier gets 403; another store responding gets 404. |
| 9 | Invariant `earned = withdrawn + withdrawable + settlementHold + disputeHold` in one transaction | ✅ | `expectInvariants` runs after every money step for both stores: the invariant plus, per bucket, the column equals SUM(ledger). After the suite, a DB query finds 0 wallets violating the invariant. |
| 10 | Full Swagger | ✅ | "documents every Phase 9 route under its tag" (≥ 3 responses each). The served `/api/docs-json` of the built server lists all 9 dispute paths (10 operations) under `customer-disputes`, `vendor-disputes` and `admin-disputes`; arbitrate documents 200/400/401/403/404/409. |

**Additional cases (all passing):**
- a cancelled dispute returns the hold to escrow PENDING and the package stays SHIPPED; a second cancel gets 409 `DISPUTE_NOT_CANCELLABLE`;
- a new dispute may be opened after a cancellation, but not after a decision (`DISPUTE_ALREADY_DECIDED`);
- a decided dispute cannot be answered (`DISPUTE_NOT_AWAITING_VENDOR`) or arbitrated (`DISPUTE_ALREADY_CLOSED`) again;
- the daily quota returns 429;
- evidence access: the store can download the buyer's file (200), while another store and another customer get 403;
- the customer mobile is masked in the store view (`+98997***0003`);
- the staff dossier contains the order, items, package history, the payment (SUCCESSFUL), the store wallet and the hold;
- the financial overview shows the `disputes` section, `ledgerConsistent: true` and the unrecovered amount.

## 2. Quality gates

| Gate | Command | Result |
|---|---|---|
| Type check | `pnpm typecheck` | ✅ 2/2 packages |
| Lint | `pnpm lint` | ✅ 0 errors, 0 warnings |
| Unit tests | `pnpm test` | ✅ **27 suites, 314/314** (Phase 8: 303; +11 = dispute-policy 7, escrow-state table in wallet-math, media dispute-party access) |
| E2E (live PG + Redis) | `pnpm test:e2e` | ✅ **10 suites, 274/274** (Phase 8: 248; +26 disputes) |
| Build | `pnpm build` | ✅ backend + web |
| Served HTTP | `node dist/main.js` + curl | ✅ see below |

**Real-HTTP probes against the built server:**

| Request | Status |
|---|---|
| `GET health` | 200 |
| `GET customer/disputes`, `GET vendor/disputes`, `POST admin/disputes/:id/arbitrate` (anonymous) | 401 each |
| `GET /api/docs-json`, `GET /api/docs` | 200 / 200; 9 dispute paths; the `dispute_evidence` purpose is documented on `media/upload/document` |

**Existing suites adapted to Phase 9 (intended behaviour changes, not regressions):**
- `finance.e2e-spec.ts`: the bucket → column reconciliation map now includes `DISPUTE_HOLD`.
- `schema-integrity.e2e-spec.ts`: the Phase 2 dispute fixture now has the Phase 9 NOT NULL columns (`vendorId`, `subOrderStatusAtOpen`).
- `media.service.spec.ts`: its in-memory Prisma double gained `disputeEvidence.count`, used by the new access rule. A new test covers dispute-party access.

**Data hygiene:** after the suite, 0 test users, 0 disputes and 0 invariant violations remain. System configs are restored, and the Redis dispute counters and sandbox payment keys are removed.

## 3. Test money used by the disputes suite (exact figures)

Category commission 10%, platform shipping 450,000 per package:
- **A1** 2,000,000 → earnings 1,800,000;
- **B1** 1,000,000 → 900,000;
- **B2** 300,000 → 270,000.

| Scenario | Package | Flow | Result |
|---|---|---|---|
| 2 | order1 / A1 (PROCESSING) | open → store ACCEPT_RETURN | hold 1,800,000 → REFUND_DEDUCTION; refundAmount 2,450,000; restocked |
| 3 | order1 / B1 (DELIVERED) | open → store defends → staff VENDOR_FAVOR | 900,000 WITHDRAWABLE → HOLD → WITHDRAWABLE |
| 4 | order2 / A1 (SHIPPED) | open → cancel → reopen → staff BUYER_FAVOR (not returned) | hold → PENDING → hold → REFUND_DEDUCTION; no restock; refundAmount 2,450,000 |
| 5 | order3 / B1 (DELIVERED) | store B settles 1,300,000 of 1,800,000 → open → settlement paid → order4 (B2) delivered → staff BUYER_FAVOR (returned) | hold 500,000, shortfall 400,000; deducted 500,000 from the hold + 270,000 from withdrawable; unrecovered 130,000; restocked; refundAmount 1,450,000 |

Final wallet of store B: withdrawn 1,300,000 = earned 1,300,000; withdrawable, settlementHold and disputeHold are all 0.

## 4. Disputes e2e suite: output (26 tests)

```
PASS test/disputes.e2e-spec.ts (16.542 s)
  Phase 9 — disputes, escrow freeze and arbitration (live stack)
    opening: ownership, order state, reason and evidence
      ✓ requires a customer token (11 ms)
      ✓ refuses packages of unpaid orders, then packages the store has not accepted yet (99 ms)
      ✓ hides other customers’ packages (404) and validates the body (25 ms)
      ✓ accepts only the caller’s own dispute_evidence uploads as evidence (59 ms)
      ✓ limits a customer to 10 dispute attempts per day (429, Redis counter) (8 ms)
    not-yet-shipped package: freeze, blocked transitions, store accepts the return
      ✓ opens the dispute and freezes the escrow PENDING → DISPUTE_HOLD in the same transaction (64 ms)
      ✓ allows one active dispute per package (11 ms)
      ✓ blocks every status change of the disputed package (409 SUB_ORDER_UNDER_DISPUTE) (30 ms)
      ✓ shows the dispute to its customer and its store only; the store may read the buyer’s evidence (94 ms)
      ✓ refuses arbitration to customers, stores, finance officers and anonymous callers (17 ms)
      ✓ store ACCEPT_RETURN resolves for the buyer: REFUNDED, REFUND_DEDUCTION from the hold, restocked, refund notice (82 ms)
      ✓ a decided dispute cannot be answered again and its package cannot be disputed again (26 ms)
    delivered package: freeze from WITHDRAWABLE, store defends, staff decides for the store
      ✓ freezes the already released earnings (WITHDRAWABLE → DISPUTE_HOLD) (128 ms)
      ✓ store REJECT_WITH_DEFENSE with its own evidence → UNDER_ARBITRATION (48 ms)
      ✓ gives staff the full dossier (21 ms)
      ✓ validates the arbitration body (6 ms)
      ✓ VENDOR_FAVOR: package DELIVERED, hold released to WITHDRAWABLE (DISPUTE_HOLD_RELEASE), audited (41 ms)
      ✓ a decided dispute cannot be arbitrated again, and the package cannot be disputed again (19 ms)
    shipped package: delivery blocked, customer cancels and re-opens, staff decides for the buyer
      ✓ delivery confirmation cannot release escrow while the dispute is active (43 ms)
      ✓ customer cancel returns the hold to escrow PENDING; the package stays SHIPPED (50 ms)
      ✓ a cancelled dispute does not block a new one (37 ms)
      ✓ staff BUYER_FAVOR without a returned item: REFUNDED, deducted, stock untouched (47 ms)
    delivered package whose earnings were partly withdrawn: shortfall, recovery, unrecovered remainder
      ✓ BUYER_FAVOR deducts the hold, recovers from later earnings and reports the rest as unrecovered (273 ms)
      ✓ surfaces disputes and the dispute hold in the financial overview (14 ms)
    OpenAPI contract
      ✓ documents every Phase 9 route under its tag (127 ms)
Test Suites: 1 passed, 1 total
Tests:       26 passed, 26 total
```

## 5. Known limitations (not failures)

- **The refund to the customer is recorded, not paid.** `refundAmount` and `refundsOwedToCustomers` are exact, but the bank refund is manual because no IPG refund API is integrated.
- **Unrecovered vendor earnings are reported, not collected** (no vendor debt ledger yet; this needs a TM decision).
- **Buyer favour on credit-funded packages returns 409** `CREDIT_ORDER_REFUND_UNSUPPORTED` (Phase 8 limitation); the hold stays.
- **Race on concurrent opens:** covered by the parent-order lock and by the partial unique index. It is not load-tested in e2e; it was checked by code review and by the DB constraint.
- **SMS failure path:** the refund notice is exercised on the sandbox provider (SENT). The FAILED branch (`REFUND_NOTICE_FAILED`, decision kept) is covered only by code review, because the sandbox cannot be made to fail on demand.
- `prisma:error` lines in the e2e log come from negative tests that expect a refused write; they are not failures.
