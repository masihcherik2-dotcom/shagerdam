# Shopino — Phase 7 verification report

**Environment:**

- Live stack from `docker compose`: PostgreSQL 16 and Redis 7.4.
- Backend: Node 22, NestJS 11 + Fastify 5, Prisma 6.19.3.
- Migration `20260929090000_phase7_finance` applied; `prisma migrate status` is clean.

**Provider under test:** `PAYMENT_GATEWAY_PROVIDER=sandbox`. The e2e suite drives the real HTTP flow through the sandbox bank page: initiate → bank page → decision → 303 → callback. Nothing is mocked inside the application. Zarinpal is covered by unit tests only; see §5.

---

## 1. Acceptance criteria (TM brief)

| # | Criterion | Result | Evidence (finance e2e) |
|---|---|---|---|
| 1 | initiate → Payment INITIATED, `{paymentId, redirectUrl, gatewayName:"SANDBOX"}` | ✅ | "creates an INITIATED payment and returns the sandbox bank page" |
| 2 | Success → parent PAID, sub-orders **PENDING_APPROVAL**, stock committed (`stock−q`, `reserved−q`), exact escrow credit, ledger rows | ✅ | "a successful payment completes the order atomically…": wallets A = 5,550,000.00 and B = 2,700,000.00 pending; one `CREDIT_SALE_ESCROW_HOLD` row per package with the exact `balanceAfter` |
| 3 | Before payment, packages are hidden from vendors | ✅ | "keeps packages hidden from vendors while the order is unpaid" |
| 4 | Failure → Payment FAILED, order retryable, stock stays reserved | ✅ | "a declined payment fails the Payment but keeps the order payable…" |
| 5 | Redirect parameters are not trusted | ✅ | "never trusts the redirect: a forged Status=OK … is verified and rejected" |
| 6 | Idempotent callback (GET and form POST), no double application | ✅ | "repeated callbacks … never apply twice"; "concurrent callbacks … exactly once" |
| 7 | DELIVERED releases escrow once: pending → withdrawable, totalEarned, `escrowReleasedAt`, `ESCROW_RELEASE_TO_WITHDRAWABLE` | ✅ | "customer confirmation of a SHIPPED package releases the escrow … exactly once" (a second confirmation returns 409 and the balances are unchanged) |
| 8 | Cancel before delivery reverses the escrow and restocks | ✅ | "a vendor cancel before delivery reverses the escrow and restocks…" |
| 9 | Settlement request deducts withdrawable immediately | ✅ | "a request holds the amount immediately…" |
| 10 | Request > withdrawable → 409; < minimum → 400; foreign or invalid IBAN refused | ✅ | "validates amount and IBAN…" |
| 11 | Approve → PAID_PAYA + `SETTLEMENT_PAYOUT`, totalWithdrawn increased | ✅ | "approve records the PAYA payout…"; "POST …/payout pays a request…" |
| 12 | Reject → held amount restored | ✅ | "reject restores the held amount…" |
| 13 | Only FINANCIAL_OFFICER / SUPER_ADMIN process; SUPPORT and VENDOR refused | ✅ | "lists requests for finance staff…"; role tests |
| 14 | Financial overview matches the live DB | ✅ | "matches independent aggregates of the live database and reports a consistent ledger" |
| 15 | Full Swagger | ✅ | "documents every Phase 7 route under its tag" (≥ 2 responses per route); served `/api/docs-json` lists all 12 Phase 7 paths (including confirm-delivery) |

**Additional edge cases (all passing):**

- the expiry sweeper spares an in-flight payment;
- a late capture on an expired order is flagged `requiresManualRefund`;
- 5 open attempts per order, then 429;
- a refund after delivery that would make withdrawable negative is refused (409) with nothing changed;
- a Paya reference cannot be reused;
- a processed request cannot be processed again.

## 2. Quality gates

| Gate | Command | Result |
|---|---|---|
| Type check | `pnpm typecheck` | ✅ 2/2 packages |
| Lint | `pnpm lint` | ✅ 0 errors, 0 warnings |
| Unit tests | `pnpm test` | ✅ **23 suites, 271/271** (Phase 6: 252; +19 = wallet-math, Zarinpal provider, payment env validation) |
| E2E (live PG + Redis) | `pnpm test:e2e` | ✅ **8 suites, 219/219**, run twice in a row with the same result (Phase 6: 192; +27 finance) |
| Build | `pnpm build` | ✅ backend + web |
| Served HTTP | `pnpm verify:http` against `node dist/main.js` | ✅ 4/4 (health: database up, redis up; docs-json includes every Phase 7 path) |
| Boot warning | server log | ✅ `PAYMENT_GATEWAY_PROVIDER=sandbox — card payments are simulated…; development/test provider only.` |
| Production guard | unit test (env validation) | ✅ `NODE_ENV=production` + sandbox → boot refused; zarinpal without a merchant id → refused |

**Real-HTTP probes against the built server:**

| Request | Status |
|---|---|
| `GET payments/callback?Status=OK` (no token) | 400 |
| `GET payments/callback?Authority=SBXNOPE&Status=OK` | 404 |
| `POST payments/callback` (form-urlencoded, unknown token) | 404 (form body parsed) |
| `GET admin/financial/overview` (anonymous) | 401 |
| `GET vendor/wallet` (anonymous) | 401 |
| `GET sandbox/payment-page/<unknown uuid>` | 404 |

**Data hygiene:** after the suite, no payments, ledger rows, settlements or test users remain. Only the seed vendor wallet exists, the settlement minimum is restored to `5000000.00`, and no `payment:sandbox:*` keys are left in Redis.

## 3. Test money used by the finance suite (exact figures)

- **Package A:** 2 × 3,000,000 at store A's 7.5 % override → items 6,000,000, commission 450,000, **earnings 5,550,000**.
- **Package B:** 1 × 3,000,000 at 10 % → commission 300,000, **earnings 2,700,000**.
- **Shipping:** 450,000 per package (below the 20,000,000 free threshold).
- **Payable:** 9,000,000 + 900,000 = **9,900,000 IRR**, rendered on the sandbox bank page as `۹٬۹۰۰٬۰۰۰`.
- **Escrow held after payment:** 8,250,000 (= 5,550,000 + 2,700,000). Shipping is not credited to vendors (see deliverable §9).

## 4. Finance e2e suite: output (27 tests)

```
    
    
  Phase 7 — payments, escrow wallet and settlements (live stack)
    payment initiation
      ✓ prices the order as documented (9,900,000 IRR) (3 ms)
      ✓ enforces authentication, role and ownership (10 ms)
      ✓ creates an INITIATED payment and returns the sandbox bank page (23 ms)
      ✓ keeps packages hidden from vendors while the order is unpaid (10 ms)
    callback processing
      ✓ a declined payment fails the Payment but keeps the order payable with its stock reserved (32 ms)
      ✓ never trusts the redirect: a forged Status=OK for an unpaid bank session is verified and rejected (22 ms)
      ✓ rejects callbacks without a token (400) and with an unknown token (404) (3 ms)
      ✓ a successful payment completes the order atomically: PAID, PENDING_APPROVAL, stock committed, escrow credited (77 ms)
      ✓ repeated callbacks (GET or form POST) return the same outcome and never apply twice (14 ms)
      ✓ a paid order cannot be paid again (4 ms)
      ✓ packages are now visible to their vendors in PENDING_APPROVAL (6 ms)
    escrow release and reversal
      ✓ customer confirmation of a SHIPPED package releases the escrow to withdrawable, exactly once (355 ms)
      ✓ a vendor cancel before delivery reverses the escrow and restocks; a later staff REFUNDED is a wallet no-op (86 ms)
    vendor settlements
      ✓ guards the vendor wallet endpoints by role (10 ms)
      ✓ validates amount and IBAN: > withdrawable 409, < minimum 400, foreign IBAN 409, invalid IBAN 400 (39 ms)
      ✓ a request holds the amount immediately (withdrawable → settlement hold); a second one cannot overdraw (54 ms)
      ✓ lists requests for finance staff with filters; support and vendors are refused (35 ms)
      ✓ reject restores the held amount; a processed request cannot be processed again (54 ms)
      ✓ approve records the PAYA payout: PAID_PAYA, hold cleared, totalWithdrawnAmount increased (49 ms)
      ✓ POST …/payout pays a request; a PAYA reference cannot be reused (49 ms)
      ✓ a refund after delivery cannot drive the withdrawable balance negative (409, nothing changes) (14 ms)
    payment edge cases
      ✓ the expiry sweeper spares an order whose payment is in flight, and a late capture is flagged for manual refund (133 ms)
      ✓ concurrent callbacks for one payment apply it exactly once (108 ms)
      ✓ limits open payment attempts per order (106 ms)
    financial overview
      ✓ is restricted to finance staff and admins (15 ms)
      ✓ matches independent aggregates of the live database and reports a consistent ledger (14 ms)
    OpenAPI contract
      ✓ documents every Phase 7 route under its tag (96 ms)
Tests:       27 passed, 27 total
```

## 5. Known limitations (not failures)

- **Zarinpal** is verified only by 9 unit tests against the v4 contract (request, StartPay URL, verify codes 100/101, errors, timeout, amount mismatch). A real merchant ID test is required before production.
- **No reconcile job** for INITIATED payments whose callback never arrives.
- **Refunds to the card are manual** (`requiresManualRefund`, counted in the overview).
- **Shipping money** is not credited to vendors (Phase 6 earnings rule); ownership is pending a TM decision.
- `commerce.escrowHoldDays` is unused (release is immediate on DELIVERED, per the brief).
- `prisma:error` lines in the e2e log come from negative tests that expect a refused write (CHECK or unique violation); they are not failures.
