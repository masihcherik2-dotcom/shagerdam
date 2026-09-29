# Phase 10 — Verification report

## 1. Environment

- **Services:** PostgreSQL 16 and Redis 7 (docker compose); backend `node dist/main.js` on :4000; frontend `next start` (production build) on :3000.
- **Providers:** sandbox SMS, sandbox IPG, SANDBOX_BANK credit. No real money or credit moves.
- **Browser tests:** Playwright (Chromium, `fa-IR`, 1366×900) drives the real UI against the live backend. OTP codes are read from the sandbox SMS log line, exactly as a tester would read an SMS.
  - Harness: `tmpdoc/p10e2e/` (`helpers.py`, `stage1_store.py` … `stage5_session.py`).
  - The harness is outside the repository, because it is a verification tool and not product code.
  - Screenshots: `tmpdoc/p10e2e/shots/`.

## 2. Automated suites (final run, after the last code change)

| Suite | Command | Result |
|---|---|---|
| Frontend typecheck | `pnpm --filter @shopino/frontend typecheck` | 0 errors |
| Frontend lint | `pnpm --filter @shopino/frontend lint` | 0 problems |
| Frontend unit (vitest) | `pnpm --filter @shopino/frontend test` | **60/60** (9 files) |
| Frontend build | `pnpm --filter @shopino/frontend build` | Compiled successfully; all routes generated |
| Backend typecheck + lint | `pnpm --filter @shopino/backend typecheck && … lint` | 0 errors / 0 problems |
| Backend unit (jest) | `pnpm --filter @shopino/backend test` | **322/322** (29 suites) |
| Backend e2e (real PostgreSQL + Redis) | `pnpm --filter @shopino/backend test:e2e` on a freshly migrated + seeded database `shopino_e2e` | **274/274** (10 suites) |

**Note on the e2e database.** `seed.e2e-spec.ts` and `schema-integrity.e2e-spec.ts` assert that the database holds **no fabricated financial data** (zero wallet balances, no orders or payments beyond the seed).

- After the browser E2E run, the development database `shopino_db` legitimately contains real orders, payments and vendor wallets, so those 4 assertions fail there by design.
- The same suite passes 274/274 on a clean database (11 migrations + seed). It also passed 274/274 on `shopino_db` earlier in this round, before the browser stages.
- This is a data-state precondition, not a regression.

## 3. Browser E2E — results

| Stage | Script | Identities | Result |
|---|---|---|---|
| 1. Store, cart, checkout (cash IPG) | `stage1_store.py` | customer `09971180002` | **29/29** |
| 2. Vendor onboarding, KYC, admin approval, product with variant matrix | `stage2_vendor.py` | vendor `09971180014` | **21/21** |
| 3. Fulfilment, tracking, delivery, photo dispute, vendor defence, arbitration, wallet, settlement + Paya payout, moderation | `stage3_fulfilment.py` | customer `…0002`, vendor `…0014`, support, finance, admin | **40/40** |
| 4. Credit / BNPL: rejection, approval, 100% credit, hybrid, installment repayment, credit-order arbitration guard | `stage4_credit.py` | rejected `…0032`, credit customer `…0006`, vendor `…0014`, support | **27/27** |
| 5. Expired token, silent refresh, logout revocation, revoked session, invalid cookie | `stage5_session.py` (backend restarted with `JWT_ACCESS_TTL=60s`, then restored) | customer `…0040` | **12/12** |
| **Total** | | | **129/129** |

**Run notes (full disclosure):**

- Stages 2 → 5 were each re-run from the start, with fresh identities and a fresh product, after fixing test-harness bugs. The final logs below are complete single runs. The harness bugs were:
  - a URL-encoded slug comparison;
  - a reused Paya reference, which the backend correctly refused because references are unique;
  - the wrong JSON path for installments and for `moderation.isBlockedByAdmin`;
  - an ambiguous radio selector;
  - an OTP cooldown collision.

  No product code was changed to make a test pass, except the two real defects listed in the deliverable §5: logout revocation and localised credit reasons.
- To fit five stages into one hour, the dev-only Redis counters `auth:otp:hourly:ip:127.0.0.1` and `auth:otp:hourly:mobile:+989971180002` were deleted once each. Rate limiting itself was not disabled.
  - The harness waits out the 120 s per-mobile cooldown when it gets a 429 (observed and honoured: "note OTP cooldown … waiting 125 s").
- The e2e and browser runs were done against `localhost:3000`. See §5 for the preview-host caveat.

## 4. Stage logs (verbatim)

### Stage 1 — store, cart, checkout

```text
PASS html dir=rtl — rtl
PASS home: featured product from API
PASS home: category grid
PASS home: BNPL promo
PASS home: Toman prices
PASS search: debounced query in URL — http://localhost:3000/search?q=%D9%84%D9%BE
PASS search: sort param accepted
PASS category page: product listed
PASS product matrix: black → SKU BLK-L
PASS product matrix: black/XL missing → XL disabled
PASS product matrix: white/XL → SKU WHT-XL
PASS product: installment calculator
PASS guest cart: header badge updated
PASS cart: grouped by vendor
PASS guest cart token held in httpOnly cookie
PASS no JWT/cart token readable from JS
PASS checkout redirects anonymous to login — http://localhost:3000/login?next=%2Fcheckout
PASS login returns to checkout — http://localhost:3000/checkout
PASS session cookies httpOnly — shopino_at,shopino_rt
   note [store] 404 GET http://localhost:3000/api/v1/credit/account
PASS address saved and selected
PASS payment: cash IPG offered
PASS payment: no credit account → apply-for-credit CTA instead of credit methods
PASS redirected to sandbox bank page — http://localhost:3000/api/v1/sandbox/payment-page/2e80d316-0185-4959-9bc6-e2d90561a69b
PASS payment result: success message — http://localhost:3000/payment/result?orderNumber=SHP-100000020&outcome=PAID&paymentId=2e80d316-0185-4959-9bc6-e2d90561a69b&parentOrderId=7521e47c-ca5b-428a-951f-67b5e2df2bfe&purpose=ORDER_CHECKOUT&rrn=181381216050
PASS payment result: orderNumber in query
PASS payment result: RRN shown
PASS customer orders: new order listed
PASS order detail: package + vendor
PASS no browser errors / 5xx
=== 29/29 checks passed ===
```

### Stage 2 — vendor onboarding and catalogue

```text
PASS vendor register: store created → KYC step
PASS KYC: document uploaded (private)
PASS KYC submitted → awaiting review
PASS pending vendor (still CUSTOMER role) cannot open vendor panel — http://localhost:3000/forbidden?from=%2Fvendor%2Fdashboard&home=%2Fcustomer%2Forders
PASS admin lands on /admin/vendors (role home) — http://localhost:3000/admin/vendors
PASS admin vendors: pending application listed
PASS admin vendor detail: KYC doc link
PASS KYC doc downloads for admin via BFF — /api/v1/media/documents/0ce06b8b-235a-4b2f-8856-ece596387dbb/download → 200
PASS KYC doc NOT downloadable anonymously — 401
PASS admin: store approved
PASS vendor: role refreshed → vendor panel — http://localhost:3000/vendor/dashboard
PASS vendor dashboard renders metrics
PASS product image uploaded
PASS variant matrix: 4 rows generated — 4
PASS variant matrix: SKUs suggested & unique — 1834-C1-M,1834-C1-L,1834-C2-M,1834-C2-L
PASS product saved → edit page — http://localhost:3000/vendor/products/49a95062-fc84-440c-b45f-153f4e412b10
PASS vendor products list shows product
PASS public search finds new product
PASS public product page: new vendor card
PASS public product page: 2 colours
PASS no browser errors / 5xx
=== 21/21 checks passed ===
```

### Stage 3 — fulfilment, disputes, wallet, payout, moderation

```text
   note [customer] 429 POST http://localhost:3000/api/session/otp
   note OTP cooldown for 09971180002: waiting 125 s and retrying once
PASS order A: cart quantity 4 — [('1834-C1-M', 4)]
   note [customer] 404 GET http://localhost:3000/api/v1/credit/account
PASS order A: paid via sandbox bank — orderNumber=SHP-100000032&outcome=PAID&paymentId=fc9fef20-4a2e-4311-9909-a913f48
PASS order B: cart quantity 1 — [('1834-C2-L', 1)]
   note [customer] 404 GET http://localhost:3000/api/v1/credit/account
PASS order B: paid via sandbox bank — orderNumber=SHP-100000033&outcome=PAID&paymentId=b45e814f-3a52-4954-af72-ac3aff9
PASS vendor dashboard: pending packages counter
PASS vendor orders: 2 packages awaiting approval
PASS vendor: both packages PROCESSING — ['PROCESSING', 'PROCESSING']
PASS vendor: both packages SHIPPED with tracking — [('SHIPPED', 'TPX-P10-0001'), ('SHIPPED', 'TPX-P10-0002')]
PASS order A: tracking code visible to customer
PASS order A: carrier visible
PASS order A: package DELIVERED — DELIVERED
PASS dispute: evidence photo uploaded
PASS dispute: OPEN (exactly one active) — ['OPEN']
PASS dispute: evidence attached
PASS customer disputes list shows dispute
PASS wallet: A released to withdrawable — 10320000.00
PASS wallet: B frozen in dispute hold — 2580000.00
PASS wallet page: balances rendered
PASS settlement modal: IBAN prefilled read-only — IR200170000000171699780258
   note [vendor] 400 POST http://localhost:3000/api/v1/vendor/wallet/settlements
PASS settlement below minimum → localized error with minimum
PASS settlement REQUESTED for full withdrawable — [('REQUESTED', '10320000.00')]
PASS vendor dispute: customer evidence visible
PASS dispute → VENDOR_RESPONDED/UNDER_ARBITRATION — UNDER_ARBITRATION
PASS support lands on /admin/disputes — http://localhost:3000/admin/disputes
PASS dossier: both parties' statements
PASS cash order: BUYER_FAVOR option enabled
PASS dispute RESOLVED_VENDOR_FAVOR — RESOLVED_VENDOR_FAVOR
PASS wallet: dispute hold released — 0.00
PASS support cannot open financial (role guard) — http://localhost:3000/forbidden?from=%2Fadmin%2Ffinancial&home=%2Fadmin%2Fdisputes
PASS finance overview: GMV/escrow cards
PASS settlement PAID_PAYA with reference — PAID_PAYA PAYA-P10-1790557418
PASS wallet: totalWithdrawn increased by payout — 10320000.00 vs 10320000.00
PASS finance cannot open vendor moderation — http://localhost:3000/forbidden?from=%2Fadmin%2Fvendors&home=%2Fadmin%2Ffinancial
PASS blocked product hidden from public API — 404
PASS unblock toast: republishing is the vendor's decision
PASS after unblock: not blocked, still unpublished (backend rule) — False/False
PASS unblocked-but-unpublished product still hidden — 404
PASS vendor republishes (toast)
PASS republished product visible again — 200
PASS no browser errors / 5xx
=== 40/40 checks passed ===
```

### Stage 4 — credit / BNPL

```text
   note [rejected] 404 GET http://localhost:3000/api/v1/credit/account
PASS credit: low score → REJECTED badge inline
PASS credit: rejection reason localized (no raw code)
PASS credit: rejected applicant has no account
   note [credit] 404 GET http://localhost:3000/api/v1/credit/account
   note [credit] 404 GET http://localhost:3000/api/v1/credit/account
PASS credit: invalid national code rejected client-side
   note [credit] 404 GET http://localhost:3000/api/v1/credit/account
PASS credit: approval → account view replaces form
PASS credit account ACTIVE with limit 1,000,000 T — ACTIVE 10000000.00
PASS credit page: limit bar (available/used/reserved)
PASS checkout: installment plans listed — 3
PASS credit checkout: result page success (no IPG) — orderNumber=SHP-100000036&outcome=PAID&paymentId=7d585cba-ee3e-4e90-882d-8dec9831831c&pare
PASS credit: used amount = order payable — used 3500000.00 avail 6500000.00
PASS credit: 3 installments scheduled — 3
PASS credit: installments sum = used (0% plan) — 3500000.00 vs 3500000.00
PASS checkout: full credit disabled when payable > available
PASS hybrid: split (credit + cash) shown
PASS hybrid: cash part paid via IPG → success — orderNumber=SHP-100000037&outcome=PAID&paymentId=a7e40894-5539-4ed3-a3a1-f314a8476aa4&pare
PASS hybrid: all remaining credit consumed — 0.00
PASS hybrid order: paymentMethod HYBRID, PAID — HYBRID PAID
PASS installment calendar lists payable installments — 6
PASS installment payment: result success — orderNumber=SHP-100000037&outcome=PAID&paymentId=5d94e11e-bb6d-4aaf-af32-8695f799c16e&parentOrderId=
PASS installment result links back to credit page
PASS installment marked PAID — {'f43454eb-e780-4e87-bc69-a21c8af202d6': 'PAID', '63075b31-3861-420f-a7cc-2e7c74dabac8': 'PENDING', '1719a4a2-23f8-4cb1-8d24-c98c0b62654e': 'PENDING', 'e0bc286e-b882-4f8a-bbc2-efc7c23ad39f': 'PENDING', 'd1454ba1-21cd-431e-afde-ea7864f5ed06': 'PENDING', '095616f8-5116-4471-94b4-ac2f9ba20199': 'PENDING'}
PASS credit: repayment restores available credit — 2166666.00
PASS credit order package accepted by vendor — PROCESSING
PASS dispute on credit order OPEN — 1
PASS credit order: BUYER_FAVOR disabled for staff
PASS credit order: definitive CREDIT_ORDER_REFUND_UNSUPPORTED notice
PASS no browser errors / 5xx
=== 27/27 checks passed ===
```

### Stage 5 — session expiry and logout

```text
PASS login: access + refresh cookies set (httpOnly)
PASS A: expired access token → page still served (no /login) — http://localhost:3000/customer/orders
PASS A: page renders for the user
PASS A: tokens rotated
PASS B: session cookies cleared
PASS B: header shows sign-in again
PASS B: refresh token revoked server-side despite expired access token — 401
PASS C: revoked session → redirected to /login — http://localhost:3000/login?next=%2Fcustomer%2Forders
PASS C: revoked session cookies cleared
PASS D: old (rotated) refresh token rejected
PASS E: invalid access cookie → /login — http://localhost:3000/login?next=%2Fcustomer%2Forders
PASS no browser errors / 5xx
=== 12/12 checks passed ===
```

`note` lines are informational: expected 404s (`credit/account` before a credit account exists), the intentional 400 of the below-minimum settlement attempt, and 429s from the OTP cooldown that the harness then waits out. They are not failures; the final check of every stage asserts that no browser console error or 5xx occurred.

## 5. Known limitations and risks (not failures)

- **Sandbox providers only.** SMS, IPG and bank credit are sandboxes. Production needs real Zarinpal/Kavenegar/bank credentials and a provider switch through env/config, which is already supported.
- **Preview host vs. callback origin.** The sandbox bank page and the IPG callback are built from `PUBLIC_API_ORIGIN`. When the storefront is opened through a proxy host that differs from that origin (e.g. the e2b preview URL), the return from the sandbox bank can land on the wrong host. A dev-only relative callback was proposed and **not implemented**; it awaits TM approval. The flows were verified on `localhost`.
- **Seed product images** point at `cdn.shopino.local`, which does not resolve. The cards fall back to the placeholder tile. Products created through the vendor panel use real uploaded images.
- **Admin unblock does not republish** (backend rule): the vendor must republish. This is surfaced in the UI and verified in stage 3.
- **Credit-funded packages cannot be refunded to the buyer** (backend 409 `CREDIT_ORDER_REFUND_UNSUPPORTED`, Phase-8 limitation). BUYER_FAVOR is disabled for them in the dossier.
- **Visual regression / accessibility audits** (axe, Lighthouse) and cross-browser runs (Firefox/WebKit, mobile viewports) were not part of this phase's automated checks. RTL layout was reviewed via the screenshots only.
