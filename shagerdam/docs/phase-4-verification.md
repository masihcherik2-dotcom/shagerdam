# Shopino — Phase 4 verification report

**Phase:** 4 — Pluggable media storage engine (Sharp) and the vendor onboarding / verification / profile workflow
**Reported by:** AI Software Developer · **Date:** 2026-09-26
**Environment:** live PostgreSQL 16.15 (Docker) · Redis 7.4.11 (Docker) · local filesystem storage (`STORAGE_PROVIDER=local`) · NestJS 11 + Fastify · Prisma 6.19.3 · Node 22.23.3
**Verdict:** every acceptance criterion verified against real services. The S3 provider is implemented and unit-tested but was **not** exercised against a real bucket (no credentials in this environment; see §7).

The gates in §2 were run on a **freshly provisioned sandbox** (new Docker daemon, empty
database → `prisma migrate deploy` → seed), so they don't depend on any leftover state.

---

## 1. Acceptance criteria

| # | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Explicit `StorageProvider` contract (`upload`, `delete`, `getUrl`) | **PASS** | `storage-provider.interface.ts`; also exposes `exists`/`read` |
| 2 | `LocalStorageProvider` when `STORAGE_PROVIDER=local`, serving from a configured public dir securely | **PASS** | §4: boot log + `/media/storage-provider`; root-escape/absolute/NUL/backslash guards (unit specs) |
| 3 | `S3StorageProvider` when `STORAGE_PROVIDER=s3` (AWS / ArvanCloud / Liara) | **PASS (code + unit)** | SDK v3, custom endpoint + path-style; boot refuses incomplete S3 config (`env.validation.spec`). Not run against a real bucket |
| 4 | Sharp: auto WebP, max 1600 px, 300×300 thumbnail | **PASS** | §4: 2400×1800 PNG → stored `webp 1600x1200` + `_thumb.webp`; unit specs |
| 5 | Magic-byte validation, 5 MB image / 10 MB document caps | **PASS** | §4: text file named `.png` → 400; oversize → 413 (unit + e2e) |
| 6 | Vendor creation/approval initialises an active 0-balance `VendorWallet` in the same transaction | **PASS** | e2e + pre-reset live DB check: `vendors = wallets`, balances `0.00×3` |
| 7 | Approval sets owner role to `VENDOR` | **PASS** | e2e + live DB (owner_role `VENDOR` after approval; rejected store owner stays `CUSTOMER`) |
| 8 | Verify = one transaction (status, reviewer stamp, wallet + role, AuditLog) | **PASS** | e2e asserts all four rows after the call |
| 9 | Rejection reason visible to the vendor | **PASS** | e2e + live driver (`GET /vendors/me` returns the reason) |
| 10 | Staff-only admin routes; non-staff blocked | **PASS** | e2e: CUSTOMER/VENDOR → 403, anonymous → 401; SUPPORT may read but not verify (403) |
| 11 | Full Swagger annotations | **PASS** | 24 paths, tags `media`, `vendors`, `admin-vendors`; multipart bodies documented (e2e + live `/api/docs-json`) |
| 12 | No TODO / placeholder / mock endpoints | **PASS** | lint clean; no fake providers; tests use real PG/Redis/fs/Sharp |

## 2. Quality gates (fresh sandbox)

| Gate | Command | Result |
| --- | --- | --- |
| Migrations | `pnpm db:deploy` | **PASS** — all 5 migrations applied to an empty DB |
| Seed | `pnpm db:seed` | **PASS** |
| Connections | `verify:connections` | **PASS** — PG 16.15, Redis 7.4.11 |
| Type check | `pnpm typecheck` | **PASS** — 2/2 packages |
| Lint | `pnpm lint` | **PASS** — 2/2 packages, 0 errors, 0 warnings |
| Build | `pnpm build` | **PASS** — 2/2 tasks (frontend `✓ Compiled successfully`) |
| Unit | `pnpm exec jest` (backend) | **PASS** — **205/205**, 16 suites |
| E2E | `jest -c test/jest-e2e.json --runInBand` | **PASS** — **104/104**, 5 suites (vendors 50/50), exits on its own (no `--forceExit`) |

**Honest note:** the *first* e2e run on the fresh sandbox had 1 failure — `health.e2e-spec`
got 503 instead of 200 (103/104). The suite passed on its own right after, and the full run
then passed 104/104. The cause wasn't captured (the failing response body isn't logged). The
likeliest explanation is a dependency that wasn't fully warm straight after `docker compose up`,
but that's unconfirmed. Tracked in §7.

## 3. What the vendor e2e suite covers (50 tests)

Register PENDING (+ wallet, role stays CUSTOMER) · slug uniqueness/format/reserved names ·
IBAN checksum · Instagram normalisation · staff cannot register · image upload → WebP +
thumbnail · non-image / corrupt / oversize rejected · document upload private, owner/staff
download only, audited per reader · KYC submission (national card required, foreign document
URLs refused) · admin list filters/search/pagination · admin detail (documents + audit
history) · approve → APPROVED + wallet + role VENDOR + reviewer stamp + audit row · reject
with reason (reason required, visible to vendor) · re-review of a reviewed submission → 409 ·
resubmission → PENDING · profile PATCH, IBAN change needs new proof and returns to PENDING
with a warning · CUSTOMER/VENDOR/anonymous blocked from admin routes, SUPPORT cannot verify ·
OpenAPI contract.

Transport: Fastify in-process injection through the full Nest pipeline (guards, pipes,
interceptors, multipart). Database, Redis, storage and Sharp are all real. The suite cleans up
its own rows **and** stored files: two runs on the fresh sandbox left 0 files in `uploads/`.

## 4. Live HTTP check (built server `node dist/main.js`, port 4000, fresh sandbox)

```
health: 200
provider: {"provider":"local","isLocal":true,"maxImageBytes":5242880,"maxDocumentBytes":10485760}
tags ['auth','admin-users','admin-audit','media','vendors','admin-vendors'] paths 24
upload (2400x1800 PNG, 60 720 B): 201 {"mimeType":"image/webp","sizeBytes":3488,"width":1600,"height":1200,
        "url":"/api/v1/media/files/images/store_logo/2026/09/<uuid>.webp","thumbnailUrl":".../<uuid>_thumb.webp"}
fetch stored url: 200 image/webp   → decoded by Sharp: webp 1600x1200
text file named .png: 400
GET /admin/vendors without token: 401
GET /admin/vendors?status=APPROVED&page=1&pageSize=5 as SUPER_ADMIN: 200 {page:1,pageSize:5,total:1,totalPages:1}
```

Before the sandbox reset, the full sandbox-only live driver (real HTTP, 11 sections: register →
upload → KYC → admin list/detail → approve → override → reject → resubmit → profile/IBAN →
file privacy → OpenAPI) passed **89/89** against the same build. DB readback after that run:
`vendors 3 = wallets 3`; approved owner role `VENDOR`; rejected owner `CUSTOMER`; verification
history kept (2 rows); audit rows CREATE → STATUS_CHANGE ×2 → UPDATE ×2; media rows
IMAGE/public, DOCUMENT/private, provider `local`. The driver is sandbox tooling (not app source)
and was lost in the reset. It wasn't re-created; the committed e2e suite covers the same flow.

## 5. Security properties verified

* The file type comes from the content, never the name or client MIME. Sharp decodes with `failOn:'error'` and a pixel limit.
* No user input reaches a storage key (`<family>/<purpose>/<yyyy>/<mm>/<uuid>`). Traversal, absolute, NUL and backslash keys are rejected by both providers.
* KYC documents can't be reached through the public file route (404). The download route needs a token (401), rejects other vendors (403), allows staff, and writes one audit row per reader.
* Asset metadata never exposes the internal storage key.
* Staff accounts can't own a store. SUPPORT is read-only on admin vendor routes.
* The verify decision's audit row is written inside the same transaction.

## 6. Environment / provider status

| Concern | Active in dev | Production-ready? |
| --- | --- | --- |
| Storage | `local` (`STORAGE_LOCAL_ROOT=uploads`, served under `/api/v1/media/files`) | Local only suits a single instance with a persistent volume. Production should use `s3` with real credentials (none are configured here) |
| SMS | `sandbox` (unchanged from Phase 3) | No — dev/test only |

## 7. Remaining issues / risks

1. **S3 provider not tested against a real bucket.** Only the unit specs and boot validation have run. It needs real ArvanCloud/Liara/AWS credentials from the TM for a live check.
2. **One-off health 503** on the first e2e run after fresh infra (§2). It didn't reproduce, and the cause is unconfirmed.
3. **A killed e2e run leaves rows behind.** The suite has no `beforeAll` purge, so rows from an aborted run must be removed by hand.
4. **Orphaned files after row-only cleanup.** Deleting a store's DB rows by hand does not delete its files. There's no orphan-file sweeper yet (33 such files from the pre-reset sandbox driver were removed manually).
5. Minor (non-blocking): the audit `list()` shows a null `actorMobile` for staff actors identified by email. `VendorProfileDto` and `MeVendorSummaryDto` overlap and could be unified.
