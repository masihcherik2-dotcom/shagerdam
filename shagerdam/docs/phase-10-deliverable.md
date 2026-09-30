# Phase 10 — Frontend (Next.js 15 storefront, customer, vendor and admin panels)

## 1. Scope

`apps/frontend` is a production frontend for the Shopino marketplace. It uses Next.js 15.5 (App Router), React 19, TypeScript (strict), Tailwind CSS 4, Lucide icons and the self-hosted Vazirmatn font. The layout is strict RTL throughout (`<html lang="fa" dir="rtl">`).

**Every screen reads and writes the live `/api/v1` backend** (Phases 1–9). There is no mock data, no fake API, no placeholder page and no non-functional button.

- Every data view has skeleton, empty and error (retry) states through `AsyncView`, `Skeleton`, `EmptyState` and `ErrorState`.
- Money is stored in rials by the backend and always displayed in **Toman** (`formatToman`, `<Money rials>`, and `TomanInput` for entry, which converts back to rials).
- Dates are Jalali (`Intl` `fa-IR-u-ca-persian`). Financial periods are sent with the `+03:30` offset.

## 2. Architecture

| Concern | Implementation |
|---|---|
| API access | Browser → same-origin **BFF** `src/app/api/v1/[...path]/route.ts` → backend `/api/v1`. The browser never sees a token and never calls the backend origin. The BFF enforces a same-origin check on mutating requests; `payments/callback` is exempt because it is a bank redirect. |
| Session storage | JWT pair in **httpOnly, SameSite=Lax cookies** (`shopino_at`, `shopino_rt`), with `Secure` whenever the request arrives over HTTPS (`shouldUseSecureCookies`, which honours `x-forwarded-proto`). It is set only by `src/app/api/session/*` route handlers (OTP login, password login, refresh, logout). |
| Token refresh | `session-core.ts` (`isAccessTokenFresh` with a 20 s skew, `refreshAtBackend`). The BFF and the middleware rotate a stale access token transparently. A failed refresh clears both cookies. |
| Logout | `DELETE /api/session`. If the access token is no longer fresh, the pair is first rotated through the refresh token, so that backend `auth/logout` (which requires a valid Bearer token) can revoke the server session. If the rotation fails, the refresh token is already unusable. Cookies are always cleared. |
| Route protection | `src/middleware.ts` protects `/customer/*`, `/vendor/*` and `/admin/*`. It redirects to `/login?next=` when there is no usable session, and to `/forbidden?from=&home=` when the role is wrong. Each admin sub-area also checks capabilities (e.g. support cannot open `/admin/financial`). |
| Role navigation | Header user menu and panel sidebars built per role; role home pages (`/customer`, `/vendor`, `/admin` → the role's landing page). |
| Client data | `useApi` (GET with abort, reload and loading/error state), `useMutation`, and `apiGet/Post/Patch/Delete/Upload`. Errors are normalised by `toApiError` + `localizeErrorMessage` (order: backend error code → backend Persian message → HTTP status). |
| Cart | `useCart` context bound to `/cart` (guest cart cookie handled by the backend; merged on login). |
| Uploads | Multipart through the BFF (`purpose` field first). KYC and dispute evidence are private documents; they are downloaded only through the authenticated BFF. |

## 3. Pages delivered

| Area | Route | Main features |
|---|---|---|
| Store | `/` | Hero, category grid, featured products, 0% BNPL promo |
| Store | `/search`, `/categories/[slug]` | Debounced search; filter sidebar (category tree, price range, in stock, colour/size pills, sort newest / price_asc / price_desc / popular); URL-synced filters; paginated product cards (thumbnail, price, strike-through + discount badge, swatches, store name, BNPL badge) |
| Store | `/products/[slug]` | Gallery + thumbnails; colour × size matrix updating price, SKU and stock; installment calculator (3/6/12 months from live plans); vendor card (logo, name, Instagram, verified); add to cart, disabled when out of stock |
| Store | `/cart` | Grouped by vendor; quantity ± within stock; per-vendor shipping + free-shipping progress; price-change warnings |
| Store | `/checkout` | Address select + add-address modal (province/city lists, postal code); Cash IPG / Bank credit (plan selector) / Hybrid (credit + cash remainder, live split); "ثبت سفارش و پرداخت" → `orders/checkout` then `payments/initiate` or `payments/credit/initiate` |
| Store | `/payment/result` | Outcome, RRN, order number, links to tracking or `/customer/credit` |
| System | `/status` | Phase-1 system health panel (moved from `/`) |
| Auth | `/login`, `/forbidden` | OTP login (mobile) and password login (staff); `next=` round-trip |
| Customer | `/customer/profile`, `/customer/addresses` | Profile edit; address CRUD + default |
| Customer | `/customer/orders`, `/customer/orders/[id]` | List + status timeline; packages, carrier + tracking code, confirm delivery, dispute modal with photo evidence |
| Customer | `/customer/credit` | Apply flow (national-code checksum, Persian decision reasons); limit bar (available/used/reserved); installment calendar; pay installment through the IPG |
| Customer | `/customer/disputes`, `/customer/disputes/[id]` | Dispute list + status; dispute detail with both sides' statements and evidence |
| Vendor | `/vendor/register` | Store registration + KYC upload |
| Vendor | `/vendor/dashboard` | Metrics, pending packages, wallet summary |
| Vendor | `/vendor/products`, `/new`, `/[id]` | Product list with publish toggle; multi-variant table (colour, size, price, compare price, stock, SKU suggestion); image upload |
| Vendor | `/vendor/orders` | PENDING_APPROVAL by default; accept & process; ship modal (carrier + tracking); `?focus=` deep link |
| Vendor | `/vendor/wallet` | Pending / withdrawable / dispute-hold balances, ledger, settlement request to the (read-only) registered IBAN, minimum enforced |
| Vendor | `/vendor/disputes`, `/vendor/disputes/[id]` | List; defend with text + photos, or accept the return |
| Admin | `/admin/vendors`, `/admin/vendors/[id]` | Pending applications, KYC documents, approve / reject with reason |
| Admin | `/admin/products` | Block with reason / unblock |
| Admin | `/admin/financial`, `/admin/settlements` | GMV, escrow, commission; approve payouts with a Paya reference, reject with reason |
| Admin | `/admin/disputes`, `/admin/disputes/[id]` | Dossier (both sides' evidence) and final ruling BUYER_FAVOR / VENDOR_FAVOR. BUYER_FAVOR is disabled for credit-funded packages (backend `CREDIT_ORDER_REFUND_UNSUPPORTED`). |

## 4. Backend changes made for Phase 10 (announced deviations)

These are small and additive. No schema change, so no migration.

1. **`startingCompareAtPrice`** on catalog list items (`product-views.ts`, `catalog-search.service.ts`, DTO), so product cards can show strike-through prices and discount badges. Covered by `product-views.spec.ts` and `catalog.e2e-spec.ts`.
2. **Payment callback → storefront redirect.** When `PAYMENT_RESULT_REDIRECT_URL` is set, `payments/callback` answers `303` to the result page with `buildResultRedirectQuery(outcome)`. When it is unset, the Phase-6 JSON contract is unchanged. Covered by `payments.controller.spec.ts`.
3. **`test/setup-env.ts`** pins `PAYMENT_RESULT_REDIRECT_URL ??= ''`, so the e2e suites keep asserting the JSON contract.
4. **`.env.example`** documents `PUBLIC_API_ORIGIN` and `PAYMENT_RESULT_REDIRECT_URL`.

## 5. Frontend fixes found during verification

- **BFF 502 after `next start`.** `loadEnvConfig(root, true)` now force-reloads the monorepo `.env`, so `API_INTERNAL_URL` is present in the route handler.
- **Credit orders in arbitration.** BUYER_FAVOR is disabled, with an amber explanation, because the backend refuses it with 409 `CREDIT_ORDER_REFUND_UNSUPPORTED`.
- **Role home pages** (`/customer`, `/vendor`, `/admin`) redirect to the role's landing page.
- **Logout with an expired access token.** The server session and refresh token used to survive "sign out"; the pair is now rotated before `auth/logout` (see §2). Verified by browser stage 5.
- **Credit decision reasons.** Provider codes (`SCORE_BELOW_THRESHOLD`, `NOT_ELIGIBLE`, `BELOW_MINIMUM_LIMIT`, `CAPPED_AT_MAXIMUM`) used to be shown raw. They are now localised by `creditDecisionReason()`, with a generic Persian fallback for unknown codes. Unit-tested in `labels.test.ts`.

## 6. Design decisions

- Disputes are listed with `customer/disputes?pageSize=100`; installment links point to `/customer/credit`.
- Vendor dashboard counts use `pageSize=1` totals.
- Settlement minimum: the backend is the authority (`AMOUNT_BELOW_MINIMUM` is shown inline). The IBAN is read-only and comes from the vendor profile.
- Products have a publish toggle and no DELETE in the UI. SKU suggestions use `PREFIX-COLOR-SIZE`; the prefix falls back to digits for Persian titles.
- `itemReturned` is sent only for ACCEPT_RETURN / BUYER_FAVOR.
- Admin vendors default to the PENDING filter; vendor orders default to PENDING_APPROVAL.
- Arbitration is allowed on any active dispute status.
- Admin unblock does not republish. Republishing is the vendor's decision, and the UI tells the admin so.

## 7. Environment

| Variable | Where | Purpose |
|---|---|---|
| `API_INTERNAL_URL` | frontend (server only) | Backend base URL used by the BFF and the session routes |
| `PUBLIC_API_ORIGIN` | backend | Public origin used to build sandbox-bank / callback URLs |
| `PAYMENT_RESULT_REDIRECT_URL` | backend | Storefront `/payment/result` URL for the 303 callback redirect (unset = JSON) |

Active providers in development: **SANDBOX** SMS, **SANDBOX** IPG and **SANDBOX_BANK** credit. None of these is production-ready. Real Zarinpal / bank credentials are required before launch.

## 8. Commands

```bash
pnpm --filter @shopino/frontend typecheck
pnpm --filter @shopino/frontend lint
pnpm --filter @shopino/frontend test
pnpm --filter @shopino/frontend build
pnpm --filter @shopino/frontend start   # next start (reads the monorepo .env)
```

## 9. File tree (`apps/frontend`, build output and dependencies excluded)

```text
apps/frontend/
  eslint.config.mjs
  next-env.d.ts
  next.config.ts
  package.json
  postcss.config.mjs
  src/
    app/
      (store)/
        cart/
          page.tsx
        categories/
          [slug]/
            page.tsx
        checkout/
          page.tsx
        forbidden/
          page.tsx
        layout.tsx
        login/
          page.tsx
        page.tsx
        payment/
          result/
            page.tsx
        products/
          [slug]/
            page.tsx
        search/
          page.tsx
      admin/
        disputes/
          [id]/
            page.tsx
          page.tsx
        financial/
          page.tsx
        layout.tsx
        page.tsx
        products/
          page.tsx
        settlements/
          page.tsx
        vendors/
          [id]/
            page.tsx
          page.tsx
      api/
        session/
          otp/
            route.ts
          password/
            route.ts
          route.ts
          verify/
            route.ts
        v1/
          [...path]/
            route.ts
      customer/
        addresses/
          page.tsx
        credit/
          page.tsx
        disputes/
          [id]/
            page.tsx
          page.tsx
        layout.tsx
        orders/
          [id]/
            page.tsx
          page.tsx
        page.tsx
        profile/
          page.tsx
      error.tsx
      fonts.ts
      globals.css
      layout.tsx
      not-found.tsx
      status/
        page.tsx
      vendor/
        dashboard/
          page.tsx
        disputes/
          [id]/
            page.tsx
          page.tsx
        layout.tsx
        orders/
          page.tsx
        page.tsx
        products/
          [id]/
            page.tsx
          new/
            page.tsx
          page.tsx
        register/
          page.tsx
        wallet/
          page.tsx
    components/
      auth/
        login-form.tsx
      catalog/
        installment-calculator.tsx
        product-browser.tsx
        product-card.tsx
        product-gallery.tsx
        variant-panel.tsx
      customer/
        address-form.tsx
        dispute-form.tsx
        retry-payment-button.tsx
      disputes/
        dispute-list.tsx
        dispute-view.tsx
      layout/
        dashboard-shell.tsx
        header-bar.tsx
        site-footer.tsx
        site-header.tsx
      orders/
        package-stepper.tsx
      providers/
        cart-provider.tsx
        session-provider.tsx
        toast-provider.tsx
      system-health-panel.tsx
      ui/
        button.tsx
        field.tsx
        file-drop.tsx
        misc.tsx
        modal.tsx
        states.tsx
      vendor/
        product-basics.tsx
        product-status-badge.tsx
        variant-editor.tsx
    lib/
      api/
        catalog.server.ts
        client.ts
        error-messages.test.ts
        error-messages.ts
        errors.test.ts
        errors.ts
        health.server.ts
        health.ts
        server.ts
        types.ts
      auth/
        access.test.ts
        access.ts
        bff.ts
        session-core.ts
      currency.test.ts
      currency.ts
      env.ts
      format.test.ts
      format.ts
      hooks/
        use-api.ts
      installments.test.ts
      installments.ts
      iran.test.ts
      iran.ts
      labels.test.ts
      labels.ts
      money.ts
      product-form.test.ts
      product-form.ts
    middleware.ts
  tsconfig.json
  vitest.config.ts
```

## 10. Page / component → API binding (generated from the source)

Every row is extracted from the actual `useApi` / `useMutation` / `api*` calls. `:id` stands for an interpolated identifier. All calls go through the same-origin BFF `/api/v1/*`; session operations go through `/api/session/*`.

| File | Endpoints |
|---|---|
| `app/(store)/categories/[slug]/page.tsx` | GET (SSR) `/categories/:id`<br>GET (SSR) `/categories/tree` |
| `app/(store)/checkout/page.tsx` | GET `/customer/addresses`<br>GET `/credit/account`<br>GET `/credit/plans`<br>POST `/payments/initiate`<br>POST `/payments/credit/initiate`<br>POST `/orders/checkout` |
| `app/(store)/payment/result/page.tsx` | GET (SSR) `/customer/orders/:id` |
| `app/(store)/products/[slug]/page.tsx` | GET (SSR) `/products/:id` |
| `app/admin/disputes/[id]/page.tsx` | GET `/admin/disputes/:id`<br>POST `/admin/disputes/:id/arbitrate` |
| `app/admin/financial/page.tsx` | GET `/admin/financial/overview` |
| `app/admin/products/page.tsx` | GET `/admin/products`<br>PATCH `/admin/products/:id/status` |
| `app/admin/settlements/page.tsx` | GET `/admin/settlements`<br>PATCH `/admin/settlements/:id/process` |
| `app/admin/vendors/[id]/page.tsx` | GET `/admin/vendors/:id`<br>POST `/admin/vendors/:id/verify` |
| `app/admin/vendors/page.tsx` | GET `/admin/vendors` |
| `app/customer/addresses/page.tsx` | GET `/customer/addresses`<br>PATCH `/customer/addresses/:id`<br>DELETE `/customer/addresses/:id` |
| `app/customer/credit/page.tsx` | GET `/credit/plans`<br>GET `/credit/account`<br>POST `/credit/applications`<br>GET `/credit/installments`<br>POST `/credit/installments/:id/pay` |
| `app/customer/disputes/[id]/page.tsx` | GET `/customer/disputes/:id`<br>POST `/customer/disputes/:id/cancel` |
| `app/customer/orders/[id]/page.tsx` | GET `/customer/orders/:id`<br>GET `/customer/disputes`<br>POST `/customer/orders/:id/cancel`<br>POST `/customer/orders/:id/sub-orders/:id/confirm-delivery` |
| `app/customer/orders/page.tsx` | GET `/customer/orders` |
| `app/customer/profile/page.tsx` | GET `/auth/me`<br>PATCH `/auth/profile` |
| `app/vendor/dashboard/page.tsx` | GET `/vendor/orders`<br>GET `/vendor/disputes`<br>GET `/vendor/wallet` |
| `app/vendor/disputes/[id]/page.tsx` | GET `/vendor/disputes/:id`<br>POST `/vendor/disputes/:id/respond` |
| `app/vendor/orders/page.tsx` | GET `/vendor/orders`<br>PATCH `/vendor/orders/:id/status`<br>GET `/vendor/orders/:id` |
| `app/vendor/products/[id]/page.tsx` | GET `/vendor/products/:id`<br>PATCH `/vendor/products/:id`<br>POST `/vendor/products/:id/variants`<br>PATCH `/vendor/products/variants/:id` |
| `app/vendor/products/new/page.tsx` | POST `/vendor/products` |
| `app/vendor/products/page.tsx` | GET `/vendor/products`<br>PATCH `/vendor/products/:id` |
| `app/vendor/register/page.tsx` | POST `/vendors/register`<br>GET `/vendors/me`<br>POST `/vendors/verification/documents`<br>PATCH `/vendors/me` |
| `app/vendor/wallet/page.tsx` | GET `/vendor/wallet`<br>GET `/vendor/wallet/settlements`<br>GET `/vendor/wallet/transactions`<br>GET `/vendors/me`<br>POST `/vendor/wallet/settlements` |
| `components/auth/login-form.tsx` | GET `/auth/sms-provider`<br>POST `/api/session/otp`<br>POST `/api/session/verify`<br>POST `/api/session/password` |
| `components/catalog/product-browser.tsx` | GET `/products` |
| `components/customer/address-form.tsx` | PATCH `/customer/addresses/:id`<br>POST `/customer/addresses` |
| `components/customer/dispute-form.tsx` | POST `/customer/disputes` |
| `components/customer/retry-payment-button.tsx` | POST `/payments/initiate` |
| `components/layout/header-bar.tsx` | GET `/products` |
| `components/layout/site-header.tsx` | GET (SSR) `/categories/tree` |
| `components/providers/cart-provider.tsx` | GET `/cart`<br>POST `/cart/items`<br>PATCH `/cart/items/:id`<br>DELETE `/cart/items/:id`<br>POST `/cart/clear` |
| `components/providers/session-provider.tsx` | GET `/api/session`<br>DELETE `/api/session` |
| `components/ui/file-drop.tsx` | POST (multipart) `/media/upload/image`<br>POST (multipart) `/media/upload/document` |
| `components/vendor/product-basics.tsx` | GET `/categories/tree` |
| `lib/api/catalog.server.ts` | GET (SSR) `/products`<br>GET (SSR) `/categories/tree`<br>GET (SSR) `/credit/plans` |
| `lib/api/server.ts` | GET (SSR) `/auth/me` |

## 11. Complete source — frontend

Every new or changed frontend file (pages, layouts, components, hooks, libs, route handlers, middleware, tests, config) is listed in full.

### `apps/frontend/next.config.ts`

```ts
import path from 'node:path';

import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

/**
 * The repository keeps a single `.env` at its root, shared with the backend and
 * docker-compose. Next.js only reads environment files from its own project
 * directory, so the workspace root is loaded explicitly here. `forceReload` is
 * required: Next.js has already called loadEnvConfig for the app directory by
 * the time this file runs, and without it @next/env returns that cached result
 * (leaving e.g. BACKEND_INTERNAL_URL unset under `next start`). Variables
 * already present in the real process environment still take precedence.
 */
const workspaceRoot = path.resolve(process.cwd(), '..', '..');
loadEnvConfig(workspaceRoot, process.env.NODE_ENV !== 'production', console, true);

const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '*.e2b.app')
  .split(',')
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Keeps file tracing scoped to the monorepo instead of the app directory.
  outputFileTracingRoot: workspaceRoot,
  turbopack: {
    root: workspaceRoot,
  },
  // Remote development sandboxes and tunnels reach the dev server through a
  // different origin; without this, Next.js refuses to serve its dev assets.
  allowedDevOrigins,
  // No /api rewrite: the browser's /api/* calls are served by the BFF route
  // handlers (src/app/api/session, src/app/api/v1/[...path]) which keep the
  // JWTs in httpOnly cookies and forward to BACKEND_INTERNAL_URL server-side.
  // (An afterFiles rewrite would also shadow the dynamic proxy route.)
  images: {
    // Product/store images are served by the backend through the same-origin proxy.
    unoptimized: true,
  },
};

export default nextConfig;
```

### `apps/frontend/package.json`

```json
{
  "name": "@shopino/frontend",
  "version": "0.1.0",
  "private": true,
  "description": "Shopino web client — Next.js App Router (RTL)",
  "license": "UNLICENSED",
  "scripts": {
    "dev": "next dev --port 3000 --hostname 0.0.0.0",
    "build": "next build",
    "start": "next start --port 3000 --hostname 0.0.0.0",
    "typecheck": "tsc --noEmit -p tsconfig.json",
    "lint": "eslint .",
    "test": "vitest run",
    "clean": "rm -rf .next"
  },
  "dependencies": {
    "@next/env": "15.5.26",
    "axios": "^1.20.0",
    "lucide-react": "^1.48.0",
    "next": "^15.5.26",
    "react": "^19.3.0",
    "react-dom": "^19.3.0",
    "vazirmatn": "^33.0.3"
  },
  "devDependencies": {
    "@eslint/eslintrc": "^3.3.7",
    "@shopino/config": "workspace:*",
    "@tailwindcss/postcss": "^4.3.3",
    "@types/node": "^20.19.43",
    "@types/react": "^19.3.0",
    "@types/react-dom": "^19.3.0",
    "eslint": "^9.39.5",
    "eslint-config-next": "^15.5.26",
    "tailwindcss": "^4.3.3",
    "typescript": "5.9.3",
    "vitest": "^3.2.7"
  },
  "engines": {
    "node": ">=22.0.0"
  }
}
```

### `apps/frontend/src/app/(store)/cart/page.tsx`

```tsx
'use client';

import { AlertTriangle, ImageOff, Minus, PackageOpen, Plus, ShoppingBag, Store, Trash2, Truck } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { useCart } from '@/components/providers/cart-provider';
import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { LinkButton } from '@/components/ui/button';
import { Money, PageHeader, ProgressBar } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { toApiError } from '@/lib/api/errors';
import type { CartLine, CartVendorGroup } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatCount, toPersianDigits } from '@/lib/format';
import { compareRials, shareOf } from '@/lib/money';

/** Backend line cap (MAX_LINE_QUANTITY). */
const MAX_LINE_QUANTITY = 100;

export default function CartPage() {
  const { cart, loading, error, reload } = useCart();
  const { user } = useSession();

  if (loading && !cart) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]" role="status" aria-label="در حال بارگذاری سبد خرید">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }
  if (error && !cart) {
    return <ErrorState error={error} title="سبد خرید بارگذاری نشد" onRetry={() => void reload()} />;
  }
  if (!cart || cart.lineCount === 0) {
    return (
      <EmptyState
        icon={<ShoppingBag className="size-6" />}
        title="سبد خرید شما خالی است"
        description="محصولات دلخواه را از فروشگاه‌های مختلف به سبد اضافه کنید؛ همه را یک‌جا پرداخت می‌کنید."
        action={<LinkButton href="/search">مشاهدهٔ محصولات</LinkButton>}
      />
    );
  }

  const checkoutHref = user ? '/checkout' : `/login?next=${encodeURIComponent('/checkout')}`;

  return (
    <>
      <PageHeader title="سبد خرید" description={`${formatCount(cart.itemCount)} کالا از ${formatCount(cart.groups.length)} فروشگاه — هر فروشگاه یک مرسولهٔ جداگانه ارسال می‌کند.`} />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="flex flex-col gap-4">
          {cart.hasPriceChanges ? (
            <p role="alert" className="flex items-start gap-2 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-900">
              <AlertTriangle className="mt-0.5 size-5 shrink-0" />
              قیمت برخی کالاها از زمان افزودن به سبد تغییر کرده است. مبلغ نهایی با قیمت‌های جدید محاسبه می‌شود؛ ردیف‌های تغییرکرده مشخص شده‌اند.
            </p>
          ) : null}
          {cart.groups.map((group) => (
            <VendorPackage key={group.vendor.storeSlug} group={group} />
          ))}
        </div>

        <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-20">
          <h2 className="text-base font-bold">خلاصهٔ سفارش</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">مبلغ کالاها ({toPersianDigits(cart.itemCount)})</dt>
              <dd><Money rials={cart.itemsSubtotal} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">هزینهٔ ارسال ({toPersianDigits(cart.groups.length)} مرسوله)</dt>
              <dd>{compareRials(cart.shippingTotal, 0) === 0 ? <span className="font-medium text-emerald-700">رایگان</span> : <Money rials={cart.shippingTotal} />}</dd>
            </div>
            <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-black">
              <dt>مبلغ قابل پرداخت</dt>
              <dd><Money rials={cart.payableAmount} /></dd>
            </div>
          </dl>
          {cart.canCheckout ? (
            <LinkButton href={checkoutHref} size="lg">
              {user ? 'ادامه و انتخاب شیوهٔ پرداخت' : 'ورود و ادامهٔ خرید'}
            </LinkButton>
          ) : (
            <p className="rounded-xl bg-rose-50 px-3 py-2 text-xs leading-6 text-rose-800">برخی کالاها قابل خرید نیستند (ناموجود یا غیرفعال). آن‌ها را حذف یا تعدادشان را اصلاح کنید.</p>
          )}
          {!user ? <p className="text-xs leading-5 text-slate-500">پس از ورود، سبد خرید شما حفظ و با حسابتان یکی می‌شود.</p> : null}
        </aside>
      </div>
    </>
  );
}

function VendorPackage({ group }: { group: CartVendorGroup }) {
  const { shipping } = group;
  const remaining = shipping.remainingForFreeShipping;
  return (
    <section className="rounded-2xl border border-slate-200 bg-white shadow-sm" aria-label={`مرسولهٔ ${group.vendor.storeName}`}>
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3">
        <p className="flex items-center gap-2 text-sm font-bold text-slate-900">
          <Store className="size-4 text-brand-600" /> {group.vendor.storeName}
        </p>
        <p className="flex items-center gap-1.5 text-xs text-slate-600">
          <Truck className="size-4" /> ارسال: {shipping.isFree ? <b className="text-emerald-700">رایگان</b> : <Money rials={shipping.fee} />}
        </p>
      </header>
      {!shipping.isFree && remaining !== null && compareRials(shipping.freeThreshold, 0) > 0 ? (
        <div className="flex flex-col gap-2 border-b border-slate-100 bg-emerald-50/50 px-5 py-3">
          <p className="text-xs text-emerald-900">
            فقط <b>{formatToman(remaining)}</b> دیگر از این فروشگاه بخرید تا ارسال رایگان شود.
          </p>
          <ProgressBar value={shareOf(group.itemsSubtotal, shipping.freeThreshold)} tone="success" label="پیشرفت تا ارسال رایگان" />
        </div>
      ) : shipping.isFree && compareRials(shipping.freeThreshold, 0) > 0 ? (
        <p className="border-b border-slate-100 bg-emerald-50/50 px-5 py-2 text-xs text-emerald-800">ارسال این مرسوله رایگان شد.</p>
      ) : null}
      <ul className="divide-y divide-slate-100">
        {group.lines.map((line) => (
          <CartLineRow key={line.id} line={line} />
        ))}
      </ul>
      <footer className="flex justify-between border-t border-slate-100 px-5 py-3 text-sm">
        <span className="text-slate-600">جمع این مرسوله</span>
        <Money rials={group.packageTotal} className="font-bold" />
      </footer>
    </section>
  );
}

function CartLineRow({ line }: { line: CartLine }) {
  const { updateQuantity, removeLine } = useCart();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const priceChanged = compareRials(line.unitPrice, line.priceWhenAdded) !== 0;
  const max = Math.min(line.availableQuantity, MAX_LINE_QUANTITY);
  const otherIssues = line.issues.filter((issue) => issue.code !== 'PRICE_CHANGED');

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    try {
      await action();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={`flex gap-4 px-5 py-4 ${busy ? 'opacity-60' : ''}`}>
      <Link href={`/products/${line.productSlug}`} className="relative size-20 shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-100">
        {line.image ? (
          <Image src={line.image.thumbnailUrl ?? line.image.url} alt={line.productTitle} fill sizes="80px" className="object-cover" unoptimized />
        ) : (
          <ImageOff className="m-auto mt-6 size-8 text-slate-400" />
        )}
      </Link>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Link href={`/products/${line.productSlug}`} className="line-clamp-2 text-sm font-medium text-slate-800 hover:text-brand-700">
          {line.productTitle}
        </Link>
        <div className="flex flex-wrap items-center gap-3 text-xs text-slate-500">
          {line.colorName ? (
            <span className="flex items-center gap-1">
              <span className="size-3 rounded-full border border-slate-300" style={{ backgroundColor: line.colorHex ?? '#e2e8f0' }} /> {line.colorName}
            </span>
          ) : null}
          {line.size ? <span>سایز {line.size}</span> : null}
          {line.guarantee ? <span>{line.guarantee}</span> : null}
        </div>
        {priceChanged ? (
          <p className="flex flex-wrap items-center gap-1 text-xs text-amber-800">
            <AlertTriangle className="size-3.5" />
            قیمت از <span className="line-through">{formatToman(line.priceWhenAdded)}</span> به <b>{formatToman(line.unitPrice)}</b> تغییر کرد.
          </p>
        ) : null}
        {otherIssues.map((issue) => (
          <p key={issue.code} className="flex items-center gap-1 text-xs font-medium text-rose-700">
            <PackageOpen className="size-3.5" /> {issue.message}
          </p>
        ))}
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="flex items-center rounded-xl border border-slate-300">
              <button
                type="button"
                disabled={busy || line.quantity >= max}
                onClick={() => void run(() => updateQuantity(line.id, line.quantity + 1))}
                className="p-2 disabled:opacity-30"
                aria-label="افزایش تعداد"
              >
                <Plus className="size-4" />
              </button>
              <span className="w-8 text-center text-sm font-bold">{toPersianDigits(line.quantity)}</span>
              <button
                type="button"
                disabled={busy || line.quantity <= 1}
                onClick={() => void run(() => updateQuantity(line.id, line.quantity - 1))}
                className="p-2 disabled:opacity-30"
                aria-label="کاهش تعداد"
              >
                <Minus className="size-4" />
              </button>
            </div>
            <button type="button" disabled={busy} onClick={() => void run(() => removeLine(line.id))} className="rounded-lg p-2 text-rose-600 hover:bg-rose-50" aria-label={`حذف ${line.productTitle}`}>
              <Trash2 className="size-4" />
            </button>
            {line.availableQuantity > 0 && line.availableQuantity <= 5 ? (
              <span className="text-xs text-amber-700">حداکثر {toPersianDigits(line.availableQuantity)} عدد موجود</span>
            ) : null}
          </div>
          <div className="flex flex-col items-end">
            <span className="text-xs text-slate-500">
              {line.compareAtPrice ? <span className="me-1 text-slate-400 line-through">{formatToman(line.compareAtPrice)}</span> : null}
              هر عدد {formatToman(line.unitPrice)}
            </span>
            <Money rials={line.lineTotal} className="text-sm font-bold" />
          </div>
        </div>
      </div>
    </li>
  );
}
```

### `apps/frontend/src/app/(store)/categories/[slug]/page.tsx`

```tsx
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { ProductBrowser } from '@/components/catalog/product-browser';
import { SkeletonCards } from '@/components/ui/states';
import { isBnplEnabled, loadCreditPlans } from '@/lib/api/catalog.server';
import { serverApiOrNull } from '@/lib/api/server';
import type { CategoryDetail, CategoryTree, CategoryTreeNode } from '@/lib/api/types';
import { formatCount } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const category = await serverApiOrNull<CategoryDetail>(`categories/${encodeURIComponent(slug)}`).catch(() => null);
  return { title: category ? category.titleFa : 'دسته‌بندی' };
}

function findNode(nodes: CategoryTreeNode[], id: string): CategoryTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const [category, tree, plans] = await Promise.all([
    serverApiOrNull<CategoryDetail>(`categories/${encodeURIComponent(slug)}`),
    serverApiOrNull<CategoryTree>('categories/tree'),
    loadCreditPlans(),
  ]);
  if (!category) {
    notFound();
  }
  // Sidebar tree: the root this category belongs to, so siblings and children are one click away.
  const rootId = category.breadcrumbs[0]?.id ?? category.id;
  const root = tree ? findNode(tree.items, rootId) : null;

  return (
    <>
      <nav aria-label="مسیر" className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          شاپینو
        </Link>
        {category.breadcrumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronLeft className="size-3" />
            {crumb.id === category.id ? (
              <span className="font-medium text-slate-800">{crumb.titleFa}</span>
            ) : (
              <Link href={`/categories/${crumb.slug}`} className="hover:text-brand-700">
                {crumb.titleFa}
              </Link>
            )}
          </span>
        ))}
      </nav>
      <div className="mb-6 flex flex-col gap-3">
        <h1 className="text-2xl font-black text-slate-900">{category.titleFa}</h1>
        <p className="text-sm text-slate-500">{formatCount(category.totalProductCount)} محصول</p>
        {category.children.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {category.children.map((child) => (
              <Link key={child.id} href={`/categories/${child.slug}`} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:border-brand-400 hover:text-brand-700">
                {child.titleFa} <span className="text-xs text-slate-400">({formatCount(child.totalProductCount)})</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      <Suspense fallback={<SkeletonCards />}>
        <ProductBrowser fixedCategorySlug={category.slug} tree={root ? [root] : []} bnplEnabled={isBnplEnabled(plans)} />
      </Suspense>
    </>
  );
}
```

### `apps/frontend/src/app/(store)/checkout/page.tsx`

```tsx
'use client';

import { CalendarClock, Check, CreditCard, Layers, MapPin, Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { AddressFormModal } from '@/components/customer/address-form';
import { useCart } from '@/components/providers/cart-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError, Textarea } from '@/components/ui/field';
import { Card, Money, PageHeader } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AddressList, CheckoutResponse, CreditAccount, CreditPaymentInitiateResponse, CreditPlans, InitiatePaymentResponse, PaymentMethod } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatMobile, formatPercent, toPersianDigits } from '@/lib/format';
import { previewInstallments, splitCreditPayment } from '@/lib/installments';
import { useApi } from '@/lib/hooks/use-api';
import { PAYMENT_METHOD_LABELS } from '@/lib/labels';

type Stage = 'idle' | 'placing' | 'redirecting';

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, loading: cartLoading, error: cartError, reload: reloadCart } = useCart();
  const addresses = useApi<AddressList>('/customer/addresses');
  const account = useApi<CreditAccount>('/credit/account');
  const plans = useApi<CreditPlans>('/credit/plans');

  const [addressId, setAddressId] = useState<string | null>(null);
  const [addressModal, setAddressModal] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('CASH_IPG');
  const [planId, setPlanId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [placedOrder, setPlacedOrder] = useState<CheckoutResponse | null>(null);

  // Preselect the default address.
  useEffect(() => {
    if (addressId === null && addresses.data && addresses.data.items.length > 0) {
      setAddressId((addresses.data.items.find((item) => item.isDefault) ?? addresses.data.items[0])!.id);
    }
  }, [addresses.data, addressId]);

  useEffect(() => {
    if (planId === null && plans.data && plans.data.items.length > 0) {
      setPlanId([...plans.data.items].sort((a, b) => a.durationMonths - b.durationMonths)[0]!.id);
    }
  }, [plans.data, planId]);

  // 404 CREDIT_ACCOUNT_NOT_FOUND simply means "no credit line yet".
  const creditAccount = account.data && account.data.status === 'ACTIVE' ? account.data : null;
  const creditEnabled = Boolean(plans.data?.creditEnabled && plans.data.items.length > 0);
  const payable = cart?.payableAmount ?? '0';

  const creditSplit = useMemo(() => (creditAccount ? splitCreditPayment('BANK_CREDIT', payable, creditAccount.availableAmount) : null), [creditAccount, payable]);
  const hybridSplit = useMemo(() => (creditAccount ? splitCreditPayment('HYBRID', payable, creditAccount.availableAmount) : null), [creditAccount, payable]);
  const selectedPlan = plans.data?.items.find((plan) => plan.id === planId) ?? null;

  const creditPortion = method === 'BANK_CREDIT' && creditSplit?.ok ? creditSplit.creditAmount : method === 'HYBRID' && hybridSplit?.ok ? hybridSplit.creditAmount : null;
  const schedulePreview = creditPortion && selectedPlan ? previewInstallments(creditPortion, selectedPlan.interestRatePercent, selectedPlan.durationMonths) : null;

  async function pay(order: { parentOrderId: string; orderNumber: string }) {
    if (method === 'CASH_IPG') {
      const payment = await apiPost<InitiatePaymentResponse>('/payments/initiate', { parentOrderId: order.parentOrderId });
      setStage('redirecting');
      window.location.assign(payment.redirectUrl);
      return;
    }
    const result = await apiPost<CreditPaymentInitiateResponse>('/payments/credit/initiate', { parentOrderId: order.parentOrderId, planId, paymentMethod: method });
    if (result.status === 'IPG_REQUIRED' && result.redirectUrl) {
      setStage('redirecting');
      window.location.assign(result.redirectUrl);
      return;
    }
    const query = new URLSearchParams({ orderNumber: result.orderNumber, outcome: 'PAID', paymentId: result.paymentId, parentOrderId: result.parentOrderId });
    router.push(`/payment/result?${query.toString()}`);
  }

  async function submit() {
    if (!addressId) {
      setError('یک نشانی برای ارسال انتخاب یا اضافه کنید.');
      return;
    }
    if (method !== 'CASH_IPG' && !planId) {
      setError('طرح اقساط را انتخاب کنید.');
      return;
    }
    setError(null);
    setStage('placing');
    let order = placedOrder;
    try {
      if (!order) {
        order = await apiPost<CheckoutResponse>('/orders/checkout', { addressId, customerNote: note.trim() || undefined });
        setPlacedOrder(order);
        void reloadCart();
      }
      await pay(order);
    } catch (caught) {
      setStage('idle');
      const apiError = toApiError(caught);
      setError(order ? `سفارش ${order.orderNumber} ثبت شد اما شروع پرداخت ممکن نشد: ${apiError.message}` : apiError.message);
    }
  }

  if (cartLoading && !cart) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]" role="status" aria-label="در حال بارگذاری">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (cartError && !cart) {
    return <ErrorState error={cartError} onRetry={() => void reloadCart()} />;
  }
  if (!placedOrder && (!cart || cart.lineCount === 0)) {
    return <EmptyState title="سبد خرید خالی است" description="برای ثبت سفارش ابتدا کالایی به سبد اضافه کنید." action={<LinkButton href="/search">مشاهدهٔ محصولات</LinkButton>} />;
  }
  if (!placedOrder && cart && !cart.canCheckout) {
    return <EmptyState title="سبد خرید نیاز به اصلاح دارد" description="برخی کالاها ناموجود یا غیرفعال شده‌اند." action={<LinkButton href="/cart">بازگشت به سبد خرید</LinkButton>} />;
  }

  const totals = placedOrder
    ? { items: placedOrder.totalItemsAmount, shipping: placedOrder.totalShippingFee, payable: placedOrder.finalPayableAmount, packages: placedOrder.subOrders.length }
    : { items: cart!.itemsSubtotal, shipping: cart!.shippingTotal, payable: cart!.payableAmount, packages: cart!.groups.length };

  return (
    <>
      <PageHeader title="تکمیل خرید" description="نشانی ارسال و شیوهٔ پرداخت را انتخاب کنید." />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <Card
            title={
              <span className="flex items-center gap-2">
                <MapPin className="size-5 text-brand-600" /> نشانی ارسال
              </span>
            }
            action={
              !placedOrder ? (
                <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} onClick={() => setAddressModal(true)}>
                  نشانی جدید
                </Button>
              ) : null
            }
          >
            {addresses.loading && !addresses.data ? (
              <Skeleton className="h-24" />
            ) : addresses.error && !addresses.data ? (
              <ErrorState error={addresses.error} onRetry={() => void addresses.reload()} />
            ) : addresses.data && addresses.data.items.length === 0 ? (
              <EmptyState title="هنوز نشانی ثبت نکرده‌اید" action={<Button onClick={() => setAddressModal(true)}>افزودن نشانی</Button>} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="نشانی ارسال">
                {addresses.data?.items.map((address) => {
                  const active = address.id === addressId;
                  return (
                    <button
                      key={address.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={Boolean(placedOrder)}
                      onClick={() => setAddressId(address.id)}
                      className={`flex flex-col gap-1 rounded-2xl border p-4 text-start text-sm ${active ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300'}`}
                    >
                      <span className="flex items-center justify-between font-bold text-slate-900">
                        {address.province}، {address.city}
                        {active ? <Check className="size-4 text-brand-600" /> : null}
                      </span>
                      <span className="line-clamp-2 leading-6 text-slate-600">{address.postalAddress}</span>
                      <span className="text-xs text-slate-500">
                        {address.recipientName} · {formatMobile(address.recipientMobile)} · کد پستی {toPersianDigits(address.postalCode)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-2">
                <CreditCard className="size-5 text-brand-600" /> شیوهٔ پرداخت
              </span>
            }
          >
            <div className="flex flex-col gap-3" role="radiogroup" aria-label="شیوهٔ پرداخت">
              <MethodOption
                active={method === 'CASH_IPG'}
                disabled={Boolean(placedOrder)}
                onSelect={() => setMethod('CASH_IPG')}
                icon={<CreditCard className="size-5" />}
                title={PAYMENT_METHOD_LABELS.CASH_IPG}
                description="پرداخت کامل با کارت‌های عضو شتاب از طریق درگاه بانکی."
              />
              {account.loading || plans.loading ? (
                <Skeleton className="h-20" />
              ) : !creditEnabled ? (
                <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">خرید اعتباری در حال حاضر فعال نیست.</p>
              ) : !creditAccount ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/50 px-4 py-3 text-sm">
                  <span className="text-emerald-900">{account.data ? 'حساب اعتباری شما فعال نیست.' : 'برای خرید اقساطی ابتدا اعتبار دریافت کنید.'}</span>
                  <Link href="/customer/credit" className="font-bold text-emerald-700 hover:underline">
                    درخواست اعتبار ←
                  </Link>
                </div>
              ) : (
                <>
                  <MethodOption
                    active={method === 'BANK_CREDIT'}
                    disabled={Boolean(placedOrder) || !creditSplit?.ok}
                    onSelect={() => setMethod('BANK_CREDIT')}
                    icon={<CalendarClock className="size-5" />}
                    title={PAYMENT_METHOD_LABELS.BANK_CREDIT}
                    description={
                      creditSplit?.ok
                        ? `کل مبلغ از اعتبار شما (${formatToman(creditAccount.availableAmount)} در دسترس) کسر و اقساطی پرداخت می‌شود.`
                        : `اعتبار در دسترس (${formatToman(creditAccount.availableAmount)}) برای کل مبلغ کافی نیست؛ پرداخت ترکیبی را انتخاب کنید.`
                    }
                  />
                  <MethodOption
                    active={method === 'HYBRID'}
                    disabled={Boolean(placedOrder) || !hybridSplit?.ok}
                    onSelect={() => setMethod('HYBRID')}
                    icon={<Layers className="size-5" />}
                    title={PAYMENT_METHOD_LABELS.HYBRID}
                    description={
                      hybridSplit?.ok
                        ? `${formatToman(hybridSplit.creditAmount)} از اعتبار کسر و ${formatToman(hybridSplit.cashAmount)} باقی‌مانده با درگاه بانکی پرداخت می‌شود.`
                        : 'اعتبار شما کل مبلغ را پوشش می‌دهد؛ پرداخت ترکیبی لازم نیست.'
                    }
                  />
                </>
              )}
            </div>

            {method !== 'CASH_IPG' && plans.data ? (
              <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4">
                <p className="text-sm font-bold text-slate-800">طرح اقساط</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="طرح اقساط">
                  {[...plans.data.items]
                    .sort((a, b) => a.durationMonths - b.durationMonths)
                    .map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        role="radio"
                        aria-checked={plan.id === planId}
                        disabled={Boolean(placedOrder)}
                        onClick={() => setPlanId(plan.id)}
                        className={`rounded-xl border px-3 py-2 text-sm ${plan.id === planId ? 'border-emerald-600 bg-emerald-50 font-bold ring-2 ring-emerald-100' : 'border-slate-200'}`}
                      >
                        {plan.title}
                        <span className="block text-xs font-normal text-slate-500">
                          {toPersianDigits(plan.durationMonths)} قسط · {Number(plan.interestRatePercent) === 0 ? 'بدون سود' : `سود ${formatPercent(plan.interestRatePercent)}`}
                        </span>
                      </button>
                    ))}
                </div>
                {schedulePreview ? (
                  <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs leading-6 text-emerald-900">
                    {toPersianDigits(schedulePreview.lines.length)} قسط حدوداً {formatToman(schedulePreview.regularInstallment)}؛ مجموع بازپرداخت اعتبار {formatToman(schedulePreview.totalPayable)}
                    {Number(selectedPlan?.interestRatePercent) === 0 ? ' (بدون سود)' : ` (شامل ${formatToman(schedulePreview.totalInterest)} سود)`}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>

          {!placedOrder ? (
            <Card title="توضیحات سفارش (اختیاری)">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="مثلاً: قبل از ارسال تماس بگیرید." aria-label="توضیحات سفارش" />
            </Card>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-20">
          <h2 className="text-base font-bold">{placedOrder ? `سفارش ${placedOrder.orderNumber}` : 'خلاصهٔ پرداخت'}</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">مبلغ کالاها</dt>
              <dd><Money rials={totals.items} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">ارسال ({toPersianDigits(totals.packages)} مرسوله)</dt>
              <dd><Money rials={totals.shipping} /></dd>
            </div>
            {creditPortion ? (
              <div className="flex justify-between text-emerald-800">
                <dt>از اعتبار</dt>
                <dd><Money rials={creditPortion} /></dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-black">
              <dt>{method === 'HYBRID' ? 'پرداخت با درگاه' : method === 'BANK_CREDIT' ? 'پرداخت نقدی' : 'مبلغ قابل پرداخت'}</dt>
              <dd>
                <Money rials={method === 'HYBRID' && hybridSplit?.ok ? hybridSplit.cashAmount : method === 'BANK_CREDIT' ? '0' : totals.payable} />
              </dd>
            </div>
          </dl>
          <FormError message={error} />
          <Button size="lg" onClick={() => void submit()} loading={stage !== 'idle'} disabled={!addressId || (method !== 'CASH_IPG' && !creditPortion)}>
            {stage === 'redirecting' ? 'در حال انتقال به درگاه…' : method === 'BANK_CREDIT' ? 'ثبت سفارش و پرداخت اعتباری' : 'ثبت سفارش و پرداخت'}
          </Button>
          {placedOrder ? (
            <Link href={`/customer/orders/${placedOrder.parentOrderId}`} className="text-center text-sm text-brand-700 hover:underline">
              مشاهدهٔ سفارش ثبت‌شده
            </Link>
          ) : null}
          <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            مبلغ تا تحویل کالا نزد شاپینو امانت می‌ماند و سپس به فروشنده پرداخت می‌شود.
          </p>
        </aside>
      </div>

      {addressModal ? (
        <AddressFormModal
          open
          onClose={() => setAddressModal(false)}
          onSaved={(saved) => {
            setAddressModal(false);
            setAddressId(saved.id);
            void addresses.reload();
          }}
        />
      ) : null}
    </>
  );
}

function MethodOption({ active, disabled, onSelect, icon, title, description }: { active: boolean; disabled: boolean; onSelect: () => void; icon: React.ReactNode; title: string; description: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-2xl border p-4 text-start disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300'}`}
    >
      <span className={`mt-0.5 ${active ? 'text-brand-600' : 'text-slate-500'}`}>{icon}</span>
      <span className="flex flex-col gap-1">
        <span className="text-sm font-bold text-slate-900">{title}</span>
        <span className="text-xs leading-5 text-slate-600">{description}</span>
      </span>
    </button>
  );
}
```

### `apps/frontend/src/app/(store)/forbidden/page.tsx`

```tsx
import { ShieldX } from 'lucide-react';
import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/button';
import { safeNextPath } from '@/lib/auth/access';

export const metadata: Metadata = { title: 'دسترسی مجاز نیست', robots: { index: false } };

export default async function ForbiddenPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const home = safeNextPath(params.home) ?? '/';
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 rounded-3xl border border-slate-200 bg-white p-8 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-rose-50 text-rose-600">
        <ShieldX className="size-8" />
      </span>
      <h1 className="text-xl font-black">دسترسی به این بخش مجاز نیست</h1>
      <p className="text-sm leading-7 text-slate-600">نقش حساب کاربری شما اجازهٔ ورود به این صفحه را نمی‌دهد. اگر فکر می‌کنید اشتباهی رخ داده، با پشتیبانی تماس بگیرید.</p>
      <LinkButton href={home}>رفتن به پنل من</LinkButton>
    </div>
  );
}
```

### `apps/frontend/src/app/(store)/layout.tsx`

```tsx
import type { ReactNode } from 'react';

import { SiteFooter } from '@/components/layout/site-footer';
import { SiteHeader } from '@/components/layout/site-header';

export default function StoreLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto min-h-[60vh] max-w-7xl px-4 py-6">{children}</main>
      <SiteFooter />
    </>
  );
}
```

### `apps/frontend/src/app/(store)/login/page.tsx`

```tsx
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LoginForm } from '@/components/auth/login-form';
import { Skeleton } from '@/components/ui/states';

export const metadata: Metadata = { title: 'ورود | ثبت‌نام', robots: { index: false } };

export default function LoginPage() {
  return (
    <div className="mx-auto w-full max-w-md py-6">
      <Suspense fallback={<Skeleton className="h-96" />}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
```

### `apps/frontend/src/app/(store)/page.tsx`

```tsx
import { ArrowLeft, BadgeCheck, CalendarClock, LayoutGrid, ShieldCheck, Sparkles, Truck } from 'lucide-react';
import Link from 'next/link';

import { ProductGrid } from '@/components/catalog/product-card';
import { LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans, loadProducts } from '@/lib/api/catalog.server';
import type { InstallmentPlan } from '@/lib/api/types';
import { formatCount, formatPercent, toPersianDigits } from '@/lib/format';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [tree, popular, newest, plans] = await Promise.all([
    loadCategoryTree(),
    loadProducts({ sortBy: 'popular', pageSize: 8, inStockOnly: true }),
    loadProducts({ sortBy: 'newest', pageSize: 8 }),
    loadCreditPlans(),
  ]);
  const bnpl = isBnplEnabled(plans);
  const planItems: InstallmentPlan[] = plans.ok ? plans.data.items : [];
  const zeroInterest = planItems.filter((plan) => Number(plan.interestRatePercent) === 0);

  return (
    <div className="flex flex-col gap-12">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-sky-500 px-6 py-12 text-white md:px-12 md:py-16">
        <div className="relative z-10 flex max-w-2xl flex-col gap-5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
            <Sparkles className="size-3.5" /> بازار آنلاین چندفروشندگی
          </span>
          <h1 className="text-3xl font-black leading-tight md:text-5xl">هر چه می‌خواهید، از فروشگاه‌های تأییدشده؛ نقدی یا اقساطی</h1>
          <p className="text-sm leading-7 text-white/85 md:text-base">
            پول شما تا زمان تحویل کالا نزد شاپینو امانت می‌ماند. سفارش از چند فروشگاه را یک‌جا پرداخت کنید و هر مرسوله را جداگانه پیگیری کنید.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/search" variant="secondary" size="lg" className="border-0 text-brand-700">
              شروع خرید <ArrowLeft className="size-4" />
            </LinkButton>
            {bnpl ? (
              <LinkButton href="/customer/credit" size="lg" className="bg-white/15 hover:bg-white/25">
                دریافت اعتبار خرید
              </LinkButton>
            ) : null}
          </div>
          {tree.ok ? (
            <p className="text-xs text-white/75">
              {formatCount(tree.data.totalProducts)} محصول در {formatCount(tree.data.totalCategories)} دسته‌بندی
            </p>
          ) : null}
        </div>
        <div className="pointer-events-none absolute -bottom-24 -left-24 size-80 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -top-16 left-40 size-48 rounded-full bg-white/10" />
      </section>

      {/* Trust strip */}
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: ShieldCheck, title: 'پرداخت امن و امانی', text: 'مبلغ تا تأیید تحویل به فروشنده پرداخت نمی‌شود.' },
          { icon: BadgeCheck, title: 'فروشندگان احرازشده', text: 'مدارک هویتی و حساب بانکی هر فروشگاه بررسی می‌شود.' },
          { icon: Truck, title: 'پیگیری هر مرسوله', text: 'کد رهگیری و وضعیت هر بسته جداگانه نمایش داده می‌شود.' },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4">
            <item.icon className="mt-0.5 size-6 shrink-0 text-brand-600" />
            <div>
              <p className="text-sm font-bold text-slate-900">{item.title}</p>
              <p className="mt-1 text-xs leading-6 text-slate-500">{item.text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Category grid */}
      <section className="flex flex-col gap-4">
        <SectionTitle icon={<LayoutGrid className="size-5" />} title="دسته‌بندی‌ها" href="/search" />
        {!tree.ok ? (
          <ErrorState error={tree.message} title="دسته‌بندی‌ها بارگذاری نشد" />
        ) : tree.data.items.length === 0 ? (
          <EmptyState title="هنوز دسته‌بندی فعالی وجود ندارد" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tree.data.items.map((category) => (
              <Link
                key={category.id}
                href={`/categories/${category.slug}`}
                className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-center transition hover:border-brand-300 hover:shadow-sm"
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-lg font-black text-brand-700">{category.titleFa.charAt(0)}</span>
                <span className="text-sm font-bold text-slate-800">{category.titleFa}</span>
                <span className="text-xs text-slate-500">{formatCount(category.totalProductCount)} محصول</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* BNPL promo — driven by the live installment plans */}
      {bnpl ? (
        <section className="grid items-center gap-6 overflow-hidden rounded-3xl border border-emerald-200 bg-gradient-to-l from-emerald-50 to-white p-6 md:grid-cols-[1.2fr_1fr] md:p-10">
          <div className="flex flex-col gap-4">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
              <CalendarClock className="size-3.5" /> الان بخر، بعداً پرداخت کن
            </span>
            <h2 className="text-2xl font-black text-slate-900 md:text-3xl">
              {zeroInterest.length > 0
                ? `خرید اقساطی ${toPersianDigits(zeroInterest[0]!.durationMonths)} ماهه بدون سود`
                : 'خرید اقساطی با اعتبار بانکی'}
            </h2>
            <p className="text-sm leading-7 text-slate-600">
              با یک بار دریافت اعتبار از {plans.ok && plans.data.provider ? plans.data.provider.name : 'بانک همکار'}، سبد خرید خود را از همهٔ فروشگاه‌ها به‌صورت اقساطی پرداخت کنید. اگر اعتبارتان کمتر از مبلغ سفارش باشد، باقی‌مانده را با کارت بانکی بپردازید.
            </p>
            <div>
              <LinkButton href="/customer/credit" variant="success">
                درخواست اعتبار
              </LinkButton>
            </div>
          </div>
          <ul className="grid gap-3">
            {planItems.map((plan) => (
              <li key={plan.id} className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-white px-4 py-3">
                <span className="text-sm font-bold text-slate-800">{plan.title}</span>
                <span className="text-xs text-slate-600">
                  {toPersianDigits(plan.durationMonths)} قسط ·{' '}
                  {Number(plan.interestRatePercent) === 0 ? <b className="text-emerald-700">بدون سود</b> : `سود کل ${formatPercent(plan.interestRatePercent)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Featured (best sellers) */}
      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Sparkles className="size-5" />} title="پرفروش‌ترین‌ها" href="/search?sort=popular" />
        {!popular.ok ? (
          <ErrorState error={popular.message} title="محصولات بارگذاری نشد" />
        ) : popular.data.items.length === 0 ? (
          <EmptyState title="هنوز محصولی برای نمایش وجود ندارد" description="به‌محض انتشار محصولات توسط فروشندگان، این بخش پر می‌شود." />
        ) : (
          <ProductGrid products={popular.data.items} bnplEnabled={bnpl} />
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle title="تازه‌ترین محصولات" href="/search?sort=newest" />
        {!newest.ok ? (
          <ErrorState error={newest.message} title="محصولات بارگذاری نشد" />
        ) : newest.data.items.length === 0 ? (
          <EmptyState title="محصولی ثبت نشده است" />
        ) : (
          <ProductGrid products={newest.data.items} bnplEnabled={bnpl} />
        )}
      </section>
    </div>
  );
}

function SectionTitle({ title, href, icon }: { title: string; href: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-900 md:text-xl">
        {icon ? <span className="text-brand-600">{icon}</span> : null}
        {title}
      </h2>
      <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
        مشاهدهٔ همه <ArrowLeft className="size-4" />
      </Link>
    </div>
  );
}
```

### `apps/frontend/src/app/(store)/payment/result/page.tsx`

```tsx
import { CheckCircle2, Clock, XCircle } from 'lucide-react';
import type { Metadata } from 'next';

import { RetryPaymentButton } from '@/components/customer/retry-payment-button';
import { LinkButton } from '@/components/ui/button';
import { Badge, Money, StatusBadge } from '@/components/ui/misc';
import { EmptyState } from '@/components/ui/states';
import { ApiError } from '@/lib/api/errors';
import { serverApi } from '@/lib/api/server';
import type { CustomerOrderDetail, PaymentOutcome } from '@/lib/api/types';
import { formatDateTime, toPersianDigits } from '@/lib/format';
import { PAYMENT_METHOD_LABELS, PAYMENT_OUTCOME, PAYMENT_STATUS } from '@/lib/labels';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'نتیجهٔ پرداخت', robots: { index: false } };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const OUTCOMES = Object.keys(PAYMENT_OUTCOME) as PaymentOutcome[];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Landing page of the bank round-trip (backend PAYMENT_RESULT_REDIRECT_URL).
 * The query string (outcome, order number, RRN) is only a hint: when the
 * order id is present, the order is re-read from the API and its real payment
 * status is what the page trusts.
 */
export default async function PaymentResultPage({ searchParams }: Props) {
  const params = await searchParams;
  const outcomeParam = one(params.outcome);
  const outcome = OUTCOMES.includes(outcomeParam as PaymentOutcome) ? (outcomeParam as PaymentOutcome) : null;
  const orderNumber = one(params.orderNumber);
  const rrn = one(params.rrn);
  const parentOrderId = one(params.parentOrderId);
  const isInstallment = one(params.purpose) === 'INSTALLMENT_REPAYMENT';

  if (!outcome || !orderNumber) {
    return <EmptyState title="اطلاعات پرداخت یافت نشد" description="این صفحه پس از بازگشت از درگاه بانکی نمایش داده می‌شود." action={<LinkButton href="/customer/orders">سفارش‌های من</LinkButton>} />;
  }

  let order: CustomerOrderDetail | null = null;
  let orderError: string | null = null;
  if (!isInstallment && parentOrderId && UUID.test(parentOrderId)) {
    try {
      order = await serverApi<CustomerOrderDetail>(`customer/orders/${parentOrderId}`);
    } catch (error) {
      orderError = error instanceof ApiError && error.status === 401 ? 'برای مشاهدهٔ جزئیات سفارش وارد حساب خود شوید.' : error instanceof Error ? error.message : null;
    }
  }

  // The order's own status wins over the redirect hint — except for an
  // instalment repayment, whose order was paid long ago (the instalment page
  // shows the instalment's own status).
  const effective: PaymentOutcome = order && !isInstallment ? (order.paymentStatus === 'PAID' ? (outcome === 'PAID_REQUIRES_REFUND' ? outcome : 'PAID') : outcome === 'PAID' ? 'VERIFICATION_PENDING' : outcome) : outcome;
  const meta = PAYMENT_OUTCOME[effective];
  const Icon = effective === 'PAID' ? CheckCircle2 : effective === 'FAILED' ? XCircle : Clock;
  const iconColor = effective === 'PAID' ? 'text-emerald-600 bg-emerald-50' : effective === 'FAILED' ? 'text-rose-600 bg-rose-50' : 'text-amber-600 bg-amber-50';

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-6 rounded-3xl border border-slate-200 bg-white p-8 text-center shadow-sm">
      <span className={`flex size-20 items-center justify-center rounded-full ${iconColor}`}>
        <Icon className="size-10" />
      </span>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-black text-slate-900">
          {isInstallment ? 'پرداخت قسط: ' : ''}
          {meta.label}
        </h1>
        <p className="text-sm leading-7 text-slate-600">{meta.description}</p>
      </div>

      <dl className="grid w-full grid-cols-1 gap-3 rounded-2xl bg-slate-50 p-4 text-sm sm:grid-cols-2">
        <div className="flex flex-col gap-0.5 text-start">
          <dt className="text-slate-500">شمارهٔ سفارش</dt>
          <dd dir="ltr" className="text-end font-mono font-bold text-slate-900 sm:text-start">
            {orderNumber}
          </dd>
        </div>
        <div className="flex flex-col gap-0.5 text-start">
          <dt className="text-slate-500">کد پیگیری بانکی (RRN)</dt>
          <dd dir="ltr" className="text-end font-mono font-bold text-slate-900 sm:text-start">
            {rrn ?? '—'}
          </dd>
        </div>
        {order && !isInstallment ? (
          <>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">وضعیت پرداخت سفارش</dt>
              <dd>
                <StatusBadge value={order.paymentStatus} map={PAYMENT_STATUS} />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">مبلغ سفارش</dt>
              <dd className="font-bold">
                <Money rials={order.finalPayableAmount} />
              </dd>
            </div>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">شیوهٔ پرداخت</dt>
              <dd>{PAYMENT_METHOD_LABELS[order.paymentMethod]}</dd>
            </div>
            <div className="flex flex-col gap-0.5 text-start">
              <dt className="text-slate-500">مرسوله‌ها</dt>
              <dd>{toPersianDigits(order.subOrders.length)} مرسوله</dd>
            </div>
            {order.paidAt ? (
              <div className="flex flex-col gap-0.5 text-start sm:col-span-2">
                <dt className="text-slate-500">زمان پرداخت</dt>
                <dd>{formatDateTime(order.paidAt)}</dd>
              </div>
            ) : null}
          </>
        ) : null}
      </dl>
      {orderError ? <Badge tone="warning">{orderError}</Badge> : null}

      <div className="flex w-full flex-col gap-3 sm:flex-row sm:justify-center">
        {isInstallment ? (
          <LinkButton href="/customer/credit" size="lg">
            مشاهدهٔ اقساط
          </LinkButton>
        ) : parentOrderId && UUID.test(parentOrderId) ? (
          <LinkButton href={`/customer/orders/${parentOrderId}`} size="lg">
            پیگیری سفارش
          </LinkButton>
        ) : (
          <LinkButton href="/customer/orders" size="lg">
            سفارش‌های من
          </LinkButton>
        )}
        {order && !isInstallment && order.paymentStatus === 'PENDING' && effective === 'FAILED' ? <RetryPaymentButton parentOrderId={order.id} /> : null}
        <LinkButton href="/" variant="secondary" size="lg">
          بازگشت به فروشگاه
        </LinkButton>
      </div>
    </div>
  );
}
```

### `apps/frontend/src/app/(store)/products/[slug]/page.tsx`

```tsx
import { AtSign, BadgeCheck, ChevronLeft, Store } from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProductGallery } from '@/components/catalog/product-gallery';
import { VariantPanel } from '@/components/catalog/variant-panel';
import { Badge } from '@/components/ui/misc';
import { loadCreditPlans } from '@/lib/api/catalog.server';
import { serverApiOrNull } from '@/lib/api/server';
import type { ProductDetail } from '@/lib/api/types';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await serverApiOrNull<ProductDetail>(`products/${encodeURIComponent(slug)}`).catch(() => null);
  return product ? { title: product.title, description: product.description?.slice(0, 160) ?? undefined } : { title: 'محصول' };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const [product, plans] = await Promise.all([serverApiOrNull<ProductDetail>(`products/${encodeURIComponent(slug)}`), loadCreditPlans()]);
  if (!product) {
    notFound();
  }
  const vendor = product.vendor;
  const instagram = vendor.instagramHandle?.replace(/^@/, '');

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="مسیر" className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          شاپینو
        </Link>
        {product.breadcrumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronLeft className="size-3" />
            <Link href={`/categories/${crumb.slug}`} className="hover:text-brand-700">
              {crumb.titleFa}
            </Link>
          </span>
        ))}
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        <ProductGallery media={product.media} title={product.title} />

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            {product.brand ? <span className="text-sm font-medium text-brand-700">{product.brand}</span> : null}
            <h1 className="text-2xl font-black leading-snug text-slate-900">{product.title}</h1>
          </div>

          {product.variants.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">این محصول در حال حاضر گزینهٔ قابل فروشی ندارد.</p>
          ) : (
            <VariantPanel product={product} plans={plans.ok ? plans.data : null} />
          )}

          {/* Vendor card */}
          <section className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="فروشنده">
            <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
              {vendor.logoUrl ? (
                <Image src={vendor.logoUrl} alt={vendor.storeName} fill sizes="56px" className="object-cover" unoptimized />
              ) : (
                <Store className="m-auto mt-3.5 size-7 text-slate-400" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold text-slate-900">{vendor.storeName}</p>
                {vendor.verifiedAt ? (
                  <Badge tone="success">
                    <BadgeCheck className="size-3.5" /> فروشگاه احرازشده
                  </Badge>
                ) : null}
              </div>
              {vendor.verifiedAt ? <p className="text-xs text-slate-500">عضو تأییدشده از {formatDate(vendor.verifiedAt)}</p> : null}
              {vendor.bio ? <p className="line-clamp-3 text-sm leading-6 text-slate-600">{vendor.bio}</p> : null}
              <div className="flex flex-wrap gap-3 text-sm">
                <Link href={`/search?vendor=${encodeURIComponent(vendor.storeSlug)}`} className="font-medium text-brand-700 hover:underline">
                  سایر محصولات این فروشگاه
                </Link>
                {instagram ? (
                  <a href={`https://instagram.com/${encodeURIComponent(instagram)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-pink-700 hover:underline">
                    <AtSign className="size-4" /> اینستاگرام <span dir="ltr">@{instagram}</span>
                  </a>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>

      {product.description ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-3 text-lg font-bold text-slate-900">معرفی محصول</h2>
          <p className="whitespace-pre-line text-sm leading-8 text-slate-700">{product.description}</p>
        </section>
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/app/(store)/search/page.tsx`

```tsx
import type { Metadata } from 'next';
import { Suspense } from 'react';

import { ProductBrowser } from '@/components/catalog/product-browser';
import { PageHeader } from '@/components/ui/misc';
import { SkeletonCards } from '@/components/ui/states';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans } from '@/lib/api/catalog.server';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }): Promise<Metadata> {
  const { q } = await searchParams;
  return { title: q ? `جست‌وجوی «${q}»` : 'همهٔ محصولات' };
}

export default async function SearchPage() {
  const [tree, plans] = await Promise.all([loadCategoryTree(), loadCreditPlans()]);
  return (
    <>
      <PageHeader title="جست‌وجوی محصولات" description="نتایج با هر تغییر عبارت یا فیلتر، بلافاصله از فهرست زندهٔ محصولات به‌روز می‌شوند." />
      <Suspense fallback={<SkeletonCards />}>
        <ProductBrowser tree={tree.ok ? tree.data.items : []} bnplEnabled={isBnplEnabled(plans)} />
      </Suspense>
    </>
  );
}
```

### `apps/frontend/src/app/admin/disputes/[id]/page.tsx`

```tsx
'use client';

import { Gavel, ShieldCheck, UserRound } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DisputeView } from '@/components/disputes/dispute-view';
import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormError, Textarea } from '@/components/ui/field';
import { Card, DefinitionList, Money, PageHeader, StatusBadge, Table, Td } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { AdminDisputeDossier, ArbitrationDecision, DisputeActionResult } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, toPersianDigits } from '@/lib/format';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS, SUB_ORDER_STATUS, WALLET_BUCKET_LABELS } from '@/lib/labels';

const ACTIVE = ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION'];

export default function AdminDisputeDossierPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const state = useApi<AdminDisputeDossier>(`/admin/disputes/${id}`);
  const mayArbitrate = can(user?.role, 'arbitrateDisputes');

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[600px]" />}>
      {(dossier) => (
        <>
          <PageHeader
            title="پروندهٔ اختلاف"
            description={`سفارش ${dossier.order.orderNumber} — مرسولهٔ ${dossier.package.subOrderNumber}`}
            action={
              <LinkButton href="/admin/disputes" variant="secondary">
                بازگشت
              </LinkButton>
            }
          />
          <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
            <DisputeView
              dispute={dossier}
              extra={
                <>
                  <Card title="اقلام مرسوله">
                    <Table head={['کالا', 'SKU', 'تعداد', 'قیمت واحد', 'جمع']}>
                      {dossier.items.map((item) => (
                        <tr key={item.sku}>
                          <Td>{item.productTitle}</Td>
                          <Td>
                            <span dir="ltr" className="font-mono text-xs">
                              {item.sku}
                            </span>
                          </Td>
                          <Td>{toPersianDigits(item.quantity)}</Td>
                          <Td>
                            <Money rials={item.unitPrice} />
                          </Td>
                          <Td>
                            <Money rials={item.totalLineAmount} />
                          </Td>
                        </tr>
                      ))}
                    </Table>
                  </Card>
                  <Card title="تاریخچهٔ مرسوله">
                    <ol className="flex flex-col gap-2 text-xs">
                      {dossier.packageHistory.map((entry, index) => (
                        <li key={`${entry.createdAt}-${index}`} className="flex flex-wrap items-center gap-2">
                          <span className="text-slate-500">{formatDateTime(entry.createdAt)}</span>
                          <StatusBadge value={entry.toStatus} map={SUB_ORDER_STATUS} />
                          <span className="text-slate-500">{entry.actorRole}</span>
                          {entry.note ? <span>{entry.note}</span> : null}
                        </li>
                      ))}
                    </ol>
                  </Card>
                  <Card title="پرداخت‌ها">
                    <Table head={['درگاه', 'روش', 'وضعیت', 'نقدی', 'اعتباری', 'RRN', 'زمان']}>
                      {dossier.payments.map((payment) => (
                        <tr key={payment.id}>
                          <Td className="text-xs">{payment.gatewayName}</Td>
                          <Td className="text-xs">{PAYMENT_METHOD_LABELS[payment.paymentMethod]}</Td>
                          <Td className="text-xs">{payment.status}</Td>
                          <Td>
                            <Money rials={payment.cashAmount} />
                          </Td>
                          <Td>
                            <Money rials={payment.creditAmount} />
                          </Td>
                          <Td>
                            <span dir="ltr" className="font-mono text-xs">
                              {payment.bankRrn ?? '—'}
                            </span>
                          </Td>
                          <Td className="text-xs text-slate-500">{payment.paidAt ? formatDateTime(payment.paidAt) : '—'}</Td>
                        </tr>
                      ))}
                    </Table>
                  </Card>
                </>
              }
            />
            <aside className="flex flex-col gap-6">
              {mayArbitrate && ACTIVE.includes(dossier.status) ? <ArbitrationForm dossier={dossier} onDone={() => void state.reload()} /> : null}
              <Card title={<span className="flex items-center gap-2"><UserRound className="size-4" /> خریدار</span>}>
                <DefinitionList
                  items={[
                    { label: 'نام', value: dossier.customer.name },
                    { label: 'موبایل', value: <span dir="ltr">{formatMobile(dossier.customer.mobile)}</span> },
                  ]}
                />
              </Card>
              <Card title="سفارش">
                <DefinitionList
                  items={[
                    { label: 'وضعیت پرداخت', value: <StatusBadge value={dossier.order.paymentStatus} map={PAYMENT_STATUS} /> },
                    { label: 'روش پرداخت', value: PAYMENT_METHOD_LABELS[dossier.order.paymentMethod] },
                    { label: 'مبلغ کل', value: <Money rials={dossier.order.finalPayableAmount} /> },
                    { label: 'سهم فروشنده از مرسوله', value: <Money rials={dossier.vendorEarningsAmount} /> },
                  ]}
                />
              </Card>
              <Card title={<span className="flex items-center gap-2"><ShieldCheck className="size-4" /> وجه مسدود و کیف پول فروشنده</span>}>
                <DefinitionList
                  items={[
                    { label: 'مبلغ مسدود', value: <Money rials={dossier.hold.amount} /> },
                    { label: 'منبع', value: dossier.hold.source ? WALLET_BUCKET_LABELS[dossier.hold.source] : '—' },
                    { label: 'کسری', value: <Money rials={dossier.hold.shortfall} /> },
                    { label: 'امانی', value: <Money rials={dossier.vendorWallet.pendingBalance} /> },
                    { label: 'قابل برداشت', value: <Money rials={dossier.vendorWallet.withdrawableBalance} /> },
                    { label: 'مسدود (اختلاف)', value: <Money rials={dossier.vendorWallet.disputeHoldBalance} /> },
                  ]}
                />
              </Card>
            </aside>
          </div>
        </>
      )}
    </AsyncView>
  );
}

function ArbitrationForm({ dossier, onDone }: { dossier: AdminDisputeDossier; onDone: () => void }) {
  const toast = useToast();
  const [decision, setDecision] = useState<ArbitrationDecision | ''>('');
  const [notes, setNotes] = useState('');
  const [itemReturned, setItemReturned] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const arbitrate = useMutation((body: Record<string, unknown>) => apiPost<DisputeActionResult>(`/admin/disputes/${dossier.id}/arbitrate`, body));
  const creditOrder = dossier.order.paymentMethod !== 'CASH_IPG';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!decision) return setLocalError('رأی را انتخاب کنید.');
    if (notes.trim().length < 10) return setLocalError('استدلال رأی را دست‌کم در ۱۰ نویسه بنویسید؛ برای هر دو طرف نمایش داده می‌شود.');
    setLocalError(null);
    const body: Record<string, unknown> = { decision, resolutionNotes: notes.trim() };
    if (decision === 'BUYER_FAVOR') body.itemReturned = itemReturned;
    const result = await arbitrate.run(body);
    if (result) {
      toast.success('رأی نهایی ثبت شد.');
      onDone();
    }
  }

  return (
    <Card title={<span className="flex items-center gap-2"><Gavel className="size-5 text-brand-600" /> رأی نهایی</span>}>
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="رأی">
          {(
            [
              ['BUYER_FAVOR', 'به نفع خریدار', 'مرسوله مرجوع و مبلغ بازپرداخت می‌شود.'],
              ['VENDOR_FAVOR', 'به نفع فروشنده', 'مرسوله تحویل‌شده و مبلغ آزاد می‌شود.'],
            ] as const
          ).map(([value, title, text]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={decision === value}
              disabled={value === 'BUYER_FAVOR' && creditOrder}
              onClick={() => setDecision(value)}
              className={`rounded-xl border p-3 text-start disabled:cursor-not-allowed disabled:opacity-50 ${decision === value ? (value === 'BUYER_FAVOR' ? 'border-rose-400 bg-rose-50' : 'border-emerald-400 bg-emerald-50') : 'border-slate-200'}`}
            >
              <span className="block text-sm font-bold">{title}</span>
              <span className="text-xs text-slate-600">{text}</span>
            </button>
          ))}
        </div>
        {creditOrder ? (
          <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">
            این سفارش با اعتبار بانکی/ترکیبی پرداخت شده است. سرور بازپرداخت یا لغو مرسوله‌های چنین سفارش‌هایی را نمی‌پذیرد (CREDIT_ORDER_REFUND_UNSUPPORTED)، بنابراین رأی به نفع خریدار در اینجا ممکن نیست؛ استرداد باید با بانک اعتباردهنده به‌صورت دستی پیگیری شود.
          </p>
        ) : null}
        <Field label="استدلال رأی" required hint="۱۰ تا ۲۰۰۰ نویسه">
          {(id, described) => <Textarea id={id} aria-describedby={described} rows={5} maxLength={2000} value={notes} onChange={(event) => setNotes(event.target.value)} />}
        </Field>
        {decision === 'BUYER_FAVOR' ? <Checkbox label="کالا به فروشنده بازگشته است (موجودی افزوده شود)" checked={itemReturned} onChange={(event) => setItemReturned(event.target.checked)} /> : null}
        <FormError message={localError ?? arbitrate.error?.message} />
        <Button type="submit" loading={arbitrate.pending} icon={<Gavel className="size-4" />}>
          ثبت رأی نهایی
        </Button>
      </form>
    </Card>
  );
}
```

### `apps/frontend/src/app/admin/disputes/page.tsx`

```tsx
'use client';

import { DisputeList } from '@/components/disputes/dispute-list';
import { PageHeader } from '@/components/ui/misc';
import type { AdminDisputeSummary } from '@/lib/api/types';

export default function AdminDisputesPage() {
  return (
    <>
      <PageHeader title="داوری اختلاف‌ها" description="پرونده‌های در انتظار داوری را بررسی و رأی نهایی صادر کنید." />
      <DisputeList<AdminDisputeSummary>
        endpoint="/admin/disputes"
        hrefBase="/admin/disputes"
        emptyText="پرونده‌ای با این وضعیت وجود ندارد."
        partyColumn={{ head: 'خریدار', cell: (dispute) => <span>{dispute.customer.name}</span> }}
      />
    </>
  );
}
```

### `apps/frontend/src/app/admin/financial/page.tsx`

```tsx
'use client';

import { AlertTriangle, Banknote, CheckCircle2, CreditCard, Landmark, Lock, Scale, ShoppingBag, Wallet } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Card, Money, PageHeader, StatCard } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import type { FinancialOverview } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime } from '@/lib/format';

/** A calendar day picked in the browser, as the start of that day in Tehran time. */
function tehranDayStart(day: string): string {
  return `${day}T00:00:00+03:30`;
}

function nextDay(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function Row({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between py-1.5 text-sm ${strong ? 'border-t border-slate-100 pt-2 font-bold' : ''}`}>
      <span className="text-slate-600">{label}</span>
      <Money rials={value} />
    </div>
  );
}

export default function AdminFinancialPage() {
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [applied, setApplied] = useState<{ from?: string; to?: string }>({});
  const state = useApi<FinancialOverview>('/admin/financial/overview', applied);

  return (
    <>
      <PageHeader title="گزارش مالی" description="فروش، کارمزد، وجوه امانی و تعهدات پرداخت — از دفتر کل واقعی" />
      <Card className="mb-6">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            setApplied({ ...(fromDay ? { from: tehranDayStart(fromDay) } : {}), ...(toDay ? { to: tehranDayStart(nextDay(toDay)) } : {}) });
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            از تاریخ (میلادی)
            <Input type="date" dir="ltr" value={fromDay} onChange={(event) => setFromDay(event.target.value)} className="w-44" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            تا تاریخ (شامل)
            <Input type="date" dir="ltr" value={toDay} min={fromDay || undefined} onChange={(event) => setToDay(event.target.value)} className="w-44" />
          </label>
          <Button type="submit">اعمال بازه</Button>
          {applied.from || applied.to ? (
            <Button
              variant="ghost"
              onClick={() => {
                setFromDay('');
                setToDay('');
                setApplied({});
              }}
            >
              کل دوره
            </Button>
          ) : null}
          <span className="ms-auto text-xs text-slate-500">بازه فقط روی ارقام فروش اثر دارد؛ مانده‌ها همیشه لحظه‌ای‌اند.</span>
        </form>
      </Card>

      <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
        {(data) => (
          <div className="flex flex-col gap-6">
            {!data.wallets.ledgerConsistent ? (
              <div className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                <AlertTriangle className="mt-0.5 size-5 shrink-0" /> ناهمخوانی دفتر کل: مانده‌ی {formatCount(data.wallets.inconsistentWallets)} کیف پول با جمع تراکنش‌هایش برابر نیست. پیش از پرداخت تسویه‌ها بررسی شود.
              </div>
            ) : null}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <StatCard label="ارزش ناخالص فروش (GMV)" value={<Money rials={data.sales.gmv} />} icon={<ShoppingBag className="size-5" />} tone="info" />
              <StatCard label="کارمزد قطعی" value={<Money rials={data.commission.earned} />} icon={<Banknote className="size-5" />} tone="success" hint={<>در انتظار: <Money rials={data.commission.pending} /></>} />
              <StatCard label="وجوه امانی (Escrow)" value={<Money rials={data.wallets.escrowHeld} />} icon={<Lock className="size-5" />} tone="warning" />
              <StatCard label="قابل برداشت فروشندگان" value={<Money rials={data.wallets.withdrawable} />} icon={<Wallet className="size-5" />} />
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <Card title={<span className="flex items-center gap-2"><ShoppingBag className="size-4 text-brand-600" /> فروش</span>}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-slate-600">سفارش‌های پرداخت‌شده</span>
                  <b>{formatCount(data.sales.paidOrders)}</b>
                </div>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-slate-600">مرسوله‌های فعال</span>
                  <b>{formatCount(data.sales.activePackages)}</b>
                </div>
                <Row label="هزینهٔ ارسال" value={data.sales.shippingFees} />
                <Row label="دریافت از درگاه" value={data.sales.collectedByGateway} />
                <Row label="تأمین از اعتبار بانکی" value={data.sales.fundedByCredit} />
                <Row label="اقساط وصول‌شده" value={data.sales.installmentsCollected} />
                <Row label="GMV" value={data.sales.gmv} strong />
              </Card>
              <Card title={<span className="flex items-center gap-2"><Wallet className="size-4 text-brand-600" /> کیف پول‌ها</span>}>
                <Row label="امانی (در انتظار تحویل)" value={data.wallets.escrowHeld} />
                <Row label="قابل برداشت" value={data.wallets.withdrawable} />
                <Row label="در حال تسویه" value={data.wallets.settlementHold} />
                <Row label="مسدود (اختلاف)" value={data.wallets.disputeHold} />
                <Row label="کل پرداخت‌شده به فروشندگان" value={data.wallets.totalWithdrawn} strong />
                <p className="mt-2 flex items-center gap-1 text-xs text-slate-500">
                  {data.wallets.ledgerConsistent ? <CheckCircle2 className="size-3 text-emerald-600" /> : <AlertTriangle className="size-3 text-rose-600" />}
                  {data.wallets.ledgerConsistent ? 'دفتر کل همخوان است' : 'دفتر کل ناهمخوان است'}
                </p>
              </Card>
              <Card title={<span className="flex items-center gap-2"><Landmark className="size-4 text-brand-600" /> تسویه و تعهدات</span>}>
                <div className="mb-2 flex justify-between text-sm">
                  <span className="text-slate-600">تسویه‌های در انتظار</span>
                  <b>{formatCount(data.settlements.pendingCount)}</b>
                </div>
                <Row label="مبلغ در انتظار" value={data.settlements.pendingAmount} />
                <div className="my-2 flex justify-between text-sm">
                  <span className="text-slate-600">تسویه‌های پرداخت‌شده</span>
                  <b>{formatCount(data.settlements.paidCount)}</b>
                </div>
                <Row label="مبلغ پرداخت‌شده" value={data.settlements.paidAmount} />
                <div className="mt-2 flex justify-between border-t border-slate-100 pt-2 text-sm">
                  <span className="flex items-center gap-1 text-slate-600">
                    <CreditCard className="size-4" /> پرداخت‌های نیازمند استرداد دستی
                  </span>
                  <b className={data.paymentsRequiringManualRefund > 0 ? 'text-rose-600' : ''}>{formatCount(data.paymentsRequiringManualRefund)}</b>
                </div>
              </Card>
            </div>
            <Card title={<span className="flex items-center gap-2"><Scale className="size-4 text-brand-600" /> اختلاف‌ها</span>}>
              <div className="grid gap-4 text-sm sm:grid-cols-5">
                <div>
                  <div className="text-slate-500">باز</div>
                  <b>{formatCount(data.disputes.open)}</b>
                </div>
                <div>
                  <div className="text-slate-500">در داوری</div>
                  <b>{formatCount(data.disputes.underArbitration)}</b>
                </div>
                <div>
                  <div className="text-slate-500">به نفع خریدار</div>
                  <b>{formatCount(data.disputes.resolvedForBuyer)}</b>
                </div>
                <div>
                  <div className="text-slate-500">بدهی استرداد به خریداران</div>
                  <Money rials={data.disputes.refundsOwedToCustomers} className="font-bold" />
                </div>
                <div>
                  <div className="text-slate-500">درآمد وصول‌نشده از فروشندگان</div>
                  <Money rials={data.disputes.unrecoveredVendorEarnings} className="font-bold" />
                </div>
              </div>
            </Card>
            <p className="text-xs text-slate-500">
              تولید گزارش: {formatDateTime(data.generatedAt)}
              {data.from || data.to ? ` — بازهٔ فروش: ${data.from ? formatDateTime(data.from) : 'ابتدا'} تا ${data.to ? formatDateTime(data.to) : 'اکنون'}` : ''}
            </p>
          </div>
        )}
      </AsyncView>
    </>
  );
}
```

### `apps/frontend/src/app/admin/layout.tsx`

```tsx
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/layout/dashboard-shell';
import { SiteHeader } from '@/components/layout/site-header';

export const dynamic = 'force-dynamic';

/** Access is enforced by src/middleware.ts (role guard) and again by every backend endpoint. */
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <DashboardShell area="admin">{children}</DashboardShell>
    </>
  );
}
```

### `apps/frontend/src/app/admin/page.tsx`

```tsx
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { homeForRole } from '@/lib/auth/access';
import { ACCESS_COOKIE, readAccessClaims } from '@/lib/auth/session-core';

/** /admin itself has no content: send the user to their role's landing page (middleware already enforced access). */
export default async function AdminIndexPage() {
  const claims = readAccessClaims((await cookies()).get(ACCESS_COOKIE)?.value);
  redirect(claims ? homeForRole(claims.role) : '/login');
}
```

### `apps/frontend/src/app/admin/products/page.tsx`

```tsx
'use client';

import { Ban, ExternalLink, Package, Search, ShieldCheck } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Money, PageHeader, Pagination, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { ProductStatusBadge } from '@/components/vendor/product-status-badge';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AdminProduct, Page } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useDebounced, useMutation } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime } from '@/lib/format';

type Filter = 'all' | 'published' | 'blocked';

export default function AdminProductsPage() {
  const { user } = useSession();
  const toast = useToast();
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
  const [vendorSlug, setVendorSlug] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const vendorTerm = useDebounced(vendorSlug.trim().toLowerCase(), 400);
  const state = useApi<Page<AdminProduct>>('/admin/products', {
    search: term || undefined,
    vendorSlug: vendorTerm || undefined,
    isBlockedByAdmin: filter === 'blocked' ? true : undefined,
    isPublished: filter === 'published' ? true : undefined,
    page,
    pageSize: 20,
  });
  const [blocking, setBlocking] = useState<AdminProduct | null>(null);
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const moderate = useMutation((args: { id: string; body: Record<string, unknown> }) => apiPatch<AdminProduct>(`/admin/products/${args.id}/status`, args.body));
  const [unblockingId, setUnblockingId] = useState<string | null>(null);
  const mayModerate = can(user?.role, 'moderateProducts');

  async function block() {
    if (!blocking) return;
    if (reason.trim().length < 10) return setLocalError('علت مسدودسازی را دست‌کم در ۱۰ نویسه بنویسید؛ برای فروشنده نمایش داده می‌شود.');
    setLocalError(null);
    const result = await moderate.run({ id: blocking.id, body: { isBlockedByAdmin: true, blockedReason: reason.trim() } });
    if (result) {
      toast.success('محصول مسدود و از فروشگاه برداشته شد.');
      setBlocking(null);
      setReason('');
      await state.reload();
    }
  }

  async function unblock(product: AdminProduct) {
    setUnblockingId(product.id);
    try {
      await apiPatch<AdminProduct>(`/admin/products/${product.id}/status`, { isBlockedByAdmin: false });
      toast.success('مسدودی برداشته شد؛ انتشار دوباره با فروشنده است.');
      await state.reload();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setUnblockingId(null);
    }
  }

  return (
    <>
      <PageHeader title="نظارت بر محصولات" description="مسدودسازی محصولات ناقض قوانین با ذکر علت" />
      <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap gap-2">
          {(
            [
              ['all', 'همه'],
              ['published', 'منتشرشده'],
              ['blocked', 'مسدود'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={filter === value}
              onClick={() => {
                setFilter(value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${filter === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative sm:w-64">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
            <Input
              placeholder="عنوان یا SKU"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              className="ps-9"
            />
          </div>
          <Input
            dir="ltr"
            placeholder="vendor slug"
            aria-label="نامک فروشگاه"
            value={vendorSlug}
            onChange={(event) => {
              setVendorSlug(event.target.value);
              setPage(1);
            }}
            className="sm:w-44"
          />
        </div>
      </div>
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Package className="size-8" />} title="محصولی یافت نشد" />}>
        {(data) => (
          <>
            <Table head={['محصول', 'فروشگاه', 'قیمت پایه', 'موجودی', 'وضعیت', 'به‌روزرسانی', '']}>
              {data.items.map((product) => (
                <tr key={product.id}>
                  <Td>
                    <div className="flex items-center gap-3">
                      <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border bg-slate-50">
                        {product.primaryImage ? <Image src={product.primaryImage.thumbnailUrl ?? product.primaryImage.url} alt="" fill sizes="48px" className="object-cover" unoptimized /> : null}
                      </span>
                      <div>
                        <div className="line-clamp-2 font-medium">{product.title}</div>
                        <div className="text-xs text-slate-500">{product.category.titleFa}</div>
                      </div>
                    </div>
                    {product.moderation.blockedReason ? <div className="mt-1 text-xs text-rose-700">علت: {product.moderation.blockedReason}</div> : null}
                  </Td>
                  <Td>
                    <div>{product.vendor.storeName}</div>
                    <div dir="ltr" className="text-end text-xs text-slate-500">
                      {product.vendor.storeSlug}
                    </div>
                  </Td>
                  <Td>
                    <Money rials={product.basePrice} />
                  </Td>
                  <Td>{formatCount(product.stock.totalAvailable)}</Td>
                  <Td>
                    <ProductStatusBadge product={product} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(product.updatedAt)}</Td>
                  <Td>
                    <div className="flex items-center gap-1">
                      {product.isPublished && !product.moderation.isBlockedByAdmin ? (
                        <Link href={`/products/${product.slug}`} target="_blank" aria-label="مشاهده در فروشگاه" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100">
                          <ExternalLink className="size-4" />
                        </Link>
                      ) : null}
                      {mayModerate ? (
                        product.moderation.isBlockedByAdmin ? (
                          <Button size="sm" variant="secondary" icon={<ShieldCheck className="size-4" />} loading={unblockingId === product.id} onClick={() => void unblock(product)}>
                            رفع مسدودی
                          </Button>
                        ) : (
                          <Button size="sm" variant="danger" icon={<Ban className="size-4" />} onClick={() => setBlocking(product)}>
                            مسدود
                          </Button>
                        )
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>

      <Modal
        open={blocking !== null}
        onClose={() => setBlocking(null)}
        title={`مسدودسازی «${blocking?.title ?? ''}»`}
        footer={
          <>
            <Button variant="danger" loading={moderate.pending} onClick={() => void block()}>
              مسدود شود
            </Button>
            <Button variant="secondary" onClick={() => setBlocking(null)}>
              انصراف
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <Field label="علت" required hint="۱۰ تا ۵۰۰ نویسه؛ به فروشنده نمایش داده می‌شود.">
            {(id, described) => <Textarea id={id} aria-describedby={described} rows={4} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </Field>
          <FormError message={localError ?? moderate.error?.message} />
        </div>
      </Modal>
    </>
  );
}
```

### `apps/frontend/src/app/admin/settlements/page.tsx`

```tsx
'use client';

import { CheckCircle2, Landmark, XCircle } from 'lucide-react';
import { useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Money, PageHeader, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import type { Page, SettlementRequest, SettlementStatus } from '@/lib/api/types';
import { SETTLEMENT_STATUSES } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { SETTLEMENT_STATUS } from '@/lib/labels';

const PAYA_REFERENCE = /^[A-Za-z0-9-]{4,60}$/;
type Decision = { kind: 'APPROVE' | 'REJECT'; item: SettlementRequest };

export default function AdminSettlementsPage() {
  const { user } = useSession();
  const [status, setStatus] = useState<SettlementStatus | ''>('REQUESTED');
  const [page, setPage] = useState(1);
  const state = useApi<Page<SettlementRequest>>('/admin/settlements', { status: status || undefined, page, pageSize: 20 });
  const [decision, setDecision] = useState<Decision | null>(null);
  const mayProcess = can(user?.role, 'processSettlements');

  return (
    <>
      <PageHeader title="تسویه‌ها" description="پرداخت درخواست‌های تسویهٔ فروشندگان از طریق پایا و ثبت شمارهٔ پیگیری" />
      <div className="mb-4 flex flex-wrap gap-2">
        {(['', ...SETTLEMENT_STATUSES] as const).map((value) => (
          <button
            key={value || 'all'}
            type="button"
            aria-pressed={status === value}
            onClick={() => {
              setStatus(value);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-xs ${status === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
          >
            {value ? SETTLEMENT_STATUS[value].label : 'همه'}
          </button>
        ))}
      </div>
      {!mayProcess ? <p className="mb-4 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-600">نقش شما فقط امکان مشاهده دارد؛ پرداخت تسویه با مسئول مالی یا مدیر ارشد است.</p> : null}
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Landmark className="size-8" />} title="درخواستی با این وضعیت نیست" />}>
        {(data) => (
          <>
            <Table head={['فروشگاه', 'مبلغ', 'شبای مقصد', 'وضعیت', 'پیگیری پایا', 'ثبت', 'رسیدگی', '']}>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <Td className="font-medium">{item.storeName}</Td>
                  <Td className="font-bold">
                    <Money rials={item.amount} />
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.targetIban}
                    </span>
                  </Td>
                  <Td>
                    <StatusBadge value={item.status} map={SETTLEMENT_STATUS} />
                    {item.rejectionReason ? <div className="mt-1 max-w-48 text-xs text-rose-700">{item.rejectionReason}</div> : null}
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.bankPayaReference ?? '—'}
                    </span>
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(item.createdAt)}</Td>
                  <Td className="text-xs text-slate-500">
                    {item.processedAt ? formatDateTime(item.processedAt) : '—'}
                    {item.processedBy?.fullName ? <div>{item.processedBy.fullName}</div> : null}
                  </Td>
                  <Td>
                    {mayProcess && (item.status === 'REQUESTED' || item.status === 'PROCESSING') ? (
                      <div className="flex gap-1">
                        <Button size="sm" variant="success" icon={<CheckCircle2 className="size-4" />} onClick={() => setDecision({ kind: 'APPROVE', item })}>
                          پرداخت
                        </Button>
                        <Button size="sm" variant="ghost" className="text-rose-600" icon={<XCircle className="size-4" />} onClick={() => setDecision({ kind: 'REJECT', item })}>
                          رد
                        </Button>
                      </div>
                    ) : null}
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
      {decision ? (
        <DecisionModal
          decision={decision}
          onClose={() => setDecision(null)}
          onDone={() => {
            setDecision(null);
            void state.reload();
          }}
        />
      ) : null}
    </>
  );
}

function DecisionModal({ decision, onClose, onDone }: { decision: Decision; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const process = useMutation((body: Record<string, string>) => apiPatch<SettlementRequest>(`/admin/settlements/${decision.item.id}/process`, body));
  const approve = decision.kind === 'APPROVE';

  async function submit() {
    let body: Record<string, string>;
    if (approve) {
      if (!PAYA_REFERENCE.test(reference.trim())) return setLocalError('شمارهٔ پیگیری پایا ۴ تا ۶۰ نویسه و فقط حروف لاتین، رقم و خط تیره است.');
      body = { action: 'APPROVE', payaReferenceNumber: reference.trim() };
    } else {
      if (reason.trim().length < 5) return setLocalError('علت رد را دست‌کم در ۵ نویسه بنویسید.');
      body = { action: 'REJECT', rejectionReason: reason.trim() };
    }
    setLocalError(null);
    const result = await process.run(body);
    if (result) {
      toast.success(approve ? 'پرداخت تسویه ثبت شد.' : 'درخواست رد شد و مبلغ به موجودی قابل برداشت فروشنده بازگشت.');
      onDone();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={approve ? 'ثبت پرداخت پایا' : 'رد درخواست تسویه'}
      footer={
        <>
          <Button variant={approve ? 'success' : 'danger'} loading={process.pending} onClick={() => void submit()}>
            {approve ? 'ثبت پرداخت' : 'رد درخواست'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 text-sm">
        <p className="rounded-xl bg-slate-50 px-3 py-2 leading-7">
          {decision.item.storeName} — <Money rials={decision.item.amount} className="font-bold" />
          <br />
          شبا: <span dir="ltr" className="font-mono text-xs">{decision.item.targetIban}</span>
        </p>
        {approve ? (
          <>
            <p className="text-xs leading-6 text-amber-800">ابتدا مبلغ را از سامانهٔ بانک به شبای بالا (پایا) واریز کنید، سپس شمارهٔ پیگیری را ثبت کنید. این ثبت برگشت‌ناپذیر است.</p>
            <Field label="شمارهٔ پیگیری پایا" required>
              {(id) => <Input id={id} dir="ltr" maxLength={60} value={reference} onChange={(event) => setReference(event.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label="علت رد" required hint="برای فروشنده نمایش داده می‌شود.">
            {(id, described) => <Textarea id={id} aria-describedby={described} rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </Field>
        )}
        <FormError message={localError ?? process.error?.message} />
      </div>
    </Modal>
  );
}
```

### `apps/frontend/src/app/admin/vendors/[id]/page.tsx`

```tsx
'use client';

import { CheckCircle2, FileText, XCircle } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Card, DefinitionList, Money, PageHeader, StatusBadge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { VendorAdminDetail, VendorVerification } from '@/lib/api/types';
import { can } from '@/lib/auth/access';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, formatPercent, toLatinDigits, toPersianDigits } from '@/lib/format';
import { ROLE_LABELS, VENDOR_STATUS } from '@/lib/labels';

function DocLink({ href, label }: { href: string | null; label: string }) {
  if (!href) return <span className="text-xs text-slate-400">{label}: ارسال نشده</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:border-brand-300 hover:bg-brand-50">
      <FileText className="size-4 text-brand-600" /> {label}
    </a>
  );
}

export default function AdminVendorDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { user } = useSession();
  const toast = useToast();
  const state = useApi<VendorAdminDetail>(`/admin/vendors/${id}`);
  const [decision, setDecision] = useState<'APPROVED' | 'REJECTED' | null>(null);
  const [reason, setReason] = useState('');
  const [commission, setCommission] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const verify = useMutation((body: Record<string, unknown>) => apiPost<VendorAdminDetail>(`/admin/vendors/${id}/verify`, body));
  const mayReview = can(user?.role, 'reviewVendors');

  async function submit() {
    if (!decision) return;
    const body: Record<string, unknown> = { status: decision };
    if (decision === 'REJECTED') {
      if (reason.trim().length < 10) return setLocalError('علت رد را دست‌کم در ۱۰ نویسه بنویسید؛ برای فروشنده نمایش داده می‌شود.');
      body.rejectionReason = reason.trim();
    }
    if (commission.trim()) {
      const rate = Number(toLatinDigits(commission.trim()));
      if (!Number.isFinite(rate) || rate < 0 || rate > 100) return setLocalError('نرخ کارمزد باید بین ۰ تا ۱۰۰ درصد باشد.');
      body.commissionRateOverride = rate;
    }
    setLocalError(null);
    const result = await verify.run(body);
    if (result) {
      toast.success(decision === 'APPROVED' ? 'فروشگاه تأیید شد.' : 'درخواست رد شد.');
      setDecision(null);
      setReason('');
      await state.reload();
    }
  }

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(vendor) => {
        const latest: VendorVerification | undefined = vendor.verifications[0];
        const pendingReview = latest !== undefined && latest.reviewedAt === null;
        return (
          <>
            <PageHeader
              title={vendor.storeName}
              description={<span dir="ltr">/{vendor.storeSlug}</span>}
              action={
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge value={vendor.status} map={VENDOR_STATUS} />
                  <LinkButton href="/admin/vendors" variant="secondary">
                    بازگشت
                  </LinkButton>
                </div>
              }
            />
            <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
              <div className="flex flex-col gap-6">
                <Card title="مدارک احراز هویت (KYC)">
                  {vendor.verifications.length === 0 ? (
                    <p className="text-sm text-slate-500">فروشنده هنوز مدرکی ارسال نکرده است؛ تأیید بدون مدرک ممکن نیست.</p>
                  ) : (
                    <ol className="flex flex-col gap-4">
                      {vendor.verifications.map((item, index) => (
                        <li key={item.id} className={`rounded-xl border p-4 ${index === 0 ? 'border-brand-200' : 'border-slate-100 opacity-80'}`}>
                          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-sm">
                            <span className="font-medium">
                              {index === 0 ? 'آخرین ارسال' : `ارسال قبلی ${toPersianDigits(index)}`} — {formatDateTime(item.createdAt)}
                            </span>
                            <span className="text-xs text-slate-500">
                              {item.reviewedAt ? `بررسی: ${formatDateTime(item.reviewedAt)}${item.reviewedByName ? ` (${item.reviewedByName})` : ''}` : 'بررسی‌نشده'}
                            </span>
                          </div>
                          <div className="grid gap-2 sm:grid-cols-3">
                            <DocLink href={item.nationalIdCardUrl} label="کارت ملی" />
                            <DocLink href={item.businessLicenseUrl} label="جواز کسب" />
                            <DocLink href={item.bankAccountProofUrl} label="مالکیت حساب" />
                          </div>
                          {item.rejectionReason ? <p className="mt-2 text-xs text-rose-700">علت رد: {item.rejectionReason}</p> : null}
                        </li>
                      ))}
                    </ol>
                  )}
                </Card>
                <Card title="سابقهٔ تغییرات">
                  {vendor.auditTrail.length === 0 ? (
                    <p className="text-sm text-slate-500">رویدادی ثبت نشده است.</p>
                  ) : (
                    <ul className="flex flex-col gap-2 text-xs">
                      {vendor.auditTrail.map((entry) => (
                        <li key={entry.id} className="flex flex-wrap gap-2 border-b border-slate-50 pb-2">
                          <span className="text-slate-500">{formatDateTime(entry.createdAt)}</span>
                          <span className="font-mono" dir="ltr">
                            {entry.action}
                          </span>
                          <span>{entry.actorName ?? 'سیستم'}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              </div>
              <div className="flex flex-col gap-6">
                {mayReview && vendor.status !== 'APPROVED' ? (
                  <Card title="تصمیم">
                    <div className="flex flex-col gap-3">
                      {!pendingReview && vendor.status === 'REJECTED' ? <p className="text-xs text-slate-500">برای تأیید دوباره، فروشنده باید مدارک جدید ارسال کند.</p> : null}
                      <Button variant="success" icon={<CheckCircle2 className="size-4" />} disabled={!latest} onClick={() => setDecision('APPROVED')}>
                        تأیید فروشگاه
                      </Button>
                      <Button variant="danger" icon={<XCircle className="size-4" />} disabled={!pendingReview} onClick={() => setDecision('REJECTED')}>
                        رد درخواست
                      </Button>
                    </div>
                  </Card>
                ) : null}
                <Card title="مالک حساب">
                  <DefinitionList
                    items={[
                      { label: 'نام', value: vendor.owner.fullName || '—' },
                      { label: 'موبایل', value: <span dir="ltr">{formatMobile(vendor.owner.mobile)}</span> },
                      { label: 'ایمیل', value: vendor.owner.email ?? '—' },
                      { label: 'نقش', value: ROLE_LABELS[vendor.owner.role] },
                    ]}
                  />
                </Card>
                <Card title="حساب بانکی و مالی">
                  <DefinitionList
                    items={[
                      { label: 'شبا', value: <span dir="ltr" className="font-mono text-xs">{vendor.bankIban}</span> },
                      { label: 'صاحب حساب', value: vendor.bankAccountHolder ?? '—' },
                      { label: 'کارمزد اختصاصی', value: vendor.commissionRateOverride ? formatPercent(vendor.commissionRateOverride) : 'پیش‌فرض دسته' },
                      { label: 'قابل برداشت', value: vendor.wallet ? <Money rials={vendor.wallet.withdrawableBalance} /> : '—' },
                    ]}
                  />
                </Card>
                {vendor.bio ? (
                  <Card title="معرفی">
                    <p className="whitespace-pre-line text-sm leading-7">{vendor.bio}</p>
                  </Card>
                ) : null}
              </div>
            </div>

            <Modal
              open={decision !== null}
              onClose={() => setDecision(null)}
              title={decision === 'APPROVED' ? 'تأیید فروشگاه' : 'رد درخواست فروشندگی'}
              footer={
                <>
                  <Button variant={decision === 'APPROVED' ? 'success' : 'danger'} loading={verify.pending} onClick={() => void submit()}>
                    {decision === 'APPROVED' ? 'تأیید' : 'رد'}
                  </Button>
                  <Button variant="secondary" onClick={() => setDecision(null)}>
                    انصراف
                  </Button>
                </>
              }
            >
              <div className="flex flex-col gap-3">
                {decision === 'REJECTED' ? (
                  <Field label="علت رد" required hint="۱۰ تا ۱۰۰۰ نویسه؛ برای فروشنده نمایش داده می‌شود.">
                    {(fieldId, described) => <Textarea id={fieldId} aria-describedby={described} rows={4} maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} />}
                  </Field>
                ) : (
                  <p className="text-sm leading-7">با تأیید، نقش مالک به «فروشنده» تغییر می‌کند و کیف پول فروشگاه فعال می‌شود.</p>
                )}
                <Field label="کارمزد اختصاصی (درصد، اختیاری)" hint="خالی = کارمزد پیش‌فرض دسته‌بندی">
                  {(fieldId, described) => <Input id={fieldId} aria-describedby={described} dir="ltr" inputMode="decimal" value={commission} onChange={(event) => setCommission(event.target.value)} className="w-32" />}
                </Field>
                <FormError message={localError ?? verify.error?.message} />
              </div>
            </Modal>
          </>
        );
      }}
    </AsyncView>
  );
}
```

### `apps/frontend/src/app/admin/vendors/page.tsx`

```tsx
'use client';

import { ChevronLeft, Search, Store } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { Input } from '@/components/ui/field';
import { PageHeader, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import type { Page, VendorAdminSummary, VendorStatus } from '@/lib/api/types';
import { useApi, useDebounced } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime, formatMobile } from '@/lib/format';
import { VENDOR_STATUS } from '@/lib/labels';

const FILTERS: Array<VendorStatus | ''> = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', ''];

export default function AdminVendorsPage() {
  const [status, setStatus] = useState<VendorStatus | ''>('PENDING');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const state = useApi<Page<VendorAdminSummary>>('/admin/vendors', { status: status || undefined, search: term || undefined, page, pageSize: 20 });

  return (
    <>
      <PageHeader title="فروشندگان و احراز هویت" description="بررسی درخواست‌های فروشندگی و مدارک KYC" />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((value) => (
            <button
              key={value || 'all'}
              type="button"
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${status === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
            >
              {value ? VENDOR_STATUS[value].label : 'همه'}
            </button>
          ))}
        </div>
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
          <Input
            placeholder="نام یا نامک فروشگاه"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="ps-9"
          />
        </div>
      </div>
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Store className="size-8" />} title="فروشنده‌ای با این شرایط نیست" />}>
        {(data) => (
          <>
            <Table head={['فروشگاه', 'مالک', 'محصولات', 'وضعیت', 'ثبت', '']}>
              {data.items.map((vendor) => (
                <tr key={vendor.id}>
                  <Td>
                    <div className="font-medium">{vendor.storeName}</div>
                    <div dir="ltr" className="text-end text-xs text-slate-500">
                      /{vendor.storeSlug}
                    </div>
                  </Td>
                  <Td>
                    <div>{vendor.owner.fullName || '—'}</div>
                    <div dir="ltr" className="text-end text-xs text-slate-500">
                      {formatMobile(vendor.owner.mobile)}
                    </div>
                  </Td>
                  <Td>{formatCount(vendor.productCount)}</Td>
                  <Td>
                    <StatusBadge value={vendor.status} map={VENDOR_STATUS} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(vendor.createdAt)}</Td>
                  <Td>
                    <Link href={`/admin/vendors/${vendor.id}`} className="flex items-center gap-1 text-sm text-brand-700 hover:underline">
                      بررسی <ChevronLeft className="size-4" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </>
  );
}
```

### `apps/frontend/src/app/api/session/otp/route.ts`

```ts
import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, isSameOrigin, jsonResponse } from '@/lib/auth/bff';

export const dynamic = 'force-dynamic';

/** Sends a sign-in code: POST { mobile } → backend auth/otp/request (rate-limited there). */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const body: unknown = await request.json().catch(() => null);
  const { mobile } = (body ?? {}) as { mobile?: unknown };
  const result = await callBackendJson(request, 'auth/otp/request', { method: 'POST', body: { mobile } });
  return jsonResponse(result.status, result.body);
}
```

### `apps/frontend/src/app/api/session/password/route.ts`

```ts
import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, completeLogin, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { isAuthTokens } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/** Staff/vendor password sign-in: POST { identifier, password } → backend auth/login/password → httpOnly cookies. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const body: unknown = await request.json().catch(() => null);
  const { identifier, password } = (body ?? {}) as { identifier?: unknown; password?: unknown };
  const result = await callBackendJson(request, 'auth/login/password', { method: 'POST', body: { identifier, password } });
  if (result.status >= 300 || !isAuthTokens(result.body)) {
    return jsonResponse(result.status >= 300 ? result.status : 502, result.body);
  }
  return completeLogin(request, result.body);
}
```

### `apps/frontend/src/app/api/session/route.ts`

```ts
import type { NextRequest } from 'next/server';

import type { Me } from '@/lib/api/types';
import { CROSS_SITE_BODY, applyCookies, callBackendJson, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearedSessionCookies,
  isAccessTokenFresh,
  readAccessClaims,
  refreshAtBackend,
  sessionCookies,
  shouldUseSecureCookies,
  type CookieSpec,
} from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * GET: the signed-in identity (backend auth/me) or `{ user: null }`.
 * Refreshes the session when the access token expired, and also when the
 * role stored in the token no longer matches the account (e.g. a customer
 * whose store was just approved becomes VENDOR) so routing follows at once.
 */
export async function GET(request: NextRequest) {
  const secure = shouldUseSecureCookies(request.headers, request.url);
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  const cookies: CookieSpec[] = [];

  const rotate = async (): Promise<boolean> => {
    if (!refreshToken) {
      return false;
    }
    const tokens = await refreshAtBackend(refreshToken, request.headers);
    if (!tokens) {
      cookies.push(...clearedSessionCookies(secure));
      return false;
    }
    accessToken = tokens.accessToken;
    cookies.push(...sessionCookies(tokens, secure));
    return true;
  };

  if (!isAccessTokenFresh(readAccessClaims(accessToken)) && !(await rotate())) {
    return applyCookies(jsonResponse(200, { user: null }), cookies);
  }

  let me = await callBackendJson(request, 'auth/me', { method: 'GET', accessToken });
  if (me.status === 401 && cookies.length === 0 && (await rotate())) {
    me = await callBackendJson(request, 'auth/me', { method: 'GET', accessToken });
  }
  if (me.status === 401) {
    return applyCookies(jsonResponse(200, { user: null }), [...cookies, ...clearedSessionCookies(secure)]);
  }
  if (me.status >= 300) {
    return applyCookies(jsonResponse(me.status, me.body), cookies);
  }

  const identity = me.body as Me;
  const tokenRole = readAccessClaims(accessToken)?.role;
  if (tokenRole !== undefined && tokenRole !== identity.user.role && cookies.length === 0) {
    await rotate();
  }
  return applyCookies(jsonResponse(200, identity), cookies);
}

/** DELETE: sign out — revokes the refresh session at the backend and clears the cookies. */
export async function DELETE(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const secure = shouldUseSecureCookies(request.headers, request.url);
  let refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let accessToken = request.cookies.get(ACCESS_COOKIE)?.value;
  let revoked = false;
  // Backend logout authenticates with the access token. When it has expired,
  // rotate the refresh token first: rotation already invalidates the old
  // refresh token, and logging out with the fresh pair revokes the new session.
  // Without this, an expired access token would leave the server-side session
  // (and the refresh token) alive after "sign out".
  if (refreshToken && !isAccessTokenFresh(readAccessClaims(accessToken))) {
    const rotated = await refreshAtBackend(refreshToken, request.headers);
    if (rotated) {
      accessToken = rotated.accessToken;
      refreshToken = rotated.refreshToken;
    } else {
      // The refresh token is already unusable (expired/revoked): nothing left to revoke.
      accessToken = undefined;
      refreshToken = undefined;
      revoked = true;
    }
  }
  if (accessToken) {
    const result = await callBackendJson(request, 'auth/logout', {
      method: 'POST',
      accessToken,
      body: refreshToken ? { refreshToken } : {},
    });
    revoked = result.status < 300;
  }
  return applyCookies(jsonResponse(200, { signedOut: true, revoked }), clearedSessionCookies(secure));
}
```

### `apps/frontend/src/app/api/session/verify/route.ts`

```ts
import type { NextRequest } from 'next/server';

import { CROSS_SITE_BODY, callBackendJson, completeLogin, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import { isAuthTokens } from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/** OTP sign-in: POST { mobile, code } → backend auth/otp/verify → httpOnly cookies. */
export async function POST(request: NextRequest) {
  if (!isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }
  const body: unknown = await request.json().catch(() => null);
  const { mobile, code } = (body ?? {}) as { mobile?: unknown; code?: unknown };
  const result = await callBackendJson(request, 'auth/otp/verify', { method: 'POST', body: { mobile, code } });
  if (result.status >= 300 || !isAuthTokens(result.body)) {
    return jsonResponse(result.status >= 300 ? result.status : 502, result.body);
  }
  return completeLogin(request, result.body);
}
```

### `apps/frontend/src/app/api/v1/[...path]/route.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';

import { CROSS_SITE_BODY, applyCookies, isSameOrigin, jsonResponse } from '@/lib/auth/bff';
import {
  ACCESS_COOKIE,
  CART_COOKIE,
  REFRESH_COOKIE,
  backendOrigin,
  cartCookie,
  clearedSessionCookies,
  forwardingHeaders,
  isAccessTokenFresh,
  readAccessClaims,
  refreshAtBackend,
  sessionCookies,
  shouldUseSecureCookies,
  type CookieSpec,
} from '@/lib/auth/session-core';

export const dynamic = 'force-dynamic';

/**
 * Backend-for-frontend proxy: every browser call to /api/v1/* lands here and
 * is forwarded to the backend with
 *
 * - `Authorization: Bearer <access token>` from the httpOnly cookie,
 * - `X-Cart-Token` from the guest-cart cookie,
 * - one transparent refresh + retry when the backend answers 401,
 * - request/response bodies passed through byte-for-byte (JSON, multipart
 *   uploads, document downloads, the sandbox bank page's HTML/forms) and
 *   redirects handed to the browser unchanged (payment callback → result page).
 *
 * Token-issuing endpoints are not reachable through here — they would put the
 * tokens in reach of browser JavaScript. Sign-in/out goes through /api/session.
 */

const BLOCKED_PATHS = new Set(['auth/otp/verify', 'auth/login/password', 'auth/refresh', 'auth/logout']);

/**
 * Called by the bank, possibly as a cross-site form POST. Public at the
 * backend and verified server-to-server with the gateway, so the same-origin
 * check does not apply.
 */
const CROSS_SITE_ALLOWED = new Set(['payments/callback']);

/** Request headers worth forwarding (everything else is hop-by-hop or identity we set ourselves). */
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'if-none-match', 'if-modified-since', 'range'];

/** Response headers the browser must not receive from upstream as-is. */
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'set-cookie']);

type RouteContext = { params: Promise<{ path: string[] }> };

async function forward(request: NextRequest, path: string, body: ArrayBuffer | undefined, accessToken: string | undefined): Promise<Response> {
  const headers = new Headers(forwardingHeaders(request.headers));
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  if (accessToken) {
    headers.set('Authorization', `Bearer ${accessToken}`);
  }
  const cartToken = request.cookies.get(CART_COOKIE)?.value;
  if (cartToken) {
    headers.set('X-Cart-Token', cartToken);
  }
  return fetch(`${backendOrigin()}/api/v1/${path}${request.nextUrl.search}`, {
    method: request.method,
    headers,
    body,
    redirect: 'manual',
    cache: 'no-store',
  });
}

async function handle(request: NextRequest, context: RouteContext): Promise<Response> {
  const { path: segments } = await context.params;
  const path = segments.map((segment) => encodeURIComponent(segment)).join('/');

  if (BLOCKED_PATHS.has(path)) {
    return jsonResponse(404, { statusCode: 404, error: 'Not Found', message: 'Use /api/session for sign-in, refresh and sign-out.' });
  }
  const mutating = request.method !== 'GET' && request.method !== 'HEAD';
  if (mutating && !CROSS_SITE_ALLOWED.has(path) && !isSameOrigin(request)) {
    return jsonResponse(403, CROSS_SITE_BODY);
  }

  const secure = shouldUseSecureCookies(request.headers, request.url);
  const cookies: CookieSpec[] = [];
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let accessToken = request.cookies.get(ACCESS_COOKIE)?.value;

  const rotate = async (): Promise<boolean> => {
    if (!refreshToken) {
      return false;
    }
    const tokens = await refreshAtBackend(refreshToken, request.headers);
    if (!tokens) {
      accessToken = undefined;
      cookies.push(...clearedSessionCookies(secure));
      return false;
    }
    accessToken = tokens.accessToken;
    cookies.push(...sessionCookies(tokens, secure));
    return true;
  };

  // Refresh up front when we already know the access token is stale.
  if (!isAccessTokenFresh(readAccessClaims(accessToken))) {
    if (refreshToken) {
      await rotate();
    } else {
      accessToken = undefined;
    }
  }

  // Buffered so the request can be replayed once after a refresh.
  const body = mutating ? await request.arrayBuffer() : undefined;

  let upstream: Response;
  try {
    upstream = await forward(request, path, body, accessToken);
    if (upstream.status === 401 && refreshToken && cookies.length === 0 && (await rotate())) {
      upstream = await forward(request, path, body, accessToken);
    }
  } catch (error) {
    console.error(`[bff] upstream request failed: ${request.method} /api/v1/${path}`, error);
    return applyCookies(
      jsonResponse(502, { statusCode: 502, error: 'Bad Gateway', message: 'سرور اصلی در دسترس نیست. کمی بعد دوباره تلاش کنید.' }),
      cookies,
    );
  }

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase())) {
      responseHeaders.set(name, value);
    }
  });

  // A guest cart is identified by the token the backend returns in the cart body.
  // Keep it in an httpOnly cookie instead of exposing it to scripts.
  const contentType = upstream.headers.get('content-type') ?? '';
  let responseBody: BodyInit | null = upstream.body;
  if (path.startsWith('cart') && upstream.ok && contentType.includes('application/json')) {
    const text = await upstream.text();
    responseBody = text;
    try {
      const parsed = JSON.parse(text) as { cartToken?: unknown; owner?: unknown };
      const current = request.cookies.get(CART_COOKIE)?.value;
      if (parsed.owner === 'guest' && typeof parsed.cartToken === 'string' && parsed.cartToken !== current) {
        cookies.push(cartCookie(parsed.cartToken, secure));
      }
    } catch {
      // Not a cart body (e.g. an empty 204): nothing to remember.
    }
  }

  const response = new NextResponse(upstream.status === 204 || upstream.status === 304 ? null : responseBody, {
    status: upstream.status,
    headers: responseHeaders,
  });
  return applyCookies(response, cookies);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
```

### `apps/frontend/src/app/customer/addresses/page.tsx`

```tsx
'use client';

import { MapPin, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import { useState } from 'react';

import { AddressFormModal } from '@/components/customer/address-form';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Badge, PageHeader } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { apiDelete, apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Address, AddressList } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatMobile, toPersianDigits } from '@/lib/format';

export default function CustomerAddressesPage() {
  const toast = useToast();
  const state = useApi<AddressList>('/customer/addresses');
  const [editing, setEditing] = useState<Address | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Address | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  async function makeDefault(address: Address) {
    setBusyId(address.id);
    try {
      await apiPatch(`/customer/addresses/${address.id}`, { isDefault: true });
      await state.reload();
      toast.success('نشانی پیش‌فرض تغییر کرد.');
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  async function remove() {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await apiDelete(`/customer/addresses/${deleting.id}`);
      setDeleting(null);
      await state.reload();
      toast.success('نشانی حذف شد.');
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  const atLimit = state.data ? state.data.total >= state.data.limit : false;

  return (
    <>
      <PageHeader
        title="نشانی‌های من"
        description={state.data ? `${toPersianDigits(state.data.total)} از ${toPersianDigits(state.data.limit)} نشانی مجاز` : undefined}
        action={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing(null)} disabled={atLimit || state.loading}>
            افزودن نشانی
          </Button>
        }
      />
      <AsyncView
        state={state}
        skeleton={<SkeletonRows rows={3} className="h-32" />}
        isEmpty={(data) => data.items.length === 0}
        empty={<EmptyState icon={<MapPin className="size-8" />} title="هنوز نشانی ثبت نکرده‌اید" description="برای ثبت سفارش دست‌کم یک نشانی لازم است." action={<Button onClick={() => setEditing(null)}>افزودن نشانی</Button>} />}
      >
        {(data) => (
          <ul className="grid gap-4 md:grid-cols-2">
            {data.items.map((address) => (
              <li key={address.id} className={`flex flex-col gap-3 rounded-2xl border bg-white p-5 ${address.isDefault ? 'border-brand-300 ring-1 ring-brand-200' : 'border-slate-200'}`}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 font-bold">
                    <MapPin className="size-4 text-brand-600" />
                    {address.province}، {address.city}
                  </div>
                  {address.isDefault ? <Badge tone="brand">پیش‌فرض</Badge> : null}
                </div>
                <p className="text-sm leading-7 text-slate-700">
                  {address.postalAddress}
                  {address.buildingNumber ? `، پلاک ${toPersianDigits(address.buildingNumber)}` : ''}
                  {address.unitNumber ? `، واحد ${toPersianDigits(address.unitNumber)}` : ''}
                </p>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                  <span>کد پستی: {toPersianDigits(address.postalCode)}</span>
                  <span>گیرنده: {address.recipientName}</span>
                  <span dir="ltr">{formatMobile(address.recipientMobile)}</span>
                </div>
                <div className="mt-auto flex flex-wrap gap-2 border-t border-slate-100 pt-3">
                  <Button size="sm" variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditing(address)}>
                    ویرایش
                  </Button>
                  {!address.isDefault ? (
                    <Button size="sm" variant="ghost" icon={<Star className="size-4" />} loading={busyId === address.id} onClick={() => void makeDefault(address)}>
                      پیش‌فرض کن
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" className="text-rose-600" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(address)}>
                    حذف
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </AsyncView>

      <AddressFormModal
        open={editing !== undefined}
        address={editing ?? undefined}
        onClose={() => setEditing(undefined)}
        onSaved={() => {
          setEditing(undefined);
          void state.reload();
        }}
      />
      <Modal
        open={deleting !== null}
        title="حذف نشانی"
        onClose={() => setDeleting(null)}
        footer={
          <>
            <Button variant="danger" loading={busyId === deleting?.id} onClick={() => void remove()}>
              حذف شود
            </Button>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              انصراف
            </Button>
          </>
        }
      >
        <p className="text-sm leading-7">
          نشانی «{deleting?.city}، {deleting?.postalAddress}» حذف شود؟ سفارش‌های قبلی تغییری نمی‌کنند، چون نشانی در زمان سفارش ذخیره شده است.
        </p>
      </Modal>
    </>
  );
}
```

### `apps/frontend/src/app/customer/credit/page.tsx`

```tsx
'use client';

import { CalendarDays, CreditCard, FlaskConical, Landmark, ShieldCheck } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input, TomanInput } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Badge, Card, Money, PageHeader, StatCard, StatusBadge } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { CreditAccount, CreditApplication, CreditPlans, Installment, InstallmentPaymentResponse, InstallmentsOverview, OrderInstallments } from '@/lib/api/types';
import { tomanToRials } from '@/lib/currency';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDate, formatPercent, toLatinDigits, toPersianDigits } from '@/lib/format';
import { isValidNationalCode } from '@/lib/iran';
import { shareOf } from '@/lib/money';
import { CREDIT_ACCOUNT_STATUS, CREDIT_APPLICATION_STATUS, INSTALLMENT_STATUS, creditDecisionReason } from '@/lib/labels';

export default function CustomerCreditPage() {
  const plans = useApi<CreditPlans>('/credit/plans');
  const account = useApi<CreditAccount>('/credit/account');
  const noAccount = account.error?.status === 404;

  const loading = (plans.loading && !plans.data) || (account.loading && !account.data && !account.error);
  if (loading) return <Skeleton className="h-[480px]" />;
  if (plans.error && !plans.data) return <ErrorState error={plans.error} onRetry={() => void plans.reload()} />;
  if (account.error && !noAccount) return <ErrorState error={account.error} onRetry={() => void account.reload()} />;

  return (
    <>
      <PageHeader title="اعتبار خرید و اقساط" description={plans.data?.provider ? `تأمین‌کنندهٔ اعتبار: ${plans.data.provider.name}` : undefined} />
      {plans.data?.provider?.isSandbox ? (
        <p className="mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" /> محیط توسعه: بانک آزمایشی (Sandbox) فعال است؛ اعتبارسنجی و تخصیص اعتبار واقعی نیست.
        </p>
      ) : null}
      {account.data ? (
        <AccountView account={account.data} plans={plans.data} />
      ) : plans.data && !plans.data.creditEnabled ? (
        <EmptyState icon={<Landmark className="size-8" />} title="خرید اقساطی فعلاً فعال نیست" description="در حال حاضر امکان درخواست اعتبار وجود ندارد. لطفاً بعداً دوباره سر بزنید." />
      ) : plans.data ? (
        <ApplyView plans={plans.data} onApproved={() => void account.reload()} />
      ) : null}
    </>
  );
}

/* ─── Apply ─────────────────────────────────────────────────────────────── */

function ApplyView({ plans, onApproved }: { plans: CreditPlans; onApproved: () => void }) {
  const [limitToman, setLimitToman] = useState('');
  const [nationalCode, setNationalCode] = useState('');
  const [docs, setDocs] = useState<UploadedFile[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [result, setResult] = useState<CreditApplication | null>(null);
  const apply = useMutation((body: { requestedLimit: number; nationalCode: string; providerCode: string; documentIds?: string[] }) => apiPost<CreditApplication>('/credit/applications', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const nextErrors: Record<string, string> = {};
    let requestedLimit = 0;
    try {
      requestedLimit = tomanToRials(limitToman);
      if (requestedLimit <= 0) nextErrors.limit = 'مبلغ اعتبار درخواستی را وارد کنید.';
    } catch (caught) {
      nextErrors.limit = caught instanceof Error ? caught.message : 'مبلغ معتبر نیست.';
    }
    const code = toLatinDigits(nationalCode.trim());
    if (!isValidNationalCode(code)) nextErrors.nationalCode = 'کد ملی معتبر نیست.';
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0 || !plans.provider) return;
    const application = await apply.run({ requestedLimit, nationalCode: code, providerCode: plans.provider.code, ...(docs.length ? { documentIds: docs.map((doc) => doc.id) } : {}) });
    if (application) {
      setResult(application);
      if (application.status === 'APPROVED') onApproved();
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
      <Card title="درخواست اعتبار خرید اقساطی">
        {result && result.status !== 'APPROVED' ? (
          <div className="mb-4 flex flex-col gap-2 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
            <div className="flex items-center gap-2">
              نتیجهٔ درخواست: <StatusBadge value={result.status} map={CREDIT_APPLICATION_STATUS} />
            </div>
            {result.decisionReason ? <p className="text-slate-700">{creditDecisionReason(result.decisionReason)}</p> : null}
            {result.trackingCode ? (
              <p className="text-xs text-slate-500">
                کد پیگیری: <span dir="ltr">{result.trackingCode}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
          <Field label="مبلغ اعتبار درخواستی (تومان)" error={errors.limit} required>
            {(id, described) => <TomanInput id={id} aria-describedby={described} value={limitToman} onChange={(event) => setLimitToman(event.target.value)} />}
          </Field>
          <Field label="کد ملی" error={errors.nationalCode} required hint="باید با کد ملی پروفایل شما یکی باشد.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="numeric" maxLength={10} value={nationalCode} onChange={(event) => setNationalCode(event.target.value)} />}
          </Field>
          <FileDrop upload={{ kind: 'document', purpose: 'other' }} value={docs} onChange={setDocs} max={10} accept="image/jpeg,image/png,image/webp,application/pdf" label="مدارک تکمیلی (اختیاری)" hint="مانند فیش حقوقی یا گردش حساب؛ برای بانک ارسال می‌شود." />
          <FormError message={apply.error?.message} />
          <Button type="submit" size="lg" loading={apply.pending} icon={<ShieldCheck className="size-5" />}>
            ارسال درخواست و اعتبارسنجی
          </Button>
        </form>
      </Card>
      <Card title="طرح‌های اقساطی">
        {plans.items.length === 0 ? (
          <p className="text-sm text-slate-500">طرحی تعریف نشده است.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm">
            {plans.items.map((plan) => (
              <li key={plan.id} className="flex items-center justify-between rounded-xl border border-slate-100 px-3 py-2">
                <span className="font-medium">{plan.title}</span>
                <Badge tone={Number(plan.interestRatePercent) === 0 ? 'success' : 'neutral'}>{Number(plan.interestRatePercent) === 0 ? 'بدون کارمزد' : `کارمزد ${formatPercent(plan.interestRatePercent)}`}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

/* ─── Account + instalments ─────────────────────────────────────────────── */

function AccountView({ account, plans }: { account: CreditAccount; plans: CreditPlans | undefined }) {
  const installments = useApi<InstallmentsOverview>('/credit/installments');
  const usedShare = shareOf(account.usedAmount, account.totalLimit);
  const reservedShare = shareOf(account.reservedAmount, account.totalLimit);

  return (
    <div className="flex flex-col gap-6">
      <Card
        title={
          <span className="flex items-center gap-2">
            <CreditCard className="size-5 text-brand-600" /> حساب اعتباری
          </span>
        }
        action={<StatusBadge value={account.status} map={CREDIT_ACCOUNT_STATUS} />}
      >
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <div className="text-xs text-slate-500">اعتبار قابل استفاده</div>
              <div className="text-2xl font-black text-emerald-700">
                <Money rials={account.availableAmount} />
              </div>
            </div>
            <div className="text-end text-sm text-slate-600">
              سقف کل: <Money rials={account.totalLimit} className="font-bold" />
              {account.expiresAt ? <div className="text-xs text-slate-500">اعتبار تا {formatDate(account.expiresAt)}</div> : null}
            </div>
          </div>
          <div className="flex h-4 w-full overflow-hidden rounded-full bg-emerald-100" role="img" aria-label="وضعیت مصرف اعتبار">
            <span className="h-full bg-brand-600" style={{ width: `${usedShare * 100}%` }} />
            <span className="h-full bg-amber-400" style={{ width: `${reservedShare * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-4 text-xs">
            <Legend color="bg-emerald-300" label="آزاد" value={account.availableAmount} />
            <Legend color="bg-brand-600" label="مصرف‌شده" value={account.usedAmount} />
            <Legend color="bg-amber-400" label="رزروشده (در انتظار پرداخت)" value={account.reservedAmount} />
          </div>
          <div className="flex flex-wrap gap-2">
            <LinkButton href="/" size="sm">
              خرید اقساطی
            </LinkButton>
            {plans?.items.length ? <span className="self-center text-xs text-slate-500">{plans.items.map((plan) => plan.title).join('، ')}</span> : null}
          </div>
        </div>
      </Card>

      <div className="grid gap-4 sm:grid-cols-3">
        <StatCard label="اقساط باقی‌مانده" value={toPersianDigits(account.outstanding.count)} icon={<CalendarDays className="size-5" />} />
        <StatCard label="اقساط معوق" value={toPersianDigits(account.outstanding.overdueCount)} tone={account.outstanding.overdueCount > 0 ? 'danger' : 'neutral'} />
        <StatCard label="سررسید بعدی" value={account.outstanding.nextDueDate ? formatDate(account.outstanding.nextDueDate) : '—'} />
      </div>

      {installments.loading && !installments.data ? (
        <Skeleton className="h-64" />
      ) : installments.error && !installments.data ? (
        <ErrorState error={installments.error} onRetry={() => void installments.reload()} />
      ) : installments.data && installments.data.orders.length === 0 ? (
        <EmptyState icon={<CalendarDays className="size-8" />} title="قسطی ندارید" description="پس از خرید اقساطی، تقویم اقساط اینجا نمایش داده می‌شود." />
      ) : installments.data ? (
        <InstallmentCalendar overview={installments.data} />
      ) : null}
    </div>
  );
}

function Legend({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`size-3 rounded-sm ${color}`} /> {label}: <Money rials={value} className="font-medium" />
    </span>
  );
}

const MONTH_FORMAT = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { year: 'numeric', month: 'long', timeZone: 'Asia/Tehran' });

function InstallmentCalendar({ overview }: { overview: InstallmentsOverview }) {
  const toast = useToast();
  const [payingId, setPayingId] = useState<string | null>(null);

  // Unpaid instalments of all orders grouped by (Persian) due month.
  const months = useMemo(() => {
    const groups = new Map<string, Array<{ installment: Installment; order: OrderInstallments }>>();
    for (const order of overview.orders) {
      for (const installment of order.installments) {
        if (installment.status !== 'PENDING' && installment.status !== 'OVERDUE') continue;
        const key = MONTH_FORMAT.format(new Date(installment.dueDate));
        const list = groups.get(key) ?? [];
        list.push({ installment, order });
        groups.set(key, list);
      }
    }
    return [...groups.entries()];
  }, [overview]);

  async function pay(installment: Installment) {
    setPayingId(installment.id);
    try {
      const payment = await apiPost<InstallmentPaymentResponse>(`/credit/installments/${installment.id}/pay`);
      window.location.assign(payment.redirectUrl);
    } catch (caught) {
      toast.error(toApiError(caught).message);
      setPayingId(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card title="تقویم اقساط" action={<span className="text-sm">باقی‌ماندهٔ کل: <Money rials={overview.totalRemaining} className="font-bold" /></span>}>
        {months.length === 0 ? (
          <p className="text-sm text-emerald-700">همهٔ اقساط پرداخت شده‌اند.</p>
        ) : (
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {months.map(([month, entries]) => (
              <section key={month} className="rounded-2xl border border-slate-200 p-4">
                <h3 className="mb-3 flex items-center gap-2 font-bold">
                  <CalendarDays className="size-4 text-brand-600" /> {month}
                </h3>
                <ul className="flex flex-col gap-3">
                  {entries.map(({ installment, order }) => (
                    <li key={installment.id} className={`flex flex-col gap-2 rounded-xl p-3 text-sm ${installment.status === 'OVERDUE' ? 'bg-rose-50' : 'bg-slate-50'}`}>
                      <div className="flex items-center justify-between">
                        <span>
                          قسط {toPersianDigits(installment.installmentNumber)} از {toPersianDigits(installment.totalInstallments)}
                        </span>
                        <StatusBadge value={installment.status} map={INSTALLMENT_STATUS} />
                      </div>
                      <div className="flex items-center justify-between text-xs text-slate-500">
                        <span dir="ltr">{order.orderNumber}</span>
                        <span>سررسید {formatDate(installment.dueDate)}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <Money rials={installment.amountDue} className="font-bold" />
                        <Button size="sm" loading={payingId === installment.id} disabled={payingId !== null && payingId !== installment.id} onClick={() => void pay(installment)}>
                          پرداخت قسط
                        </Button>
                      </div>
                      {installment.penaltyAmount !== '0.00' && installment.penaltyAmount !== '0' ? (
                        <span className="text-xs text-rose-700">
                          شامل جریمهٔ دیرکرد <Money rials={installment.penaltyAmount} />
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Card>

      {overview.orders.map((order) => (
        <Card
          key={order.parentOrderId}
          title={
            <span>
              سفارش <span dir="ltr">{order.orderNumber}</span>
              {order.plan ? <span className="ms-2 text-xs font-normal text-slate-500">{order.plan.title}</span> : null}
            </span>
          }
          action={
            <span className="text-xs text-slate-500">
              {toPersianDigits(order.paidCount)} از {toPersianDigits(order.installments.length)} پرداخت‌شده
            </span>
          }
        >
          <div className="mb-3 grid grid-cols-2 gap-2 text-xs text-slate-600 sm:grid-cols-4">
            <span>
              مبلغ اعتبار: <Money rials={order.creditAmount} />
            </span>
            <span>
              کارمزد: <Money rials={order.totalInterest} />
            </span>
            <span>
              پرداخت‌شده: <Money rials={order.paidAmount} />
            </span>
            <span>
              باقی‌مانده: <Money rials={order.remainingAmount} className="font-bold" />
            </span>
          </div>
          <ol className="grid grid-cols-3 gap-2 sm:grid-cols-6 lg:grid-cols-12">
            {order.installments.map((installment) => (
              <li
                key={installment.id}
                title={`${formatDate(installment.dueDate)} — ${INSTALLMENT_STATUS[installment.status].label}`}
                className={`flex flex-col items-center rounded-lg border px-1 py-2 text-[11px] ${
                  installment.status === 'PAID' || installment.status === 'WAIVED' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : installment.status === 'OVERDUE' ? 'border-rose-200 bg-rose-50 text-rose-800' : 'border-slate-200 bg-white text-slate-700'
                }`}
              >
                <b>{toPersianDigits(installment.installmentNumber)}</b>
                <span>{formatDate(installment.dueDate)}</span>
              </li>
            ))}
          </ol>
        </Card>
      ))}
    </div>
  );
}
```

### `apps/frontend/src/app/customer/disputes/[id]/page.tsx`

```tsx
'use client';

import { CircleSlash } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState } from 'react';

import { DisputeView } from '@/components/disputes/dispute-view';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Textarea } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { Dispute, DisputeActionResult } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';

const CANCELLABLE = ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION'];

export default function CustomerDisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const state = useApi<Dispute>(`/customer/disputes/${id}`);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useMutation((body: { reason?: string }) => apiPost<DisputeActionResult>(`/customer/disputes/${id}/cancel`, body));

  async function doCancel() {
    const text = reason.trim();
    const result = await cancel.run(text ? { reason: text } : {});
    if (result) {
      state.setData(result.dispute);
      setOpen(false);
      toast.success('اختلاف پس گرفته شد.');
    }
  }

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(dispute) => (
        <>
          <PageHeader
            title="جزئیات اختلاف"
            description={`سفارش ${dispute.package.orderNumber}`}
            action={
              <div className="flex gap-2">
                <LinkButton href="/customer/disputes" variant="secondary">
                  بازگشت
                </LinkButton>
                {CANCELLABLE.includes(dispute.status) ? (
                  <Button variant="danger" icon={<CircleSlash className="size-4" />} onClick={() => setOpen(true)}>
                    پس گرفتن اختلاف
                  </Button>
                ) : null}
              </div>
            }
          />
          <DisputeView dispute={dispute} />
          <Modal
            open={open}
            title="پس گرفتن اختلاف"
            onClose={() => setOpen(false)}
            footer={
              <>
                <Button variant="danger" loading={cancel.pending} onClick={() => void doCancel()}>
                  پس گرفته شود
                </Button>
                <Button variant="secondary" onClick={() => setOpen(false)}>
                  انصراف
                </Button>
              </>
            }
          >
            <div className="flex flex-col gap-3">
              <p className="text-sm leading-7">با پس گرفتن اختلاف، مبلغ مسدودشدهٔ فروشنده آزاد می‌شود. در صورت نیاز می‌توانید بعداً دوباره اختلاف ثبت کنید.</p>
              <Field label="توضیح (اختیاری)">{(fieldId) => <Textarea id={fieldId} rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}</Field>
              <FormError message={cancel.error?.message} />
            </div>
          </Modal>
        </>
      )}
    </AsyncView>
  );
}
```

### `apps/frontend/src/app/customer/disputes/page.tsx`

```tsx
'use client';

import { DisputeList } from '@/components/disputes/dispute-list';
import { PageHeader } from '@/components/ui/misc';

export default function CustomerDisputesPage() {
  return (
    <>
      <PageHeader title="اختلاف‌ها و مرجوعی‌ها" description="برای ثبت اختلاف جدید، از صفحهٔ جزئیات سفارش روی «ثبت اختلاف / مرجوعی» بزنید." />
      <DisputeList endpoint="/customer/disputes" hrefBase="/customer/disputes" emptyText="اختلافی ثبت نکرده‌اید." />
    </>
  );
}
```

### `apps/frontend/src/app/customer/layout.tsx`

```tsx
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/layout/dashboard-shell';
import { SiteHeader } from '@/components/layout/site-header';

export const dynamic = 'force-dynamic';

/** Access is enforced by src/middleware.ts (role guard) and again by every backend endpoint. */
export default function CustomerLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <DashboardShell area="customer">{children}</DashboardShell>
    </>
  );
}
```

### `apps/frontend/src/app/customer/orders/[id]/page.tsx`

```tsx
'use client';

import { CalendarClock, CircleCheck, CircleSlash, MapPin, Package, Scale, Truck } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useMemo, useState } from 'react';

import { DisputeFormModal } from '@/components/customer/dispute-form';
import { RetryPaymentButton } from '@/components/customer/retry-payment-button';
import { PackageStepper } from '@/components/orders/package-stepper';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Textarea } from '@/components/ui/field';
import { Badge, Card, Money, PageHeader, StatusBadge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { CustomerDeliveryConfirmation, CustomerOrderDetail, CustomerSubOrder, Dispute, Page, SubOrderStatus } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, toPersianDigits } from '@/lib/format';
import { DISPUTE_STATUS, PAYMENT_METHOD_LABELS, PAYMENT_STATUS, SUB_ORDER_STATUS, TIMELINE_EVENT_LABELS } from '@/lib/labels';

const DISPUTABLE: readonly SubOrderStatus[] = ['PROCESSING', 'SHIPPED', 'DELIVERED'];

export default function CustomerOrderDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<CustomerOrderDetail>(`/customer/orders/${id}`);
  const disputes = useApi<Page<Dispute>>('/customer/disputes', { pageSize: 100 });

  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(order) => <OrderDetail order={order} disputes={disputes.data?.items ?? []} onChange={state.setData} reloadDisputes={disputes.reload} />}
    </AsyncView>
  );
}

function OrderDetail({ order, disputes, onChange, reloadDisputes }: { order: CustomerOrderDetail; disputes: Dispute[]; onChange: (order: CustomerOrderDetail) => void; reloadDisputes: () => Promise<void> }) {
  const toast = useToast();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [confirming, setConfirming] = useState<CustomerSubOrder | null>(null);
  const [disputing, setDisputing] = useState<CustomerSubOrder | null>(null);
  const cancel = useMutation((reason: string) => apiPost<CustomerOrderDetail>(`/customer/orders/${order.id}/cancel`, reason ? { reason } : {}));
  const confirm = useMutation((subOrderId: string) => apiPost<CustomerDeliveryConfirmation>(`/customer/orders/${order.id}/sub-orders/${subOrderId}/confirm-delivery`));

  // The latest dispute per package (list is newest first).
  const disputeBySub = useMemo(() => {
    const map = new Map<string, Dispute>();
    for (const dispute of disputes) if (!map.has(dispute.package.subOrderId)) map.set(dispute.package.subOrderId, dispute);
    return map;
  }, [disputes]);

  async function doCancel() {
    const result = await cancel.run(cancelReason.trim());
    if (result) {
      onChange(result);
      setCancelOpen(false);
      toast.success('سفارش لغو شد.');
    }
  }

  async function doConfirm() {
    if (!confirming) return;
    const result = await confirm.run(confirming.id);
    if (result) {
      onChange(result.order);
      setConfirming(null);
      toast.success('تحویل مرسوله تأیید شد. سپاس از خرید شما!');
    }
  }

  const isCredit = order.paymentMethod !== 'CASH_IPG';

  return (
    <>
      <PageHeader
        title={`سفارش ${order.orderNumber}`}
        description={`ثبت‌شده در ${formatDateTime(order.createdAt)}`}
        action={
          <div className="flex flex-wrap gap-2">
            {order.paymentStatus === 'PENDING' && order.paymentMethod === 'CASH_IPG' ? <RetryPaymentButton parentOrderId={order.id} label="پرداخت سفارش" /> : null}
            {order.canCancel ? (
              <Button variant="danger" icon={<CircleSlash className="size-4" />} onClick={() => setCancelOpen(true)}>
                لغو سفارش
              </Button>
            ) : null}
          </div>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-4">
          {order.cancellationReason ? <p className="rounded-xl bg-rose-50 px-4 py-3 text-sm text-rose-800">علت لغو: {order.cancellationReason}</p> : null}
          {order.subOrders.map((sub) => {
            const dispute = disputeBySub.get(sub.id);
            const activeDispute = dispute && ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION'].includes(dispute.status);
            const canDispute = order.paymentStatus === 'PAID' && DISPUTABLE.includes(sub.status) && (!dispute || dispute.status === 'CANCELLED');
            return (
              <Card
                key={sub.id}
                title={
                  <span className="flex items-center gap-2">
                    <Package className="size-4 text-slate-400" />
                    {sub.store.storeName}
                    <span className="text-xs font-normal text-slate-500" dir="ltr">
                      {sub.subOrderNumber}
                    </span>
                  </span>
                }
                action={<StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />}
              >
                <div className="flex flex-col gap-4">
                  <PackageStepper status={sub.status} />
                  {sub.trackingCode ? (
                    <div className="flex flex-wrap items-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">
                      <Truck className="size-4" />
                      {sub.carrierName ?? 'حمل‌کننده'} — کد رهگیری: <b dir="ltr">{sub.trackingCode}</b>
                      {sub.shippedAt ? <span className="text-xs text-sky-700">(ارسال: {formatDateTime(sub.shippedAt)})</span> : null}
                    </div>
                  ) : null}
                  {sub.cancellationReason ? <p className="text-sm text-rose-700">علت لغو مرسوله: {sub.cancellationReason}</p> : null}
                  <ul className="divide-y divide-slate-100 text-sm">
                    {sub.items.map((item) => (
                      <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <div>
                          <div className="font-medium">{item.productTitle}</div>
                          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                            {item.variantDetails.colorHex ? <span className="size-3 rounded-full border" style={{ background: item.variantDetails.colorHex }} /> : null}
                            {[item.variantDetails.colorName, item.variantDetails.size, item.variantDetails.guarantee].filter(Boolean).join(' · ')}
                            <span dir="ltr">{item.sku}</span>
                          </div>
                        </div>
                        <div className="text-end">
                          <div>
                            {toPersianDigits(item.quantity)} × <Money rials={item.unitPrice} />
                          </div>
                          <div className="font-bold">
                            <Money rials={item.lineTotal} />
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-sm">
                    <span className="text-slate-600">
                      کالاها <Money rials={sub.itemsSubtotal} /> + ارسال <Money rials={sub.shippingFee} />
                    </span>
                    <div className="flex flex-wrap gap-2">
                      {dispute ? (
                        <Link href={`/customer/disputes/${dispute.id}`} className="flex items-center gap-1">
                          <Scale className="size-4 text-slate-500" /> <StatusBadge value={dispute.status} map={DISPUTE_STATUS} />
                        </Link>
                      ) : null}
                      {sub.status === 'SHIPPED' && order.paymentStatus === 'PAID' && !activeDispute ? (
                        <Button size="sm" variant="success" icon={<CircleCheck className="size-4" />} onClick={() => setConfirming(sub)}>
                          تأیید تحویل
                        </Button>
                      ) : null}
                      {canDispute ? (
                        <Button size="sm" variant="secondary" icon={<Scale className="size-4" />} onClick={() => setDisputing(sub)}>
                          ثبت اختلاف / مرجوعی
                        </Button>
                      ) : null}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}

          <Card title="تاریخچهٔ سفارش">
            <ol className="relative flex flex-col gap-4 border-s-2 border-slate-100 ps-5">
              {order.timeline.map((event, index) => (
                <li key={`${event.at}-${index}`} className="relative text-sm">
                  <span className="absolute -start-[27px] top-1 size-3 rounded-full border-2 border-white bg-brand-500" />
                  <div className="font-medium">
                    {event.type === 'SUB_ORDER_STATUS' && event.toStatus ? `مرسولهٔ ${event.subOrderNumber ?? ''}: ${SUB_ORDER_STATUS[event.toStatus].label}` : (TIMELINE_EVENT_LABELS[event.type] ?? event.type)}
                  </div>
                  <div className="text-xs text-slate-500">{formatDateTime(event.at)}</div>
                  {event.note ? <div className="mt-1 text-xs text-slate-600">{event.note}</div> : null}
                </li>
              ))}
            </ol>
          </Card>
        </div>

        <aside className="flex flex-col gap-4">
          <Card title="پرداخت">
            <dl className="flex flex-col gap-2 text-sm">
              <div className="flex justify-between">
                <dt className="text-slate-500">وضعیت</dt>
                <dd>
                  <StatusBadge value={order.paymentStatus} map={PAYMENT_STATUS} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">روش</dt>
                <dd>{PAYMENT_METHOD_LABELS[order.paymentMethod]}</dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">جمع کالاها</dt>
                <dd>
                  <Money rials={order.totalItemsAmount} />
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-slate-500">هزینهٔ ارسال</dt>
                <dd>
                  <Money rials={order.totalShippingFee} />
                </dd>
              </div>
              {order.totalDiscountAmount !== '0' && order.totalDiscountAmount !== '0.00' ? (
                <div className="flex justify-between text-emerald-700">
                  <dt>تخفیف</dt>
                  <dd>
                    <Money rials={order.totalDiscountAmount} />
                  </dd>
                </div>
              ) : null}
              <div className="flex justify-between border-t border-slate-100 pt-2 font-bold">
                <dt>مبلغ نهایی</dt>
                <dd>
                  <Money rials={order.finalPayableAmount} />
                </dd>
              </div>
              {order.paidAt ? <div className="text-xs text-slate-500">پرداخت: {formatDateTime(order.paidAt)}</div> : null}
              {order.paymentStatus === 'PENDING' && order.paymentExpiresAt ? (
                <Badge tone="warning">
                  <CalendarClock className="size-3" /> مهلت پرداخت تا {formatDateTime(order.paymentExpiresAt)}
                </Badge>
              ) : null}
            </dl>
            {isCredit && order.paymentStatus === 'PAID' ? (
              <LinkButton href="/customer/credit" variant="secondary" size="sm" className="mt-3 w-full">
                مشاهدهٔ اقساط
              </LinkButton>
            ) : null}
          </Card>
          <Card title="نشانی تحویل">
            <div className="flex flex-col gap-1 text-sm leading-7">
              <span className="flex items-center gap-1 font-medium">
                <MapPin className="size-4 text-brand-600" /> {order.shippingAddress.province}، {order.shippingAddress.city}
              </span>
              <span className="text-slate-700">{order.shippingAddress.postalAddress}</span>
              <span className="text-xs text-slate-500">کد پستی {toPersianDigits(order.shippingAddress.postalCode)}</span>
              <span className="text-xs text-slate-500">
                {order.shippingAddress.recipientName} — <span dir="ltr">{formatMobile(order.shippingAddress.recipientMobile)}</span>
              </span>
            </div>
          </Card>
          {order.customerNote ? (
            <Card title="یادداشت شما">
              <p className="text-sm text-slate-700">{order.customerNote}</p>
            </Card>
          ) : null}
        </aside>
      </div>

      <Modal
        open={cancelOpen}
        title="لغو سفارش"
        onClose={() => setCancelOpen(false)}
        footer={
          <>
            <Button variant="danger" loading={cancel.pending} onClick={() => void doCancel()}>
              لغو سفارش
            </Button>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              منصرف شدم
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-7">موجودی کالاها آزاد می‌شود{order.paymentStatus === 'PAID' ? ' و مبلغ پرداختی طبق روش پرداخت بازگردانده می‌شود' : ''}.</p>
          <Field label="علت (اختیاری)">{(fieldId) => <Textarea id={fieldId} rows={3} maxLength={500} value={cancelReason} onChange={(event) => setCancelReason(event.target.value)} />}</Field>
          <FormError message={cancel.error?.message} />
        </div>
      </Modal>

      <Modal
        open={confirming !== null}
        title="تأیید تحویل مرسوله"
        onClose={() => setConfirming(null)}
        footer={
          <>
            <Button variant="success" loading={confirm.pending} onClick={() => void doConfirm()}>
              کالا را سالم تحویل گرفتم
            </Button>
            <Button variant="secondary" onClick={() => setConfirming(null)}>
              انصراف
            </Button>
          </>
        }
      >
        <p className="text-sm leading-7">با تأیید تحویل مرسولهٔ «{confirming?.store.storeName}»، مبلغ آن برای فروشنده قابل برداشت می‌شود. اگر مشکلی دارید، به‌جای تأیید، اختلاف ثبت کنید.</p>
        <FormError message={confirm.error?.message} />
      </Modal>

      {disputing ? (
        <DisputeFormModal
          open
          subOrderId={disputing.id}
          packageLabel={disputing.store.storeName}
          onClose={() => setDisputing(null)}
          onFiled={() => {
            setDisputing(null);
            void reloadDisputes();
          }}
        />
      ) : null}
    </>
  );
}
```

### `apps/frontend/src/app/customer/orders/page.tsx`

```tsx
'use client';

import { ChevronLeft, Package, ShoppingBag } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';

import { PackageStepper } from '@/components/orders/package-stepper';
import { LinkButton } from '@/components/ui/button';
import { Money, PageHeader, Pagination, StatusBadge } from '@/components/ui/misc';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import type { CustomerOrderSummary, Page, ParentOrderPaymentStatus } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatDateTime, toPersianDigits } from '@/lib/format';
import { PAYMENT_METHOD_LABELS, PAYMENT_STATUS } from '@/lib/labels';

const FILTERS: Array<{ value: ParentOrderPaymentStatus | ''; label: string }> = [
  { value: '', label: 'همه' },
  { value: 'PAID', label: 'پرداخت‌شده' },
  { value: 'PENDING', label: 'در انتظار پرداخت' },
  { value: 'CANCELLED', label: 'لغوشده' },
  { value: 'FAILED', label: 'ناموفق' },
];

export default function CustomerOrdersPage() {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<ParentOrderPaymentStatus | ''>('');
  const state = useApi<Page<CustomerOrderSummary>>('/customer/orders', { page, pageSize: 10, paymentStatus: status || undefined });

  return (
    <>
      <PageHeader title="سفارش‌های من" description="وضعیت پرداخت و مرسوله‌های هر سفارش" />
      <div className="mb-4 flex flex-wrap gap-2" role="tablist">
        {FILTERS.map((filter) => (
          <button
            key={filter.value}
            type="button"
            role="tab"
            aria-selected={status === filter.value}
            onClick={() => {
              setStatus(filter.value);
              setPage(1);
            }}
            className={`rounded-full border px-4 py-1.5 text-sm ${status === filter.value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700 hover:border-brand-300'}`}
          >
            {filter.label}
          </button>
        ))}
      </div>
      <AsyncView
        state={state}
        skeleton={<SkeletonRows rows={4} className="h-44" />}
        isEmpty={(data) => data.items.length === 0}
        empty={<EmptyState icon={<ShoppingBag className="size-8" />} title="سفارشی پیدا نشد" description={status ? 'سفارشی با این وضعیت ندارید.' : 'هنوز خریدی انجام نداده‌اید.'} action={<LinkButton href="/">شروع خرید</LinkButton>} />}
      >
        {(data) => (
          <div className="flex flex-col gap-4">
            {data.items.map((order) => (
              <article key={order.id} className="rounded-2xl border border-slate-200 bg-white">
                <header className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-slate-100 px-5 py-3 text-sm">
                  <span className="font-bold" dir="ltr">
                    {order.orderNumber}
                  </span>
                  <StatusBadge value={order.paymentStatus} map={PAYMENT_STATUS} />
                  <span className="text-slate-500">{formatDateTime(order.createdAt)}</span>
                  <span className="text-slate-500">{PAYMENT_METHOD_LABELS[order.paymentMethod]}</span>
                  <span className="ms-auto font-bold">
                    <Money rials={order.finalPayableAmount} />
                  </span>
                </header>
                <ul className="divide-y divide-slate-100">
                  {order.subOrders.map((sub) => (
                    <li key={sub.id} className="grid gap-3 px-5 py-4 md:grid-cols-[220px_1fr] md:items-center">
                      <div className="flex items-center gap-2 text-sm">
                        <Package className="size-4 text-slate-400" />
                        <div>
                          <div className="font-medium">{sub.storeName}</div>
                          <div className="text-xs text-slate-500">
                            {toPersianDigits(sub.itemCount)} قلم
                            {sub.trackingCode ? (
                              <>
                                {' '}
                                · کد رهگیری <span dir="ltr">{sub.trackingCode}</span>
                              </>
                            ) : null}
                          </div>
                        </div>
                      </div>
                      <PackageStepper status={sub.status} />
                    </li>
                  ))}
                </ul>
                <footer className="flex justify-end border-t border-slate-100 px-5 py-3">
                  <Link href={`/customer/orders/${order.id}`} className="flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
                    جزئیات سفارش <ChevronLeft className="size-4" />
                  </Link>
                </footer>
              </article>
            ))}
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </div>
        )}
      </AsyncView>
    </>
  );
}
```

### `apps/frontend/src/app/customer/page.tsx`

```tsx
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { homeForRole } from '@/lib/auth/access';
import { ACCESS_COOKIE, readAccessClaims } from '@/lib/auth/session-core';

/** /customer itself has no content: send the user to their role's landing page (middleware already enforced access). */
export default async function CustomerIndexPage() {
  const claims = readAccessClaims((await cookies()).get(ACCESS_COOKIE)?.value);
  redirect(claims ? homeForRole(claims.role) : '/login');
}
```

### `apps/frontend/src/app/customer/profile/page.tsx`

```tsx
'use client';

import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { Card, DefinitionList, PageHeader, StatusBadge } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import type { Me, UpdateProfileInput } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDate, formatMobile, toLatinDigits } from '@/lib/format';
import { isValidNationalCode } from '@/lib/iran';
import { ROLE_LABELS, VENDOR_STATUS } from '@/lib/labels';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CustomerProfilePage() {
  const state = useApi<Me>('/auth/me');
  return (
    <>
      <PageHeader title="پروفایل من" description="اطلاعات حساب کاربری و هویتی" />
      <AsyncView state={state} skeleton={<Skeleton className="h-96" />}>
        {(me) => <ProfileForm me={me} onSaved={state.setData} />}
      </AsyncView>
    </>
  );
}

function ProfileForm({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const toast = useToast();
  const { refresh } = useSession();
  const router = useRouter();

  // The BFF rotates the session when the account's role changed (store approved → VENDOR).
  async function enterVendorPanel() {
    await refresh();
    router.push('/vendor/dashboard');
    router.refresh();
  }
  const [fullName, setFullName] = useState(me.user.fullName);
  const [email, setEmail] = useState(me.user.email ?? '');
  const [nationalCode, setNationalCode] = useState('');
  const [birthDate, setBirthDate] = useState(me.customerProfile?.birthDate?.slice(0, 10) ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation((body: UpdateProfileInput) => apiPatch<Me & { updated: boolean }>('/auth/profile', body));

  useEffect(() => {
    setFullName(me.user.fullName);
    setEmail(me.user.email ?? '');
  }, [me]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: UpdateProfileInput = {};
    const nextErrors: Record<string, string> = {};
    const name = fullName.trim();
    if (name !== me.user.fullName) {
      if (name.length < 2 || name.length > 120) nextErrors.fullName = 'نام باید بین ۲ تا ۱۲۰ نویسه باشد.';
      body.fullName = name;
    }
    const mail = email.trim();
    if (mail && mail !== (me.user.email ?? '')) {
      if (!EMAIL.test(mail)) nextErrors.email = 'ایمیل معتبر نیست.';
      body.email = mail;
    }
    const code = toLatinDigits(nationalCode.trim());
    if (code) {
      if (!isValidNationalCode(code)) nextErrors.nationalCode = 'کد ملی معتبر نیست.';
      body.nationalCode = code;
    }
    if (birthDate && birthDate !== (me.customerProfile?.birthDate?.slice(0, 10) ?? '')) body.birthDate = birthDate;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (Object.keys(body).length === 0) {
      toast.info('تغییری برای ذخیره وجود ندارد.');
      return;
    }
    const result = await save.run(body);
    if (result) {
      onSaved({ user: result.user, customerProfile: result.customerProfile, vendor: result.vendor });
      setNationalCode('');
      await refresh();
      toast.success('پروفایل ذخیره شد.');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card title="ویرایش اطلاعات">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="نام و نام خانوادگی" error={errors.fullName} required>
            {(id, described) => <Input id={id} aria-describedby={described} value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} />}
          </Field>
          <Field label="ایمیل" error={errors.email}>
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} />}
          </Field>
          <Field label="کد ملی" error={errors.nationalCode} hint="برای درخواست اعتبار خرید اقساطی لازم است. کد ثبت‌شده قابل تغییر نیست.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="numeric" maxLength={10} value={nationalCode} onChange={(event) => setNationalCode(event.target.value)} placeholder="۱۰ رقم" />}
          </Field>
          <Field label="تاریخ تولد (میلادی)">
            {(id) => <Input id={id} type="date" dir="ltr" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} max={new Date().toISOString().slice(0, 10)} />}
          </Field>
          <div className="sm:col-span-2">
            <FormError message={save.error?.message} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
              ذخیرهٔ تغییرات
            </Button>
          </div>
        </form>
      </Card>
      <div className="flex flex-col gap-6">
        <Card title="حساب کاربری">
          <DefinitionList
            items={[
              { label: 'موبایل', value: <span dir="ltr">{formatMobile(me.user.mobile)}</span> },
              { label: 'نقش', value: ROLE_LABELS[me.user.role] },
              { label: 'تاریخ تولد', value: me.customerProfile?.birthDate ? formatDate(me.customerProfile.birthDate) : '—' },
            ]}
          />
        </Card>
        <Card title="فروشگاه">
          {me.vendor ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <b>{me.vendor.storeName}</b>
                <StatusBadge value={me.vendor.status} map={VENDOR_STATUS} />
              </div>
              {me.vendor.status === 'APPROVED' ? (
                <Button variant="secondary" onClick={() => void enterVendorPanel()}>
                  ورود به پنل فروشنده
                </Button>
              ) : (
                <p className="text-slate-600">درخواست فروشندگی شما در حال بررسی توسط تیم شاپینو است.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-sm text-slate-600">
              <p>محصولات خود را در شاپینو بفروشید.</p>
              <LinkButton href="/vendor/register" variant="secondary">
                درخواست فروشندگی
              </LinkButton>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
```

### `apps/frontend/src/app/error.tsx`

```tsx
'use client';

import { ErrorState } from '@/components/ui/states';

/** Last-resort boundary: a render/server error shows a retryable error state instead of a blank page. */
export default function GlobalRouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-16">
      <ErrorState error={error.message || 'خطای غیرمنتظره‌ای رخ داد.'} title="نمایش این صفحه ممکن نشد" onRetry={reset} />
    </main>
  );
}
```

### `apps/frontend/src/app/fonts.ts`

```ts
import localFont from 'next/font/local';

/**
 * Vazirmatn (OFL-1.1, npm package `vazirmatn`), self-hosted through
 * next/font: the variable font file is bundled at build time, so no request
 * leaves for a third-party font CDN. Falls back to the system stack in
 * globals.css while loading.
 */
export const vazirmatn = localFont({
  src: '../../node_modules/vazirmatn/fonts/webfonts/Vazirmatn[wght].woff2',
  weight: '100 900',
  style: 'normal',
  display: 'swap',
  variable: '--font-vazirmatn',
  preload: true,
});
```

### `apps/frontend/src/app/globals.css`

```css
@import "tailwindcss";

/*
 * Shopino design tokens. Vazirmatn is self-hosted through next/font (see
 * src/app/fonts.ts, exposed as --font-vazirmatn); the rest of the stack is the
 * system fallback with full Arabic-script coverage.
 */
@theme {
  --font-sans: var(--font-vazirmatn), "Vazirmatn", "IRANSansX", "IRANSans", "Segoe UI", Tahoma, system-ui, sans-serif;

  --color-brand-50: #eff6ff;
  --color-brand-100: #dbeafe;
  --color-brand-400: #60a5fa;
  --color-brand-500: #2563eb;
  --color-brand-600: #1d4ed8;
  --color-brand-700: #1e40af;
  --color-brand-900: #172554;

  --color-surface: #ffffff;
  --color-surface-muted: #f8fafc;
}

html {
  color-scheme: light;
}

body {
  font-family: var(--font-sans);
}

/* Dual-thumb price slider: two range inputs stacked on one track. */
.range-thumb {
  pointer-events: none;
  appearance: none;
  background: transparent;
}
.range-thumb::-webkit-slider-thumb {
  pointer-events: auto;
  appearance: none;
  height: 1.1rem;
  width: 1.1rem;
  border-radius: 9999px;
  background: #fff;
  border: 3px solid var(--color-brand-600);
  cursor: pointer;
}
.range-thumb::-moz-range-thumb {
  pointer-events: auto;
  height: 1.1rem;
  width: 1.1rem;
  border-radius: 9999px;
  background: #fff;
  border: 3px solid var(--color-brand-600);
  cursor: pointer;
}
```

### `apps/frontend/src/app/layout.tsx`

```tsx
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { CartProvider } from '@/components/providers/cart-provider';
import { SessionProvider } from '@/components/providers/session-provider';
import { ToastProvider } from '@/components/providers/toast-provider';
import { getServerSession } from '@/lib/api/server';

import { vazirmatn } from './fonts';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'شاپینو | خرید آنلاین با امکان پرداخت اقساطی', template: '%s | شاپینو' },
  description: 'بازار آنلاین چندفروشندگی شاپینو — خرید نقدی یا اقساطی (BNPL) از فروشگاه‌های تأییدشده.',
};

export const viewport: Viewport = {
  themeColor: '#1d4ed8',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // First render already knows who is signed in (no flash of the anonymous header).
  const session = await getServerSession();
  return (
    // dir="rtl" + lang="fa": the whole application is right-to-left; Tailwind's
    // logical utilities (ps-*, pe-*, ms-*, me-*, text-start…) follow it.
    <html lang="fa" dir="rtl" className={vazirmatn.variable}>
      <body className="min-h-screen bg-surface-muted text-slate-900 antialiased">
        <SessionProvider initial={session}>
          <ToastProvider>
            <CartProvider>{children}</CartProvider>
          </ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
```

### `apps/frontend/src/app/not-found.tsx`

```tsx
import { SearchX } from 'lucide-react';

import { LinkButton } from '@/components/ui/button';

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-[70vh] max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <span className="flex size-16 items-center justify-center rounded-full bg-slate-100 text-slate-500">
        <SearchX className="size-8" />
      </span>
      <h1 className="text-xl font-black">صفحه یا محصول مورد نظر پیدا نشد</h1>
      <p className="text-sm leading-7 text-slate-600">ممکن است نشانی اشتباه باشد یا این محصول دیگر منتشر نشود.</p>
      <div className="flex gap-2">
        <LinkButton href="/">صفحهٔ اصلی</LinkButton>
        <LinkButton href="/search" variant="secondary">
          جست‌وجوی محصولات
        </LinkButton>
      </div>
    </main>
  );
}
```

### `apps/frontend/src/app/status/page.tsx`

```tsx
import { SystemHealthPanel } from '@/components/system-health-panel';
import { getSystemHealthServerSide } from '@/lib/api/health.server';
import type { SystemHealth } from '@/lib/api/health';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Server-side call at request time: the page always shows the live state of
  // the API (database, Redis, memory, uptime), never cached output.
  let initialHealth: SystemHealth | null = null;
  let initialError: string | null = null;

  try {
    initialHealth = await getSystemHealthServerSide();
  } catch (error) {
    initialError = error instanceof Error ? error.message : 'خطای نامشخص در ارتباط با API';
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-14">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-brand-600">شاپینو</p>
        <h1 className="text-3xl font-bold text-slate-900">وضعیت سامانه</h1>
        <p className="text-sm leading-6 text-slate-600">
          این صفحه وضعیت زندهٔ سرویس‌های زیرساختی (PostgreSQL و Redis) و همچنین وضعیت پردازش API
          را نمایش می‌دهد. داده‌های نمایش‌داده‌شده از خود سرویس‌ها خوانده می‌شوند.
        </p>
      </header>

      <SystemHealthPanel initialHealth={initialHealth} initialError={initialError} />

      <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500">
        <p>شاپینو — نسخهٔ ۰.۱.۰ | API: مسیر امن از طریق پروکسی Next.js به سرویس Backend</p>
      </footer>
    </main>
  );
}
```

### `apps/frontend/src/app/vendor/dashboard/page.tsx`

```tsx
'use client';

import { ChevronLeft, Clock, PackageCheck, Scale, Truck, Wallet } from 'lucide-react';
import Link from 'next/link';

import { LinkButton } from '@/components/ui/button';
import { Card, Money, PageHeader, StatCard, StatusBadge, Table, Td } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton, SkeletonRows } from '@/components/ui/states';
import { useSession } from '@/components/providers/session-provider';
import type { Page, SubOrderStatus, VendorDispute, VendorSubOrderSummary, WalletSummary } from '@/lib/api/types';
import { useApi } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime, toPersianDigits } from '@/lib/format';
import { SUB_ORDER_STATUS } from '@/lib/labels';

/** Package counts come from the list endpoint's `total` (pageSize=1): no separate stats endpoint exists. */
function usePackageCount(status: SubOrderStatus) {
  return useApi<Page<VendorSubOrderSummary>>('/vendor/orders', { status, pageSize: 1 });
}

function CountValue({ state }: { state: { data?: { total: number } | undefined; error?: unknown } }) {
  if (state.data) return <>{formatCount(state.data.total)}</>;
  if (state.error) return <span className="text-sm text-rose-600">خطا</span>;
  return <Skeleton className="h-7 w-12" />;
}

export default function VendorDashboardPage() {
  const { me } = useSession();
  const awaiting = useApi<Page<VendorSubOrderSummary>>('/vendor/orders', { status: 'PENDING_APPROVAL', pageSize: 5 });
  const processing = usePackageCount('PROCESSING');
  const shipped = usePackageCount('SHIPPED');
  const disputes = useApi<Page<VendorDispute>>('/vendor/disputes', { status: 'OPEN', pageSize: 1 });
  const wallet = useApi<WalletSummary>('/vendor/wallet');

  return (
    <>
      <PageHeader title={`پیشخوان ${me?.vendor?.storeName ?? 'فروشگاه'}`} description="نمای کلی سفارش‌ها و کیف پول" />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="در انتظار تأیید" value={<CountValue state={awaiting} />} icon={<Clock className="size-5" />} tone="warning" />
        <StatCard label="در حال پردازش" value={<CountValue state={processing} />} icon={<PackageCheck className="size-5" />} tone="info" />
        <StatCard label="ارسال‌شده" value={<CountValue state={shipped} />} icon={<Truck className="size-5" />} />
        <StatCard label="اختلاف‌های باز" value={<CountValue state={disputes} />} icon={<Scale className="size-5" />} tone={disputes.data && disputes.data.total > 0 ? 'danger' : 'neutral'} />
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card title="مرسوله‌های در انتظار تأیید" action={<Link href="/vendor/orders" className="flex items-center gap-1 text-sm text-brand-700">همه <ChevronLeft className="size-4" /></Link>}>
          {awaiting.loading && !awaiting.data ? (
            <SkeletonRows rows={3} />
          ) : awaiting.error && !awaiting.data ? (
            <ErrorState error={awaiting.error} onRetry={() => void awaiting.reload()} />
          ) : awaiting.data && awaiting.data.items.length === 0 ? (
            <EmptyState icon={<PackageCheck className="size-8" />} title="مرسوله‌ای در انتظار تأیید نیست" />
          ) : awaiting.data ? (
            <Table head={['مرسوله', 'اقلام', 'سهم شما', 'ثبت', 'وضعیت']}>
              {awaiting.data.items.map((sub) => (
                <tr key={sub.id}>
                  <Td>
                    <Link href={`/vendor/orders?focus=${sub.id}`} dir="ltr" className="font-mono text-xs text-brand-700 hover:underline">
                      {sub.subOrderNumber}
                    </Link>
                  </Td>
                  <Td>{toPersianDigits(sub.itemCount)}</Td>
                  <Td>
                    <Money rials={sub.vendorEarningsAmount} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(sub.paidAt ?? sub.placedAt)}</Td>
                  <Td>
                    <StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />
                  </Td>
                </tr>
              ))}
            </Table>
          ) : null}
        </Card>

        <Card
          title={
            <span className="flex items-center gap-2">
              <Wallet className="size-5 text-brand-600" /> کیف پول
            </span>
          }
        >
          {wallet.loading && !wallet.data ? (
            <Skeleton className="h-40" />
          ) : wallet.error && !wallet.data ? (
            <ErrorState error={wallet.error} onRetry={() => void wallet.reload()} />
          ) : wallet.data ? (
            <div className="flex flex-col gap-3 text-sm">
              <div>
                <div className="text-xs text-slate-500">قابل برداشت</div>
                <Money rials={wallet.data.withdrawableBalance} className="text-2xl font-black text-emerald-700" />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">در انتظار تحویل (امانی)</span>
                <Money rials={wallet.data.pendingBalance} />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">در حال تسویه</span>
                <Money rials={wallet.data.settlementHoldBalance} />
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">مسدود (اختلاف)</span>
                <Money rials={wallet.data.disputeHoldBalance} />
              </div>
              <div className="flex justify-between border-t border-slate-100 pt-2">
                <span className="text-slate-500">کل درآمد</span>
                <Money rials={wallet.data.totalEarnedBalance} className="font-bold" />
              </div>
              <LinkButton href="/vendor/wallet" variant="secondary" size="sm">
                درخواست تسویه
              </LinkButton>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}
```

### `apps/frontend/src/app/vendor/disputes/[id]/page.tsx`

```tsx
'use client';

import { Shield, Undo2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DisputeView } from '@/components/disputes/dispute-view';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormError, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Card, Money, PageHeader } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { DisputeActionResult, DisputeVendorAction, VendorDispute } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { WALLET_BUCKET_LABELS } from '@/lib/labels';

const NOTES_MIN = 10;
const NOTES_MAX = 2000;

export default function VendorDisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<VendorDispute>(`/vendor/disputes/${id}`);
  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(dispute) => (
        <>
          <PageHeader
            title="رسیدگی به اختلاف"
            description={`خریدار: ${dispute.customerName} (${dispute.customerMobileMasked})`}
            action={
              <LinkButton href="/vendor/disputes" variant="secondary">
                بازگشت
              </LinkButton>
            }
          />
          <DisputeView
            dispute={dispute}
            extra={
              <>
                <Card title="مبلغ مسدودشده">
                  <p className="text-sm">
                    <Money rials={dispute.hold.amount} className="font-bold" />
                    {dispute.hold.source ? <span className="text-slate-500"> — از صندوق «{WALLET_BUCKET_LABELS[dispute.hold.source]}»</span> : null}
                  </p>
                </Card>
                {dispute.status === 'OPEN' ? <RespondForm disputeId={dispute.id} onDone={() => void state.reload()} /> : null}
              </>
            }
          />
        </>
      )}
    </AsyncView>
  );
}

function RespondForm({ disputeId, onDone }: { disputeId: string; onDone: () => void }) {
  const toast = useToast();
  const [action, setAction] = useState<DisputeVendorAction>('REJECT_WITH_DEFENSE');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [itemReturned, setItemReturned] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const respond = useMutation((body: Record<string, unknown>) => apiPost<DisputeActionResult>(`/vendor/disputes/${disputeId}/respond`, body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = notes.trim();
    if (text.length < NOTES_MIN) return setLocalError(`توضیحات باید دست‌کم ${toPersianDigits(NOTES_MIN)} نویسه باشد.`);
    setLocalError(null);
    const body: Record<string, unknown> = { action, defenseNotes: text };
    if (files.length) body.evidenceUrls = files.map((file) => file.url);
    if (action === 'ACCEPT_RETURN') body.itemReturned = itemReturned;
    const result = await respond.run(body);
    if (result) {
      toast.success(action === 'ACCEPT_RETURN' ? 'مرجوعی پذیرفته شد و مبلغ به خریدار بازگردانده می‌شود.' : 'دفاعیه ثبت شد و پرونده برای داوری ارسال شد.');
      onDone();
    }
  }

  return (
    <Card title="پاسخ شما">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="نوع پاسخ">
          {(
            [
              { value: 'REJECT_WITH_DEFENSE', title: 'دفاع و ارجاع به داوری', text: 'مستندات خود را ارسال کنید؛ کارشناس شاپینو رأی می‌دهد.', icon: Shield },
              { value: 'ACCEPT_RETURN', title: 'پذیرش مرجوعی', text: 'اختلاف به نفع خریدار بسته و مبلغ مرسوله بازگردانده می‌شود.', icon: Undo2 },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={action === option.value}
              onClick={() => setAction(option.value)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-start ${action === option.value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-300' : 'border-slate-200'}`}
            >
              <option.icon className="mt-0.5 size-5 text-brand-600" />
              <span>
                <span className="block text-sm font-bold">{option.title}</span>
                <span className="text-xs text-slate-600">{option.text}</span>
              </span>
            </button>
          ))}
        </div>
        <Field label={action === 'ACCEPT_RETURN' ? 'توضیح برای خریدار' : 'دفاعیه'} required hint={`${toPersianDigits(notes.trim().length)} / ${toPersianDigits(NOTES_MAX)}`}>
          {(id, described) => <Textarea id={id} aria-describedby={described} rows={5} maxLength={NOTES_MAX} value={notes} onChange={(event) => setNotes(event.target.value)} />}
        </Field>
        <FileDrop upload={{ kind: 'document', purpose: 'dispute_evidence' }} value={files} onChange={setFiles} max={10} accept="image/jpeg,image/png,image/webp,application/pdf" label="تصاویر و مستندات" hint="مثلاً عکس بسته‌بندی پیش از ارسال یا رسید حمل." />
        {action === 'ACCEPT_RETURN' ? <Checkbox label="کالا به فروشگاه بازگشته است (موجودی دوباره افزوده شود)" checked={itemReturned} onChange={(event) => setItemReturned(event.target.checked)} /> : null}
        <FormError message={localError ?? respond.error?.message} />
        <Button type="submit" variant={action === 'ACCEPT_RETURN' ? 'danger' : 'primary'} loading={respond.pending}>
          {action === 'ACCEPT_RETURN' ? 'پذیرش مرجوعی' : 'ارسال دفاعیه'}
        </Button>
      </form>
    </Card>
  );
}
```

### `apps/frontend/src/app/vendor/disputes/page.tsx`

```tsx
'use client';

import { DisputeList } from '@/components/disputes/dispute-list';
import { PageHeader } from '@/components/ui/misc';
import type { VendorDispute } from '@/lib/api/types';

export default function VendorDisputesPage() {
  return (
    <>
      <PageHeader title="اختلاف‌ها" description="به اختلاف‌های باز پاسخ دهید: پذیرش مرجوعی یا ارسال دفاعیه برای داوری." />
      <DisputeList<VendorDispute>
        endpoint="/vendor/disputes"
        hrefBase="/vendor/disputes"
        emptyText="اختلافی برای فروشگاه شما ثبت نشده است."
        partyColumn={{ head: 'خریدار', cell: (dispute) => <span>{dispute.customerName}</span> }}
      />
    </>
  );
}
```

### `apps/frontend/src/app/vendor/layout.tsx`

```tsx
import type { ReactNode } from 'react';

import { DashboardShell } from '@/components/layout/dashboard-shell';
import { SiteHeader } from '@/components/layout/site-header';

export const dynamic = 'force-dynamic';

/** Access is enforced by src/middleware.ts (role guard) and again by every backend endpoint. */
export default function VendorLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <SiteHeader />
      <DashboardShell area="vendor">{children}</DashboardShell>
    </>
  );
}
```

### `apps/frontend/src/app/vendor/orders/page.tsx`

```tsx
'use client';

import { CheckCircle2, Eye, PackageCheck, Search, Truck, XCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { Money, PageHeader, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, Skeleton, SkeletonRows } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Page, SubOrderStatus, VendorSubOrderDetail, VendorSubOrderSummary, VendorSubOrderTransition } from '@/lib/api/types';
import { SUB_ORDER_STATUSES } from '@/lib/api/types';
import { useApi, useDebounced, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime, formatMobile, toPersianDigits } from '@/lib/format';
import { SUB_ORDER_STATUS } from '@/lib/labels';

const TRACKING = /^[A-Za-z0-9-]{4,40}$/;

type Action = { kind: 'ship' | 'cancel'; sub: VendorSubOrderSummary };

export default function VendorOrdersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <VendorOrders />
    </Suspense>
  );
}

function VendorOrders() {
  const toast = useToast();
  const router = useRouter();
  const params = useSearchParams();
  const [status, setStatus] = useState<SubOrderStatus | ''>('PENDING_APPROVAL');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const state = useApi<Page<VendorSubOrderSummary>>('/vendor/orders', { status: status || undefined, search: term || undefined, page, pageSize: 20 });
  const [action, setAction] = useState<Action | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const focus = params.get('focus');

  async function accept(sub: VendorSubOrderSummary) {
    setBusyId(sub.id);
    try {
      await apiPatch<VendorSubOrderTransition>(`/vendor/orders/${sub.id}/status`, { status: 'PROCESSING' });
      toast.success(`مرسولهٔ ${sub.subOrderNumber} پذیرفته شد و در حال پردازش است.`);
      await state.reload();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  function openDetail(id: string | null) {
    const next = new URLSearchParams(params.toString());
    if (id) next.set('focus', id);
    else next.delete('focus');
    router.replace(`/vendor/orders${next.size ? `?${next.toString()}` : ''}`, { scroll: false });
  }

  return (
    <>
      <PageHeader title="مرسوله‌ها" description="پذیرش، ارسال و پیگیری مرسوله‌های فروشگاه" />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          {(['', ...SUB_ORDER_STATUSES] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={status === value}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${status === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
            >
              {value ? SUB_ORDER_STATUS[value].label : 'همه'}
            </button>
          ))}
        </div>
        <div className="relative md:w-64">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
          <Input
            dir="ltr"
            placeholder="شمارهٔ سفارش یا مرسوله"
            value={search}
            maxLength={24}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="ps-9"
          />
        </div>
      </div>

      <AsyncView state={state} skeleton={<SkeletonRows rows={6} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<PackageCheck className="size-8" />} title="مرسوله‌ای یافت نشد" />}>
        {(data) => (
          <>
            <Table head={['مرسوله', 'اقلام', 'مبلغ کالا', 'کارمزد', 'سهم شما', 'زمان', 'وضعیت', 'عملیات']}>
              {data.items.map((sub) => (
                <tr key={sub.id} className="align-top">
                  <Td>
                    <div dir="ltr" className="text-end font-mono text-xs">
                      {sub.subOrderNumber}
                    </div>
                    {sub.trackingCode ? (
                      <div className="text-xs text-slate-500">
                        {sub.carrierName}: <span dir="ltr">{sub.trackingCode}</span>
                      </div>
                    ) : null}
                  </Td>
                  <Td>{toPersianDigits(sub.itemCount)}</Td>
                  <Td>
                    <Money rials={sub.itemsSubtotal} />
                  </Td>
                  <Td className="text-slate-500">
                    <Money rials={sub.platformCommissionAmount} />
                  </Td>
                  <Td className="font-bold">
                    <Money rials={sub.vendorEarningsAmount} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(sub.paidAt ?? sub.placedAt)}</Td>
                  <Td>
                    <StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => openDetail(sub.id)} aria-label="جزئیات" />
                      {sub.allowedTransitions.includes('PROCESSING') && sub.status === 'PENDING_APPROVAL' ? (
                        <Button size="sm" variant="success" loading={busyId === sub.id} icon={<CheckCircle2 className="size-4" />} onClick={() => void accept(sub)}>
                          پذیرش و پردازش
                        </Button>
                      ) : null}
                      {sub.allowedTransitions.includes('SHIPPED') && sub.status === 'PROCESSING' ? (
                        <Button size="sm" icon={<Truck className="size-4" />} onClick={() => setAction({ kind: 'ship', sub })}>
                          ثبت ارسال
                        </Button>
                      ) : null}
                      {sub.allowedTransitions.includes('CANCELLED') ? (
                        <Button size="sm" variant="ghost" className="text-rose-600" icon={<XCircle className="size-4" />} onClick={() => setAction({ kind: 'cancel', sub })}>
                          لغو
                        </Button>
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>

      {action ? (
        <TransitionModal
          action={action}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            void state.reload();
          }}
        />
      ) : null}
      {focus ? <DetailModal id={focus} onClose={() => openDetail(null)} /> : null}
    </>
  );
}

function TransitionModal({ action, onClose, onDone }: { action: Action; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [carrier, setCarrier] = useState('');
  const [tracking, setTracking] = useState('');
  const [reason, setReason] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const run = useMutation((body: Record<string, string>) => apiPatch<VendorSubOrderTransition>(`/vendor/orders/${action.sub.id}/status`, body));
  const ship = action.kind === 'ship';

  async function submit(event: FormEvent) {
    event.preventDefault();
    let body: Record<string, string>;
    if (ship) {
      if (carrier.trim().length < 2) return setLocalError('نام شرکت حمل را وارد کنید.');
      if (!TRACKING.test(tracking.trim())) return setLocalError('کد رهگیری ۴ تا ۴۰ نویسه و فقط حروف لاتین، رقم و خط تیره است.');
      body = { status: 'SHIPPED', shippingCarrier: carrier.trim(), trackingCode: tracking.trim() };
    } else {
      if (reason.trim().length < 5) return setLocalError('علت لغو را (دست‌کم ۵ نویسه) بنویسید؛ برای خریدار نمایش داده می‌شود.');
      body = { status: 'CANCELLED', reason: reason.trim() };
    }
    setLocalError(null);
    const result = await run.run(body);
    if (result) {
      toast.success(ship ? 'ارسال مرسوله ثبت شد.' : 'مرسوله لغو شد و موجودی بازگشت.');
      onDone();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={ship ? `ثبت ارسال — ${action.sub.subOrderNumber}` : `لغو مرسوله — ${action.sub.subOrderNumber}`}
      footer={
        <>
          <Button type="submit" form="transition-form" variant={ship ? 'primary' : 'danger'} loading={run.pending}>
            {ship ? 'ثبت ارسال' : 'لغو مرسوله'}
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <form id="transition-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        {ship ? (
          <>
            <Field label="شرکت حمل" required>
              {(id) => <Input id={id} maxLength={80} list="carriers" value={carrier} onChange={(event) => setCarrier(event.target.value)} placeholder="مثلاً پست پیشتاز" />}
            </Field>
            <datalist id="carriers">
              <option value="پست پیشتاز" />
              <option value="تیپاکس" />
              <option value="چاپار" />
              <option value="پیک اختصاصی" />
            </datalist>
            <Field label="کد رهگیری" required>
              {(id) => <Input id={id} dir="ltr" maxLength={40} value={tracking} onChange={(event) => setTracking(event.target.value)} />}
            </Field>
          </>
        ) : (
          <Field label="علت لغو" required hint="برای خریدار نمایش داده می‌شود. مبلغ به خریدار بازگردانده می‌شود.">
            {(id, described) => <Textarea id={id} aria-describedby={described} rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />}
          </Field>
        )}
        <FormError message={localError ?? run.error?.message} />
      </form>
    </Modal>
  );
}

function DetailModal({ id, onClose }: { id: string; onClose: () => void }) {
  const state = useApi<VendorSubOrderDetail>(`/vendor/orders/${id}`);
  return (
    <Modal open size="lg" onClose={onClose} title={state.data ? `مرسولهٔ ${state.data.subOrderNumber}` : 'جزئیات مرسوله'}>
      <AsyncView state={state} skeleton={<Skeleton className="h-72" />}>
        {(sub) => (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-3">
              <StatusBadge value={sub.status} map={SUB_ORDER_STATUS} />
              <span className="text-slate-500">
                سفارش <span dir="ltr">{sub.orderNumber}</span>
              </span>
              {sub.trackingCode ? (
                <span>
                  {sub.carrierName}: <b dir="ltr">{sub.trackingCode}</b>
                </span>
              ) : null}
            </div>
            <div className="rounded-xl bg-slate-50 p-3 leading-7">
              <b>{sub.shippingAddress.recipientName}</b> — <span dir="ltr">{formatMobile(sub.shippingAddress.recipientMobile)}</span>
              <br />
              {sub.shippingAddress.province}، {sub.shippingAddress.city}، {sub.shippingAddress.postalAddress}
              {sub.shippingAddress.buildingNumber ? `، پلاک ${toPersianDigits(sub.shippingAddress.buildingNumber)}` : ''}
              {sub.shippingAddress.unitNumber ? `، واحد ${toPersianDigits(sub.shippingAddress.unitNumber)}` : ''}
              <br />
              کد پستی: {toPersianDigits(sub.shippingAddress.postalCode)}
            </div>
            {sub.customerNote ? <p className="rounded-xl bg-amber-50 p-3">یادداشت خریدار: {sub.customerNote}</p> : null}
            <Table head={['کالا', 'SKU', 'تعداد', 'قیمت واحد', 'جمع', 'کارمزد']}>
              {sub.items.map((item) => (
                <tr key={item.id}>
                  <Td>
                    {item.productTitle}
                    <div className="text-xs text-slate-500">{[item.variantDetails.colorName, item.variantDetails.size].filter(Boolean).join(' · ')}</div>
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.sku}
                    </span>
                  </Td>
                  <Td>{toPersianDigits(item.quantity)}</Td>
                  <Td>
                    <Money rials={item.unitPrice} />
                  </Td>
                  <Td>
                    <Money rials={item.lineTotal} />
                  </Td>
                  <Td className="text-slate-500">
                    <Money rials={item.commissionAmount} />
                  </Td>
                </tr>
              ))}
            </Table>
            <div className="flex flex-wrap justify-end gap-4">
              <span>
                هزینهٔ ارسال: <Money rials={sub.shippingFee} />
              </span>
              <span className="font-bold">
                سهم شما: <Money rials={sub.vendorEarningsAmount} />
              </span>
            </div>
            <div>
              <h3 className="mb-2 font-bold">تاریخچه</h3>
              <ol className="flex flex-col gap-2">
                {sub.history.map((entry, index) => (
                  <li key={`${entry.at}-${index}`} className="flex flex-wrap gap-2 text-xs">
                    <span className="text-slate-500">{formatDateTime(entry.at)}</span>
                    <StatusBadge value={entry.toStatus} map={SUB_ORDER_STATUS} />
                    {entry.note ? <span className="text-slate-600">{entry.note}</span> : null}
                  </li>
                ))}
              </ol>
            </div>
          </div>
        )}
      </AsyncView>
    </Modal>
  );
}
```

### `apps/frontend/src/app/vendor/page.tsx`

```tsx
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { homeForRole } from '@/lib/auth/access';
import { ACCESS_COOKIE, readAccessClaims } from '@/lib/auth/session-core';

/** /vendor itself has no content: send the user to their role's landing page (middleware already enforced access). */
export default async function VendorIndexPage() {
  const claims = readAccessClaims((await cookies()).get(ACCESS_COOKIE)?.value);
  redirect(claims ? homeForRole(claims.role) : '/login');
}
```

### `apps/frontend/src/app/vendor/products/[id]/page.tsx`

```tsx
'use client';

import { ExternalLink, Plus, Save, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError, Input } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { ProductBasicsFields, validateBasics, type ProductBasics } from '@/components/vendor/product-basics';
import { ProductStatusBadge } from '@/components/vendor/product-status-badge';
import { VariantEditor } from '@/components/vendor/variant-editor';
import { apiPatch, apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { UpdateProductInput, UpdateVariantInput, VendorProductDetail, VendorVariant } from '@/lib/api/types';
import { rialsToToman, tomanToRials } from '@/lib/currency';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime, toLatinDigits, toPersianDigits } from '@/lib/format';
import { MAX_STOCK, MAX_VARIANTS_PER_PRODUCT, duplicateSkus, variantRowToInput, type VariantRow } from '@/lib/product-form';

function basicsFrom(product: VendorProductDetail): ProductBasics {
  return {
    title: product.title,
    slug: product.slug,
    categoryId: product.category.id,
    brand: product.brand ?? '',
    basePriceToman: rialsToToman(product.basePrice),
    description: product.description ?? '',
    // Only gallery entries backed by an uploaded asset can be re-sent as mediaIds.
    images: product.media.filter((media) => media.mediaAssetId !== null).map((media) => ({ id: media.mediaAssetId ?? '', url: media.url, thumbnailUrl: media.thumbnailUrl, name: media.url.split('/').pop() ?? 'image' })),
    isPublished: product.isPublished,
  };
}

export default function EditVendorProductPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<VendorProductDetail>(`/vendor/products/${id}`);
  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[600px]" />}>
      {(product) => <Editor key={product.updatedAt} product={product} reload={state.reload} />}
    </AsyncView>
  );
}

function Editor({ product, reload }: { product: VendorProductDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const [basics, setBasics] = useState<ProductBasics>(() => basicsFrom(product));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newRows, setNewRows] = useState<VariantRow[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [addingVariants, setAddingVariants] = useState(false);
  const save = useMutation((body: UpdateProductInput) => apiPatch<VendorProductDetail>(`/vendor/products/${product.id}`, body));
  const blocked = product.moderation.isBlockedByAdmin;

  async function saveBasics(event: FormEvent) {
    event.preventDefault();
    const { errors: fieldErrors, payload } = validateBasics(basics);
    setErrors(fieldErrors);
    if (!payload) return;
    const body: UpdateProductInput = { ...payload };
    if (blocked) delete body.isPublished; // staff block wins; publishing is refused anyway
    const result = await save.run(body);
    if (result) {
      toast.success('مشخصات محصول ذخیره شد.');
      await reload();
    }
  }

  async function addVariants() {
    const existing = new Set(product.variants.map((variant) => variant.sku));
    const duplicates = duplicateSkus(newRows).concat(newRows.map((row) => row.sku.trim().toUpperCase()).filter((sku) => existing.has(sku)));
    if (duplicates.length) return setRowsError(`SKU تکراری: ${[...new Set(duplicates)].join('، ')}`);
    const inputs = [];
    for (const row of newRows) {
      const result = variantRowToInput(row);
      if (!result.ok) return setRowsError(result.error);
      inputs.push({ key: row.key, input: result.value });
    }
    setRowsError(null);
    setAddingVariants(true);
    // One POST per variant; rows that succeed are removed so a retry only resends the failures.
    const failed = new Set<string>();
    let firstError: string | null = null;
    for (const { key, input } of inputs) {
      try {
        await apiPost(`/vendor/products/${product.id}/variants`, input);
      } catch (caught) {
        failed.add(key);
        firstError ??= `${input.sku}: ${toApiError(caught).message}`;
      }
    }
    setAddingVariants(false);
    const added = inputs.length - failed.size;
    if (added > 0) toast.success(`${toPersianDigits(added)} تنوع افزوده شد.`);
    if (firstError) {
      setRowsError(firstError);
      setNewRows((rows) => rows.filter((row) => failed.has(row.key)));
    }
    if (added > 0) await reload();
  }

  return (
    <>
      <PageHeader
        title={product.title}
        description={`آخرین به‌روزرسانی: ${formatDateTime(product.updatedAt)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ProductStatusBadge product={product} />
            {product.isPublished && !blocked ? (
              <Link href={`/products/${product.slug}`} target="_blank" className="flex items-center gap-1 text-sm text-brand-700 hover:underline">
                مشاهده در فروشگاه <ExternalLink className="size-4" />
              </Link>
            ) : null}
            <LinkButton href="/vendor/products" variant="secondary">
              بازگشت
            </LinkButton>
          </div>
        }
      />
      {blocked ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <div>
            این محصول توسط مدیریت مسدود شده و در فروشگاه نمایش داده نمی‌شود.
            {product.moderation.blockedReason ? <div className="mt-1">علت: {product.moderation.blockedReason}</div> : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <Card title="مشخصات و تصاویر">
          <form onSubmit={(event) => void saveBasics(event)} noValidate className="flex flex-col gap-4">
            <ProductBasicsFields value={basics} onChange={setBasics} errors={errors} />
            <FormError message={save.error?.message} />
            <div>
              <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
                ذخیرهٔ مشخصات
              </Button>
            </div>
          </form>
        </Card>

        <Card title={`تنوع‌ها (${toPersianDigits(product.variants.length)})`}>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="px-2 py-2 text-start font-medium">SKU</th>
                  <th className="px-2 py-2 text-start font-medium">رنگ / سایز</th>
                  <th className="px-2 py-2 text-start font-medium">قیمت (تومان)</th>
                  <th className="px-2 py-2 text-start font-medium">قبل از تخفیف</th>
                  <th className="px-2 py-2 text-start font-medium">موجودی</th>
                  <th className="px-2 py-2 text-start font-medium">رزرو / قابل فروش</th>
                  <th className="px-2 py-2 text-start font-medium">فعال</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {product.variants.map((variant) => (
                  <VariantRowEditor key={`${variant.id}-${variant.updatedAt}`} variant={variant} onSaved={() => void reload()} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="افزودن تنوع جدید">
          <VariantEditor rows={newRows} onChange={setNewRows} skuPrefix={product.slug} capacity={MAX_VARIANTS_PER_PRODUCT - product.variants.length} />
          <FormError message={rowsError} />
          {newRows.length > 0 ? (
            <div className="mt-4">
              <Button loading={addingVariants} icon={<Plus className="size-4" />} onClick={() => void addVariants()}>
                ثبت {toPersianDigits(newRows.length)} تنوع جدید
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}

function VariantRowEditor({ variant, onSaved }: { variant: VendorVariant; onSaved: () => void }) {
  const toast = useToast();
  const [price, setPrice] = useState(rialsToToman(variant.price));
  const [compare, setCompare] = useState(variant.compareAtPrice ? rialsToToman(variant.compareAtPrice) : '');
  const [stock, setStock] = useState(String(variant.stockQuantity));
  const [active, setActive] = useState(variant.isActive);
  const [error, setError] = useState<string | null>(null);
  const update = useMutation((body: UpdateVariantInput) => apiPatch<VendorVariant>(`/vendor/products/variants/${variant.id}`, body));

  async function saveRow() {
    const body: UpdateVariantInput = {};
    try {
      const nextPrice = tomanToRials(price);
      if (nextPrice <= 0) return setError('قیمت باید بیشتر از صفر باشد.');
      if (nextPrice !== Number(variant.price)) body.price = nextPrice;
      const nextCompare = compare.trim() ? tomanToRials(compare) : null;
      if (nextCompare !== null && nextCompare <= nextPrice) return setError('قیمت قبل از تخفیف باید بیشتر از قیمت فروش باشد.');
      if (nextCompare !== (variant.compareAtPrice === null ? null : Number(variant.compareAtPrice))) body.compareAtPrice = nextCompare;
    } catch (caught) {
      return setError(caught instanceof Error ? caught.message : 'مبلغ نامعتبر است.');
    }
    const stockText = toLatinDigits(stock.trim());
    if (!/^\d+$/.test(stockText) || Number(stockText) > MAX_STOCK) return setError('موجودی باید عدد صحیح نامنفی باشد.');
    if (Number(stockText) !== variant.stockQuantity) body.stockQuantity = Number(stockText);
    if (active !== variant.isActive) body.isActive = active;
    setError(null);
    if (Object.keys(body).length === 0) return;
    const result = await update.run(body);
    if (result) {
      toast.success(`تنوع ${variant.sku} به‌روزرسانی شد.`);
      onSaved();
    }
  }

  const dirty =
    price !== rialsToToman(variant.price) || compare !== (variant.compareAtPrice ? rialsToToman(variant.compareAtPrice) : '') || stock !== String(variant.stockQuantity) || active !== variant.isActive;

  return (
    <>
      <tr className={variant.isActive ? '' : 'bg-slate-50 text-slate-500'}>
        <td className="px-2 py-1.5">
          <span dir="ltr" className="font-mono text-xs">
            {variant.sku}
          </span>
        </td>
        <td className="px-2 py-1.5">
          <span className="flex items-center gap-1.5 text-xs">
            {variant.colorHex ? <span className="size-3 rounded-full border" style={{ background: variant.colorHex }} /> : null}
            {[variant.colorName, variant.size].filter(Boolean).join(' / ') || '—'}
          </span>
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="قیمت" dir="ltr" value={price} onChange={(event) => setPrice(event.target.value)} className="h-9 w-32" />
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="قیمت قبل از تخفیف" dir="ltr" value={compare} onChange={(event) => setCompare(event.target.value)} className="h-9 w-32" />
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="موجودی" dir="ltr" inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} className="h-9 w-24" />
        </td>
        <td className="px-2 py-1.5 text-xs">
          {formatCount(variant.reservedQuantity)} / <b>{formatCount(variant.availableQuantity)}</b>
        </td>
        <td className="px-2 py-1.5">
          <input type="checkbox" aria-label="فعال" checked={active} onChange={(event) => setActive(event.target.checked)} className="size-4 accent-brand-600" />
        </td>
        <td className="px-2 py-1.5">
          <Button size="sm" variant={dirty ? 'primary' : 'ghost'} disabled={!dirty} loading={update.pending} onClick={() => void saveRow()}>
            ذخیره
          </Button>
        </td>
      </tr>
      {error ?? update.error ? (
        <tr>
          <td colSpan={8} className="px-2 pb-2 text-xs text-rose-700">
            {error ?? update.error?.message}
          </td>
        </tr>
      ) : null}
    </>
  );
}
```

### `apps/frontend/src/app/vendor/products/new/page.tsx`

```tsx
'use client';

import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { EMPTY_BASICS, ProductBasicsFields, validateBasics, type ProductBasics } from '@/components/vendor/product-basics';
import { VariantEditor } from '@/components/vendor/variant-editor';
import { apiPost } from '@/lib/api/client';
import type { CreateProductInput, CreateVariantInput, VendorProductDetail } from '@/lib/api/types';
import { useMutation } from '@/lib/hooks/use-api';
import { duplicateSkus, variantRowToInput, type VariantRow } from '@/lib/product-form';

export default function NewVendorProductPage() {
  const router = useRouter();
  const toast = useToast();
  const [basics, setBasics] = useState<ProductBasics>(EMPTY_BASICS);
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [variantError, setVariantError] = useState<string | null>(null);
  const create = useMutation((body: CreateProductInput) => apiPost<VendorProductDetail>('/vendor/products', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { errors: fieldErrors, payload } = validateBasics(basics);
    setErrors(fieldErrors);
    let rowError: string | null = null;
    const variants: CreateVariantInput[] = [];
    if (rows.length === 0) rowError = 'دست‌کم یک تنوع (رنگ/سایز/قیمت/موجودی) لازم است.';
    const duplicates = duplicateSkus(rows);
    if (!rowError && duplicates.length) rowError = `SKU تکراری: ${duplicates.join('، ')}`;
    for (const row of rows) {
      if (rowError) break;
      const result = variantRowToInput(row);
      if (result.ok) variants.push(result.value);
      else rowError = result.error;
    }
    setVariantError(rowError);
    if (!payload || rowError) return;
    const product = await create.run({ ...payload, variants });
    if (product) {
      toast.success('محصول ذخیره شد.');
      router.push(`/vendor/products/${product.id}`);
    }
  }

  const skuPrefix = basics.slug || basics.title;

  return (
    <form onSubmit={(event) => void submit(event)} noValidate>
      <PageHeader
        title="افزودن محصول"
        action={
          <div className="flex gap-2">
            <LinkButton href="/vendor/products" variant="secondary">
              انصراف
            </LinkButton>
            <Button type="submit" loading={create.pending} icon={<Save className="size-4" />}>
              ذخیرهٔ محصول
            </Button>
          </div>
        }
      />
      <div className="flex flex-col gap-6">
        <Card title="مشخصات و تصاویر">
          <ProductBasicsFields value={basics} onChange={setBasics} errors={errors} />
        </Card>
        <Card title="تنوع‌ها (رنگ × سایز)">
          <VariantEditor rows={rows} onChange={setRows} skuPrefix={skuPrefix} />
        </Card>
        <FormError message={variantError ?? create.error?.message} />
        <div className="flex justify-end">
          <Button type="submit" size="lg" loading={create.pending} icon={<Save className="size-5" />}>
            ذخیرهٔ محصول
          </Button>
        </div>
      </div>
    </form>
  );
}
```

### `apps/frontend/src/app/vendor/products/page.tsx`

```tsx
'use client';

import { Eye, EyeOff, Package, Pencil, Plus, Search } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Money, PageHeader, Pagination, Table, Td } from '@/components/ui/misc';
import { ProductStatusBadge } from '@/components/vendor/product-status-badge';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Page, VendorProductStatus, VendorProductSummary } from '@/lib/api/types';
import { useApi, useDebounced } from '@/lib/hooks/use-api';
import { formatCount, formatDate } from '@/lib/format';

const STATUS_FILTERS: Array<{ value: VendorProductStatus | ''; label: string }> = [
  { value: '', label: 'همه' },
  { value: 'published', label: 'منتشرشده' },
  { value: 'draft', label: 'پیش‌نویس' },
  { value: 'blocked', label: 'مسدود توسط مدیریت' },
];

export default function VendorProductsPage() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<VendorProductStatus | ''>('');
  const [page, setPage] = useState(1);
  const term = useDebounced(search.trim(), 400);
  const state = useApi<Page<VendorProductSummary>>('/vendor/products', { search: term || undefined, status: status || undefined, page, pageSize: 20 });
  const [busyId, setBusyId] = useState<string | null>(null);

  async function togglePublish(product: VendorProductSummary) {
    setBusyId(product.id);
    try {
      await apiPatch(`/vendor/products/${product.id}`, { isPublished: !product.isPublished });
      toast.success(product.isPublished ? 'محصول از فروشگاه برداشته شد.' : 'محصول منتشر شد.');
      await state.reload();
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader
        title="محصولات"
        action={
          <LinkButton href="/vendor/products/new" icon={<Plus className="size-4" />}>
            افزودن محصول
          </LinkButton>
        }
      />
      <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              aria-pressed={status === filter.value}
              onClick={() => {
                setStatus(filter.value);
                setPage(1);
              }}
              className={`rounded-full border px-3 py-1 text-xs ${status === filter.value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
            >
              {filter.label}
            </button>
          ))}
        </div>
        <div className="relative md:w-72">
          <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
          <Input
            placeholder="جست‌وجوی عنوان یا SKU"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setPage(1);
            }}
            className="ps-9"
          />
        </div>
      </div>
      <AsyncView
        state={state}
        skeleton={<SkeletonRows rows={6} />}
        isEmpty={(data) => data.items.length === 0}
        empty={<EmptyState icon={<Package className="size-8" />} title="محصولی یافت نشد" action={<LinkButton href="/vendor/products/new">افزودن اولین محصول</LinkButton>} />}
      >
        {(data) => (
          <>
            <Table head={['محصول', 'دسته', 'قیمت', 'موجودی', 'وضعیت', 'به‌روزرسانی', '']}>
              {data.items.map((product) => (
                <tr key={product.id}>
                  <Td>
                    <Link href={`/vendor/products/${product.id}`} className="flex items-center gap-3 hover:text-brand-700">
                      <span className="relative size-12 shrink-0 overflow-hidden rounded-lg border bg-slate-50">
                        {product.primaryImage ? <Image src={product.primaryImage.thumbnailUrl ?? product.primaryImage.url} alt="" fill sizes="48px" className="object-cover" unoptimized /> : null}
                      </span>
                      <span className="line-clamp-2 font-medium">{product.title}</span>
                    </Link>
                    {product.moderation.blockedReason ? <div className="mt-1 text-xs text-rose-700">علت مسدودی: {product.moderation.blockedReason}</div> : null}
                  </Td>
                  <Td className="text-xs">{product.category.titleFa}</Td>
                  <Td>
                    {product.priceRange ? (
                      product.priceRange.min === product.priceRange.max ? (
                        <Money rials={product.priceRange.min} />
                      ) : (
                        <span className="text-xs">
                          <Money rials={product.priceRange.min} /> تا <Money rials={product.priceRange.max} />
                        </span>
                      )
                    ) : (
                      <Money rials={product.basePrice} />
                    )}
                  </Td>
                  <Td>
                    <span className={product.stock.totalAvailable === 0 ? 'text-rose-600' : ''}>{formatCount(product.stock.totalAvailable)}</span>
                    <div className="text-xs text-slate-500">{formatCount(product.stock.activeVariantCount)} تنوع فعال</div>
                  </Td>
                  <Td>
                    <ProductStatusBadge product={product} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDate(product.updatedAt)}</Td>
                  <Td>
                    <div className="flex gap-1">
                      <LinkButton href={`/vendor/products/${product.id}`} size="sm" variant="ghost" icon={<Pencil className="size-4" />} aria-label="ویرایش" />
                      {!product.moderation.isBlockedByAdmin ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyId === product.id}
                          icon={product.isPublished ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                          onClick={() => void togglePublish(product)}
                          aria-label={product.isPublished ? 'لغو انتشار' : 'انتشار'}
                          title={product.isPublished ? 'لغو انتشار' : 'انتشار'}
                        />
                      ) : null}
                    </div>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </>
  );
}
```

### `apps/frontend/src/app/vendor/register/page.tsx`

```tsx
'use client';

import { BadgeCheck, FileCheck2, Save, Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Card, DefinitionList, PageHeader, StatusBadge } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPatch, apiPost } from '@/lib/api/client';
import type { RegisterVendorInput, VendorProfile } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { isValidSheba } from '@/lib/iran';
import { VENDOR_STATUS } from '@/lib/labels';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOC_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

function normaliseIban(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Vendor onboarding and store settings:
 *  1. no store yet → POST /vendors/register;
 *  2. store exists → KYC documents (POST /vendors/verification/documents) and
 *     profile editing (PATCH /vendors/me). Staff review the documents in /admin/vendors.
 */
export default function VendorRegisterPage() {
  const { me } = useSession();
  const hasStore = Boolean(me?.vendor);
  return hasStore ? <StoreSettings /> : <RegisterForm />;
}

function RegisterForm() {
  const toast = useToast();
  const { refresh } = useSession();
  const router = useRouter();
  const [form, setForm] = useState<RegisterVendorInput>({ storeName: '', storeSlug: '', instagramHandle: '', bio: '', bankIban: 'IR', bankAccountHolder: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const register = useMutation((body: RegisterVendorInput) => apiPost<VendorProfile>('/vendors/register', body));
  const set = (key: keyof RegisterVendorInput) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const iban = normaliseIban(form.bankIban);
    const next: Record<string, string> = {};
    if (form.storeName.trim().length < 2) next.storeName = 'نام فروشگاه دست‌کم ۲ نویسه است.';
    if (!SLUG.test(form.storeSlug) || form.storeSlug.length < 3) next.storeSlug = 'فقط حروف کوچک لاتین، رقم و خط تیره (دست‌کم ۳ نویسه).';
    if (!isValidSheba(iban)) next.bankIban = 'شمارهٔ شبا معتبر نیست.';
    if (form.bankAccountHolder.trim().length < 3) next.bankAccountHolder = 'نام صاحب حساب را وارد کنید.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const body: RegisterVendorInput = {
      storeName: form.storeName.trim(),
      storeSlug: form.storeSlug,
      bankIban: iban,
      bankAccountHolder: form.bankAccountHolder.trim(),
      ...(form.instagramHandle?.trim() ? { instagramHandle: form.instagramHandle.trim().replace(/^@/, '') } : {}),
      ...(form.bio?.trim() ? { bio: form.bio.trim() } : {}),
    };
    const vendor = await register.run(body);
    if (vendor) {
      toast.success('فروشگاه ساخته شد. اکنون مدارک احراز هویت را بارگذاری کنید.');
      await refresh();
      router.refresh();
    }
  }

  return (
    <>
      <PageHeader title="فروشنده شوید" description="ثبت فروشگاه در شاپینو — پس از بارگذاری مدارک و تأیید کارشناسان، پنل فروشنده فعال می‌شود." />
      <Card title="اطلاعات فروشگاه">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4 md:grid-cols-2" noValidate>
          <Field label="نام فروشگاه" required error={errors.storeName}>
            {(id, described) => <Input id={id} aria-describedby={described} maxLength={120} value={form.storeName} onChange={(event) => set('storeName')(event.target.value)} />}
          </Field>
          <Field label="نامک (آدرس فروشگاه)" required error={errors.storeSlug} hint="مثال: pars-digital">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={140} value={form.storeSlug} onChange={(event) => set('storeSlug')(event.target.value.toLowerCase())} />}
          </Field>
          <Field label="شمارهٔ شبا" required error={errors.bankIban} hint="تسویه‌ها فقط به این حساب واریز می‌شود.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={34} value={form.bankIban} onChange={(event) => set('bankIban')(event.target.value)} />}
          </Field>
          <Field label="نام صاحب حساب" required error={errors.bankAccountHolder}>
            {(id, described) => <Input id={id} aria-describedby={described} maxLength={120} value={form.bankAccountHolder} onChange={(event) => set('bankAccountHolder')(event.target.value)} />}
          </Field>
          <Field label="اینستاگرام (اختیاری)">{(id) => <Input id={id} dir="ltr" maxLength={60} placeholder="@store" value={form.instagramHandle} onChange={(event) => set('instagramHandle')(event.target.value)} />}</Field>
          <Field label="معرفی فروشگاه (اختیاری)" className="md:col-span-2">
            {(id) => <Textarea id={id} rows={3} maxLength={2000} value={form.bio} onChange={(event) => set('bio')(event.target.value)} />}
          </Field>
          <div className="md:col-span-2">
            <FormError message={register.error?.message} />
          </div>
          <div className="md:col-span-2">
            <Button type="submit" size="lg" loading={register.pending} icon={<Store className="size-5" />}>
              ساخت فروشگاه
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function StoreSettings() {
  const state = useApi<VendorProfile>('/vendors/me');
  return (
    <>
      <PageHeader title="فروشگاه و مدارک" description="وضعیت احراز هویت، مدارک و مشخصات فروشگاه" />
      <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
        {(vendor) => (
          <div className="grid gap-6 lg:grid-cols-2">
            <VerificationCard vendor={vendor} onChange={state.setData} />
            <ProfileCard vendor={vendor} onChange={state.setData} />
          </div>
        )}
      </AsyncView>
    </>
  );
}

function VerificationCard({ vendor, onChange }: { vendor: VendorProfile; onChange: (vendor: VendorProfile) => void }) {
  const toast = useToast();
  const [nationalId, setNationalId] = useState<UploadedFile[]>([]);
  const [license, setLicense] = useState<UploadedFile[]>([]);
  const [bankProof, setBankProof] = useState<UploadedFile[]>([]);
  const submit = useMutation((body: Record<string, string>) => apiPost<VendorProfile>('/vendors/verification/documents', body));
  const verification = vendor.verification;
  const awaitingReview = verification !== null && verification.reviewedAt === null;

  async function send() {
    const [id] = nationalId;
    if (!id) {
      toast.error('تصویر کارت ملی الزامی است.');
      return;
    }
    const body: Record<string, string> = { nationalIdCardUrl: id.url };
    if (license[0]) body.businessLicenseUrl = license[0].url;
    if (bankProof[0]) body.bankAccountProofUrl = bankProof[0].url;
    const result = await submit.run(body);
    if (result) {
      onChange(result);
      setNationalId([]);
      setLicense([]);
      setBankProof([]);
      toast.success('مدارک ارسال شد و در صف بررسی قرار گرفت.');
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <BadgeCheck className="size-5 text-brand-600" /> احراز هویت
        </span>
      }
      action={<StatusBadge value={vendor.status} map={VENDOR_STATUS} />}
    >
      <div className="flex flex-col gap-4">
        {vendor.status === 'APPROVED' ? <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">فروشگاه در {vendor.verifiedAt ? formatDateTime(vendor.verifiedAt) : '—'} تأیید شد.</p> : null}
        {verification?.rejectionReason ? <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">علت رد: {verification.rejectionReason}</p> : null}
        {verification ? (
          <DefinitionList
            items={[
              { label: 'آخرین ارسال', value: formatDateTime(verification.createdAt) },
              { label: 'بررسی', value: verification.reviewedAt ? `${formatDateTime(verification.reviewedAt)}${verification.reviewedByName ? ` — ${verification.reviewedByName}` : ''}` : 'در انتظار بررسی' },
              {
                label: 'مدارک',
                value: (
                  <span className="flex flex-wrap gap-2">
                    <a className="text-brand-700 underline" href={verification.nationalIdCardUrl} target="_blank" rel="noopener noreferrer">
                      کارت ملی
                    </a>
                    {verification.businessLicenseUrl ? (
                      <a className="text-brand-700 underline" href={verification.businessLicenseUrl} target="_blank" rel="noopener noreferrer">
                        جواز کسب
                      </a>
                    ) : null}
                    {verification.bankAccountProofUrl ? (
                      <a className="text-brand-700 underline" href={verification.bankAccountProofUrl} target="_blank" rel="noopener noreferrer">
                        مالکیت حساب
                      </a>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <p className="text-sm text-slate-600">برای فعال شدن فروشگاه، مدارک زیر را بارگذاری کنید.</p>
        )}
        {vendor.status !== 'APPROVED' && !awaitingReview ? (
          <>
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_national_id' }} value={nationalId} onChange={setNationalId} max={1} accept={DOC_ACCEPT} label="کارت ملی (الزامی)" />
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_business_license' }} value={license} onChange={setLicense} max={1} accept={DOC_ACCEPT} label="جواز کسب (اختیاری)" />
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_bank_proof' }} value={bankProof} onChange={setBankProof} max={1} accept={DOC_ACCEPT} label="گواهی مالکیت حساب (اختیاری)" />
            <FormError message={submit.error?.message} />
            <Button loading={submit.pending} icon={<FileCheck2 className="size-4" />} onClick={() => void send()}>
              ارسال مدارک برای بررسی
            </Button>
          </>
        ) : null}
        {awaitingReview && vendor.status !== 'APPROVED' ? <p className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">مدارک شما دریافت شده و در صف بررسی کارشناسان است.</p> : null}
      </div>
    </Card>
  );
}

function ProfileCard({ vendor, onChange }: { vendor: VendorProfile; onChange: (vendor: VendorProfile) => void }) {
  const toast = useToast();
  const { refresh } = useSession();
  const [storeName, setStoreName] = useState(vendor.storeName);
  const [bio, setBio] = useState(vendor.bio ?? '');
  const [instagram, setInstagram] = useState(vendor.instagramHandle ?? '');
  const [logo, setLogo] = useState<UploadedFile[]>([]);
  const [iban, setIban] = useState(vendor.bankIban);
  const [ibanProof, setIbanProof] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation((body: Record<string, string>) => apiPatch<VendorProfile>('/vendors/me', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, string> = {};
    if (storeName.trim() !== vendor.storeName) body.storeName = storeName.trim();
    if (bio.trim() !== (vendor.bio ?? '')) body.bio = bio.trim();
    const handle = instagram.trim().replace(/^@/, '');
    if (handle !== (vendor.instagramHandle ?? '')) body.instagramHandle = handle;
    if (logo[0]) body.logoUrl = logo[0].url;
    const nextIban = normaliseIban(iban);
    if (nextIban !== vendor.bankIban) {
      if (!isValidSheba(nextIban)) return setError('شمارهٔ شبا معتبر نیست.');
      if (!ibanProof[0]) return setError('برای تغییر شبا، گواهی مالکیت حساب جدید را بارگذاری کنید.');
      body.bankIban = nextIban;
      body.bankAccountProofUrl = ibanProof[0].url;
    }
    setError(null);
    if (Object.keys(body).length === 0) {
      toast.info('تغییری برای ذخیره وجود ندارد.');
      return;
    }
    const result = await save.run(body);
    if (result) {
      onChange(result);
      setLogo([]);
      setIbanProof([]);
      await refresh();
      toast.success(body.bankIban ? 'ذخیره شد. تا تأیید شبای جدید، فروشگاه در وضعیت بررسی است.' : 'مشخصات فروشگاه ذخیره شد.');
    }
  }

  const ibanChanged = normaliseIban(iban) !== vendor.bankIban;

  return (
    <Card title="مشخصات فروشگاه">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          {vendor.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- media URL from the API
            <img src={vendor.logoUrl} alt="" className="size-14 rounded-xl border object-cover" />
          ) : null}
          <span dir="ltr">/{vendor.storeSlug}</span>
        </div>
        <Field label="نام فروشگاه">{(id) => <Input id={id} maxLength={120} value={storeName} onChange={(event) => setStoreName(event.target.value)} />}</Field>
        <Field label="اینستاگرام">{(id) => <Input id={id} dir="ltr" maxLength={60} value={instagram} onChange={(event) => setInstagram(event.target.value)} />}</Field>
        <Field label="معرفی">{(id) => <Textarea id={id} rows={3} maxLength={2000} value={bio} onChange={(event) => setBio(event.target.value)} />}</Field>
        <FileDrop upload={{ kind: 'image', purpose: 'store_logo' }} value={logo} onChange={setLogo} max={1} accept="image/jpeg,image/png,image/webp" label="لوگوی جدید" />
        <Field label="شمارهٔ شبا" hint="تغییر شبا نیازمند گواهی مالکیت و تأیید دوباره است.">
          {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={34} value={iban} onChange={(event) => setIban(event.target.value)} />}
        </Field>
        {ibanChanged ? <FileDrop upload={{ kind: 'document', purpose: 'kyc_bank_proof' }} value={ibanProof} onChange={setIbanProof} max={1} accept={DOC_ACCEPT} label="گواهی مالکیت حساب جدید" /> : null}
        <FormError message={error ?? save.error?.message} />
        <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
          ذخیره
        </Button>
      </form>
    </Card>
  );
}
```

### `apps/frontend/src/app/vendor/wallet/page.tsx`

```tsx
'use client';

import { ArrowDownLeft, ArrowUpRight, Banknote, Landmark } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Select, TomanInput } from '@/components/ui/field';
import { Card, Money, PageHeader, Pagination, StatCard, StatusBadge, Table, Td } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { AsyncView, EmptyState, ErrorState, Skeleton, SkeletonRows } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { Page, SettlementRequest, VendorProfile, WalletBalanceBucket, WalletSummary, WalletTransaction } from '@/lib/api/types';
import { WALLET_BUCKETS } from '@/lib/api/types';
import { formatToman, rialsToToman, tomanToRials } from '@/lib/currency';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { compareRials } from '@/lib/money';
import { SETTLEMENT_STATUS, WALLET_BUCKET_LABELS, WALLET_TX_LABELS } from '@/lib/labels';

export default function VendorWalletPage() {
  const wallet = useApi<WalletSummary>('/vendor/wallet');
  const [requestOpen, setRequestOpen] = useState(false);
  const [settlementsKey, setSettlementsKey] = useState(0);

  return (
    <>
      <PageHeader
        title="کیف پول و تسویه"
        description="درآمد هر مرسوله پس از تأیید تحویل از «امانی» به «قابل برداشت» منتقل می‌شود."
        action={
          <Button icon={<Banknote className="size-4" />} disabled={!wallet.data || compareRials(wallet.data.withdrawableBalance, 0) <= 0} onClick={() => setRequestOpen(true)}>
            درخواست تسویه
          </Button>
        }
      />
      {wallet.loading && !wallet.data ? (
        <Skeleton className="h-28" />
      ) : wallet.error && !wallet.data ? (
        <ErrorState error={wallet.error} onRetry={() => void wallet.reload()} />
      ) : wallet.data ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="قابل برداشت" value={<Money rials={wallet.data.withdrawableBalance} />} tone="success" />
          <StatCard label="امانی (در انتظار تحویل)" value={<Money rials={wallet.data.pendingBalance} />} tone="warning" />
          <StatCard label="در حال تسویه" value={<Money rials={wallet.data.settlementHoldBalance} />} tone="info" />
          <StatCard label="مسدود به‌دلیل اختلاف" value={<Money rials={wallet.data.disputeHoldBalance} />} tone="danger" />
          <StatCard label="کل درآمد" value={<Money rials={wallet.data.totalEarnedBalance} />} />
          <StatCard label="کل برداشت‌شده" value={<Money rials={wallet.data.totalWithdrawnAmount} />} />
        </div>
      ) : null}

      <div className="mt-6 flex flex-col gap-6">
        <Settlements key={settlementsKey} />
        <Ledger />
      </div>

      {requestOpen && wallet.data ? (
        <SettlementModal
          withdrawable={wallet.data.withdrawableBalance}
          onClose={() => setRequestOpen(false)}
          onDone={() => {
            setRequestOpen(false);
            void wallet.reload();
            setSettlementsKey((key) => key + 1);
          }}
        />
      ) : null}
    </>
  );
}

function Settlements() {
  const [page, setPage] = useState(1);
  const state = useApi<Page<SettlementRequest>>('/vendor/wallet/settlements', { page, pageSize: 10 });
  return (
    <Card title="درخواست‌های تسویه">
      <AsyncView state={state} skeleton={<SkeletonRows rows={3} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Landmark className="size-8" />} title="هنوز درخواست تسویه‌ای ثبت نکرده‌اید" />}>
        {(data) => (
          <>
            <Table head={['مبلغ', 'شبا', 'وضعیت', 'پیگیری پایا', 'ثبت', 'رسیدگی']}>
              {data.items.map((item) => (
                <tr key={item.id}>
                  <Td className="font-bold">
                    <Money rials={item.amount} />
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.targetIban}
                    </span>
                  </Td>
                  <Td>
                    <StatusBadge value={item.status} map={SETTLEMENT_STATUS} />
                    {item.rejectionReason ? <div className="mt-1 text-xs text-rose-700">{item.rejectionReason}</div> : null}
                  </Td>
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {item.bankPayaReference ?? '—'}
                    </span>
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(item.createdAt)}</Td>
                  <Td className="text-xs text-slate-500">{item.processedAt ? formatDateTime(item.processedAt) : '—'}</Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </Card>
  );
}

function Ledger() {
  const [page, setPage] = useState(1);
  const [bucket, setBucket] = useState<WalletBalanceBucket | ''>('');
  const state = useApi<Page<WalletTransaction>>('/vendor/wallet/transactions', { page, pageSize: 20, bucket: bucket || undefined });
  return (
    <Card
      title="گردش حساب"
      action={
        <Select
          aria-label="صندوق"
          value={bucket}
          onChange={(event) => {
            setBucket(event.target.value as WalletBalanceBucket | '');
            setPage(1);
          }}
          className="h-9 w-44 text-xs"
        >
          <option value="">همهٔ صندوق‌ها</option>
          {WALLET_BUCKETS.map((value) => (
            <option key={value} value={value}>
              {WALLET_BUCKET_LABELS[value]}
            </option>
          ))}
        </Select>
      }
    >
      <AsyncView state={state} skeleton={<SkeletonRows rows={6} className="h-10" />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState title="تراکنشی ثبت نشده است" />}>
        {(data) => (
          <>
            <Table head={['نوع', 'صندوق', 'مبلغ', 'مانده پس از تراکنش', 'مرسوله', 'زمان']}>
              {data.items.map((tx) => {
                const incoming = compareRials(tx.amount, 0) >= 0;
                return (
                  <tr key={tx.id}>
                    <Td>
                      <span className="flex items-center gap-1.5">
                        {incoming ? <ArrowDownLeft className="size-4 text-emerald-600" /> : <ArrowUpRight className="size-4 text-rose-600" />}
                        {WALLET_TX_LABELS[tx.type]}
                      </span>
                      {tx.description ? <div className="text-xs text-slate-500">{tx.description}</div> : null}
                    </Td>
                    <Td className="text-xs">{WALLET_BUCKET_LABELS[tx.bucket]}</Td>
                    <Td className={incoming ? 'text-emerald-700' : 'text-rose-700'}>
                      <Money rials={tx.amount} />
                    </Td>
                    <Td>
                      <Money rials={tx.balanceAfter} />
                    </Td>
                    <Td>
                      <span dir="ltr" className="font-mono text-xs">
                        {tx.subOrderNumber ?? '—'}
                      </span>
                    </Td>
                    <Td className="text-xs text-slate-500">{formatDateTime(tx.createdAt)}</Td>
                  </tr>
                );
              })}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </Card>
  );
}

function SettlementModal({ withdrawable, onClose, onDone }: { withdrawable: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const profile = useApi<VendorProfile>('/vendors/me');
  const [amount, setAmount] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);
  const request = useMutation((body: { amount: number; targetIban: string }) => apiPost<SettlementRequest>('/vendor/wallet/settlements', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!profile.data) return;
    let rials: number;
    try {
      rials = tomanToRials(amount);
    } catch (caught) {
      return setLocalError(caught instanceof Error ? caught.message : 'مبلغ معتبر نیست.');
    }
    if (rials <= 0) return setLocalError('مبلغ باید بیشتر از صفر باشد.');
    if (compareRials(rials, withdrawable) > 0) return setLocalError(`حداکثر مبلغ قابل برداشت ${formatToman(withdrawable)} است.`);
    setLocalError(null);
    const result = await request.run({ amount: rials, targetIban: profile.data.bankIban });
    if (result) {
      toast.success('درخواست تسویه ثبت شد و پس از تأیید واحد مالی از طریق پایا واریز می‌شود.');
      onDone();
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="درخواست تسویه"
      footer={
        <>
          <Button type="submit" form="settlement-form" loading={request.pending} disabled={!profile.data}>
            ثبت درخواست
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <form id="settlement-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          قابل برداشت: <Money rials={withdrawable} className="font-bold" />
        </p>
        <Field label="مبلغ (تومان)" required>
          {(id) => (
            <div className="flex gap-2">
              <div className="flex-1">
                <TomanInput id={id} value={amount} onChange={(event) => setAmount(event.target.value)} />
              </div>
              <Button variant="secondary" size="sm" onClick={() => setAmount(rialsToToman(withdrawable))}>
                کل مبلغ
              </Button>
            </div>
          )}
        </Field>
        <Field label="واریز به شبا" hint="تسویه فقط به شبای تأییدشدهٔ فروشگاه انجام می‌شود؛ برای تغییر آن به «فروشگاه و مدارک» بروید.">
          {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" readOnly value={profile.data?.bankIban ?? (profile.loading ? '…' : '')} />}
        </Field>
        <FormError message={localError ?? request.error?.message ?? profile.error?.message} />
      </form>
    </Modal>
  );
}
```

### `apps/frontend/src/components/auth/login-form.tsx`

```tsx
'use client';

import { FlaskConical, KeyRound, Smartphone } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { apiGet, sessionClient } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AuthUser, OtpRequestResponse } from '@/lib/api/types';
import { homeForRole, safeNextPath } from '@/lib/auth/access';
import { formatMobile, toLatinDigits, toPersianDigits } from '@/lib/format';
import { IRAN_MOBILE_PATTERN } from '@/lib/iran';

type Mode = 'otp' | 'password';

/**
 * Sign-in: mobile + one-time code (customers, sign-up on first login) or
 * email/mobile + password (staff and vendors). Both post to the BFF, which
 * stores the tokens in httpOnly cookies and merges the guest cart.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useSession();
  const next = safeNextPath(params.get('next'));

  const [mode, setMode] = useState<Mode>('otp');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<OtpRequestResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSms, setTestSms] = useState(false);

  useEffect(() => {
    apiGet<{ provider: string; isTestProvider: boolean }>('/auth/sms-provider')
      .then((info) => setTestSms(info.isTestProvider))
      .catch(() => setTestSms(false));
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function finish(user: AuthUser) {
    await refresh();
    router.replace(next ?? homeForRole(user.role));
    router.refresh();
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    const normalised = toLatinDigits(mobile).replace(/[\s-]/g, '');
    if (!IRAN_MOBILE_PATTERN.test(normalised)) {
      setError('شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<OtpRequestResponse>('/otp', { mobile: normalised });
      setSent(data);
      setSecondsLeft(Math.min(data.expiresInSeconds, 120));
      setCode('');
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    const normalisedCode = toLatinDigits(code).trim();
    if (!/^\d{4,8}$/.test(normalisedCode)) {
      setError('کد تأیید را کامل وارد کنید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<{ user: AuthUser }>('/verify', { mobile: toLatinDigits(mobile).replace(/[\s-]/g, ''), code: normalisedCode });
      await finish(data.user);
    } catch (caught) {
      setError(toApiError(caught).message);
      setBusy(false);
    }
  }

  async function passwordLogin(event: FormEvent) {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError('شناسه و رمز عبور را وارد کنید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<{ user: AuthUser }>('/password', { identifier: toLatinDigits(identifier.trim()), password });
      await finish(data.user);
    } catch (caught) {
      setError(toApiError(caught).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      <h1 className="mb-1 text-xl font-black text-slate-900">ورود به شاپینو</h1>
      <p className="mb-6 text-sm text-slate-500">{next ? 'برای ادامه وارد حساب خود شوید.' : 'خرید، پیگیری سفارش و مدیریت فروشگاه'}</p>

      <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
        {(
          [
            { id: 'otp', label: 'ورود با کد یکبارمصرف', icon: Smartphone },
            { id: 'password', label: 'ورود با رمز عبور', icon: KeyRound },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            onClick={() => {
              setMode(tab.id);
              setError(null);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium sm:text-sm ${mode === tab.id ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}
          >
            <tab.icon className="size-4" /> {tab.label}
          </button>
        ))}
      </div>

      {mode === 'otp' ? (
        !sent ? (
          <form onSubmit={(event) => void requestCode(event)} className="flex flex-col gap-4" noValidate>
            <Field label="شمارهٔ موبایل" hint="اگر حساب ندارید، با همین شماره ساخته می‌شود.">
              {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="tel" autoComplete="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="09121234567" autoFocus />}
            </Field>
            <FormError message={error} />
            <Button type="submit" size="lg" loading={busy}>
              دریافت کد تأیید
            </Button>
          </form>
        ) : (
          <form onSubmit={(event) => void verify(event)} className="flex flex-col gap-4" noValidate>
            <p className="text-sm text-slate-600">
              کد ارسال‌شده به <b dir="ltr">{formatMobile(toLatinDigits(mobile))}</b> را وارد کنید.{' '}
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setSent(null)}>
                تغییر شماره
              </button>
            </p>
            <Field label="کد تأیید">
              {(id) => <Input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} className="text-center text-lg tracking-[0.5em]" autoFocus />}
            </Field>
            <FormError message={error} />
            <Button type="submit" size="lg" loading={busy}>
              ورود
            </Button>
            <button type="button" disabled={secondsLeft > 0 || busy} onClick={() => void requestCode()} className="text-sm text-brand-700 disabled:text-slate-400">
              {secondsLeft > 0 ? `ارسال دوباره تا ${toPersianDigits(secondsLeft)} ثانیهٔ دیگر` : 'ارسال دوبارهٔ کد'}
            </button>
          </form>
        )
      ) : (
        <form onSubmit={(event) => void passwordLogin(event)} className="flex flex-col gap-4" noValidate>
          <Field label="ایمیل یا شمارهٔ موبایل">
            {(id) => <Input id={id} dir="ltr" autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoFocus />}
          </Field>
          <Field label="رمز عبور">
            {(id) => <Input id={id} type="password" dir="ltr" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />}
          </Field>
          <FormError message={error} />
          <Button type="submit" size="lg" loading={busy}>
            ورود
          </Button>
          <p className="text-xs leading-5 text-slate-500">ورود با رمز برای کارکنان و فروشندگانی است که رمز عبور تعیین کرده‌اند.</p>
        </form>
      )}

      {testSms && mode === 'otp' ? (
        <p className="mt-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          محیط توسعه: سرویس پیامک آزمایشی (Sandbox) فعال است و پیامک واقعی ارسال نمی‌شود؛ کد در لاگ سرور ثبت می‌شود.
        </p>
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/components/catalog/installment-calculator.tsx`

```tsx
'use client';

import { CalendarClock } from 'lucide-react';
import { useState } from 'react';

import type { CreditPlans } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatPercent, toPersianDigits } from '@/lib/format';
import { previewInstallments } from '@/lib/installments';

/**
 * Installment calculator over the provider's live plans (e.g. 3 months 0%,
 * 6 and 12 months with interest). Numbers come from lib/installments, which
 * mirrors the backend's schedule arithmetic exactly.
 */
export function InstallmentCalculator({ amount, plans }: { amount: string; plans: CreditPlans }) {
  const sorted = [...plans.items].sort((a, b) => a.durationMonths - b.durationMonths);
  const [planId, setPlanId] = useState(sorted[0]?.id ?? '');
  const plan = sorted.find((item) => item.id === planId) ?? sorted[0];
  if (!plan) return null;
  const preview = previewInstallments(amount, plan.interestRatePercent, plan.durationMonths);
  const zero = Number(plan.interestRatePercent) === 0;

  return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4" aria-labelledby="installment-calc-title">
      <h2 id="installment-calc-title" className="mb-3 flex items-center gap-2 text-sm font-bold text-emerald-900">
        <CalendarClock className="size-4" /> محاسبهٔ اقساط {plans.provider ? `— ${plans.provider.name}` : ''}
      </h2>
      <div className="mb-4 grid grid-cols-3 gap-2" role="radiogroup" aria-label="طرح اقساط">
        {sorted.map((item) => {
          const active = item.id === plan.id;
          return (
            <button
              key={item.id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => setPlanId(item.id)}
              className={`flex flex-col items-center gap-0.5 rounded-xl border px-2 py-2 text-center ${active ? 'border-emerald-600 bg-white ring-2 ring-emerald-100' : 'border-emerald-200 bg-white/60'}`}
            >
              <span className="text-sm font-bold text-slate-900">{toPersianDigits(item.durationMonths)} ماهه</span>
              <span className={`text-xs ${Number(item.interestRatePercent) === 0 ? 'font-bold text-emerald-700' : 'text-slate-500'}`}>
                {Number(item.interestRatePercent) === 0 ? 'بدون سود' : `سود ${formatPercent(item.interestRatePercent)}`}
              </span>
            </button>
          );
        })}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">مبلغ هر قسط</dt>
          <dd className="mt-1 font-black text-emerald-800">{formatToman(preview.regularInstallment)}</dd>
        </div>
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">تعداد اقساط</dt>
          <dd className="mt-1 font-bold text-slate-900">
            {toPersianDigits(plan.durationMonths)} قسط، هر {toPersianDigits(plan.installmentIntervalDays)} روز
          </dd>
        </div>
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">سود کل</dt>
          <dd className="mt-1 font-bold text-slate-900">{zero ? 'بدون سود' : formatToman(preview.totalInterest)}</dd>
        </div>
        <div className="rounded-xl bg-white p-3">
          <dt className="text-xs text-slate-500">مجموع بازپرداخت</dt>
          <dd className="mt-1 font-bold text-slate-900">{formatToman(preview.totalPayable)}</dd>
        </div>
      </dl>
      <p className="mt-3 text-xs leading-5 text-emerald-900/70">
        محاسبه برای قیمت کالای انتخاب‌شده (بدون هزینهٔ ارسال) است. جدول قطعی اقساط هنگام پرداخت ساخته می‌شود؛ جریمهٔ دیرکرد ماهانه {formatPercent(plan.penaltyRatePercentPerMonth)}.
      </p>
    </section>
  );
}
```

### `apps/frontend/src/components/catalog/product-browser.tsx`

```tsx
'use client';

import { Filter, PackageSearch, Search, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Pagination } from '@/components/ui/misc';
import { EmptyState, ErrorState, SkeletonCards } from '@/components/ui/states';
import type { CategoryTreeNode, ColorOption, Page, ProductListItem, ProductSort } from '@/lib/api/types';
import { PRODUCT_SORTS } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatCount } from '@/lib/format';
import { useApi, useDebounced } from '@/lib/hooks/use-api';
import { SORT_LABELS } from '@/lib/labels';
import { compareRials, toRialCents } from '@/lib/money';

import { ProductGrid } from './product-card';

const PAGE_SIZE = 24;
/** Facets (colours, sizes, price ceiling) are derived from up to this many matching products. */
const FACET_SAMPLE = 100;

interface ProductBrowserProps {
  /** Category page: the category is fixed by the route. */
  fixedCategorySlug?: string;
  tree: CategoryTreeNode[];
  bnplEnabled: boolean;
}

function splitList(value: string | null): string[] {
  return value ? value.split(',').map((item) => item.trim()).filter(Boolean) : [];
}

function parseSort(value: string | null): ProductSort {
  return (PRODUCT_SORTS as readonly string[]).includes(value ?? '') ? (value as ProductSort) : 'newest';
}

/** Whole Rials from a URL value, or undefined. */
function parseRials(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

/**
 * Search/category listing. Filters live in the URL (shareable, back-button
 * friendly) and every change queries GET /products live. The text box is
 * debounced (instant search) — no submit needed.
 */
export function ProductBrowser({ fixedCategorySlug, tree, bnplEnabled }: ProductBrowserProps) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const q = params.get('q') ?? '';
  const sort = parseSort(params.get('sort'));
  const categorySlug = fixedCategorySlug ?? params.get('category') ?? undefined;
  const vendorSlug = params.get('vendor') ?? undefined;
  const minPrice = parseRials(params.get('minPrice'));
  const maxPrice = parseRials(params.get('maxPrice'));
  const inStockOnly = params.get('inStock') === '1';
  const colors = splitList(params.get('colors'));
  const sizes = splitList(params.get('sizes'));
  const page = Math.max(1, Number(params.get('page')) || 1);

  const [term, setTerm] = useState(q);
  const debouncedTerm = useDebounced(term.trim(), 350);
  const [filtersOpen, setFiltersOpen] = useState(false);

  function update(changes: Record<string, string | null>, resetPage = true) {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (resetPage) next.delete('page');
    const text = next.toString();
    router.replace(text ? `${pathname}?${text}` : pathname, { scroll: false });
  }

  // Instant search: push the debounced term into the URL.
  useEffect(() => {
    if (debouncedTerm !== q.trim()) update({ q: debouncedTerm || null });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the debounced term drives this
  }, [debouncedTerm]);
  // Keep the box in sync when the URL changes from elsewhere (header search, back button).
  useEffect(() => setTerm(q), [q]);

  const results = useApi<Page<ProductListItem>>('/products', {
    search: q || undefined,
    categorySlug,
    vendorSlug,
    minPrice,
    maxPrice,
    inStockOnly: inStockOnly || undefined,
    colors,
    sizes,
    sortBy: sort,
    page,
    pageSize: PAGE_SIZE,
  });

  // Facet sample: same text/category scope, without the facet filters themselves.
  const facetSample = useApi<Page<ProductListItem>>('/products', { search: q || undefined, categorySlug, vendorSlug, pageSize: FACET_SAMPLE, sortBy: 'price_desc' });
  const facets = useMemo(() => {
    const colorMap = new Map<string, ColorOption>();
    const sizeSet = new Set<string>();
    let ceiling = '0';
    for (const item of facetSample.data?.items ?? []) {
      for (const color of item.colors) if (!colorMap.has(color.name)) colorMap.set(color.name, color);
      for (const size of item.sizes) sizeSet.add(size);
      if (compareRials(item.priceRange.max, ceiling) > 0) ceiling = item.priceRange.max;
    }
    return { colors: [...colorMap.values()], sizes: [...sizeSet], ceiling: Number(toRialCents(ceiling) / 100n) };
  }, [facetSample.data]);

  const activeFilterCount = (minPrice !== undefined || maxPrice !== undefined ? 1 : 0) + (inStockOnly ? 1 : 0) + colors.length + sizes.length + (!fixedCategorySlug && categorySlug ? 1 : 0);

  const toggleInList = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]).join(',') || null;

  const sidebar = (
    <div className="flex flex-col gap-6">
      <FilterSection title="دسته‌بندی">
        <CategoryTreeFilter
          nodes={tree}
          activeSlug={categorySlug}
          hrefFor={(slug) => {
            if (fixedCategorySlug) {
              const keep = new URLSearchParams(params.toString());
              keep.delete('page');
              const text = keep.toString();
              return `/categories/${slug}${text ? `?${text}` : ''}`;
            }
            const next = new URLSearchParams(params.toString());
            next.delete('page');
            if (slug) next.set('category', slug);
            else next.delete('category');
            const text = next.toString();
            return `${pathname}${text ? `?${text}` : ''}`;
          }}
          allowAll={!fixedCategorySlug}
        />
      </FilterSection>

      <FilterSection title="محدودهٔ قیمت">
        {facetSample.loading && facetSample.data === undefined ? (
          <div className="h-10 animate-pulse rounded-lg bg-slate-100" />
        ) : facets.ceiling > 0 ? (
          <PriceRangeSlider
            key={`${categorySlug ?? ''}-${facets.ceiling}`}
            ceiling={facets.ceiling}
            min={minPrice}
            max={maxPrice}
            onCommit={(nextMin, nextMax) => update({ minPrice: nextMin === undefined ? null : String(nextMin), maxPrice: nextMax === undefined ? null : String(nextMax) })}
          />
        ) : (
          <p className="text-xs text-slate-500">محصولی برای تعیین بازهٔ قیمت نیست.</p>
        )}
      </FilterSection>

      <FilterSection title="موجودی">
        <label className="flex cursor-pointer items-center justify-between gap-3 text-sm text-slate-700">
          فقط کالاهای موجود
          <button
            type="button"
            role="switch"
            aria-checked={inStockOnly}
            onClick={() => update({ inStock: inStockOnly ? null : '1' })}
            className={`relative h-6 w-11 rounded-full transition ${inStockOnly ? 'bg-brand-600' : 'bg-slate-300'}`}
          >
            <span className={`absolute top-0.5 size-5 rounded-full bg-white shadow transition-all ${inStockOnly ? 'start-[1.375rem]' : 'start-0.5'}`} />
          </button>
        </label>
      </FilterSection>

      {facets.colors.length > 0 ? (
        <FilterSection title="رنگ">
          <div className="flex flex-wrap gap-2">
            {facets.colors.map((color) => {
              const active = colors.includes(color.name);
              return (
                <button
                  key={color.name}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ colors: toggleInList(colors, color.name) })}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${active ? 'border-brand-600 bg-brand-50 font-bold text-brand-700' : 'border-slate-300 text-slate-700'}`}
                >
                  <span className="size-3.5 rounded-full border border-slate-300" style={{ backgroundColor: color.hex ?? '#e2e8f0' }} />
                  {color.name}
                </button>
              );
            })}
          </div>
        </FilterSection>
      ) : null}

      {facets.sizes.length > 0 ? (
        <FilterSection title="سایز">
          <div className="flex flex-wrap gap-2">
            {facets.sizes.map((size) => {
              const active = sizes.includes(size);
              return (
                <button
                  key={size}
                  type="button"
                  aria-pressed={active}
                  onClick={() => update({ sizes: toggleInList(sizes, size) })}
                  className={`min-w-10 rounded-lg border px-2.5 py-1 text-xs ${active ? 'border-brand-600 bg-brand-50 font-bold text-brand-700' : 'border-slate-300 text-slate-700'}`}
                >
                  {size}
                </button>
              );
            })}
          </div>
        </FilterSection>
      ) : null}

      {activeFilterCount > 0 ? (
        <button
          type="button"
          onClick={() => update({ minPrice: null, maxPrice: null, inStock: null, colors: null, sizes: null, ...(fixedCategorySlug ? {} : { category: null }) })}
          className="inline-flex items-center justify-center gap-1 rounded-xl border border-slate-300 py-2 text-sm text-slate-700 hover:bg-slate-50"
        >
          <X className="size-4" /> حذف همهٔ فیلترها
        </button>
      ) : null}
    </div>
  );

  return (
    <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
      <aside className="hidden w-72 shrink-0 rounded-2xl border border-slate-200 bg-white p-4 lg:sticky lg:top-20 lg:block">{sidebar}</aside>

      <div className="min-w-0 flex-1">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
            <input
              type="search"
              value={term}
              onChange={(event) => setTerm(event.target.value)}
              placeholder="جست‌وجوی فوری در نتایج…"
              aria-label="جست‌وجو"
              className="h-10 w-full rounded-xl border border-slate-300 bg-white pe-3 ps-9 text-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            مرتب‌سازی:
            <select value={sort} onChange={(event) => update({ sort: event.target.value })} className="h-10 rounded-xl border border-slate-300 bg-white px-3 text-sm">
              {PRODUCT_SORTS.map((value) => (
                <option key={value} value={value}>
                  {SORT_LABELS[value]}
                </option>
              ))}
            </select>
          </label>
          <button type="button" onClick={() => setFiltersOpen(true)} className="inline-flex h-10 items-center gap-1.5 rounded-xl border border-slate-300 bg-white px-3 text-sm lg:hidden">
            <Filter className="size-4" /> فیلترها {activeFilterCount > 0 ? `(${formatCount(activeFilterCount)})` : ''}
          </button>
        </div>

        {vendorSlug ? (
          <p className="mb-3 inline-flex items-center gap-2 rounded-full bg-brand-50 px-3 py-1 text-xs text-brand-800">
            فقط محصولات فروشگاه «{results.data?.items[0]?.vendor.storeName ?? vendorSlug}»
            <button type="button" onClick={() => update({ vendor: null })} aria-label="حذف فیلتر فروشگاه">
              <X className="size-3.5" />
            </button>
          </p>
        ) : null}
        {results.data ? (
          <p className="mb-3 text-xs text-slate-500" aria-live="polite">
            {formatCount(results.data.total)} محصول{q ? ` برای «${q}»` : ''}
            {results.refreshing || results.loading ? ' — در حال به‌روزرسانی…' : ''}
          </p>
        ) : null}

        {results.loading && results.data === undefined ? (
          <SkeletonCards count={8} />
        ) : results.error && results.data === undefined ? (
          <ErrorState error={results.error} onRetry={() => void results.reload()} />
        ) : results.data && results.data.items.length === 0 ? (
          <EmptyState
            icon={<PackageSearch className="size-6" />}
            title="محصولی با این مشخصات پیدا نشد"
            description="عبارت دیگری را امتحان کنید یا برخی فیلترها را بردارید."
          />
        ) : results.data ? (
          <div className={results.loading ? 'opacity-60 transition-opacity' : ''}>
            <ProductGrid products={results.data.items} bnplEnabled={bnplEnabled} />
            <Pagination page={results.data.page} totalPages={results.data.totalPages} total={results.data.total} onChange={(next) => update({ page: String(next) }, false)} />
          </div>
        ) : null}
      </div>

      {filtersOpen ? (
        <div className="fixed inset-0 z-50 flex lg:hidden" role="dialog" aria-modal="true" aria-label="فیلترها">
          <button type="button" className="flex-1 bg-slate-900/40" onClick={() => setFiltersOpen(false)} aria-label="بستن فیلترها" />
          <div className="h-full w-80 max-w-[85vw] overflow-y-auto bg-white p-4">
            <div className="mb-4 flex items-center justify-between">
              <p className="font-bold">فیلترها</p>
              <button type="button" onClick={() => setFiltersOpen(false)} aria-label="بستن">
                <X className="size-5" />
              </button>
            </div>
            {sidebar}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FilterSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-bold text-slate-900">{title}</h3>
      {children}
    </section>
  );
}

function CategoryTreeFilter({ nodes, activeSlug, hrefFor, allowAll }: { nodes: CategoryTreeNode[]; activeSlug: string | undefined; hrefFor: (slug: string | null) => string; allowAll: boolean }) {
  if (nodes.length === 0) {
    return <p className="text-xs text-slate-500">دسته‌بندی‌ای موجود نیست.</p>;
  }
  const renderNodes = (list: CategoryTreeNode[], depth: number) => (
    <ul className={depth > 0 ? 'ms-3 border-s border-slate-100 ps-2' : ''}>
      {list.map((node) => (
        <li key={node.id}>
          <Link
            href={hrefFor(node.slug)}
            scroll={false}
            className={`flex items-center justify-between rounded-lg px-2 py-1 text-sm ${node.slug === activeSlug ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
          >
            {node.titleFa}
            <span className="text-xs text-slate-400">{formatCount(node.totalProductCount)}</span>
          </Link>
          {node.children.length > 0 ? renderNodes(node.children, depth + 1) : null}
        </li>
      ))}
    </ul>
  );
  return (
    <div className="max-h-72 overflow-y-auto">
      {allowAll ? (
        <Link href={hrefFor(null)} scroll={false} className={`block rounded-lg px-2 py-1 text-sm ${!activeSlug ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}>
          همهٔ دسته‌ها
        </Link>
      ) : null}
      {renderNodes(nodes, 0)}
    </div>
  );
}

/**
 * Dual-thumb price slider over whole Rials (the API unit); labels are shown
 * in Toman via formatToman. Commits on release, not on every pixel.
 */
function PriceRangeSlider({ ceiling, min, max, onCommit }: { ceiling: number; min: number | undefined; max: number | undefined; onCommit: (min: number | undefined, max: number | undefined) => void }) {
  const step = Math.max(10, Math.ceil(ceiling / 100 / 10) * 10);
  const top = Math.ceil(ceiling / step) * step;
  const [low, setLow] = useState(Math.min(min ?? 0, top));
  const [high, setHigh] = useState(Math.min(max ?? top, top));

  const commit = () => onCommit(low > 0 ? low : undefined, high < top ? high : undefined);
  const lowPercent = (low / top) * 100;
  const highPercent = (high / top) * 100;

  return (
    <div className="flex flex-col gap-3">
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-slate-200" />
        <div className="absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-brand-600" style={{ insetInlineStart: `${lowPercent}%`, insetInlineEnd: `${100 - highPercent}%` }} />
        <input
          type="range"
          min={0}
          max={top}
          step={step}
          value={low}
          aria-label="حداقل قیمت"
          onChange={(event) => setLow(Math.min(Number(event.target.value), high - step))}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          className="range-thumb absolute inset-0 w-full"
        />
        <input
          type="range"
          min={0}
          max={top}
          step={step}
          value={high}
          aria-label="حداکثر قیمت"
          onChange={(event) => setHigh(Math.max(Number(event.target.value), low + step))}
          onMouseUp={commit}
          onTouchEnd={commit}
          onKeyUp={commit}
          className="range-thumb absolute inset-0 w-full"
        />
      </div>
      <div className="flex items-center justify-between text-xs text-slate-600">
        <span>از {formatToman(low)}</span>
        <span>تا {formatToman(high)}</span>
      </div>
    </div>
  );
}
```

### `apps/frontend/src/components/catalog/product-card.tsx`

```tsx
import { BadgePercent, CalendarClock, ImageOff, Store } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';

import type { ProductListItem } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { toPersianDigits } from '@/lib/format';
import { compareRials } from '@/lib/money';

/**
 * Listing card: thumbnail, "from" price with the matching strike-through
 * compare-at price and discount badge, colour swatches, store name and the
 * BNPL badge (shown only when the platform's credit programme is enabled).
 */
export function ProductCard({ product, bnplEnabled }: { product: ProductListItem; bnplEnabled: boolean }) {
  const { priceRange } = product;
  const hasRange = compareRials(priceRange.min, priceRange.max) !== 0;
  const swatches = product.colors.slice(0, 5);
  return (
    <Link
      href={`/products/${product.slug}`}
      className="group flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
    >
      <div className="relative aspect-square bg-slate-100">
        {product.primaryImage ? (
          <Image
            src={product.primaryImage.thumbnailUrl ?? product.primaryImage.url}
            alt={product.title}
            fill
            sizes="(max-width: 768px) 50vw, 25vw"
            className="object-cover transition group-hover:scale-[1.02]"
            unoptimized
          />
        ) : (
          <div className="flex h-full items-center justify-center text-slate-400">
            <ImageOff className="size-10" />
          </div>
        )}
        <div className="absolute start-2 top-2 flex flex-col items-start gap-1">
          {product.maxDiscountPercent ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
              <BadgePercent className="size-3.5" />
              {toPersianDigits(product.maxDiscountPercent)}٪
            </span>
          ) : null}
          {bnplEnabled && product.inStock ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-600 px-2 py-0.5 text-[11px] font-bold text-white">
              <CalendarClock className="size-3.5" /> خرید اقساطی
            </span>
          ) : null}
        </div>
        {!product.inStock ? (
          <span className="absolute inset-x-0 bottom-0 bg-slate-900/70 py-1 text-center text-xs font-medium text-white">ناموجود</span>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-2 p-3">
        <h3 className="line-clamp-2 min-h-10 text-sm font-medium leading-5 text-slate-800">{product.title}</h3>
        <p className="flex items-center gap-1 text-xs text-slate-500">
          <Store className="size-3.5" /> {product.vendor.storeName}
        </p>
        {swatches.length > 0 ? (
          <div className="flex items-center gap-1" aria-label={`رنگ‌ها: ${product.colors.map((color) => color.name).join('، ')}`}>
            {swatches.map((color) => (
              <span
                key={color.name}
                title={color.name}
                className="size-4 rounded-full border border-slate-300"
                style={{ backgroundColor: color.hex ?? '#e2e8f0' }}
              />
            ))}
            {product.colors.length > swatches.length ? <span className="text-xs text-slate-400">+{toPersianDigits(product.colors.length - swatches.length)}</span> : null}
          </div>
        ) : null}
        <div className="mt-auto flex flex-col items-end gap-0.5 pt-1">
          {product.startingCompareAtPrice ? <span className="text-xs text-slate-400 line-through">{formatToman(product.startingCompareAtPrice)}</span> : null}
          <span className="text-sm font-bold text-slate-900">
            {hasRange ? <span className="me-1 text-xs font-normal text-slate-500">از</span> : null}
            {formatToman(priceRange.min)}
          </span>
        </div>
      </div>
    </Link>
  );
}

export function ProductGrid({ products, bnplEnabled }: { products: ProductListItem[]; bnplEnabled: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4">
      {products.map((product) => (
        <ProductCard key={product.id} product={product} bnplEnabled={bnplEnabled} />
      ))}
    </div>
  );
}
```

### `apps/frontend/src/components/catalog/product-gallery.tsx`

```tsx
'use client';

import { ImageOff } from 'lucide-react';
import Image from 'next/image';
import { useState } from 'react';

import type { ImageRef } from '@/lib/api/types';
import { toPersianDigits } from '@/lib/format';

export function ProductGallery({ media, title }: { media: ImageRef[]; title: string }) {
  const [active, setActive] = useState(0);
  const current = media[active];

  if (!current) {
    return (
      <div className="flex aspect-square items-center justify-center rounded-3xl border border-slate-200 bg-slate-100 text-slate-400">
        <ImageOff className="size-16" />
        <span className="sr-only">این محصول تصویری ندارد</span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="relative aspect-square overflow-hidden rounded-3xl border border-slate-200 bg-white">
        <Image src={current.url} alt={`${title} — تصویر ${toPersianDigits(active + 1)}`} fill sizes="(max-width: 1024px) 100vw, 50vw" className="object-contain" priority unoptimized />
      </div>
      {media.length > 1 ? (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="تصاویر محصول">
          {media.map((image, index) => (
            <li key={image.url}>
              <button
                type="button"
                onClick={() => setActive(index)}
                aria-label={`نمایش تصویر ${toPersianDigits(index + 1)}`}
                aria-current={index === active}
                className={`relative size-20 overflow-hidden rounded-xl border-2 bg-white ${index === active ? 'border-brand-600' : 'border-transparent opacity-70 hover:opacity-100'}`}
              >
                <Image src={image.thumbnailUrl ?? image.url} alt="" fill sizes="80px" className="object-cover" unoptimized />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/components/catalog/variant-panel.tsx`

```tsx
'use client';

import { BadgePercent, Check, Minus, Plus, ShieldCheck, ShoppingCart } from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';

import { useCart } from '@/components/providers/cart-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import type { CreditPlans, ProductDetail, PublicVariant } from '@/lib/api/types';
import { toApiError } from '@/lib/api/errors';
import { formatToman } from '@/lib/currency';
import { toPersianDigits } from '@/lib/format';
import { multiplyRials } from '@/lib/money';

import { InstallmentCalculator } from './installment-calculator';

/** Matching key for a colour/size choice (null = the product has no such dimension). */
function pick(variants: PublicVariant[], color: string | null, size: string | null): PublicVariant | undefined {
  return variants.find((variant) => variant.colorName === color && variant.size === size);
}

/**
 * Colour × size matrix. Selecting options resolves the exact variant, whose
 * price, compare-at price, SKU, guarantee and live stock are shown; combos
 * that do not exist or are sold out are disabled. Add to Cart posts the
 * variant to the live cart and is disabled when out of stock.
 */
export function VariantPanel({ product, plans }: { product: ProductDetail; plans: CreditPlans | null }) {
  const { addItem } = useCart();
  const toast = useToast();
  const variants = product.variants;
  const colors = product.colors;
  const sizes = product.sizes;

  const firstAvailable = variants.find((variant) => variant.inStock) ?? variants[0];
  const [color, setColor] = useState<string | null>(firstAvailable?.colorName ?? null);
  const [size, setSize] = useState<string | null>(firstAvailable?.size ?? null);
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [added, setAdded] = useState(false);

  const selected = pick(variants, color, size);
  const maxQuantity = selected ? Math.min(selected.availableQuantity, 100) : 0;
  const lineAmount = useMemo(() => (selected ? multiplyRials(selected.price, Math.max(1, Math.min(quantity, Math.max(1, maxQuantity)))) : null), [selected, quantity, maxQuantity]);

  function chooseColor(next: string) {
    setColor(next);
    // Keep the size when that combination exists, otherwise jump to the first size of the colour.
    if (!pick(variants, next, size)) {
      const fallback = variants.find((variant) => variant.colorName === next && variant.inStock) ?? variants.find((variant) => variant.colorName === next);
      setSize(fallback?.size ?? null);
    }
    setQuantity(1);
    setAdded(false);
  }

  function chooseSize(next: string) {
    setSize(next);
    setQuantity(1);
    setAdded(false);
  }

  async function add() {
    if (!selected) return;
    setAdding(true);
    try {
      await addItem(selected.id, quantity);
      setAdded(true);
      toast.success(`${toPersianDigits(quantity)} عدد «${product.title}» به سبد خرید اضافه شد.`);
    } catch (caught) {
      toast.error(toApiError(caught).message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      {colors.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-bold text-slate-800">
            رنگ: <span className="font-normal text-slate-600">{color ?? '—'}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {colors.map((option) => {
              const exists = variants.some((variant) => variant.colorName === option.name);
              const inStock = variants.some((variant) => variant.colorName === option.name && variant.inStock);
              const active = option.name === color;
              return (
                <button
                  key={option.name}
                  type="button"
                  disabled={!exists}
                  aria-pressed={active}
                  onClick={() => chooseColor(option.name)}
                  title={inStock ? option.name : `${option.name} (ناموجود)`}
                  className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm ${active ? 'border-brand-600 ring-2 ring-brand-100' : 'border-slate-300'} ${inStock ? '' : 'opacity-50'}`}
                >
                  <span className="size-5 rounded-full border border-slate-300" style={{ backgroundColor: option.hex ?? '#e2e8f0' }} />
                  {option.name}
                  {active ? <Check className="size-4 text-brand-600" /> : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      {sizes.length > 0 ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-bold text-slate-800">
            سایز: <span className="font-normal text-slate-600">{size ?? '—'}</span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {sizes.map((option) => {
              const variant = pick(variants, color, option);
              const active = option === size;
              return (
                <button
                  key={option}
                  type="button"
                  disabled={!variant}
                  aria-pressed={active}
                  onClick={() => chooseSize(option)}
                  className={`min-w-12 rounded-xl border px-3 py-1.5 text-sm ${active ? 'border-brand-600 bg-brand-50 font-bold text-brand-700' : 'border-slate-300 text-slate-700'} ${!variant ? 'cursor-not-allowed line-through opacity-40' : !variant.inStock ? 'opacity-50' : ''}`}
                >
                  {option}
                </button>
              );
            })}
          </div>
        </fieldset>
      ) : null}

      <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
        {selected ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="flex flex-col gap-1">
                {selected.compareAtPrice ? (
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-slate-400 line-through">{formatToman(selected.compareAtPrice)}</span>
                    {selected.discountPercent ? (
                      <span className="inline-flex items-center gap-1 rounded-full bg-rose-600 px-2 py-0.5 text-xs font-bold text-white">
                        <BadgePercent className="size-3.5" /> {toPersianDigits(selected.discountPercent)}٪
                      </span>
                    ) : null}
                  </div>
                ) : null}
                <span className="text-2xl font-black text-slate-900">{formatToman(selected.price)}</span>
              </div>
              <div className="text-end text-xs text-slate-500">
                <p dir="ltr" className="font-mono">
                  SKU: {selected.sku}
                </p>
                <p className={selected.inStock ? (selected.availableQuantity <= 3 ? 'font-bold text-amber-700' : 'text-emerald-700') : 'font-bold text-rose-700'}>
                  {selected.inStock
                    ? selected.availableQuantity <= 3
                      ? `فقط ${toPersianDigits(selected.availableQuantity)} عدد باقی مانده`
                      : `موجود در انبار (${toPersianDigits(selected.availableQuantity)} عدد)`
                    : 'ناموجود'}
                </p>
              </div>
            </div>
            {selected.guarantee ? (
              <p className="flex items-center gap-1.5 text-sm text-slate-600">
                <ShieldCheck className="size-4 text-emerald-600" /> {selected.guarantee}
              </p>
            ) : null}

            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center rounded-xl border border-slate-300 bg-white">
                <button type="button" onClick={() => setQuantity((value) => Math.min(maxQuantity, value + 1))} disabled={!selected.inStock || quantity >= maxQuantity} className="p-2.5 disabled:opacity-30" aria-label="افزایش تعداد">
                  <Plus className="size-4" />
                </button>
                <span className="w-10 text-center text-sm font-bold" aria-live="polite">
                  {toPersianDigits(quantity)}
                </span>
                <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} disabled={quantity <= 1} className="p-2.5 disabled:opacity-30" aria-label="کاهش تعداد">
                  <Minus className="size-4" />
                </button>
              </div>
              <Button size="lg" className="flex-1" onClick={() => void add()} loading={adding} disabled={!selected.inStock} icon={<ShoppingCart className="size-5" />}>
                {selected.inStock ? 'افزودن به سبد خرید' : 'ناموجود'}
              </Button>
            </div>
            {added ? (
              <Link href="/cart" className="text-center text-sm font-medium text-brand-700 hover:underline">
                مشاهدهٔ سبد خرید و ادامهٔ خرید ←
              </Link>
            ) : null}
          </div>
        ) : (
          <p className="text-sm text-slate-600">این ترکیب رنگ و سایز موجود نیست؛ گزینهٔ دیگری انتخاب کنید.</p>
        )}
      </div>

      {plans && plans.creditEnabled && plans.items.length > 0 && lineAmount && selected?.inStock ? (
        <InstallmentCalculator amount={lineAmount} plans={plans} />
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/components/customer/address-form.tsx`

```tsx
'use client';

import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox, Field, FormError, Input, Select, Textarea } from '@/components/ui/field';
import { Modal } from '@/components/ui/modal';
import { apiPatch, apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { Address, AddressInput } from '@/lib/api/types';
import { toLatinDigits } from '@/lib/format';
import { IRAN_MOBILE_PATTERN, IRAN_PROVINCES, POSTAL_CODE_PATTERN } from '@/lib/iran';

type Errors = Partial<Record<keyof AddressInput, string>>;

function validate(input: AddressInput): Errors {
  const errors: Errors = {};
  if (!input.province) errors.province = 'استان را انتخاب کنید.';
  if (input.city.trim().length < 2) errors.city = 'نام شهر را وارد کنید.';
  if (input.postalAddress.trim().length < 10) errors.postalAddress = 'نشانی کامل (حداقل ۱۰ حرف) را وارد کنید.';
  if (!POSTAL_CODE_PATTERN.test(input.postalCode)) errors.postalCode = 'کد پستی ۱۰ رقمی و بدون خط تیره است (با صفر شروع نمی‌شود).';
  if (input.recipientName.trim().length < 2) errors.recipientName = 'نام گیرنده را وارد کنید.';
  if (!IRAN_MOBILE_PATTERN.test(input.recipientMobile)) errors.recipientMobile = 'شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷).';
  return errors;
}

/**
 * Add/edit address modal (province, city, full address, postal code,
 * recipient). Validates like the backend, then POST/PATCH customer/addresses.
 */
export function AddressFormModal({
  open,
  onClose,
  onSaved,
  address,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (address: Address) => void;
  address?: Address | null;
}) {
  const [form, setForm] = useState<AddressInput>(() => ({
    province: address?.province ?? '',
    city: address?.city ?? '',
    postalAddress: address?.postalAddress ?? '',
    postalCode: address?.postalCode ?? '',
    buildingNumber: address?.buildingNumber ?? '',
    unitNumber: address?.unitNumber ?? '',
    recipientName: address?.recipientName ?? '',
    recipientMobile: address?.recipientMobile.replace(/^\+98/, '0') ?? '',
    isDefault: address?.isDefault ?? false,
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof AddressInput>(key: K, value: AddressInput[K]) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const normalised: AddressInput = {
      ...form,
      city: form.city.trim(),
      postalAddress: form.postalAddress.trim(),
      postalCode: toLatinDigits(form.postalCode).replace(/\D/g, ''),
      recipientName: form.recipientName.trim(),
      recipientMobile: toLatinDigits(form.recipientMobile).replace(/[\s-]/g, ''),
      buildingNumber: form.buildingNumber?.trim() ? toLatinDigits(form.buildingNumber.trim()) : null,
      unitNumber: form.unitNumber?.trim() ? toLatinDigits(form.unitNumber.trim()) : null,
    };
    const found = validate(normalised);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setSaving(true);
    setServerError(null);
    try {
      const body = { ...normalised, isDefault: normalised.isDefault ? true : undefined };
      const saved = address ? await apiPatch<Address>(`/customer/addresses/${address.id}`, body) : await apiPost<Address>('/customer/addresses', body);
      onSaved(saved);
    } catch (caught) {
      setServerError(toApiError(caught).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={address ? 'ویرایش نشانی' : 'افزودن نشانی جدید'}
      size="lg"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
          <Button type="submit" form="address-form" loading={saving}>
            ذخیرهٔ نشانی
          </Button>
        </>
      }
    >
      <form id="address-form" onSubmit={(event) => void submit(event)} className="grid gap-4 sm:grid-cols-2" noValidate>
        <Field label="استان" required error={errors.province}>
          {(id, described) => (
            <Select id={id} aria-describedby={described} aria-invalid={Boolean(errors.province)} value={form.province} onChange={(event) => set('province', event.target.value)}>
              <option value="">انتخاب استان…</option>
              {IRAN_PROVINCES.map((province) => (
                <option key={province} value={province}>
                  {province}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="شهر" required error={errors.city}>
          {(id, described) => <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.city)} value={form.city} onChange={(event) => set('city', event.target.value)} maxLength={60} />}
        </Field>
        <Field label="نشانی پستی کامل" required error={errors.postalAddress} className="sm:col-span-2">
          {(id, described) => (
            <Textarea id={id} aria-describedby={described} aria-invalid={Boolean(errors.postalAddress)} value={form.postalAddress} onChange={(event) => set('postalAddress', event.target.value)} maxLength={500} placeholder="خیابان، کوچه، …" />
          )}
        </Field>
        <Field label="کد پستی" required error={errors.postalCode} hint="۱۰ رقم، بدون خط تیره">
          {(id, described) => (
            <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.postalCode)} dir="ltr" inputMode="numeric" value={form.postalCode} onChange={(event) => set('postalCode', event.target.value)} maxLength={12} />
          )}
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="پلاک">
            {(id) => <Input id={id} value={form.buildingNumber ?? ''} onChange={(event) => set('buildingNumber', event.target.value)} maxLength={20} />}
          </Field>
          <Field label="واحد">
            {(id) => <Input id={id} value={form.unitNumber ?? ''} onChange={(event) => set('unitNumber', event.target.value)} maxLength={20} />}
          </Field>
        </div>
        <Field label="نام و نام خانوادگی گیرنده" required error={errors.recipientName}>
          {(id, described) => <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.recipientName)} value={form.recipientName} onChange={(event) => set('recipientName', event.target.value)} maxLength={120} />}
        </Field>
        <Field label="موبایل گیرنده" required error={errors.recipientMobile}>
          {(id, described) => (
            <Input id={id} aria-describedby={described} aria-invalid={Boolean(errors.recipientMobile)} dir="ltr" inputMode="tel" value={form.recipientMobile} onChange={(event) => set('recipientMobile', event.target.value)} placeholder="09121234567" />
          )}
        </Field>
        {!address?.isDefault ? <Checkbox className="sm:col-span-2" label="نشانی پیش‌فرض من باشد" checked={Boolean(form.isDefault)} onChange={(event) => set('isDefault', event.target.checked)} /> : null}
        <div className="sm:col-span-2">
          <FormError message={serverError} />
        </div>
      </form>
    </Modal>
  );
}
```

### `apps/frontend/src/components/customer/dispute-form.tsx`

```tsx
'use client';

import { useEffect, useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Select, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Modal } from '@/components/ui/modal';
import { apiPost } from '@/lib/api/client';
import type { Dispute, DisputeActionResult, DisputeReason } from '@/lib/api/types';
import { DISPUTE_REASONS } from '@/lib/api/types';
import { useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { DISPUTE_REASON_LABELS } from '@/lib/labels';

/** Mirrors the backend limits (CreateDisputeDto): description 20–2000 chars, ≤ 10 evidence files. */
export const DISPUTE_DESCRIPTION_MIN = 20;
export const DISPUTE_DESCRIPTION_MAX = 2000;
export const MAX_EVIDENCE = 10;

interface Props {
  open: boolean;
  onClose: () => void;
  onFiled: (dispute: Dispute) => void;
  subOrderId: string;
  packageLabel: string;
}

/**
 * Opens a dispute on one package (POST /customer/disputes). Photos are
 * uploaded first as private `dispute_evidence` documents; their download
 * URLs are sent as evidence. Filing freezes the vendor's earnings for the package.
 */
export function DisputeFormModal({ open, onClose, onFiled, subOrderId, packageLabel }: Props) {
  const toast = useToast();
  const [reason, setReason] = useState<DisputeReason | ''>('');
  const [description, setDescription] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const file = useMutation((body: { subOrderId: string; reason: DisputeReason; description: string; evidenceUrls: string[] }) => apiPost<DisputeActionResult>('/customer/disputes', body));

  useEffect(() => {
    if (open) {
      setReason('');
      setDescription('');
      setFiles([]);
      setLocalError(null);
      file.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when the dialog opens
  }, [open]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = description.trim();
    if (!reason) return setLocalError('علت اختلاف را انتخاب کنید.');
    if (text.length < DISPUTE_DESCRIPTION_MIN) return setLocalError(`شرح مشکل باید دست‌کم ${toPersianDigits(DISPUTE_DESCRIPTION_MIN)} نویسه باشد.`);
    setLocalError(null);
    const result = await file.run({ subOrderId, reason, description: text, evidenceUrls: files.map((item) => item.url) });
    if (result) {
      toast.success('درخواست شما ثبت شد و برای فروشنده ارسال شد.');
      onFiled(result.dispute);
    }
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`ثبت اختلاف / مرجوعی — ${packageLabel}`}
      size="lg"
      footer={
        <>
          <Button type="submit" form="dispute-form" variant="danger" loading={file.pending}>
            ثبت اختلاف
          </Button>
          <Button variant="secondary" onClick={onClose}>
            انصراف
          </Button>
        </>
      }
    >
      <form id="dispute-form" onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <Field label="علت" required>
          {(id) => (
            <Select id={id} value={reason} onChange={(event) => setReason(event.target.value as DisputeReason)}>
              <option value="">انتخاب کنید…</option>
              {DISPUTE_REASONS.map((value) => (
                <option key={value} value={value}>
                  {DISPUTE_REASON_LABELS[value]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="شرح مشکل" required hint={`${toPersianDigits(description.trim().length)} / ${toPersianDigits(DISPUTE_DESCRIPTION_MAX)} نویسه — دست‌کم ${toPersianDigits(DISPUTE_DESCRIPTION_MIN)}`}>
          {(id, described) => <Textarea id={id} aria-describedby={described} rows={5} maxLength={DISPUTE_DESCRIPTION_MAX} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="چه مشکلی پیش آمده است؟ جزئیات را بنویسید." />}
        </Field>
        <FileDrop
          upload={{ kind: 'document', purpose: 'dispute_evidence' }}
          value={files}
          onChange={setFiles}
          max={MAX_EVIDENCE}
          accept="image/jpeg,image/png,image/webp,application/pdf"
          label="تصاویر و مستندات"
          hint={`حداکثر ${toPersianDigits(MAX_EVIDENCE)} فایل (JPG، PNG، WebP یا PDF). فقط شما، فروشنده و داور می‌توانند آن‌ها را ببینند.`}
        />
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs leading-6 text-amber-900">با ثبت اختلاف، مبلغ این مرسوله در کیف پول فروشنده مسدود می‌شود تا فروشنده پاسخ دهد یا داور تصمیم بگیرد.</p>
        <FormError message={localError ?? file.error?.message} />
      </form>
    </Modal>
  );
}
```

### `apps/frontend/src/components/customer/retry-payment-button.tsx`

```tsx
'use client';

import { CreditCard } from 'lucide-react';
import { useState } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { InitiatePaymentResponse } from '@/lib/api/types';

/** Opens a new bank session for a still-PENDING order (POST /payments/initiate) and redirects to it. */
export function RetryPaymentButton({ parentOrderId, label = 'پرداخت مجدد' }: { parentOrderId: string; label?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function retry() {
    setBusy(true);
    try {
      const payment = await apiPost<InitiatePaymentResponse>('/payments/initiate', { parentOrderId });
      window.location.assign(payment.redirectUrl);
    } catch (caught) {
      toast.error(toApiError(caught).message);
      setBusy(false);
    }
  }
  return (
    <Button size="lg" variant="success" loading={busy} onClick={() => void retry()} icon={<CreditCard className="size-5" />}>
      {label}
    </Button>
  );
}
```

### `apps/frontend/src/components/disputes/dispute-list.tsx`

```tsx
'use client';

import { ChevronLeft, Scale } from 'lucide-react';
import Link from 'next/link';
import { useState, type ReactNode } from 'react';

import { Money, Pagination, StatusBadge, Table, Td } from '@/components/ui/misc';
import { AsyncView, EmptyState, SkeletonRows } from '@/components/ui/states';
import type { Dispute, DisputeStatus, Page } from '@/lib/api/types';
import { DISPUTE_STATUSES } from '@/lib/api/types';
import type { Query } from '@/lib/api/client';
import { useApi } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { DISPUTE_REASON_LABELS, DISPUTE_STATUS } from '@/lib/labels';

/** Paged dispute table with a status filter, for /customer, /vendor and /admin disputes. */
export function DisputeList<T extends Dispute>({ endpoint, hrefBase, extraQuery, partyColumn, emptyText }: { endpoint: string; hrefBase: string; extraQuery?: Query; partyColumn?: { head: string; cell: (dispute: T) => ReactNode }; emptyText: string }) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<DisputeStatus | ''>('');
  const state = useApi<Page<T>>(endpoint, { page, pageSize: 20, status: status || undefined, ...extraQuery });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        {(['', ...DISPUTE_STATUSES] as const).map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={status === value}
            onClick={() => {
              setStatus(value);
              setPage(1);
            }}
            className={`rounded-full border px-3 py-1 text-xs ${status === value ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-200 bg-white text-slate-700'}`}
          >
            {value ? DISPUTE_STATUS[value].label : 'همه'}
          </button>
        ))}
      </div>
      <AsyncView state={state} skeleton={<SkeletonRows rows={5} />} isEmpty={(data) => data.items.length === 0} empty={<EmptyState icon={<Scale className="size-8" />} title="اختلافی یافت نشد" description={emptyText} />}>
        {(data) => (
          <>
            <Table head={['مرسوله', 'علت', ...(partyColumn ? [partyColumn.head] : []), 'مبلغ', 'وضعیت', 'تاریخ', '']}>
              {data.items.map((dispute) => (
                <tr key={dispute.id} className="hover:bg-slate-50">
                  <Td>
                    <span dir="ltr" className="font-mono text-xs">
                      {dispute.package.subOrderNumber}
                    </span>
                    <div className="text-xs text-slate-500">{dispute.package.storeName}</div>
                  </Td>
                  <Td>{DISPUTE_REASON_LABELS[dispute.reason]}</Td>
                  {partyColumn ? <Td>{partyColumn.cell(dispute)}</Td> : null}
                  <Td>
                    <Money rials={dispute.package.itemsSubtotal} />
                  </Td>
                  <Td>
                    <StatusBadge value={dispute.status} map={DISPUTE_STATUS} />
                  </Td>
                  <Td className="text-xs text-slate-500">{formatDateTime(dispute.createdAt)}</Td>
                  <Td>
                    <Link href={`${hrefBase}/${dispute.id}`} className="flex items-center gap-1 text-sm text-brand-700 hover:underline">
                      مشاهده <ChevronLeft className="size-4" />
                    </Link>
                  </Td>
                </tr>
              ))}
            </Table>
            <Pagination page={data.page} totalPages={data.totalPages} total={data.total} onChange={setPage} />
          </>
        )}
      </AsyncView>
    </div>
  );
}
```

### `apps/frontend/src/components/disputes/dispute-view.tsx`

```tsx
import { FileText, Paperclip } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card, Money, StatusBadge } from '@/components/ui/misc';
import type { Dispute, DisputeEvidence } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { DISPUTE_EVENT_LABELS, DISPUTE_REASON_LABELS, DISPUTE_STATUS, SUB_ORDER_STATUS } from '@/lib/labels';

const UPLOADER_LABEL: Record<DisputeEvidence['uploadedBy'], string> = { CUSTOMER: 'خریدار', VENDOR: 'فروشنده', STAFF: 'داور' };
const ACTOR_LABEL: Record<string, string> = { CUSTOMER: 'خریدار', VENDOR: 'فروشنده', SYSTEM: 'سیستم' };

/** Private evidence files are served by /api/v1/media/documents/:id/download through the BFF (session cookie). */
export function EvidenceList({ evidence }: { evidence: DisputeEvidence[] }) {
  if (evidence.length === 0) return <p className="text-sm text-slate-500">مستندی بارگذاری نشده است.</p>;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {evidence.map((item) => (
        <li key={item.id}>
          <a href={item.fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:border-brand-300 hover:bg-brand-50">
            {item.fileType?.startsWith('image/') ? <Paperclip className="size-4 text-brand-600" /> : <FileText className="size-4 text-brand-600" />}
            <span className="flex-1 truncate">{item.caption ?? (item.fileType?.startsWith('image/') ? 'تصویر' : 'فایل')}</span>
            <span className="text-xs text-slate-500">
              {UPLOADER_LABEL[item.uploadedBy]} · {formatDateTime(item.createdAt)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Case summary, both sides' statements, evidence and timeline — shared by customer, vendor and admin views. */
export function DisputeView({ dispute, extra }: { dispute: Dispute; extra?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="شرح اختلاف" action={<StatusBadge value={dispute.status} map={DISPUTE_STATUS} />}>
        <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-slate-500">علت</dt>
            <dd className="font-medium">{DISPUTE_REASON_LABELS[dispute.reason]}</dd>
          </div>
          <div>
            <dt className="text-slate-500">مرسوله</dt>
            <dd dir="ltr" className="text-end font-mono sm:text-start">
              {dispute.package.subOrderNumber}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">فروشگاه</dt>
            <dd>{dispute.package.storeName}</dd>
          </div>
          <div>
            <dt className="text-slate-500">مبلغ مرسوله</dt>
            <dd>
              <Money rials={dispute.package.itemsSubtotal} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">وضعیت مرسوله</dt>
            <dd>
              <StatusBadge value={dispute.package.status} map={SUB_ORDER_STATUS} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">ثبت</dt>
            <dd>{formatDateTime(dispute.createdAt)}</dd>
          </div>
        </dl>
        <p className="whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm leading-7">{dispute.description}</p>
      </Card>

      {dispute.vendorResponse ? (
        <Card title={dispute.vendorResponse.action === 'ACCEPT_RETURN' ? 'پاسخ فروشنده: پذیرش مرجوعی' : 'دفاعیهٔ فروشنده'}>
          <p className="whitespace-pre-line text-sm leading-7">{dispute.vendorResponse.defenseNotes}</p>
          <p className="mt-2 text-xs text-slate-500">{formatDateTime(dispute.vendorResponse.respondedAt)}</p>
        </Card>
      ) : null}

      {dispute.resolution ? (
        <Card title="نتیجه">
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge value={dispute.resolution.outcome} map={DISPUTE_STATUS} />
              <span className="text-slate-500">
                {dispute.resolution.decidedBy === 'STAFF' ? 'رأی داور' : 'پذیرش فروشنده'} — {formatDateTime(dispute.resolution.resolvedAt)}
              </span>
            </div>
            {dispute.resolution.refundAmount ? (
              <span>
                مبلغ بازپرداخت: <Money rials={dispute.resolution.refundAmount} className="font-bold" />
              </span>
            ) : null}
            {dispute.resolution.notes ? <p className="whitespace-pre-line leading-7">{dispute.resolution.notes}</p> : null}
          </div>
        </Card>
      ) : null}

      {extra}

      <Card title="مستندات">
        <EvidenceList evidence={dispute.evidence} />
      </Card>

      <Card title="روند رسیدگی">
        <ol className="relative flex flex-col gap-4 border-s-2 border-slate-100 ps-5">
          {dispute.timeline.map((event, index) => (
            <li key={`${event.createdAt}-${index}`} className="relative text-sm">
              <span className="absolute -start-[27px] top-1 size-3 rounded-full border-2 border-white bg-brand-500" />
              <div className="font-medium">{DISPUTE_EVENT_LABELS[event.type]}</div>
              <div className="text-xs text-slate-500">
                {ACTOR_LABEL[event.actorRole] ?? 'کارشناس شاپینو'} · {formatDateTime(event.createdAt)}
              </div>
              {event.note ? <div className="mt-1 whitespace-pre-line text-xs text-slate-600">{event.note}</div> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
```

### `apps/frontend/src/components/layout/dashboard-shell.tsx`

```tsx
'use client';

import {
  Banknote,
  BarChart3,
  CreditCard,
  Gavel,
  LayoutDashboard,
  MapPin,
  Package,
  PackageCheck,
  Scale,
  ShieldCheck,
  ShoppingBag,
  Store,
  User,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { canAccess } from '@/lib/auth/access';
import { ROLE_LABELS } from '@/lib/labels';

export type DashboardArea = 'customer' | 'vendor' | 'admin';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: Record<DashboardArea, { title: string; items: NavItem[] }> = {
  customer: {
    title: 'حساب کاربری',
    items: [
      { href: '/customer/orders', label: 'سفارش‌ها', icon: ShoppingBag },
      { href: '/customer/credit', label: 'اعتبار و اقساط', icon: CreditCard },
      { href: '/customer/disputes', label: 'اختلاف‌ها و مرجوعی', icon: Scale },
      { href: '/customer/addresses', label: 'نشانی‌ها', icon: MapPin },
      { href: '/customer/profile', label: 'اطلاعات حساب', icon: User },
    ],
  },
  vendor: {
    title: 'پنل فروشنده',
    items: [
      { href: '/vendor/dashboard', label: 'پیشخوان', icon: LayoutDashboard },
      { href: '/vendor/orders', label: 'مرسوله‌ها', icon: PackageCheck },
      { href: '/vendor/products', label: 'محصولات', icon: Package },
      { href: '/vendor/wallet', label: 'کیف پول و تسویه', icon: Wallet },
      { href: '/vendor/disputes', label: 'اختلاف‌ها', icon: Scale },
      { href: '/vendor/register', label: 'فروشگاه و مدارک', icon: Store },
    ],
  },
  admin: {
    title: 'پنل مدیریت',
    items: [
      { href: '/admin/vendors', label: 'فروشندگان و احراز هویت', icon: ShieldCheck },
      { href: '/admin/products', label: 'نظارت بر محصولات', icon: Package },
      { href: '/admin/financial', label: 'گزارش مالی', icon: BarChart3 },
      { href: '/admin/settlements', label: 'تسویه‌ها', icon: Banknote },
      { href: '/admin/disputes', label: 'داوری اختلاف‌ها', icon: Gavel },
    ],
  },
};

export function DashboardShell({ area, children }: { area: DashboardArea; children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useSession();
  const nav = NAV[area];
  // Only links whose pages (and API guards) accept the current role.
  const items = nav.items.filter((item) => canAccess(item.href, user?.role));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row">
      <aside className="lg:w-60 lg:shrink-0">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:sticky lg:top-20">
          <div className="border-b border-slate-100 px-2 pb-3">
            <p className="text-sm font-bold text-slate-900">{nav.title}</p>
            {user ? (
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {user.fullName || 'کاربر شاپینو'} · {ROLE_LABELS[user.role]}
              </p>
            ) : null}
          </div>
          <nav className="mt-2 flex gap-1 overflow-x-auto lg:flex-col" aria-label={nav.title}>
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm ${active ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
```

### `apps/frontend/src/components/layout/header-bar.tsx`

```tsx
'use client';

import {
  ChevronDown,
  LayoutDashboard,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Search,
  ShoppingCart,
  Store,
  User,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useCart } from '@/components/providers/cart-provider';
import { useSession } from '@/components/providers/session-provider';
import { apiGet } from '@/lib/api/client';
import type { CategoryTreeNode, Page, ProductListItem } from '@/lib/api/types';
import { homeForRole } from '@/lib/auth/access';
import { formatToman } from '@/lib/currency';
import { toPersianDigits } from '@/lib/format';
import { useDebounced } from '@/lib/hooks/use-api';
import { ROLE_LABELS } from '@/lib/labels';

export function HeaderBar({ categories, categoriesError }: { categories: CategoryTreeNode[]; categoriesError: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-lg font-black text-brand-700">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white">ش</span>
          <span className="hidden sm:inline">شاپینو</span>
        </Link>
        <CategoryMenu categories={categories} failed={categoriesError} />
        <HeaderSearch />
        <div className="ms-auto flex items-center gap-1">
          <CartButton />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function CategoryMenu({ categories, failed }: { categories: CategoryTreeNode[]; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const activeNode = categories.find((node) => node.id === active) ?? categories[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
      >
        <LayoutGrid className="size-4" />
        <span className="hidden md:inline">دسته‌بندی‌ها</span>
        <ChevronDown className="size-4" />
      </button>
      {open ? (
        <div className="absolute start-0 top-12 z-50 w-[min(90vw,44rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          {failed ? (
            <p className="p-4 text-sm text-rose-700">فهرست دسته‌بندی‌ها بارگذاری نشد. صفحه را دوباره باز کنید.</p>
          ) : categories.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">هنوز دسته‌بندی فعالی ثبت نشده است.</p>
          ) : (
            <div className="flex max-h-[70vh]">
              <ul className="w-48 shrink-0 overflow-y-auto border-e border-slate-100 bg-slate-50 py-2">
                {categories.map((node) => (
                  <li key={node.id}>
                    <Link
                      href={`/categories/${node.slug}`}
                      onMouseEnter={() => setActive(node.id)}
                      onFocus={() => setActive(node.id)}
                      className={`flex items-center justify-between px-4 py-2 text-sm ${activeNode?.id === node.id ? 'bg-white font-bold text-brand-700' : 'text-slate-700'}`}
                    >
                      {node.titleFa}
                      <span className="text-xs text-slate-400">{toPersianDigits(node.totalProductCount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex-1 overflow-y-auto p-4">
                {activeNode ? (
                  <>
                    <Link href={`/categories/${activeNode.slug}`} className="mb-3 inline-block text-sm font-bold text-brand-700">
                      همهٔ {activeNode.titleFa} ←
                    </Link>
                    {activeNode.children.length === 0 ? (
                      <p className="text-sm text-slate-500">زیرشاخه‌ای ندارد.</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-4">
                        {activeNode.children.map((child) => (
                          <div key={child.id}>
                            <Link href={`/categories/${child.slug}`} className="text-sm font-medium text-slate-800 hover:text-brand-700">
                              {child.titleFa}
                            </Link>
                            {child.children.length > 0 ? (
                              <ul className="mt-1 flex flex-col gap-1">
                                {child.children.map((leaf) => (
                                  <li key={leaf.id}>
                                    <Link href={`/categories/${leaf.slug}`} className="text-xs text-slate-500 hover:text-brand-700">
                                      {leaf.titleFa}
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function HeaderSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const [term, setTerm] = useState('');
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<ProductListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const debounced = useDebounced(term.trim(), 300);

  useEffect(() => {
    setFocused(false);
  }, [pathname]);

  useEffect(() => {
    if (debounced.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiGet<Page<ProductListItem>>('/products', { query: { search: debounced, pageSize: 6 } })
      .then((page) => {
        if (!cancelled) {
          setResults(page.items);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = term.trim();
    setFocused(false);
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }

  const showPanel = focused && debounced.length >= 2;

  return (
    <form onSubmit={submit} role="search" className="relative min-w-0 flex-1 md:max-w-xl">
      <label htmlFor="header-search" className="sr-only">
        جست‌وجوی محصولات
      </label>
      <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
      <input
        id="header-search"
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="جست‌وجو در محصولات، برندها و فروشگاه‌ها…"
        autoComplete="off"
        className="h-10 w-full rounded-xl border border-slate-200 bg-slate-100 pe-3 ps-9 text-sm focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
      />
      {showPanel ? (
        <div className="absolute inset-x-0 top-12 z-50 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          {loading && results === null ? (
            <p className="flex items-center gap-2 p-4 text-sm text-slate-500">
              <LoaderCircle className="size-4 animate-spin" /> در حال جست‌وجو…
            </p>
          ) : failed ? (
            <p className="p-4 text-sm text-rose-700">جست‌وجو انجام نشد؛ دوباره تلاش کنید.</p>
          ) : results && results.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">محصولی با «{debounced}» پیدا نشد.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {(results ?? []).map((item) => (
                <li key={item.id}>
                  <Link href={`/products/${item.slug}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <span className="relative size-10 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                      {item.primaryImage ? (
                        <Image src={item.primaryImage.thumbnailUrl ?? item.primaryImage.url} alt="" fill sizes="40px" className="object-cover" unoptimized />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-slate-800">{item.title}</span>
                      <span className="block text-xs text-slate-500">{item.vendor.storeName}</span>
                    </span>
                    <span className="text-xs font-bold text-slate-700">{formatToman(item.priceRange.min)}</span>
                  </Link>
                </li>
              ))}
              <li>
                <button type="submit" className="w-full px-4 py-2.5 text-start text-sm font-medium text-brand-700 hover:bg-brand-50">
                  مشاهدهٔ همهٔ نتایج «{debounced}»
                </button>
              </li>
            </ul>
          )}
        </div>
      ) : null}
    </form>
  );
}

function CartButton() {
  const { count, loading } = useCart();
  return (
    <Link href="/cart" className="relative inline-flex size-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100" aria-label={`سبد خرید، ${toPersianDigits(count)} کالا`}>
      <ShoppingCart className="size-5" />
      {!loading && count > 0 ? (
        <span className="absolute -end-0.5 -top-0.5 flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[11px] font-bold leading-5 text-white">
          {toPersianDigits(count > 99 ? '99+' : count)}
        </span>
      ) : null}
    </Link>
  );
}

function UserMenu() {
  const { me, user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!user) {
    return (
      <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50">
        <LogIn className="size-4" /> <span className="hidden sm:inline">ورود | ثبت‌نام</span>
      </Link>
    );
  }

  const links: Array<{ href: string; label: string; icon: typeof User }> = [{ href: homeForRole(user.role), label: 'پنل کاربری', icon: LayoutDashboard }];
  if (user.role === 'CUSTOMER') {
    links.push({ href: '/customer/profile', label: 'حساب کاربری', icon: User });
    links.push({ href: '/vendor/register', label: me?.vendor ? 'وضعیت فروشگاه من' : 'فروشنده شوید', icon: Store });
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-slate-800 hover:bg-slate-100">
        <User className="size-4" />
        <span className="hidden max-w-32 truncate sm:inline">{user.fullName || 'کاربر شاپینو'}</span>
        <ChevronDown className="size-4" />
      </button>
      {open ? (
        <div className="absolute end-0 top-12 z-50 w-60 overflow-hidden rounded-2xl border border-slate-200 bg-white py-2 shadow-xl">
          <div className="border-b border-slate-100 px-4 pb-2">
            <p className="truncate text-sm font-bold text-slate-900">{user.fullName || 'کاربر شاپینو'}</p>
            <p className="text-xs text-slate-500">{ROLE_LABELS[user.role]}</p>
          </div>
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              <link.icon className="size-4" /> {link.label}
            </Link>
          ))}
          <button type="button" onClick={() => void signOut()} className="flex w-full items-center gap-2 px-4 py-2 text-sm text-rose-700 hover:bg-rose-50">
            <LogOut className="size-4" /> خروج
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/components/layout/site-footer.tsx`

```tsx
import Link from 'next/link';

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-slate-600 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <p className="text-base font-black text-brand-700">شاپینو</p>
          <p className="leading-7">بازار آنلاین چندفروشندگی با پرداخت امن درگاه بانکی و خرید اعتباری. پول شما تا تحویل کالا نزد شاپینو امانت می‌ماند.</p>
        </div>
        <nav className="flex flex-col gap-2" aria-label="خرید">
          <p className="font-bold text-slate-800">خرید</p>
          <Link href="/search" className="hover:text-brand-700">همهٔ محصولات</Link>
          <Link href="/search?sort=popular" className="hover:text-brand-700">پرفروش‌ترین‌ها</Link>
          <Link href="/customer/credit" className="hover:text-brand-700">خرید اقساطی</Link>
        </nav>
        <nav className="flex flex-col gap-2" aria-label="همکاری">
          <p className="font-bold text-slate-800">همکاری</p>
          <Link href="/vendor/register" className="hover:text-brand-700">فروشنده شوید</Link>
          <Link href="/customer/disputes" className="hover:text-brand-700">پیگیری اختلاف و مرجوعی</Link>
          <Link href="/status" className="hover:text-brand-700">وضعیت سامانه</Link>
        </nav>
      </div>
    </footer>
  );
}
```

### `apps/frontend/src/components/layout/site-header.tsx`

```tsx
import { serverApi } from '@/lib/api/server';
import type { CategoryTreeNode, CategoryTree } from '@/lib/api/types';

import { HeaderBar } from './header-bar';

/** Server part of the sticky header: loads the live category tree once per render. */
export async function SiteHeader() {
  let categories: CategoryTreeNode[] = [];
  let categoriesError = false;
  try {
    categories = (await serverApi<CategoryTree>('categories/tree')).items;
  } catch {
    categoriesError = true;
  }
  return <HeaderBar categories={categories} categoriesError={categoriesError} />;
}
```

### `apps/frontend/src/components/orders/package-stepper.tsx`

```tsx
import { Check, X } from 'lucide-react';

import type { SubOrderStatus } from '@/lib/api/types';
import { PACKAGE_STEPS, SUB_ORDER_STATUS } from '@/lib/labels';

/**
 * Horizontal status timeline of one package:
 * awaiting approval → processing → shipped → delivered.
 * Cancelled/refunded packages show a terminal red marker instead.
 */
export function PackageStepper({ status }: { status: SubOrderStatus }) {
  if (status === 'CANCELLED' || status === 'REFUNDED') {
    return (
      <div className="flex items-center gap-2 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700">
        <X className="size-4" /> {SUB_ORDER_STATUS[status].label}
      </div>
    );
  }
  const current = PACKAGE_STEPS.indexOf(status);
  return (
    <ol className="flex items-center" aria-label="وضعیت مرسوله">
      {PACKAGE_STEPS.map((step, index) => {
        const done = index < current || (index === current && step === 'DELIVERED');
        const active = index === current;
        return (
          <li key={step} className="flex flex-1 items-center last:flex-none" aria-current={active ? 'step' : undefined}>
            <div className="flex flex-col items-center gap-1">
              <span
                className={`flex size-7 items-center justify-center rounded-full border-2 text-xs font-bold ${
                  done ? 'border-emerald-500 bg-emerald-500 text-white' : active ? 'border-brand-600 bg-brand-50 text-brand-700' : 'border-slate-200 bg-white text-slate-400'
                }`}
              >
                {done ? <Check className="size-4" /> : index + 1}
              </span>
              <span className={`whitespace-nowrap text-[11px] ${active ? 'font-bold text-slate-900' : 'text-slate-500'}`}>{SUB_ORDER_STATUS[step].label}</span>
            </div>
            {index < PACKAGE_STEPS.length - 1 ? <span className={`mx-1 mb-5 h-0.5 flex-1 ${index < current ? 'bg-emerald-400' : 'bg-slate-200'}`} /> : null}
          </li>
        );
      })}
    </ol>
  );
}
```

### `apps/frontend/src/components/providers/cart-provider.tsx`

```tsx
'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api/client';
import { toApiError, type ApiError } from '@/lib/api/errors';
import type { Cart } from '@/lib/api/types';

import { useSession } from './session-provider';

interface CartContextValue {
  cart: Cart | undefined;
  loading: boolean;
  error: ApiError | undefined;
  /** Live number of items for the header badge. */
  count: number;
  reload: () => Promise<void>;
  addItem: (productVariantId: string, quantity: number) => Promise<Cart>;
  updateQuantity: (lineId: string, quantity: number) => Promise<Cart>;
  removeLine: (lineId: string) => Promise<Cart>;
  clear: () => Promise<Cart>;
}

const CartContext = createContext<CartContextValue | null>(null);

/**
 * Single source of the cart for the header badge, the cart page and checkout.
 * Guests get a backend guest cart (its token lives in an httpOnly cookie set
 * by the BFF); on sign-in the BFF merges it into the account cart.
 */
export function CartProvider({ children }: { children: ReactNode }) {
  const { user } = useSession();
  const [cart, setCart] = useState<Cart | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError | undefined>(undefined);

  const reload = useCallback(async () => {
    try {
      setCart(await apiGet<Cart>('/cart'));
      setError(undefined);
    } catch (caught) {
      setError(toApiError(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload whenever the identity changes (sign-in merges the guest cart, sign-out shows the guest cart).
  useEffect(() => {
    void reload();
  }, [reload, user?.id]);

  const apply = useCallback((next: Cart): Cart => {
    setCart(next);
    setError(undefined);
    return next;
  }, []);

  const value = useMemo<CartContextValue>(
    () => ({
      cart,
      loading,
      error,
      count: cart?.itemCount ?? 0,
      reload,
      addItem: async (productVariantId, quantity) => apply(await apiPost<Cart>('/cart/items', { productVariantId, quantity })),
      updateQuantity: async (lineId, quantity) => apply(await apiPatch<Cart>(`/cart/items/${lineId}`, { quantity })),
      removeLine: async (lineId) => apply(await apiDelete<Cart>(`/cart/items/${lineId}`)),
      clear: async () => apply(await apiPost<Cart>('/cart/clear')),
    }),
    [apply, cart, error, loading, reload],
  );

  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartContextValue {
  const value = useContext(CartContext);
  if (!value) {
    throw new Error('useCart must be used inside <CartProvider>');
  }
  return value;
}
```

### `apps/frontend/src/components/providers/session-provider.tsx`

```tsx
'use client';

import { useRouter } from 'next/navigation';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import { sessionClient } from '@/lib/api/client';
import type { AuthUser, Me } from '@/lib/api/types';

interface SessionContextValue {
  me: Me | null;
  user: AuthUser | null;
  /** Re-reads the identity from the BFF (after login, profile change, vendor approval). */
  refresh: () => Promise<Me | null>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ initial, children }: { initial: Me | null; children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(initial);
  const router = useRouter();

  const refresh = useCallback(async (): Promise<Me | null> => {
    try {
      const { data } = await sessionClient.get<Me | { user: null }>('');
      const next = data.user === null ? null : (data as Me);
      setMe(next);
      return next;
    } catch {
      return null;
    }
  }, []);

  const signOut = useCallback(async () => {
    try {
      await sessionClient.delete('');
    } finally {
      setMe(null);
      router.push('/');
      router.refresh();
    }
  }, [router]);

  const value = useMemo(() => ({ me, user: me?.user ?? null, refresh, signOut }), [me, refresh, signOut]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) {
    throw new Error('useSession must be used inside <SessionProvider>');
  }
  return value;
}
```

### `apps/frontend/src/components/providers/toast-provider.tsx`

```tsx
'use client';

import { CheckCircle2, CircleAlert, Info, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

type ToastTone = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastContextValue {
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);
let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const push = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId++;
      setToasts((current) => [...current.slice(-3), { id, tone, message }]);
      setTimeout(() => dismiss(id), tone === 'error' ? 7000 : 4000);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ success: (m: string) => push('success', m), error: (m: string) => push('error', m), info: (m: string) => push('info', m) }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full max-w-md items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ${
              toast.tone === 'error' ? 'border-rose-200 bg-rose-50 text-rose-900' : toast.tone === 'info' ? 'border-sky-200 bg-sky-50 text-sky-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'
            }`}
          >
            {toast.tone === 'error' ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : toast.tone === 'info' ? <Info className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0" />}
            <p className="flex-1 leading-6">{toast.message}</p>
            <button type="button" onClick={() => dismiss(toast.id)} className="text-current/70 hover:text-current" aria-label="بستن">
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext);
  if (!value) {
    throw new Error('useToast must be used inside <ToastProvider>');
  }
  return value;
}
```

### `apps/frontend/src/components/ui/button.tsx`

```tsx
import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import type { ButtonHTMLAttributes, ComponentProps, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
type Size = 'sm' | 'md' | 'lg';

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus-visible:outline-brand-600 disabled:bg-brand-600/50',
  secondary: 'border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 focus-visible:outline-slate-400 disabled:text-slate-400',
  ghost: 'text-slate-700 hover:bg-slate-100 focus-visible:outline-slate-400 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 focus-visible:outline-rose-600 disabled:bg-rose-600/50',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 focus-visible:outline-emerald-600 disabled:bg-emerald-600/50',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 gap-1.5 rounded-lg px-3 text-xs',
  md: 'h-10 gap-2 rounded-xl px-4 text-sm',
  lg: 'h-12 gap-2 rounded-xl px-6 text-base',
};

export function buttonClasses(variant: Variant = 'primary', size: Size = 'md', extra = ''): string {
  return `inline-flex shrink-0 items-center justify-center font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed ${VARIANTS[variant]} ${SIZES[size]} ${extra}`;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  icon?: ReactNode;
}

export function Button({ variant = 'primary', size = 'md', loading = false, icon, className = '', children, disabled, type = 'button', ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
}

interface LinkButtonProps extends ComponentProps<typeof Link> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

export function LinkButton({ variant = 'primary', size = 'md', icon, className = '', children, ...rest }: LinkButtonProps) {
  return (
    <Link className={buttonClasses(variant, size, className)} {...rest}>
      {icon}
      {children}
    </Link>
  );
}
```

### `apps/frontend/src/components/ui/field.tsx`

```tsx
import { forwardRef, useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

const CONTROL =
  'w-full rounded-xl border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-100 disabled:bg-slate-100 disabled:text-slate-500 aria-[invalid=true]:border-rose-400';

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: (id: string, describedBy: string | undefined) => ReactNode;
  className?: string;
}

/** Label + control + hint/error, wired for screen readers. */
export function Field({ label, hint, error, required, children, className = '' }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  return (
    <div className={`flex flex-col gap-1.5 ${className}`}>
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
        {required ? <span className="ms-0.5 text-rose-500">*</span> : null}
      </label>
      {children(id, describedBy)}
      {hint ? (
        <p id={hintId} className="text-xs leading-5 text-slate-500">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs leading-5 text-rose-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className = '', ...rest }, ref) {
  return <input ref={ref} className={`${CONTROL} h-10 ${className}`} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className = '', children, ...rest }, ref) {
  return (
    <select ref={ref} className={`${CONTROL} h-10 ${className}`} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className = '', ...rest }, ref) {
  return <textarea ref={ref} className={`${CONTROL} min-h-24 py-2 leading-6 ${className}`} {...rest} />;
});

/**
 * Amount input in TOMAN (TM decision): shows the unit next to the field. The
 * value stays the raw text the user typed; forms convert it with
 * `tomanToRials` from lib/currency on submit.
 */
export const TomanInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>>(function TomanInput({ className = '', ...rest }, ref) {
  return (
    <div className="relative">
      <input ref={ref} type="text" inputMode="decimal" dir="ltr" className={`${CONTROL} h-10 pe-3 ps-14 text-left tabular-nums ${className}`} {...rest} />
      <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-xs font-medium text-slate-500">تومان</span>
    </div>
  );
});

export function Checkbox({ label, className = '', ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode }) {
  return (
    <label className={`inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700 ${className}`}>
      <input type="checkbox" className="size-4 rounded border-slate-300 accent-brand-600" {...rest} />
      <span>{label}</span>
    </label>
  );
}

export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm leading-6 text-rose-800">
      {message}
    </p>
  );
}
```

### `apps/frontend/src/components/ui/file-drop.tsx`

```tsx
'use client';

import { FileText, ImagePlus, LoaderCircle, Trash2, UploadCloud } from 'lucide-react';
import Image from 'next/image';
import { useId, useRef, useState, type DragEvent } from 'react';

import { apiUpload } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { DocumentPurpose, DocumentUploadResponse, ImagePurpose, ImageUploadResponse } from '@/lib/api/types';
import { toPersianDigits } from '@/lib/format';

export interface UploadedFile {
  id: string;
  url: string;
  /** Image thumbnail, when the upload is an image. */
  thumbnailUrl: string | null;
  name: string;
}

type UploadKind = { kind: 'image'; purpose: ImagePurpose } | { kind: 'document'; purpose: DocumentPurpose };

interface FileDropProps {
  upload: UploadKind;
  value: UploadedFile[];
  onChange: (files: UploadedFile[]) => void;
  max: number;
  accept: string;
  label: string;
  hint?: string;
  /** Allow re-ordering (first = primary image). */
  orderable?: boolean;
}

interface Pending {
  key: string;
  name: string;
  progress: number;
}

/**
 * Drag-and-drop (or click) uploader bound to the real media endpoints:
 * images → POST /media/upload/image (WebP + thumbnail), documents →
 * POST /media/upload/document (private). Uploads run in parallel with
 * progress; server-side rejections (type, size, corrupt file) are shown per file.
 */
export function FileDrop({ upload, value, onChange, max, accept, label, hint, orderable = false }: FileDropProps) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [pending, setPending] = useState<Pending[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const valueRef = useRef(value);
  valueRef.current = value;

  const remaining = max - value.length - pending.length;

  async function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const files = Array.from(list).slice(0, Math.max(0, remaining));
    const skipped = list.length - files.length;
    const nextErrors: string[] = skipped > 0 ? [`حداکثر ${toPersianDigits(max)} فایل مجاز است؛ ${toPersianDigits(skipped)} فایل اضافه نشد.`] : [];
    const jobs = files.map((file, index) => ({ key: `${Date.now()}-${index}-${file.name}`, file }));
    setPending((current) => [...current, ...jobs.map((job) => ({ key: job.key, name: job.file.name, progress: 0 }))]);

    const results = await Promise.all(
      jobs.map(async (job): Promise<UploadedFile | null> => {
        const onProgress = (fraction: number) =>
          setPending((current) => current.map((item) => (item.key === job.key ? { ...item, progress: fraction } : item)));
        try {
          if (upload.kind === 'image') {
            const result = await apiUpload<ImageUploadResponse>('/media/upload/image', job.file, upload.purpose, onProgress);
            return { id: result.id, url: result.url, thumbnailUrl: result.thumbnailUrl, name: job.file.name };
          }
          const result = await apiUpload<DocumentUploadResponse>('/media/upload/document', job.file, upload.purpose, onProgress);
          return { id: result.id, url: result.url, thumbnailUrl: null, name: result.originalName };
        } catch (caught) {
          nextErrors.push(`«${job.file.name}»: ${toApiError(caught).message}`);
          return null;
        } finally {
          setPending((current) => current.filter((item) => item.key !== job.key));
        }
      }),
    );
    const uploaded = results.filter((item): item is UploadedFile => item !== null);
    if (uploaded.length > 0) {
      onChange([...valueRef.current, ...uploaded]);
    }
    setErrors(nextErrors);
    if (inputRef.current) inputRef.current.value = '';
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setDragging(false);
    void handleFiles(event.dataTransfer.files);
  }

  function move(index: number, delta: number) {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [item] = next.splice(index, 1);
    if (item) next.splice(target, 0, item);
    onChange(next);
  }

  return (
    <div className="flex flex-col gap-3">
      <span className="text-sm font-medium text-slate-700">{label}</span>
      {remaining > 0 ? (
        <label
          htmlFor={inputId}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
          className={`flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed px-4 py-8 text-center transition-colors ${
            dragging ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-slate-50 hover:border-brand-400'
          }`}
        >
          <UploadCloud className="size-8 text-brand-600" />
          <span className="text-sm font-medium text-slate-700">فایل‌ها را اینجا رها کنید یا برای انتخاب کلیک کنید</span>
          {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
          <span className="text-xs text-slate-400">{toPersianDigits(remaining)} فایل دیگر مجاز است</span>
          <input id={inputId} ref={inputRef} type="file" accept={accept} multiple={max > 1} className="sr-only" onChange={(event) => void handleFiles(event.target.files)} />
        </label>
      ) : null}

      {errors.length > 0 ? (
        <ul role="alert" className="flex flex-col gap-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs leading-5 text-rose-800">
          {errors.map((error) => (
            <li key={error}>{error}</li>
          ))}
        </ul>
      ) : null}

      {value.length > 0 || pending.length > 0 ? (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {value.map((file, index) => (
            <li key={file.id} className="relative flex flex-col gap-2 rounded-xl border border-slate-200 bg-white p-2">
              {file.thumbnailUrl ? (
                <div className="relative aspect-square overflow-hidden rounded-lg bg-slate-100">
                  <Image src={file.thumbnailUrl} alt={file.name} fill sizes="160px" className="object-cover" unoptimized />
                </div>
              ) : (
                <div className="flex aspect-square items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                  {upload.kind === 'image' ? <ImagePlus className="size-8" /> : <FileText className="size-8" />}
                </div>
              )}
              <span className="truncate text-xs text-slate-600" title={file.name}>
                {orderable && index === 0 ? '★ تصویر اصلی — ' : ''}
                {file.name}
              </span>
              <div className="flex items-center justify-between gap-1">
                {orderable ? (
                  <div className="flex gap-1">
                    <button type="button" onClick={() => move(index, -1)} disabled={index === 0} className="rounded-md border px-1.5 text-xs disabled:opacity-30" aria-label="جابه‌جایی به قبل">
                      →
                    </button>
                    <button type="button" onClick={() => move(index, 1)} disabled={index === value.length - 1} className="rounded-md border px-1.5 text-xs disabled:opacity-30" aria-label="جابه‌جایی به بعد">
                      ←
                    </button>
                  </div>
                ) : (
                  <span />
                )}
                <button type="button" onClick={() => onChange(value.filter((item) => item.id !== file.id))} className="rounded-md p-1 text-rose-600 hover:bg-rose-50" aria-label={`حذف ${file.name}`}>
                  <Trash2 className="size-4" />
                </button>
              </div>
            </li>
          ))}
          {pending.map((item) => (
            <li key={item.key} className="flex flex-col items-center justify-center gap-2 rounded-xl border border-slate-200 bg-white p-2 text-center">
              <LoaderCircle className="size-6 animate-spin text-brand-600" />
              <span className="w-full truncate text-xs text-slate-600">{item.name}</span>
              <span className="text-xs text-slate-400">{toPersianDigits(Math.round(item.progress * 100))}٪</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/components/ui/misc.tsx`

```tsx
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

import { formatToman } from '@/lib/currency';
import { formatCount, toPersianDigits } from '@/lib/format';
import type { Tone } from '@/lib/labels';

const TONES: Record<Tone, string> = {
  neutral: 'bg-slate-100 text-slate-700 ring-slate-200',
  info: 'bg-sky-50 text-sky-800 ring-sky-200',
  success: 'bg-emerald-50 text-emerald-800 ring-emerald-200',
  warning: 'bg-amber-50 text-amber-900 ring-amber-200',
  danger: 'bg-rose-50 text-rose-800 ring-rose-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
};

export function Badge({ tone = 'neutral', children, className = '' }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]} ${className}`}>{children}</span>;
}

/** Badge for an enum value using a label/tone map from lib/labels. */
export function StatusBadge<K extends string>({ value, map }: { value: K; map: Record<K, { label: string; tone: Tone }> }) {
  const entry = map[value];
  return <Badge tone={entry?.tone ?? 'neutral'}>{entry?.label ?? value}</Badge>;
}

/** A Rial amount from the API displayed in Toman (via lib/currency only). */
export function Money({ rials, className = '', strike = false }: { rials: string | number | bigint; className?: string; strike?: boolean }) {
  return <span className={`whitespace-nowrap tabular-nums ${strike ? 'text-slate-400 line-through' : ''} ${className}`}>{formatToman(rials)}</span>;
}

export function Card({ children, className = '', title, action }: { children: ReactNode; className?: string; title?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`rounded-2xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {title || action ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-base font-bold text-slate-900">{title}</h2> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function StatCard({ label, value, hint, icon, tone = 'neutral' }: { label: string; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: Tone }) {
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-slate-500">{label}</span>
        {icon ? <span className={`flex size-9 items-center justify-center rounded-xl ring-1 ring-inset ${TONES[tone]}`}>{icon}</span> : null}
      </div>
      <div className="text-lg font-bold text-slate-900">{value}</div>
      {hint ? <div className="text-xs leading-5 text-slate-500">{hint}</div> : null}
    </div>
  );
}

export function PageHeader({ title, description, action }: { title: string; description?: ReactNode; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-bold text-slate-900 md:text-2xl">{title}</h1>
        {description ? <p className="text-sm leading-6 text-slate-500">{description}</p> : null}
      </div>
      {action}
    </div>
  );
}

export function Pagination({ page, totalPages, total, onChange }: { page: number; totalPages: number; total?: number; onChange: (page: number) => void }) {
  if (totalPages <= 1) {
    return total !== undefined && total > 0 ? <p className="mt-4 text-center text-xs text-slate-500">{formatCount(total)} مورد</p> : null;
  }
  return (
    <nav className="mt-6 flex items-center justify-center gap-3" aria-label="صفحه‌بندی">
      <button
        type="button"
        onClick={() => onChange(page - 1)}
        disabled={page <= 1}
        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
      >
        <ChevronRight className="size-4" /> قبلی
      </button>
      <span className="text-sm text-slate-600">
        صفحهٔ {toPersianDigits(page)} از {toPersianDigits(totalPages)}
        {total !== undefined ? <span className="text-slate-400"> ({formatCount(total)} مورد)</span> : null}
      </span>
      <button
        type="button"
        onClick={() => onChange(page + 1)}
        disabled={page >= totalPages}
        className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:opacity-40"
      >
        بعدی <ChevronLeft className="size-4" />
      </button>
    </nav>
  );
}

/** Horizontal progress bar (0…1). */
export function ProgressBar({ value, tone = 'brand', label }: { value: number; tone?: 'brand' | 'success' | 'warning' | 'danger'; label?: string }) {
  const colors = { brand: 'bg-brand-600', success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-rose-500' };
  const percent = Math.max(0, Math.min(1, value)) * 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)} aria-label={label}>
      <div className={`h-full rounded-full ${colors[tone]} transition-[width]`} style={{ width: `${percent}%` }} />
    </div>
  );
}

export function DefinitionList({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col gap-0.5">
          <dt className="text-slate-500">{item.label}</dt>
          <dd className="font-medium text-slate-900">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Table shell with horizontal scroll on small screens. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
      <table className="w-full min-w-[640px] text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="px-4 py-3 text-start font-medium">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <td className={`px-4 py-3 align-middle ${className}`}>{children}</td>;
}
```

### `apps/frontend/src/components/ui/modal.tsx`

```tsx
'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'md' | 'lg';
}

/** Accessible dialog on top of the native <dialog> element (focus trap, Esc to close). */
export function Modal({ open, title, onClose, children, footer, size = 'md' }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) onClose();
      }}
      className={`m-auto w-[calc(100%-2rem)] ${size === 'lg' ? 'max-w-3xl' : 'max-w-lg'} rounded-2xl bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-slate-900/40`}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col" dir="rtl">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <h2 id={titleId} className="text-base font-bold">
              {title}
            </h2>
            <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-500 hover:bg-slate-100" aria-label="بستن">
              <X className="size-5" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
```

### `apps/frontend/src/components/ui/states.tsx`

```tsx
import { CircleAlert, Inbox, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';

import type { ApiError } from '@/lib/api/errors';

export function Skeleton({ className = '' }: { className?: string }) {
  return <div aria-hidden className={`animate-pulse rounded-lg bg-slate-200/80 ${className}`} />;
}

/** Stack of skeleton rows for lists and tables. */
export function SkeletonRows({ rows = 5, className = 'h-14' }: { rows?: number; className?: string }) {
  return (
    <div className="flex flex-col gap-3" role="status" aria-label="در حال بارگذاری">
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} className={className} />
      ))}
    </div>
  );
}

export function SkeletonCards({ count = 8 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4" role="status" aria-label="در حال بارگذاری">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="flex flex-col gap-2 rounded-2xl border border-slate-100 bg-white p-3">
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="h-4 w-4/5" />
          <Skeleton className="h-4 w-2/5" />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ title, description, action, icon }: { title: string; description?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-slate-300 bg-white px-6 py-12 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-slate-100 text-slate-500">{icon ?? <Inbox className="size-6" />}</span>
      <h3 className="text-base font-bold text-slate-800">{title}</h3>
      {description ? <p className="max-w-md text-sm leading-6 text-slate-500">{description}</p> : null}
      {action}
    </div>
  );
}

export function ErrorState({ error, title = 'دریافت اطلاعات ممکن نشد', onRetry }: { error: ApiError | Error | string; title?: string; onRetry?: () => void }) {
  const message = typeof error === 'string' ? error : error.message;
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50 px-6 py-10 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-rose-100 text-rose-600">
        <CircleAlert className="size-6" />
      </span>
      <h3 className="text-base font-bold text-rose-900">{title}</h3>
      <p className="max-w-md text-sm leading-6 text-rose-800">{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="inline-flex items-center gap-2 rounded-xl border border-rose-300 bg-white px-4 py-2 text-sm font-medium text-rose-800 hover:bg-rose-100">
          <RefreshCw className="size-4" /> تلاش دوباره
        </button>
      ) : null}
    </div>
  );
}

/**
 * Renders the right state of an API-backed view: skeleton while loading,
 * error with retry, empty state, or the content.
 */
export function AsyncView<T>({
  state,
  skeleton,
  isEmpty,
  empty,
  children,
}: {
  state: { data: T | undefined; error: ApiError | undefined; loading: boolean; reload: () => Promise<void> };
  skeleton?: ReactNode;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (state.loading && state.data === undefined) {
    return <>{skeleton ?? <SkeletonRows />}</>;
  }
  if (state.error && state.data === undefined) {
    return <ErrorState error={state.error} onRetry={() => void state.reload()} />;
  }
  if (state.data === undefined) {
    return <>{skeleton ?? <SkeletonRows />}</>;
  }
  if (isEmpty?.(state.data)) {
    return <>{empty ?? <EmptyState title="موردی یافت نشد" />}</>;
  }
  return <>{children(state.data)}</>;
}
```

### `apps/frontend/src/components/vendor/product-basics.tsx`

```tsx
'use client';

import { Checkbox, Field, Input, Select, Textarea, TomanInput } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Skeleton } from '@/components/ui/states';
import type { CategoryTree, CreateProductInput } from '@/lib/api/types';
import { tomanToRials } from '@/lib/currency';
import { useApi } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { MAX_MEDIA_PER_PRODUCT, PRODUCT_SLUG_PATTERN, flattenCategories } from '@/lib/product-form';

export interface ProductBasics {
  title: string;
  slug: string;
  categoryId: string;
  brand: string;
  basePriceToman: string;
  description: string;
  images: UploadedFile[];
  isPublished: boolean;
}

export const EMPTY_BASICS: ProductBasics = { title: '', slug: '', categoryId: '', brand: '', basePriceToman: '', description: '', images: [], isPublished: true };

export type BasicsPayload = Omit<CreateProductInput, 'variants'>;

/** Client-side mirror of CreateProductDto; returns field errors or the API payload (Rials). */
export function validateBasics(value: ProductBasics): { errors: Record<string, string>; payload: BasicsPayload | null } {
  const errors: Record<string, string> = {};
  const title = value.title.trim();
  if (title.length < 3 || title.length > 200) errors.title = 'عنوان باید ۳ تا ۲۰۰ نویسه باشد.';
  const slug = value.slug.trim();
  if (slug && (!PRODUCT_SLUG_PATTERN.test(slug) || slug.length > 200)) errors.slug = 'نامک فقط حروف کوچک لاتین، رقم و خط تیره.';
  if (!value.categoryId) errors.categoryId = 'دسته‌بندی را انتخاب کنید.';
  if (value.brand.trim().length > 80) errors.brand = 'برند حداکثر ۸۰ نویسه است.';
  let basePrice = 0;
  try {
    basePrice = tomanToRials(value.basePriceToman);
    if (basePrice <= 0) errors.basePrice = 'قیمت پایه باید بیشتر از صفر باشد.';
  } catch (caught) {
    errors.basePrice = caught instanceof Error ? caught.message : 'قیمت نامعتبر است.';
  }
  if (Object.keys(errors).length) return { errors, payload: null };
  return {
    errors,
    payload: {
      title,
      ...(slug ? { slug } : {}),
      categoryId: value.categoryId,
      brand: value.brand.trim() || null,
      description: value.description.trim() || null,
      basePrice,
      mediaIds: value.images.map((image) => image.id),
      isPublished: value.isPublished,
    },
  };
}

export function ProductBasicsFields({ value, onChange, errors }: { value: ProductBasics; onChange: (value: ProductBasics) => void; errors: Record<string, string> }) {
  const tree = useApi<CategoryTree>('/categories/tree');
  const set = <K extends keyof ProductBasics>(key: K, next: ProductBasics[K]) => onChange({ ...value, [key]: next });
  const options = tree.data ? flattenCategories(tree.data.items) : [];

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="عنوان محصول" required error={errors.title} className="md:col-span-2">
        {(id, described) => <Input id={id} aria-describedby={described} maxLength={200} value={value.title} onChange={(event) => set('title', event.target.value)} />}
      </Field>
      <Field label="دسته‌بندی" required error={errors.categoryId ?? tree.error?.message}>
        {(id, described) =>
          tree.loading && !tree.data ? (
            <Skeleton className="h-10" />
          ) : (
            <Select id={id} aria-describedby={described} value={value.categoryId} onChange={(event) => set('categoryId', event.target.value)}>
              <option value="">انتخاب کنید…</option>
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          )
        }
      </Field>
      <Field label="برند" error={errors.brand}>
        {(id, described) => <Input id={id} aria-describedby={described} maxLength={80} value={value.brand} onChange={(event) => set('brand', event.target.value)} />}
      </Field>
      <Field label="قیمت پایه (تومان)" required error={errors.basePrice} hint="قیمت نمایشی پیش‌فرض؛ قیمت واقعی هر تنوع در جدول تنوع‌ها تعیین می‌شود.">
        {(id, described) => <TomanInput id={id} aria-describedby={described} value={value.basePriceToman} onChange={(event) => set('basePriceToman', event.target.value)} />}
      </Field>
      <Field label="نامک (اختیاری)" error={errors.slug} hint="خالی بگذارید تا از عنوان ساخته شود.">
        {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={200} value={value.slug} onChange={(event) => set('slug', event.target.value.toLowerCase())} />}
      </Field>
      <Field label="توضیحات" className="md:col-span-2">
        {(id) => <Textarea id={id} rows={5} maxLength={20000} value={value.description} onChange={(event) => set('description', event.target.value)} />}
      </Field>
      <div className="md:col-span-2">
        <FileDrop
          upload={{ kind: 'image', purpose: 'product_image' }}
          value={value.images}
          onChange={(images) => set('images', images)}
          max={MAX_MEDIA_PER_PRODUCT}
          accept="image/jpeg,image/png,image/webp"
          label="تصاویر محصول"
          hint={`حداکثر ${toPersianDigits(MAX_MEDIA_PER_PRODUCT)} تصویر؛ تصویر اول، تصویر اصلی است. ترتیب را با دکمه‌ها تغییر دهید.`}
          orderable
        />
      </div>
      <div className="md:col-span-2">
        <Checkbox label="پس از ذخیره در فروشگاه منتشر شود" checked={value.isPublished} onChange={(event) => set('isPublished', event.target.checked)} />
      </div>
    </div>
  );
}
```

### `apps/frontend/src/components/vendor/product-status-badge.tsx`

```tsx
import { Badge } from '@/components/ui/misc';
import type { VendorProductSummary } from '@/lib/api/types';

/** Storefront state of a vendor product: blocked by staff, published (sellable or out of stock) or draft. */
export function ProductStatusBadge({ product }: { product: Pick<VendorProductSummary, 'moderation' | 'isPublished' | 'isSellable'> }) {
  if (product.moderation.isBlockedByAdmin) return <Badge tone="danger">مسدود</Badge>;
  if (product.isPublished) return product.isSellable ? <Badge tone="success">منتشرشده</Badge> : <Badge tone="warning">منتشر، ناموجود</Badge>;
  return <Badge>پیش‌نویس</Badge>;
}
```

### `apps/frontend/src/components/vendor/variant-editor.tsx`

```tsx
'use client';

import { Grid3X3, Plus, Trash2, X } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { toPersianDigits } from '@/lib/format';
import { MAX_VARIANTS_PER_PRODUCT, buildVariantMatrix, emptyVariantRow, type ColorChoice, type VariantRow } from '@/lib/product-form';

interface Props {
  rows: VariantRow[];
  onChange: (rows: VariantRow[]) => void;
  skuPrefix: string;
  /** Rows that may still be added (existing variants count against the 100 limit). */
  capacity?: number;
}

/**
 * Multi-variant table: colour (name + swatch), size, price, compare price,
 * stock and SKU per row. The generator builds the colour × size matrix at once.
 */
export function VariantEditor({ rows, onChange, skuPrefix, capacity = MAX_VARIANTS_PER_PRODUCT }: Props) {
  const [colors, setColors] = useState<ColorChoice[]>([]);
  const [colorName, setColorName] = useState('');
  const [colorHex, setColorHex] = useState('#1D4ED8');
  const [sizes, setSizes] = useState('');
  const [price, setPrice] = useState('');
  const [compare, setCompare] = useState('');
  const [stock, setStock] = useState('10');
  const [notice, setNotice] = useState<string | null>(null);

  const update = (key: string, patch: Partial<VariantRow>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));

  function addColor() {
    const name = colorName.trim();
    if (!name) return;
    setColors((current) => [...current.filter((color) => color.name !== name), { name, hex: colorHex.toUpperCase() }]);
    setColorName('');
  }

  function generate() {
    const sizeList = sizes
      .split(/[,،]/)
      .map((size) => size.trim())
      .filter(Boolean);
    const generated = buildVariantMatrix(colors, [...new Set(sizeList)], { priceToman: price, compareToman: compare, stock, skuPrefix });
    const room = capacity - rows.length;
    if (generated.length > room) {
      setNotice(`حداکثر ${toPersianDigits(MAX_VARIANTS_PER_PRODUCT)} تنوع مجاز است؛ ${toPersianDigits(Math.max(room, 0))} ردیف افزوده شد.`);
    } else {
      setNotice(null);
    }
    onChange([...rows, ...generated.slice(0, Math.max(room, 0))]);
  }

  return (
    <div className="flex flex-col gap-4">
      <details className="rounded-xl border border-dashed border-brand-300 bg-brand-50/40 p-4" open={rows.length === 0}>
        <summary className="flex cursor-pointer items-center gap-2 text-sm font-bold text-brand-800">
          <Grid3X3 className="size-4" /> ساخت خودکار ماتریس رنگ × سایز
        </summary>
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-600">رنگ‌ها</span>
            <div className="flex gap-2">
              <input type="color" aria-label="انتخاب رنگ" value={colorHex} onChange={(event) => setColorHex(event.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-slate-200" />
              <Input
                placeholder="نام رنگ (مثلاً سرمه‌ای)"
                value={colorName}
                maxLength={40}
                onChange={(event) => setColorName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    addColor();
                  }
                }}
              />
              <Button variant="secondary" onClick={addColor} icon={<Plus className="size-4" />} aria-label="افزودن رنگ" />
            </div>
            <div className="flex flex-wrap gap-2">
              {colors.map((color) => (
                <span key={color.name} className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-white py-1 pe-1 ps-2 text-xs">
                  <span className="size-3 rounded-full border" style={{ background: color.hex }} /> {color.name}
                  <button type="button" aria-label={`حذف ${color.name}`} onClick={() => setColors((current) => current.filter((item) => item.name !== color.name))} className="rounded-full p-0.5 hover:bg-slate-100">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium text-slate-600">سایزها (با ویرگول جدا کنید)</span>
            <Input placeholder="S, M, L, XL" value={sizes} onChange={(event) => setSizes(event.target.value)} />
          </div>
          <div className="grid grid-cols-3 gap-2 lg:col-span-2">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              قیمت فروش (تومان)
              <Input dir="ltr" inputMode="decimal" value={price} onChange={(event) => setPrice(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              قیمت قبل از تخفیف
              <Input dir="ltr" inputMode="decimal" value={compare} onChange={(event) => setCompare(event.target.value)} />
            </label>
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              موجودی هر تنوع
              <Input dir="ltr" inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-3 lg:col-span-2">
            <Button onClick={generate} icon={<Grid3X3 className="size-4" />}>
              ساخت {toPersianDigits(Math.max(colors.length, 1) * Math.max(sizes.split(/[,،]/).filter((size) => size.trim()).length, 1))} تنوع
            </Button>
            {notice ? <span className="text-xs text-amber-700">{notice}</span> : null}
          </div>
        </div>
      </details>

      <div className="overflow-x-auto rounded-xl border border-slate-200">
        <table className="w-full min-w-[860px] text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="px-2 py-2 text-start font-medium">رنگ</th>
              <th className="px-2 py-2 text-start font-medium">سایز</th>
              <th className="px-2 py-2 text-start font-medium">قیمت (تومان)</th>
              <th className="px-2 py-2 text-start font-medium">قبل از تخفیف</th>
              <th className="px-2 py-2 text-start font-medium">موجودی</th>
              <th className="px-2 py-2 text-start font-medium">SKU</th>
              <th className="px-2 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-slate-500">
                  هنوز تنوعی اضافه نشده است. از ماتریس بالا استفاده کنید یا ردیف دستی بیفزایید.
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.key}>
                  <td className="px-2 py-1.5">
                    <div className="flex items-center gap-1">
                      <input
                        type="color"
                        aria-label="رنگ"
                        value={row.colorHex || '#FFFFFF'}
                        onChange={(event) => update(row.key, { colorHex: event.target.value.toUpperCase() })}
                        className="h-9 w-9 shrink-0 cursor-pointer rounded border border-slate-200"
                      />
                      <Input aria-label="نام رنگ" value={row.colorName} maxLength={40} onChange={(event) => update(row.key, { colorName: event.target.value })} className="h-9 min-w-24" />
                      {row.colorHex ? (
                        <button type="button" aria-label="بدون رنگ" title="بدون رنگ" onClick={() => update(row.key, { colorHex: '', colorName: '' })} className="rounded p-1 text-slate-400 hover:bg-slate-100">
                          <X className="size-3" />
                        </button>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="سایز" value={row.size} maxLength={20} onChange={(event) => update(row.key, { size: event.target.value })} className="h-9 w-20" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="قیمت" dir="ltr" inputMode="decimal" value={row.priceToman} onChange={(event) => update(row.key, { priceToman: event.target.value })} className="h-9 w-32" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="قیمت قبل از تخفیف" dir="ltr" inputMode="decimal" value={row.compareToman} onChange={(event) => update(row.key, { compareToman: event.target.value })} className="h-9 w-32" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="موجودی" dir="ltr" inputMode="numeric" value={row.stock} onChange={(event) => update(row.key, { stock: event.target.value })} className="h-9 w-20" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Input aria-label="SKU" dir="ltr" value={row.sku} maxLength={64} onChange={(event) => update(row.key, { sku: event.target.value.toUpperCase() })} className="h-9 w-44 font-mono text-xs" />
                  </td>
                  <td className="px-2 py-1.5">
                    <Button size="sm" variant="ghost" className="text-rose-600" aria-label="حذف ردیف" icon={<Trash2 className="size-4" />} onClick={() => onChange(rows.filter((item) => item.key !== row.key))} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between text-xs text-slate-500">
        <Button size="sm" variant="secondary" icon={<Plus className="size-4" />} disabled={rows.length >= capacity} onClick={() => onChange([...rows, emptyVariantRow({ stock: '0' })])}>
          افزودن ردیف
        </Button>
        <span>
          {toPersianDigits(rows.length)} تنوع
        </span>
      </div>
    </div>
  );
}
```

### `apps/frontend/src/lib/api/catalog.server.ts`

```ts
import { serverApi } from './server';
import type { CategoryTree, CreditPlans, Page, ProductListItem, ProductQuery } from './types';

export type Loaded<T> = { ok: true; data: T } | { ok: false; message: string };

async function load<T>(promise: Promise<T>): Promise<Loaded<T>> {
  try {
    return { ok: true, data: await promise };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'خطای نامشخص' };
  }
}

export function loadProducts(query: ProductQuery): Promise<Loaded<Page<ProductListItem>>> {
  return load(serverApi<Page<ProductListItem>>('products', { query: { ...query } }));
}

export function loadCategoryTree(): Promise<Loaded<CategoryTree>> {
  return load(serverApi<CategoryTree>('categories/tree'));
}

/** Installment plans of the active credit provider (public). */
export function loadCreditPlans(): Promise<Loaded<CreditPlans>> {
  return load(serverApi<CreditPlans>('credit/plans'));
}

/** BNPL badges are shown only when the credit programme is live and has plans. */
export function isBnplEnabled(plans: Loaded<CreditPlans>): boolean {
  return plans.ok && plans.data.creditEnabled && plans.data.items.length > 0;
}
```

### `apps/frontend/src/lib/api/client.ts`

```ts
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { resolvePublicApiBaseUrl } from '../env';
import { toApiError } from './errors';

/** Upper bound for a browser request before it is reported as a timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Uploads carry images/documents of several megabytes. */
export const UPLOAD_TIMEOUT_MS = 90_000;

/**
 * Creates an axios instance that always talks to the Shopino BFF (same
 * origin, `/api/v1`) and never leaks transport-specific errors to the callers:
 * every rejection is an {@link import('./errors').ApiError}.
 *
 * No token handling happens here: the BFF attaches the httpOnly session
 * cookies' access token server-side and refreshes it transparently.
 */
export function createApiClient(baseURL: string = resolvePublicApiBaseUrl()): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    withCredentials: true,
    headers: {
      Accept: 'application/json',
    },
    // Arrays as repeated keys (colors=a&colors=b), which the backend expects.
    paramsSerializer: { indexes: null },
  });

  instance.interceptors.response.use(
    (response) => response,
    (error: unknown) => Promise.reject(toApiError(error)),
  );

  return instance;
}

/** Shared client for browser components. */
export const apiClient = createApiClient();

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;
export type Query = Record<string, QueryValue>;

/** Drops empty values so optional filters never reach the API as "". */
export function cleanQuery(query: Query | undefined): Record<string, string | number | boolean | readonly string[]> {
  const result: Record<string, string | number | boolean | readonly string[]> = {};
  if (!query) {
    return result;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value as string | number | boolean | readonly string[];
  }
  return result;
}

/** Query string in the same format the axios client sends. */
export function toQueryString(query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(cleanQuery(query))) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function apiGet<TResponse>(path: string, config?: AxiosRequestConfig & { query?: Query }): Promise<TResponse> {
  const { query, ...rest } = config ?? {};
  const { data } = await apiClient.get<TResponse>(path, { ...rest, params: cleanQuery(query) });
  return data;
}

export async function apiPost<TResponse, TBody = unknown>(path: string, body?: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.post<TResponse>(path, body ?? {}, config);
  return data;
}

export async function apiPatch<TResponse, TBody = unknown>(path: string, body: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.patch<TResponse>(path, body, config);
  return data;
}

export async function apiDelete<TResponse>(path: string, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.delete<TResponse>(path, config);
  return data;
}

/**
 * Multipart upload (media endpoints). `purpose` is written before the file:
 * the backend reads the parts in order.
 */
export async function apiUpload<TResponse>(path: string, file: File, purpose: string, onProgress?: (fraction: number) => void): Promise<TResponse> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', file, file.name);
  const { data } = await apiClient.post<TResponse>(path, form, {
    timeout: UPLOAD_TIMEOUT_MS,
    onUploadProgress: (event) => {
      if (onProgress && event.total) {
        onProgress(event.loaded / event.total);
      }
    },
  });
  return data;
}

/** Same-origin session endpoints (sign-in/out) of the BFF — not under /api/v1. */
export const sessionClient = createApiClient('/api/session');
```

### `apps/frontend/src/lib/api/error-messages.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { localizeErrorMessage } from './error-messages';

describe('localizeErrorMessage', () => {
  it('translates known business codes', () => {
    expect(localizeErrorMessage(409, 'IBAN_MISMATCH', 'Target IBAN differs', {})).toBe('شبای مقصد باید همان شبای ثبت‌شده در پروفایل فروشگاه باشد.');
  });

  it('formats money details in Toman', () => {
    expect(localizeErrorMessage(400, 'AMOUNT_BELOW_MINIMUM', 'The minimum settlement amount is 1000000.00 IRR', { minimumAmount: '1000000.00' })).toBe('حداقل مبلغ تسویه ۱۰۰٬۰۰۰ تومان است.');
  });

  it('keeps Persian backend messages', () => {
    expect(localizeErrorMessage(400, undefined, 'ایمیل معتبر نیست', {})).toBe('ایمیل معتبر نیست');
  });

  it('keeps English validation details next to a Persian sentence', () => {
    expect(localizeErrorMessage(400, undefined, 'trackingCode must be longer than 4', {})).toBe('اطلاعات ارسالی معتبر نیست. (trackingCode must be longer than 4)');
  });

  it('replaces other English messages with a status text', () => {
    expect(localizeErrorMessage(403, undefined, 'Forbidden resource', {})).toBe('اجازهٔ انجام این کار را ندارید.');
    expect(localizeErrorMessage(418, undefined, undefined, {})).toBe('درخواست با خطای 418 رد شد.');
  });
});
```

### `apps/frontend/src/lib/api/error-messages.ts`

```ts
import { formatToman } from '@/lib/currency';

/**
 * Persian texts for the backend's stable error codes. The backend keeps some
 * messages in English (they are also read by API clients and logs); the UI is
 * Persian-only, so known codes are translated here and unknown English
 * messages fall back to a status-based Persian sentence.
 */
const CODE_MESSAGES: Record<string, string | ((details: Record<string, unknown>) => string)> = {
  AMOUNT_BELOW_MINIMUM: (details) => (typeof details.minimumAmount === 'string' ? `حداقل مبلغ تسویه ${formatToman(details.minimumAmount)} است.` : 'مبلغ کمتر از حداقل مجاز است.'),
  AMOUNT_NOT_WHOLE_RIALS: 'مبلغ باید عدد صحیح ریال باشد.',
  BANK_ACCOUNT_MISSING: 'حساب بانکی فروشگاه ثبت نشده است.',
  CART_EMPTY: 'سبد خرید خالی است.',
  CART_FULL: 'سبد خرید به حداکثر ظرفیت رسیده است.',
  CONCURRENT_UPDATE: 'اطلاعات هم‌زمان تغییر کرد؛ صفحه را تازه کنید و دوباره تلاش کنید.',
  CREDIT_ORDER_REFUND_UNSUPPORTED: 'بازپرداخت یا لغو مرسوله‌های سفارش اعتباری/ترکیبی به‌صورت خودکار پشتیبانی نمی‌شود؛ باید با بانک اعتباردهنده به‌صورت دستی پیگیری شود.',
  CREDIT_ACCOUNT_EXISTS: 'شما از قبل حساب اعتباری فعال دارید.',
  CREDIT_ACCOUNT_EXPIRED: 'اعتبار شما منقضی شده است.',
  CREDIT_ACCOUNT_NOT_ACTIVE: 'حساب اعتباری شما فعال نیست.',
  CREDIT_ACCOUNT_NOT_FOUND: 'حساب اعتباری ندارید.',
  CREDIT_ACCOUNT_REQUIRED: 'برای خرید اقساطی ابتدا اعتبار دریافت کنید.',
  CREDIT_APPLICATION_IN_PROGRESS: 'درخواست اعتبار قبلی شما هنوز در حال بررسی است.',
  CREDIT_PROVIDER_NOT_ACTIVE: 'این تأمین‌کنندهٔ اعتبار فعال نیست.',
  CREDIT_PROVIDER_UNAVAILABLE: 'سامانهٔ بانک در دسترس نیست؛ کمی بعد دوباره تلاش کنید.',
  CREDIT_RESERVATION_NOT_HELD: 'رزرو اعتبار این سفارش معتبر نیست.',
  DISPUTE_ALREADY_ACTIVE: 'برای این مرسوله اختلاف فعالی وجود دارد.',
  DISPUTE_ALREADY_CLOSED: 'این اختلاف بسته شده است.',
  DISPUTE_ALREADY_DECIDED: 'برای این مرسوله قبلاً رأی صادر شده است.',
  DISPUTE_NOT_AWAITING_VENDOR: 'این اختلاف در انتظار پاسخ فروشنده نیست.',
  DISPUTE_NOT_CANCELLABLE: 'این اختلاف دیگر قابل پس گرفتن نیست.',
  ESCROW_FROZEN_BY_DISPUTE: 'مبلغ این مرسوله به‌دلیل اختلاف مسدود است.',
  ESCROW_NOT_FREEZABLE: 'مبلغ این مرسوله قابل مسدودسازی نیست.',
  ESCROW_NOT_FROZEN: 'مبلغ این مرسوله مسدود نیست.',
  GATEWAY_UNAVAILABLE: 'درگاه پرداخت در دسترس نیست؛ کمی بعد دوباره تلاش کنید.',
  GATEWAY_UNREACHABLE: 'ارتباط با درگاه پرداخت برقرار نشد.',
  HYBRID_NOT_REQUIRED: 'اعتبار شما برای کل مبلغ کافی است؛ «پرداخت اعتباری» را انتخاب کنید.',
  IBAN_MISMATCH: 'شبای مقصد باید همان شبای ثبت‌شده در پروفایل فروشگاه باشد.',
  INSTALLMENT_NOT_PAYABLE: 'این قسط قابل پرداخت نیست.',
  INSTALLMENT_PLAN_NOT_AVAILABLE: 'این طرح اقساطی در دسترس نیست.',
  INSUFFICIENT_CREDIT: 'اعتبار قابل استفادهٔ شما کافی نیست.',
  INSUFFICIENT_STOCK: 'موجودی کالا کافی نیست.',
  INSUFFICIENT_WALLET_BALANCE: 'موجودی قابل برداشت کافی نیست.',
  INVALID_AMOUNT: 'مبلغ نامعتبر است.',
  INVALID_CART_TOKEN: 'سبد خرید نامعتبر است؛ صفحه را تازه کنید.',
  INVALID_DOCUMENTS: 'مدارک ارسالی نامعتبر است.',
  INVALID_STATUS_TRANSITION: 'این تغییر وضعیت در حالت فعلی مجاز نیست.',
  NATIONAL_CODE_IN_USE: 'این کد ملی برای حساب دیگری ثبت شده است.',
  NATIONAL_CODE_MISMATCH: 'کد ملی با کد ملی پروفایل شما یکسان نیست.',
  ORDER_NOT_PAID: 'این سفارش پرداخت نشده است.',
  ORDER_NOT_PAYABLE: 'این سفارش قابل پرداخت نیست.',
  ORDER_PAYMENT_EXPIRED: 'مهلت پرداخت این سفارش به پایان رسیده است.',
  OUT_OF_STOCK: 'کالا ناموجود است.',
  PAYA_REFERENCE_IN_USE: 'این شمارهٔ پیگیری پایا قبلاً ثبت شده است.',
  PRICE_CHANGED: 'قیمت کالا تغییر کرده است.',
  SETTLEMENT_ALREADY_PROCESSED: 'این درخواست تسویه قبلاً رسیدگی شده است.',
  SUB_ORDER_NOT_DISPUTABLE: 'برای این مرسوله در وضعیت فعلی نمی‌توان اختلاف ثبت کرد.',
  SUB_ORDER_UNDER_DISPUTE: 'این مرسوله اختلاف فعال دارد و تا پایان رسیدگی قابل تغییر نیست.',
};

const STATUS_MESSAGES: Record<number, string> = {
  400: 'اطلاعات ارسالی معتبر نیست.',
  401: 'نشست شما به پایان رسیده است؛ دوباره وارد شوید.',
  403: 'اجازهٔ انجام این کار را ندارید.',
  404: 'مورد درخواستی پیدا نشد.',
  409: 'این عملیات با وضعیت فعلی سازگار نیست.',
  413: 'حجم فایل بیش از حد مجاز است.',
  415: 'نوع فایل پشتیبانی نمی‌شود.',
  422: 'اطلاعات ارسالی قابل پردازش نیست.',
  429: 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.',
  500: 'خطای داخلی سرور رخ داد.',
  502: 'سرویس بیرونی پاسخ نداد؛ کمی بعد دوباره تلاش کنید.',
  503: 'سرویس موقتاً در دسترس نیست.',
};

const PERSIAN_LETTER = /[\u0600-\u06FF]/;

/** Persian UI message for a failed HTTP response. */
export function localizeErrorMessage(status: number, code: string | undefined, backendMessage: string | undefined, details: unknown): string {
  const mapped = code ? CODE_MESSAGES[code] : undefined;
  if (mapped) {
    return typeof mapped === 'function' ? mapped(typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}) : mapped;
  }
  if (backendMessage && PERSIAN_LETTER.test(backendMessage)) {
    return backendMessage;
  }
  const generic = STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500] : `درخواست با خطای ${status} رد شد.`);
  // Validation details stay visible (they name the offending field) for 400/422.
  return backendMessage && (status === 400 || status === 422) ? `${generic} (${backendMessage})` : (generic ?? `درخواست با خطای ${status} رد شد.`);
}
```

### `apps/frontend/src/lib/api/errors.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { ApiError, toApiError, toApiErrorFromResponse } from './errors';

/** Minimal axios-like rejection, matching what axios actually produces. */
function axiosErrorWith(overrides: Record<string, unknown>): unknown {
  return {
    name: 'AxiosError',
    message: 'Request failed',
    isAxiosError: true,
    ...overrides,
  };
}

describe('toApiError', () => {
  it('maps a 4xx response to an http error and keeps the validation messages', () => {
    const error = toApiError(
      axiosErrorWith({
        code: 'ERR_BAD_REQUEST',
        response: {
          status: 400,
          data: {
            statusCode: 400,
            message: ['email must be an email', 'password is too short'],
            error: 'Bad Request',
          },
        },
      }),
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error.kind).toBe('http');
    expect(error.status).toBe(400);
    expect(error.code).toBe('Bad Request');
    expect(error.message).toBe('email must be an email، password is too short');
    expect(error.isClientError).toBe(true);
  });

  it('prefers the stable business code of actionable errors (409 INSUFFICIENT_STOCK…)', () => {
    const error = toApiError(
      axiosErrorWith({
        response: {
          status: 409,
          data: { statusCode: 409, error: 'Conflict', code: 'INSUFFICIENT_STOCK', message: 'Only 2 left', available: 2 },
        },
      }),
    );
    expect(error.code).toBe('INSUFFICIENT_STOCK');
    expect(error.details).toMatchObject({ available: 2 });
  });

  it('maps a 5xx response to a server error', () => {
    const error = toApiError(
      axiosErrorWith({
        code: 'ERR_BAD_RESPONSE',
        response: { status: 503, data: { statusCode: 503, message: 'Service Unavailable' } },
      }),
    );

    expect(error.kind).toBe('http');
    expect(error.isServerError).toBe(true);
    // English infrastructure messages are replaced by a Persian status text.
    expect(error.message).toBe('سرویس موقتاً در دسترس نیست.');
  });

  it('maps a missing response to a network error', () => {
    const error = toApiError(axiosErrorWith({ code: 'ERR_NETWORK' }));

    expect(error.kind).toBe('network');
    expect(error.message).toContain('ارتباط با سرور');
  });

  it('maps an aborted request to a timeout error', () => {
    const error = toApiError(axiosErrorWith({ code: 'ECONNABORTED' }));

    expect(error.kind).toBe('timeout');
  });

  it('returns the same instance when an ApiError is passed through', () => {
    const original = new ApiError('already mapped', { kind: 'unknown' });

    expect(toApiError(original)).toBe(original);
  });

  it('wraps an unexpected value as an unknown error', () => {
    const error = toApiError(new Error('boom'));

    expect(error.kind).toBe('unknown');
    expect(error.message).toBe('boom');
  });
});

describe('toApiErrorFromResponse', () => {
  it('uses a Persian backend message as-is and keeps the payload available as details', () => {
    const body = { statusCode: 503, message: 'پایگاه داده در دسترس نیست' };
    const error = toApiErrorFromResponse(new Response(JSON.stringify(body), { status: 503 }), body);

    expect(error.status).toBe(503);
    expect(error.message).toBe('پایگاه داده در دسترس نیست');
    expect(error.details).toEqual(body);
  });

  it('falls back to a generic message when the body carries none', () => {
    const error = toApiErrorFromResponse(new Response(null, { status: 502 }), undefined);

    expect(error.message).toBe('سرویس بیرونی پاسخ نداد؛ کمی بعد دوباره تلاش کنید.');
    expect(error.kind).toBe('http');
  });
});
```

### `apps/frontend/src/lib/api/errors.ts`

```ts
import axios from 'axios';

import { localizeErrorMessage } from './error-messages';

/** Classification of everything that can go wrong on an API call. */
export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'parse' | 'unknown';

export interface ApiErrorOptions {
  kind: ApiErrorKind;
  status?: number;
  code?: string;
  details?: unknown;
  cause?: unknown;
}

/**
 * Single error type surfaced to the UI. Callers can branch on `kind`/`status`
 * without knowing whether the failure came from axios, fetch or JSON parsing.
 */
export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly details?: unknown;

  constructor(message: string, options: ApiErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'ApiError';
    this.kind = options.kind;
    if (options.status !== undefined) {
      this.status = options.status;
    }
    if (options.code !== undefined) {
      this.code = options.code;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  /** True for 4xx responses, where retrying the same request cannot help. */
  get isClientError(): boolean {
    return this.status !== undefined && this.status >= 400 && this.status < 500;
  }

  /** True when the backend is reachable but reports a failure (5xx). */
  get isServerError(): boolean {
    return this.status !== undefined && this.status >= 500;
  }
}

interface NestErrorBody {
  statusCode?: number;
  message?: string | string[];
  error?: string;
  /** Stable machine code of actionable errors (e.g. INSUFFICIENT_STOCK). */
  code?: string;
}

function readNestErrorBody(data: unknown): NestErrorBody | undefined {
  return typeof data === 'object' && data !== null ? (data as NestErrorBody) : undefined;
}

function messageFromBody(data: unknown): string | undefined {
  const body = readNestErrorBody(data);
  if (body?.message === undefined) {
    return undefined;
  }
  return Array.isArray(body.message) ? body.message.join('، ') : body.message;
}

/** Normalises any thrown value into an {@link ApiError}. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    return error;
  }

  if (axios.isAxiosError(error)) {
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return new ApiError('پاسخی از سرور دریافت نشد؛ زمان درخواست به پایان رسید.', {
        kind: 'timeout',
        code: error.code,
        cause: error,
      });
    }

    if (error.response === undefined) {
      return new ApiError('ارتباط با سرور برقرار نشد. اتصال شبکه را بررسی کنید.', {
        kind: 'network',
        code: error.code,
        cause: error,
      });
    }

    const { status, data } = error.response;
    const code = readNestErrorBody(data)?.code;
    return new ApiError(localizeErrorMessage(status, code, messageFromBody(data), data), {
      kind: 'http',
      status,
      code: code ?? readNestErrorBody(data)?.error,
      details: data,
      cause: error,
    });
  }

  if (error instanceof Error) {
    return new ApiError(error.message, { kind: 'unknown', cause: error });
  }

  return new ApiError('خطای ناشناخته در ارتباط با سرور.', { kind: 'unknown', cause: error });
}

/** Builds an {@link ApiError} for a failed `fetch` response. */
export function toApiErrorFromResponse(response: Response, details: unknown): ApiError {
  return new ApiError(localizeErrorMessage(response.status, readNestErrorBody(details)?.code, messageFromBody(details), details), {
    kind: 'http',
    status: response.status,
    code: readNestErrorBody(details)?.code ?? readNestErrorBody(details)?.error,
    details,
  });
}
```

### `apps/frontend/src/lib/api/server.ts`

```ts
import { cookies, headers } from 'next/headers';

import { ACCESS_COOKIE, CART_COOKIE, backendApiUrl, forwardingHeaders } from '../auth/session-core';
import { ApiError, toApiError, toApiErrorFromResponse } from './errors';
import { toQueryString, type Query } from './client';
import type { Me } from './types';

const SERVER_FETCH_TIMEOUT_MS = 8_000;

/**
 * Server Component / Server Action access to the backend: direct (never via
 * the browser), with the session's access token from the httpOnly cookie
 * (the middleware has already refreshed it for this render).
 */
export async function serverApi<T>(path: string, options: { query?: Query; method?: string; body?: unknown } = {}): Promise<T> {
  const cookieStore = await cookies();
  const incoming = await headers();
  const requestHeaders: Record<string, string> = { Accept: 'application/json', ...forwardingHeaders(incoming) };
  const accessToken = cookieStore.get(ACCESS_COOKIE)?.value;
  if (accessToken) {
    requestHeaders.Authorization = `Bearer ${accessToken}`;
  }
  const cartToken = cookieStore.get(CART_COOKIE)?.value;
  if (cartToken) {
    requestHeaders['X-Cart-Token'] = cartToken;
  }
  if (options.body !== undefined) {
    requestHeaders['Content-Type'] = 'application/json';
  }
  try {
    const response = await fetch(`${backendApiUrl(path)}${toQueryString(options.query)}`, {
      method: options.method ?? 'GET',
      headers: requestHeaders,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    });
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw toApiErrorFromResponse(response, body);
    }
    return body as T;
  } catch (error) {
    throw error instanceof ApiError ? error : toApiError(error);
  }
}

/** Like {@link serverApi} but resolves to null on 404 (missing product/category). */
export async function serverApiOrNull<T>(path: string, options: { query?: Query } = {}): Promise<T | null> {
  try {
    return await serverApi<T>(path, options);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/** The signed-in identity for the first render, or null (anonymous / expired). */
export async function getServerSession(): Promise<Me | null> {
  const cookieStore = await cookies();
  if (!cookieStore.get(ACCESS_COOKIE)?.value) {
    return null;
  }
  try {
    return await serverApi<Me>('auth/me');
  } catch {
    return null;
  }
}
```

### `apps/frontend/src/lib/api/types.ts`

```ts
/**
 * Response/request shapes of the Shopino API (`/api/v1`), mirrored from the
 * backend DTO classes (apps/backend/src/modules/<module>/dto). Money fields
 * are Rial decimal strings ("35000000.00"); dates are ISO strings.
 */

/* ─── Enums ─────────────────────────────────────────────────────────────── */

export const USER_ROLES = ['SUPER_ADMIN', 'ADMIN', 'VENDOR', 'CUSTOMER', 'FINANCIAL_OFFICER', 'SUPPORT'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const STAFF_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCIAL_OFFICER', 'SUPPORT'];

export type VendorStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type PaymentMethod = 'CASH_IPG' | 'BANK_CREDIT' | 'HYBRID';
export type ParentOrderPaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
export const SUB_ORDER_STATUSES = ['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const;
export type SubOrderStatus = (typeof SUB_ORDER_STATUSES)[number];
export type PaymentStatus = 'INITIATED' | 'SUCCESSFUL' | 'FAILED' | 'REFUNDED';
export type PaymentPurpose = 'ORDER_CHECKOUT' | 'INSTALLMENT_REPAYMENT';
export type PaymentOutcome = 'PAID' | 'FAILED' | 'VERIFICATION_PENDING' | 'PAID_REQUIRES_REFUND';
export type WalletTransactionType =
  | 'CREDIT_SALE_ESCROW_HOLD'
  | 'ESCROW_RELEASE_TO_WITHDRAWABLE'
  | 'COMMISSION_DEDUCTION'
  | 'SETTLEMENT_PAYOUT'
  | 'REFUND_DEDUCTION'
  | 'SETTLEMENT_HOLD'
  | 'SETTLEMENT_HOLD_RELEASE'
  | 'DISPUTE_HOLD_LOCK'
  | 'DISPUTE_HOLD_RELEASE';
export const WALLET_BUCKETS = ['PENDING', 'WITHDRAWABLE', 'SETTLEMENT_HOLD', 'DISPUTE_HOLD'] as const;
export type WalletBalanceBucket = (typeof WALLET_BUCKETS)[number];
export const SETTLEMENT_STATUSES = ['REQUESTED', 'PROCESSING', 'PAID_PAYA', 'REJECTED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export type CreditAccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';
export type CreditApplicationStatus = 'DRAFT' | 'PENDING_BANK_INQUIRY' | 'DOCS_REQUIRED' | 'APPROVED' | 'REJECTED';
export type InstallmentStatus = 'PENDING' | 'PAID' | 'OVERDUE' | 'WAIVED';
export const DISPUTE_REASONS = ['WRONG_ITEM', 'DAMAGED', 'NOT_AS_DESCRIBED', 'NOT_DELIVERED', 'COUNTERFEIT'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
export const DISPUTE_STATUSES = ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION', 'RESOLVED_BUYER_FAVOR', 'RESOLVED_VENDOR_FAVOR', 'CANCELLED'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type DisputeVendorAction = 'ACCEPT_RETURN' | 'REJECT_WITH_DEFENSE';
export type DisputeEventType =
  | 'OPENED'
  | 'EVIDENCE_ADDED'
  | 'VENDOR_ACCEPTED_RETURN'
  | 'VENDOR_DEFENDED'
  | 'ARBITRATED_BUYER_FAVOR'
  | 'ARBITRATED_VENDOR_FAVOR'
  | 'CANCELLED_BY_CUSTOMER'
  | 'REFUND_NOTICE_SENT'
  | 'REFUND_NOTICE_FAILED';
export type ArbitrationDecision = 'BUYER_FAVOR' | 'VENDOR_FAVOR';
export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'popular'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export type VendorProductStatus = 'published' | 'draft' | 'blocked';

/* ─── Shared ────────────────────────────────────────────────────────────── */

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ImageRef {
  url: string;
  thumbnailUrl: string | null;
}

export interface PriceRange {
  min: string;
  max: string;
}

/* ─── Auth ──────────────────────────────────────────────────────────────── */

export interface AuthUser {
  id: string;
  mobile: string;
  role: UserRole;
  fullName: string;
  email: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  user: AuthUser;
}

export interface OtpRequestResponse {
  status: 'sent';
  expiresInSeconds: number;
  trackingId: string;
}

export interface CustomerProfile {
  birthDate: string | null;
  gender: string | null;
  bankIban: string | null;
  defaultAddressId: string | null;
}

export interface MeVendorSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  status: VendorStatus;
  logoUrl: string | null;
}

export interface Me {
  user: AuthUser;
  customerProfile: CustomerProfile | null;
  vendor: MeVendorSummary | null;
}

export interface UpdateProfileInput {
  fullName?: string;
  email?: string;
  nationalCode?: string;
  birthDate?: string;
}

/* ─── Categories ────────────────────────────────────────────────────────── */

export interface CategorySummary {
  id: string;
  slug: string;
  titleFa: string;
  titleEn: string | null;
}

export interface CategoryTreeNode extends CategorySummary {
  parentId: string | null;
  defaultCommissionRate: string;
  sortOrder: number;
  depth: number;
  productCount: number;
  totalProductCount: number;
  children: CategoryTreeNode[];
}

export interface CategoryTree {
  items: CategoryTreeNode[];
  totalCategories: number;
  totalProducts: number;
}

export interface Subcategory extends CategorySummary {
  sortOrder: number;
  totalProductCount: number;
  childCount: number;
}

export interface CategoryDetail extends CategorySummary {
  parentId: string | null;
  defaultCommissionRate: string;
  depth: number;
  productCount: number;
  totalProductCount: number;
  breadcrumbs: CategorySummary[];
  children: Subcategory[];
}

/* ─── Catalog ───────────────────────────────────────────────────────────── */

export interface ColorOption {
  name: string;
  hex: string | null;
}

export interface PublicVendorSummary {
  storeName: string;
  storeSlug: string;
  logoUrl: string | null;
}

export interface PublicVendorDetail extends PublicVendorSummary {
  bio: string | null;
  instagramHandle: string | null;
  verifiedAt: string | null;
}

export interface ProductListItem {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  primaryImage: ImageRef | null;
  priceRange: PriceRange;
  maxDiscountPercent: number | null;
  startingCompareAtPrice: string | null;
  colors: ColorOption[];
  sizes: string[];
  inStock: boolean;
  vendor: PublicVendorSummary;
  category: CategorySummary;
  createdAt: string;
}

export interface PublicVariant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  availableQuantity: number;
  inStock: boolean;
  weightGrams: number | null;
}

export interface ProductDetail {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  brand: string | null;
  breadcrumbs: CategorySummary[];
  vendor: PublicVendorDetail;
  media: ImageRef[];
  variants: PublicVariant[];
  priceRange: PriceRange;
  maxDiscountPercent: number | null;
  colors: ColorOption[];
  sizes: string[];
  inStock: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProductQuery {
  search?: string;
  categorySlug?: string;
  vendorSlug?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  colors?: string[];
  sizes?: string[];
  sortBy?: ProductSort;
  page?: number;
  pageSize?: number;
}

/* ─── Vendor products ───────────────────────────────────────────────────── */

export interface StockSummary {
  variantCount: number;
  activeVariantCount: number;
  totalStock: number;
  totalReserved: number;
  totalAvailable: number;
}

export interface ProductModeration {
  isBlockedByAdmin: boolean;
  blockedReason: string | null;
  blockedAt: string | null;
}

export interface VendorVariant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  weightGrams: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendorProductSummary {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  basePrice: string;
  isPublished: boolean;
  isSellable: boolean;
  moderation: ProductModeration;
  category: CategorySummary;
  primaryImage: ImageRef | null;
  priceRange: PriceRange | null;
  stock: StockSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ProductMedia extends ImageRef {
  id: string;
  mediaAssetId: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface VendorProductDetail extends VendorProductSummary {
  description: string | null;
  media: ProductMedia[];
  variants: VendorVariant[];
}

export interface CreateVariantInput {
  sku: string;
  colorName?: string | null;
  colorHex?: string | null;
  size?: string | null;
  guarantee?: string | null;
  price: number;
  compareAtPrice?: number | null;
  stockQuantity: number;
  weightGrams?: number | null;
  isActive?: boolean;
}

export interface UpdateVariantInput {
  price?: number;
  compareAtPrice?: number | null;
  /** Absolute stock; mutually exclusive with stockDelta. */
  stockQuantity?: number;
  stockDelta?: number;
  isActive?: boolean;
}

export interface CreateProductInput {
  title: string;
  slug?: string;
  description?: string | null;
  categoryId: string;
  brand?: string | null;
  basePrice: number;
  mediaIds?: string[];
  variants: CreateVariantInput[];
  isPublished?: boolean;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'variants'>>;

export interface ArchiveProductResponse {
  id: string;
  slug: string;
  isPublished: boolean;
  wasPublished: boolean;
  auditLogId: string | null;
}

export interface AdminProduct extends VendorProductSummary {
  vendor: { id: string; storeName: string; storeSlug: string; status: VendorStatus };
  blockedByUserId: string | null;
}

/* ─── Media ─────────────────────────────────────────────────────────────── */

export interface ImageUploadResponse {
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
}

export interface DocumentUploadResponse {
  id: string;
  url: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  isPublic: false;
}

export type ImagePurpose = 'avatar' | 'store_logo' | 'store_banner' | 'product_image';
export type DocumentPurpose = 'kyc_national_id' | 'kyc_business_license' | 'kyc_bank_proof' | 'dispute_evidence' | 'other';

/* ─── Cart ──────────────────────────────────────────────────────────────── */

export interface CartIssue {
  code: string;
  message: string;
}

export interface CartLine {
  id: string;
  productVariantId: string;
  sku: string;
  productId: string;
  productSlug: string;
  productTitle: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  image: ImageRef | null;
  quantity: number;
  unitPrice: string;
  priceWhenAdded: string;
  compareAtPrice: string | null;
  lineTotal: string;
  availableQuantity: number;
  isPurchasable: boolean;
  issues: CartIssue[];
  addedAt: string;
}

export interface CartShipping {
  fee: string;
  isFree: boolean;
  freeThreshold: string;
  remainingForFreeShipping: string | null;
}

export interface CartVendorGroup {
  vendor: { storeName: string; storeSlug: string };
  lines: CartLine[];
  itemsSubtotal: string;
  shipping: CartShipping;
  packageTotal: string;
}

export interface Cart {
  cartToken: string | null;
  owner: 'user' | 'guest' | 'none';
  groups: CartVendorGroup[];
  itemCount: number;
  lineCount: number;
  itemsSubtotal: string;
  shippingTotal: string;
  payableAmount: string;
  hasPriceChanges: boolean;
  canCheckout: boolean;
}

/* ─── Addresses ─────────────────────────────────────────────────────────── */

export interface Address {
  id: string;
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber: string | null;
  unitNumber: string | null;
  recipientName: string;
  recipientMobile: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AddressList {
  items: Address[];
  total: number;
  limit: number;
}

export interface AddressInput {
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber?: string | null;
  unitNumber?: string | null;
  recipientName: string;
  recipientMobile: string;
  isDefault?: boolean;
}

/* ─── Orders ────────────────────────────────────────────────────────────── */

export interface AddressSnapshot {
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber: string | null;
  unitNumber: string | null;
  recipientName: string;
  recipientMobile: string;
}

export interface OrderItem {
  id: string;
  productVariantId: string | null;
  productTitle: string;
  sku: string;
  vendorStoreName: string;
  variantDetails: { colorName: string | null; colorHex: string | null; size: string | null; guarantee: string | null };
  unitPrice: string;
  quantity: number;
  discount: string;
  lineTotal: string;
}

export interface VendorOrderItem extends OrderItem {
  commissionRate: string;
  commissionAmount: string;
}

export interface StoreRef {
  id: string;
  storeName: string;
  storeSlug: string;
}

export interface TimelineEvent {
  at: string;
  type: 'ORDER_PLACED' | 'PAYMENT_CONFIRMED' | 'ORDER_CANCELLED' | 'PAYMENT_FAILED' | 'SUB_ORDER_STATUS';
  subOrderNumber: string | null;
  fromStatus: SubOrderStatus | null;
  toStatus: SubOrderStatus | null;
  actor: string;
  note: string | null;
}

export interface CustomerSubOrder {
  id: string;
  subOrderNumber: string;
  store: StoreRef;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  total: string;
  trackingCode: string | null;
  carrierName: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: OrderItem[];
}

export interface OrderMoney {
  id: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: PaymentMethod;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string | null;
  createdAt: string;
}

export interface CustomerSubOrderSummary {
  id: string;
  subOrderNumber: string;
  storeName: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  itemCount: number;
  trackingCode: string | null;
}

export interface CustomerOrderSummary extends OrderMoney {
  subOrders: CustomerSubOrderSummary[];
}

export interface CustomerOrderDetail extends OrderMoney {
  shippingAddress: AddressSnapshot;
  customerNote: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  canCancel: boolean;
  subOrders: CustomerSubOrder[];
  timeline: TimelineEvent[];
}

export interface CheckoutResponse {
  parentOrderId: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: PaymentMethod;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string | null;
  subOrders: CustomerSubOrder[];
}

export interface StatusHistoryEntry {
  fromStatus: SubOrderStatus | null;
  toStatus: SubOrderStatus;
  actorRole: string;
  note: string | null;
  at: string;
}

export interface VendorSubOrderSummary {
  id: string;
  subOrderNumber: string;
  orderNumber: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  platformCommissionAmount: string;
  vendorEarningsAmount: string;
  itemCount: number;
  trackingCode: string | null;
  carrierName: string | null;
  placedAt: string;
  paidAt: string | null;
  allowedTransitions: SubOrderStatus[];
}

export interface VendorSubOrderDetail extends Omit<VendorSubOrderSummary, 'itemCount'> {
  itemCount: number;
  shippingAddress: AddressSnapshot;
  customerNote: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: VendorOrderItem[];
  history: StatusHistoryEntry[];
}

export type WalletAction = 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'DISPUTE_HOLD_REFUNDED' | 'DISPUTE_HOLD_RELEASED' | 'NONE';

export interface VendorSubOrderTransition {
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
  subOrder: VendorSubOrderDetail;
}

export interface CustomerDeliveryConfirmation {
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
  order: CustomerOrderDetail;
}

/* ─── Payments & credit ─────────────────────────────────────────────────── */

export interface InitiatePaymentResponse {
  paymentId: string;
  redirectUrl: string;
  gatewayName: 'SANDBOX' | 'ZARINPAL';
  amount: string;
  currency: string;
  orderNumber: string;
  paymentExpiresAt: string | null;
}

export interface InstallmentPlanRef {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
}

export interface CreditPaymentInitiateResponse {
  status: 'COMPLETED' | 'IPG_REQUIRED';
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: 'BANK_CREDIT' | 'HYBRID';
  creditAmount: string;
  cashAmount: string;
  currency: string;
  plan: InstallmentPlanRef;
  orderPaymentStatus: ParentOrderPaymentStatus;
  redirectUrl: string | null;
  gatewayName: string | null;
  paymentExpiresAt: string | null;
  schedule: {
    installments: number;
    creditAmount: string;
    totalInterest: string;
    totalPayable: string;
    firstDueDate: string;
    lastDueDate: string;
  } | null;
}

export interface CreditProviderSummary {
  code: string;
  name: string;
  isSandbox: boolean;
}

export interface CreditAccount {
  id: string;
  provider: CreditProviderSummary;
  status: CreditAccountStatus;
  totalLimit: string;
  usedAmount: string;
  reservedAmount: string;
  availableAmount: string;
  currency: string;
  expiresAt: string | null;
  createdAt: string;
  outstanding: { count: number; overdueCount: number; principal: string; interest: string; nextDueDate: string | null };
}

export interface CreditApplication {
  id: string;
  status: CreditApplicationStatus;
  provider: CreditProviderSummary;
  requestedLimit: string;
  approvedLimit: string | null;
  trackingCode: string | null;
  score: number | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  account: CreditAccount | null;
}

export interface InstallmentPlan {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
  penaltyRatePercentPerMonth: string;
  installmentIntervalDays: number;
}

export interface CreditPlans {
  creditEnabled: boolean;
  provider: CreditProviderSummary | null;
  items: InstallmentPlan[];
}

export interface Installment {
  id: string;
  installmentNumber: number;
  totalInstallments: number;
  dueDate: string;
  principalAmount: string;
  interestAmount: string;
  penaltyAmount: string;
  totalAmount: string;
  paidAmount: string;
  amountDue: string;
  status: InstallmentStatus;
  paidAt: string | null;
}

export interface OrderInstallments {
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: PaymentMethod;
  paidAt: string | null;
  plan: InstallmentPlanRef | null;
  creditAmount: string;
  totalInterest: string;
  totalPayable: string;
  paidAmount: string;
  remainingAmount: string;
  paidCount: number;
  overdueCount: number;
  installments: Installment[];
}

export interface InstallmentsOverview {
  orders: OrderInstallments[];
  totalRemaining: string;
  overdueCount: number;
}

export interface InstallmentPaymentResponse {
  paymentId: string;
  installmentId: string;
  installmentNumber: number;
  totalInstallments: number;
  orderNumber: string;
  redirectUrl: string;
  gatewayName: string;
  amount: string;
  currency: string;
}

/* ─── Disputes ──────────────────────────────────────────────────────────── */

export interface DisputeEvidence {
  id: string;
  uploadedBy: 'CUSTOMER' | 'VENDOR' | 'STAFF';
  fileUrl: string;
  fileType: string | null;
  caption: string | null;
  createdAt: string;
}

export interface DisputeEvent {
  type: DisputeEventType;
  actorRole: string;
  fromStatus: DisputeStatus | null;
  toStatus: DisputeStatus | null;
  note: string | null;
  createdAt: string;
}

export interface Dispute {
  id: string;
  status: DisputeStatus;
  reason: DisputeReason;
  description: string;
  package: {
    subOrderId: string;
    subOrderNumber: string;
    orderNumber: string;
    status: SubOrderStatus;
    vendorId: string;
    storeName: string;
    itemsSubtotal: string;
    shippingFee: string;
  };
  subOrderStatusAtOpen: SubOrderStatus;
  vendorResponse: { action: DisputeVendorAction; defenseNotes: string; respondedAt: string } | null;
  resolution: {
    outcome: DisputeStatus;
    notes: string | null;
    resolvedAt: string;
    decidedBy: 'VENDOR' | 'STAFF';
    refundAmount: string | null;
    itemReturned: boolean | null;
    restocked: boolean;
  } | null;
  cancelledAt: string | null;
  evidence: DisputeEvidence[];
  timeline: DisputeEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface DisputeHold {
  source: WalletBalanceBucket | null;
  amount: string;
  shortfall: string;
  unrecovered: string;
}

export interface VendorDispute extends Dispute {
  customerName: string;
  customerMobileMasked: string;
  hold: DisputeHold;
}

export interface DisputeParty {
  userId: string;
  name: string;
  mobile: string;
}

export interface AdminDisputeSummary extends Dispute {
  customer: DisputeParty;
  hold: DisputeHold;
}

export interface AdminDisputeDossier extends AdminDisputeSummary {
  order: {
    id: string;
    orderNumber: string;
    paymentStatus: ParentOrderPaymentStatus;
    paymentMethod: PaymentMethod;
    finalPayableAmount: string;
    createdAt: string;
  };
  items: Array<{ productTitle: string; sku: string; quantity: number; unitPrice: string; totalLineAmount: string }>;
  packageHistory: Array<{ fromStatus: SubOrderStatus | null; toStatus: SubOrderStatus; actorRole: string; note: string | null; createdAt: string }>;
  payments: Array<{
    id: string;
    gatewayName: string;
    paymentMethod: PaymentMethod;
    status: string;
    cashAmount: string;
    creditAmount: string;
    bankRrn: string | null;
    paidAt: string | null;
  }>;
  vendorWallet: {
    pendingBalance: string;
    withdrawableBalance: string;
    settlementHoldBalance: string;
    disputeHoldBalance: string;
    totalEarnedBalance: string;
    totalWithdrawnAmount: string;
  };
  vendorEarningsAmount: string;
}

export interface DisputeActionResult {
  dispute: Dispute;
  walletAction: 'FROZEN' | 'REFUNDED' | 'RELEASED_TO_WITHDRAWABLE' | 'RETURNED_TO_ESCROW' | 'NONE';
  subOrderStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
}

/* ─── Vendors ───────────────────────────────────────────────────────────── */

export interface VendorWalletSummary {
  pendingBalance: string;
  withdrawableBalance: string;
  totalEarnedBalance: string;
  updatedAt: string;
}

export interface VendorVerification {
  id: string;
  nationalIdCardUrl: string;
  businessLicenseUrl: string | null;
  bankAccountProofUrl: string | null;
  rejectionReason: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MediaAssetSummary {
  id: string;
  kind: 'IMAGE' | 'DOCUMENT';
  purpose: string;
  url: string;
  thumbnailUrl: string | null;
  isPublic: boolean;
  createdAt: string;
}

export interface VendorProfile {
  id: string;
  userId: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: string | null;
  status: VendorStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  wallet: VendorWalletSummary | null;
  verification: VendorVerification | null;
  mediaAssets: MediaAssetSummary[];
}

export interface RegisterVendorInput {
  storeName: string;
  storeSlug: string;
  instagramHandle?: string;
  bio?: string;
  bankIban: string;
  bankAccountHolder: string;
}

export interface VendorOwner {
  id: string;
  mobile: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
}

export interface VendorAdminSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  status: VendorStatus;
  verifiedAt: string | null;
  productCount: number;
  wallet: VendorWalletSummary | null;
  owner: VendorOwner;
  createdAt: string;
}

export interface VendorAuditEntry {
  id: string;
  action: string;
  entityName: string;
  entityId: string | null;
  actorId: string | null;
  actorName: string | null;
  ipAddress: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

export interface VendorAdminDetail extends VendorAdminSummary {
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: string | null;
  verifications: VendorVerification[];
  mediaAssets: MediaAssetSummary[];
  auditTrail: VendorAuditEntry[];
}

/* ─── Wallet & settlements ──────────────────────────────────────────────── */

export interface WalletSummary {
  pendingBalance: string;
  withdrawableBalance: string;
  settlementHoldBalance: string;
  disputeHoldBalance: string;
  totalEarnedBalance: string;
  totalWithdrawnAmount: string;
  currency: string;
}

export interface WalletTransaction {
  id: string;
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: string;
  balanceAfter: string;
  subOrderId: string | null;
  subOrderNumber: string | null;
  settlementRequestId: string | null;
  description: string | null;
  createdAt: string;
}

export interface SettlementRequest {
  id: string;
  vendorId: string;
  storeName: string;
  amount: string;
  targetIban: string;
  status: SettlementStatus;
  bankPayaReference: string | null;
  rejectionReason: string | null;
  processedAt: string | null;
  processedBy: { id: string; fullName: string | null } | null;
  createdAt: string;
}

/* ─── Admin financial ───────────────────────────────────────────────────── */

export interface FinancialOverview {
  currency: string;
  from: string | null;
  to: string | null;
  generatedAt: string;
  sales: {
    paidOrders: number;
    activePackages: number;
    gmv: string;
    shippingFees: string;
    collectedByGateway: string;
    fundedByCredit: string;
    installmentsCollected: string;
  };
  commission: { earned: string; pending: string; total: string };
  wallets: {
    escrowHeld: string;
    withdrawable: string;
    settlementHold: string;
    disputeHold: string;
    totalWithdrawn: string;
    ledgerConsistent: boolean;
    inconsistentWallets: number;
  };
  settlements: { pendingCount: number; pendingAmount: string; paidCount: number; paidAmount: string };
  paymentsRequiringManualRefund: number;
  disputes: {
    open: number;
    underArbitration: number;
    resolvedForBuyer: number;
    refundsOwedToCustomers: string;
    unrecoveredVendorEarnings: string;
  };
}
```

### `apps/frontend/src/lib/auth/access.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { can, canAccess, homeForRole, ruleFor, safeNextPath } from './access';
import { isAccessTokenFresh, readAccessClaims } from './session-core';

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload: object): string => `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;

describe('route access', () => {
  it('leaves storefront pages public', () => {
    for (const path of ['/', '/search', '/products/x', '/categories/y', '/cart', '/login', '/payment/result']) {
      expect(ruleFor(path)).toBeNull();
      expect(canAccess(path, null)).toBe(true);
    }
  });

  it('guards the role areas', () => {
    expect(canAccess('/customer/orders', 'CUSTOMER')).toBe(true);
    expect(canAccess('/customer/orders', 'VENDOR')).toBe(false);
    expect(canAccess('/customer/orders', null)).toBe(false);
    expect(canAccess('/checkout', 'CUSTOMER')).toBe(true);
    expect(canAccess('/vendor/dashboard', 'VENDOR')).toBe(true);
    expect(canAccess('/vendor/dashboard', 'CUSTOMER')).toBe(false);
    expect(canAccess('/vendor/register', 'CUSTOMER')).toBe(true);
    expect(canAccess('/admin/vendors', 'SUPPORT')).toBe(true);
    expect(canAccess('/admin/settlements', 'SUPPORT')).toBe(false);
    expect(canAccess('/admin/settlements', 'FINANCIAL_OFFICER')).toBe(true);
    expect(canAccess('/admin/disputes/1', 'FINANCIAL_OFFICER')).toBe(false);
    expect(canAccess('/admin', 'CUSTOMER')).toBe(false);
    // Prefix matching is segment-based.
    expect(ruleFor('/vendorship')).toBeNull();
  });

  it('sends each role to its own area', () => {
    expect(homeForRole('CUSTOMER')).toBe('/customer/orders');
    expect(homeForRole('VENDOR')).toBe('/vendor/dashboard');
    expect(homeForRole('FINANCIAL_OFFICER')).toBe('/admin/financial');
    for (const role of ['CUSTOMER', 'VENDOR', 'FINANCIAL_OFFICER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN'] as const) {
      expect(canAccess(homeForRole(role), role)).toBe(true);
    }
  });

  it('accepts only same-site relative post-login targets', () => {
    expect(safeNextPath('/checkout')).toBe('/checkout');
    expect(safeNextPath('//evil.example')).toBeNull();
    expect(safeNextPath('https://evil.example')).toBeNull();
    expect(safeNextPath('/\\evil')).toBeNull();
    expect(safeNextPath('/api/v1/auth/me')).toBeNull();
    expect(safeNextPath(null)).toBeNull();
  });

  it('maps staff capabilities like the backend guards', () => {
    expect(can('FINANCIAL_OFFICER', 'processSettlements')).toBe(true);
    expect(can('ADMIN', 'processSettlements')).toBe(false);
    expect(can('FINANCIAL_OFFICER', 'arbitrateDisputes')).toBe(false);
    expect(can('SUPPORT', 'reviewVendors')).toBe(false);
  });
});

describe('access token claims', () => {
  it('reads sub/role/exp without trusting anything else', () => {
    const claims = readAccessClaims(token({ sub: 'u1', role: 'VENDOR', exp: 2_000_000_000, typ: 'access' }));
    expect(claims).toEqual({ sub: 'u1', role: 'VENDOR', exp: 2_000_000_000 });
    expect(isAccessTokenFresh(claims, 1_000)).toBe(true);
    expect(isAccessTokenFresh(claims, 2_000_000_000)).toBe(false);
  });

  it('rejects refresh tokens, garbage and missing claims', () => {
    expect(readAccessClaims(token({ sub: 'u1', role: 'VENDOR', exp: 1, typ: 'refresh' }))).toBeNull();
    expect(readAccessClaims('not-a-jwt')).toBeNull();
    expect(readAccessClaims('a.b.c')).toBeNull();
    expect(readAccessClaims(token({ sub: 'u1' }))).toBeNull();
    expect(readAccessClaims(undefined)).toBeNull();
  });
});
```

### `apps/frontend/src/lib/auth/access.ts`

```ts
/**
 * Role-based routing: which area each role may open, and where each role
 * lands after signing in. Mirrors the backend's @Roles() guards so a user is
 * never shown a page whose API calls would all be refused. (The backend still
 * enforces every rule on its own.)
 */
import type { UserRole } from '../api/types';

interface RouteRule {
  prefix: string;
  roles: readonly UserRole[];
}

const ADMIN_READ: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
const FINANCE: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCIAL_OFFICER'];
const DISPUTE_STAFF: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
const ALL_STAFF: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCIAL_OFFICER', 'SUPPORT'];

/** Most specific prefix first. */
const RULES: readonly RouteRule[] = [
  { prefix: '/vendor/register', roles: ['CUSTOMER', 'VENDOR'] },
  { prefix: '/vendor', roles: ['VENDOR'] },
  { prefix: '/admin/vendors', roles: ADMIN_READ },
  { prefix: '/admin/products', roles: ADMIN_READ },
  { prefix: '/admin/financial', roles: FINANCE },
  { prefix: '/admin/settlements', roles: FINANCE },
  { prefix: '/admin/disputes', roles: DISPUTE_STAFF },
  { prefix: '/admin', roles: ALL_STAFF },
  { prefix: '/customer', roles: ['CUSTOMER'] },
  { prefix: '/checkout', roles: ['CUSTOMER'] },
];

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The rule protecting a path, or null for public pages. */
export function ruleFor(pathname: string): RouteRule | null {
  return RULES.find((rule) => matches(pathname, rule.prefix)) ?? null;
}

export function canAccess(pathname: string, role: UserRole | null | undefined): boolean {
  const rule = ruleFor(pathname);
  if (rule === null) {
    return true;
  }
  return role !== null && role !== undefined && rule.roles.includes(role);
}

/** Landing page of each role's own area. */
export function homeForRole(role: UserRole): string {
  switch (role) {
    case 'VENDOR':
      return '/vendor/dashboard';
    case 'FINANCIAL_OFFICER':
      return '/admin/financial';
    case 'SUPPORT':
      return '/admin/disputes';
    case 'ADMIN':
    case 'SUPER_ADMIN':
      return '/admin/vendors';
    case 'CUSTOMER':
    default:
      return '/customer/orders';
  }
}

/** Only same-site relative paths are accepted as post-login targets (no open redirects). */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/api/')) {
    return null;
  }
  return value;
}

/** Staff capabilities that differ from mere page access (backend @Roles on the mutation routes). */
export const CAPABILITIES = {
  reviewVendors: ['SUPER_ADMIN', 'ADMIN'],
  moderateProducts: ['SUPER_ADMIN', 'ADMIN'],
  processSettlements: ['SUPER_ADMIN', 'FINANCIAL_OFFICER'],
  arbitrateDisputes: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'],
} as const satisfies Record<string, readonly UserRole[]>;

export function can(role: UserRole | null | undefined, capability: keyof typeof CAPABILITIES): boolean {
  return role !== null && role !== undefined && (CAPABILITIES[capability] as readonly UserRole[]).includes(role);
}
```

### `apps/frontend/src/lib/auth/bff.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';

import type { AuthTokens, Cart } from '../api/types';
import {
  CART_COOKIE,
  backendApiUrl,
  clearedCartCookie,
  forwardingHeaders,
  sessionCookies,
  shouldUseSecureCookies,
  type CookieSpec,
} from './session-core';

/**
 * Helpers for the BFF route handlers under /api/session: they call the
 * backend, keep the tokens server-side and answer the browser with the user
 * only.
 */

export interface BackendResult {
  status: number;
  body: unknown;
}

export async function callBackendJson(request: NextRequest, path: string, init: { method: string; body?: unknown; accessToken?: string; cartToken?: string }): Promise<BackendResult> {
  const headers: Record<string, string> = { Accept: 'application/json', ...forwardingHeaders(request.headers) };
  if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (init.accessToken) {
    headers.Authorization = `Bearer ${init.accessToken}`;
  }
  if (init.cartToken) {
    headers['X-Cart-Token'] = init.cartToken;
  }
  try {
    const response = await fetch(backendApiUrl(path), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: 'no-store',
    });
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { message: text };
      }
    }
    return { status: response.status, body };
  } catch {
    return { status: 502, body: { statusCode: 502, error: 'Bad Gateway', message: 'سرور اصلی در دسترس نیست. کمی بعد دوباره تلاش کنید.' } };
  }
}

export function applyCookies(response: NextResponse, cookies: CookieSpec[]): NextResponse {
  for (const cookie of cookies) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  return response;
}

export function jsonResponse(status: number, body: unknown): NextResponse {
  return NextResponse.json(body ?? {}, { status, headers: { 'Cache-Control': 'no-store' } });
}

/**
 * Same-origin check for state-changing BFF calls (defence in depth on top of
 * SameSite=Lax cookies): a present Origin header must match the host the
 * browser used.
 */
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get('origin');
  if (!origin) {
    return true;
  }
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  try {
    return host !== null && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export const CROSS_SITE_BODY = { statusCode: 403, error: 'Forbidden', code: 'CROSS_SITE_REQUEST', message: 'درخواست از مبدأ دیگری ارسال شده است.' };

/**
 * Completes a login: writes the session cookies, merges the guest cart into
 * the account (backend POST /cart/merge) and drops the guest cart cookie.
 * The browser receives only the user.
 */
export async function completeLogin(request: NextRequest, tokens: AuthTokens): Promise<NextResponse> {
  const secure = shouldUseSecureCookies(request.headers, request.url);
  const cookies: CookieSpec[] = sessionCookies(tokens, secure);
  const guestCartToken = request.cookies.get(CART_COOKIE)?.value;
  let merge: { mergedLines: number; clampedLines: unknown[]; droppedLines: unknown[] } | null = null;
  if (guestCartToken) {
    const merged = await callBackendJson(request, 'cart/merge', { method: 'POST', accessToken: tokens.accessToken, cartToken: guestCartToken });
    if (merged.status < 300) {
      merge = (merged.body as { report: typeof merge; cart: Cart }).report;
    }
    // Merged (or refused as malformed): the guest cart cookie has done its job. On a
    // backend outage (5xx) it is kept so the next login can still merge it.
    if (merged.status < 500) {
      cookies.push(clearedCartCookie(secure));
    }
  }
  return applyCookies(jsonResponse(200, { user: tokens.user, cartMerge: merge }), cookies);
}
```

### `apps/frontend/src/lib/auth/session-core.ts`

```ts
/**
 * Session primitives shared by the middleware (Edge runtime), the BFF route
 * handlers and Server Components. No Node-only APIs here.
 *
 * Tokens never reach browser JavaScript: the BFF stores them in httpOnly
 * cookies and attaches `Authorization: Bearer …` server-side.
 */
import type { AuthTokens, UserRole } from '../api/types';

export const ACCESS_COOKIE = 'shopino_at';
export const REFRESH_COOKIE = 'shopino_rt';
/** Guest cart token (backend header X-Cart-Token), also httpOnly. */
export const CART_COOKIE = 'shopino_cart';
export const CART_COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Refresh a little before expiry so an in-flight request never carries a dying token. */
const EXPIRY_SKEW_SECONDS = 20;

export interface AccessClaims {
  sub: string;
  role: UserRole;
  exp: number;
}

function base64UrlDecode(segment: string): string {
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/**
 * Reads the claims of an access token WITHOUT verifying its signature.
 *
 * Used only for routing decisions (which dashboard to show, whether to
 * refresh). Authorisation is always enforced by the backend, which verifies
 * the signature and re-reads the user on every request — a forged cookie can
 * at most render an empty shell whose every API call answers 401/403.
 */
export function readAccessClaims(token: string | undefined | null): AccessClaims | null {
  if (!token) {
    return null;
  }
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1])) as Partial<AccessClaims> & { typ?: string };
    if (typeof payload.sub !== 'string' || typeof payload.role !== 'string' || typeof payload.exp !== 'number') {
      return null;
    }
    if (payload.typ !== undefined && payload.typ !== 'access') {
      return null;
    }
    return { sub: payload.sub, role: payload.role as UserRole, exp: payload.exp };
  } catch {
    return null;
  }
}

export function isAccessTokenFresh(claims: AccessClaims | null, nowSeconds = Math.floor(Date.now() / 1000)): claims is AccessClaims {
  return claims !== null && claims.exp - EXPIRY_SKEW_SECONDS > nowSeconds;
}

export interface CookieSpec {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: 'lax';
    secure: boolean;
    path: '/';
    maxAge: number;
  };
}

function spec(name: string, value: string, maxAge: number, secure: boolean): CookieSpec {
  return { name, value, options: { httpOnly: true, sameSite: 'lax', secure, path: '/', maxAge } };
}

/** Cookies to write after a login or a refresh. */
export function sessionCookies(tokens: Pick<AuthTokens, 'accessToken' | 'refreshToken' | 'expiresIn' | 'refreshExpiresIn'>, secure: boolean): CookieSpec[] {
  return [spec(ACCESS_COOKIE, tokens.accessToken, tokens.expiresIn, secure), spec(REFRESH_COOKIE, tokens.refreshToken, tokens.refreshExpiresIn, secure)];
}

/** Cookies that end the session (maxAge 0). */
export function clearedSessionCookies(secure: boolean): CookieSpec[] {
  return [spec(ACCESS_COOKIE, '', 0, secure), spec(REFRESH_COOKIE, '', 0, secure)];
}

export function cartCookie(token: string, secure: boolean): CookieSpec {
  return spec(CART_COOKIE, token, CART_COOKIE_MAX_AGE_SECONDS, secure);
}

export function clearedCartCookie(secure: boolean): CookieSpec {
  return spec(CART_COOKIE, '', 0, secure);
}

/**
 * `Secure` is set whenever the browser reached us over HTTPS (directly or via
 * a TLS-terminating proxy), and always in production.
 */
export function shouldUseSecureCookies(headers: Headers, url: string): boolean {
  if (process.env.NODE_ENV === 'production') {
    return true;
  }
  const forwardedProto = headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  return forwardedProto === 'https' || url.startsWith('https:');
}

/** Backend origin as seen from the Next.js server. */
export function backendOrigin(): string {
  const value = process.env.BACKEND_INTERNAL_URL?.trim();
  if (!value) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('BACKEND_INTERNAL_URL must be set for production deployments.');
    }
    return 'http://127.0.0.1:4000';
  }
  return value.replace(/\/+$/, '');
}

export function backendApiUrl(path: string): string {
  return `${backendOrigin()}/api/v1/${path.replace(/^\/+/, '')}`;
}

export function isAuthTokens(value: unknown): value is AuthTokens {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AuthTokens>;
  return (
    typeof candidate.accessToken === 'string' &&
    typeof candidate.refreshToken === 'string' &&
    typeof candidate.expiresIn === 'number' &&
    typeof candidate.refreshExpiresIn === 'number' &&
    typeof candidate.user === 'object'
  );
}

/**
 * Rotates the refresh token at the backend. Returns null when the session is
 * no longer valid (revoked, expired, reused) — the caller clears the cookies.
 */
export async function refreshAtBackend(refreshToken: string, forwarded: Headers): Promise<AuthTokens | null> {
  try {
    const response = await fetch(backendApiUrl('auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...forwardingHeaders(forwarded) },
      body: JSON.stringify({ refreshToken }),
      cache: 'no-store',
    });
    if (!response.ok) {
      return null;
    }
    const body: unknown = await response.json();
    return isAuthTokens(body) ? body : null;
  } catch {
    return null;
  }
}

/** Client identity headers the backend uses for rate limits and audit logs (trustProxy is on). */
export function forwardingHeaders(incoming: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  const forwardedFor = incoming.get('x-forwarded-for') ?? incoming.get('x-real-ip');
  if (forwardedFor) {
    result['X-Forwarded-For'] = forwardedFor;
  }
  const userAgent = incoming.get('user-agent');
  if (userAgent) {
    result['User-Agent'] = userAgent;
  }
  const language = incoming.get('accept-language');
  if (language) {
    result['Accept-Language'] = language;
  }
  return result;
}
```

### `apps/frontend/src/lib/currency.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { formatToman, rialsToToman, tomanToRials } from './currency';

describe('formatToman', () => {
  it('converts Rials to Toman with Persian digits and ٬ separators (TM example)', () => {
    expect(formatToman(35_000_000)).toBe('۳٬۵۰۰٬۰۰۰ تومان');
    expect(formatToman('35000000.00')).toBe('۳٬۵۰۰٬۰۰۰ تومان');
    expect(formatToman(35_000_000n)).toBe('۳٬۵۰۰٬۰۰۰ تومان');
  });

  it('handles zero, small and large amounts', () => {
    expect(formatToman('0.00')).toBe('۰ تومان');
    expect(formatToman(10)).toBe('۱ تومان');
    expect(formatToman(9_990)).toBe('۹۹۹ تومان');
    expect(formatToman(10_000)).toBe('۱٬۰۰۰ تومان');
    expect(formatToman('1234567890120.00')).toBe('۱۲۳٬۴۵۶٬۷۸۹٬۰۱۲ تومان');
    // Beyond Number.MAX_SAFE_INTEGER: string and bigint stay exact.
    expect(formatToman('90071992547409930')).toBe('۹٬۰۰۷٬۱۹۹٬۲۵۴٬۷۴۰٬۹۹۳ تومان');
  });

  it('keeps fractions of a Toman instead of rounding them away', () => {
    expect(formatToman(12_345)).toBe('۱٬۲۳۴٫۵ تومان');
    expect(formatToman('5.50')).toBe('۰٫۵۵ تومان');
    expect(formatToman('0.01')).toBe('۰٫۰۰۱ تومان');
    expect(formatToman(10.5)).toBe('۱٫۰۵ تومان');
  });

  it('formats negative (debit) amounts with a minus sign', () => {
    expect(formatToman('-2590000.00')).toBe('−۲۵۹٬۰۰۰ تومان');
  });

  it('can omit the unit', () => {
    expect(formatToman('35000000.00', { unit: false })).toBe('۳٬۵۰۰٬۰۰۰');
  });

  it('rejects values that are not amounts', () => {
    expect(() => formatToman('abc')).toThrow(TypeError);
    expect(() => formatToman('1.234')).toThrow(TypeError);
    expect(() => formatToman(Number.NaN)).toThrow(TypeError);
    expect(() => formatToman(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  });
});

describe('tomanToRials', () => {
  it('multiplies Toman by 10 (TM rule: send value × 10)', () => {
    expect(tomanToRials(3_500_000)).toBe(35_000_000);
    expect(tomanToRials('3500000')).toBe(35_000_000);
  });

  it('accepts Persian/Arabic digits and separators', () => {
    expect(tomanToRials('۳٬۵۰۰٬۰۰۰')).toBe(35_000_000);
    expect(tomanToRials('٣٥٠٠٠')).toBe(350_000);
    expect(tomanToRials('3,500,000')).toBe(35_000_000);
    expect(tomanToRials(' 12 500 ')).toBe(125_000);
  });

  it('accepts one fraction digit (1 Rial = 0.1 Toman)', () => {
    expect(tomanToRials('1234.5')).toBe(12_345);
    expect(tomanToRials('۱۲۳۴٫۵')).toBe(12_345);
    expect(tomanToRials(0.1)).toBe(1);
  });

  it('rejects empty, negative, malformed and oversized values', () => {
    expect(() => tomanToRials('')).toThrow(RangeError);
    expect(() => tomanToRials('-5')).toThrow(RangeError);
    expect(() => tomanToRials(-5)).toThrow(RangeError);
    expect(() => tomanToRials('12.34')).toThrow(RangeError);
    expect(() => tomanToRials('12a')).toThrow(RangeError);
    expect(() => tomanToRials(Number.NaN)).toThrow(RangeError);
    expect(() => tomanToRials('9'.repeat(20))).toThrow(RangeError);
  });

  it('round-trips with formatToman and rialsToToman', () => {
    for (const rials of [0, 10, 12_345, 35_000_000, 999_999_990]) {
      expect(tomanToRials(rialsToToman(rials))).toBe(rials);
      expect(formatToman(tomanToRials(rialsToToman(rials)))).toBe(formatToman(rials));
    }
  });
});

describe('rialsToToman', () => {
  it('produces a plain Toman string for editable inputs', () => {
    expect(rialsToToman('45000000.00')).toBe('4500000');
    expect(rialsToToman(12_345)).toBe('1234.5');
    expect(rialsToToman('-2590000.00')).toBe('-259000');
  });
});
```

### `apps/frontend/src/lib/currency.ts`

```ts
/**
 * The ONLY place where money changes unit (TM decision, Phase 10 — Option 1).
 *
 * - The API speaks Rial (IRR). Amounts arrive as decimal strings with two
 *   fraction digits ("35000000.00") and are sent as numbers of Rials.
 * - The UI speaks Toman (1 Toman = 10 Rials), always with Persian digits and
 *   the Persian thousands separator "٬": 35,000,000 IRR → "۳٬۵۰۰٬۰۰۰ تومان".
 *
 * Components never multiply or divide by 10 themselves: they call
 * {@link formatToman} to display, {@link tomanToRials} to submit, and
 * {@link rialsToToman} to prefill a Toman input from an API value.
 *
 * Arithmetic is exact (BigInt on hundredths of a Rial); binary floating point
 * never touches an amount on its way to the screen.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;
const THOUSANDS_SEPARATOR = '٬';
const DECIMAL_SEPARATOR = '٫';
const MINUS_SIGN = '−';
export const TOMAN_UNIT = 'تومان';

/** Rials per Toman. Exported for documentation/tests; components must not use it. */
export const RIALS_PER_TOMAN = 10;

export type MoneyInput = number | string | bigint;

export interface FormatTomanOptions {
  /** Append the "تومان" unit (default true). */
  unit?: boolean;
}

function toPersian(value: string): string {
  return value.replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Converts Persian (U+06F0…) and Arabic-Indic (U+0660…) digits to ASCII. */
function toAscii(value: string): string {
  return value
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
}

/**
 * Parses an API amount (Rials) into hundredths of a Rial.
 * Accepts "35000000", "35000000.5", "35000000.00", "-2590000.00", numbers and bigints.
 */
function toRialHundredths(amountInRials: MoneyInput): bigint {
  if (typeof amountInRials === 'bigint') {
    return amountInRials * 100n;
  }
  let text: string;
  if (typeof amountInRials === 'number') {
    if (!Number.isFinite(amountInRials)) {
      throw new TypeError(`formatToman: amount must be finite, got ${amountInRials}`);
    }
    text = Number.isInteger(amountInRials) ? amountInRials.toString() : amountInRials.toFixed(2);
  } else {
    text = amountInRials.trim();
  }
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new TypeError(`formatToman: not a Rial amount: "${String(amountInRials)}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const hundredths = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign ? -hundredths : hundredths;
}

/**
 * Formats a Rial amount from the API as Toman with Persian digits:
 * `formatToman('35000000.00')` → `"۳٬۵۰۰٬۰۰۰ تومان"`.
 *
 * Amounts that are not a whole number of Toman keep their fraction
 * (`"12345"` Rials → `"۱٬۲۳۴٫۵ تومان"`) instead of being silently rounded.
 */
export function formatToman(amountInRials: MoneyInput, options: FormatTomanOptions = {}): string {
  const hundredths = toRialHundredths(amountInRials);
  const negative = hundredths < 0n;
  const absolute = negative ? -hundredths : hundredths;
  // Toman × 1000 = Rial × 100, so the hundredths of a Rial are thousandths of a Toman.
  const whole = absolute / 1000n;
  const thousandths = absolute % 1000n;
  let text = groupThousands(whole.toString());
  if (thousandths > 0n) {
    text += DECIMAL_SEPARATOR + thousandths.toString().padStart(3, '0').replace(/0+$/, '');
  }
  text = toPersian(text);
  if (negative) {
    text = MINUS_SIGN + text;
  }
  return options.unit === false ? text : `${text} ${TOMAN_UNIT}`;
}

/**
 * Converts a Toman amount typed by a vendor/admin into the Rial number the API
 * expects: `tomanToRials('۳٬۵۰۰٬۰۰۰')` → `35000000`.
 *
 * Accepts Persian, Arabic-Indic or ASCII digits, thousands separators (٬ , or
 * spaces) and at most one fraction digit (0.1 Toman = 1 Rial). Negative,
 * empty, malformed and unsafe values throw a RangeError whose message can be
 * shown next to the field.
 */
export function tomanToRials(toman: number | string): number {
  let text: string;
  if (typeof toman === 'number') {
    if (!Number.isFinite(toman)) {
      throw new RangeError('مبلغ واردشده معتبر نیست.');
    }
    text = toman.toString();
  } else {
    text = toAscii(toman.trim())
      .replace(/[٬,\s]/g, '')
      .replace(DECIMAL_SEPARATOR, '.');
  }
  if (text === '') {
    throw new RangeError('مبلغ را وارد کنید.');
  }
  if (text.startsWith('-')) {
    throw new RangeError('مبلغ نمی‌تواند منفی باشد.');
  }
  const match = /^(\d+)(?:\.(\d))?$/.exec(text);
  if (!match) {
    throw new RangeError('مبلغ باید عدد تومان با حداکثر یک رقم اعشار باشد.');
  }
  const [, whole = '0', fraction = '0'] = match;
  const rials = BigInt(whole) * BigInt(RIALS_PER_TOMAN) + BigInt(fraction);
  if (rials > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('مبلغ بیش از حد بزرگ است.');
  }
  return Number(rials);
}

/**
 * Rial amount from the API → plain Toman string for an editable input
 * (ASCII digits, no separators): `rialsToToman('45000000.00')` → `"4500000"`.
 * Fractions of a Rial (never produced by the API for prices) are truncated.
 */
export function rialsToToman(amountInRials: MoneyInput): string {
  const hundredths = toRialHundredths(amountInRials);
  const negative = hundredths < 0n;
  const rials = (negative ? -hundredths : hundredths) / 100n;
  const whole = rials / BigInt(RIALS_PER_TOMAN);
  const tenth = rials % BigInt(RIALS_PER_TOMAN);
  const text = tenth === 0n ? whole.toString() : `${whole.toString()}.${tenth.toString()}`;
  return negative ? `-${text}` : text;
}
```

### `apps/frontend/src/lib/format.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { formatCount, formatDate, formatMobile, formatPercent, toLatinDigits, toPersianDigits } from './format';

describe('format helpers', () => {
  it('converts digits both ways', () => {
    expect(toPersianDigits('SHP-100000123')).toBe('SHP-۱۰۰۰۰۰۱۲۳');
    expect(toLatinDigits('۰۹۱۲۱۲۳۴۵۶۷')).toBe('09121234567');
    expect(toLatinDigits('٠٩١٢')).toBe('0912');
  });

  it('formats counts and percentages', () => {
    expect(formatCount(12_500)).toBe('۱۲٬۵۰۰');
    expect(formatPercent('9.00')).toBe('۹٪');
    expect(formatPercent('2.50')).toBe('۲٫۵٪');
    expect(formatPercent('abc')).toBe('—');
  });

  it('formats dates in the Solar Hijri calendar', () => {
    expect(formatDate('2026-09-28')).toContain('۱۴۰۵');
    expect(formatDate(null)).toBe('—');
    expect(formatDate('not a date')).toBe('—');
  });

  it('formats Iranian mobiles', () => {
    expect(formatMobile('+989121234567')).toBe('۰۹۱۲ ۱۲۳ ۴۵۶۷');
  });
});
```

### `apps/frontend/src/lib/format.ts`

```ts
/**
 * Non-monetary display helpers: Persian digits, counts, percentages and dates
 * (Solar Hijri calendar, Tehran time). Money goes through `currency.ts` only.
 */

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'] as const;

export function toPersianDigits(value: string | number): string {
  return String(value).replace(/[0-9]/g, (digit) => PERSIAN_DIGITS[Number(digit)] ?? digit);
}

/** Persian/Arabic-Indic digits → ASCII (for inputs such as mobile or postal code). */
export function toLatinDigits(value: string): string {
  return value
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660));
}

/** Integer count with Persian digits and ٬ grouping: 12500 → "۱۲٬۵۰۰". */
export function formatCount(value: number): string {
  return toPersianDigits(Math.trunc(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '٬'));
}

/** Percentage from an API decimal string or number: "9.00" → "۹٪", "2.5" → "۲٫۵٪". */
export function formatPercent(value: string | number): string {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return '—';
  }
  const text = Number.isInteger(numeric) ? numeric.toString() : numeric.toFixed(2).replace(/0+$/, '');
  return `${toPersianDigits(text).replace('.', '٫')}٪`;
}

const TIME_ZONE = 'Asia/Tehran';

const dateFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const dateTimeFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});

function toDate(value: string | Date): Date | null {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "2026-09-28T…" → "۶ مهر ۱۴۰۵". A plain calendar date ("2026-10-28") is read as that day. */
export function formatDate(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const normalised = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00Z` : value;
  const date = toDate(normalised);
  return date ? dateFormatter.format(date) : '—';
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) {
    return '—';
  }
  const date = toDate(value);
  return date ? dateTimeFormatter.format(date) : '—';
}

/** Iranian mobile in a readable, Persian-digit form: +989121234567 → "۰۹۱۲ ۱۲۳ ۴۵۶۷". */
export function formatMobile(mobile: string): string {
  const local = mobile.replace(/^\+98/, '0');
  const grouped = /^0\d{10}$/.test(local) ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : local;
  return toPersianDigits(grouped);
}
```

### `apps/frontend/src/lib/hooks/use-api.ts`

```ts
'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { apiGet, toQueryString, type Query } from '../api/client';
import { ApiError, toApiError } from '../api/errors';

export interface ApiState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True while the first response (or a response for new parameters) is pending. */
  loading: boolean;
  /** True while a background reload is running with data already on screen. */
  refreshing: boolean;
  reload: () => Promise<void>;
  /** Replace the cached data after a mutation that returned the new state. */
  setData: (data: T) => void;
}

/**
 * Live GET against the BFF with loading/error state. `path === null` pauses
 * the request (e.g. until a dependency is known). Responses for outdated
 * parameters are discarded, so fast typing never shows stale results.
 */
export function useApi<T>(path: string | null, query?: Query): ApiState<T> {
  const key = path === null ? null : `${path}${toQueryString(query)}`;
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(path !== null);
  const [refreshing, setRefreshing] = useState(false);
  const latestKey = useRef<string | null>(key);
  const queryRef = useRef(query);
  queryRef.current = query;

  const run = useCallback(
    async (background: boolean): Promise<void> => {
      if (path === null || key === null) {
        return;
      }
      latestKey.current = key;
      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      try {
        const result = await apiGet<T>(path, { query: queryRef.current });
        if (latestKey.current === key) {
          setData(result);
          setError(undefined);
        }
      } catch (caught) {
        if (latestKey.current === key) {
          setError(toApiError(caught));
        }
      } finally {
        if (latestKey.current === key) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [key, path],
  );

  useEffect(() => {
    if (key === null) {
      setLoading(false);
      return;
    }
    void run(false);
  }, [key, run]);

  const reload = useCallback(() => run(true), [run]);

  return { data, error, loading, refreshing, reload, setData };
}

/** Debounced copy of a value (instant search). */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface MutationState<TArgs extends unknown[], TResult> {
  run: (...args: TArgs) => Promise<TResult | undefined>;
  pending: boolean;
  error: ApiError | undefined;
  reset: () => void;
}

/**
 * Wraps a state-changing API call: tracks pending/error and never throws to
 * the caller (the error is exposed for display; the result is undefined).
 */
export function useMutation<TArgs extends unknown[], TResult>(action: (...args: TArgs) => Promise<TResult>): MutationState<TArgs, TResult> {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const actionRef = useRef(action);
  actionRef.current = action;

  const run = useCallback(async (...args: TArgs): Promise<TResult | undefined> => {
    setPending(true);
    setError(undefined);
    try {
      return await actionRef.current(...args);
    } catch (caught) {
      setError(toApiError(caught));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);

  const reset = useCallback(() => setError(undefined), []);
  return { run, pending, error, reset };
}
```

### `apps/frontend/src/lib/installments.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { previewInstallments, splitCreditPayment } from './installments';
import { addRials, compareRials, multiplyRials, shareOf, subtractRials } from './money';

describe('previewInstallments (mirror of backend installment-math)', () => {
  it('0% plan over 3 months splits the principal, remainder on the last instalment', () => {
    const preview = previewInstallments('10000001.00', '0.00', 3);
    expect(preview.totalInterest).toBe('0.00');
    expect(preview.totalPayable).toBe('10000001.00');
    expect(preview.lines.map((line) => line.totalAmount)).toEqual(['3333333.00', '3333333.00', '3333335.00']);
  });

  it('applies the whole-plan rate once and floors interest in the customer’s favour', () => {
    // 12,345,679 × 9% = 1,111,111.11 → 1,111,111
    const preview = previewInstallments(12_345_679, '9.00', 6);
    expect(preview.totalInterest).toBe('1111111.00');
    expect(preview.totalPayable).toBe('13456790.00');
    const principal = preview.lines.reduce((sum, line) => addRials(sum, line.principalAmount), '0');
    const interest = preview.lines.reduce((sum, line) => addRials(sum, line.interestAmount), '0');
    expect(principal).toBe('12345679.00');
    expect(interest).toBe('1111111.00');
    expect(preview.regularInstallment).toBe(addRials(preview.lines[0]!.principalAmount, preview.lines[0]!.interestAmount));
  });

  it('supports fractional rates', () => {
    expect(previewInstallments(1_000_000, '18.5', 12).totalInterest).toBe('185000.00');
  });

  it('rejects invalid input', () => {
    expect(() => previewInstallments(0, '0', 3)).toThrow();
    expect(() => previewInstallments('100.50', '0', 3)).toThrow();
    expect(() => previewInstallments(100, '0', 0)).toThrow();
    expect(() => previewInstallments(100, 'x', 3)).toThrow();
  });
});

describe('splitCreditPayment (mirror of backend splitPayment)', () => {
  it('BANK_CREDIT needs the whole amount', () => {
    expect(splitCreditPayment('BANK_CREDIT', '5000000.00', '5000000.00')).toEqual({ ok: true, creditAmount: '5000000.00', cashAmount: '0.00' });
    expect(splitCreditPayment('BANK_CREDIT', '5000000.00', '4999999.00')).toEqual({ ok: false, reason: 'INSUFFICIENT_CREDIT' });
  });

  it('HYBRID deducts the whole-Rial available credit and leaves the rest to the card', () => {
    expect(splitCreditPayment('HYBRID', '5000000.00', '1200000.75')).toEqual({ ok: true, creditAmount: '1200000.00', cashAmount: '3800000.00' });
    expect(splitCreditPayment('HYBRID', '5000000.00', '5000000.00')).toEqual({ ok: false, reason: 'HYBRID_NOT_REQUIRED' });
    expect(splitCreditPayment('HYBRID', '5000000.00', '0.50')).toEqual({ ok: false, reason: 'INSUFFICIENT_CREDIT' });
  });

  it('refuses non-whole payable amounts', () => {
    expect(splitCreditPayment('HYBRID', '5000000.50', '100.00')).toEqual({ ok: false, reason: 'AMOUNT_NOT_WHOLE_RIALS' });
  });
});

describe('money helpers', () => {
  it('compares, adds, subtracts and multiplies exactly', () => {
    expect(compareRials('0.10', 0.1)).toBe(0);
    expect(compareRials('10.00', '9.99')).toBe(1);
    expect(addRials('0.10', '0.20')).toBe('0.30');
    expect(subtractRials('100.00', '250.50')).toBe('-150.50');
    expect(multiplyRials('33333.33', 3)).toBe('99999.99');
  });

  it('computes clamped shares for progress bars', () => {
    expect(shareOf('250.00', '1000.00')).toBe(0.25);
    expect(shareOf('2000', '1000')).toBe(1);
    expect(shareOf('-5', '1000')).toBe(0);
    expect(shareOf('5', '0')).toBe(0);
  });
});
```

### `apps/frontend/src/lib/installments.ts`

```ts
/**
 * Client-side PREVIEW of the backend's instalment arithmetic, mirrored line
 * for line from `apps/backend/src/modules/credit/installment-math.ts` and
 * `credit-math.ts#splitPayment` (TM-approved Phase 8 "Option A"):
 *
 *   totalInterest = floor(creditAmount × interestRatePercent / 100)
 *   basePrincipal = floor(creditAmount / n), remainder → last instalment
 *   baseInterest  = floor(totalInterest / n), remainder → last instalment
 *
 * All values are whole Rials (strings in API format). The backend remains the
 * source of truth: the real schedule is created and returned by the API when
 * a credit payment is initiated. This module only lets the product page and
 * checkout show the same numbers beforehand.
 */
import { fromRialCents, toRialCents, type RialAmount } from './money';

export interface InstallmentPreviewLine {
  installmentNumber: number;
  principalAmount: string;
  interestAmount: string;
  totalAmount: string;
}

export interface InstallmentPreview {
  creditAmount: string;
  totalInterest: string;
  totalPayable: string;
  /** Amount of each regular instalment (the last one may be slightly larger). */
  regularInstallment: string;
  lines: InstallmentPreviewLine[];
}

/** "9.00" → 900n (hundredths of a percent). */
function percentToBasisPoints(percent: string | number): bigint {
  const text = typeof percent === 'number' ? percent.toFixed(2) : percent.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new TypeError(`Not a percentage: "${String(percent)}"`);
  }
  const [, whole = '0', fraction = ''] = match;
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
}

function wholeRials(amount: RialAmount): bigint {
  const cents = toRialCents(amount);
  if (cents % 100n !== 0n) {
    throw new TypeError('Credit amounts are whole Rials');
  }
  return cents / 100n;
}

const rials = (value: bigint): string => fromRialCents(value * 100n);

export function previewInstallments(creditAmount: RialAmount, interestRatePercent: string | number, durationMonths: number): InstallmentPreview {
  if (!Number.isInteger(durationMonths) || durationMonths < 1) {
    throw new TypeError('durationMonths must be a positive integer');
  }
  const credit = wholeRials(creditAmount);
  if (credit <= 0n) {
    throw new TypeError('creditAmount must be positive');
  }
  const n = BigInt(durationMonths);
  // floor(credit × bp / 10000) === floor(credit × percent / 100)
  const totalInterest = (credit * percentToBasisPoints(interestRatePercent)) / 10_000n;
  const basePrincipal = credit / n;
  const principalRemainder = credit - basePrincipal * n;
  const baseInterest = totalInterest / n;
  const interestRemainder = totalInterest - baseInterest * n;

  const lines: InstallmentPreviewLine[] = [];
  for (let k = 1; k <= durationMonths; k += 1) {
    const last = k === durationMonths;
    const principal = last ? basePrincipal + principalRemainder : basePrincipal;
    const interest = last ? baseInterest + interestRemainder : baseInterest;
    lines.push({ installmentNumber: k, principalAmount: rials(principal), interestAmount: rials(interest), totalAmount: rials(principal + interest) });
  }
  return {
    creditAmount: rials(credit),
    totalInterest: rials(totalInterest),
    totalPayable: rials(credit + totalInterest),
    regularInstallment: rials(basePrincipal + baseInterest),
    lines,
  };
}

export type CreditSplit =
  | { ok: true; creditAmount: string; cashAmount: string }
  | { ok: false; reason: 'INSUFFICIENT_CREDIT' | 'HYBRID_NOT_REQUIRED' | 'AMOUNT_NOT_WHOLE_RIALS' };

/** Mirror of the backend's `splitPayment` for BANK_CREDIT / HYBRID. */
export function splitCreditPayment(method: 'BANK_CREDIT' | 'HYBRID', payable: RialAmount, available: RialAmount): CreditSplit {
  const payableCents = toRialCents(payable);
  const availableCents = toRialCents(available);
  if (payableCents <= 0n || payableCents % 100n !== 0n) {
    return { ok: false, reason: 'AMOUNT_NOT_WHOLE_RIALS' };
  }
  if (method === 'BANK_CREDIT') {
    return availableCents >= payableCents
      ? { ok: true, creditAmount: fromRialCents(payableCents), cashAmount: '0.00' }
      : { ok: false, reason: 'INSUFFICIENT_CREDIT' };
  }
  if (availableCents >= payableCents) {
    return { ok: false, reason: 'HYBRID_NOT_REQUIRED' };
  }
  const creditCents = (availableCents / 100n) * 100n; // floor to whole Rials
  if (creditCents <= 0n) {
    return { ok: false, reason: 'INSUFFICIENT_CREDIT' };
  }
  return { ok: true, creditAmount: fromRialCents(creditCents), cashAmount: fromRialCents(payableCents - creditCents) };
}
```

### `apps/frontend/src/lib/iran.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { IRAN_MOBILE_PATTERN, IRAN_PROVINCES, POSTAL_CODE_PATTERN, isValidNationalCode, isValidSheba } from './iran';

describe('iran reference data & validators', () => {
  it('lists the 31 provinces', () => {
    expect(IRAN_PROVINCES).toHaveLength(31);
    expect(new Set(IRAN_PROVINCES).size).toBe(31);
  });

  it('validates postal codes and mobiles like the backend', () => {
    expect(POSTAL_CODE_PATTERN.test('1968913111')).toBe(true);
    expect(POSTAL_CODE_PATTERN.test('0968913111')).toBe(false);
    expect(POSTAL_CODE_PATTERN.test('196891311')).toBe(false);
    for (const mobile of ['09121234567', '+989121234567', '9121234567', '00989121234567']) {
      expect(IRAN_MOBILE_PATTERN.test(mobile)).toBe(true);
    }
    expect(IRAN_MOBILE_PATTERN.test('0812345678')).toBe(false);
  });

  it('checks national-code checksums', () => {
    expect(isValidNationalCode('0499370899')).toBe(true);
    expect(isValidNationalCode('0499370898')).toBe(false);
    expect(isValidNationalCode('1111111111')).toBe(false);
  });

  it('checks Sheba mod-97', () => {
    expect(isValidSheba('IR820540102680020817909002')).toBe(true);
    expect(isValidSheba('IR620540102680020817909001')).toBe(false);
    expect(isValidSheba('IR82054010268002081790900')).toBe(false);
  });
});
```

### `apps/frontend/src/lib/iran.ts`

```ts
/**
 * Geographic reference data (not business data): the 31 provinces of Iran,
 * used by the address form's province selector.
 */
export const IRAN_PROVINCES = [
  'آذربایجان شرقی',
  'آذربایجان غربی',
  'اردبیل',
  'اصفهان',
  'البرز',
  'ایلام',
  'بوشهر',
  'تهران',
  'چهارمحال و بختیاری',
  'خراسان جنوبی',
  'خراسان رضوی',
  'خراسان شمالی',
  'خوزستان',
  'زنجان',
  'سمنان',
  'سیستان و بلوچستان',
  'فارس',
  'قزوین',
  'قم',
  'کردستان',
  'کرمان',
  'کرمانشاه',
  'کهگیلویه و بویراحمد',
  'گلستان',
  'گیلان',
  'لرستان',
  'مازندران',
  'مرکزی',
  'هرمزگان',
  'همدان',
  'یزد',
] as const;

/** Same rule as the backend (POSTAL_CODE_PATTERN): 10 digits, not starting with 0. */
export const POSTAL_CODE_PATTERN = /^[1-9][0-9]{9}$/;

/** Iranian mobile in any common form: 09xxxxxxxxx, 9xxxxxxxxx, +989xxxxxxxxx, 00989xxxxxxxxx. */
export const IRAN_MOBILE_PATTERN = /^(?:\+98|0098|98|0)?9\d{9}$/;

/** Iranian national code checksum (same algorithm the backend validates). */
export function isValidNationalCode(value: string): boolean {
  if (!/^\d{10}$/.test(value) || /^(\d)\1{9}$/.test(value)) {
    return false;
  }
  const digits = value.split('').map(Number);
  const check = digits[9]!;
  const sum = digits.slice(0, 9).reduce((total, digit, index) => total + digit * (10 - index), 0);
  const remainder = sum % 11;
  return remainder < 2 ? check === remainder : check === 11 - remainder;
}

/** Sheba (IBAN) format + ISO 13616 mod-97 check. */
export function isValidSheba(value: string): boolean {
  const iban = value.replace(/\s+/g, '').toUpperCase();
  if (!/^IR\d{24}$/.test(iban)) {
    return false;
  }
  const rearranged = `${iban.slice(4)}${iban.slice(0, 4)}`.replace(/[A-Z]/g, (letter) => String(letter.charCodeAt(0) - 55));
  let remainder = 0;
  for (const char of rearranged) {
    remainder = (remainder * 10 + Number(char)) % 97;
  }
  return remainder === 1;
}
```

### `apps/frontend/src/lib/labels.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import { CREDIT_DECISION_REASON, creditDecisionReason } from './labels';

describe('creditDecisionReason', () => {
  it('maps every provider decision code the backend emits to Persian', () => {
    for (const code of ['SCORE_BELOW_THRESHOLD', 'NOT_ELIGIBLE', 'BELOW_MINIMUM_LIMIT', 'CAPPED_AT_MAXIMUM']) {
      expect(CREDIT_DECISION_REASON[code]).toBeDefined();
      expect(creditDecisionReason(code)).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it('never shows a raw code for unknown reasons', () => {
    const text = creditDecisionReason('SOME_FUTURE_CODE');
    expect(text).not.toContain('SOME_FUTURE_CODE');
    expect(text).toMatch(/[\u0600-\u06FF]/);
  });
});
```

### `apps/frontend/src/lib/labels.ts`

```ts
import type {
  CreditAccountStatus,
  CreditApplicationStatus,
  DisputeEventType,
  DisputeReason,
  DisputeStatus,
  InstallmentStatus,
  ParentOrderPaymentStatus,
  PaymentMethod,
  PaymentOutcome,
  ProductSort,
  SettlementStatus,
  SubOrderStatus,
  UserRole,
  VendorStatus,
  WalletBalanceBucket,
  WalletTransactionType,
} from './api/types';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'مدیر ارشد',
  ADMIN: 'مدیر',
  VENDOR: 'فروشنده',
  CUSTOMER: 'مشتری',
  FINANCIAL_OFFICER: 'کارشناس مالی',
  SUPPORT: 'پشتیبانی',
};

export const SUB_ORDER_STATUS: Record<SubOrderStatus, { label: string; tone: Tone }> = {
  PENDING_APPROVAL: { label: 'در انتظار تأیید فروشنده', tone: 'warning' },
  PROCESSING: { label: 'در حال آماده‌سازی', tone: 'info' },
  SHIPPED: { label: 'ارسال شده', tone: 'brand' },
  DELIVERED: { label: 'تحویل شده', tone: 'success' },
  CANCELLED: { label: 'لغو شده', tone: 'neutral' },
  REFUNDED: { label: 'مرجوع/بازپرداخت شده', tone: 'danger' },
};

export const PAYMENT_STATUS: Record<ParentOrderPaymentStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'در انتظار پرداخت', tone: 'warning' },
  PAID: { label: 'پرداخت شده', tone: 'success' },
  FAILED: { label: 'پرداخت ناموفق', tone: 'danger' },
  CANCELLED: { label: 'لغو شده', tone: 'neutral' },
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH_IPG: 'پرداخت آنلاین (درگاه بانکی)',
  BANK_CREDIT: 'اعتبار بانکی (اقساطی)',
  HYBRID: 'ترکیبی (اعتبار + درگاه)',
};

export const PAYMENT_OUTCOME: Record<PaymentOutcome, { label: string; tone: Tone; description: string }> = {
  PAID: { label: 'پرداخت موفق', tone: 'success', description: 'سفارش شما ثبت و پرداخت شد و برای فروشندگان ارسال شد.' },
  FAILED: { label: 'پرداخت ناموفق', tone: 'danger', description: 'پرداخت انجام نشد. اگر مبلغی از حساب شما کسر شده باشد، طبق مقررات شاپرک حداکثر ظرف ۷۲ ساعت برمی‌گردد.' },
  VERIFICATION_PENDING: { label: 'در انتظار تأیید بانک', tone: 'warning', description: 'نتیجهٔ پرداخت هنوز از بانک دریافت نشده است. وضعیت سفارش را چند دقیقهٔ دیگر بررسی کنید.' },
  PAID_REQUIRES_REFUND: { label: 'پرداخت دیرهنگام', tone: 'warning', description: 'پرداخت پس از پایان مهلت سفارش انجام شد؛ مبلغ توسط واحد مالی به حساب شما بازگردانده می‌شود.' },
};

export const VENDOR_STATUS: Record<VendorStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'در انتظار بررسی', tone: 'warning' },
  APPROVED: { label: 'تأیید شده', tone: 'success' },
  REJECTED: { label: 'رد شده', tone: 'danger' },
  SUSPENDED: { label: 'معلق', tone: 'neutral' },
};

export const SETTLEMENT_STATUS: Record<SettlementStatus, { label: string; tone: Tone }> = {
  REQUESTED: { label: 'ثبت شده', tone: 'warning' },
  PROCESSING: { label: 'در حال پردازش', tone: 'info' },
  PAID_PAYA: { label: 'واریز شده (پایا)', tone: 'success' },
  REJECTED: { label: 'رد شده', tone: 'danger' },
};

export const WALLET_BUCKET_LABELS: Record<WalletBalanceBucket, string> = {
  PENDING: 'در انتظار (امانی)',
  WITHDRAWABLE: 'قابل برداشت',
  SETTLEMENT_HOLD: 'در انتظار تسویه',
  DISPUTE_HOLD: 'مسدود بابت اختلاف',
};

export const WALLET_TX_LABELS: Record<WalletTransactionType, string> = {
  CREDIT_SALE_ESCROW_HOLD: 'فروش (نگهداری امانی)',
  ESCROW_RELEASE_TO_WITHDRAWABLE: 'آزادسازی پس از تحویل',
  COMMISSION_DEDUCTION: 'کسر کارمزد',
  SETTLEMENT_PAYOUT: 'واریز تسویه',
  REFUND_DEDUCTION: 'کسر بابت مرجوعی',
  SETTLEMENT_HOLD: 'انتقال به درخواست تسویه',
  SETTLEMENT_HOLD_RELEASE: 'بازگشت از تسویهٔ ردشده',
  DISPUTE_HOLD_LOCK: 'مسدودی بابت اختلاف',
  DISPUTE_HOLD_RELEASE: 'رفع مسدودی اختلاف',
};

export const CREDIT_ACCOUNT_STATUS: Record<CreditAccountStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'فعال', tone: 'success' },
  FROZEN: { label: 'مسدود', tone: 'danger' },
  CLOSED: { label: 'بسته شده', tone: 'neutral' },
};

/** Provider decision codes (CreditApplication.decisionReason) → Persian. Unknown codes fall back to a generic text. */
export const CREDIT_DECISION_REASON: Record<string, string> = {
  SCORE_BELOW_THRESHOLD: 'امتیاز اعتباری شما کمتر از حد لازم بانک است.',
  NOT_ELIGIBLE: 'در حال حاضر واجد شرایط دریافت اعتبار نیستید.',
  BELOW_MINIMUM_LIMIT: 'مبلغ درخواستی کمتر از حداقل مبلغ قابل ارائهٔ بانک است.',
  CAPPED_AT_MAXIMUM: 'اعتبار تا سقف مجاز بانک تأیید شد.',
};

export function creditDecisionReason(code: string): string {
  return CREDIT_DECISION_REASON[code] ?? 'بانک دلیل دیگری برای این تصمیم اعلام کرده است.';
}

export const CREDIT_APPLICATION_STATUS: Record<CreditApplicationStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'پیش‌نویس', tone: 'neutral' },
  PENDING_BANK_INQUIRY: { label: 'در انتظار استعلام بانک', tone: 'warning' },
  DOCS_REQUIRED: { label: 'نیاز به مدارک تکمیلی', tone: 'warning' },
  APPROVED: { label: 'تأیید شده', tone: 'success' },
  REJECTED: { label: 'رد شده', tone: 'danger' },
};

export const INSTALLMENT_STATUS: Record<InstallmentStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'سررسید نشده', tone: 'neutral' },
  PAID: { label: 'پرداخت شده', tone: 'success' },
  OVERDUE: { label: 'معوق', tone: 'danger' },
  WAIVED: { label: 'بخشوده', tone: 'info' },
};

export const DISPUTE_REASON_LABELS: Record<DisputeReason, string> = {
  WRONG_ITEM: 'کالای اشتباه ارسال شده',
  DAMAGED: 'کالا آسیب دیده است',
  NOT_AS_DESCRIBED: 'مغایرت با توضیحات',
  NOT_DELIVERED: 'کالا به دستم نرسیده',
  COUNTERFEIT: 'کالا تقلبی است',
};

export const DISPUTE_STATUS: Record<DisputeStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'باز — در انتظار پاسخ فروشنده', tone: 'warning' },
  VENDOR_RESPONDED: { label: 'پاسخ فروشنده ثبت شد', tone: 'info' },
  UNDER_ARBITRATION: { label: 'در حال داوری', tone: 'brand' },
  RESOLVED_BUYER_FAVOR: { label: 'رأی به نفع خریدار', tone: 'success' },
  RESOLVED_VENDOR_FAVOR: { label: 'رأی به نفع فروشنده', tone: 'danger' },
  CANCELLED: { label: 'لغو شده توسط خریدار', tone: 'neutral' },
};

export const DISPUTE_EVENT_LABELS: Record<DisputeEventType, string> = {
  OPENED: 'ثبت اختلاف',
  EVIDENCE_ADDED: 'افزودن مدرک',
  VENDOR_ACCEPTED_RETURN: 'پذیرش مرجوعی توسط فروشنده',
  VENDOR_DEFENDED: 'دفاعیهٔ فروشنده',
  ARBITRATED_BUYER_FAVOR: 'رأی داور به نفع خریدار',
  ARBITRATED_VENDOR_FAVOR: 'رأی داور به نفع فروشنده',
  CANCELLED_BY_CUSTOMER: 'لغو توسط خریدار',
  REFUND_NOTICE_SENT: 'اطلاع‌رسانی بازپرداخت',
  REFUND_NOTICE_FAILED: 'خطا در اطلاع‌رسانی بازپرداخت',
};

export const SORT_LABELS: Record<ProductSort, string> = {
  newest: 'جدیدترین',
  price_asc: 'ارزان‌ترین',
  price_desc: 'گران‌ترین',
  popular: 'پرفروش‌ترین',
};

export const TIMELINE_EVENT_LABELS: Record<string, string> = {
  ORDER_PLACED: 'ثبت سفارش',
  PAYMENT_CONFIRMED: 'تأیید پرداخت',
  ORDER_CANCELLED: 'لغو سفارش',
  PAYMENT_FAILED: 'پرداخت ناموفق',
  SUB_ORDER_STATUS: 'تغییر وضعیت مرسوله',
};

/** Forward progress of a package, for the order timeline stepper. */
export const PACKAGE_STEPS: readonly SubOrderStatus[] = ['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED', 'DELIVERED'];
```

### `apps/frontend/src/lib/money.ts`

```ts
/**
 * Exact arithmetic on Rial amounts as the API sends them ("35000000.00").
 * Values stay in Rials here — unit conversion for display lives in
 * `currency.ts` only. Everything works on BigInt hundredths of a Rial so no
 * float rounding can creep into comparisons or totals.
 */

export type RialAmount = string | number | bigint;

/** Hundredths of a Rial. */
export function toRialCents(amount: RialAmount): bigint {
  if (typeof amount === 'bigint') {
    return amount * 100n;
  }
  const text = typeof amount === 'number' ? (Number.isInteger(amount) ? amount.toString() : amount.toFixed(2)) : amount.trim();
  const match = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new TypeError(`Not a Rial amount: "${String(amount)}"`);
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  return sign ? -cents : cents;
}

/** Back to the API's string form ("35000000.00"). */
export function fromRialCents(cents: bigint): string {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const text = `${(absolute / 100n).toString()}.${(absolute % 100n).toString().padStart(2, '0')}`;
  return negative ? `-${text}` : text;
}

/** -1, 0 or 1. */
export function compareRials(a: RialAmount, b: RialAmount): number {
  const left = toRialCents(a);
  const right = toRialCents(b);
  return left === right ? 0 : left < right ? -1 : 1;
}

export function isPositiveAmount(amount: RialAmount): boolean {
  return toRialCents(amount) > 0n;
}

export function addRials(...amounts: RialAmount[]): string {
  return fromRialCents(amounts.reduce<bigint>((sum, amount) => sum + toRialCents(amount), 0n));
}

export function subtractRials(a: RialAmount, b: RialAmount): string {
  return fromRialCents(toRialCents(a) - toRialCents(b));
}

/**
 * Share of `part` in `total`, clamped to 0…1 (progress bars, credit usage).
 * Returns 0 when total is not positive.
 */
export function shareOf(part: RialAmount, total: RialAmount): number {
  const whole = toRialCents(total);
  if (whole <= 0n) {
    return 0;
  }
  const piece = toRialCents(part);
  if (piece <= 0n) {
    return 0;
  }
  if (piece >= whole) {
    return 1;
  }
  // Scale to basis points in BigInt first, then a small safe division.
  return Number((piece * 10_000n) / whole) / 10_000;
}

/** Line total preview: unit price × quantity. */
export function multiplyRials(amount: RialAmount, quantity: number): string {
  if (!Number.isInteger(quantity)) {
    throw new TypeError('quantity must be an integer');
  }
  return fromRialCents(toRialCents(amount) * BigInt(quantity));
}
```

### `apps/frontend/src/lib/product-form.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import type { CategoryTreeNode } from '@/lib/api/types';

import { SKU_PATTERN, buildVariantMatrix, duplicateSkus, emptyVariantRow, flattenCategories, suggestSku, variantRowToInput } from './product-form';

const defaults = { priceToman: '1200000', compareToman: '', stock: '5', skuPrefix: 'tshirt' };

describe('buildVariantMatrix', () => {
  it('builds colour × size rows with SKUs that pass the backend pattern', () => {
    const rows = buildVariantMatrix(
      [
        { name: 'Black', hex: '#111111' },
        { name: 'آبی', hex: '#1d4ed8' },
      ],
      ['M', 'L'],
      defaults,
    );
    expect(rows).toHaveLength(4);
    expect(rows.map((row) => row.sku)).toEqual(['TSHIRT-BLACK-M', 'TSHIRT-BLACK-L', 'TSHIRT-C2-M', 'TSHIRT-C2-L']);
    expect(rows[2]?.colorHex).toBe('#1D4ED8');
    for (const row of rows) expect(SKU_PATTERN.test(row.sku)).toBe(true);
  });

  it('collapses missing dimensions', () => {
    expect(buildVariantMatrix([], ['S', 'M', 'L'], defaults)).toHaveLength(3);
    expect(buildVariantMatrix([], [], defaults)).toHaveLength(1);
  });
});

describe('suggestSku', () => {
  it('falls back for non-Latin prefixes', () => {
    expect(suggestSku('تیشرت', 0, '', '')).toBe('SKU');
  });
});

describe('variantRowToInput', () => {
  it('converts Toman to Rials and normalises SKU/hex', () => {
    const result = variantRowToInput(emptyVariantRow({ sku: 'ab-1', colorName: 'Red', colorHex: '#ff0000', size: 'XL', priceToman: '۱۲۰٬۰۰۰', compareToman: '150000', stock: '3' }));
    expect(result).toEqual({ ok: true, value: { sku: 'AB-1', colorName: 'Red', colorHex: '#FF0000', size: 'XL', price: 1_200_000, compareAtPrice: 1_500_000, stockQuantity: 3 } });
  });

  it('rejects a compare price that is not above the price', () => {
    const result = variantRowToInput(emptyVariantRow({ sku: 'A1', priceToman: '100', compareToman: '100', stock: '1' }));
    expect(result.ok).toBe(false);
  });

  it('rejects invalid SKUs and stock', () => {
    expect(variantRowToInput(emptyVariantRow({ sku: '-bad', priceToman: '100', stock: '1' })).ok).toBe(false);
    expect(variantRowToInput(emptyVariantRow({ sku: 'OK1', priceToman: '100', stock: '1.5' })).ok).toBe(false);
  });
});

describe('duplicateSkus', () => {
  it('is case-insensitive', () => {
    expect(duplicateSkus([emptyVariantRow({ sku: 'a1' }), emptyVariantRow({ sku: 'A1' }), emptyVariantRow({ sku: 'B' })])).toEqual(['A1']);
  });
});

describe('flattenCategories', () => {
  it('indents children', () => {
    const node = (id: string, children: CategoryTreeNode[] = []): CategoryTreeNode => ({ id, slug: id, titleFa: id, titleEn: null, parentId: null, defaultCommissionRate: '0', sortOrder: 0, depth: 0, productCount: 0, totalProductCount: 0, children });
    expect(flattenCategories([node('a', [node('b')])]).map((option) => option.label)).toEqual(['a', '— b']);
  });
});
```

### `apps/frontend/src/lib/product-form.ts`

```ts
import type { CategoryTreeNode, CreateVariantInput } from '@/lib/api/types';
import { tomanToRials } from '@/lib/currency';
import { toLatinDigits } from '@/lib/format';

/** Mirrors backend product-rules.ts. */
export const SKU_PATTERN = /^[A-Z0-9](?:[A-Z0-9._-]{0,62}[A-Z0-9])?$/;
export const COLOR_HEX_PATTERN = /^#[0-9A-F]{6}$/;
export const MAX_VARIANTS_PER_PRODUCT = 100;
export const MAX_MEDIA_PER_PRODUCT = 12;
export const MAX_STOCK = 1_000_000;
export const PRODUCT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Editable variant row: money fields are Toman text as typed. */
export interface VariantRow {
  key: string;
  colorName: string;
  colorHex: string;
  size: string;
  priceToman: string;
  compareToman: string;
  stock: string;
  sku: string;
}

export interface ColorChoice {
  name: string;
  hex: string;
}

let rowCounter = 0;
export function newRowKey(): string {
  rowCounter += 1;
  return `row-${rowCounter}`;
}

export function emptyVariantRow(defaults: Partial<VariantRow> = {}): VariantRow {
  return { key: newRowKey(), colorName: '', colorHex: '', size: '', priceToman: '', compareToman: '', stock: '0', sku: '', ...defaults };
}

/** Upper-case Latin token for SKUs ("Navy Blue" → "NAVY-BLUE"; non-Latin text → fallback). */
function skuToken(value: string, fallback: string): string {
  const token = toLatinDigits(value)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 16);
  return token || fallback;
}

/** Suggested SKU: PREFIX-COLOR-SIZE, always matching SKU_PATTERN. */
export function suggestSku(prefix: string, colorIndex: number, color: string, size: string): string {
  const parts = [skuToken(prefix, 'SKU').slice(0, 20)];
  if (color) parts.push(skuToken(color, `C${colorIndex + 1}`));
  if (size) parts.push(skuToken(size, 'S'));
  return parts.join('-').slice(0, 64).replace(/[-._]+$/g, '');
}

/**
 * Colour × size matrix. Empty colour or size lists collapse that dimension, so
 * sizes only, colours only and both all work. Price/stock defaults fill every row.
 */
export function buildVariantMatrix(colors: ColorChoice[], sizes: string[], defaults: { priceToman: string; compareToman: string; stock: string; skuPrefix: string }): VariantRow[] {
  const colorList: Array<ColorChoice | null> = colors.length ? colors : [null];
  const sizeList: Array<string | null> = sizes.length ? sizes : [null];
  const rows: VariantRow[] = [];
  colorList.forEach((color, colorIndex) => {
    for (const size of sizeList) {
      rows.push(
        emptyVariantRow({
          colorName: color?.name ?? '',
          colorHex: color?.hex.toUpperCase() ?? '',
          size: size ?? '',
          priceToman: defaults.priceToman,
          compareToman: defaults.compareToman,
          stock: defaults.stock,
          sku: suggestSku(defaults.skuPrefix, colorIndex, color?.name ?? '', size ?? ''),
        }),
      );
    }
  });
  return rows;
}

export type RowResult = { ok: true; value: CreateVariantInput } | { ok: false; error: string };

/** Validates one row and converts it to the API payload (Rials, upper-case SKU/hex). */
export function variantRowToInput(row: VariantRow): RowResult {
  const sku = row.sku.trim().toUpperCase();
  if (!SKU_PATTERN.test(sku)) return { ok: false, error: `SKU «${row.sku || '—'}» معتبر نیست (حروف لاتین بزرگ، رقم، . _ -).` };
  const hex = row.colorHex.trim().toUpperCase();
  if (hex && !COLOR_HEX_PATTERN.test(hex)) return { ok: false, error: `کد رنگ ${sku} باید به شکل ‎#RRGGBB باشد.` };
  if (hex && !row.colorName.trim()) return { ok: false, error: `برای رنگ ${sku} نام رنگ را وارد کنید.` };
  if (row.colorName.trim().length > 40) return { ok: false, error: `نام رنگ ${sku} حداکثر ۴۰ نویسه است.` };
  if (row.size.trim().length > 20) return { ok: false, error: `سایز ${sku} حداکثر ۲۰ نویسه است.` };
  let price: number;
  let compareAtPrice: number | null = null;
  try {
    price = tomanToRials(row.priceToman);
    if (row.compareToman.trim()) compareAtPrice = tomanToRials(row.compareToman);
  } catch (caught) {
    return { ok: false, error: `${sku}: ${caught instanceof Error ? caught.message : 'مبلغ نامعتبر'}` };
  }
  if (price <= 0) return { ok: false, error: `قیمت ${sku} باید بیشتر از صفر باشد.` };
  if (compareAtPrice !== null && compareAtPrice <= price) return { ok: false, error: `قیمت قبل از تخفیف ${sku} باید بیشتر از قیمت فروش باشد.` };
  const stockText = toLatinDigits(row.stock.trim());
  const stock = Number(stockText);
  if (!/^\d+$/.test(stockText) || stock > MAX_STOCK) return { ok: false, error: `موجودی ${sku} باید عدد صحیح بین ۰ و ۱٬۰۰۰٬۰۰۰ باشد.` };
  return {
    ok: true,
    value: {
      sku,
      colorName: row.colorName.trim() || null,
      colorHex: hex || null,
      size: row.size.trim() || null,
      price,
      compareAtPrice,
      stockQuantity: stock,
    },
  };
}

/** Duplicate SKUs inside the form (the backend also rejects duplicates across the store). */
export function duplicateSkus(rows: VariantRow[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const sku = row.sku.trim().toUpperCase();
    if (!sku) continue;
    if (seen.has(sku)) duplicates.add(sku);
    seen.add(sku);
  }
  return [...duplicates];
}

export interface CategoryOption {
  id: string;
  label: string;
  depth: number;
}

/** Depth-first flattening of the category tree for a <select>, indented by depth. */
export function flattenCategories(nodes: CategoryTreeNode[], depth = 0): CategoryOption[] {
  return nodes.flatMap((node) => [{ id: node.id, label: `${'— '.repeat(depth)}${node.titleFa}`, depth }, ...flattenCategories(node.children, depth + 1)]);
}
```

### `apps/frontend/src/middleware.ts`

```ts
import { NextResponse, type NextRequest } from 'next/server';

import { homeForRole, ruleFor } from './lib/auth/access';
import {
  ACCESS_COOKIE,
  REFRESH_COOKIE,
  clearedSessionCookies,
  isAccessTokenFresh,
  readAccessClaims,
  refreshAtBackend,
  sessionCookies,
  shouldUseSecureCookies,
  type CookieSpec,
} from './lib/auth/session-core';

/**
 * Runs before every page render:
 *
 * 1. **Silent refresh.** When the access cookie is missing/expiring but a
 *    refresh cookie exists, the refresh token is rotated at the backend and
 *    the new cookies are written to the response AND injected into the
 *    current request, so Server Components of this very render already see a
 *    valid token.
 * 2. **Route protection.** `/customer/*`, `/checkout`, `/vendor/*` and
 *    `/admin/*` require a session with an allowed role (see lib/auth/access):
 *    anonymous → /login?next=…, wrong role → /forbidden.
 *
 * The role is read from the access token's claims for routing only; the
 * backend verifies the signature and the role again on every API call.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  const secure = shouldUseSecureCookies(request.headers, request.url);

  let claims = readAccessClaims(request.cookies.get(ACCESS_COOKIE)?.value);
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  let cookiesToWrite: CookieSpec[] = [];

  if (!isAccessTokenFresh(claims)) {
    claims = null;
    if (refreshToken) {
      const tokens = await refreshAtBackend(refreshToken, request.headers);
      if (tokens) {
        claims = readAccessClaims(tokens.accessToken);
        cookiesToWrite = sessionCookies(tokens, secure);
        request.cookies.set(ACCESS_COOKIE, tokens.accessToken);
        request.cookies.set(REFRESH_COOKIE, tokens.refreshToken);
      } else {
        cookiesToWrite = clearedSessionCookies(secure);
        request.cookies.delete(ACCESS_COOKIE);
        request.cookies.delete(REFRESH_COOKIE);
      }
    }
  }

  const rule = ruleFor(pathname);
  let response: NextResponse;

  if (rule && !claims) {
    const login = new URL('/login', request.url);
    login.searchParams.set('next', `${pathname}${search}`);
    response = NextResponse.redirect(login);
  } else if (rule && claims && !rule.roles.includes(claims.role)) {
    const forbidden = new URL('/forbidden', request.url);
    forbidden.searchParams.set('from', pathname);
    forbidden.searchParams.set('home', homeForRole(claims.role));
    response = NextResponse.redirect(forbidden);
  } else if (pathname === '/login' && claims) {
    // Already signed in: go to the requested page or the role's own area.
    const next = request.nextUrl.searchParams.get('next');
    const target = next && next.startsWith('/') && !next.startsWith('//') ? next : homeForRole(claims.role);
    response = NextResponse.redirect(new URL(target, request.url));
  } else {
    response = NextResponse.next({ request: { headers: request.headers } });
  }

  for (const cookie of cookiesToWrite) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }
  // Pages that depend on the session must never be served from a shared cache.
  if (rule) {
    response.headers.set('Cache-Control', 'private, no-store');
  }
  return response;
}

export const config = {
  // Pages only: the BFF (/api/*) refreshes on its own, static assets need no session.
  matcher: ['/((?!api/|_next/static|_next/image|favicon.ico|fonts/|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)'],
};
```

### `apps/frontend/vitest.config.ts`

```ts
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Same `@/*` → `src/*` mapping as tsconfig paths.
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
```

## 12. Complete source — backend changes and new tests

### `.env.example`

```bash
# ============================================================================
# Shopino — environment template
# ----------------------------------------------------------------------------
# Copy to `.env` and fill in real values:      cp .env.example .env
# `.env` is git-ignored and must never be committed.
#
# The values below are DEVELOPMENT placeholders. They are safe only on a local
# machine and MUST be replaced before any shared or production deployment.
# The backend refuses to boot in production when a required secret is missing
# (see apps/backend/src/config/env.validation.ts).
# ============================================================================

# ─── Runtime ────────────────────────────────────────────────────────────────
# development | test | production
NODE_ENV=development
# Public port of the backend API.
PORT=4000
# Bind address. 0.0.0.0 is required inside containers and remote dev sandboxes;
# use 127.0.0.1 to restrict the API to the local machine.
HOST=0.0.0.0
# Comma-separated list of browser origins allowed to call the API (CORS).
# In development, localhost and *.e2b.app preview origins are additionally
# allowed automatically; production uses exactly this list.
CORS_ORIGINS=http://localhost:3000
# error | warn | log | debug | verbose
LOG_LEVEL=debug

# ─── PostgreSQL 16 (docker-compose service: postgres) ───────────────────────
POSTGRES_USER=shopino
POSTGRES_PASSWORD=replace-with-a-strong-password
POSTGRES_DB=shopino_db
POSTGRES_PORT=5432

# Prisma runtime connection (application queries).
# In production this points at the pooled endpoint (PgBouncer / managed pooler).
DATABASE_URL=postgresql://shopino:replace-with-a-strong-password@127.0.0.1:5432/shopino_db?schema=public&connection_limit=10&pool_timeout=20
# Prisma migration/introspection connection. Must bypass the pooler; identical
# to DATABASE_URL when no pooler is used.
DIRECT_URL=postgresql://shopino:replace-with-a-strong-password@127.0.0.1:5432/shopino_db?schema=public

# ─── Redis 7 (docker-compose service: redis) ───────────────────────────────
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_PASSWORD=replace-with-a-strong-password
# Logical database index (0-15).
REDIS_DB=0

# ─── Authentication (JWT) ──────────────────────────────────────────────────
# REQUIRED: the API signs real tokens, so it refuses to start when either secret
# is empty or shorter than 32 characters — in every environment, development
# included. A missing secret is a service that cannot authenticate anyone.
# Generate with:  openssl rand -base64 48
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=

# Token lifetimes. The access token is deliberately short-lived and stateless;
# the refresh token is persistent and tracked server-side in Redis so it can be
# revoked instantly. Both accept the `30s`/`15m`/`12h`/`7d` shorthand.
JWT_ACCESS_TTL=15m
JWT_REFRESH_TTL=7d

# ─── OTP policy ────────────────────────────────────────────────────────────
# Validity of a generated login code, and how many digits it has.
OTP_TTL_SECONDS=120
OTP_LENGTH=5
# Minimum delay between two code requests for the same number.
OTP_REQUEST_COOLDOWN_SECONDS=120
# Wrong codes tolerated before the number is locked, and for how long.
OTP_MAX_VERIFY_ATTEMPTS=5
OTP_LOCK_SECONDS=900
# Ceilings per rolling hour: per number, and per client IP (the second one stops
# an attacker from enumerating many numbers from a single host).
OTP_MAX_REQUESTS_PER_HOUR=5
OTP_MAX_REQUESTS_PER_IP_PER_HOUR=20

# ─── Password login policy ─────────────────────────────────────────────────
# Failed attempts tolerated per identifier (e-mail or mobile) before it is
# locked for AUTH_LOCK_SECONDS. Counted in Redis, so it holds across instances.
AUTH_MAX_LOGIN_ATTEMPTS=5
AUTH_LOCK_SECONDS=900

# ─── SMS provider ──────────────────────────────────────────────────────────
# sandbox    → development/test provider: prints the code to the log and keeps
#              the last 50 dispatches in memory. NEVER delivers a real message,
#              and the API refuses to boot with it when NODE_ENV=production.
# kavenegar  → production provider: real delivery through the Kavenegar HTTP API
#              (verify/lookup for OTP, sms/send for transactional). Requires the
#              three credentials below; a missing one fails the boot.
SMS_PROVIDER=sandbox

# Only meaningful for the sandbox provider: print the generated code so a
# developer can complete the login flow locally. Keep it false on any shared host.
SMS_SANDBOX_LOG_CODES=true

# Kavenegar credentials (production). The API key travels in the request path of
# the gateway, so treat it as a secret: never commit it, inject it from the
# secret manager, and rotate it if it ever leaves one.
SMS_KAVENEGAR_API_KEY=
# Sender line number configured in the Kavenegar panel.
SMS_KAVENEGAR_SENDER=
# Name of the approved "lookup" template used for login codes.
SMS_KAVENEGAR_OTP_TEMPLATE=

# ─── File storage (Phase 4) ────────────────────────────────────────────────
# `local` writes uploads to STORAGE_LOCAL_ROOT on this host and serves them
# through the API (development default). `s3` talks to any S3-compatible object
# store: AWS S3, ArvanCloud, Liara, MinIO. Selection happens at boot inside
# StorageModule, so no business code branches on it.
STORAGE_PROVIDER=local
# Uploads root for the local provider (relative to the backend app directory).
STORAGE_LOCAL_ROOT=uploads
# Base URL stored objects are published under. The default points at the API's
# own file route; set it to a CDN origin in production.
STORAGE_PUBLIC_BASE_URL=/api/v1/media/files

# S3 settings — only read when STORAGE_PROVIDER=s3, and the API refuses to boot
# with `s3` selected while the bucket or the keys are missing.
S3_ENDPOINT=
S3_REGION=ir-thr-at1
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
# Path-style addressing (endpoint/bucket/key). Required by ArvanCloud and Liara;
# AWS deprecated it, so set false when talking to AWS directly.
S3_FORCE_PATH_STYLE=true
# CDN/custom domain in front of the bucket. Empty falls back to endpoint/bucket.
S3_PUBLIC_BASE_URL=

# ─── Media limits (Phase 4) ────────────────────────────────────────────────
# Ceiling for an uploaded image and document, in bytes.
MEDIA_MAX_IMAGE_BYTES=5242880
MEDIA_MAX_DOCUMENT_BYTES=10485760

# ─── Seed master data (apps/backend/prisma/seed.ts) ────────────────────────
# Credentials of the super-admin account created by `pnpm db:seed`.
# The seed never invents credentials: it fails when these are missing.
# REQUIRED IN PRODUCTION: replace the development values before deploying.
# Password policy: at least 12 characters. Generate with: openssl rand -base64 24
SUPER_ADMIN_EMAIL=admin@shopino.local
SUPER_ADMIN_PASSWORD=
# Display name stored on the super-admin account.
SUPER_ADMIN_FULL_NAME=مدیر ارشد پلتفرم
# Set to true only when the admin password must be rotated deliberately;
# the seed never overwrites an existing password otherwise.
SEED_RESET_ADMIN_PASSWORD=false
# Dev/test password for the seeded staff accounts (support + financial officer).
# REQUIRED IN PRODUCTION: replace before deploying; dev value may be generated
# with: openssl rand -base64 24
SEED_STAFF_PASSWORD=
# Dev/test password for the owner account of the sample vendor shop.
SEED_VENDOR_PASSWORD=

# ─── Frontend (Next.js) ────────────────────────────────────────────────────
# Base URL the browser uses for API calls. Relative, so requests hit the
# Next.js origin and are proxied server-side (no CORS, works behind one domain).
NEXT_PUBLIC_API_BASE_URL=/api/v1
# Internal URL the Next.js server uses to reach the backend (rewrites and
# server-side rendering). Never exposed to the browser.
BACKEND_INTERNAL_URL=http://127.0.0.1:4000
# Comma-separated extra origins allowed to load Next.js dev assets
# (remote dev sandboxes / tunnels). Production builds ignore this.
NEXT_ALLOWED_DEV_ORIGINS=

# ─── Commerce: shipping & order lifecycle (Phase 6) ─────────────────────────
# Amounts are in the platform currency (system_configs platform.currency = IRR, rial).
# These are fallbacks: system_configs keys shipping.default_fee_per_vendor and
# shipping.free_threshold_per_vendor take precedence; a store's own
# shippingFeeOverride / freeShippingThreshold take precedence over both.
# 500000 IRR = 50,000 toman · 10000000 IRR = 1,000,000 toman. 0 threshold = never free.
SHIPPING_DEFAULT_FEE_PER_VENDOR=500000
SHIPPING_FREE_THRESHOLD_PER_VENDOR=10000000
# Unpaid orders release their stock reservation after this many minutes.
ORDER_PAYMENT_TIMEOUT_MINUTES=30
# Expiry sweeper period in seconds (0 disables it on this instance).
ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=60

# ─── Payments (Phase 7) ────────────────────────────────────────────────────
# Origin the customer's browser and the bank reach this API on (no path). The
# gateway callback is ${PUBLIC_API_ORIGIN}/api/v1/payments/callback.
# With the Next.js frontend (Phase 10) this is the FRONTEND origin: its /api/v1
# BFF forwards to the backend, so the bank page, the callback and the result
# page all live on the one origin the browser already has cookies for.
PUBLIC_API_ORIGIN=http://localhost:3000
# `sandbox` = built-in simulated bank page (development/test ONLY; the API
# refuses to boot with it in production). `zarinpal` = Zarinpal IPG v4.
PAYMENT_GATEWAY_PROVIDER=sandbox
# Required when PAYMENT_GATEWAY_PROVIDER=zarinpal. Never commit a real value.
ZARINPAL_MERCHANT_ID=
# https://payment.zarinpal.com (live) or https://sandbox.zarinpal.com (Zarinpal test host).
ZARINPAL_API_BASE_URL=https://payment.zarinpal.com
# Timeout of one gateway API call, in milliseconds.
PAYMENT_GATEWAY_TIMEOUT_MS=15000
# Frontend result page; empty = the callback answers with JSON. The storefront
# page is /payment/result (query: orderNumber, outcome, paymentId, parentOrderId, rrn).
PAYMENT_RESULT_REDIRECT_URL=/payment/result
# An INITIATED payment protects its order from the expiry sweeper this long.
PAYMENT_CALLBACK_GRACE_MINUTES=20

# ─── Phase 8: BNPL instalments ───────────────────────────────────────────────
# How often due instalments are marked OVERDUE (seconds; 0 disables the timer).
INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=3600
```

### `apps/backend/src/modules/payments/payments.controller.spec.ts`

```ts
import { ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus } from '@prisma/client';

import type { PaymentOutcomeDto } from './dto/payment.dto';
import { buildResultRedirectQuery } from './payments.controller';

const outcome = (overrides: Partial<PaymentOutcomeDto> = {}): PaymentOutcomeDto => ({
  outcome: 'PAID',
  paymentId: '0b8c7d4e-1111-4222-8333-444455556666',
  paymentStatus: PaymentStatus.SUCCESSFUL,
  parentOrderId: '6f1e2d3c-aaaa-4bbb-8ccc-ddddeeeeffff',
  orderNumber: 'SHP-100000123',
  orderPaymentStatus: ParentOrderPaymentStatus.PAID,
  bankRrn: '123456789012',
  message: 'ok',
  canRetry: false,
  paymentExpiresAt: null,
  purpose: PaymentPurpose.ORDER_CHECKOUT,
  paymentMethod: PaymentMethod.CASH_IPG,
  cashAmount: '1000000.00',
  creditAmount: '0.00',
  installmentScheduleId: null,
  ...overrides,
});

describe('buildResultRedirectQuery', () => {
  it('carries order number, outcome, payment id, order id, purpose and the bank RRN', () => {
    const query = buildResultRedirectQuery(outcome());
    expect(Object.fromEntries(query)).toEqual({
      orderNumber: 'SHP-100000123',
      outcome: 'PAID',
      paymentId: '0b8c7d4e-1111-4222-8333-444455556666',
      parentOrderId: '6f1e2d3c-aaaa-4bbb-8ccc-ddddeeeeffff',
      purpose: 'ORDER_CHECKOUT',
      rrn: '123456789012',
    });
  });

  it('marks instalment repayments so the result page does not judge them by the (already paid) order', () => {
    expect(buildResultRedirectQuery(outcome({ purpose: PaymentPurpose.INSTALLMENT_REPAYMENT })).get('purpose')).toBe('INSTALLMENT_REPAYMENT');
  });

  it('omits rrn when the bank returned none (failed or cancelled payment)', () => {
    const query = buildResultRedirectQuery(outcome({ outcome: 'FAILED', bankRrn: null }));
    expect(query.has('rrn')).toBe(false);
    expect(query.get('outcome')).toBe('FAILED');
  });

  it('URL-encodes values', () => {
    expect(buildResultRedirectQuery(outcome({ bankRrn: 'A&B=C' })).toString()).toContain('rrn=A%26B%3DC');
  });
});
```

### `apps/backend/src/modules/payments/payments.controller.ts`

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import type { EnvironmentVariables } from '../../config/env.validation';
import { SkipAudit } from '../audit/audit.decorator';
import { InitiatePaymentDto, InitiatePaymentResponseDto, PaymentOutcomeDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

const CALLBACK_DESCRIPTION =
  'Where the bank sends the customer’s browser after the payment page (Zarinpal: `Authority` + `Status=OK|NOK`). ' +
  'The redirect parameters are never trusted: the payment is verified server-to-server with the gateway for the stored amount. ' +
  'On success the order becomes PAID in one transaction (stock committed, each store’s earnings held in escrow, packages visible to ' +
  'vendors as PENDING_APPROVAL, Payment SUCCESSFUL with the bank RRN). On failure the Payment becomes FAILED and the order stays ' +
  'PENDING with its stock reserved, so the customer can retry until the payment window closes. Repeated callbacks return the same ' +
  'outcome without a second verification. Answers JSON, or a 303 redirect to PAYMENT_RESULT_REDIRECT_URL when that is configured ' +
  '(query: orderNumber, outcome, paymentId, parentOrderId and rrn when the bank returned one).';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly resultRedirectUrl: string | null;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.resultRedirectUrl = config.get<string | undefined>('PAYMENT_RESULT_REDIRECT_URL') ?? null;
  }

  @Post('initiate')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth('access-token')
  @SkipAudit() // audited inside the transaction that creates the payment
  @ApiOperation({
    summary: 'Start paying an unpaid order',
    description:
      'Creates an INITIATED payment for the order’s payable amount and opens a session with the active gateway. ' +
      'Redirect the customer to `redirectUrl`. Allowed while the order is PENDING and inside its payment window; ' +
      'after a failed attempt a new one can be initiated.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: InitiatePaymentResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiNotFoundResponse({ description: 'Unknown order or not the caller’s' })
  @ApiConflictResponse({ description: 'ORDER_NOT_PAYABLE (already paid, cancelled or failed) or ORDER_PAYMENT_EXPIRED' })
  @ApiTooManyRequestsResponse({ description: 'Too many open payment attempts for this order' })
  @ApiResponse({ status: HttpStatus.BAD_GATEWAY, description: 'GATEWAY_UNAVAILABLE: the gateway refused or could not be reached' })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiatePaymentDto,
    @ClientContext() context: RequestContext,
  ): Promise<InitiatePaymentResponseDto> {
    return this.payments.initiate(user.id, dto.parentOrderId, { actorId: user.id, context });
  }

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Bank callback (GET)', description: CALLBACK_DESCRIPTION })
  @ApiQuery({ name: 'Authority', required: true, description: 'Gateway session token' })
  @ApiQuery({ name: 'Status', required: false, enum: ['OK', 'NOK'] })
  @ApiOkResponse({ type: PaymentOutcomeDto })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to PAYMENT_RESULT_REDIRECT_URL?orderNumber=…&outcome=…&paymentId=… (when configured)' })
  @ApiBadRequestResponse({ description: 'INVALID_CALLBACK: no payment token' })
  @ApiNotFoundResponse({ description: 'Unknown payment token' })
  async callbackGet(
    @Query() query: Record<string, unknown>,
    @ClientContext() context: RequestContext,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.respond(reply, await this.payments.handleCallback(query, { actorId: null, context }));
  }

  @Post('callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the settlement transaction
  @ApiOperation({ summary: 'Bank callback (POST, form or JSON body)', description: CALLBACK_DESCRIPTION })
  @ApiOkResponse({ type: PaymentOutcomeDto })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to PAYMENT_RESULT_REDIRECT_URL (when configured)' })
  @ApiBadRequestResponse({ description: 'INVALID_CALLBACK: no payment token' })
  @ApiNotFoundResponse({ description: 'Unknown payment token' })
  async callbackPost(
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown> | undefined,
    @ClientContext() context: RequestContext,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const params = { ...query, ...(typeof body === 'object' && body !== null ? body : {}) };
    await this.respond(reply, await this.payments.handleCallback(params, { actorId: null, context }));
  }

  private async respond(reply: FastifyReply, outcome: PaymentOutcomeDto): Promise<void> {
    void reply.header('Cache-Control', 'no-store');
    if (this.resultRedirectUrl) {
      const separator = this.resultRedirectUrl.includes('?') ? '&' : '?';
      const query = buildResultRedirectQuery(outcome);
      await reply.status(HttpStatus.SEE_OTHER).header('Location', `${this.resultRedirectUrl}${separator}${query.toString()}`).send();
      return;
    }
    await reply.status(HttpStatus.OK).send(outcome);
  }
}

/**
 * Query string of the storefront result page. It carries only what the
 * customer already sees on the bank page (order number, outcome, payment id,
 * the bank's retrieval reference number) plus the order id for the "track my
 * order" link, and the purpose (checkout vs instalment repayment) — the result page re-reads the order itself before trusting it.
 */
export function buildResultRedirectQuery(outcome: PaymentOutcomeDto): URLSearchParams {
  const query = new URLSearchParams({
    orderNumber: outcome.orderNumber,
    outcome: outcome.outcome,
    paymentId: outcome.paymentId,
    parentOrderId: outcome.parentOrderId,
    purpose: outcome.purpose,
  });
  if (outcome.bankRrn !== null) {
    query.set('rrn', outcome.bankRrn);
  }
  return query;
}
```

### `apps/backend/src/modules/products/catalog-search.service.ts`

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { visibleProductSql, visibleProductWhere } from '../categories/catalog-visibility';
import { CategoriesService } from '../categories/categories.service';
import { CategorySummaryDto } from '../categories/dto/category-response.dto';
import { escapeLikePattern, searchTermVariants } from './catalog-text';
import type { ProductSort, PublicProductQueryDto } from './dto/product-query.dto';
import type { PublicProductDetailDto, PublicProductListItemDto } from './dto/product-response.dto';
import { COLOR_HEX_PATTERN } from './product-rules';
import {
  imageRef,
  maxDiscountPercent,
  startingCompareAtPrice,
  mediaSelect,
  priceRange,
  toPublicVariant,
  variantOptions,
  variantSelect,
  type VariantRow,
} from './product-views';

/** Sub-orders in these states did not result in a sale and do not count as "popular". */
const NON_SALE_STATUSES = Prisma.sql`('CANCELLED', 'REFUNDED')`;

const listingSelect = {
  id: true,
  slug: true,
  title: true,
  brand: true,
  createdAt: true,
  category: { select: { id: true, slug: true, titleFa: true, titleEn: true } },
  vendor: { select: { storeName: true, storeSlug: true, logoUrl: true } },
  variants: { where: { isActive: true }, select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 1 },
} satisfies Prisma.ProductSelect;

/**
 * Public catalogue discovery.
 *
 * The listing is one parameterised SQL statement (plus a COUNT with the same
 * predicate) so that every filter is evaluated by PostgreSQL on indexed columns:
 *
 * - text search: `ILIKE '%term%'` on title / brand / description, served by the
 *   pg_trgm GIN indexes (`products_*_trgm_idx`); each term is also tried with
 *   ASCII and Persian digits;
 * - variant filters (price range, stock, colours, sizes) must hold for the
 *   **same** active variant — "red, size L, under 1,000,000" never matches a
 *   product whose only red variant is size M;
 * - category filters include every descendant, resolved from the cached tree;
 * - sorting: newest, lowest matching price asc/desc, or units sold.
 *
 * Only ids come back from the SQL; the page is then hydrated through Prisma
 * with the same visibility predicate, so the response shape is typed end to end.
 */
@Injectable()
export class CatalogSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
  ) {}

  async search(query: PublicProductQueryDto): Promise<{ items: PublicProductListItemDto[]; total: number }> {
    if (query.categorySlug !== undefined && query.categoryId !== undefined) {
      throw new BadRequestException('Use either categorySlug or categoryId, not both');
    }
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
      throw new BadRequestException('minPrice must not be greater than maxPrice');
    }

    const categoryIds = await this.scopeCategoryIds(query);
    if (categoryIds.length === 0) {
      return { items: [], total: 0 };
    }

    const where = this.buildWhere(query, categoryIds);
    const variantMatch = this.buildVariantMatch(query);
    const needsSales = query.sortBy === 'popular';

    const from = Prisma.sql`
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      JOIN LATERAL (
        SELECT MIN(pv.price) AS min_price
          FROM product_variants pv
         WHERE ${variantMatch}
      ) mv ON mv.min_price IS NOT NULL`;

    const sales = needsSales
      ? Prisma.sql`
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(oi.quantity), 0)::int AS sold
          FROM order_items oi
          JOIN product_variants sv ON sv.id = oi.product_variant_id
          JOIN sub_orders so ON so.id = oi.sub_order_id
         WHERE sv.product_id = p.id AND so.status NOT IN ${NON_SALE_STATUSES}
      ) sales ON true`
      : Prisma.empty;

    const [pageRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT p.id
        ${from}
        ${sales}
        WHERE ${where}
        ORDER BY ${orderBy(query.sortBy)}
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS total
        ${from}
        WHERE ${where}`),
    ]);

    const total = countRows[0]?.total ?? 0;
    const ids = pageRows.map((row) => row.id);
    if (ids.length === 0) {
      return { items: [], total };
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, ...visibleProductWhere() },
      select: listingSelect,
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    const items = ids
      .map((id) => byId.get(id))
      .filter((product): product is NonNullable<typeof product> => product !== undefined)
      .map((product): PublicProductListItemDto => {
        const options = variantOptions(product.variants);
        return {
          id: product.id,
          slug: product.slug,
          title: product.title,
          brand: product.brand,
          primaryImage: imageRef(product.media[0]),
          priceRange: priceRange(product.variants) ?? { min: '0.00', max: '0.00' },
          maxDiscountPercent: maxDiscountPercent(product.variants),
          startingCompareAtPrice: startingCompareAtPrice(product.variants),
          colors: options.colors,
          sizes: options.sizes,
          inStock: product.variants.some(hasStock),
          vendor: product.vendor,
          category: CategorySummaryDto.from(product.category),
          createdAt: product.createdAt,
        };
      });

    return { items, total };
  }

  /** A publicly visible product by slug, with live stock. 404 otherwise. */
  async getBySlug(slug: string): Promise<PublicProductDetailDto> {
    const visibleIds = await this.categories.visibleCategoryIds();
    const product = await this.prisma.product.findFirst({
      where: { slug, ...visibleProductWhere(), categoryId: { in: visibleIds } },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        brand: true,
        categoryId: true,
        createdAt: true,
        updatedAt: true,
        vendor: {
          select: { storeName: true, storeSlug: true, logoUrl: true, bio: true, instagramHandle: true, verifiedAt: true },
        },
        variants: { where: { isActive: true }, select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
        media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
      },
    });
    if (!product) {
      throw new NotFoundException(`Product "${slug}" was not found`);
    }

    const breadcrumbs = await this.categories.breadcrumbFor(product.categoryId);
    const options = variantOptions(product.variants);

    return {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      brand: product.brand,
      breadcrumbs: breadcrumbs.map((node) => CategorySummaryDto.from(node)),
      vendor: product.vendor,
      media: product.media.map((media) => ({ url: media.url, thumbnailUrl: media.thumbnailUrl })),
      variants: product.variants.map((variant) => toPublicVariant(variant)),
      priceRange: priceRange(product.variants) ?? { min: '0.00', max: '0.00' },
      maxDiscountPercent: maxDiscountPercent(product.variants),
      colors: options.colors,
      sizes: options.sizes,
      inStock: product.variants.some(hasStock),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------

  private async scopeCategoryIds(query: PublicProductQueryDto): Promise<string[]> {
    if (query.categorySlug !== undefined || query.categoryId !== undefined) {
      const subtree = await this.categories.visibleSubtreeIds({
        ...(query.categorySlug !== undefined ? { slug: query.categorySlug.trim().toLowerCase() } : {}),
        ...(query.categoryId !== undefined ? { id: query.categoryId } : {}),
      });
      return subtree ?? [];
    }
    return this.categories.visibleCategoryIds();
  }

  private buildWhere(query: PublicProductQueryDto, categoryIds: string[]): Prisma.Sql {
    const conditions: Prisma.Sql[] = [visibleProductSql(), Prisma.sql`p.category_id = ANY(${categoryIds}::uuid[])`];

    if (query.vendorSlug !== undefined) {
      conditions.push(Prisma.sql`v.store_slug = ${query.vendorSlug.trim().toLowerCase()}`);
    }

    if (query.search !== undefined) {
      const patterns = searchTermVariants(query.search).map((term) => `%${escapeLikePattern(term)}%`);
      if (patterns.length > 0) {
        // One ILIKE per column and pattern (not ILIKE ANY): the planner turns an
        // OR of simple ILIKEs into a BitmapOr over the trigram GIN indexes.
        const matches = patterns.flatMap((pattern) => [
          Prisma.sql`p.title ILIKE ${pattern}`,
          Prisma.sql`p.brand ILIKE ${pattern}`,
          Prisma.sql`p.description ILIKE ${pattern}`,
        ]);
        conditions.push(Prisma.sql`(${Prisma.join(matches, ' OR ')})`);
      }
    }

    return Prisma.join(conditions, ' AND ');
  }

  /** Predicate over `product_variants pv` for the variant a product must have. */
  private buildVariantMatch(query: PublicProductQueryDto): Prisma.Sql {
    const conditions: Prisma.Sql[] = [Prisma.sql`pv.product_id = p.id`, Prisma.sql`pv.is_active = true`];

    if (query.minPrice !== undefined) {
      conditions.push(Prisma.sql`pv.price >= ${query.minPrice.toFixed(2)}::numeric`);
    }
    if (query.maxPrice !== undefined) {
      conditions.push(Prisma.sql`pv.price <= ${query.maxPrice.toFixed(2)}::numeric`);
    }
    if (query.inStockOnly === true) {
      conditions.push(Prisma.sql`pv.stock_quantity - pv.reserved_quantity > 0`);
    }
    if (query.colors !== undefined && query.colors.length > 0) {
      const hexes = query.colors.map((color) => color.toUpperCase()).filter((color) => COLOR_HEX_PATTERN.test(color));
      const names = query.colors
        .filter((color) => !COLOR_HEX_PATTERN.test(color.toUpperCase()))
        .flatMap((color) => searchTermVariants(color))
        .map((color) => color.toLowerCase());
      const colorMatches: Prisma.Sql[] = [];
      if (names.length > 0) colorMatches.push(Prisma.sql`lower(pv.color_name) = ANY(${names}::text[])`);
      if (hexes.length > 0) colorMatches.push(Prisma.sql`upper(pv.color_hex) = ANY(${hexes}::text[])`);
      conditions.push(colorMatches.length > 0 ? Prisma.sql`(${Prisma.join(colorMatches, ' OR ')})` : Prisma.sql`false`);
    }
    if (query.sizes !== undefined && query.sizes.length > 0) {
      const sizes = query.sizes.map((size) => size.toUpperCase());
      conditions.push(Prisma.sql`upper(pv.size) = ANY(${sizes}::text[])`);
    }

    return Prisma.join(conditions, ' AND ');
  }
}

function orderBy(sort: ProductSort): Prisma.Sql {
  switch (sort) {
    case 'price_asc':
      return Prisma.sql`mv.min_price ASC, p.created_at DESC, p.id ASC`;
    case 'price_desc':
      return Prisma.sql`mv.min_price DESC, p.created_at DESC, p.id ASC`;
    case 'popular':
      return Prisma.sql`sales.sold DESC, p.created_at DESC, p.id ASC`;
    case 'newest':
    default:
      return Prisma.sql`p.created_at DESC, p.id ASC`;
  }
}

function hasStock(variant: Pick<VariantRow, 'stockQuantity' | 'reservedQuantity'>): boolean {
  return variant.stockQuantity - variant.reservedQuantity > 0;
}
```

### `apps/backend/src/modules/products/dto/product-response.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorStatus } from '@prisma/client';
import { CategorySummaryDto } from '../../categories/dto/category-response.dto';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export class PriceRangeDto {
  @ApiProperty({ example: '42500000.00', description: 'Lowest selling price among the variants considered.' })
  min!: string;

  @ApiProperty({ example: '42900000.00', description: 'Highest selling price among the variants considered.' })
  max!: string;
}

export class StockSummaryDto {
  @ApiProperty({ example: 3 })
  variantCount!: number;

  @ApiProperty({ example: 2 })
  activeVariantCount!: number;

  @ApiProperty({ example: 19, description: 'On-hand units across active variants.' })
  totalStock!: number;

  @ApiProperty({ example: 1, description: 'Units reserved by open checkouts across active variants.' })
  totalReserved!: number;

  @ApiProperty({ example: 18, description: 'Sellable units: totalStock - totalReserved.' })
  totalAvailable!: number;
}

export class ColorOptionDto {
  @ApiProperty({ example: 'مشکی' })
  name!: string;

  @ApiProperty({ example: '#111827', nullable: true, type: String })
  hex!: string | null;
}

export class ImageRefDto {
  @ApiProperty({ example: '/api/v1/media/files/images/product_image/2026/09/0f2c….webp' })
  url!: string;

  @ApiProperty({ nullable: true, type: String, example: '/api/v1/media/files/images/product_image/2026/09/0f2c…_thumb.webp' })
  thumbnailUrl!: string | null;
}

export class ProductMediaDto extends ImageRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Uploaded file this entry was created from.' })
  mediaAssetId!: string | null;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty({ example: 10 })
  sortOrder!: number;
}

export class ProductModerationDto {
  @ApiProperty()
  isBlockedByAdmin!: boolean;

  @ApiProperty({ nullable: true, type: String, description: 'Reason given by staff; visible to the vendor.' })
  blockedReason!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  blockedAt!: Date | null;
}

// ---------------------------------------------------------------------------
// Vendor views
// ---------------------------------------------------------------------------

export class VendorVariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'SHP-A55-256-BLK' })
  sku!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ example: '42500000.00' })
  price!: string;

  @ApiProperty({ example: '45000000.00', nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ example: 5, nullable: true, type: Number, description: 'floor((compareAtPrice - price) / compareAtPrice × 100)' })
  discountPercent!: number | null;

  @ApiProperty({ example: 12 })
  stockQuantity!: number;

  @ApiProperty({ example: 1 })
  reservedQuantity!: number;

  @ApiProperty({ example: 11 })
  availableQuantity!: number;

  @ApiProperty({ nullable: true, type: Number })
  weightGrams!: number | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class VendorProductSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ example: '42500000.00' })
  basePrice!: string;

  @ApiProperty()
  isPublished!: boolean;

  @ApiProperty({ description: 'Published, not blocked, store approved and at least one active variant.' })
  isSellable!: boolean;

  @ApiProperty({ type: () => ProductModerationDto })
  moderation!: ProductModerationDto;

  @ApiProperty({ type: () => CategorySummaryDto })
  category!: CategorySummaryDto;

  @ApiProperty({ type: () => ImageRefDto, nullable: true })
  primaryImage!: ImageRefDto | null;

  @ApiProperty({ type: () => PriceRangeDto, nullable: true, description: 'Across active variants; null when none is active.' })
  priceRange!: PriceRangeDto | null;

  @ApiProperty({ type: () => StockSummaryDto })
  stock!: StockSummaryDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class VendorProductDetailDto extends VendorProductSummaryDto {
  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ type: () => [ProductMediaDto] })
  media!: ProductMediaDto[];

  @ApiProperty({ type: () => [VendorVariantDto], description: 'All variants, active or not.' })
  variants!: VendorVariantDto[];
}

export class PaginatedVendorProductsDto {
  @ApiProperty({ type: () => [VendorProductSummaryDto] })
  items!: VendorProductSummaryDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class ArchiveProductResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ example: false })
  isPublished!: boolean;

  @ApiProperty({ description: 'Whether the product was live before this call (false: the call was a no-op).' })
  wasPublished!: boolean;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Audit row, when the state changed.' })
  auditLogId!: string | null;
}

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

export class PublicVendorSummaryDto {
  @ApiProperty({ example: 'فروشگاه نمونهٔ شاپینو' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;

  @ApiProperty({ nullable: true, type: String })
  logoUrl!: string | null;
}

export class PublicVendorDetailDto extends PublicVendorSummaryDto {
  @ApiProperty({ nullable: true, type: String })
  bio!: string | null;

  @ApiProperty({ nullable: true, type: String })
  instagramHandle!: string | null;

  @ApiProperty({ nullable: true, type: Date, description: 'When the store was approved.' })
  verifiedAt!: Date | null;
}

export class PublicProductListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ type: () => ImageRefDto, nullable: true, description: 'Primary image (use thumbnailUrl in listings).' })
  primaryImage!: ImageRefDto | null;

  @ApiProperty({ type: () => PriceRangeDto, description: 'Across all active variants.' })
  priceRange!: PriceRangeDto;

  @ApiProperty({ nullable: true, type: Number, example: 22, description: 'Largest discount among active variants.' })
  maxDiscountPercent!: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '52000000.00',
    description: 'Compare-at (strike-through) price of the cheapest active variant — the one priceRange.min comes from; null when that variant has no discount.',
  })
  startingCompareAtPrice!: string | null;

  @ApiProperty({ type: () => [ColorOptionDto] })
  colors!: ColorOptionDto[];

  @ApiProperty({ type: [String], example: ['L', 'XL'] })
  sizes!: string[];

  @ApiProperty({ description: 'At least one active variant has sellable stock.' })
  inStock!: boolean;

  @ApiProperty({ type: () => PublicVendorSummaryDto })
  vendor!: PublicVendorSummaryDto;

  @ApiProperty({ type: () => CategorySummaryDto })
  category!: CategorySummaryDto;

  @ApiProperty()
  createdAt!: Date;
}

export class PaginatedPublicProductsDto {
  @ApiProperty({ type: () => [PublicProductListItemDto] })
  items!: PublicProductListItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 42, description: 'Total number of matching products.' })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class PublicVariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ example: '42500000.00' })
  price!: string;

  @ApiProperty({ nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  discountPercent!: number | null;

  @ApiProperty({ example: 11, description: 'Real-time sellable units (stock minus open reservations).' })
  availableQuantity!: number;

  @ApiProperty()
  inStock!: boolean;

  @ApiProperty({ nullable: true, type: Number })
  weightGrams!: number | null;
}

export class PublicProductDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ type: () => [CategorySummaryDto], description: 'Root → product category.' })
  breadcrumbs!: CategorySummaryDto[];

  @ApiProperty({ type: () => PublicVendorDetailDto })
  vendor!: PublicVendorDetailDto;

  @ApiProperty({ type: () => [ImageRefDto], description: 'Full gallery in display order; the first image is the primary one.' })
  media!: ImageRefDto[];

  @ApiProperty({ type: () => [PublicVariantDto], description: 'Active variants only.' })
  variants!: PublicVariantDto[];

  @ApiProperty({ type: () => PriceRangeDto })
  priceRange!: PriceRangeDto;

  @ApiProperty({ nullable: true, type: Number })
  maxDiscountPercent!: number | null;

  @ApiProperty({ type: () => [ColorOptionDto] })
  colors!: ColorOptionDto[];

  @ApiProperty({ type: [String] })
  sizes!: string[];

  @ApiProperty()
  inStock!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

// ---------------------------------------------------------------------------
// Staff views
// ---------------------------------------------------------------------------

export class AdminProductVendorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  storeName!: string;

  @ApiProperty()
  storeSlug!: string;

  @ApiProperty({ enum: VendorStatus })
  status!: VendorStatus;
}

export class AdminProductDto extends VendorProductSummaryDto {
  @ApiProperty({ type: () => AdminProductVendorDto })
  vendor!: AdminProductVendorDto;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Staff member who blocked the product.' })
  blockedByUserId!: string | null;
}

export class PaginatedAdminProductsDto {
  @ApiProperty({ type: () => [AdminProductDto] })
  items!: AdminProductDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class AdminProductStatusResponseDto {
  @ApiProperty({ type: () => AdminProductDto })
  product!: AdminProductDto;

  @ApiProperty({ format: 'uuid' })
  auditLogId!: string;

  @ApiPropertyOptional({ type: [String], example: ['isBlockedByAdmin', 'isPublished'], description: 'Fields that changed.' })
  changed!: string[];
}
```

### `apps/backend/src/modules/products/product-views.spec.ts`

```ts
import { Prisma } from '@prisma/client';

import { maxDiscountPercent, startingCompareAtPrice } from './product-views';

interface TestVariant {
  price: Prisma.Decimal;
  compareAtPrice: Prisma.Decimal | null;
  isActive: boolean;
}

const variant = (price: number, compareAtPrice: number | null, isActive = true): TestVariant => ({
  price: new Prisma.Decimal(price),
  compareAtPrice: compareAtPrice === null ? null : new Prisma.Decimal(compareAtPrice),
  isActive,
});

describe('startingCompareAtPrice', () => {
  it('returns the compare-at price of the cheapest active variant', () => {
    expect(startingCompareAtPrice([variant(500_000, 600_000), variant(400_000, 480_000), variant(450_000, null)])).toBe('480000.00');
  });

  it('is null when the cheapest variant is not discounted, even if a dearer one is', () => {
    const variants = [variant(400_000, null), variant(500_000, 900_000)];
    expect(startingCompareAtPrice(variants)).toBeNull();
    // …while the badge still reports the best discount of the product.
    expect(maxDiscountPercent(variants)).toBe(44);
  });

  it('ignores inactive variants', () => {
    expect(startingCompareAtPrice([variant(100_000, 200_000, false), variant(300_000, 330_000)])).toBe('330000.00');
  });

  it('is null for a compare-at price that is not above the price, and for no active variant', () => {
    expect(startingCompareAtPrice([variant(300_000, 300_000)])).toBeNull();
    expect(startingCompareAtPrice([variant(300_000, 400_000, false)])).toBeNull();
    expect(startingCompareAtPrice([])).toBeNull();
  });
});
```

### `apps/backend/src/modules/products/product-views.ts`

```ts
import { VendorStatus, type Prisma } from '@prisma/client';
import { CategorySummaryDto } from '../categories/dto/category-response.dto';
import type {
  AdminProductDto,
  ColorOptionDto,
  ImageRefDto,
  PriceRangeDto,
  ProductMediaDto,
  PublicVariantDto,
  StockSummaryDto,
  VendorProductDetailDto,
  VendorProductSummaryDto,
  VendorVariantDto,
} from './dto/product-response.dto';
import { discountPercent } from './product-rules';

/**
 * Prisma selections and the pure mappers that turn their rows into response
 * DTOs. Keeping the `select` next to the mapper guarantees the mapper never
 * reads a field the query did not load.
 */

export const variantSelect = {
  id: true,
  sku: true,
  colorName: true,
  colorHex: true,
  size: true,
  guarantee: true,
  price: true,
  compareAtPrice: true,
  stockQuantity: true,
  reservedQuantity: true,
  weightGrams: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductVariantSelect;

export const mediaSelect = {
  id: true,
  mediaAssetId: true,
  url: true,
  thumbnailUrl: true,
  isPrimary: true,
  sortOrder: true,
} satisfies Prisma.ProductMediaSelect;

const categorySelect = { id: true, slug: true, titleFa: true, titleEn: true } satisfies Prisma.CategorySelect;

export const productSummarySelect = {
  id: true,
  slug: true,
  title: true,
  brand: true,
  basePrice: true,
  isPublished: true,
  isBlockedByAdmin: true,
  blockedReason: true,
  blockedAt: true,
  blockedByUserId: true,
  createdAt: true,
  updatedAt: true,
  category: { select: categorySelect },
  vendor: { select: { id: true, storeName: true, storeSlug: true, status: true } },
  variants: { select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 1 },
} satisfies Prisma.ProductSelect;

export const productDetailSelect = {
  ...productSummarySelect,
  description: true,
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.ProductSelect;

export type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;
export type MediaRow = Prisma.ProductMediaGetPayload<{ select: typeof mediaSelect }>;
export type ProductSummaryRow = Prisma.ProductGetPayload<{ select: typeof productSummarySelect }>;
export type ProductDetailRow = Prisma.ProductGetPayload<{ select: typeof productDetailSelect }>;

type PricedVariant = Pick<VariantRow, 'price' | 'compareAtPrice' | 'isActive'>;
type StockedVariant = Pick<VariantRow, 'stockQuantity' | 'reservedQuantity' | 'isActive'>;
type OptionVariant = Pick<VariantRow, 'colorName' | 'colorHex' | 'size'>;

export function money(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export function priceRange(variants: readonly PricedVariant[]): PriceRangeDto | null {
  const prices = variants.filter((variant) => variant.isActive).map((variant) => variant.price);
  if (prices.length === 0) {
    return null;
  }
  const min = prices.reduce((lowest, price) => (price.lt(lowest) ? price : lowest));
  const max = prices.reduce((highest, price) => (price.gt(highest) ? price : highest));
  return { min: money(min), max: money(max) };
}

export function maxDiscountPercent(variants: readonly PricedVariant[]): number | null {
  let best: number | null = null;
  for (const variant of variants) {
    if (!variant.isActive) continue;
    const percent = discountPercent(variant.price, variant.compareAtPrice);
    if (percent !== null && (best === null || percent > best)) {
      best = percent;
    }
  }
  return best;
}

/**
 * Strike-through price that belongs to the listing's "from" price: the
 * compare-at price of the cheapest active variant, or null when that variant
 * is not discounted. (A product card shows `priceRange.min` next to it, so a
 * compare-at price of a different variant would misstate the discount.)
 */
export function startingCompareAtPrice(variants: readonly PricedVariant[]): string | null {
  let cheapest: PricedVariant | null = null;
  for (const variant of variants) {
    if (!variant.isActive) continue;
    if (cheapest === null || variant.price.lt(cheapest.price)) {
      cheapest = variant;
    }
  }
  if (cheapest === null || cheapest.compareAtPrice === null || !cheapest.compareAtPrice.greaterThan(cheapest.price)) {
    return null;
  }
  return money(cheapest.compareAtPrice);
}

export function stockSummary(variants: readonly StockedVariant[]): StockSummaryDto {
  const active = variants.filter((variant) => variant.isActive);
  const totalStock = active.reduce((sum, variant) => sum + variant.stockQuantity, 0);
  const totalReserved = active.reduce((sum, variant) => sum + variant.reservedQuantity, 0);
  return {
    variantCount: variants.length,
    activeVariantCount: active.length,
    totalStock,
    totalReserved,
    totalAvailable: totalStock - totalReserved,
  };
}

/** Distinct colours (by case-insensitive name, first hex wins) and sizes, in variant order. */
export function variantOptions(variants: readonly OptionVariant[]): { colors: ColorOptionDto[]; sizes: string[] } {
  const colors = new Map<string, ColorOptionDto>();
  const sizes = new Map<string, string>();
  for (const variant of variants) {
    if (variant.colorName) {
      const key = variant.colorName.toLocaleLowerCase('fa');
      if (!colors.has(key)) {
        colors.set(key, { name: variant.colorName, hex: variant.colorHex });
      }
    }
    if (variant.size) {
      const key = variant.size.toLocaleUpperCase('en');
      if (!sizes.has(key)) {
        sizes.set(key, variant.size);
      }
    }
  }
  return { colors: [...colors.values()], sizes: [...sizes.values()] };
}

export function imageRef(media: Pick<MediaRow, 'url' | 'thumbnailUrl'> | undefined): ImageRefDto | null {
  return media ? { url: media.url, thumbnailUrl: media.thumbnailUrl } : null;
}

export function toVendorVariant(variant: VariantRow): VendorVariantDto {
  return {
    id: variant.id,
    sku: variant.sku,
    colorName: variant.colorName,
    colorHex: variant.colorHex,
    size: variant.size,
    guarantee: variant.guarantee,
    price: money(variant.price),
    compareAtPrice: variant.compareAtPrice ? money(variant.compareAtPrice) : null,
    discountPercent: discountPercent(variant.price, variant.compareAtPrice),
    stockQuantity: variant.stockQuantity,
    reservedQuantity: variant.reservedQuantity,
    availableQuantity: variant.stockQuantity - variant.reservedQuantity,
    weightGrams: variant.weightGrams,
    isActive: variant.isActive,
    createdAt: variant.createdAt,
    updatedAt: variant.updatedAt,
  };
}

export function toPublicVariant(variant: VariantRow): PublicVariantDto {
  const available = Math.max(0, variant.stockQuantity - variant.reservedQuantity);
  return {
    id: variant.id,
    sku: variant.sku,
    colorName: variant.colorName,
    colorHex: variant.colorHex,
    size: variant.size,
    guarantee: variant.guarantee,
    price: money(variant.price),
    compareAtPrice: variant.compareAtPrice ? money(variant.compareAtPrice) : null,
    discountPercent: discountPercent(variant.price, variant.compareAtPrice),
    availableQuantity: available,
    inStock: available > 0,
    weightGrams: variant.weightGrams,
  };
}

export function toMediaDto(media: MediaRow): ProductMediaDto {
  return { ...media };
}

/** Sellable = what the storefront would list (category visibility is checked separately). */
export function isSellable(product: Pick<ProductSummaryRow, 'isPublished' | 'isBlockedByAdmin' | 'variants' | 'vendor'>): boolean {
  return (
    product.isPublished &&
    !product.isBlockedByAdmin &&
    product.vendor.status === VendorStatus.APPROVED &&
    product.variants.some((variant) => variant.isActive)
  );
}

export function toVendorSummary(product: ProductSummaryRow): VendorProductSummaryDto {
  return {
    id: product.id,
    slug: product.slug,
    title: product.title,
    brand: product.brand,
    basePrice: money(product.basePrice),
    isPublished: product.isPublished,
    isSellable: isSellable(product),
    moderation: {
      isBlockedByAdmin: product.isBlockedByAdmin,
      blockedReason: product.blockedReason,
      blockedAt: product.blockedAt,
    },
    category: CategorySummaryDto.from(product.category),
    primaryImage: imageRef(product.media[0]),
    priceRange: priceRange(product.variants),
    stock: stockSummary(product.variants),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export function toVendorDetail(product: ProductDetailRow): VendorProductDetailDto {
  return {
    ...toVendorSummary(product),
    description: product.description,
    media: product.media.map((media) => toMediaDto(media)),
    variants: product.variants.map((variant) => toVendorVariant(variant)),
  };
}

export function toAdminProduct(product: ProductSummaryRow): AdminProductDto {
  return {
    ...toVendorSummary(product),
    vendor: { ...product.vendor },
    blockedByUserId: product.blockedByUserId,
  };
}
```

### `apps/backend/test/catalog.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AuditAction, PaymentMethod, SubOrderStatus, VendorStatus } from '@prisma/client';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { CategoriesService } from '../src/modules/categories/categories.service';
import { InventoryService } from '../src/modules/products/inventory.service';
import { SMS_PROVIDER } from '../src/modules/sms/sms-provider.interface';
import type { SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification of the Phase-5 catalogue against the real stack:
 * PostgreSQL 16 (pg_trgm, CHECK constraints, row locks), Redis 7 (category tree
 * cache, auth state), the real media pipeline and the real auth flow.
 *
 * Vendors are onboarded the way production onboards them — OTP sign-in, store
 * registration, staff approval over the admin API — and product images are real
 * uploads. Sold units for the "popular" sort are genuine order rows. Every row,
 * file and audit entry the suite creates is removed in `afterAll`; every name,
 * slug and SKU carries a per-run tag so the seeded catalogue never interferes.
 */

const TEST_UA = 'shopino-catalog-e2e/1.0';
const RUN = Date.now().toString(36);
/** SKUs are stored upper-cased; fixtures refer to them through this tag. */
const TAG = RUN.toUpperCase();

const VENDOR_A_MOBILE = '+989971130001';
const VENDOR_B_MOBILE = '+989971130002';
const PENDING_VENDOR_MOBILE = '+989971130003';
const CUSTOMER_MOBILE = '+989971130004';
const SUITE_MOBILES = [VENDOR_A_MOBILE, VENDOR_B_MOBILE, PENDING_VENDOR_MOBILE, CUSTOMER_MOBILE];

/** Checksum-valid Iranian IBANs (MOD 97-10 verified). */
const IBANS = ['IR820540102680020817909002', 'IR570629600000001003242001', 'IR550540102680020817909003'];

const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';

const ORDER_PREFIX = `E5${RUN}`.slice(0, 12).toUpperCase();

interface HttpResult<T> {
  status: number;
  body: T;
}

interface Category {
  id: string;
  slug: string;
  titleFa: string;
  titleEn: string | null;
  parentId: string | null;
  defaultCommissionRate: string;
  isActive: boolean;
  auditLogId?: string;
}

interface TreeNode {
  id: string;
  slug: string;
  depth: number;
  productCount: number;
  totalProductCount: number;
  children: TreeNode[];
}

interface Variant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  isActive: boolean;
}

interface VendorProduct {
  id: string;
  slug: string;
  title: string;
  isPublished: boolean;
  isSellable: boolean;
  moderation: { isBlockedByAdmin: boolean; blockedReason: string | null };
  category: { slug: string };
  priceRange: { min: string; max: string } | null;
  stock: { variantCount: number; activeVariantCount: number; totalStock: number; totalAvailable: number };
  media?: Array<{ id: string; mediaAssetId: string | null; isPrimary: boolean; sortOrder: number; url: string }>;
  variants?: Variant[];
}

interface ListItem {
  slug: string;
  priceRange: { min: string; max: string };
  colors: Array<{ name: string; hex: string | null }>;
  sizes: string[];
  inStock: boolean;
  primaryImage: { url: string; thumbnailUrl: string | null } | null;
  vendor: { storeSlug: string };
  category: { slug: string };
  maxDiscountPercent: number | null;
  startingCompareAtPrice: string | null;
}

interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

describe('Phase 5 — categories, product catalogue and discovery (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let storage: StorageProvider;
  let inventory: InventoryService;

  let adminToken: string;
  let supportToken: string;
  let vendorA: { token: string; userId: string; vendorId: string; storeSlug: string };
  let vendorB: { token: string; userId: string; vendorId: string; storeSlug: string };
  let pending: { token: string; userId: string };
  let customer: { token: string; userId: string };

  const cat: Record<'root' | 'cams' | 'mirrorless' | 'lenses', Category> = {} as never;
  const media: { a1: string; a2: string; a3: string; b1: string } = {} as never;
  const product: Record<'p1' | 'p2' | 'p3' | 'pb' | 'draft', VendorProduct> = {} as never;

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'; token?: string; body?: unknown; form?: FormData } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;

    let payload: string | Buffer | undefined;
    if (options.form !== undefined) {
      const serialized = new Response(options.form);
      payload = Buffer.from(await serialized.arrayBuffer());
      headers['content-type'] = serialized.headers.get('content-type') ?? '';
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }

    const response = await app.inject({
      method: options.method ?? 'GET',
      url: `${API}${url}`,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return {
      status: response.statusCode,
      body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T),
    };
  };

  const search = (params: Record<string, string | number | boolean | string[]>): Promise<HttpResult<Page<ListItem>>> => {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (Array.isArray(value)) value.forEach((entry) => query.append(key, entry));
      else query.append(key, String(value));
    }
    return request<Page<ListItem>>(`/products?${query.toString()}`);
  };

  const slugs = (result: HttpResult<Page<ListItem>>): string[] => result.body.items.map((item) => item.slug);

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    const requested = await request('/auth/otp/request', { method: 'POST', body: { mobile } });
    expect(requested.status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    expect(code).toBeDefined();
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', {
      method: 'POST',
      body: { mobile, code },
    });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const loginWithPassword = async (identifier: string, password: string): Promise<string> => {
    const response = await request<{ accessToken: string }>('/auth/login/password', {
      method: 'POST',
      body: { identifier, password },
    });
    expect(response.status).toBe(200);
    return response.body.accessToken;
  };

  const registerStore = async (token: string, storeSlug: string, iban: string): Promise<string> => {
    const response = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token,
      body: {
        storeName: `فروشگاه آزمون کاتالوگ ${storeSlug}`,
        storeSlug,
        bio: 'فروشگاه ساخته‌شده در آزمون کاتالوگ',
        bankIban: iban,
        bankAccountHolder: 'شرکت آزمون کاتالوگ',
      },
    });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  /** Uploads a national-ID document and submits it, as Phase 4 requires before review. */
  const submitVerification = async (token: string): Promise<void> => {
    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% catalog e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const uploaded = await request<{ url: string }>('/media/upload/document', { method: 'POST', token, form });
    expect(uploaded.status).toBe(201);
    const submitted = await request('/vendors/verification/documents', {
      method: 'POST',
      token,
      body: { nationalIdCardUrl: uploaded.body.url },
    });
    expect(submitted.status).toBe(200);
  };

  const approveStore = async (vendorId: string): Promise<void> => {
    const response = await request(`/admin/vendors/${vendorId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null },
    });
    expect(response.status).toBe(200);
  };

  const uploadImage = async (token: string, width: number, rgb: [number, number, number]): Promise<string> => {
    const body = await sharp({ create: { width, height: width, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
      .png()
      .toBuffer();
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(body)], { type: 'image/png' }), `product-${width}.png`);
    form.append('purpose', 'product_image');
    const response = await request<{ id: string }>('/media/upload/image', { method: 'POST', token, form });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  const createCategory = (body: Record<string, unknown>, token = adminToken): Promise<HttpResult<Category>> =>
    request<Category>('/admin/categories', { method: 'POST', token, body });

  const createProduct = (token: string, body: Record<string, unknown>): Promise<HttpResult<VendorProduct>> =>
    request<VendorProduct>('/vendor/products', { method: 'POST', token, body });

  const findNode = (nodes: TreeNode[], slug: string): TreeNode | undefined => {
    for (const node of nodes) {
      if (node.slug === slug) return node;
      const nested = findNode(node.children, slug);
      if (nested) return nested;
    }
    return undefined;
  };

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    inventory = app.get(InventoryService);
    await resetAuthKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    const staffPassword = process.env['SEED_STAFF_PASSWORD'];
    if (adminPassword === undefined || staffPassword === undefined) {
      throw new Error('This suite needs SUPER_ADMIN_PASSWORD and SEED_STAFF_PASSWORD from the root .env.');
    }
    adminToken = await loginWithPassword(SEEDED_ADMIN_EMAIL, adminPassword);
    supportToken = await loginWithPassword(SEEDED_SUPPORT_EMAIL, staffPassword);

    // Two approved stores, one store still under review, one plain customer.
    const a = await loginWithOtp(VENDOR_A_MOBILE);
    const b = await loginWithOtp(VENDOR_B_MOBILE);
    pending = await loginWithOtp(PENDING_VENDOR_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);

    const storeA = `cat-e2e-a-${RUN}`;
    const storeB = `cat-e2e-b-${RUN}`;
    const vendorAId = await registerStore(a.token, storeA, IBANS[0]!);
    const vendorBId = await registerStore(b.token, storeB, IBANS[1]!);
    await registerStore(pending.token, `cat-e2e-p-${RUN}`, IBANS[2]!);
    await submitVerification(a.token);
    await submitVerification(b.token);
    await approveStore(vendorAId);
    await approveStore(vendorBId);
    vendorA = { ...a, vendorId: vendorAId, storeSlug: storeA };
    vendorB = { ...b, vendorId: vendorBId, storeSlug: storeB };

    media.a1 = await uploadImage(a.token, 64, [200, 30, 30]);
    media.a2 = await uploadImage(a.token, 72, [30, 200, 30]);
    media.a3 = await uploadImage(a.token, 80, [30, 30, 200]);
    media.b1 = await uploadImage(b.token, 88, [120, 120, 20]);
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((vendor) => vendor.id);
      const products = await prisma.product.findMany({
        where: { vendorId: { in: vendorIds } },
        select: { id: true, variants: { select: { id: true } } },
      });
      const productIds = products.map((row) => row.id);
      const variantIds = products.flatMap((row) => row.variants.map((variant) => variant.id));
      const categories = await prisma.category.findMany({
        where: { slug: { startsWith: `e2e-cat-${RUN}` } },
        select: { id: true, parentId: true },
      });
      const categoryIds = categories.map((row) => row.id);

      const orders = await prisma.parentOrder.findMany({
        where: { orderNumber: { startsWith: ORDER_PREFIX } },
        select: { id: true },
      });
      const orderIds = orders.map((row) => row.id);
      await prisma.orderItem.deleteMany({ where: { subOrder: { parentOrderId: { in: orderIds } } } });
      await prisma.subOrder.deleteMany({ where: { parentOrderId: { in: orderIds } } });
      await prisma.parentOrder.deleteMany({ where: { id: { in: orderIds } } });

      await prisma.productMedia.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } });

      // Children before parents: the parent FK is RESTRICT.
      const remaining = new Set(categoryIds);
      while (remaining.size > 0) {
        const leaves = categories.filter(
          (row) => remaining.has(row.id) && !categories.some((child) => child.parentId === row.id && remaining.has(child.id)),
        );
        await prisma.category.deleteMany({ where: { id: { in: leaves.map((row) => row.id) } } });
        leaves.forEach((row) => remaining.delete(row.id));
        if (leaves.length === 0) break;
      }

      const assets = await prisma.mediaAsset.findMany({
        where: { ownerUserId: { in: userIds } },
        select: { path: true, thumbnailPath: true },
      });
      for (const asset of assets) {
        await storage.delete(asset.path).catch(() => false);
        if (asset.thumbnailPath !== null) await storage.delete(asset.thumbnailPath).catch(() => false);
      }

      await prisma.auditLog.deleteMany({
        where: {
          OR: [
            { userId: { in: userIds } },
            { userAgent: TEST_UA },
            { entityId: { in: [...vendorIds, ...productIds, ...variantIds, ...categoryIds] } },
          ],
        },
      });
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });

      await app.get(CategoriesService).invalidateTree();
      await resetAuthKeys();
    }
    await app?.close();
  }, 120_000);

  /** Test-only housekeeping: clears the auth rate-limit state this suite produces. */
  async function resetAuthKeys(): Promise<void> {
    const redis = app.get(RedisService);
    const keys = [
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
      ...SUITE_MOBILES.flatMap((mobile) => [
        OtpKeys.challenge(mobile),
        OtpKeys.lock(mobile),
        OtpKeys.cooldown(mobile),
        OtpKeys.hourlyByMobile(mobile),
        loginAttemptsKey(normalizeIdentifier(mobile)),
        loginLockKey(normalizeIdentifier(mobile)),
      ]),
      ...[SEEDED_ADMIN_EMAIL, SEEDED_SUPPORT_EMAIL].flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  // ─── 1. Category management ───────────────────────────────────────────────

  describe('admin category management', () => {
    it('builds a three-level tree (root → child → grandchild) and a sibling, audited', async () => {
      const root = await createCategory({
        slug: `e2e-cat-${RUN}`,
        titleFa: 'دوربین و عکاسی آزمون',
        titleEn: 'E2E Photography',
        defaultCommissionRate: 8.5,
        sortOrder: 900,
      });
      expect(root.status).toBe(201);
      expect(root.body.parentId).toBeNull();
      expect(root.body.defaultCommissionRate).toBe('8.50');
      cat.root = root.body;

      const cams = await createCategory({
        parentId: cat.root.id,
        slug: `e2e-cat-${RUN}-cams`,
        titleFa: 'دوربین',
        defaultCommissionRate: 7,
        sortOrder: 10,
      });
      expect(cams.status).toBe(201);
      cat.cams = cams.body;

      const mirrorless = await createCategory({
        parentId: cat.cams.id,
        slug: `e2e-cat-${RUN}-mirrorless`,
        titleFa: 'دوربین بدون آینه',
        titleEn: 'Mirrorless',
        defaultCommissionRate: 6.25,
        sortOrder: 10,
      });
      expect(mirrorless.status).toBe(201);
      cat.mirrorless = mirrorless.body;

      const lenses = await createCategory({
        parentId: cat.root.id,
        slug: `e2e-cat-${RUN}-lenses`,
        titleFa: 'لنز',
        defaultCommissionRate: 9,
        sortOrder: 20,
      });
      expect(lenses.status).toBe(201);
      cat.lenses = lenses.body;

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: mirrorless.body.auditLogId! } });
      expect(audit.action).toBe(AuditAction.CREATE);
      expect(audit.entityName).toBe('Category');
      expect(audit.entityId).toBe(cat.mirrorless.id);
    });

    it('rejects duplicate and reserved slugs, unknown parents and out-of-range commission', async () => {
      const duplicate = await createCategory({ slug: cat.cams.slug, titleFa: 'تکراری', defaultCommissionRate: 5 });
      expect(duplicate.status).toBe(409);

      const reserved = await createCategory({ slug: 'tree', titleFa: 'رزرو', defaultCommissionRate: 5 });
      expect(reserved.status).toBe(400);

      const orphan = await createCategory({
        parentId: '00000000-0000-4000-8000-000000000000',
        slug: `e2e-cat-${RUN}-orphan`,
        titleFa: 'یتیم',
        defaultCommissionRate: 5,
      });
      expect(orphan.status).toBe(400);

      const tooHigh = await createCategory({ slug: `e2e-cat-${RUN}-x`, titleFa: 'زیاد', defaultCommissionRate: 150 });
      expect(tooHigh.status).toBe(400);
    });

    it('only SUPER_ADMIN / ADMIN may manage categories', async () => {
      const body = { slug: `e2e-cat-${RUN}-nope`, titleFa: 'ممنوع', defaultCommissionRate: 5 };
      expect((await request('/admin/categories', { method: 'POST', body })).status).toBe(401);
      expect((await createCategory(body, supportToken)).status).toBe(403);
      expect((await createCategory(body, vendorA.token)).status).toBe(403);
      expect((await createCategory(body, customer.token)).status).toBe(403);
    });

    it('updates the commission rate with an audit trail of old and new values', async () => {
      const response = await request<Category>(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { defaultCommissionRate: 7.75 },
      });
      expect(response.status).toBe(200);
      expect(response.body.defaultCommissionRate).toBe('7.75');

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: response.body.auditLogId! } });
      expect(audit.action).toBe(AuditAction.UPDATE);
      expect(JSON.stringify(audit.oldValue)).toContain('7');
      expect(JSON.stringify(audit.newValue)).toContain('7.75');
    });

    it('refuses to create cycles: self-parenting and moving a node under its own descendant', async () => {
      const self = await request(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.cams.id },
      });
      expect(self.status).toBe(400);

      const underDescendant = await request(`/admin/categories/${cat.root.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.mirrorless.id },
      });
      expect(underDescendant.status).toBe(400);

      const unchanged = await prisma.category.findUniqueOrThrow({ where: { id: cat.root.id } });
      expect(unchanged.parentId).toBeNull();
    });

    it('allows a legitimate move and moving it back', async () => {
      const moved = await request<Category>(`/admin/categories/${cat.lenses.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.cams.id },
      });
      expect(moved.status).toBe(200);
      expect(moved.body.parentId).toBe(cat.cams.id);

      const back = await request<Category>(`/admin/categories/${cat.lenses.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { parentId: cat.root.id },
      });
      expect(back.status).toBe(200);
      expect(back.body.parentId).toBe(cat.root.id);
    });

    it('lists every category for staff, inactive ones included', async () => {
      const response = await request<{ items: Category[]; total: number }>('/admin/categories', { token: adminToken });
      expect(response.status).toBe(200);
      const ours = response.body.items.filter((row) => row.slug.startsWith(`e2e-cat-${RUN}`));
      expect(ours).toHaveLength(4);
      expect(response.body.total).toBe(response.body.items.length);
    });
  });

  // ─── 2. Public category tree ──────────────────────────────────────────────

  describe('public category tree and category page', () => {
    it('builds the nested tree recursively: root, deep nested node, correct depths', async () => {
      const response = await request<{ items: TreeNode[]; totalCategories: number }>('/categories/tree');
      expect(response.status).toBe(200);

      const root = response.body.items.find((node) => node.slug === cat.root.slug);
      expect(root).toBeDefined();
      expect(root!.depth).toBe(0);
      expect(root!.children.map((child) => child.slug)).toEqual([cat.cams.slug, cat.lenses.slug]);

      const deep = root!.children[0]!.children[0]!;
      expect(deep.slug).toBe(cat.mirrorless.slug);
      expect(deep.depth).toBe(2);
      expect(deep.children).toEqual([]);
      expect(response.body.totalCategories).toBeGreaterThanOrEqual(4);
    });

    it('returns a category with its ancestor breadcrumb and direct children', async () => {
      const deep = await request<{ breadcrumbs: Array<{ slug: string }>; children: unknown[]; depth: number }>(
        `/categories/${cat.mirrorless.slug}`,
      );
      expect(deep.status).toBe(200);
      expect(deep.body.breadcrumbs.map((crumb) => crumb.slug)).toEqual([cat.root.slug, cat.cams.slug, cat.mirrorless.slug]);
      expect(deep.body.depth).toBe(2);

      const root = await request<{ breadcrumbs: Array<{ slug: string }>; children: Array<{ slug: string; childCount: number }> }>(
        `/categories/${cat.root.slug}`,
      );
      expect(root.body.breadcrumbs.map((crumb) => crumb.slug)).toEqual([cat.root.slug]);
      expect(root.body.children.map((child) => child.slug)).toEqual([cat.cams.slug, cat.lenses.slug]);
      expect(root.body.children[0]!.childCount).toBe(1);

      expect((await request('/categories/does-not-exist')).status).toBe(404);
    });

    it('hides a deactivated category together with its whole subtree, and restores it', async () => {
      const off = await request(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: false },
      });
      expect(off.status).toBe(200);

      expect((await request(`/categories/${cat.cams.slug}`)).status).toBe(404);
      expect((await request(`/categories/${cat.mirrorless.slug}`)).status).toBe(404);
      const tree = await request<{ items: TreeNode[] }>('/categories/tree');
      expect(findNode(tree.body.items, cat.mirrorless.slug)).toBeUndefined();
      expect(findNode(tree.body.items, cat.lenses.slug)).toBeDefined();

      const on = await request(`/admin/categories/${cat.cams.id}`, {
        method: 'PATCH',
        token: adminToken,
        body: { isActive: true },
      });
      expect(on.status).toBe(200);
      expect((await request(`/categories/${cat.mirrorless.slug}`)).status).toBe(200);
    });
  });

  // ─── 3. Vendor product creation ───────────────────────────────────────────

  describe('vendor product creation', () => {
    const baseBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
      title: `محصول آزمون ${RUN}`,
      categoryId: cat.mirrorless.id,
      basePrice: 1_000_000,
      variants: [{ sku: `E2E-${TAG}-TMP-1`, price: 1_000_000, stockQuantity: 1 }],
      ...overrides,
    });

    it('blocks anonymous callers, customers, stores under review and staff', async () => {
      expect((await request('/vendor/products', { method: 'POST', body: baseBody() })).status).toBe(401);
      expect((await createProduct(customer.token, baseBody())).status).toBe(403);
      expect((await createProduct(pending.token, baseBody())).status).toBe(403);
      expect((await createProduct(adminToken, baseBody())).status).toBe(403);
      expect((await request('/vendor/products', { token: pending.token })).status).toBe(403);
    });

    it('creates product, variant matrix and ordered gallery in one transaction', async () => {
      const response = await createProduct(vendorA.token, {
        title: `دوربین كهكشان ${RUN}`, // Arabic kaf on purpose: stored normalised
        description: 'دوربین بدون آینه با حسگر فول‌فریم و لرزشگیر پنج محوره',
        categoryId: cat.mirrorless.id,
        brand: 'Kahkeshan',
        basePrice: 12_000_000,
        mediaIds: [media.a2, media.a1],
        isPublished: true,
        variants: [
          { sku: `e2e-${RUN}-p1-blk-s`, colorName: 'مشکی', colorHex: '#000000', size: 's', guarantee: 'گارانتی ۱۸ ماهه', price: 10_000_000, compareAtPrice: 12_000_000, stockQuantity: 5, weightGrams: 650 },
          { sku: `E2E-${TAG}-P1-BLK-M`, colorName: 'مشکی', colorHex: '#000000', size: 'M', guarantee: 'گارانتی ۱۸ ماهه', price: 11_000_000, stockQuantity: 0 },
          { sku: `E2E-${TAG}-P1-RED-M`, colorName: 'قرمز', colorHex: '#ff0000', size: 'M', guarantee: 'گارانتی ۱۸ ماهه', price: 12_500_000, stockQuantity: 3 },
        ],
      });
      expect(response.status).toBe(201);
      product.p1 = response.body;

      expect(response.body.title).toBe(`دوربین کهکشان ${RUN}`);
      expect(response.body.slug).toMatch(new RegExp(`${RUN}$`));
      expect(response.body.isPublished).toBe(true);
      expect(response.body.isSellable).toBe(true);
      expect(response.body.priceRange).toEqual({ min: '10000000.00', max: '12500000.00' });
      expect(response.body.stock).toMatchObject({ variantCount: 3, activeVariantCount: 3, totalStock: 8, totalAvailable: 8 });

      const [first, second] = response.body.media!;
      expect(first!.mediaAssetId).toBe(media.a2);
      expect(first!.isPrimary).toBe(true);
      expect(second!.mediaAssetId).toBe(media.a1);
      expect(second!.isPrimary).toBe(false);
      expect(first!.sortOrder).toBeLessThan(second!.sortOrder);

      const skus = response.body.variants!.map((variant) => variant.sku);
      expect(skus).toContain(`E2E-${TAG}-P1-BLK-S`); // normalised to upper case
      const discounted = response.body.variants!.find((variant) => variant.sku === `E2E-${TAG}-P1-BLK-S`)!;
      expect(discounted.discountPercent).toBe(16);
      // Sizes keep the vendor's spelling; every comparison (matrix, filters, facets) is case-insensitive.
      expect(discounted.size).toBe('s');
      expect(discounted.colorHex).toBe('#000000');

      const rows = await prisma.product.findUniqueOrThrow({
        where: { id: product.p1.id },
        include: { variants: true, media: true },
      });
      expect(rows.vendorId).toBe(vendorA.vendorId);
      expect(rows.variants).toHaveLength(3);
      expect(rows.media).toHaveLength(2);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: product.p1.id, action: AuditAction.CREATE, entityName: 'Product' },
      });
      expect(audit.userId).toBe(vendorA.userId);
    });

    it('creates the rest of the fixture catalogue', async () => {
      const p2 = await createProduct(vendorA.token, {
        title: `لنز تله ${RUN}`,
        description: 'لنز تله با بدنه ضدآب',
        categoryId: cat.lenses.id,
        brand: 'Optika',
        basePrice: 3_000_000,
        mediaIds: [media.a3],
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-P2-1`, price: 3_000_000, stockQuantity: 0 }],
      });
      expect(p2.status).toBe(201);
      product.p2 = p2.body;

      const p3 = await createProduct(vendorA.token, {
        title: `کیف دوربین ${RUN}`,
        categoryId: cat.cams.id,
        basePrice: 500_000,
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-P3-1`, colorName: 'قهوه‌ای', size: 'L', price: 500_000, stockQuantity: 10 }],
      });
      expect(p3.status).toBe(201);
      product.p3 = p3.body;

      const pb = await createProduct(vendorB.token, {
        title: `سه پایه ${RUN}`,
        slug: `tripod-${RUN}`,
        categoryId: cat.mirrorless.id,
        basePrice: 1_500_000,
        mediaIds: [media.b1],
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-PB-1`, colorName: 'مشکی', colorHex: '#000000', price: 1_500_000, stockQuantity: 4 }],
      });
      expect(pb.status).toBe(201);
      expect(pb.body.slug).toBe(`tripod-${RUN}`);
      product.pb = pb.body;
    });

    it('derives a fresh slug for a duplicate title and keeps drafts unpublished', async () => {
      const draft = await createProduct(vendorA.token, {
        title: `دوربین کهکشان ${RUN}`,
        categoryId: cat.mirrorless.id,
        basePrice: 2_000_000,
        variants: [{ sku: `E2E-${TAG}-D-1`, price: 2_000_000, stockQuantity: 5 }],
      });
      expect(draft.status).toBe(201);
      expect(draft.body.slug).not.toBe(product.p1.slug);
      expect(draft.body.isPublished).toBe(false);
      product.draft = draft.body;
    });

    it('enforces globally unique SKUs — across stores, case-insensitively, and within one request', async () => {
      const crossStore = await createProduct(vendorB.token, {
        ...baseBody(),
        variants: [{ sku: `e2e-${RUN}-p1-red-m`, price: 1_000_000, stockQuantity: 1 }],
      });
      expect(crossStore.status).toBe(409);

      const withinRequest = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [
          { sku: `E2E-${TAG}-DUP`, size: 'S', price: 1_000_000, stockQuantity: 1 },
          { sku: `E2E-${TAG}-DUP`, size: 'M', price: 1_000_000, stockQuantity: 1 },
        ],
      });
      expect(withinRequest.status).toBe(400);
      expect(await prisma.productVariant.count({ where: { sku: `E2E-${TAG}-DUP` } })).toBe(0);
    });

    it('rejects pricing violations: compareAtPrice ≤ price, zero price', async () => {
      const equal = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-1`, price: 1_000_000, compareAtPrice: 1_000_000, stockQuantity: 1 }],
      });
      expect(equal.status).toBe(400);

      const lower = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-2`, price: 1_000_000, compareAtPrice: 900_000, stockQuantity: 1 }],
      });
      expect(lower.status).toBe(400);

      const zero = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-3`, price: 0, stockQuantity: 1 }],
      });
      expect(zero.status).toBe(400);

      const negativeStock = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [{ sku: `E2E-${TAG}-PR-4`, price: 10, stockQuantity: -1 }],
      });
      expect(negativeStock.status).toBe(400);
    });

    it('rejects a duplicated matrix cell, foreign media, inactive categories and taken slugs', async () => {
      const cell = await createProduct(vendorA.token, {
        ...baseBody(),
        variants: [
          { sku: `E2E-${TAG}-C-1`, colorName: 'سفید', size: 'L', price: 10, stockQuantity: 1 },
          { sku: `E2E-${TAG}-C-2`, colorName: 'سفید', size: 'l', price: 10, stockQuantity: 1 },
        ],
      });
      expect(cell.status).toBe(400);

      const foreignMedia = await createProduct(vendorA.token, baseBody({ mediaIds: [media.b1] }));
      expect(foreignMedia.status).toBe(400);

      await prisma.category.update({ where: { id: cat.lenses.id }, data: { isActive: false } });
      await app.get(CategoriesService).invalidateTree();
      const inactive = await createProduct(vendorA.token, baseBody({ categoryId: cat.lenses.id }));
      expect(inactive.status).toBe(400);
      await prisma.category.update({ where: { id: cat.lenses.id }, data: { isActive: true } });
      await app.get(CategoriesService).invalidateTree();

      const takenSlug = await createProduct(vendorA.token, baseBody({ slug: `tripod-${RUN}` }));
      expect(takenSlug.status).toBe(409);
    });

    it('refuses to publish a product whose variants are all inactive', async () => {
      const response = await createProduct(vendorA.token, {
        ...baseBody(),
        isPublished: true,
        variants: [{ sku: `E2E-${TAG}-OFF-1`, price: 10, stockQuantity: 1, isActive: false }],
      });
      expect(response.status).toBe(400);
    });
  });

  // ─── 4. Vendor listing and detail ─────────────────────────────────────────

  describe('vendor listing and detail', () => {
    it('lists only the caller’s products, with stock summaries, search and status filter', async () => {
      const all = await request<Page<VendorProduct>>('/vendor/products?pageSize=50', { token: vendorA.token });
      expect(all.status).toBe(200);
      expect(all.body.total).toBe(4);
      expect(all.body.items.map((item) => item.id)).not.toContain(product.pb.id);
      const p1 = all.body.items.find((item) => item.id === product.p1.id)!;
      expect(p1.stock.totalStock).toBe(8);

      const drafts = await request<Page<VendorProduct>>('/vendor/products?status=draft', { token: vendorA.token });
      expect(drafts.body.items.map((item) => item.id)).toEqual([product.draft.id]);

      const bySku = await request<Page<VendorProduct>>(`/vendor/products?search=${encodeURIComponent(`E2E-${TAG}-P3`)}`, {
        token: vendorA.token,
      });
      expect(bySku.body.items.map((item) => item.id)).toEqual([product.p3.id]);

      const paged = await request<Page<VendorProduct>>('/vendor/products?pageSize=3&page=2', { token: vendorA.token });
      expect(paged.body).toMatchObject({ page: 2, pageSize: 3, total: 4, totalPages: 2 });
      expect(paged.body.items).toHaveLength(1);
    });

    it('returns full detail to the owner and 404 to any other store', async () => {
      const own = await request<VendorProduct>(`/vendor/products/${product.p1.id}`, { token: vendorA.token });
      expect(own.status).toBe(200);
      expect(own.body.variants).toHaveLength(3);
      expect(own.body.media).toHaveLength(2);

      expect((await request(`/vendor/products/${product.p1.id}`, { token: vendorB.token })).status).toBe(404);
      expect((await request('/vendor/products/not-a-uuid', { token: vendorA.token })).status).toBe(400);
    });
  });

  // ─── 5. Variant and product updates ───────────────────────────────────────

  describe('variant and product updates', () => {
    const variantOf = (p: VendorProduct, sku: string): Variant => p.variants!.find((variant) => variant.sku === sku)!;

    it('lets the owner change price and stock, audited with old and new values', async () => {
      const target = variantOf(product.draft, `E2E-${TAG}-D-1`);
      const response = await request<Variant>(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { price: 2_200_000, compareAtPrice: 2_500_000, stockQuantity: 9 },
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ price: '2200000.00', compareAtPrice: '2500000.00', stockQuantity: 9, discountPercent: 12 });

      const row = await prisma.productVariant.findUniqueOrThrow({ where: { id: target.id } });
      expect(row.price.toFixed(2)).toBe('2200000.00');
      expect(row.stockQuantity).toBe(9);

      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { entityId: target.id, entityName: 'ProductVariant', action: AuditAction.UPDATE },
        orderBy: { createdAt: 'desc' },
      });
      expect(audit.userId).toBe(vendorA.userId);
      expect(JSON.stringify(audit.oldValue)).toContain('2000000');
    });

    it('applies relative stock changes atomically and refuses to go below zero', async () => {
      const target = variantOf(product.draft, `E2E-${TAG}-D-1`);
      const down = await request<Variant>(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockDelta: -4 },
      });
      expect(down.status).toBe(200);
      expect(down.body.stockQuantity).toBe(5);

      const tooFar = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockDelta: -6 },
      });
      expect(tooFar.status).toBe(409);

      const both = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockDelta: 1, stockQuantity: 1 },
      });
      expect(both.status).toBe(400);

      const empty = await request(`/vendor/products/variants/${target.id}`, { method: 'PATCH', token: vendorA.token, body: {} });
      expect(empty.status).toBe(400);
    });

    it('rejects a new price that is not below the existing compareAtPrice; clearing it works', async () => {
      const target = variantOf(product.draft, `E2E-${TAG}-D-1`);
      const invalid = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { price: 2_600_000 },
      });
      expect(invalid.status).toBe(400);

      const cleared = await request<Variant>(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { price: 2_600_000, compareAtPrice: null },
      });
      expect(cleared.status).toBe(200);
      expect(cleared.body.compareAtPrice).toBeNull();
      expect(cleared.body.discountPercent).toBeNull();
    });

    it('gives another store 404 for every write on someone else’s product', async () => {
      const target = variantOf(product.p1, `E2E-${TAG}-P1-BLK-S`);
      const variantWrite = await request(`/vendor/products/variants/${target.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { stockQuantity: 999 },
      });
      expect(variantWrite.status).toBe(404);
      expect((await request(`/vendor/products/${product.p1.id}`, { method: 'PATCH', token: vendorB.token, body: { title: 'ربوده' } })).status).toBe(404);
      expect((await request(`/vendor/products/${product.p1.id}/variants`, { method: 'POST', token: vendorB.token, body: { sku: `E2E-${TAG}-X`, price: 1, stockQuantity: 1 } })).status).toBe(404);
      expect((await request(`/vendor/products/${product.p1.id}`, { method: 'DELETE', token: vendorB.token })).status).toBe(404);

      const untouched = await prisma.productVariant.findUniqueOrThrow({ where: { id: target.id } });
      expect(untouched.stockQuantity).toBe(5);
      expect((await prisma.product.findUniqueOrThrow({ where: { id: product.p1.id } })).isPublished).toBe(true);
    });

    it('adds a variant, rejecting duplicate SKUs and duplicate matrix cells', async () => {
      const added = await request<Variant>(`/vendor/products/${product.p1.id}/variants`, {
        method: 'POST',
        token: vendorA.token,
        body: { sku: `E2E-${TAG}-P1-RED-S`, colorName: 'قرمز', colorHex: '#FF0000', size: 'S', guarantee: 'گارانتی ۱۸ ماهه', price: 12_000_000, stockQuantity: 2 },
      });
      expect(added.status).toBe(201);
      expect(added.body.isActive).toBe(true);

      const sameSku = await request(`/vendor/products/${product.p1.id}/variants`, {
        method: 'POST',
        token: vendorA.token,
        body: { sku: `E2E-${TAG}-PB-1`, colorName: 'سبز', price: 1, stockQuantity: 1 },
      });
      expect(sameSku.status).toBe(409);

      const sameCell = await request(`/vendor/products/${product.p1.id}/variants`, {
        method: 'POST',
        token: vendorA.token,
        body: { sku: `E2E-${TAG}-P1-RED-S2`, colorName: 'قرمز', size: 's', guarantee: 'گارانتی ۱۸ ماهه', price: 1, stockQuantity: 1 },
      });
      expect(sameCell.status).toBe(409);

      // Deactivated again so the public fixtures below stay as designed.
      const off = await request<Variant>(`/vendor/products/variants/${added.body.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { isActive: false },
      });
      expect(off.status).toBe(200);
      expect(off.body.isActive).toBe(false);
    });

    it('refuses to deactivate the last active variant of a published product', async () => {
      const only = product.p3.variants![0]!;
      const response = await request(`/vendor/products/variants/${only.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { isActive: false },
      });
      expect(response.status).toBe(409);
    });

    it('re-orders the gallery with PATCH mediaIds and keeps the first image primary', async () => {
      const response = await request<VendorProduct>(`/vendor/products/${product.p1.id}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { mediaIds: [media.a1, media.a2] },
      });
      expect(response.status).toBe(200);
      expect(response.body.media!.map((entry) => entry.mediaAssetId)).toEqual([media.a1, media.a2]);
      expect(response.body.media![0]!.isPrimary).toBe(true);
      expect(await prisma.productMedia.count({ where: { productId: product.p1.id } })).toBe(2);
    });
  });

  // ─── 6. Inventory integrity ───────────────────────────────────────────────

  describe('inventory integrity (atomic, database-enforced)', () => {
    let variantId: string;

    beforeAll(() => {
      variantId = product.draft.variants![0]!.id;
    });

    it('never oversells under concurrent reservations', async () => {
      await inventory.setStock(variantId, 5);
      const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => inventory.reserve(variantId, 1)));
      expect(attempts.filter((attempt) => attempt.status === 'fulfilled')).toHaveLength(5);
      expect(attempts.filter((attempt) => attempt.status === 'rejected')).toHaveLength(7);

      const level = await inventory.level(variantId);
      expect(level).toMatchObject({ stockQuantity: 5, reservedQuantity: 5, availableQuantity: 0 });
    });

    it('does not let the vendor set stock below reserved units', async () => {
      const response = await request(`/vendor/products/variants/${variantId}`, {
        method: 'PATCH',
        token: vendorA.token,
        body: { stockQuantity: 3 },
      });
      expect(response.status).toBe(409);
      expect((await inventory.level(variantId))!.stockQuantity).toBe(5);
    });

    it('releases and commits reservations exactly', async () => {
      expect(await inventory.release(variantId, 2)).toMatchObject({ reservedQuantity: 3, availableQuantity: 2 });
      expect(await inventory.commitReservation(variantId, 3)).toMatchObject({ stockQuantity: 2, reservedQuantity: 0 });
      await expect(inventory.release(variantId, 1)).rejects.toThrow();
    });

    it('serialises concurrent relative decrements from the API', async () => {
      const results = await Promise.all(
        Array.from({ length: 4 }, () =>
          request(`/vendor/products/variants/${variantId}`, { method: 'PATCH', token: vendorA.token, body: { stockDelta: -1 } }),
        ),
      );
      expect(results.filter((result) => result.status === 200)).toHaveLength(2);
      expect(results.filter((result) => result.status === 409)).toHaveLength(2);
      expect((await inventory.level(variantId))!.stockQuantity).toBe(0);
    });

    it('is backed by CHECK constraints even for writes that bypass the API', async () => {
      await expect(prisma.productVariant.update({ where: { id: variantId }, data: { stockQuantity: -1 } })).rejects.toThrow();
      await expect(prisma.productVariant.update({ where: { id: variantId }, data: { reservedQuantity: 1 } })).rejects.toThrow();
      await expect(prisma.productVariant.update({ where: { id: variantId }, data: { price: 0 } })).rejects.toThrow();
      await expect(
        prisma.productVariant.update({ where: { id: variantId }, data: { compareAtPrice: 1 } }),
      ).rejects.toThrow();
    });
  });

  // ─── 7. Public discovery ──────────────────────────────────────────────────

  describe('public discovery', () => {
    const inRoot = { categorySlug: `e2e-cat-${RUN}`, pageSize: 50 };

    it('finds products by keyword in title, brand and description, tolerant of Arabic letters', async () => {
      const title = await search({ search: `کهکشان ${RUN}` });
      expect(slugs(title)).toEqual([product.p1.slug]);

      const arabic = await search({ search: `كهكشان ${RUN}` });
      expect(slugs(arabic)).toEqual([product.p1.slug]);

      const brand = await search({ ...inRoot, search: 'optika' });
      expect(slugs(brand)).toEqual([product.p2.slug]);

      const description = await search({ ...inRoot, search: 'ضدآب' });
      expect(slugs(description)).toEqual([product.p2.slug]);

      const nothing = await search({ search: `ناموجود-${RUN}-zzz` });
      expect(nothing.body.total).toBe(0);
    });

    it('treats LIKE wildcards in the search term literally', async () => {
      const wildcard = await search({ ...inRoot, search: '%' });
      expect(wildcard.status).toBe(200);
      expect(wildcard.body.total).toBe(0);
    });

    it('includes every descendant when filtering by category', async () => {
      const root = await search(inRoot);
      expect(root.body.total).toBe(4);
      expect(new Set(slugs(root))).toEqual(new Set([product.p1.slug, product.p2.slug, product.p3.slug, product.pb.slug]));

      const cams = await search({ categorySlug: cat.cams.slug, pageSize: 50 });
      expect(new Set(slugs(cams))).toEqual(new Set([product.p1.slug, product.p3.slug, product.pb.slug]));

      const deep = await search({ categoryId: cat.mirrorless.id, pageSize: 50 });
      expect(new Set(slugs(deep))).toEqual(new Set([product.p1.slug, product.pb.slug]));

      const lenses = await search({ categorySlug: cat.lenses.slug });
      expect(slugs(lenses)).toEqual([product.p2.slug]);

      const unknown = await search({ categorySlug: 'no-such-category' });
      expect(unknown.body).toMatchObject({ total: 0, items: [] });
    });

    it('never lists drafts, even when the search term matches', async () => {
      const response = await search({ ...inRoot, search: `کهکشان ${RUN}` });
      expect(slugs(response)).toEqual([product.p1.slug]);
      expect(slugs(response)).not.toContain(product.draft.slug);
    });

    it('returns the exact subset for price ranges (variant level)', async () => {
      const mid = await search({ ...inRoot, minPrice: 1_000_000, maxPrice: 4_000_000 });
      expect(new Set(slugs(mid))).toEqual(new Set([product.p2.slug, product.pb.slug]));

      const p1Only = await search({ ...inRoot, minPrice: 10_000_000 });
      expect(slugs(p1Only)).toEqual([product.p1.slug]);

      const cheap = await search({ ...inRoot, maxPrice: 500_000 });
      expect(slugs(cheap)).toEqual([product.p3.slug]);

      expect((await search({ minPrice: 5, maxPrice: 1 })).status).toBe(400);
    });

    it('returns the exact subset for inStockOnly', async () => {
      const inStock = await search({ ...inRoot, inStockOnly: true });
      expect(new Set(slugs(inStock))).toEqual(new Set([product.p1.slug, product.p3.slug, product.pb.slug]));

      const all = await search(inRoot);
      const p2 = all.body.items.find((item) => item.slug === product.p2.slug)!;
      expect(p2.inStock).toBe(false);
    });

    it('matches colour, size, price and stock on the same variant', async () => {
      const blackM = await search({ ...inRoot, colors: ['مشکی'], sizes: ['m'] });
      expect(slugs(blackM)).toEqual([product.p1.slug]);

      // P1's only black-M variant has no stock, so it must drop out.
      const blackMInStock = await search({ ...inRoot, colors: ['مشکی'], sizes: ['M'], inStockOnly: true });
      expect(blackMInStock.body.total).toBe(0);

      const black = await search({ ...inRoot, colors: ['#000000'] });
      expect(new Set(slugs(black))).toEqual(new Set([product.p1.slug, product.pb.slug]));

      const redS = await search({ ...inRoot, colors: ['#ff0000'], sizes: ['S'] });
      expect(redS.body.total).toBe(0); // the red-S variant exists but is inactive

      const commaList = await search({ ...inRoot, sizes: ['S,L'] });
      expect(new Set(slugs(commaList))).toEqual(new Set([product.p1.slug, product.p3.slug]));
    });

    it('filters by store', async () => {
      const b = await search({ ...inRoot, vendorSlug: vendorB.storeSlug });
      expect(slugs(b)).toEqual([product.pb.slug]);
      expect(b.body.items[0]!.vendor.storeSlug).toBe(vendorB.storeSlug);
    });

    it('sorts by newest, price ascending and price descending', async () => {
      const newest = await search({ ...inRoot, sortBy: 'newest' });
      expect(slugs(newest)).toEqual([product.pb.slug, product.p3.slug, product.p2.slug, product.p1.slug]);

      const asc = await search({ ...inRoot, sortBy: 'price_asc' });
      expect(slugs(asc)).toEqual([product.p3.slug, product.pb.slug, product.p2.slug, product.p1.slug]);

      const desc = await search({ ...inRoot, sortBy: 'price_desc' });
      expect(slugs(desc)).toEqual([product.p1.slug, product.p2.slug, product.pb.slug, product.p3.slug]);
    });

    it('sorts by units actually sold, ignoring cancelled orders, with newest as the tie-breaker', async () => {
      const zero = await search({ ...inRoot, sortBy: 'popular' });
      expect(slugs(zero)).toEqual(slugs(await search({ ...inRoot, sortBy: 'newest' })));

      const line = async (suffix: string, sku: string, quantity: number, status: SubOrderStatus): Promise<void> => {
        const variant = await prisma.productVariant.findUniqueOrThrow({
          where: { sku },
          include: { product: { include: { vendor: true } } },
        });
        const amount = variant.price.mul(quantity);
        await prisma.parentOrder.create({
          data: {
            orderNumber: `${ORDER_PREFIX}${suffix}`,
            userId: customer.userId,
            shippingAddressSnapshot: { city: 'تهران', recipientName: 'آزمون' },
            totalItemsAmount: amount,
            finalPayableAmount: amount,
            paymentMethod: PaymentMethod.CASH_IPG,
            paymentStatus: 'PAID',
            subOrders: {
              create: {
                vendorId: variant.product.vendorId,
                subOrderNumber: `${ORDER_PREFIX}${suffix}-1`,
                itemsSubtotal: amount,
                platformCommissionAmount: 0,
                vendorEarningsAmount: amount,
                status,
                items: {
                  create: {
                    productVariantId: variant.id,
                    productTitleSnapshot: variant.product.title,
                    vendorStoreNameSnapshot: variant.product.vendor.storeName,
                    skuSnapshot: variant.sku,
                    variantDetailsSnapshot: {},
                    unitPriceSnapshot: variant.price,
                    discountSnapshot: 0,
                    commissionRateSnapshot: 0,
                    quantity,
                    totalLineAmount: amount,
                  },
                },
              },
            },
          },
        });
      };

      await line('A', `E2E-${TAG}-PB-1`, 3, SubOrderStatus.DELIVERED);
      await line('B', `E2E-${TAG}-P2-1`, 1, SubOrderStatus.PROCESSING);
      await line('C', `E2E-${TAG}-P3-1`, 50, SubOrderStatus.CANCELLED);
      await line('D', `E2E-${TAG}-P3-1`, 7, SubOrderStatus.REFUNDED);

      const popular = await search({ ...inRoot, sortBy: 'popular' });
      expect(slugs(popular)).toEqual([product.pb.slug, product.p2.slug, product.p3.slug, product.p1.slug]);
    });

    it('paginates with a consistent total', async () => {
      const page2 = await search({ ...inRoot, pageSize: 1, page: 2, sortBy: 'newest' });
      expect(page2.body).toMatchObject({ page: 2, pageSize: 1, total: 4, totalPages: 4 });
      expect(slugs(page2)).toEqual([product.p3.slug]);

      const beyond = await search({ ...inRoot, pageSize: 10, page: 9 });
      expect(beyond.body).toMatchObject({ total: 4, items: [] });
    });

    it('returns thumbnail, price range, options, discount and vendor for each item', async () => {
      const response = await search({ search: `کهکشان ${RUN}` });
      const item = response.body.items[0]!;
      expect(item.priceRange).toEqual({ min: '10000000.00', max: '12500000.00' });
      // Variants have no sort column: order is createdAt, then SKU (…BLK-M < …BLK-S < …RED-M).
      expect(item.sizes).toEqual(['M', 's']);
      expect(item.colors).toEqual([
        { name: 'مشکی', hex: '#000000' },
        { name: 'قرمز', hex: '#FF0000' },
      ]);
      expect(item.maxDiscountPercent).toBe(16);
      // The strike-through price that belongs to priceRange.min (the 10,000,000 variant).
      expect(item.startingCompareAtPrice).toBe('12000000.00');
      expect(item.inStock).toBe(true);
      expect(item.vendor.storeSlug).toBe(vendorA.storeSlug);
      expect(item.category.slug).toBe(cat.mirrorless.slug);

      const primary = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.a1 } });
      expect(item.primaryImage!.url).toContain(primary.path);
      expect(item.primaryImage!.thumbnailUrl).not.toBeNull();
    });

    it('returns the product page with breadcrumbs, store, full gallery and every active variant', async () => {
      const response = await request<{
        breadcrumbs: Array<{ slug: string }>;
        vendor: { storeSlug: string; bio: string | null };
        media: Array<{ url: string; thumbnailUrl: string | null }>;
        variants: Array<{ sku: string; availableQuantity: number; inStock: boolean }>;
        description: string;
      }>(`/products/${product.p1.slug}`);

      expect(response.status).toBe(200);
      expect(response.body.breadcrumbs.map((crumb) => crumb.slug)).toEqual([cat.root.slug, cat.cams.slug, cat.mirrorless.slug]);
      expect(response.body.vendor.storeSlug).toBe(vendorA.storeSlug);
      expect(response.body.vendor.bio).not.toBeNull();
      expect(response.body.description).toContain('فول‌فریم');
      expect(response.body.media).toHaveLength(2);

      const [first, second] = await Promise.all([
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.a1 } }),
        prisma.mediaAsset.findUniqueOrThrow({ where: { id: media.a2 } }),
      ]);
      expect(response.body.media[0]!.url).toContain(first.path);
      expect(response.body.media[1]!.url).toContain(second.path);

      const variants = new Map(response.body.variants.map((variant) => [variant.sku, variant]));
      expect([...variants.keys()].sort()).toEqual(
        [`E2E-${TAG}-P1-BLK-M`, `E2E-${TAG}-P1-BLK-S`, `E2E-${TAG}-P1-RED-M`].sort(),
      ); // the inactive red-S variant is not shown
      expect(variants.get(`E2E-${TAG}-P1-BLK-S`)).toMatchObject({ availableQuantity: 5, inStock: true });
      expect(variants.get(`E2E-${TAG}-P1-BLK-M`)).toMatchObject({ availableQuantity: 0, inStock: false });
    });

    it('shows live stock: a reservation is reflected immediately', async () => {
      const variant = product.p1.variants!.find((entry) => entry.sku === `E2E-${TAG}-P1-RED-M`)!;
      await inventory.reserve(variant.id, 2);
      const response = await request<{ variants: Array<{ sku: string; availableQuantity: number }> }>(`/products/${product.p1.slug}`);
      expect(response.body.variants.find((entry) => entry.sku === variant.sku)!.availableQuantity).toBe(1);
      await inventory.release(variant.id, 2);
    });

    it('404s for drafts and unknown slugs', async () => {
      expect((await request(`/products/${product.draft.slug}`)).status).toBe(404);
      expect((await request('/products/no-such-product')).status).toBe(404);
    });

    it('reflects visible products in the category tree counts', async () => {
      const tree = await request<{ items: TreeNode[] }>('/categories/tree');
      const root = findNode(tree.body.items, cat.root.slug)!;
      expect(root.productCount).toBe(0);
      expect(root.totalProductCount).toBe(4);
      expect(findNode(tree.body.items, cat.mirrorless.slug)!.productCount).toBe(2);
      expect(findNode(tree.body.items, cat.cams.slug)!.totalProductCount).toBe(3);
    });
  });

  // ─── 8. Staff moderation ──────────────────────────────────────────────────

  describe('staff moderation', () => {
    const status = (token: string, body: Record<string, unknown>, id = product.pb.id): Promise<HttpResult<{
      product: { isPublished: boolean; moderation: { isBlockedByAdmin: boolean; blockedReason: string | null }; blockedByUserId: string | null };
      auditLogId: string;
      changed: string[];
    }>> => request(`/admin/products/${id}/status`, { method: 'PATCH', token, body });

    it('lets SUPPORT browse but not moderate; vendors cannot reach it at all', async () => {
      const list = await request<Page<{ id: string }>>(`/admin/products?vendorSlug=${vendorB.storeSlug}`, { token: supportToken });
      expect(list.status).toBe(200);
      expect(list.body.items.map((item) => item.id)).toEqual([product.pb.id]);

      expect((await status(supportToken, { isBlockedByAdmin: true, blockedReason: 'تصویر نامناسب' })).status).toBe(403);
      expect((await status(vendorA.token, { isBlockedByAdmin: true, blockedReason: 'تصویر نامناسب' })).status).toBe(403);
      expect((await request(`/admin/products`, { token: vendorA.token })).status).toBe(403);
    });

    it('requires a reason to block', async () => {
      expect((await status(adminToken, { isBlockedByAdmin: true })).status).toBe(400);
      expect((await status(adminToken, { blockedReason: 'بدون مسدودسازی' })).status).toBe(400);
      expect((await status(adminToken, {})).status).toBe(400);
    });

    it('blocks: unpublishes, removes from the storefront and writes an audit row', async () => {
      const response = await status(adminToken, { isBlockedByAdmin: true, blockedReason: 'اطلاعات گارانتی نادرست است' });
      expect(response.status).toBe(200);
      expect(response.body.product.isPublished).toBe(false);
      expect(response.body.product.moderation).toMatchObject({ isBlockedByAdmin: true, blockedReason: 'اطلاعات گارانتی نادرست است' });

      const audit = await prisma.auditLog.findUniqueOrThrow({ where: { id: response.body.auditLogId } });
      expect(audit.action).toBe(AuditAction.STATUS_CHANGE);
      expect(audit.entityId).toBe(product.pb.id);

      expect((await request(`/products/${product.pb.slug}`)).status).toBe(404);
      expect(slugs(await search({ categorySlug: `e2e-cat-${RUN}`, pageSize: 50 }))).not.toContain(product.pb.slug);

      const blocked = await request<Page<{ id: string }>>('/admin/products?isBlockedByAdmin=true&pageSize=100', { token: adminToken });
      expect(blocked.body.items.map((item) => item.id)).toContain(product.pb.id);

      const vendorView = await request<VendorProduct>(`/vendor/products/${product.pb.id}`, { token: vendorB.token });
      expect(vendorView.body.moderation.blockedReason).toBe('اطلاعات گارانتی نادرست است');
    });

    it('stops the vendor — and staff — from publishing a blocked product', async () => {
      const vendorPublish = await request(`/vendor/products/${product.pb.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { isPublished: true },
      });
      expect(vendorPublish.status).toBe(403);

      expect((await status(adminToken, { isPublished: true })).status).toBe(409);

      // Other edits remain possible while blocked, so the vendor can fix the problem.
      const edit = await request(`/vendor/products/${product.pb.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { description: 'گارانتی ۱۲ ماهه شرکتی' },
      });
      expect(edit.status).toBe(200);
    });

    it('unblocks without republishing; the vendor can then publish again', async () => {
      const lifted = await status(adminToken, { isBlockedByAdmin: false });
      expect(lifted.status).toBe(200);
      expect(lifted.body.product.isPublished).toBe(false);
      expect(lifted.body.product.moderation.isBlockedByAdmin).toBe(false);
      expect(lifted.body.product.blockedByUserId).toBeNull();

      const published = await request<VendorProduct>(`/vendor/products/${product.pb.id}`, {
        method: 'PATCH',
        token: vendorB.token,
        body: { isPublished: true },
      });
      expect(published.status).toBe(200);
      expect((await request(`/products/${product.pb.slug}`)).status).toBe(200);
    });

    it('hides a suspended store’s products and freezes its writes, but keeps its reads', async () => {
      await prisma.vendor.update({ where: { id: vendorB.vendorId }, data: { status: VendorStatus.SUSPENDED } });
      try {
        expect((await request(`/products/${product.pb.slug}`)).status).toBe(404);
        expect((await request(`/vendor/products/${product.pb.id}`, { token: vendorB.token })).status).toBe(200);
        const write = await request(`/vendor/products/${product.pb.id}`, {
          method: 'PATCH',
          token: vendorB.token,
          body: { title: 'تغییر در حالت تعلیق' },
        });
        expect(write.status).toBe(403);
      } finally {
        await prisma.vendor.update({ where: { id: vendorB.vendorId }, data: { status: VendorStatus.APPROVED } });
      }
      expect((await request(`/products/${product.pb.slug}`)).status).toBe(200);
    });
  });

  // ─── 9. Archive (soft delete) ─────────────────────────────────────────────

  describe('archive', () => {
    it('unpublishes, keeps every row, and is idempotent', async () => {
      const first = await request<{ isPublished: boolean; wasPublished: boolean; auditLogId: string | null }>(
        `/vendor/products/${product.p3.id}`,
        { method: 'DELETE', token: vendorA.token },
      );
      expect(first.status).toBe(200);
      expect(first.body).toMatchObject({ isPublished: false, wasPublished: true });
      expect(first.body.auditLogId).not.toBeNull();

      const second = await request<{ wasPublished: boolean; auditLogId: string | null }>(`/vendor/products/${product.p3.id}`, {
        method: 'DELETE',
        token: vendorA.token,
      });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ wasPublished: false, auditLogId: null });

      expect((await request(`/products/${product.p3.slug}`)).status).toBe(404);
      const row = await prisma.product.findUniqueOrThrow({ where: { id: product.p3.id }, include: { variants: true } });
      expect(row.isPublished).toBe(false);
      expect(row.variants).toHaveLength(1);
    });
  });

  // ─── 10. OpenAPI contract ─────────────────────────────────────────────────

  describe('OpenAPI documentation', () => {
    it('documents every Phase-5 endpoint, secured where it must be', () => {
      const document = buildOpenApiDocument(app) as unknown as {
        paths: Record<string, Record<string, { tags?: string[]; security?: unknown[]; responses: Record<string, unknown> }>>;
        tags?: Array<{ name: string }>;
      };
      const expected: Array<[string, string]> = [
        ['/api/v1/categories/tree', 'get'],
        ['/api/v1/categories/{slug}', 'get'],
        ['/api/v1/admin/categories', 'get'],
        ['/api/v1/admin/categories', 'post'],
        ['/api/v1/admin/categories/{id}', 'patch'],
        ['/api/v1/vendor/products', 'post'],
        ['/api/v1/vendor/products', 'get'],
        ['/api/v1/vendor/products/{id}', 'get'],
        ['/api/v1/vendor/products/{id}', 'patch'],
        ['/api/v1/vendor/products/{id}', 'delete'],
        ['/api/v1/vendor/products/{id}/variants', 'post'],
        ['/api/v1/vendor/products/variants/{variantId}', 'patch'],
        ['/api/v1/products', 'get'],
        ['/api/v1/products/{slug}', 'get'],
        ['/api/v1/admin/products', 'get'],
        ['/api/v1/admin/products/{id}/status', 'patch'],
      ];
      for (const [path, method] of expected) {
        const operation = document.paths[path]?.[method];
        expect(operation).toBeDefined();
        expect(operation!.tags?.length).toBeGreaterThan(0);
        expect(Object.keys(operation!.responses).length).toBeGreaterThan(0);
        const isPublic = path.startsWith('/api/v1/products') || path.startsWith('/api/v1/categories');
        if (isPublic) expect(operation!.security ?? []).toEqual([]);
        else expect(operation!.security?.length).toBeGreaterThan(0);
      }
      const tags = (document.tags ?? []).map((tag) => tag.name);
      expect(tags).toEqual(expect.arrayContaining(['categories', 'admin-categories', 'products', 'vendor-products', 'admin-products']));
    });
  });
});
```

### `apps/backend/test/setup-env.ts`

```ts
import { config as loadDotenv } from 'dotenv';

import { resolveEnvFilePaths } from '../src/config/env-file-paths';

/**
 * Jest setup file for the end-to-end suites.
 *
 * The application loads the root `.env` through `ConfigModule`; test suites that
 * talk to PostgreSQL and Redis directly (without booting Nest) need the same
 * values in `process.env`. Both call {@link resolveEnvFilePaths}, so the list of
 * environment files has exactly one definition.
 *
 * `override: false` keeps variables that CI already exported (secrets injected by
 * the pipeline take precedence over the checked-out file).
 */
// The suites assert the callback's JSON contract. A developer `.env` points the
// callback at the storefront result page (303), so the e2e run pins JSON mode
// explicitly (an empty value means "unset" to the env validation). The redirect
// query itself is covered by payments.controller.spec.ts.
process.env.PAYMENT_RESULT_REDIRECT_URL ??= '';

for (const envFilePath of resolveEnvFilePaths()) {
  loadDotenv({ path: envFilePath, override: false, quiet: true });
}
```

## 13. Diff of previously tracked files (vs `a7c6cb7`)

```diff
diff --git a/.env.example b/.env.example
index 6b852f1..a31b1f6 100644
--- a/.env.example
+++ b/.env.example
@@ -177,7 +177,10 @@ ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=60
 # ─── Payments (Phase 7) ────────────────────────────────────────────────────
 # Origin the customer's browser and the bank reach this API on (no path). The
 # gateway callback is ${PUBLIC_API_ORIGIN}/api/v1/payments/callback.
-PUBLIC_API_ORIGIN=http://localhost:4000
+# With the Next.js frontend (Phase 10) this is the FRONTEND origin: its /api/v1
+# BFF forwards to the backend, so the bank page, the callback and the result
+# page all live on the one origin the browser already has cookies for.
+PUBLIC_API_ORIGIN=http://localhost:3000
 # `sandbox` = built-in simulated bank page (development/test ONLY; the API
 # refuses to boot with it in production). `zarinpal` = Zarinpal IPG v4.
 PAYMENT_GATEWAY_PROVIDER=sandbox
@@ -187,8 +190,9 @@ ZARINPAL_MERCHANT_ID=
 ZARINPAL_API_BASE_URL=https://payment.zarinpal.com
 # Timeout of one gateway API call, in milliseconds.
 PAYMENT_GATEWAY_TIMEOUT_MS=15000
-# Optional frontend result page; empty = the callback answers with JSON.
-PAYMENT_RESULT_REDIRECT_URL=
+# Frontend result page; empty = the callback answers with JSON. The storefront
+# page is /payment/result (query: orderNumber, outcome, paymentId, parentOrderId, rrn).
+PAYMENT_RESULT_REDIRECT_URL=/payment/result
 # An INITIATED payment protects its order from the expiry sweeper this long.
 PAYMENT_CALLBACK_GRACE_MINUTES=20
 
diff --git a/apps/backend/src/modules/payments/payments.controller.ts b/apps/backend/src/modules/payments/payments.controller.ts
index 55155c4..8105f17 100644
--- a/apps/backend/src/modules/payments/payments.controller.ts
+++ b/apps/backend/src/modules/payments/payments.controller.ts
@@ -32,7 +32,8 @@ const CALLBACK_DESCRIPTION =
   'On success the order becomes PAID in one transaction (stock committed, each store’s earnings held in escrow, packages visible to ' +
   'vendors as PENDING_APPROVAL, Payment SUCCESSFUL with the bank RRN). On failure the Payment becomes FAILED and the order stays ' +
   'PENDING with its stock reserved, so the customer can retry until the payment window closes. Repeated callbacks return the same ' +
-  'outcome without a second verification. Answers JSON, or a 303 redirect to PAYMENT_RESULT_REDIRECT_URL when that is configured.';
+  'outcome without a second verification. Answers JSON, or a 303 redirect to PAYMENT_RESULT_REDIRECT_URL when that is configured ' +
+  '(query: orderNumber, outcome, paymentId, parentOrderId and rrn when the bank returned one).';
 
 @ApiTags('payments')
 @Controller('payments')
@@ -113,10 +114,30 @@ export class PaymentsController {
     void reply.header('Cache-Control', 'no-store');
     if (this.resultRedirectUrl) {
       const separator = this.resultRedirectUrl.includes('?') ? '&' : '?';
-      const query = new URLSearchParams({ orderNumber: outcome.orderNumber, outcome: outcome.outcome, paymentId: outcome.paymentId });
+      const query = buildResultRedirectQuery(outcome);
       await reply.status(HttpStatus.SEE_OTHER).header('Location', `${this.resultRedirectUrl}${separator}${query.toString()}`).send();
       return;
     }
     await reply.status(HttpStatus.OK).send(outcome);
   }
 }
+
+/**
+ * Query string of the storefront result page. It carries only what the
+ * customer already sees on the bank page (order number, outcome, payment id,
+ * the bank's retrieval reference number) plus the order id for the "track my
+ * order" link, and the purpose (checkout vs instalment repayment) — the result page re-reads the order itself before trusting it.
+ */
+export function buildResultRedirectQuery(outcome: PaymentOutcomeDto): URLSearchParams {
+  const query = new URLSearchParams({
+    orderNumber: outcome.orderNumber,
+    outcome: outcome.outcome,
+    paymentId: outcome.paymentId,
+    parentOrderId: outcome.parentOrderId,
+    purpose: outcome.purpose,
+  });
+  if (outcome.bankRrn !== null) {
+    query.set('rrn', outcome.bankRrn);
+  }
+  return query;
+}
diff --git a/apps/backend/src/modules/products/catalog-search.service.ts b/apps/backend/src/modules/products/catalog-search.service.ts
index 345fa75..8783e2f 100644
--- a/apps/backend/src/modules/products/catalog-search.service.ts
+++ b/apps/backend/src/modules/products/catalog-search.service.ts
@@ -11,6 +11,7 @@ import { COLOR_HEX_PATTERN } from './product-rules';
 import {
   imageRef,
   maxDiscountPercent,
+  startingCompareAtPrice,
   mediaSelect,
   priceRange,
   toPublicVariant,
@@ -135,6 +136,7 @@ export class CatalogSearchService {
           primaryImage: imageRef(product.media[0]),
           priceRange: priceRange(product.variants) ?? { min: '0.00', max: '0.00' },
           maxDiscountPercent: maxDiscountPercent(product.variants),
+          startingCompareAtPrice: startingCompareAtPrice(product.variants),
           colors: options.colors,
           sizes: options.sizes,
           inStock: product.variants.some(hasStock),
diff --git a/apps/backend/src/modules/products/dto/product-response.dto.ts b/apps/backend/src/modules/products/dto/product-response.dto.ts
index 468ef62..a429794 100644
--- a/apps/backend/src/modules/products/dto/product-response.dto.ts
+++ b/apps/backend/src/modules/products/dto/product-response.dto.ts
@@ -263,6 +263,14 @@ export class PublicProductListItemDto {
   @ApiProperty({ nullable: true, type: Number, example: 22, description: 'Largest discount among active variants.' })
   maxDiscountPercent!: number | null;
 
+  @ApiProperty({
+    nullable: true,
+    type: String,
+    example: '52000000.00',
+    description: 'Compare-at (strike-through) price of the cheapest active variant — the one priceRange.min comes from; null when that variant has no discount.',
+  })
+  startingCompareAtPrice!: string | null;
+
   @ApiProperty({ type: () => [ColorOptionDto] })
   colors!: ColorOptionDto[];
 
diff --git a/apps/backend/src/modules/products/product-views.ts b/apps/backend/src/modules/products/product-views.ts
index 75a940d..60cf387 100644
--- a/apps/backend/src/modules/products/product-views.ts
+++ b/apps/backend/src/modules/products/product-views.ts
@@ -108,6 +108,26 @@ export function maxDiscountPercent(variants: readonly PricedVariant[]): number |
   return best;
 }
 
+/**
+ * Strike-through price that belongs to the listing's "from" price: the
+ * compare-at price of the cheapest active variant, or null when that variant
+ * is not discounted. (A product card shows `priceRange.min` next to it, so a
+ * compare-at price of a different variant would misstate the discount.)
+ */
+export function startingCompareAtPrice(variants: readonly PricedVariant[]): string | null {
+  let cheapest: PricedVariant | null = null;
+  for (const variant of variants) {
+    if (!variant.isActive) continue;
+    if (cheapest === null || variant.price.lt(cheapest.price)) {
+      cheapest = variant;
+    }
+  }
+  if (cheapest === null || cheapest.compareAtPrice === null || !cheapest.compareAtPrice.greaterThan(cheapest.price)) {
+    return null;
+  }
+  return money(cheapest.compareAtPrice);
+}
+
 export function stockSummary(variants: readonly StockedVariant[]): StockSummaryDto {
   const active = variants.filter((variant) => variant.isActive);
   const totalStock = active.reduce((sum, variant) => sum + variant.stockQuantity, 0);
diff --git a/apps/backend/test/catalog.e2e-spec.ts b/apps/backend/test/catalog.e2e-spec.ts
index cb9da84..38ef0c8 100644
--- a/apps/backend/test/catalog.e2e-spec.ts
+++ b/apps/backend/test/catalog.e2e-spec.ts
@@ -113,6 +113,7 @@ interface ListItem {
   vendor: { storeSlug: string };
   category: { slug: string };
   maxDiscountPercent: number | null;
+  startingCompareAtPrice: string | null;
 }
 
 interface Page<T> {
@@ -1238,6 +1239,8 @@ describe('Phase 5 — categories, product catalogue and discovery (live stack)',
         { name: 'قرمز', hex: '#FF0000' },
       ]);
       expect(item.maxDiscountPercent).toBe(16);
+      // The strike-through price that belongs to priceRange.min (the 10,000,000 variant).
+      expect(item.startingCompareAtPrice).toBe('12000000.00');
       expect(item.inStock).toBe(true);
       expect(item.vendor.storeSlug).toBe(vendorA.storeSlug);
       expect(item.category.slug).toBe(cat.mirrorless.slug);
diff --git a/apps/backend/test/setup-env.ts b/apps/backend/test/setup-env.ts
index 4842586..8af95e2 100644
--- a/apps/backend/test/setup-env.ts
+++ b/apps/backend/test/setup-env.ts
@@ -13,6 +13,12 @@ import { resolveEnvFilePaths } from '../src/config/env-file-paths';
  * `override: false` keeps variables that CI already exported (secrets injected by
  * the pipeline take precedence over the checked-out file).
  */
+// The suites assert the callback's JSON contract. A developer `.env` points the
+// callback at the storefront result page (303), so the e2e run pins JSON mode
+// explicitly (an empty value means "unset" to the env validation). The redirect
+// query itself is covered by payments.controller.spec.ts.
+process.env.PAYMENT_RESULT_REDIRECT_URL ??= '';
+
 for (const envFilePath of resolveEnvFilePaths()) {
   loadDotenv({ path: envFilePath, override: false, quiet: true });
 }
diff --git a/apps/frontend/next.config.ts b/apps/frontend/next.config.ts
index c0a7c55..38808b2 100644
--- a/apps/frontend/next.config.ts
+++ b/apps/frontend/next.config.ts
@@ -6,15 +6,14 @@ import type { NextConfig } from 'next';
 /**
  * The repository keeps a single `.env` at its root, shared with the backend and
  * docker-compose. Next.js only reads environment files from its own project
- * directory, so the workspace root is loaded explicitly here.
+ * directory, so the workspace root is loaded explicitly here. `forceReload` is
+ * required: Next.js has already called loadEnvConfig for the app directory by
+ * the time this file runs, and without it @next/env returns that cached result
+ * (leaving e.g. BACKEND_INTERNAL_URL unset under `next start`). Variables
+ * already present in the real process environment still take precedence.
  */
 const workspaceRoot = path.resolve(process.cwd(), '..', '..');
-loadEnvConfig(workspaceRoot, process.env.NODE_ENV !== 'production');
-
-const backendInternalUrl = (process.env.BACKEND_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(
-  /\/+$/,
-  '',
-);
+loadEnvConfig(workspaceRoot, process.env.NODE_ENV !== 'production', console, true);
 
 const allowedDevOrigins = (process.env.NEXT_ALLOWED_DEV_ORIGINS ?? '*.e2b.app')
   .split(',')
@@ -32,16 +31,13 @@ const nextConfig: NextConfig = {
   // Remote development sandboxes and tunnels reach the dev server through a
   // different origin; without this, Next.js refuses to serve its dev assets.
   allowedDevOrigins,
-  async rewrites() {
-    // The browser talks to the Next.js origin only. Requests under /api/* are
-    // forwarded server-side to the backend, which keeps the API on a single
-    // public origin (no CORS in the browser, no backend URL in client bundles).
-    return [
-      {
-        source: '/api/:path*',
-        destination: `${backendInternalUrl}/api/:path*`,
-      },
-    ];
+  // No /api rewrite: the browser's /api/* calls are served by the BFF route
+  // handlers (src/app/api/session, src/app/api/v1/[...path]) which keep the
+  // JWTs in httpOnly cookies and forward to BACKEND_INTERNAL_URL server-side.
+  // (An afterFiles rewrite would also shadow the dynamic proxy route.)
+  images: {
+    // Product/store images are served by the backend through the same-origin proxy.
+    unoptimized: true,
   },
 };
 
diff --git a/apps/frontend/package.json b/apps/frontend/package.json
index 55474a9..da27b35 100644
--- a/apps/frontend/package.json
+++ b/apps/frontend/package.json
@@ -16,9 +16,11 @@
   "dependencies": {
     "@next/env": "15.5.26",
     "axios": "^1.20.0",
+    "lucide-react": "^1.48.0",
     "next": "^15.5.26",
     "react": "^19.3.0",
-    "react-dom": "^19.3.0"
+    "react-dom": "^19.3.0",
+    "vazirmatn": "^33.0.3"
   },
   "devDependencies": {
     "@eslint/eslintrc": "^3.3.7",
diff --git a/apps/frontend/src/app/globals.css b/apps/frontend/src/app/globals.css
index 0782475..a5be1f0 100644
--- a/apps/frontend/src/app/globals.css
+++ b/apps/frontend/src/app/globals.css
@@ -1,18 +1,20 @@
 @import "tailwindcss";
 
 /*
- * Shopino design tokens. Persian text needs a font stack with full Arabic
- * script coverage; Vazirmatn/IRANSans are preferred when the operating system
- * provides them, with Tahoma as the widely available fallback.
+ * Shopino design tokens. Vazirmatn is self-hosted through next/font (see
+ * src/app/fonts.ts, exposed as --font-vazirmatn); the rest of the stack is the
+ * system fallback with full Arabic-script coverage.
  */
 @theme {
-  --font-sans: "Vazirmatn", "IRANSansX", "IRANSans", "Segoe UI", Tahoma, system-ui, sans-serif;
+  --font-sans: var(--font-vazirmatn), "Vazirmatn", "IRANSansX", "IRANSans", "Segoe UI", Tahoma, system-ui, sans-serif;
 
   --color-brand-50: #eff6ff;
   --color-brand-100: #dbeafe;
+  --color-brand-400: #60a5fa;
   --color-brand-500: #2563eb;
   --color-brand-600: #1d4ed8;
   --color-brand-700: #1e40af;
+  --color-brand-900: #172554;
 
   --color-surface: #ffffff;
   --color-surface-muted: #f8fafc;
@@ -25,3 +27,29 @@ html {
 body {
   font-family: var(--font-sans);
 }
+
+/* Dual-thumb price slider: two range inputs stacked on one track. */
+.range-thumb {
+  pointer-events: none;
+  appearance: none;
+  background: transparent;
+}
+.range-thumb::-webkit-slider-thumb {
+  pointer-events: auto;
+  appearance: none;
+  height: 1.1rem;
+  width: 1.1rem;
+  border-radius: 9999px;
+  background: #fff;
+  border: 3px solid var(--color-brand-600);
+  cursor: pointer;
+}
+.range-thumb::-moz-range-thumb {
+  pointer-events: auto;
+  height: 1.1rem;
+  width: 1.1rem;
+  border-radius: 9999px;
+  background: #fff;
+  border: 3px solid var(--color-brand-600);
+  cursor: pointer;
+}
diff --git a/apps/frontend/src/app/layout.tsx b/apps/frontend/src/app/layout.tsx
index 2599927..7ac30ca 100644
--- a/apps/frontend/src/app/layout.tsx
+++ b/apps/frontend/src/app/layout.tsx
@@ -1,20 +1,37 @@
-import type { Metadata } from 'next';
+import type { Metadata, Viewport } from 'next';
 import type { ReactNode } from 'react';
 
+import { CartProvider } from '@/components/providers/cart-provider';
+import { SessionProvider } from '@/components/providers/session-provider';
+import { ToastProvider } from '@/components/providers/toast-provider';
+import { getServerSession } from '@/lib/api/server';
+
+import { vazirmatn } from './fonts';
 import './globals.css';
 
 export const metadata: Metadata = {
-  title: 'شاپینو | وضعیت سامانه',
-  description: 'پلتفرم چندفروشندگی شاپینو با امکان خرید اعتباری (BNPL)',
+  title: { default: 'شاپینو | خرید آنلاین با امکان پرداخت اقساطی', template: '%s | شاپینو' },
+  description: 'بازار آنلاین چندفروشندگی شاپینو — خرید نقدی یا اقساطی (BNPL) از فروشگاه‌های تأییدشده.',
+};
+
+export const viewport: Viewport = {
+  themeColor: '#1d4ed8',
 };
 
-export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
+export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
+  // First render already knows who is signed in (no flash of the anonymous header).
+  const session = await getServerSession();
   return (
-    // dir="rtl" + lang="fa": the whole application is right-to-left by default,
-    // and Tailwind's logical utilities (ps-*, pe-*, ms-*, me-*, text-start…)
-    // follow this direction automatically.
-    <html lang="fa" dir="rtl">
-      <body className="min-h-screen bg-surface-muted text-slate-900 antialiased">{children}</body>
+    // dir="rtl" + lang="fa": the whole application is right-to-left; Tailwind's
+    // logical utilities (ps-*, pe-*, ms-*, me-*, text-start…) follow it.
+    <html lang="fa" dir="rtl" className={vazirmatn.variable}>
+      <body className="min-h-screen bg-surface-muted text-slate-900 antialiased">
+        <SessionProvider initial={session}>
+          <ToastProvider>
+            <CartProvider>{children}</CartProvider>
+          </ToastProvider>
+        </SessionProvider>
+      </body>
     </html>
   );
 }
diff --git a/apps/frontend/src/app/status/page.tsx b/apps/frontend/src/app/status/page.tsx
new file mode 100644
index 0000000..f099e76
--- /dev/null
+++ b/apps/frontend/src/app/status/page.tsx
@@ -0,0 +1,37 @@
+import { SystemHealthPanel } from '@/components/system-health-panel';
+import { getSystemHealthServerSide } from '@/lib/api/health.server';
+import type { SystemHealth } from '@/lib/api/health';
+
+export const dynamic = 'force-dynamic';
+
+export default async function HomePage() {
+  // Server-side call at request time: the page always shows the live state of
+  // the API (database, Redis, memory, uptime), never cached output.
+  let initialHealth: SystemHealth | null = null;
+  let initialError: string | null = null;
+
+  try {
+    initialHealth = await getSystemHealthServerSide();
+  } catch (error) {
+    initialError = error instanceof Error ? error.message : 'خطای نامشخص در ارتباط با API';
+  }
+
+  return (
+    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-14">
+      <header className="flex flex-col gap-2">
+        <p className="text-sm font-medium text-brand-600">شاپینو</p>
+        <h1 className="text-3xl font-bold text-slate-900">وضعیت سامانه</h1>
+        <p className="text-sm leading-6 text-slate-600">
+          این صفحه وضعیت زندهٔ سرویس‌های زیرساختی (PostgreSQL و Redis) و همچنین وضعیت پردازش API
+          را نمایش می‌دهد. داده‌های نمایش‌داده‌شده از خود سرویس‌ها خوانده می‌شوند.
+        </p>
+      </header>
+
+      <SystemHealthPanel initialHealth={initialHealth} initialError={initialError} />
+
+      <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500">
+        <p>شاپینو — نسخهٔ ۰.۱.۰ | API: مسیر امن از طریق پروکسی Next.js به سرویس Backend</p>
+      </footer>
+    </main>
+  );
+}
diff --git a/apps/frontend/src/lib/api/client.ts b/apps/frontend/src/lib/api/client.ts
index f2047ff..7e6018b 100644
--- a/apps/frontend/src/lib/api/client.ts
+++ b/apps/frontend/src/lib/api/client.ts
@@ -4,12 +4,17 @@ import { resolvePublicApiBaseUrl } from '../env';
 import { toApiError } from './errors';
 
 /** Upper bound for a browser request before it is reported as a timeout. */
-export const REQUEST_TIMEOUT_MS = 10_000;
+export const REQUEST_TIMEOUT_MS = 15_000;
+/** Uploads carry images/documents of several megabytes. */
+export const UPLOAD_TIMEOUT_MS = 90_000;
 
 /**
- * Creates an axios instance that always talks to the Shopino API and never
- * leaks transport-specific errors to the callers: every rejection is an
- * {@link import('./errors').ApiError}.
+ * Creates an axios instance that always talks to the Shopino BFF (same
+ * origin, `/api/v1`) and never leaks transport-specific errors to the callers:
+ * every rejection is an {@link import('./errors').ApiError}.
+ *
+ * No token handling happens here: the BFF attaches the httpOnly session
+ * cookies' access token server-side and refreshes it transparently.
  */
 export function createApiClient(baseURL: string = resolvePublicApiBaseUrl()): AxiosInstance {
   const instance = axios.create({
@@ -18,8 +23,9 @@ export function createApiClient(baseURL: string = resolvePublicApiBaseUrl()): Ax
     withCredentials: true,
     headers: {
       Accept: 'application/json',
-      'Content-Type': 'application/json',
     },
+    // Arrays as repeated keys (colors=a&colors=b), which the backend expects.
+    paramsSerializer: { indexes: null },
   });
 
   instance.interceptors.response.use(
@@ -33,19 +39,76 @@ export function createApiClient(baseURL: string = resolvePublicApiBaseUrl()): Ax
 /** Shared client for browser components. */
 export const apiClient = createApiClient();
 
-export async function apiGet<TResponse>(
-  path: string,
-  config?: AxiosRequestConfig,
-): Promise<TResponse> {
-  const { data } = await apiClient.get<TResponse>(path, config);
+export type QueryValue = string | number | boolean | readonly string[] | null | undefined;
+export type Query = Record<string, QueryValue>;
+
+/** Drops empty values so optional filters never reach the API as "". */
+export function cleanQuery(query: Query | undefined): Record<string, string | number | boolean | readonly string[]> {
+  const result: Record<string, string | number | boolean | readonly string[]> = {};
+  if (!query) {
+    return result;
+  }
+  for (const [key, value] of Object.entries(query)) {
+    if (value === undefined || value === null || value === '') continue;
+    if (Array.isArray(value) && value.length === 0) continue;
+    result[key] = value as string | number | boolean | readonly string[];
+  }
+  return result;
+}
+
+/** Query string in the same format the axios client sends. */
+export function toQueryString(query: Query | undefined): string {
+  const params = new URLSearchParams();
+  for (const [key, value] of Object.entries(cleanQuery(query))) {
+    if (Array.isArray(value)) {
+      for (const item of value) params.append(key, String(item));
+    } else {
+      params.set(key, String(value));
+    }
+  }
+  const text = params.toString();
+  return text ? `?${text}` : '';
+}
+
+export async function apiGet<TResponse>(path: string, config?: AxiosRequestConfig & { query?: Query }): Promise<TResponse> {
+  const { query, ...rest } = config ?? {};
+  const { data } = await apiClient.get<TResponse>(path, { ...rest, params: cleanQuery(query) });
   return data;
 }
 
-export async function apiPost<TResponse, TBody = unknown>(
-  path: string,
-  body: TBody,
-  config?: AxiosRequestConfig,
-): Promise<TResponse> {
-  const { data } = await apiClient.post<TResponse>(path, body, config);
+export async function apiPost<TResponse, TBody = unknown>(path: string, body?: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
+  const { data } = await apiClient.post<TResponse>(path, body ?? {}, config);
   return data;
 }
+
+export async function apiPatch<TResponse, TBody = unknown>(path: string, body: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
+  const { data } = await apiClient.patch<TResponse>(path, body, config);
+  return data;
+}
+
+export async function apiDelete<TResponse>(path: string, config?: AxiosRequestConfig): Promise<TResponse> {
+  const { data } = await apiClient.delete<TResponse>(path, config);
+  return data;
+}
+
+/**
+ * Multipart upload (media endpoints). `purpose` is written before the file:
+ * the backend reads the parts in order.
+ */
+export async function apiUpload<TResponse>(path: string, file: File, purpose: string, onProgress?: (fraction: number) => void): Promise<TResponse> {
+  const form = new FormData();
+  form.append('purpose', purpose);
+  form.append('file', file, file.name);
+  const { data } = await apiClient.post<TResponse>(path, form, {
+    timeout: UPLOAD_TIMEOUT_MS,
+    onUploadProgress: (event) => {
+      if (onProgress && event.total) {
+        onProgress(event.loaded / event.total);
+      }
+    },
+  });
+  return data;
+}
+
+/** Same-origin session endpoints (sign-in/out) of the BFF — not under /api/v1. */
+export const sessionClient = createApiClient('/api/session');
diff --git a/apps/frontend/src/lib/api/errors.test.ts b/apps/frontend/src/lib/api/errors.test.ts
index c85977d..7aee108 100644
--- a/apps/frontend/src/lib/api/errors.test.ts
+++ b/apps/frontend/src/lib/api/errors.test.ts
@@ -36,6 +36,19 @@ describe('toApiError', () => {
     expect(error.isClientError).toBe(true);
   });
 
+  it('prefers the stable business code of actionable errors (409 INSUFFICIENT_STOCK…)', () => {
+    const error = toApiError(
+      axiosErrorWith({
+        response: {
+          status: 409,
+          data: { statusCode: 409, error: 'Conflict', code: 'INSUFFICIENT_STOCK', message: 'Only 2 left', available: 2 },
+        },
+      }),
+    );
+    expect(error.code).toBe('INSUFFICIENT_STOCK');
+    expect(error.details).toMatchObject({ available: 2 });
+  });
+
   it('maps a 5xx response to a server error', () => {
     const error = toApiError(
       axiosErrorWith({
@@ -46,7 +59,8 @@ describe('toApiError', () => {
 
     expect(error.kind).toBe('http');
     expect(error.isServerError).toBe(true);
-    expect(error.message).toBe('Service Unavailable');
+    // English infrastructure messages are replaced by a Persian status text.
+    expect(error.message).toBe('سرویس موقتاً در دسترس نیست.');
   });
 
   it('maps a missing response to a network error', () => {
@@ -77,19 +91,19 @@ describe('toApiError', () => {
 });
 
 describe('toApiErrorFromResponse', () => {
-  it('uses the backend message and keeps the payload available as details', () => {
-    const body = { statusCode: 503, message: 'database is down' };
+  it('uses a Persian backend message as-is and keeps the payload available as details', () => {
+    const body = { statusCode: 503, message: 'پایگاه داده در دسترس نیست' };
     const error = toApiErrorFromResponse(new Response(JSON.stringify(body), { status: 503 }), body);
 
     expect(error.status).toBe(503);
-    expect(error.message).toBe('database is down');
+    expect(error.message).toBe('پایگاه داده در دسترس نیست');
     expect(error.details).toEqual(body);
   });
 
   it('falls back to a generic message when the body carries none', () => {
     const error = toApiErrorFromResponse(new Response(null, { status: 502 }), undefined);
 
-    expect(error.message).toContain('502');
+    expect(error.message).toBe('سرویس بیرونی پاسخ نداد؛ کمی بعد دوباره تلاش کنید.');
     expect(error.kind).toBe('http');
   });
 });
diff --git a/apps/frontend/src/lib/api/errors.ts b/apps/frontend/src/lib/api/errors.ts
index 9682bc5..3cbf0ba 100644
--- a/apps/frontend/src/lib/api/errors.ts
+++ b/apps/frontend/src/lib/api/errors.ts
@@ -1,5 +1,7 @@
 import axios from 'axios';
 
+import { localizeErrorMessage } from './error-messages';
+
 /** Classification of everything that can go wrong on an API call. */
 export type ApiErrorKind = 'http' | 'network' | 'timeout' | 'parse' | 'unknown';
 
@@ -51,6 +53,8 @@ interface NestErrorBody {
   statusCode?: number;
   message?: string | string[];
   error?: string;
+  /** Stable machine code of actionable errors (e.g. INSUFFICIENT_STOCK). */
+  code?: string;
 }
 
 function readNestErrorBody(data: unknown): NestErrorBody | undefined {
@@ -89,10 +93,11 @@ export function toApiError(error: unknown): ApiError {
     }
 
     const { status, data } = error.response;
-    return new ApiError(messageFromBody(data) ?? `درخواست با خطای ${status} رد شد.`, {
+    const code = readNestErrorBody(data)?.code;
+    return new ApiError(localizeErrorMessage(status, code, messageFromBody(data), data), {
       kind: 'http',
       status,
-      code: readNestErrorBody(data)?.error,
+      code: code ?? readNestErrorBody(data)?.error,
       details: data,
       cause: error,
     });
@@ -107,9 +112,10 @@ export function toApiError(error: unknown): ApiError {
 
 /** Builds an {@link ApiError} for a failed `fetch` response. */
 export function toApiErrorFromResponse(response: Response, details: unknown): ApiError {
-  return new ApiError(messageFromBody(details) ?? `درخواست با خطای ${response.status} رد شد.`, {
+  return new ApiError(localizeErrorMessage(response.status, readNestErrorBody(details)?.code, messageFromBody(details), details), {
     kind: 'http',
     status: response.status,
+    code: readNestErrorBody(details)?.code ?? readNestErrorBody(details)?.error,
     details,
   });
 }
diff --git a/apps/frontend/vitest.config.ts b/apps/frontend/vitest.config.ts
index 389b8bc..aca483f 100644
--- a/apps/frontend/vitest.config.ts
+++ b/apps/frontend/vitest.config.ts
@@ -1,6 +1,12 @@
+import { fileURLToPath } from 'node:url';
+
 import { defineConfig } from 'vitest/config';
 
 export default defineConfig({
+  resolve: {
+    // Same `@/*` → `src/*` mapping as tsconfig paths.
+    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
+  },
   test: {
     environment: 'node',
     include: ['src/**/*.test.ts'],
```
