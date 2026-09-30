# Smart Product Spec Importer + «شاگردم» rebrand — verification report

Base commit: `0765a1e` (Phase 11). Everything below was run in the development
sandbox against **real PostgreSQL 16 and Redis 7 containers** (`shopino_postgres`,
`shopino_redis`). The full suite used a freshly created database
(`shopino_e2e_tm`: `prisma migrate deploy` + seed), because the long-lived dev DB
is polluted by earlier manual runs (a known issue, see Phase 10).

## 1. Results

| Check | Command | Result |
| --- | --- | --- |
| Lint + typecheck (backend + frontend) | `pnpm exec turbo run lint typecheck --concurrency=1` | 4/4 tasks OK, 0 errors |
| Backend unit | `cd apps/backend && pnpm exec jest` | **522/522** (37 suites; importer alone 179) |
| Backend E2E (all suites) | `cd apps/backend && pnpm test:e2e` | **305/305** (11 suites, 80.9 s), incl. `importer.e2e-spec.ts` 31/31 |
| Frontend unit (vitest) | `cd apps/frontend && pnpm exec vitest run` | **68/68** (10 files; +8 in `product-specs.test.ts`) |
| Build | `pnpm exec turbo run build --concurrency=1 --force` | backend + frontend OK |
| nginx | image built, container booted, `nginx -t` | healthy, syntax OK, import location rendered |
| Live browser check (Playwright/Chromium) | `tmpdoc/tm-import-browser.py` (not shipped) | **22/22** |

## 2. Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| Unit tests for `DigikalaExtractor` and `GenericSchemaOrgExtractor` | `extractors/digikala.extractor.spec.ts`, `extractors/generic-schema.extractor.spec.ts` (fixtures: two Digikala API payloads, WooCommerce, Shopify, microdata) |
| SSRF rejects `http://127.0.0.1:4000` and `http://192.168.1.1` | unit (`net/address-policy.spec.ts`, `net/import-url.spec.ts`) and E2E (11 blocked targets, including those two, DNS rebinding and a redirect to 169.254.169.254) |
| E2E extract from a valid payload | E2E: Digikala API payload served from a local fixture server (only the test overrides the network policy); generic WooCommerce page |
| Ingest creates WebP assets in storage | E2E: the files exist in local storage, `image/webp`, with thumbnails; per-image failures are reported |
| Creating the product with the extracted data persists in PostgreSQL | E2E, and the browser check: product `e26f89b5-…` → `products` row with brand, 2 `product_media` (WebP `media_assets`), a `product_specifications` row updated from the edit page |
| `pnpm build` passes | see §1 |

## 3. Live browser run (real public page, no mocks)

Source page: `https://www.allbirds.com/products/mens-tree-runners` (Shopify).

- Home `<title>` = «شاگردم | پلتفرم هوشمند خرید و فروش اقساطی»; header/footer show the new brand; no «شاپینو» in the rendered HTML.
- Vendor (seeded, approved) → `/vendor/products/new`: the import panel is at the top.
- `ftp://…` is rejected client-side. `http://127.0.0.1:4000/…` is rejected by the API with the Persian `IMPORT_BLOCKED_TARGET` message.
- Fetch: the pending label is shown; the preview opens in 0.9 s. It shows source «سایت فروشگاهی», strategies JSON-LD + OpenGraph, title, brand, a category warning, and a list of 2 images (no remote `<img>`, per the CSP).
- «اعمال در فرم»: title, brand and description are filled; 2 images are ingested and shown from our storage; notes appear in the panel.
- The vendor adds category, price, 1 spec row and 1 variant → saved → redirected to the edit page.
- DB check done; the spec is edited and saved on the edit page (DB check done); no console errors, no 5xx.

Screenshots (not shipped): `tmpdoc/tm-shots/01-home.png … 04-edit.png`.

## 4. Not verified / limits

- **Digikala live**: the sandbox is geoblocked by Digikala (API and CDN). The parser is tested against real API payloads captured with a page fetcher (`dkp-13196935` verbatim; `dkp-18010600` a partly reconstructed subset). It must be re-checked from a server inside Iran.
- The storefront spec table (`components/catalog/product-specifications.tsx`) is covered by typecheck, build and `groupSpecifications` unit tests. It was not browser-checked, because the new product awaits admin moderation.
- The nginx import location (150 s timeouts, `burst=10`) was validated with `nginx -t`, not under load.
