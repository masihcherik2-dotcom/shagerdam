# Branding (dynamic visual identity) — deliverable & verification

Backend: `apps/backend/src/modules/branding/` (`BrandingModule`) + `MediaService.uploadBrandingImage` (`modules/media/branding-image.ts`).
Frontend: `/admin/branding`, `components/layout/brand-logo.tsx`, `components/home/hero-carousel.tsx`, `lib/api/branding.server.ts`, `app/layout.tsx` (favicon).

## 1. Storage

`system_configs` (no new table):

| key | valueType | value |
|---|---|---|
| `branding.logo_url` | STRING | media URL or `''` (= default monogram) |
| `branding.mobile_logo_url` | STRING | media URL or `''` |
| `branding.favicon_url` | STRING | media URL or `''` |
| `branding.hero_banners` | JSON | `[{id,imageUrl,title,linkUrl,sortOrder,isActive}]` |

Cleared values are stored as `''` so each key keeps its "last changed" timestamp. Missing/empty/corrupt values degrade to defaults — the public endpoint never fails because of branding data.

Migration `20261003090000_media_purpose_url_index`: index `media_assets(purpose, url)` for the PATCH asset check (only schema change).

## 2. API

| Endpoint | Roles | Notes |
|---|---|---|
| `GET /api/v1/branding` | public | `{logoUrl,mobileLogoUrl,faviconUrl,heroBanners:[{id,imageUrl,title,linkUrl,sortOrder}]}` — active banners only, ordered. Redis `branding:public:v1` (TTL 600 s safety net), `Cache-Control: no-cache`. |
| `GET /api/v1/admin/branding` | SUPER_ADMIN, ADMIN | full config incl. inactive banners, `updatedAt` per key, last 20 changes (`history` from AuditLog: actor, time, changed fields). |
| `PATCH /api/v1/admin/branding` | SUPER_ADMIN, ADMIN | partial: omitted = unchanged, `null` = clear logo, `heroBanners` = full replacement (≤10; ids kept or generated; order renumbered 1..n). Every URL must be a public image uploaded through the branding endpoint **for the matching slot** (`BRANDING_ASSET_INVALID`); banner links: site path `/…` (not `//`) or `https://` (`BRANDING_INVALID_LINK`). Changed keys + AuditLog (old/new values) in one transaction, then cache purge (immediately and again after 2 s). No-op → no write, no audit. |
| `POST /api/v1/admin/branding/assets` | SUPER_ADMIN, ADMIN | multipart `slot` (logo \| mobile_logo \| favicon \| hero_banner) then `file`. Audited as MediaAsset. |

Upload pipeline (same stages as all media: size → type → Sharp decode → WebP re-encode → store → record):

| slot | output | thumbnail | min source | SVG |
|---|---|---|---|---|
| logo | inside 800×240, lossless WebP | 320×96 | 64×16 | yes |
| mobile_logo | inside 512×512, lossless | 192×192 | 48×48 | yes |
| favicon | contain 512×512 transparent, lossless | 64×64 | 32×32 | yes |
| hero_banner | inside 1920×1080, q82 | 480×270 | 800×200 | no |

**SVG decision:** accepted for the three logo slots only, ≤512 KB, refused if it declares XML entities or references external resources/stylesheets, then **rasterised by Sharp to WebP** (density 288). SVG is never stored or served as SVG (an SVG served from our origin is an active document). Error codes: `BRANDING_INVALID_SLOT`, `BRANDING_SVG_NOT_ALLOWED`, `BRANDING_SVG_REJECTED`, `BRANDING_IMAGE_TOO_SMALL`; all translated in the Persian UI.

## 3. Frontend
* **Header/footer:** `BrandLogo` shows `logoUrl` (desktop) and `mobileLogoUrl` → `logoUrl` (below `sm`); no logo **or an image that fails to load (also before hydration)** → «ش» monogram + name. Never a broken image.
* **Favicon:** root `generateMetadata` emits `icon`/`shortcut` = `faviconUrl`, `apple-touch-icon` = mobile logo → favicon; nothing emitted when unset.
* **Home hero:** carousel of active banners (autoplay 6 s; pauses on hover/focus/hidden tab/reduced-motion; prev/next, dots, ←/→; site links in-app, https in new tab; broken banner dropped). No active banners → the original hero.
* One branding fetch per request (React `cache`), any failure → defaults.
* **`/admin/branding` «مدیریت هویت بصری و بنرها»** (nav «هویت بصری و بنرها», route guard SUPER_ADMIN/ADMIN): upload + preview for logo, mobile logo, favicon (last-changed time, remove), «حذف لوگو و بازگشت به لوگوی پیش‌فرض» with confirmation, banner manager (drag-and-drop and up/down ordering, «افزودن بنر جدید» modal with upload/title/link/active, per-banner active toggle and delete, inline link validation, unsaved-changes notice, save/cancel), change history.

## 4. Verification (live PostgreSQL + Redis + local storage provider)

| Check | Result |
|---|---|
| Unit: `branding-rules.spec`, `branding-image.spec` | pass (backend unit **585/585**) |
| Frontend vitest (incl. `branding.test`, access rules) | **81/81** |
| E2E `test/branding.e2e-spec.ts` | **21/21** |
| Full E2E, fresh migrated + seeded DB | **356/356** |
| Browser `tmpdoc/tm-torob-branding-browser.py` | **55/55** |
| Lint + type check (backend, frontend) | clean |
| `pnpm build` | OK |

E2E: public endpoint returns nulls/[] when unset and configured values after update; Redis entry is created, purged by PATCH, and the public endpoint reflects the change; a DB write bypassing the API is not seen until an admin change purges the cache; 401 without token and 403 for a customer on all three admin routes; PNG→WebP 800×200 served publicly; SVG rasterised to 640×192 WebP; favicon 512×512 with alpha + 64×64 thumbnail; banner capped at 1920; SVG banner / entity SVG / external-ref SVG / small banner / non-image / wrong slot rejected; wrong-slot and external URLs rejected; link/ID/count/unknown-field validation with nothing written; AuditLog old/new values; per-key timestamps + history; no-op PATCH writes no audit; banner ordering, id preservation, inactive hidden; clearing logo; corrupt stored JSON degrades to defaults; OpenAPI tags. The suite snapshots and restores the platform's existing branding rows and deletes its assets/files/audits.

Browser (real upload through the UI): defaults (monogram, no favicon link, default hero) → admin uploads PNG logo, SVG mobile logo, favicon; three banners (one inactive), invalid link blocked, reorder, save; too-small banner shows the Persian error; 4 AuditLog rows and history → storefront header/footer logo loads, favicon link served as `image/webp`, apple-touch-icon = mobile logo, carousel shows exactly the 2 active banners in order, next button and banner link work, mobile viewport uses the mobile logo; a logo URL that 404s falls back to the monogram; «حذف لوگو…» → monogram again, favicon kept; vendor is redirected away from `/admin/branding`; no console errors or 5xx.

## 5. Known limits
* Replaced/removed branding images stay in storage (MediaAsset rows are kept for audit; no garbage collection of unused branding assets).
* The monogram fallback applies to the storefront header/footer; dashboard panels keep their existing text header.
* No image cropping tool: admins upload the final image; recommended banner size 1920×640 (3:1, cropped to 2:1 on mobile).
