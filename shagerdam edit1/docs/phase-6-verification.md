# Shopino — Phase 6 verification report

**Scope:** address book, guest/account cart, checkout with multi-vendor split, stock
reservation, per-store shipping, order lifecycle (customer, vendor, staff, payment outcome,
expiry).
**Environment:** sandbox · Node 22 · PostgreSQL 16 and Redis 7.4 in Docker (real services,
nothing stubbed) · `SMS_PROVIDER=sandbox` · `STORAGE_PROVIDER=local` (Phase-3/4 dev providers).
**Date:** 2026-09-27.

---

## 1. Acceptance criteria (TM brief)

| Criterion | Evidence (e2e test names in *italics*) | Result |
| --- | --- | --- |
| Cart: add, update, delete | *creates a guest cart on first add…*, *adds to the same line…*, *deletes a line; another guest cannot see or touch it* | ✅ |
| Cart respects stock | *adds to the same line, enforces the stock limit and reports what is available* (409 `INSUFFICIENT_STOCK`, `availableQuantity: 5`; PATCH 6 → 409, 5 → 200) | ✅ |
| Only active/published/unblocked products | *refuses unpublished products, unknown variants and bad input* (409 `PRODUCT_UNPUBLISHED`, 404, 400) | ✅ |
| Guest cart merged on login | *merges the guest cart into the account cart on login, clamped to stock* (2 + 5 → 5, B1 kept, guest cart deleted, 2nd merge no-op, 401 without login, 400 without token) | ✅ |
| Cart grouped by store with subtotal, availability, price warnings | *groups by store with per-store shipping…*, *flags availability problems in the cart view*, *reports changed prices…* (`hasPriceChanges`) | ✅ |
| 2-vendor checkout → 1 parent + 2 sub-orders | *creates 1 parent order and 2 store packages…* (`SHP-\d{9,}`, `-1`/`-2`, both PENDING_APPROVAL, payment PENDING) | ✅ |
| `Σ(sub.itemsSubtotal + sub.shippingFee) == parent.finalPayableAmount` | same test, asserted on the stored rows (5,300,000 + 450,000 = 5,750,000) and by a DB CHECK (*database guarantees*) | ✅ |
| `commission + earnings == itemsSubtotal` | same test on stored rows (A: 210,000 + 2,590,000; B: 250,000 + 2,250,000) and DB CHECK | ✅ |
| Commission: store override, else category rate | A = 7.50 % (store override), B = 10.00 % (category) in item snapshots | ✅ |
| Shipping: TM rule | A 2,800,000 < platform threshold 3,000,000 → platform fee 450,000; B ≥ store threshold 2,000,000 → 0 | ✅ |
| Immutable item snapshots | *keeps item snapshots immutable when the catalogue changes afterwards* (title + price changed after checkout; order unchanged) | ✅ |
| Checkout re-prices and informs the customer | *reports changed prices, refreshes the cart, and succeeds on the next attempt* (409 `CART_PRICES_CHANGED` with old/new; no order created; next attempt 201 at the new price) | ✅ |
| Everything in one transaction, stock reserved at checkout | reserved +2/+1/+1 asserted; *lets exactly one of two concurrent checkouts take the last units* (201 + 409, reserved = stock, never above); *does not create two orders from one cart submitted twice at once* | ✅ |
| Cancel releases stock | *cancels an unpaid order, releases the stock and refuses a second cancel*; *releases the reservation when payment fails*; *cancels orders whose payment window passed…* | ✅ |
| Paid → `stock −= q, reserved −= q` | *commits the reservation when payment is confirmed* (and idempotent) | ✅ |
| Vendor A cannot see/update vendor B's package | *forbids vendor A from reading or updating vendor B's package* (GET 404, PATCH 404, DB unchanged; customer/admin on vendor route 403) | ✅ |
| Vendor ships with tracking code | *enforces the state machine and ships with a tracking code* (skip → 409 with `allowedTransitions`; SHIPPED without tracking → 400; with → 200; history + audit; customer sees tracking) | ✅ |
| Vendor cancel restocks | *restocks when a vendor cancels a paid package that has not shipped* (`stockAction: RESTOCKED`) | ✅ |
| Staff global list; force DELIVERED/REFUNDED | *lets staff search globally; support may read but not force*; *forces DELIVERED and REFUNDED…*; *restocks a paid package refunded by staff before shipping* | ✅ |
| Full Swagger | *documents every Phase-6 route with its tag* (19 operations, ≥ 2 responses each, 6 tags); served `/api/docs-json` lists all 16 Phase-6 paths (§4) | ✅ |

## 2. Quality gates

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | ✅ 2/2 tasks, 0 errors, 0 warnings |
| Type check | `pnpm typecheck` | ✅ 2/2 tasks |
| Unit tests | `pnpm --filter @shopino/backend test` | ✅ **252 / 252** (21 suites; +17 this phase: order-math 5, state machine 5, shipping 6, env 1) |
| E2E tests (live PG + Redis) | `pnpm --filter @shopino/backend test:e2e` | ✅ **192 / 192** (7 suites; orders 32 new) |
| Build | `pnpm build` | ✅ backend (`nest build`) + frontend (`next build`) |
| HTTP smoke on built server | `node dist/main.js` + `pnpm verify:http` | ✅ 4/4 (health 200 with DB/Redis up, docs-json, docs UI, 404) |
| Migrations | `prisma migrate status` | ✅ 7 migrations, database schema up to date |
| Drift | `prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --exit-code` | ✅ exit 0 |
| Cleanup | SQL after the suite | ✅ 0 test users, 0 orders, 0 carts, 0 `shipping.*` configs, Σ reserved = 0, 0 test categories |

### 2.1 The intermittent health 503 — root cause found and fixed in the test harness

Phases 4–5 recorded a rare `GET /health` 503 in the full e2e run. With `--logHeapUsage` it was
reproduced and measured directly this phase: all suites shared one `--runInBand` process and
the heap grew suite after suite (405 → 464 → … → **518 MB** at the health suite, 536 MB at the
end). The health controller reports `memory: down` above 512 MiB (Phase-1 production
threshold), hence the 503.

Fix (test configuration only; no production code or threshold changed):
`test/jest-e2e.json` → `"maxWorkers": 1, "workerIdleMemoryLimit": "350MB"`, and the
`test:e2e` script no longer passes `--runInBand`. Suites still run strictly one at a time (the
database is shared), but the worker is recycled when its heap exceeds 350 MB after a suite.
Measured heap per suite afterwards: 312–405 MB. Result: 4 consecutive full runs 192/192
(before the fix, in the same session: one of two runs failed on health at 518 MB).

## 3. Orders e2e suite (32 tests, live stack)

Stores are onboarded through the real flow (OTP → register → KYC upload → admin approval,
store A with a 7.5 % commission override); products through `POST /vendor/products`; orders
through `POST /orders/checkout`. The shipping policy is set with real `system_configs` rows and
restored afterwards. Store B's `freeShippingThreshold` is set directly in the DB (no endpoint
for store shipping settings in Phase 6). Payment confirmation/failure call the real
`OrderLifecycleService` methods, since no payment endpoint exists yet.

```
Phase 6 — cart, checkout, multi-vendor orders and lifecycle (live stack)
    customer address book
      ✓ creates addresses; the first becomes the default and mobile/postal code are normalised (38 ms)
      ✓ updates and deletes; the default moves when the default is deleted (24 ms)
      ✓ validates input and isolates customers (19 ms)
    cart
      ✓ creates a guest cart on first add and returns its token exactly once (60 ms)
      ✓ adds to the same line, enforces the stock limit and reports what is available (41 ms)
      ✓ refuses unpublished products, unknown variants and bad input (17 ms)
      ✓ deletes a line; another guest cannot see or touch it (42 ms)
      ✓ merges the guest cart into the account cart on login, clamped to stock (52 ms)
      ✓ groups by store with per-store shipping from the platform policy and store overrides (42 ms)
      ✓ flags availability problems in the cart view (61 ms)
    checkout
      ✓ refuses foreign addresses and empty carts (8 ms)
      ✓ reports changed prices, refreshes the cart, and succeeds on the next attempt (34 ms)
      ✓ creates 1 parent order and 2 store packages with correct money, snapshots and reservations (53 ms)
      ✓ keeps item snapshots immutable when the catalogue changes afterwards (40 ms)
      ✓ lets exactly one of two concurrent checkouts take the last units (105 ms)
      ✓ does not create two orders from one cart submitted twice at once (59 ms)
      customer orders
        ✓ lists own orders with the package breakdown; others get 404 (17 ms)
        ✓ shows the order detail with address, packages and timeline (4 ms)
        ✓ cancels an unpaid order, releases the stock and refuses a second cancel (58 ms)
      after payment
        ✓ hides unpaid orders from vendors (20 ms)
        ✓ commits the reservation when payment is confirmed (stock and reserved both drop) (25 ms)
        ✓ shows each vendor only its own package, with address, commission and allowed transitions (23 ms)
        ✓ forbids vendor A from reading or updating vendor B’s package (12 ms)
        ✓ enforces the state machine and ships with a tracking code (101 ms)
        ✓ restocks when a vendor cancels a paid package that has not shipped (24 ms)
        ✓ lets staff search globally; support may read but not force (28 ms)
        ✓ forces DELIVERED and REFUNDED with history and audit; unpaid orders are refused (40 ms)
        ✓ restocks a paid package refunded by staff before shipping (61 ms)
      unpaid orders that never complete
        ✓ releases the reservation when payment fails (51 ms)
        ✓ cancels orders whose payment window passed and releases their stock (54 ms)
    database guarantees
      ✓ rejects SHIPPED without a tracking code and broken money identities (327 ms)
    Swagger
      ✓ documents every Phase-6 route with its tag (79 ms)

```

## 4. Served OpenAPI (built server)

`GET /api/docs-json` on `node dist/main.js` lists: `/customer/addresses`,
`/customer/addresses/{id}`, `/cart`, `/cart/items`, `/cart/items/{id}`, `/cart/clear`,
`/cart/merge`, `/orders/checkout`, `/customer/orders`, `/customer/orders/{id}`,
`/customer/orders/{id}/cancel`, `/vendor/orders`, `/vendor/orders/{id}`,
`/vendor/orders/{id}/status`, `/admin/orders`, `/admin/sub-orders/{id}/force-status`.
Live responses checked by hand: `GET /cart` without token → 200 (`owner: none`);
`POST /orders/checkout` without token → 401; malformed `X-Cart-Token` → 400 `INVALID_CART_TOKEN`.

## 5. Known limitations (not failures)

- No payment endpoint; `markPaid`/`markPaymentFailed` are service-level only.
- No refund money movement or wallet entries (finance phase).
- No discounts (`totalDiscountAmount` = 0); `CASH_IPG` only.
- No API for store shipping settings; no guest-cart cleanup job; no rate limiting.
- Expected `prisma:error` lines in the e2e log come from negative tests (constraint violations
  that the tests provoke on purpose).
