# Shopino — Phase 5 verification report

**Scope:** categories, product catalogue with variant matrix, vendor product management,
staff moderation, inventory primitives, public discovery API.
**Environment:** sandbox · Node 22 · PostgreSQL 16 and Redis 7.4 in Docker (real
services, no fakes) · `STORAGE_PROVIDER=local` · `SMS_PROVIDER=sandbox`.
**Date:** 2026-09-27.

---

## 1. Acceptance criteria

| Criterion (TM brief) | Evidence | Result |
| --- | --- | --- |
| Category tree built recursively; root and deep nested nodes | unit `category-tree.spec.ts` (14); e2e *builds the nested tree recursively: root, deep nested node, correct depths*, *returns a category with its ancestor breadcrumb and direct children* | ✅ |
| Cycle prevention on `parentId` change | e2e *refuses to create cycles* (self-parent and under-descendant → 400, row unchanged), *allows a legitimate move and moving it back*; unit `wouldCreateCycle` | ✅ |
| Non-vendors and pending vendors cannot create products | e2e *blocks anonymous callers, customers, stores under review and staff* (401/403/403/403) | ✅ |
| SKU globally unique | e2e *enforces globally unique SKUs — across stores, case-insensitively, and within one request* (409 / 400, nothing written); e2e duplicate SKU on add-variant → 409 | ✅ |
| Pricing rule rejected when violated | e2e *rejects pricing violations* (compareAt = price, compareAt < price, price 0, stock −1 → 400); PATCH price above stored compareAt → 400; DB CHECK rejects direct writes | ✅ |
| Owning vendor updates stock and price; other vendor gets 403/404 | e2e *lets the owner change price and stock, audited*; *gives another store 404 for every write* (variant PATCH, product PATCH, add variant, DELETE → 404; DB untouched) | ✅ |
| Stock decrements atomic | e2e *never oversells under concurrent reservations* (12 × reserve(1) on stock 5 → exactly 5 succeed); *serialises concurrent relative decrements from the API* (4 × −1 on stock 2 → exactly 2 × 200, 2 × 409, final 0); *is backed by CHECK constraints* | ✅ |
| Keyword search finds matching products | e2e *finds products by keyword in title, brand and description, tolerant of Arabic letters*; *treats LIKE wildcards literally* | ✅ |
| Category filter includes descendants | e2e *includes every descendant when filtering by category* (root → 4, child → 3, leaf → 2, sibling → 1, unknown → 0) | ✅ |
| Price and in-stock filters return accurate subsets | e2e *returns the exact subset for price ranges (variant level)*, *… for inStockOnly*, *matches colour, size, price and stock on the same variant* | ✅ |
| Detail by slug returns all variants and media | e2e *returns the product page with breadcrumbs, store, full gallery and every active variant*; *shows live stock*; drafts → 404 | ✅ |
| Sorts incl. popular by units sold | e2e *sorts by newest, price ascending and price descending*; *sorts by units actually sold, ignoring cancelled orders, with newest as the tie-breaker* (real order rows) | ✅ |
| Moderation endpoint, audited; vendor cannot publish while blocked | e2e staff-moderation block (6 tests): SUPPORT 403, reason required, block → unpublished + hidden + audit STATUS_CHANGE, vendor publish → 403, staff publish → 409, unblock does not republish | ✅ |
| Full Swagger on every new endpoint | e2e *documents every Phase-5 endpoint, secured where it must be* (16 operations: tags, responses, bearer security on non-public routes, none on public) | ✅ |

## 2. Quality gates

| Gate | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | ✅ 2/2 tasks, 0 errors, 0 warnings |
| Type check | `pnpm typecheck` | ✅ 2/2 tasks |
| Unit tests | `pnpm --filter @shopino/backend test` | ✅ **235 / 235** (18 suites; +30 new: tree 14, rules 16) |
| E2E tests (live PG + Redis) | `pnpm --filter @shopino/backend test:e2e` | ✅ **160 / 160** (6 suites; catalog 56 new) — see §2.1 |
| Build | `pnpm build` | ✅ backend (`nest build`) + frontend (`next build`) |
| Migrations | `prisma migrate status` | ✅ 6 migrations, database schema up to date |
| Drift | `prisma migrate diff --from-schema-datasource … --to-schema-datamodel … --exit-code` | ✅ exit 0 (no drift) |

### 2.1 Repeated runs and the intermittent health check

The complete e2e set was run 14 times during verification. 12 runs: 160/160. 2 runs:
159/160, the single failure being `health.e2e-spec.ts` → `GET /health` returned **503**;
the catalog suite passed in every run, and `health.e2e-spec.ts` alone passes every time.

Measurement: at the moment the health test executes (5th suite in the same
`--runInBand` Jest process), `process.memoryUsage().heapUsed` was 345–389 MiB. The health
controller reports `memory: down` above a 512 MiB heap (`HEAP_LIMIT_BYTES`, Phase 1). Heap
accumulated from the four preceding suites plus GC timing can momentarily exceed that
threshold. This matches the "one-off 503" already seen in Phase 4 and is a property of
the test harness (all suites share one process), not of the running service; a live
server started with `node dist/main.js` answers `/health` with 200. No production
threshold or test configuration was changed — see §7 for the proposed fix.

## 3. What the catalog e2e suite covers (56 tests)

Vendors are created by the real flow: OTP login → `POST /vendors/register` → KYC
document upload + `POST /vendors/verification/documents` → staff
`POST /admin/vendors/:id/verify`. Product images are real multipart uploads through the
Sharp pipeline. Sales for the popular sort are real `parent_orders` / `sub_orders` /
`order_items` rows. `afterAll` removes every row, file, audit entry and Redis key it
created (verified: 0 users `+98997113…`, 0 `e2e-cat-*` categories, product/variant/
order/vendor/asset counts back to seed values).

| Block | Tests |
| --- | --- |
| Admin category management | 7 |
| Public category tree and page | 3 |
| Vendor product creation | 8 |
| Vendor listing and detail | 2 |
| Variant and product updates | 7 |
| Inventory integrity | 5 |
| Public discovery | 16 |
| Staff moderation | 6 |
| Archive | 1 |
| OpenAPI | 1 |

## 4. Live HTTP check (built server, `node dist/main.js`, port 4000, seeded data)

| Request | Observed |
| --- | --- |
| Route table | 16 Phase-5 routes mapped |
| `GET /categories/tree` | `totalCategories 19`, `totalProducts 3`; `digital` 2 (mobile 1, laptop 1), `fashion` 1 |
| `GET /categories/mobile` | breadcrumbs `[digital, mobile]` |
| `GET /products?sortBy=price_asc` | 3 items: t-shirt (890 000–920 000) → smartphone → laptop |
| `GET /products?search=گوشي` (Arabic ي) | smartphone found |
| `GET /products?categorySlug=digital` | 2 (descendants included) |
| `GET /products?colors=سفید&sizes=xl` | t-shirt |
| `GET /products/shopino-sample-smartphone-x1` | breadcrumbs `[digital, mobile]`, variants BLK 12 avail / 5 %, BLU 7 avail / 4 % |
| `GET /vendor/products`, `GET /admin/categories` without token | 401, 401 |
| `GET /products/nope` · `GET /products?minPrice=10&maxPrice=5` | 404 · 400 |

Search plan (`SET enable_seqscan=off` to show eligibility on the 3-row dev table):
`Bitmap Heap Scan → BitmapOr → products_title_trgm_idx, products_brand_trgm_idx,
products_description_trgm_idx`.

Live constraints: `categories_commission_rate_check`, `product_variants_inventory_check`,
`product_variants_price_check`, `product_variants_weight_check`,
`products_base_price_check`, `products_block_consistency_check`.

## 5. Security properties verified

- Role guard + store-status check on every vendor route; cross-store access → 404 (no
  existence oracle); staff roles cannot use vendor routes.
- Moderation restricted to SUPER_ADMIN/ADMIN; SUPPORT read-only.
- All SQL is parameterised (`Prisma.sql`); user search input is LIKE-escaped (a bare `%`
  matches nothing).
- Input validation with whitelist + `forbidNonWhitelisted` (global pipe); UUID params
  parsed; hex colours, SKU pattern, lengths and numeric ranges validated.
- Gallery accepts only public images the caller owns with purpose `product_image`; KYC
  documents and other users' assets are rejected.
- Every write audited in the same transaction (actor, IP, user agent, old/new values).

## 6. Environment / provider status

| Concern | Active provider | Production-ready? |
| --- | --- | --- |
| Database | PostgreSQL 16 (Docker) | Real engine; production instance to be provisioned |
| Cache | Redis 7.4 (Docker) | Real engine; tree cache degrades to PostgreSQL if Redis fails |
| Storage | `local` (Phase 4) | Development only; `s3` provider exists, needs credentials |
| SMS | `sandbox` (Phase 3) | Development only |

## 7. Remaining issues / risks

1. **Intermittent health 503 in the full e2e run** (§2.1). Proposed fix for TM approval:
   run the e2e suites in isolated workers (`--maxWorkers=1` + `workerIdleMemoryLimit`)
   or make the heap threshold configurable via env; neither was applied unilaterally.
2. **No rate limiting on public catalogue endpoints** (`GET products`, `products/:slug`,
   `categories/*`). Search is indexed, but an abusive client is not throttled. Needs an
   architectural decision (global throttler vs. gateway).
3. **Variant display order** is `createdAt`, then SKU; variants created together share a
   timestamp, so they are ordered by SKU, not by the vendor's input order. A `sortOrder`
   column on variants would need a schema decision.
4. **Seeded product images** point to `cdn.shopino.local` URLs that do not resolve and
   have no `mediaAssetId`; real products created through the API use real assets.
5. **Popular sort** returns newest order on seed data because no orders exist yet; the
   sold-units path is proven by e2e with real order rows.
6. **Reservations are not yet used by any flow**: `reserve/release/commitReservation`
   are ready and tested, but no expiry of abandoned reservations exists until the
   checkout phase defines it.
7. Offset pagination: deep pages cost more on very large catalogues (keyset pagination
   would be a later optimisation).
8. Carried over from Phase 4: see `docs/phase-4-verification.md` §7.
