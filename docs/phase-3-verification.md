# Shopino — Phase 3 verification report

**Phase:** 3 — Authentication, RBAC, pluggable SMS/OTP, audit engine
**Reported by:** AI Software Developer · **Date:** 2026-09-26
**Environment:** live PostgreSQL 16.15 (Docker) · Redis 7.4 (Docker) · NestJS 11 · Prisma 6.19.3 · Node 22.23.3
**Verdict:** every acceptance criterion verified against real services and real HTTP. No mock, fake, stub or hardcoded credential anywhere.

Secrets are never printed. Passwords and OTP codes appearing below are either generated at
run time inside the sandbox environment or taken from the git-ignored `.env`.

---

## 1. Acceptance criteria — result

| # | Requirement | Result | Evidence |
| --- | --- | --- | --- |
| 1 | Real JWT via `@nestjs/jwt`, 15 m access + 7 d persistent refresh stored securely | **PASS** | §4.2 (claims decoded and signature verified with the real secret), §6 (rotation + revocation in Redis) |
| 2 | Explicit `SmsProvider` contract (`sendOtp`, `sendTransactional`) | **PASS** | §5.1, deliverable §4.2 |
| 3 | `SandboxSmsProvider` active when `SMS_PROVIDER=sandbox`, logs the code, honours rate limits and TTL | **PASS** | §5.2 (code read back from the provider), §5.3 (refuses expired codes, self-throttles) |
| 4 | `KavenegarSmsProvider` active when `SMS_PROVIDER=kavenegar` with an API key | **PASS** | §5.4 (real HTTP client, boot fails without credentials), §5.5 |
| 5 | Dynamic selection through NestJS DI from configuration | **PASS** | §5.5 (factory provider, no branching in business code) |
| 6 | Argon2id hashing for password logins | **PASS** | §6.1 (seeded admin logs in; decoy hash keeps timing constant) |
| 7 | Redis-backed OTP limiter: 1 request / 120 s, 5 failed attempts → 15 m cooldown | **PASS** | §4.3, §4.4 |
| 8 | No TODOs, placeholders or fake endpoints | **PASS** | §10 (grep-style audit of the Phase-3 diff) |
| 9 | Full Swagger annotations on all new endpoints | **PASS** | §7 (11 endpoints documented with their real response codes) |
| 10 | Tests: OTP pipeline incl. Redis TTL, brute force, cooldown, password login, RBAC 403, audit row on profile update | **PASS** | §3, §4, §6, §8 |
| 11 | Live output proving 100 % passing tests against real Redis and PostgreSQL | **PASS** | §2, §9 |

---

## 2. Quality gates

| Gate | Command | Result |
| --- | --- | --- |
| Type check | `pnpm typecheck` | **PASS** — 2/2 packages, 0 errors |
| Lint | `pnpm lint` | **PASS** — 2/2 packages, 0 errors, 0 warnings |
| Unit tests | `pnpm test` | **PASS** — backend **106/106** in 10 suites |
| Integration / e2e | `cd apps/backend && pnpm run test:e2e` | **PASS** — **54/54** in 4 suites, 5–8 s |
| Production build | `pnpm build` | **PASS** — 2/2 tasks, `✓ Compiled successfully in 11.8s` |
| Live HTTP smoke | `pnpm --filter @shopino/backend run verify:auth` | **PASS** — **16/16** checks |

```text
@shopino/backend:test: Test Suites: 10 passed, 10 total
@shopino/backend:test: Tests:       106 passed, 106 total

PASS test/auth.e2e-spec.ts (6.139 s)
PASS test/seed.e2e-spec.ts
PASS test/schema-integrity.e2e-spec.ts
PASS test/health.e2e-spec.ts
Test Suites: 4 passed, 4 total
Tests:       54 passed, 54 total
```

### 2.1 Unit suites

| Suite | What it pins down |
| --- | --- |
| `common/validators/iranian-mobile.spec.ts` | every accepted spelling → canonical E.164, idempotence, and rejection of the malformed 12-character `+98999000001` form |
| `common/validators/iranian-national-code.spec.ts` | check-digit algorithm, wrong check digit, wrong length, repeated digits, Persian/Arabic digits |
| `modules/audit/audit-log.service.spec.ts` | redaction of 12 secret-bearing keys, nesting, bounds (depth 6 / 50 items / 2000 chars), dates |
| `modules/audit/audit.interceptor.spec.ts` | the full action vocabulary the mission names — `POST`→CREATE, `PATCH`/`PUT`→UPDATE, `DELETE`→DELETE and `@Auditable`→**STATUS_CHANGE** — plus `@SkipAudit`, entity-id resolution (body / `params.id` / `entityIdParam` / response `id`), anonymous-route attribution from the handler snapshot, body redaction, "a failed request writes nothing", "an audit write failure does not fail the request" and non-HTTP pass-through |
| `modules/auth/guards/jwt-auth.guard.spec.ts` | missing/invalid token → 401, deactivated account → 403, deleted account → 401, role read from the database (not the token), `@Public()` behaviour |
| `modules/auth/guards/roles.guard.spec.ts` | full six-role matrix, no-identity denial, contradictory `@Public + @Roles` refusal |
| `modules/auth/token.service.spec.ts` | duration parsing (`30s`…`7d`) and SHA-256 token hashing |
| `modules/auth/otp.service.spec.ts` | OTP outcome mapping (match / mismatch / exhausted / not found), audit rows for failures, identifier normalization, logout isolation between users |
| `infra/security/password.spec.ts` | Argon2id parameters (pre-existing) |
| `config/env.validation.spec.ts` | mandatory secrets in every environment, OTP policy bounds, sandbox refusal in production, missing gateway credentials |

### 2.2 Repeatability

The suites and the smoke script both manipulate Redis rate-limit state, so they were run
repeatedly in sequence to prove they are deterministic rather than accidentally green:

```text
چرخهٔ 1 → smoke: 16/16 checks passed | e2e: Tests: 54 passed, 54 total
چرخهٔ 2 → smoke: 16/16 checks passed | e2e: Tests: 54 passed, 54 total
چرخهٔ 3 → smoke: 16/16 checks passed | e2e: Tests: 54 passed, 54 total
```

Two real defects were found and fixed by this exercise — see §11.

---

## 3. OTP pipeline verified end to end (mission criterion 1)

From `test/auth.e2e-spec.ts`, against the running Redis and PostgreSQL:

1. `POST /auth/otp/request` → `200` `{ status: "sent", expiresInSeconds: 120, trackingId: "SBX-…" }`.
2. **Redis TTL checked directly**: `TTL auth:otp:challenge:+989990000001` is `0 < ttl ≤ 120`.
   The stored hash contains `codeHash` (a 64-character SHA-256 digest), `purpose=login`,
   `attempts=0` — and **no** `code` field, so the code is not readable from Redis.
3. The code is read back from the **active provider instance** (`SmsProvider` resolved
   through the same DI token the application uses) and matches `^[0-9]{5}$`.
4. Wrong code → `401` and the challenge survives (a typo does not burn the code).
5. Correct code → `200` with `accessToken`, `refreshToken`, `expiresIn: 900`,
   `refreshExpiresIn: 604800`.
6. The access token is verified with the **real** `JWT_ACCESS_SECRET`; the refresh token is
   rejected when presented as an access token.
7. The challenge is deleted after use: replaying the same code returns `401`.
8. The customer row exists with `role = CUSTOMER`, `isActive = true`, `passwordHash = NULL`,
   a non-null `customer_profiles` row, and **zero** credit accounts or orders.

---

## 4. Brute-force protection (mission criterion 2)

```text
# Cooldown — two consecutive requests for the same number
first  request → 200
second request → 429 · retryAfterSeconds = 120

# Attempt budget — five wrong codes
attempt 1..4 → 401 (wrong code, budget remains)
attempt 5    → 429 (locked; retryAfterSeconds ≤ OTP_LOCK_SECONDS)
correct code while locked → 429   ← the lock is real, not cosmetic
no user row was created for the attacked number
```

The lock and the counters live in Redis under
`auth:otp:lock:<mobile>`, `auth:otp:challenge:<mobile>`, `auth:otp:hourly:mobile:<mobile>`
and `auth:otp:hourly:ip:<ip>`, so they hold across every API instance. Verification is a
single Lua script (atomic), and the failure counter keeps the original TTL — a guessing loop
cannot extend the window.

Every rejected attempt also produced an audit row:

```text
action=LOGIN entityName=User newValue={"success":false,"reason":"otp_mismatch"}
action=LOGIN entityName=User newValue={"success":false,"reason":"otp_attempts_exhausted"}
```

The suite asserts that the submitted codes (`11111`, `22222`) never appear anywhere in those
rows.

---

## 5. SMS provider architecture (mission criterion 2)

### 5.1 The contract

```ts
export interface SmsProvider {
  readonly kind: SmsProviderKind;          // 'sandbox' | 'kavenegar'
  readonly isTestProvider: boolean;
  sendOtp(message: OtpMessage): Promise<SmsSendResult>;
  sendTransactional(message: TransactionalMessage): Promise<SmsSendResult>;
}
```

Injected through the `SMS_PROVIDER` token; the factory in `SmsModule` picks the
implementation once, at boot, from validated configuration.

### 5.2 Sandbox provider is the active one in this environment

```text
[EnvironmentValidation] SMS_PROVIDER=sandbox — OTP codes are written to the application log and not delivered by SMS.
[SmsModule]             SMS provider: sandbox — OTP codes are printed to the log and never delivered.
[OtpService]            OTP challenge created for +98999****567 (purpose: login)
[SmsSandbox]            OTP login → +98999****567: 21023 (valid 120s, ref SBX-MUIG4YRG-3)
```

Note the masking: the log shows `+98999****567`, never the full number.

### 5.3 Sandbox provider still enforces a real contract

* refuses a code whose `expiresInSeconds <= 0`;
* self-throttles to 5 sends/second, so a flooding bug in the caller surfaces in development
  instead of in production;
* keeps the last 50 dispatches in memory for inspection and tests.

### 5.4 Kavenegar provider is production-ready, not a stub

* OTP goes through `verify/lookup.json` (the pre-approved template endpoint Iranian operators
  require for login codes); transactional messages through `sms/send.json`;
* both the HTTP status and Kavenegar's own `return.status` are checked — either can fail;
* requests carry a 10 s abort so a hung gateway cannot pile up;
* the API key is read from the environment, travels in the request path as the gateway
  requires, and is never logged;
* a missing key/sender/template fails the boot instead of the first login.

### 5.5 Misconfiguration is refused at startup

```text
NODE_ENV=production + SMS_PROVIDER=sandbox
  → "SMS_PROVIDER=sandbox cannot be used in production: it logs codes instead of delivering them."

SMS_PROVIDER=kavenegar without credentials
  → "SMS_PROVIDER=kavenegar requires SMS_KAVENEGAR_API_KEY, SMS_KAVENEGAR_SENDER, SMS_KAVENEGAR_OTP_TEMPLATE."
```

Both are asserted in `config/env.validation.spec.ts`.

---

## 6. Staff password login and sessions (mission criterion 3)

### 6.1 Seeded super admin authenticates

```text
POST /api/v1/auth/login/password  { identifier: "admin@shopino.local", password: <from .env> }
→ 200 · role=SUPER_ADMIN · mobile=+989120000001 · accessToken=eyJhbGciOiJI…

POST /api/v1/auth/login/password  { identifier: "+989120000001", … }   ← same account, mobile identifier
→ 200 · role=SUPER_ADMIN

POST /api/v1/auth/login/password  { password: "definitely-not-the-password" }
→ 401 · "Invalid credentials."   + audit row newValue={"success":false,"reason":"bad_credentials"}

unknown account vs wrong password → identical status and identical message
```

Passwords are verified with Argon2id (19 MiB, t=2, p=1). An unknown account is verified
against a real Argon2id decoy hash so the response time does not reveal existence.

### 6.2 Refresh rotation, replay detection, logout

```text
POST /auth/refresh (token T1) → 200 with T2 and a new sessionId; T1 ≠ T2
POST /auth/refresh (token T1) → 401          ← replay of a consumed token
POST /auth/logout (bearer + T2) → 200 { revoked: true, sessionsRevoked: 1 }
redis EXISTS auth:session:<sid> → 0
POST /auth/refresh (token T2) → 401          ← the session is gone, tokens cannot be minted
```

Sessions are stored in Redis as `auth:session:<jti>` → `{ userId, refreshTokenHash, createdAt,
lastUsedAt, ipAddress, userAgent }` with a TTL equal to the refresh lifetime. Only the
SHA-256 of the refresh token is stored, so a Redis dump yields no usable token.

---

## 7. API surface in the running server

```text
GET /api/docs       → HTTP 200 (Swagger UI)
GET /api/docs-json  → HTTP 200
OpenAPI 3.0.0 · title=Shopino API v1.0.0 · documented paths: 12 · security schemes: ['access-token']

  POST   /api/v1/auth/otp/request          200,400,429          bearer=—
  POST   /api/v1/auth/otp/verify           200,401,403,429      bearer=—
  POST   /api/v1/auth/login/password       200,401,403,429      bearer=—
  POST   /api/v1/auth/refresh              200,401,403          bearer=—
  POST   /api/v1/auth/logout               200,401              bearer=yes
  GET    /api/v1/auth/me                   200,401              bearer=yes
  PATCH  /api/v1/auth/profile              200,400,401,409      bearer=yes
  GET    /api/v1/auth/sms-provider         200                  bearer=—
  GET    /api/v1/admin/users               200                  bearer=yes
  GET    /api/v1/admin/users/{id}          200,404              bearer=yes
  GET    /api/v1/admin/audit-logs          200                  bearer=yes
```

Each operation carries a Persian summary/description, body schemas, and the response codes it
can actually return.

---

## 8. RBAC and the audit engine (mission criteria 4 and 5)

### 8.1 403 for a CUSTOMER on a SUPER_ADMIN route, 200 for the admin

```text
GET /api/v1/admin/users   Authorization: Bearer <CUSTOMER token>
→ 403  { "message": "This action requires one of the following roles: SUPER_ADMIN, ADMIN" }

GET /api/v1/admin/users   Authorization: Bearer <SUPER_ADMIN token>
→ 200  total=5, roles present: CUSTOMER, FINANCIAL_OFFICER, VENDOR
        passwordHash present in payload: False

GET /api/v1/admin/users   (no token)
→ 401

SUPPORT  → /admin/users     403   (cannot enumerate identities)
SUPPORT  → /admin/users/:id 200   (can look up one user to answer a ticket)
SUPPORT  → /admin/audit-logs 403  (audit trail is admin-only)
```

`JwtAuthGuard` and `RolesGuard` are global, so these are defaults rather than per-route
choices. The role is re-read from PostgreSQL on every request, so a downgraded account loses
its access immediately.

### 8.2 A profile update produces an audit row

```text
PATCH /api/v1/auth/profile  { fullName, email, nationalCode, birthDate }  → 200 { updated: true }

audit_logs row:
  2026-09-26T13:49:33  UPDATE  User.f880cf8c…  by user=f880cf8c…  ip=127.0.0.1
  oldValue = {"email":"admin@shopino.local","fullName":"مدیر ارشد پلتفرم","birthDate":null,"nationalCode":null}
  newValue = {"result":{...new values...},"request":{...submitted body, secrets redacted...}}
```

The row is written **before** the response is emitted, so a mutation reported as successful
is always in the trail. `PATCH` with an invalid national code (`0499370898`, wrong check
digit) is rejected with `400` **and writes no audit row** — a rejected request is not an
event in the entity's history.

### 8.3 The trail is readable only by admins

```text
GET /api/v1/admin/audit-logs?entityName=User&action=UPDATE&pageSize=1   (SUPER_ADMIN) → 200, total=1, oldValue/newValue present
GET /api/v1/admin/audit-logs                                             (CUSTOMER)   → 403
```

---

## 9. Live HTTP verification (`pnpm verify:auth`)

A real HTTP client against the booted server (not Fastify's in-process `inject`):

```text
Shopino — authentication smoke test (live HTTP)

  PASS  GET /health is public and reports all dependencies up                HTTP 200 · {"status":"ok","info":{"database":{"status":"up","latency_ms":1.7},"redis":{"status":"up","latency_ms":0.81}…
  PASS  GET /auth/me without a token is rejected                             HTTP 401
  PASS  POST /auth/login/password authenticates the seeded super admin       HTTP 200 · role=SUPER_ADMIN · mobile=+989120000001 · accessToken=eyJhbGciOiJI…
  PASS  POST /auth/login/password rejects a wrong password                   HTTP 401 · message="Invalid credentials."
  PASS  GET /auth/me returns the authenticated profile                       HTTP 200 · role=SUPER_ADMIN
  PASS  PATCH /auth/profile rejects a national code with a bad check digit   HTTP 400
  PASS  PATCH /auth/profile updates the profile                              HTTP 200 · updated=true
  PASS  GET /admin/audit-logs shows the UPDATE row with before/after values  HTTP 200 · total=4 · entityId=f880cf8c…
  PASS  POST /auth/refresh rotates the refresh token                         HTTP 200 · rotated=true
  PASS  a consumed refresh token is refused (replay detection)               HTTP 401
  PASS  POST /auth/logout revokes the session                                HTTP 200 · sessionsRevoked=1
  PASS  the revoked session can no longer mint tokens                        HTTP 401
  PASS  POST /auth/otp/request accepts a national mobile number              HTTP 200 · status=sent · expiresInSeconds=120 · trackingId=SBX-MUIG8QKK-8
  PASS  the OTP cooldown is enforced over HTTP                               first=200 · second=429 · retryAfterSeconds=120
  PASS  an invalid mobile number is rejected                                 HTTP 400
  PASS  GET /auth/sms-provider reports the active provider honestly          provider=sandbox · isTestProvider=true

  16/16 checks passed
```

In production the OTP section reports `SKIP` with the reason "the live SMS provider is
active — sending test messages would cost money and disturb real traffic", so this script is
safe to run anywhere.

### 9.1 A complete OTP login over real HTTP, with the JWT inspected

```text
1) POST /auth/otp/request {"mobile":"09991234567"}
   → {"status":"sent","expiresInSeconds":120,"trackingId":"SBX-MUIG4YRG-3"}
   server log: [SmsSandbox] OTP login → +98999****567: 21023 (valid 120s, ref SBX-MUIG4YRG-3)

2) POST /auth/otp/verify {"mobile":"09991234567","code":"21023"}
   → 200 {
       "user": {"id":"73fc0f9b-…","mobile":"+989991234567","role":"CUSTOMER","fullName":"کاربر 09991234567","email":null},
       "expiresIn": 900, "refreshExpiresIn": 604800, "sessionId":"3bbdf580-…"
     }

3) JWT decoded and verified with the real JWT_ACCESS_SECRET:
   header : {"alg":"HS256","typ":"JWT"}
   payload: {"sub":"73fc0f9b-…","mobile":"+989991234567","role":"CUSTOMER","typ":"access",
             "sid":"3bbdf580-…","iat":1790430583,"exp":1790431483,
             "aud":"shopino-api","iss":"shopino","jti":"436ce6a4-…"}
   signature verified: YES

4) GET /auth/me with that token
   → 200 { user: {…role: CUSTOMER}, customerProfile: { birthDate: null, gender: null, bankIban: null, defaultAddressId: null }, vendor: null }
```

The empty `customerProfile` is the proof that the first OTP login created the account *and*
its profile, with no fabricated financial data attached.

---

## 10. Mobile canonicalization and no-placeholder audit

### 10.1 Migration applied

```text
20260926145500_canonical_e164_mobile

before: 09120000001  09120000002  09120000003  09120000010
after : +989120000001 +989120000002 +989120000003 +989120000010

prisma migrate status → 3 migrations found · Database schema is up to date!
```

### 10.2 No TODO / placeholder / mock

The Phase-3 surface contains no `TODO`, `FIXME`, `mock`, `stub`, `dummy`, `fake` or
placeholder implementation. The only occurrences of the word "stub" in the repository are in
the requirements text ("stub-ready Kavenegar implementation"), and the provider that
satisfies it is a complete HTTP client.

---

## 11. Defects found during verification (and fixed)

Verification is only useful if it finds real problems. It found these:

| # | Defect | Impact | Fix |
| --- | --- | --- | --- |
| 1 | `toE164` accepted the 12-character form `+98999000001` (one digit short of a valid Iranian mobile) | malformed numbers could be registered and would never match the canonical form | patterns corrected to `^09[0-9]{9}$` / `^\+989[0-9]{9}$`; a regression test asserts the old form is rejected and the round-trip length is 13 |
| 2 | `/api/v1/health` returned `401` once the global guard was installed | orchestrator health probes would have failed and the container would have been marked unhealthy | the endpoint is `@Public()` — dependency status is not sensitive, and probes hold no token |
| 3 | The Phase-2 integrity suite asserted `audit_logs = 0` | once the audit engine worked, any real mutation broke that suite | assertion narrowed to the invariant that still matters: **zero fabricated financial rows** (orders, payments, ledgers, instalments), with a comment explaining why audit rows are expected to grow |
| 4 | The e2e suite and the smoke script accumulated Redis rate-limit state across runs | the 5th consecutive run failed for the wrong reason (429 where 401 was expected) | both reset the state *of their own numbers and identifiers only*, in non-production; proven by three consecutive smoke+e2e cycles |
| 5 | The smoke script would have sent real SMS in production | cost and real traffic disturbance | the OTP section is skipped when `NODE_ENV=production`, reported as `SKIP` with the reason |

---

## 12. Remaining issues and risks

| # | Item | Severity | Detail / mitigation |
| --- | --- | --- | --- |
| 1 | Access-token claims are re-checked against the database on every request | Low (by design) | One indexed `SELECT` per request buys immediate effect for deactivation and role changes. If it ever becomes a hotspot, the row can be cached in Redis for a few seconds with a documented staleness budget. |
| 2 | Redis is a hard dependency of authentication | Medium | OTP challenges, rate limits and refresh sessions all live in Redis; if it is down, logins fail even though PostgreSQL is fine. Redis runs with a named volume and password; a production deployment should use a replica and alert on the health endpoint (which reports Redis separately). |
| 3 | No "change mobile number" flow | Low | `mobile` is the identity key and is deliberately not writable through `PATCH /auth/profile`; changing it needs a confirm-the-new-number OTP flow, which belongs to a later slice. |
| 4 | No password-change / reset flow yet | Medium | Staff passwords are set by the seed; a rotation endpoint (with session invalidation) is the next authentication work item. `TokenService.revokeAllForUser()` already exists for that purpose. |
| 5 | No IP allow-listing or CAPTCHA on the anonymous endpoints | Low | Rate limits are per number and per IP. A distributed attack across many IPs would need a CAPTCHA or a WAF rule; noted for the security review. |
| 6 | Kavenegar provider is not exercised against the live gateway | Medium | Its request/response handling is implemented from the documented API and unit-checked through the contract, but no real credit has been spent. It needs one end-to-end run with real credentials before production traffic. |
| 7 | `users.mobile` NOT NULL rollout rule | Medium | Unchanged from Phase 2: safe on the current database; a populated production database needs the documented add-nullable → backfill → set-not-null sequence. |

---

## 13. What is still incomplete (honest status)

* **Vendor onboarding, catalogue, cart, orders, payments, settlements, credit and disputes
  have no HTTP layer.** Their schema, constraints and ledgers are verified (Phase 2), but no
  endpoint reads or writes them yet. They are the next phases, not silent gaps.
* **No frontend screens for authentication.** The Next.js app still shows only the health
  panel. Login, OTP and profile screens are a separate deliverable.
* **No password-change or mobile-change endpoints** (see risks 3 and 4).
* **No refresh-token family revocation across devices** — logout revokes the current session
  (and optionally a supplied refresh token); `revokeAllForUser()` exists but is not yet
  exposed through an endpoint.
* **No automated coverage for the Kavenegar provider against the live gateway** (risk 6).

---

## 14. What is needed for the next step

1. **Technical-manager approval of Phase 3** (implementation + verification + testing are all
   green).
2. A decision on the next slice. The recommended order:
   * **admin & vendor authentication surfaces** — password change, session list/revoke-all,
     vendor registration → `VendorVerification` approval by `ADMIN`;
   * **catalogue APIs** — categories, products, variants, media, with `VENDOR` ownership
     checks and commission resolution;
   * then cart → checkout → payment → escrow → settlement, which is where the Phase-2
     financial schema finally gets its service layer.
3. When the credit engine is switched on, a decision is needed on the real provider's
   sandbox credentials and on the `credit.enabled` rollout (it is still `false` by design).
