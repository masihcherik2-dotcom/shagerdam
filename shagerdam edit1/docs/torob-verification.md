# Torob integration — deliverable & verification

Module: `apps/backend/src/modules/integrations/torob/` (`TorobIntegrationModule`), Swagger tag `integrations-torob`.

## 1. What it does

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/v1/integrations/torob/products` | public | Paged feed. No `vendorSlug` → marketplace feed (every APPROVED store). `vendorSlug=<storeSlug>` → that store only (404 `TOROB_VENDOR_NOT_FOUND` when unknown **or** not APPROVED — indistinguishable on purpose). `page` (≥1, default 1), `pageSize`/`limit` (1–500, default 100). Response `{count,page,totalPages,products}`. `Cache-Control: public, max-age=60`. |
| `GET /api/v1/integrations/torob/product-details` | public | Real-time price/availability of one offer: exactly one of `page_unique` (SKU, case-insensitive) or `page_url` (a URL the feed published; without `?variant` it resolves to the variant the page pre-selects). Never cached (`no-store`). Errors: `TOROB_LOOKUP_REQUIRED` 400, `TOROB_INVALID_PAGE_URL` 400, `TOROB_PRODUCT_NOT_FOUND` 404. |

One item per **active variant** of a product that is published, not blocked by staff, in a visible category, of an APPROVED store:

| Field | Source |
|---|---|
| `page_unique` | variant SKU |
| `title` | product title + `، رنگ …` / `، سایز …` |
| `price` / `old_price` | variant price; `old_price` only when `compareAtPrice > price`, else `null` |
| `availability` | `instock` when `stockQuantity − reservedQuantity > 0` and the product is listable, else `outofstock` (unlisted products looked up by details → `outofstock`, not 404) |
| `page_url` | `<PUBLIC_WEB_ORIGIN or PUBLIC_API_ORIGIN>/products/<slug>?variant=<SKU>` — the product page pre-selects that variant (`variant-panel.tsx`) |
| `image_links` | absolute URLs of the product media (primary first) |
| `category_name` | breadcrumb `A > B` from the live category tree |
| `spec` | product specifications + برند / رنگ / سایز / گارانتی |
| `guarantee` | variant guarantee |
| `delivery_fee` | one-unit checkout shipping quote for the store (override / free-shipping threshold / platform policy) |

Amounts are in **IRR** by default (`TOROB_PRICE_UNIT=IRR`); `IRT` divides by 10.

### Performance & freshness
* Keyset-friendly ordered query on indexed columns; `pageSize` ≤ 500.
* Rendered pages cached in Redis for `TOROB_FEED_CACHE_TTL_SECONDS` (default 300, 0 = off) under `torob:feed:v1:g<generation>:…`.
* O(1) invalidation: price/stock/publish/variant writes (`inventory.service`, `products.service`), staff block/unblock and vendor approval bump `torob:feed:generation` — once immediately and once 2 s later (covers writes issued inside a still-open transaction). Redis failures never break the feed (falls back to the DB).
* `product-details` always reads PostgreSQL.

### Frontend
* Vendor dashboard card «اتصال به موتور جستجوی تُرب (Torob)»: feed link `<site origin>/api/v1/integrations/torob/products?vendorSlug=<storeSlug>`, button «کپی لینک اختصاصی برای ترب» (clipboard API with select-to-copy fallback), live item count read from the feed itself, «مشاهدهٔ فید», short Persian guide.
* Product page honours `?variant=<SKU>` (case-insensitive; unknown → default selection).

### Configuration
`TOROB_FEED_CACHE_TTL_SECONDS` (0–3600, default 300), `TOROB_PRICE_UNIT` (`IRR`|`IRT`, default `IRR`), `PUBLIC_WEB_ORIGIN` (optional; storefront origin for `page_url`, defaults to `PUBLIC_API_ORIGIN`). Documented in `.env.example` and `deploy/env/production.env.example`.

## 2. Verification (live PostgreSQL 16 + Redis 7)

| Check | Result |
|---|---|
| Unit (`torob-item.mapper.spec`, `torob-feed-cache.service.spec`) | pass — part of backend unit 585/585 |
| E2E `test/torob.e2e-spec.ts` (stores onboarded through the real API, products via vendor/admin APIs) | **30/30** |
| Full E2E on a freshly migrated + seeded DB | **356/356** (13 suites) |
| Browser (`tmpdoc/tm-torob-branding-browser.py`, Torob part) | card, link, copy→clipboard, live count, feed via site origin, `page_url` opens exact variant, details = feed item — all pass (55/55 overall) |
| `pnpm build` (turbo) | OK |

E2E coverage: marketplace feed lists every approved store; `vendorSlug=store-a` returns only store A and agrees with a SQL count; unknown and PENDING stores → 404; unpublished never listed; out-of-stock listed as `outofstock` without `old_price`; reservations count (stock − reserved); staff block removes from both feeds immediately; suspended store disappears; cache negative control (DB write bypassing the app is not seen) + invalidation through vendor price/stock APIs; details by SKU / page_url / case-insensitive / unpublished / foreign URL / wrong-product SKU; OpenAPI documents both endpoints publicly under `integrations-torob`.

Sample (seeded store):

```json
{"count":7,"page":1,"totalPages":7,"products":[{"page_unique":"SHP-TSHIRT-WHT-L","title":"تی‌شرت نخی نمونه، رنگ سفید، سایز L","price":890000,"old_price":1150000,"availability":"instock","page_url":"https://<web-origin>/products/shopino-sample-cotton-tshirt?variant=SHP-TSHIRT-WHT-L","image_links":["https://cdn.shopino.local/products/sample-cotton-tshirt/white.jpg"],"category_name":"مد و پوشاک > پوشاک مردانه","spec":{"برند":"Shagerdam Sample","رنگ":"سفید","سایز":"L"},"guarantee":null,"delivery_fee":500000}]}
```

## 3. Known limits / risks
* **Schema is the TM's GET format, not Torob's current official "Product API v3"** (POST `/torob_api/v3/products`, `X-Torob-Token` Ed25519 JWT, `current_price` in Toman, `date_added`/`date_updated`, exactly 100 items/page). v3 is not built; it is a separate endpoint on top of the same query/mapper.
* Price unit defaults to IRR per the brief; confirm with Torob (their docs imply Toman) and set `TOROB_PRICE_UNIT=IRT` if so.
* No dedicated rate limit beyond nginx's `/api/` zone + the Redis cache.
* No vendor-suspension endpoint exists in the platform, so suspension-driven invalidation is not wired (the E2E suspends via DB and bumps the generation; the cache TTL bounds staleness otherwise).
* Test-environment note: two databases sharing one Redis (dev + scratch) share cache keys (category tree, feed pages); production runs one Redis per database.
