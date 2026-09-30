# Phase 0 — Trust layer, legal pages, SEO, status sanitisation

## What exists

| Area | Where | Notes |
|---|---|---|
| Business identity + seals | `modules/site-info`, `/admin/site-info` | 12 `site.*` keys in `system_configs`; SUPER_ADMIN/ADMIN; Redis cache `site-info:public:v1`; audit log. Seals accepted only from `trustseal.enamad.ir` / `logo.samandehi.ir` and published only as link+image pairs. Nothing is hard-coded: an empty field is not rendered. |
| Contact messages | `modules/support`, table `contact_messages`, `/contact`, `/admin/support` | Public `POST /support/contact-messages` (5/h per IP, 3/h per mobile, honeypot `website`), reference `C-XXXXXXXX`; SUPER_ADMIN/ADMIN/SUPPORT inbox with status + internal note (audited). |
| Legal pages | `/terms`, `/privacy`, `/returns`, `/about`, `/contact` | Texts describe the system as it actually behaves (see “Policy vs. enforcement”). BNPL plan table on `/terms` is read live from `/credit/plans`. `LEGAL_REVISION_LABEL` in `components/legal/legal-page.tsx` must be updated whenever the texts change. |
| Footer | `components/layout/site-footer.tsx` | Trust banner, link groups, legal identity and seals from `/site-info`. Seals: `<a referrerPolicy="origin"><img referrerPolicy="origin"></a>` (issuers verify the referrer). CSP `img-src` allows both issuer hosts. |
| Status | `GET /health/status`, `/status` | Business capabilities only (storefront, orders, payments, bnpl, auth) → operational/degraded/outage; cached 10 s. `GET /health` (detailed) is refused by the BFF (`/api/v1/health`, case/slash-insensitive) and stays for container probes. |
| SEO | `app/robots.ts`, `app/sitemap.ts`, `app/layout.tsx`, `lib/seo.ts` | `metadataBase` from `resolveSiteOrigin()` (`PUBLIC_WEB_ORIGIN` → `https://SHOPINO_DOMAIN`; throws in production if neither). Canonical per page (never in the root layout). Product pages: Product/AggregateOffer + BreadcrumbList JSON-LD (IRR), OG/Twitter image = first product image; missing product → 404 + noindex. Static OG image `app/opengraph-image.png`. |

## Policy vs. enforcement (keep the texts honest)

- Escrow is released when the package is DELIVERED; `commerce.escrowHoldDays` is not read by the code.
- The 7-day return window and the excluded-categories list are policy text; disputes have no time window in code.
- Refunds are not automatic: cash refunds are recorded and paid by finance; credit/hybrid orders cannot be refunded in the system (`CREDIT_ORDER_REFUND_UNSUPPORTED`) and are settled with the credit provider.
- `nationalId` is validated as 11 digits (no checksum).

## Operations

- Production env: `SHOPINO_DOMAIN` (required) and optional `PUBLIC_WEB_ORIGIN` are passed to the frontend container.
- After enamad.ir / samandehi.ir issue the seals for the domain, paste the link and image URLs in `/admin/site-info`.

## Verification (2026-09-30)

- Backend unit 614/614, e2e 370/370 (incl. `trust-layer.e2e-spec.ts` 14/14).
- Frontend vitest 94/94, typecheck + eslint clean, `next build` OK (backend build OK).
- Live browser: Phase-0 script 42/42 (admin site-info incl. validation errors, footer/contact rendering and seal attributes, contact form → admin inbox → resolve, legal pages, status leak check, 404, clean-up); previous Torob/Branding suite 55/55.
- HTTP: robots, sitemap (static + categories + products), canonical/OG/Twitter meta, JSON-LD, BFF block of `/health`, `HEALTH`, `health/`.
