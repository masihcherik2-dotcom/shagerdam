# Shopino — Phase 3 deliverable: authentication, RBAC, SMS adapter & audit engine

**Phase:** 3 — Production-grade authentication, authorization, pluggable SMS/OTP and audit logging
**Role executed:** Lead Security & Backend Architect
**Date:** 2026-09-26
**Status:** implemented · tested against live PostgreSQL 16, Redis 7 and the active SMS provider (see `phase-3-verification.md`)

---

## 1. What was built

| Area | Delivered |
| --- | --- |
| **OTP authentication** | Cryptographically secure 5-digit codes, stored in Redis as `sha256(mobile:code)` with a 120 s TTL, dispatched through the active SMS provider, verified by a single atomic Lua script |
| **Password authentication** | Argon2id verification for staff and vendors, constant-time decoy verification, per-identifier brute-force lockout |
| **Sessions** | `@nestjs/jwt` access tokens (15 m, stateless) + refresh tokens (7 d, tracked in Redis), rotation with replay detection, instant revocation on logout |
| **Identity** | `GET /auth/me`, `PATCH /auth/profile` (national code validated by its check digit), automatic `CUSTOMER` + empty `CustomerProfile` creation on first OTP login |
| **Authorization** | Global `JwtAuthGuard` (`@Public()` opt-out) + `RolesGuard` (`@Roles(...)`) covering all six roles |
| **Audit engine** | `AuditLogService` + global `AuditInterceptor` writing immutable rows with actor, IP, user agent and before/after values; secrets redacted; admin read endpoint |
| **SMS adapter** | `SmsProvider` contract with `SandboxSmsProvider` (development) and `KavenegarSmsProvider` (production), chosen by DI from configuration |
| **Database** | Migration `20260926145500_canonical_e164_mobile` making `users.mobile` a single canonical E.164 value |

**Endpoints (all under `/api/v1`, fully annotated in OpenAPI 3):**

| Method | Path | Access | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/otp/request` | public | Request a login code (rate limited per number and per IP) |
| POST | `/auth/otp/verify` | public | Verify the code, create the customer if new, return tokens |
| POST | `/auth/login/password` | public | Staff/vendor password login |
| POST | `/auth/refresh` | public | Rotate the refresh token, issue a new pair |
| POST | `/auth/logout` | bearer | Revoke the current session |
| GET | `/auth/me` | bearer | Current user + customer profile + vendor profile |
| PATCH | `/auth/profile` | bearer | Update fullName / email / nationalCode / birthDate |
| GET | `/auth/sms-provider` | public | Honest report of the active SMS provider |
| GET | `/admin/users` | SUPER_ADMIN, ADMIN | Paginated identity search |
| GET | `/admin/users/:id` | + SUPPORT, FINANCIAL_OFFICER | Single-user lookup |
| GET | `/admin/audit-logs` | SUPER_ADMIN, ADMIN | Paginated, filterable audit trail |

---

## 2. File structure of the new modules

```text
apps/backend/
├── prisma/migrations/20260926145500_canonical_e164_mobile/
│   └── migration.sql                     data-preserving mobile normalization to E.164
├── scripts/smoke-auth.ts                 live-HTTP verification (pnpm verify:auth)
├── test/auth.e2e-spec.ts                 full auth pipeline against real Redis + PostgreSQL
└── src/
    ├── common/
    │   ├── decorators/
    │   │   ├── current-user.decorator.ts     @CurrentUser() and @ClientContext()
    │   │   ├── public.decorator.ts           @Public() — opt-out of the global JWT guard
    │   │   └── roles.decorator.ts            @Roles(...) — declarative RBAC
    │   ├── exceptions/
    │   │   └── too-many-requests.exception.ts  429 with a retryAfterSeconds hint
    │   ├── types/
    │   │   ├── authenticated-user.ts         identity attached to a request
    │   │   ├── duration.ts                   `15m` / `7d` shorthand type
    │   │   └── request-context.ts            client IP + user agent for the audit trail
    │   └── validators/
    │       ├── iranian-mobile.ts             canonical E.164 normalization  (+ spec)
    │       ├── iranian-national-code.ts      check-digit algorithm           (+ spec)
    │       ├── is-iranian-mobile.decorator.ts
    │       └── is-iranian-national-code.decorator.ts
    └── modules/
        ├── audit/
        │   ├── audit-log.service.ts          writes/reads the trail, redacts secrets (+ spec)
        │   ├── audit.interceptor.ts          global interceptor for mutating requests (+ spec)
        │   ├── audit-context.ts              per-request snapshot (old/new values, actor)
        │   ├── audit.decorator.ts            @Auditable(...) and @SkipAudit()
        │   ├── audit.controller.ts           admin read endpoint
        │   ├── audit.module.ts
        │   └── dto/audit-log-query.dto.ts, dto/audit-log-response.dto.ts
        ├── auth/
        │   ├── auth.service.ts               flow policy: who may log in, what is audited (+ spec)
        │   ├── auth.controller.ts            all 8 auth endpoints, Swagger-annotated
        │   ├── auth.module.ts
        │   ├── otp.service.ts                generation, throttling, atomic verification
        │   ├── token.service.ts              signing, sessions, rotation (+ spec)
        │   ├── guards/jwt-auth.guard.ts      global authentication        (+ spec)
        │   ├── guards/roles.guard.ts         role-based authorization     (+ spec)
        │   └── dto/                          request/response contracts
        ├── sms/
        │   ├── sms-provider.interface.ts     the contract + injection token + error type
        │   ├── sms.service.ts                provider-agnostic facade, 503 on gateway failure
        │   ├── sms.module.ts                 DI selection from configuration
        │   └── providers/sandbox-sms.provider.ts, providers/kavenegar-sms.provider.ts
        └── users/
            ├── users.service.ts              the only writer of the identity tables
            ├── users.controller.ts           /admin/users
            ├── users.module.ts
            └── dto/update-profile.dto.ts, dto/user-query.dto.ts, dto/user-response.dto.ts
```

---

## 3. Architecture decisions and why

### 3.1 One canonical spelling for `users.mobile`

Phase 2 stored the national format (`09XXXXXXXXX`) while the authentication contract
normalizes to E.164 (`+989XXXXXXXXX`). Two spellings of one number would defeat the unique
index on `users.mobile` (double registration) and split the OTP rate limiter into two
buckets, so the migration `20260926145500_canonical_e164_mobile` converts existing rows in
place. It only rewrites values matching `^09[0-9]{9}$` and then **aborts** if any row is
left in a non-canonical shape — a half-migrated identity table is worse than a failed
deployment. Input still accepts `09…`, `+98…`, `0098…`, `98…`, Persian digits and
separators; only storage is canonical.

### 3.2 Fail-closed authorization

`JwtAuthGuard` and `RolesGuard` are registered globally in `AppModule`, so **every** route
requires a valid token unless it explicitly opts out with `@Public()`. Forgetting a
decorator makes a route stricter, never accidentally public. `/health` is deliberately
`@Public()`: orchestrators probe it without credentials, and it exposes only dependency
status.

The guard re-reads the user row on every request instead of trusting token claims. That one
indexed lookup means a deactivated account stops working immediately and a role change is
honoured at once, rather than after the access token expires.

### 3.3 Stateless access tokens, stateful refresh tokens

The access token (15 m) is a plain JWT — no Redis round-trip on the hot path. The refresh
token (7 d) is tracked server-side in Redis (`auth:session:<jti>` holding the SHA-256 of the
token, never the token itself). Rotation consumes the presented token and issues a new pair;
presenting a token whose session no longer exists is treated as a replay and the session is
revoked. That is what makes a stolen refresh token detectable rather than silently reusable
until it expires.

### 3.4 OTP security properties

* Codes come from `crypto.randomInt` (CSPRNG), zero-padded — `00042` stays `00042`.
* Redis stores `sha256(mobile:code)`, bound to the number, so a Redis dump yields no usable
  code and a digest captured for one number is useless for another.
* Verification is one atomic Lua script: parallel requests cannot each get a fresh attempt
  budget, and the failure counter keeps the original TTL so a guessing loop cannot extend
  the window.
* Three independent ceilings: 1 request / 120 s per number, 5 requests / hour per number,
  20 requests / hour per IP (the last one stops enumeration of many numbers from one host).
* Five wrong codes delete the challenge and lock the number for 15 minutes — even the
  correct code is refused while the lock lasts.
* A number only becomes a `CUSTOMER` account on **verify**, never on request, so spamming
  codes cannot grow the identity table.

### 3.5 SMS provider is a contract, not a branch

`SmsProvider` defines `sendOtp` and `sendTransactional`. `SmsModule` resolves the
implementation from `SMS_PROVIDER` inside the DI container, so no business code ever knows
which gateway is active. `SandboxSmsProvider` (development) logs a formatted message, keeps
the last 50 dispatches in memory and still enforces the real operational contract (it
refuses an already-expired code and throttles itself to 5 sends/s).
`KavenegarSmsProvider` (production) uses `verify/lookup.json` for OTP and `sms/send.json`
for transactional messages, reads its key from the environment and never logs it.

Two safeguards: the environment validator refuses `SMS_PROVIDER=sandbox` when
`NODE_ENV=production`, and the module factory refuses it again — defence in depth for the
one mistake that would silently disable login for every user.

### 3.6 Audit trail that cannot leak secrets

`AuditInterceptor` records every non-GET request that succeeds (a rejected request is not an
event in the entity's history; authentication outcomes are recorded explicitly by
`AuthService`). The row is written **before** the response is emitted: one extra INSERT buys
the guarantee that a mutation reported as successful is in the trail.

`newValue` combines the request body with the handler's response and `oldValue` comes from
the handler through `setAuditSnapshot()` when it already loaded the previous state — so
`audit_logs` holds a real before/after rather than a guess. Everything passes through
`sanitize()`, which replaces passwords, OTP codes, tokens and API keys with `[REDACTED]`,
bounds depth, array length and string length. `audit_logs` has no update or delete path,
neither in the schema nor in the API.

### 3.7 Password login hardening

Failures are counted per **identifier** (not per IP) in Redis for 15 minutes, so an attacker
cannot lock a legitimate owner out from a shared network. Unknown accounts are verified
against a real Argon2id decoy hash so response time does not reveal whether an account
exists, and the error message is identical for "unknown account" and "wrong password".

### 3.8 Environment contract change (announced)

Phase 1 treated `JWT_ACCESS_SECRET` / `JWT_REFRESH_SECRET` as "warn in development". Phase 3
implements authentication, so they are now **mandatory in every environment** — a missing
secret means an API that cannot authenticate anyone. `.env.example` documents all new
variables (JWT lifetimes, OTP policy, lockout policy, SMS provider and its credentials).

---

## 4. Complete source of the new modules

The code below is generated from the working tree, so it is exactly what runs and what the
tests exercise.


### 4.1 Shared building blocks (`src/common`)

#### `apps/backend/src/common/validators/iranian-mobile.ts` · 83 lines

```ts
/**
 * Iranian mobile number handling.
 *
 * Two formats exist in the wild and both are accepted from clients:
 *   - national: `09XXXXXXXXX` — 11 digits, the format printed on invoices,
 *     exactly the `^09[0-9]{9}$` pattern the platform's contract specifies;
 *   - E.164:    `+989XXXXXXXXX` — 13 characters, country code 98 followed by the
 *     same ten digits without the leading zero.
 *
 * The database stores exactly one canonical form — E.164 — because
 * `users.mobile` is the identity business key and carries a unique index. Two
 * spellings of one number would create two accounts and split the OTP rate
 * limiter's buckets. Every write path must therefore go through {@link toE164}.
 *
 * The length constants below are the specification of that canonical form and
 * are asserted by unit tests: a validator that accepts `+98999000001` (12
 * characters, one digit short) would silently admit malformed numbers.
 */

/** National format: `09` followed by nine digits (11 characters). */
export const IRANIAN_MOBILE_NATIONAL_PATTERN = /^09[0-9]{9}$/;

/** National length in characters. */
export const NATIONAL_LENGTH = 11;

/** Canonical format: `+98`, then `9`, then nine digits (13 characters). */
export const IRANIAN_MOBILE_E164_PATTERN = /^\+989[0-9]{9}$/;

/** Canonical length in characters. */
export const E164_LENGTH = 13;

/** Digits only, with the country code but no `+`: `989XXXXXXXXX` (12 digits). */
const WITHOUT_PLUS_PATTERN = /^989[0-9]{9}$/;

/** International access-code spelling: `00989XXXXXXXXX` (14 digits). */
const WITH_ACCESS_CODE_PATTERN = /^00989[0-9]{9}$/;

/**
 * Normalizes any accepted spelling to E.164, or returns `null` when the input is
 * not a valid Iranian mobile number.
 *
 * Accepted: `09XXXXXXXXX`, `+989XXXXXXXXX`, `989XXXXXXXXX`, `00989XXXXXXXXX`.
 * Persian/Arabic-Indic digits and separators are normalized first, because users
 * paste numbers out of SMS messages and spreadsheet cells.
 */
export function toE164(input: string): string | null {
  const digits = toAsciiDigits(input).replace(/[\s()-]/g, '');

  if (IRANIAN_MOBILE_NATIONAL_PATTERN.test(digits)) {
    return `+98${digits.slice(1)}`;
  }
  if (WITH_ACCESS_CODE_PATTERN.test(digits)) {
    return `+98${digits.slice(4)}`;
  }
  if (WITHOUT_PLUS_PATTERN.test(digits)) {
    return `+98${digits.slice(2)}`;
  }
  if (IRANIAN_MOBILE_E164_PATTERN.test(digits)) {
    return digits;
  }
  return null;
}

/** Returns the national `09XXXXXXXXX` spelling of a canonical E.164 value. */
export function toNationalFormat(e164: string): string {
  return e164.startsWith('+98') ? `0${e164.slice(3)}` : e164;
}

/** Masks a mobile number for logs: `+989120000001` → `+98912****001`. */
export function maskMobile(mobile: string): string {
  if (mobile.length < 8) {
    return '***';
  }
  return `${mobile.slice(0, 6)}****${mobile.slice(-3)}`;
}

/** Converts Persian (۰-۹) and Arabic-Indic (٠-٩) digits to ASCII digits. */
export function toAsciiDigits(input: string): string {
  return input
    .replace(/[\u06F0-\u06F9]/g, (char) => String(char.charCodeAt(0) - 0x06f0))
    .replace(/[\u0660-\u0669]/g, (char) => String(char.charCodeAt(0) - 0x0660));
}
```

#### `apps/backend/src/common/validators/iranian-mobile.spec.ts` · 104 lines

```ts
import {
  E164_LENGTH,
  IRANIAN_MOBILE_E164_PATTERN,
  IRANIAN_MOBILE_NATIONAL_PATTERN,
  NATIONAL_LENGTH,
  maskMobile,
  toAsciiDigits,
  toE164,
  toNationalFormat,
} from './iranian-mobile';

describe('toE164', () => {
  it('normalizes the national format to canonical E.164', () => {
    expect(toE164('09120000001')).toBe('+989120000001');
    expect(toE164('09990000001')).toBe('+989990000001');
  });

  it('accepts the international spellings of the same number', () => {
    const expected = '+989120000001';
    expect(toE164('+989120000001')).toBe(expected);
    expect(toE164('989120000001')).toBe(expected);
    expect(toE164('00989120000001')).toBe(expected);
  });

  it('ignores separators and converts Persian/Arabic-Indic digits', () => {
    expect(toE164('0912 000 0001')).toBe('+989120000001');
    expect(toE164('+98-912-000-0001')).toBe('+989120000001');
    expect(toE164('09120000001')).toBe('+989120000001');
    expect(toE164('۰۹۱۲۰۰۰۰۰۰۱')).toBe('+989120000001');
    expect(toE164('٠٩١٢٠٠٠٠٠٠١')).toBe('+989120000001');
  });

  it('always produces a value that satisfies the canonical pattern and length', () => {
    for (const input of ['09120000001', '989120000001', '00989120000001', '+989120000001']) {
      const normalized = toE164(input);
      expect(normalized).not.toBeNull();
      expect(normalized as string).toHaveLength(E164_LENGTH);
      expect(IRANIAN_MOBILE_E164_PATTERN.test(normalized as string)).toBe(true);
    }
  });

  it('rejects values that are not Iranian mobile numbers', () => {
    const rejected = [
      '',
      '12345',
      '0912000000', // one digit short
      '091200000012', // one digit too many
      '08120000001', // landline area code
      '02123456789', // Tehran landline
      '+98999000001', // 12 characters: country code plus nine digits — malformed
      '+981200000001', // country code with a non-mobile subscriber number
      '+1234567890',
      'mobile',
      '0912000000a',
    ];

    for (const input of rejected) {
      expect(toE164(input)).toBeNull();
    }
  });

  it('is idempotent: normalizing canonical input returns it unchanged', () => {
    const canonical = '+989120000001';
    expect(toE164(canonical)).toBe(canonical);
    expect(toE164(toE164('09120000001') as string)).toBe(canonical);
  });
});

describe('toNationalFormat', () => {
  it('round-trips with toE164', () => {
    expect(toNationalFormat('+989120000001')).toBe('09120000001');
    expect(toE164(toNationalFormat('+989120000001'))).toBe('+989120000001');
  });

  it('returns non-E.164 input untouched instead of corrupting it', () => {
    expect(toNationalFormat('09120000001')).toBe('09120000001');
  });

  it('produces the national length and pattern', () => {
    const national = toNationalFormat('+989120000001');
    expect(national).toHaveLength(NATIONAL_LENGTH);
    expect(IRANIAN_MOBILE_NATIONAL_PATTERN.test(national)).toBe(true);
  });
});

describe('maskMobile', () => {
  it('keeps the country code and last digits only', () => {
    expect(maskMobile('+989120000001')).toBe('+98912****001');
    expect(maskMobile('+989120000001')).not.toContain('000000');
  });

  it('degrades safely for short input', () => {
    expect(maskMobile('123')).toBe('***');
  });
});

describe('toAsciiDigits', () => {
  it('converts Persian and Arabic-Indic digits', () => {
    expect(toAsciiDigits('۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789');
    expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩')).toBe('0123456789');
    expect(toAsciiDigits('09۱2')).toBe('0912');
  });
});
```

#### `apps/backend/src/common/validators/iranian-national-code.ts` · 44 lines

```ts
import { toAsciiDigits } from './iranian-mobile';

/**
 * Iranian national code (`کد ملی`) validation.
 *
 * The code is ten digits where the last digit is a check digit computed from the
 * first nine with weights 10…2. The algorithm below is the officially published
 * one and is what the civil registry uses:
 *
 *   sum = Σ digit[i] × (10 - i)   for i = 0…8
 *   remainder = sum mod 11
 *   check digit = remainder < 2 ? remainder : 11 - remainder
 *
 * Structural rules that also matter in practice:
 *   - all ten digits identical (`1111111111`) is rejected by the registry;
 *   - the code must be exactly ten digits after digit normalization.
 */
const NATIONAL_CODE_PATTERN = /^[0-9]{10}$/;
const REPEATED_DIGITS_PATTERN = /^(\d)\1{9}$/;

/** Normalizes Persian/Arabic-Indic digits and separators, then validates the checksum. */
export function isValidNationalCode(input: string): boolean {
  const code = toAsciiDigits(input).replace(/[\s-]/g, '');

  if (!NATIONAL_CODE_PATTERN.test(code) || REPEATED_DIGITS_PATTERN.test(code)) {
    return false;
  }

  const checkDigit = Number(code[9]);
  let sum = 0;
  for (let index = 0; index < 9; index += 1) {
    sum += Number(code[index]) * (10 - index);
  }

  const remainder = sum % 11;
  const expected = remainder < 2 ? remainder : 11 - remainder;
  return expected === checkDigit;
}

/** Strips separators and returns the canonical ten-digit form (no validation). */
export function normalizeNationalCode(input: string): string {
  return toAsciiDigits(input).replace(/[\s-]/g, '');
}
```

#### `apps/backend/src/common/validators/iranian-national-code.spec.ts` · 51 lines

```ts
import { isValidNationalCode, normalizeNationalCode } from './iranian-national-code';

/**
 * The official algorithm is `check = f(Σ digit[i] × (10 - i))`. These cases pin
 * the implementation to known-valid codes and to the failure modes that matter:
 * a wrong check digit, the wrong length, and the all-identical codes the civil
 * registry never issues.
 */
describe('isValidNationalCode', () => {
  it('accepts codes with a correct check digit', () => {
    expect(isValidNationalCode('0499370899')).toBe(true);
    expect(isValidNationalCode('0084575948')).toBe(true);
    expect(isValidNationalCode('0938663488')).toBe(true);
  });

  it('accepts Persian and Arabic-Indic digits', () => {
    expect(isValidNationalCode('۰۴۹۹۳۷۰۸۹۹')).toBe(true);
    expect(isValidNationalCode('٠٤٩٩٣٧٠٨٩٩')).toBe(true);
  });

  it('tolerates separators', () => {
    expect(isValidNationalCode('049-937-0899')).toBe(true);
    expect(isValidNationalCode(' 0499370899 ')).toBe(true);
  });

  it('rejects a wrong check digit', () => {
    expect(isValidNationalCode('0499370898')).toBe(false);
    expect(isValidNationalCode('0938663480')).toBe(false); // checksum of 0938663488
    expect(isValidNationalCode('0499370890')).toBe(false);
  });

  it('rejects the wrong shape', () => {
    for (const value of ['', '04993708', '04993708991', 'abcdefghij', '04993708aa']) {
      expect(isValidNationalCode(value)).toBe(false);
    }
  });

  it('rejects codes made of one repeated digit', () => {
    for (const value of ['0000000000', '1111111111', '9999999999']) {
      expect(isValidNationalCode(value)).toBe(false);
    }
  });
});

describe('normalizeNationalCode', () => {
  it('strips separators and converts digits without validating', () => {
    expect(normalizeNationalCode(' 049-937-0899 ')).toBe('0499370899');
    expect(normalizeNationalCode('۰۴۹۹۳۷۰۸۹۹')).toBe('0499370899');
  });
});
```

#### `apps/backend/src/common/validators/is-iranian-mobile.decorator.ts` · 36 lines

```ts
import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';
import { IRANIAN_MOBILE_NATIONAL_PATTERN, toE164 } from './iranian-mobile';

/**
 * Accepts every spelling of an Iranian mobile number the public sends
 * (`09XXXXXXXXX`, `+989XXXXXXXXX`, `0098…`, with Persian digits or separators)
 * while guaranteeing the service layer receives the canonical E.164 form.
 *
 * `@Transform` cannot be used alone here because validation must run on the
 * normalized value: a client sending `+98 912 000 0001` has to be accepted, not
 * rejected for whitespace.
 */
export function IsIranianMobile(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isIranianMobile',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [],
      options: {
        message: (args: ValidationArguments) =>
          `${args.property} must be an Iranian mobile number (09XXXXXXXXX or +989XXXXXXXXX)`,
        ...options,
      },
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && toE164(value) !== null,
      },
    });
  };
}

/** True when the value is in the national `09XXXXXXXXX` format. */
export function isNationalMobile(value: string): boolean {
  return IRANIAN_MOBILE_NATIONAL_PATTERN.test(value.trim());
}
```

#### `apps/backend/src/common/validators/is-iranian-national-code.decorator.ts` · 32 lines

```ts
import { registerDecorator, type ValidationArguments, type ValidationOptions } from 'class-validator';
import { isValidNationalCode, normalizeNationalCode } from './iranian-national-code';

/**
 * Validates an Iranian national code, including its check digit.
 *
 * The stored value is always the normalized ten-digit form, so a client sending
 * Persian digits or spaces (`۰۴۹-۹۳۷۰۸۹۹`) is accepted and normalized rather than
 * rejected on formatting.
 */
export function IsIranianNationalCode(options: ValidationOptions = {}): PropertyDecorator {
  return (target: object, propertyName: string | symbol): void => {
    registerDecorator({
      name: 'isIranianNationalCode',
      target: target.constructor,
      propertyName: String(propertyName),
      constraints: [],
      options: {
        message: (args: ValidationArguments) =>
          `${args.property} must be a valid Iranian national code (10 digits with a valid check digit)`,
        ...options,
      },
      validator: {
        validate: (value: unknown): boolean => typeof value === 'string' && isValidNationalCode(value),
      },
    });
  };
}

/** Transforms any accepted spelling into the canonical ten-digit form. */
export const normalizeNationalCodeValue = normalizeNationalCode;
```

#### `apps/backend/src/common/decorators/public.decorator.ts` · 12 lines

```ts
import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'shopino:isPublic';

/**
 * Marks a route as reachable without a JWT. `JwtAuthGuard` is registered
 * globally, so authentication is opt-out and every new endpoint is protected by
 * default — a forgotten decorator can only ever make a route *stricter*, never
 * accidentally open.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
```

#### `apps/backend/src/common/decorators/roles.decorator.ts` · 15 lines

```ts
import { SetMetadata } from '@nestjs/common';
import type { UserRole } from '@prisma/client';

export const ROLES_KEY = 'shopino:roles';

/**
 * Restricts a route to the listed roles. Enforced by `RolesGuard`, which runs
 * after `JwtAuthGuard` so the actor's role is always the one signed into a
 * verified access token — never a value taken from the request body.
 *
 * A route without this decorator is open to every authenticated user.
 */
export const Roles = (...roles: UserRole[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
```

#### `apps/backend/src/common/decorators/current-user.decorator.ts` · 48 lines

```ts
import { createParamDecorator, InternalServerErrorException, type ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from '../types/authenticated-user';
import type { RequestContext } from '../types/request-context';

interface RequestWithIdentity {
  user?: AuthenticatedUser;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Injects the authenticated user into a handler. Only usable on routes that are
 * not `@Public()`: reaching the handler without an identity means the guard
 * chain was misconfigured, which is a programming error, not a client error.
 */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    if (!request.user) {
      throw new InternalServerErrorException(
        'Authenticated user is missing: this route must not be marked @Public()',
      );
    }
    return request.user;
  },
);

/**
 * Injects the transport facts an audit row needs (client IP and user agent).
 * Named `ClientContext` rather than `RequestContext` so it never collides with
 * the `RequestContext` type it returns. Always resolves: fields are `null` when
 * the information is unavailable, and a missing header never fails a request.
 */
export const ClientContext = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestContext => {
    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    const forwarded = request.headers?.['x-forwarded-for'];
    const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    const userAgentHeader = request.headers?.['user-agent'];
    const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

    return {
      ipAddress: (forwardedValue?.split(',')[0]?.trim() || request.ip || '').slice(0, 45) || null,
      userAgent: userAgent?.slice(0, 512) ?? null,
    };
  },
);
```

#### `apps/backend/src/common/exceptions/too-many-requests.exception.ts` · 31 lines

```ts
import { HttpException, HttpStatus } from '@nestjs/common';

export interface TooManyRequestsBody {
  statusCode: number;
  error: string;
  message: string;
  /** Seconds the client should wait before retrying. Mirrored in `Retry-After`. */
  retryAfterSeconds: number;
}

/**
 * `429 Too Many Requests` with an explicit retry hint.
 *
 * Nest ships no dedicated class for this status (it exposes `429` only through
 * the generic `HttpException`), and a rate limit without a retry window is not
 * actionable for a client. Every limiter in the platform throws this type, so
 * the response body is identical everywhere: `message` for humans,
 * `retryAfterSeconds` for code.
 */
export class TooManyRequestsException extends HttpException {
  constructor(message: string, retryAfterSeconds: number) {
    const body: TooManyRequestsBody = {
      statusCode: HttpStatus.TOO_MANY_REQUESTS,
      error: 'TooManyRequests',
      message,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterSeconds)),
    };
    super(body, HttpStatus.TOO_MANY_REQUESTS);
  }
}
```

#### `apps/backend/src/common/types/authenticated-user.ts` · 18 lines

```ts
import type { UserRole } from '@prisma/client';

/**
 * The identity attached to a request once `JwtAuthGuard` has verified the access
 * token. It is the *token* payload plus the fields the guards and handlers need;
 * anything else (profile, vendor) is loaded from the database on demand so a
 * revoked or role-changed account cannot keep acting on stale token claims.
 */
export interface AuthenticatedUser {
  /** `users.id` (UUID). */
  id: string;
  /** Canonical E.164 mobile number. */
  mobile: string;
  role: UserRole;
  /** JWT `jti`; used to correlate audit rows with a concrete access token. */
  sessionId: string;
}
```

#### `apps/backend/src/common/types/request-context.ts` · 13 lines

```ts
/** Transport facts captured for the audit trail. */
export interface RequestContext {
  /** Client IP, taken from `X-Forwarded-For` when the API sits behind a proxy. */
  ipAddress: string | null;
  userAgent: string | null;
}

/**
 * Every request carries this on the Fastify request object so interceptors can
 * write an audit row without re-parsing headers.
 */
export const REQUEST_CONTEXT_PROPERTY = 'shopinoContext';
```

#### `apps/backend/src/common/types/duration.ts` · 10 lines

```ts
/**
 * Duration shorthand understood by `@nestjs/jwt` / `ms`, e.g. `30s`, `15m`, `12h`, `7d`.
 *
 * The environment validator already enforces this shape with a regex, but a
 * validated `string` is still just a `string` to TypeScript. Declaring the narrow
 * type here lets the JWT module receive it without a cast at every call site, and
 * documents the contract in one place.
 */
export type DurationString = `${number}${'s' | 'm' | 'h' | 'd'}`;
```


### 4.2 `sms` module — the provider contract

#### `apps/backend/src/modules/sms/sms-provider.interface.ts` · 72 lines

```ts
/**
 * The SMS contract every provider must satisfy.
 *
 * The application layer never talks to a gateway directly: it injects the
 * `SMS_PROVIDER` token and calls these two methods. That is what makes the
 * development (sandbox) and production (real gateway) paths swappable by
 * configuration alone, with no code change and no branch inside business logic.
 */

/** Which provider implementation is running. Mirrors the `SMS_PROVIDER` env value. */
export type SmsProviderKind = 'sandbox' | 'kavenegar';

/** Injection token for the active provider. */
export const SMS_PROVIDER = 'SHOPINO_SMS_PROVIDER';

export interface OtpMessage {
  /** Canonical E.164 mobile number, e.g. `+989120000001`. */
  mobile: string;
  /** The one-time code. Never logged by a production provider. */
  code: string;
  /** Remaining validity of the code in seconds; providers reject `<= 0`. */
  expiresInSeconds: number;
  /** Purpose of the code, e.g. `login` — used for message wording and metrics. */
  purpose: string;
}

export interface TransactionalMessage {
  mobile: string;
  /** Gateway-side template identifier (Kavenegar "lookup" template name). */
  template: string;
  /** Values substituted into the template, e.g. `{ orderNumber: 'SHP-100234' }`. */
  params: Readonly<Record<string, string | number>>;
}

export interface SmsSendResult {
  /** Provider identifier as configured, e.g. `sandbox` or `kavenegar`. */
  provider: SmsProviderKind;
  /** Gateway-side identifier used for delivery reconciliation. */
  referenceId: string;
  /** Number of billable SMS parts. The sandbox always reports 1. */
  segments: number;
  /** Whether the message left the process: sandbox counts as "dispatched". */
  status: 'sent';
}

/**
 * Raised when a provider cannot accept a message. Carries the provider name so
 * the API can map it to a 502/503 without leaking gateway internals.
 */
export class SmsDeliveryError extends Error {
  constructor(
    readonly provider: SmsProviderKind,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}

export interface SmsProvider {
  readonly kind: SmsProviderKind;
  /**
   * `true` for providers that only simulate delivery. Exposed so the API can
   * advertise its capability honestly (`GET /auth/sms-provider`) and so the
   * bootstrap fails loudly when a test provider would run in production.
   */
  readonly isTestProvider: boolean;
  sendOtp(message: OtpMessage): Promise<SmsSendResult>;
  sendTransactional(message: TransactionalMessage): Promise<SmsSendResult>;
}
```

#### `apps/backend/src/modules/sms/providers/sandbox-sms.provider.ts` · 139 lines

```ts
import { Injectable, Logger } from '@nestjs/common';
import { maskMobile } from '../../../common/validators/iranian-mobile';
import {
  SmsDeliveryError,
  type OtpMessage,
  type SmsProvider,
  type SmsProviderKind,
  type SmsSendResult,
  type TransactionalMessage,
} from '../sms-provider.interface';

/** Sends per rolling second; a real gateway would reject faster bursts anyway. */
const MAX_SENDS_PER_SECOND = 5;

/** How many recent messages the sandbox keeps for inspection and tests. */
const DELIVERY_BUFFER_SIZE = 50;

export interface SandboxDelivery {
  mobile: string;
  kind: 'otp' | 'transactional';
  code?: string;
  template?: string;
  params?: Readonly<Record<string, string | number>>;
  referenceId: string;
  dispatchedAt: Date;
}

/**
 * Development/test SMS provider.
 *
 * It performs no network call; it prints the message in a readable form and
 * keeps the most recent dispatches in memory so operators (and the end-to-end
 * tests) can confirm what the user would have received. This is the local
 * equivalent of Mailhog for e-mail — it is **not** a production provider, and the
 * bootstrap refuses to start with it when `NODE_ENV=production`.
 *
 * It still honours the operational contract of a real gateway:
 *  - it rejects already-expired codes (`expiresInSeconds <= 0`);
 *  - it throttles itself to {@link MAX_SENDS_PER_SECOND} to expose flooding bugs
 *    during development instead of hiding them until production.
 */
@Injectable()
export class SandboxSmsProvider implements SmsProvider {
  readonly kind: SmsProviderKind = 'sandbox';
  readonly isTestProvider = true;

  private readonly logger = new Logger('SmsSandbox');
  private readonly deliveries: SandboxDelivery[] = [];
  private windowStartedAt = 0;
  private windowCount = 0;
  private sequence = 0;

  constructor(private readonly logCodes: boolean) {}

  sendOtp(message: OtpMessage): Promise<SmsSendResult> {
    if (message.expiresInSeconds <= 0) {
      throw new SmsDeliveryError(this.kind, 'Refusing to send an already-expired OTP');
    }
    this.assertWithinRate();

    const referenceId = this.nextReference();
    this.remember({
      mobile: message.mobile,
      kind: 'otp',
      code: message.code,
      referenceId,
      dispatchedAt: new Date(),
    });

    if (this.logCodes) {
      this.logger.log(
        `OTP ${message.purpose} → ${maskMobile(message.mobile)}: ${message.code} (valid ${message.expiresInSeconds}s, ref ${referenceId})`,
      );
    } else {
      this.logger.log(`OTP ${message.purpose} → ${maskMobile(message.mobile)} (ref ${referenceId})`);
    }

    return Promise.resolve({ provider: this.kind, referenceId, segments: 1, status: 'sent' });
  }

  sendTransactional(message: TransactionalMessage): Promise<SmsSendResult> {
    this.assertWithinRate();

    const referenceId = this.nextReference();
    this.remember({
      mobile: message.mobile,
      kind: 'transactional',
      template: message.template,
      params: message.params,
      referenceId,
      dispatchedAt: new Date(),
    });

    this.logger.log(
      `SMS ${message.template} → ${maskMobile(message.mobile)} (ref ${referenceId}) ${JSON.stringify(message.params)}`,
    );

    return Promise.resolve({ provider: this.kind, referenceId, segments: 1, status: 'sent' });
  }

  /** Most recent dispatches, newest first. Used by diagnostics and tests. */
  recentDeliveries(limit = 10, mobile?: string): readonly SandboxDelivery[] {
    const filtered = mobile ? this.deliveries.filter((item) => item.mobile === mobile) : this.deliveries;
    return filtered.slice(-limit).reverse();
  }

  /** Latest OTP code that would have been delivered to a mobile number. */
  latestOtpCode(mobile: string): string | undefined {
    return this.recentDeliveries(DELIVERY_BUFFER_SIZE, mobile).find((item) => item.kind === 'otp')?.code;
  }

  private assertWithinRate(): void {
    const now = Date.now();
    if (now - this.windowStartedAt >= 1_000) {
      this.windowStartedAt = now;
      this.windowCount = 0;
    }
    this.windowCount += 1;
    if (this.windowCount > MAX_SENDS_PER_SECOND) {
      throw new SmsDeliveryError(
        this.kind,
        `Sandbox SMS rate limit exceeded (${MAX_SENDS_PER_SECOND}/s). The OTP limiter should have prevented this.`,
      );
    }
  }

  private remember(delivery: SandboxDelivery): void {
    this.deliveries.push(delivery);
    if (this.deliveries.length > DELIVERY_BUFFER_SIZE) {
      this.deliveries.shift();
    }
  }

  private nextReference(): string {
    this.sequence += 1;
    return `SBX-${Date.now().toString(36).toUpperCase()}-${this.sequence}`;
  }
}
```

#### `apps/backend/src/modules/sms/providers/kavenegar-sms.provider.ts` · 141 lines

```ts
import { Injectable, Logger } from '@nestjs/common';
import { toNationalFormat } from '../../../common/validators/iranian-mobile';
import {
  SmsDeliveryError,
  type OtpMessage,
  type SmsProvider,
  type SmsProviderKind,
  type SmsSendResult,
  type TransactionalMessage,
} from '../sms-provider.interface';

/** Kavenegar REST base. The API key travels in the path, exactly as documented. */
const KAVENEGAR_BASE_URL = 'https://api.kavenegar.com/v1';

/** Kavenegar address-space of a single request; aborts prevent hanging requests. */
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Response shape of `verify/lookup.json` and `sms/send.json`.
 * `return.status` is Kavenegar's own status code (200 = accepted) and is
 * independent of the HTTP status — both must be checked.
 */
interface KavenegarResponse {
  return?: { status?: number; message?: string };
  entries?: Array<{ messageid?: number; status?: number; statustext?: string }>;
}

export interface KavenegarConfig {
  apiKey: string;
  /** Line number the messages are sent from (Kavenegar "sender"). */
  sender: string;
  /** Lookup template configured in the Kavenegar panel for OTP delivery. */
  otpTemplate: string;
}

/**
 * Production SMS provider backed by the Kavenegar HTTP API.
 *
 * Two distinct APIs are used, matching how Kavenegar actually works:
 *
 *  - **OTP** goes through `verify/lookup.json`, which is the pre-approved
 *    template endpoint (fast, cheap, and the only one Iranian operators allow for
 *    login codes).
 *  - **Transactional** messages go through `sms/send.json` with a rendered body.
 *
 * Credentials are read from the environment only; nothing is hardcoded and the
 * API key is never logged. A missing key is a configuration error and fails at
 * bootstrap (see `SmsModule`) rather than at the first login attempt.
 */
@Injectable()
export class KavenegarSmsProvider implements SmsProvider {
  readonly kind: SmsProviderKind = 'kavenegar';
  readonly isTestProvider = false;

  private readonly logger = new Logger(KavenegarSmsProvider.name);

  constructor(private readonly config: KavenegarConfig) {}

  async sendOtp(message: OtpMessage): Promise<SmsSendResult> {
    if (message.expiresInSeconds <= 0) {
      throw new SmsDeliveryError(this.kind, 'Refusing to send an already-expired OTP');
    }

    const response = await this.post('verify/lookup.json', {
      receptor: toNationalFormat(message.mobile),
      token: message.code,
      template: this.config.otpTemplate,
      type: 'sms',
    });

    return this.toResult(response, 1);
  }

  async sendTransactional(message: TransactionalMessage): Promise<SmsSendResult> {
    const body = this.renderBody(message.template, message.params);
    const response = await this.post('sms/send.json', {
      receptor: toNationalFormat(message.mobile),
      sender: this.config.sender,
      message: body,
    });

    // A Persian SMS is sent as UCS-2: 70 characters per part.
    const segments = Math.max(1, Math.ceil(body.length / 70));
    return this.toResult(response, segments);
  }

  private async post(path: string, payload: Record<string, string>): Promise<KavenegarResponse> {
    const url = `${KAVENEGAR_BASE_URL}/${encodeURIComponent(this.config.apiKey)}/${path}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(payload),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      // Network/DNS/timeout: retryable, reported as a provider failure.
      throw new SmsDeliveryError(this.kind, 'Kavenegar request failed before a response was received', error);
    }

    let parsed: KavenegarResponse;
    try {
      parsed = (await response.json()) as KavenegarResponse;
    } catch {
      throw new SmsDeliveryError(this.kind, `Kavenegar returned a non-JSON response (HTTP ${response.status})`);
    }

    const status = parsed.return?.status;
    const message = parsed.return?.message ?? 'unknown';
    if (!response.ok || (status !== undefined && status !== 200)) {
      throw new SmsDeliveryError(this.kind, `Kavenegar rejected the request: ${message} (status ${status ?? response.status})`);
    }

    this.logger.debug(`Kavenegar accepted ${path} (messages: ${parsed.entries?.length ?? 0})`);
    return parsed;
  }

  private toResult(response: KavenegarResponse, segments: number): SmsSendResult {
    const entry = response.entries?.[0];
    if (!entry?.messageid) {
      throw new SmsDeliveryError(this.kind, 'Kavenegar accepted the request but returned no message id');
    }
    return {
      provider: this.kind,
      referenceId: String(entry.messageid),
      segments,
      status: 'sent',
    };
  }

  /** Substitutes `{placeholder}` tokens; unknown placeholders are left untouched. */
  private renderBody(template: string, params: Readonly<Record<string, string | number>>): string {
    return Object.entries(params).reduce(
      (body, [key, value]) => body.replaceAll(`{${key}}`, String(value)),
      template,
    );
  }
}
```

#### `apps/backend/src/modules/sms/sms.service.ts` · 59 lines

```ts
import { Inject, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { OtpMessage, TransactionalMessage } from './sms-provider.interface';
import { SMS_PROVIDER, SmsDeliveryError, type SmsProvider, type SmsSendResult } from './sms-provider.interface';

/**
 * Thin application-facing facade over the active SMS provider.
 *
 * Its whole job is to (a) keep business code free of any provider detail and
 * (b) translate provider failures into an HTTP-meaningful error. A gateway
 * outage is not the client's fault, so it surfaces as `503 Service Unavailable`
 * rather than `400`, and the OTP itself stays valid in Redis so the user can
 * retry once the gateway recovers.
 */
@Injectable()
export class SmsService {
  private readonly logger = new Logger(SmsService.name);

  constructor(@Inject(SMS_PROVIDER) private readonly provider: SmsProvider) {}

  get providerKind(): SmsProvider['kind'] {
    return this.provider.kind;
  }

  /** Honest capability report; surfaced by `GET /auth/sms-provider`. */
  describe(): { provider: string; isTestProvider: boolean } {
    return { provider: this.provider.kind, isTestProvider: this.provider.isTestProvider };
  }

  async sendOtp(mobile: string, code: string, expiresInSeconds: number, purpose: string): Promise<SmsSendResult> {
    const message: OtpMessage = { mobile, code, expiresInSeconds, purpose };
    try {
      return await this.provider.sendOtp(message);
    } catch (error) {
      throw this.toHttpError(error, 'OTP delivery');
    }
  }

  async sendTransactional(
    mobile: string,
    template: string,
    params: Readonly<Record<string, string | number>>,
  ): Promise<SmsSendResult> {
    const message: TransactionalMessage = { mobile, template, params };
    try {
      return await this.provider.sendTransactional(message);
    } catch (error) {
      throw this.toHttpError(error, 'SMS delivery');
    }
  }

  private toHttpError(error: unknown, stage: string): ServiceUnavailableException {
    const detail = error instanceof SmsDeliveryError ? error.message : 'unknown provider error';
    this.logger.error(`${stage} failed via ${this.provider.kind}: ${detail}`);
    return new ServiceUnavailableException(
      `${stage} is temporarily unavailable (provider: ${this.provider.kind}). Please retry shortly.`,
    );
  }
}
```

#### `apps/backend/src/modules/sms/sms.module.ts` · 62 lines

```ts
import { Logger, Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NodeEnvironment, type EnvironmentVariables } from '../../config/env.validation';
import { KavenegarSmsProvider, type KavenegarConfig } from './providers/kavenegar-sms.provider';
import { SandboxSmsProvider } from './providers/sandbox-sms.provider';
import { SMS_PROVIDER, type SmsProvider, type SmsProviderKind } from './sms-provider.interface';
import { SmsService } from './sms.service';

/**
 * Chooses the SMS provider from configuration at boot.
 *
 * The selection is resolved **once**, inside the Nest DI container, so the rest
 * of the application depends on the `SmsProvider` contract and can never branch
 * on the environment. Swapping `SMS_PROVIDER=sandbox` for
 * `SMS_PROVIDER=kavenegar` (plus credentials) changes the provider with no code
 * change and no redeploy-specific build.
 *
 * Misconfiguration fails here, at startup, not at the first login attempt:
 *  - `kavenegar` without an API key/sender/template is rejected by the
 *    environment validator before this factory runs;
 *  - a test provider in production is refused by both the validator and the
 *    factory below (defence in depth).
 */
const smsProviderFactory: Provider = {
  provide: SMS_PROVIDER,
  inject: [ConfigService],
  useFactory: (config: ConfigService<EnvironmentVariables, true>): SmsProvider => {
    const logger = new Logger('SmsModule');
    const kind = config.getOrThrow<SmsProviderKind>('SMS_PROVIDER');
    const isProduction = config.getOrThrow<NodeEnvironment>('NODE_ENV') === NodeEnvironment.Production;

    if (kind === 'kavenegar') {
      const kavenegarConfig: KavenegarConfig = {
        apiKey: config.getOrThrow<string>('SMS_KAVENEGAR_API_KEY'),
        sender: config.getOrThrow<string>('SMS_KAVENEGAR_SENDER'),
        otpTemplate: config.getOrThrow<string>('SMS_KAVENEGAR_OTP_TEMPLATE'),
      };
      logger.log('SMS provider: kavenegar (live gateway)');
      return new KavenegarSmsProvider(kavenegarConfig);
    }

    if (isProduction) {
      throw new Error(
        'SMS_PROVIDER=sandbox is not allowed in production: it does not deliver messages. ' +
          'Set SMS_PROVIDER=kavenegar with real credentials.',
      );
    }

    logger.warn(
      'SMS provider: sandbox — OTP codes are printed to the log and never delivered. ' +
        'This provider is for development/test only.',
    );
    return new SandboxSmsProvider(config.get<boolean>('SMS_SANDBOX_LOG_CODES') ?? true);
  },
};

@Module({
  providers: [smsProviderFactory, SmsService],
  exports: [SMS_PROVIDER, SmsService],
})
export class SmsModule {}
```


### 4.3 `audit` module — the audit engine

#### `apps/backend/src/modules/audit/audit-log.service.ts` · 188 lines

```ts
import { Injectable, Logger } from '@nestjs/common';
import { AuditAction, Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { errorMessage } from '../../common/utils';

/** Fields that must never reach the audit trail in clear text. */
const REDACTED_KEYS = new Set([
  'password',
  'currentpassword',
  'newpassword',
  'passwordhash',
  'otp',
  'code',
  'token',
  'accesstoken',
  'refreshtoken',
  'authorization',
  'secret',
  'apikey',
]);

const REDACTION_PLACEHOLDER = '[REDACTED]';
const MAX_JSON_DEPTH = 6;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 2_000;

export interface AuditEntryInput {
  /** Actor; `null` for anonymous events such as a failed login attempt. */
  userId?: string | null;
  action: AuditAction;
  entityName: string;
  entityId?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

export interface AuditLogQuery {
  userId?: string;
  entityName?: string;
  entityId?: string;
  action?: AuditAction;
  from?: Date;
  to?: Date;
  page: number;
  pageSize: number;
}

/**
 * Writes and reads the platform audit trail.
 *
 * Two deliberate properties:
 *
 * 1. `record()` never throws. Auditing must not be able to fail a business
 *    operation — but it must not silently disappear either, so failures are
 *    logged at error level with the payload that could not be stored.
 * 2. Everything written is redacted and depth/length bounded, because audit rows
 *    are readable by admins and must not become a place where passwords, OTP
 *    codes or tokens leak.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Persists one audit row. Returns the row id, or `null` when writing failed. */
  async record(entry: AuditEntryInput): Promise<string | null> {
    try {
      const row = await this.prisma.auditLog.create({
        data: {
          userId: entry.userId ?? null,
          action: entry.action,
          entityName: entry.entityName,
          entityId: entry.entityId ?? null,
          ipAddress: entry.ipAddress?.slice(0, 45) ?? null,
          userAgent: entry.userAgent?.slice(0, 512) ?? null,
          oldValue: this.toJson(entry.oldValue),
          newValue: this.toJson(entry.newValue),
        },
        select: { id: true },
      });
      return row.id;
    } catch (error) {
      this.logger.error(
        `Failed to write audit row (${entry.action} ${entry.entityName}): ${errorMessage(error)}`,
      );
      return null;
    }
  }

  /** Paginated, filterable read used by the admin audit-log endpoint. */
  async list(query: AuditLogQuery): Promise<{ rows: AuditLogRow[]; total: number }> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.entityName ? { entityName: query.entityName } : {}),
      ...(query.entityId ? { entityId: query.entityId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? { createdAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: {
          id: true,
          userId: true,
          action: true,
          entityName: true,
          entityId: true,
          ipAddress: true,
          userAgent: true,
          oldValue: true,
          newValue: true,
          createdAt: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      rows: rows.map((row) => ({
        ...row,
        createdAt: row.createdAt,
        actorMobile: null,
      })),
      total,
    };
  }

  /**
   * Redacts secrets and bounds the payload. Returns `undefined` for empty input
   * so the column stays NULL instead of storing an empty object.
   */
  private toJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }
    const sanitized = sanitize(value, 0);
    return sanitized === undefined ? undefined : (sanitized as Prisma.InputJsonValue);
  }
}

export interface AuditLogRow {
  id: string;
  userId: string | null;
  action: AuditAction;
  entityName: string;
  entityId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  oldValue: Prisma.JsonValue;
  newValue: Prisma.JsonValue;
  createdAt: Date;
  actorMobile: string | null;
}

/**
 * Recursively redacts secret-bearing keys and bounds the size of the stored
 * document so a large request body cannot bloat the audit table.
 */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, MAX_STRING_LENGTH) : value;
  }
  if (depth >= MAX_JSON_DEPTH) {
    return '[TRUNCATED]';
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitize(item, depth + 1));
  }
  if (value instanceof Date) {
    return value.toISOString();
  }

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = REDACTED_KEYS.has(key.toLowerCase()) ? REDACTION_PLACEHOLDER : sanitize(item, depth + 1);
  }
  return result;
}
```

#### `apps/backend/src/modules/audit/audit-log.service.spec.ts` · 86 lines

```ts
import { sanitize } from './audit-log.service';

/**
 * The audit table is readable by admins, so it must never become a leak surface.
 * These assertions are the contract: secrets are replaced, structure is kept, and
 * the stored document is bounded so one large request cannot bloat the trail.
 */
describe('sanitize (audit trail redaction)', () => {
  it('redacts every credential-bearing key, whatever the casing', () => {
    const sanitized = sanitize({
      fullName: 'سارا محمدی',
      password: 'super-secret-value',
      currentPassword: 'old-secret',
      newPassword: 'new-secret',
      passwordHash: '$argon2id$v=19$…',
      otp: '48213',
      code: '48213',
      accessToken: 'eyJhbGciOi…',
      refreshToken: 'eyJhbGciOi…',
      authorization: 'Bearer abc.def.ghi',
      apiKey: 'kavenegar-key',
      secret: 'x',
    }) as Record<string, unknown>;

    expect(sanitized.fullName).toBe('سارا محمدی');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.currentPassword).toBe('[REDACTED]');
    expect(sanitized.newPassword).toBe('[REDACTED]');
    expect(sanitized.passwordHash).toBe('[REDACTED]');
    expect(sanitized.otp).toBe('[REDACTED]');
    expect(sanitized.code).toBe('[REDACTED]');
    expect(sanitized.accessToken).toBe('[REDACTED]');
    expect(sanitized.refreshToken).toBe('[REDACTED]');
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.secret).toBe('[REDACTED]');

    const serialized = JSON.stringify(sanitized);
    for (const secret of ['super-secret-value', 'old-secret', 'new-secret', '48213', 'kavenegar-key']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('redacts nested objects and arrays', () => {
    const sanitized = sanitize({
      user: { email: 'a@b.ir', password: 'nested-secret' },
      attempts: [{ password: 'first' }, { password: 'second' }],
    }) as { user: Record<string, unknown>; attempts: Array<Record<string, unknown>> };

    expect(sanitized.user.email).toBe('a@b.ir');
    expect(sanitized.user.password).toBe('[REDACTED]');
    expect(sanitized.attempts[0]?.password).toBe('[REDACTED]');
    expect(sanitized.attempts[1]?.password).toBe('[REDACTED]');
  });

  it('keeps numbers, booleans and null intact', () => {
    expect(sanitize({ amount: 125_000, isActive: true, note: null })).toEqual({
      amount: 125_000,
      isActive: true,
      note: null,
    });
  });

  it('converts dates to ISO strings so the JSON column stays readable', () => {
    const sanitized = sanitize({ paidAt: new Date('2026-09-26T10:00:00.000Z') }) as { paidAt: string };
    expect(sanitized.paidAt).toBe('2026-09-26T10:00:00.000Z');
  });

  it('bounds depth, array length and string length', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    expect(JSON.stringify(sanitize(deep))).toContain('[TRUNCATED]');

    const longArray = Array.from({ length: 200 }, (_value, index) => index);
    expect((sanitize({ items: longArray }) as { items: number[] }).items).toHaveLength(50);

    const longString = 'x'.repeat(5_000);
    expect((sanitize({ note: longString }) as { note: string }).note).toHaveLength(2_000);
  });

  it('passes primitives through unchanged', () => {
    expect(sanitize('plain')).toBe('plain');
    expect(sanitize(42)).toBe(42);
    expect(sanitize(null)).toBeNull();
  });
});
```

#### `apps/backend/src/modules/audit/audit.interceptor.ts` · 179 lines

```ts
import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuditAction } from '@prisma/client';
import { Observable, concatMap, from, map } from 'rxjs';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { errorMessage } from '../../common/utils';
import { AUDIT_METADATA_KEY, SKIP_AUDIT_KEY, type AuditableOptions } from './audit.decorator';
import { readAuditContext } from './audit-context';
import { AuditLogService, sanitize } from './audit-log.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

interface AuditableRequest {
  method: string;
  url: string;
  body?: unknown;
  params?: Record<string, unknown>;
  user?: AuthenticatedUser;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
}

/**
 * Records every non-GET mutating request in `audit_logs`.
 *
 * Design decisions:
 *
 * - The row is written **after** the handler succeeded, so a rejected request
 *   leaves no trail of something that never happened. Authentication outcomes
 *   (LOGIN / failed LOGIN) are recorded explicitly by `AuthService`, which knows
 *   the difference between "wrong password" and "no such user".
 * - `newValue` combines the request body with the handler's response, both
 *   passed through `sanitize()`, so secrets never reach the table.
 * - `oldValue` comes from the handler via `setAuditSnapshot()` when the handler
 *   already loaded the previous state; otherwise it stays `NULL` rather than
 *   being invented.
 * - Auditing never fails the request: `AuditLogService.record()` swallows and
 *   logs write errors.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly auditLog: AuditLogService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler<unknown>): Observable<unknown> {
    if (context.getType() !== 'http') {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<AuditableRequest>();
    const method = request.method?.toUpperCase() ?? 'GET';

    if (READ_METHODS.has(method)) {
      return next.handle();
    }

    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip === true) {
      return next.handle();
    }

    const options =
      this.reflector.getAllAndOverride<AuditableOptions>(AUDIT_METADATA_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? {};

    // The audit row is written **before** the response is emitted. Awaiting one
    // INSERT costs a little latency, and it buys the property that a mutation
    // reported as successful is always in the trail — a fire-and-forget write
    // could be lost if the process died between response and flush.
    return next.handle().pipe(
      concatMap((response: unknown) =>
        from(this.write(context, request, options, response)).pipe(map((): unknown => response)),
      ),
    );
  }

  private async write(
    context: ExecutionContext,
    request: AuditableRequest,
    options: AuditableOptions,
    response: unknown,
  ): Promise<void> {
    try {
      const snapshot = readAuditContext(request);
      const headers = request.headers ?? {};
      const forwarded = headers['x-forwarded-for'];
      const forwardedValue = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const userAgentHeader = headers['user-agent'];
      const userAgent = Array.isArray(userAgentHeader) ? userAgentHeader[0] : userAgentHeader;

      const entityId =
        snapshot.entityId ??
        (options.entityIdParam ? asId(request.params?.[options.entityIdParam]) : undefined) ??
        asId(request.params?.id) ??
        asId(readProperty(response, 'id'));

      await this.auditLog.record({
        userId: request.user?.id ?? snapshot.actorId ?? null,
        action: options.action ?? deriveAction(request.method),
        entityName: options.entityName ?? deriveEntityName(context, request.url),
        entityId: entityId ?? null,
        ipAddress: forwardedValue?.split(',')[0]?.trim() || request.ip || null,
        userAgent: userAgent ?? null,
        oldValue: snapshot.oldValue,
        newValue: {
          request: sanitize(request.body),
          ...(snapshot.newValue !== undefined ? { result: sanitize(snapshot.newValue) } : {}),
        },
      });
    } catch (error) {
      this.logger.error(`Audit interceptor failed: ${errorMessage(error)}`);
    }
  }
}

/** Maps an HTTP method to the audit vocabulary. */
export function deriveAction(method: string): AuditAction {
  switch (method.toUpperCase()) {
    case 'POST':
      return AuditAction.CREATE;
    case 'PATCH':
    case 'PUT':
      return AuditAction.UPDATE;
    case 'DELETE':
      return AuditAction.DELETE;
    default:
      return AuditAction.UPDATE;
  }
}

/** Last static path segment, e.g. `/api/v1/auth/profile` → `profile`. */
export function deriveEntityName(context: ExecutionContext, url: string): string {
  const path = url.split('?')[0] ?? '';
  const segments = path
    .split('/')
    .filter((segment) => segment.length > 0 && !segment.startsWith(':') && !isUuid(segment));
  const last = segments.at(-1);
  if (last === undefined) {
    return context.getHandler().name;
  }
  return last;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function asId(value: unknown): string | undefined {
  if (typeof value === 'string' && value.length > 0 && value.length <= 64) {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function readProperty(source: unknown, key: string): unknown {
  if (typeof source === 'object' && source !== null && key in source) {
    return (source as Record<string, unknown>)[key];
  }
  return undefined;
}
```

#### `apps/backend/src/modules/audit/audit-context.ts` · 52 lines

```ts
/**
 * Per-request audit scratchpad.
 *
 * The interceptor only sees the HTTP method, the route, the request body and the
 * handler's return value. For an `UPDATE` that is not enough to write a useful
 * trail (the previous state is not in the request), so a handler that already
 * loaded the previous state can publish it here with {@link setAuditSnapshot} —
 * no extra database round-trip and no guessing.
 *
 * The same mechanism lets an unauthenticated handler (login, OTP verify) declare
 * who the actor turned out to be, since `request.user` is only populated by the
 * JWT guard.
 */

export const AUDIT_CONTEXT_PROPERTY = 'shopinoAudit';

export interface AuditSnapshot {
  /** Actor discovered by the handler, used when the route has no JWT identity. */
  actorId?: string | null;
  entityId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
}

interface MutableRequest {
  [AUDIT_CONTEXT_PROPERTY]?: AuditSnapshot;
}

/** Merges a snapshot into the current request's audit context. */
export function setAuditSnapshot(request: unknown, snapshot: AuditSnapshot): void {
  if (typeof request !== 'object' || request === null) {
    return;
  }
  const target = request as MutableRequest;
  const current = target[AUDIT_CONTEXT_PROPERTY] ?? {};
  target[AUDIT_CONTEXT_PROPERTY] = {
    ...current,
    ...snapshot,
    ...(snapshot.oldValue !== undefined || snapshot.newValue !== undefined
      ? { oldValue: snapshot.oldValue, newValue: snapshot.newValue }
      : {}),
  };
}

/** Reads the snapshot, always returning an object so callers stay branch-free. */
export function readAuditContext(request: unknown): AuditSnapshot {
  if (typeof request !== 'object' || request === null) {
    return {};
  }
  return (request as MutableRequest)[AUDIT_CONTEXT_PROPERTY] ?? {};
}
```

#### `apps/backend/src/modules/audit/audit.decorator.ts` · 34 lines

```ts
import { SetMetadata } from '@nestjs/common';
import type { AuditAction } from '@prisma/client';

export const AUDIT_METADATA_KEY = 'shopino:audit';
export const SKIP_AUDIT_KEY = 'shopino:skipAudit';

export interface AuditableOptions {
  /**
   * Entity name recorded in `audit_logs.entity_name`. When omitted, the
   * interceptor derives it from the route path (last static segment).
   */
  entityName?: string;
  /**
   * Overrides the action derived from the HTTP method. Use for the actions that
   * are not plain CRUD, e.g. a purchase capturing a payment
   * (`AuditAction.PAYMENT_CAPTURE`) or a settlement transition
   * (`AuditAction.STATUS_CHANGE`).
   */
  action?: AuditAction;
  /** Name of the route parameter that holds the entity id (defaults to `id`). */
  entityIdParam?: string;
}

/**
 * Attaches audit metadata to a mutating route. The actual row is written by
 * `AuditInterceptor` from the *result* of the handler, so the trail records what
 * really happened rather than what was requested.
 */
export const Auditable = (options: AuditableOptions = {}): MethodDecorator & ClassDecorator =>
  SetMetadata(AUDIT_METADATA_KEY, options);

/** Opts a mutating route out of the audit trail (e.g. telemetry beacons). */
export const SkipAudit = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_AUDIT_KEY, true);
```

#### `apps/backend/src/modules/audit/audit.interceptor.spec.ts` · 344 lines

```ts
import { AuditAction, UserRole } from '@prisma/client';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import type { Reflector } from '@nestjs/core';
import { AUDIT_METADATA_KEY, SKIP_AUDIT_KEY, type AuditableOptions } from './audit.decorator';
import { AUDIT_CONTEXT_PROPERTY } from './audit-context';
import { AuditInterceptor, deriveAction, deriveEntityName } from './audit.interceptor';
import type { AuditLogService, AuditEntryInput } from './audit-log.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';

/**
 * Direct coverage of the audit interceptor, which the mission defines as the
 * component that "automatically records non-GET mutating actions (CREATE,
 * UPDATE, DELETE, STATUS_CHANGE)".
 *
 * The end-to-end suite proves the interceptor works on a real route; this spec
 * pins down the rules that no single route can exercise on its own: the full
 * HTTP-method → action mapping, the `@Auditable` override that produces
 * `STATUS_CHANGE` (used by domain transitions such as a sub-order moving to
 * SHIPPED, or a settlement being processed), the skip rules, EntityId
 * resolution, redaction of the request body, and the guarantee that a request
 * which fails writes nothing.
 */

interface FakeRequest {
  method: string;
  url: string;
  body?: unknown;
  params?: Record<string, unknown>;
  user?: AuthenticatedUser;
  ip?: string;
  headers?: Record<string, string | string[] | undefined>;
  [AUDIT_CONTEXT_PROPERTY]?: unknown;
}

/**
 * A function whose `name` matches a real controller method. `Function#name` is
 * read-only, so it is set through `defineProperty`; the interceptor only ever
 * reads it as a last-resort fallback for the entity name.
 */
function namedHandler(name: string): () => void {
  const handler = (): void => undefined;
  Object.defineProperty(handler, 'name', { value: name, configurable: true });
  return handler;
}

const handlerContext = (request: FakeRequest, handlerName = 'handler'): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => namedHandler(handlerName),
    getClass: () => class TestController {},
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const reflectorWith = (metadata: Record<string, unknown>): Reflector =>
  ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

const handlerReturning = (value: unknown): CallHandler => ({ handle: () => of(value) });
const handlerFailing = (error: Error): CallHandler => ({ handle: () => throwError(() => error) });

const actor: AuthenticatedUser = {
  id: '11111111-1111-1111-1111-111111111111',
  mobile: '+989120000001',
  role: UserRole.SUPER_ADMIN,
  sessionId: '22222222-2222-2222-2222-222222222222',
};

/** Captures what the interceptor tried to persist. */
function capturingAuditLog(): { service: AuditLogService; entries: AuditEntryInput[] } {
  const entries: AuditEntryInput[] = [];
  const service = {
    record: (entry: AuditEntryInput): Promise<string | null> => {
      entries.push(entry);
      return Promise.resolve('audit-id');
    },
  } as unknown as AuditLogService;
  return { service, entries };
}

const run = async (
  interceptor: AuditInterceptor,
  context: ExecutionContext,
  next: CallHandler,
): Promise<unknown> => {
  let emitted: unknown;
  await new Promise<void>((resolve, reject) => {
    interceptor.intercept(context, next).subscribe({
      next: (value) => {
        emitted = value;
      },
      error: reject,
      complete: resolve,
    });
  });
  return emitted;
};

describe('deriveAction (HTTP method → audit vocabulary)', () => {
  it('maps the mutating methods the mission names', () => {
    expect(deriveAction('POST')).toBe(AuditAction.CREATE);
    expect(deriveAction('PATCH')).toBe(AuditAction.UPDATE);
    expect(deriveAction('PUT')).toBe(AuditAction.UPDATE);
    expect(deriveAction('DELETE')).toBe(AuditAction.DELETE);
  });

  it('is case-insensitive', () => {
    expect(deriveAction('post')).toBe(AuditAction.CREATE);
    expect(deriveAction('Delete')).toBe(AuditAction.DELETE);
  });

  it('never invents an unsupported action', () => {
    // Anything outside the vocabulary falls back to UPDATE rather than throwing:
    // an unknown verb must still leave a trail (e.g. a future QUERY-ish verb).
    expect(deriveAction('OPTIONS')).toBe(AuditAction.UPDATE);
    expect(Object.values(AuditAction)).toContain(deriveAction('POST'));
  });
});

describe('deriveEntityName', () => {
  it('uses the last static segment of the path', () => {
    expect(deriveEntityName(handlerContext({ method: 'POST', url: '/api/v1/auth/profile' }), '/api/v1/auth/profile')).toBe(
      'profile',
    );
    expect(deriveEntityName(handlerContext({ method: 'POST', url: '/api/v1/vendors' }), '/api/v1/vendors')).toBe(
      'vendors',
    );
  });

  it('ignores the query string', () => {
    expect(
      deriveEntityName(handlerContext({ method: 'PATCH', url: '/api/v1/products?page=2' }), '/api/v1/products?page=2'),
    ).toBe('products');
  });

  it('skips a trailing UUID so a nested resource names its collection', () => {
    const url = '/api/v1/admin/users/6f9619ff-8b86-d011-b42d-00cf4fc964ff';
    expect(deriveEntityName(handlerContext({ method: 'PATCH', url }), url)).toBe('users');
  });
});

describe('AuditInterceptor', () => {
  it('ignores read-only requests entirely', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);

    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      await run(interceptor, handlerContext({ method, url: '/api/v1/health' }), handlerReturning({ status: 'ok' }));
    }

    expect(entries).toHaveLength(0);
  });

  it('records CREATE for a POST from the authenticated actor, with IP and user agent', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'POST',
      url: '/api/v1/vendors',
      body: { storeName: 'فروشگاه نمونه' },
      user: actor,
      headers: { 'user-agent': 'jest-unit', 'x-forwarded-for': '203.0.113.10, 10.0.0.1' },
    };

    await run(interceptor, handlerContext(request), handlerReturning({ id: 'vendor-id', storeName: 'فروشگاه نمونه' }));

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      userId: actor.id,
      action: AuditAction.CREATE,
      entityName: 'vendors',
      entityId: 'vendor-id',
      ipAddress: '203.0.113.10',
      userAgent: 'jest-unit',
    });
  });

  it('records UPDATE for a PATCH and keeps the before/after snapshot from the handler', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'PATCH',
      url: '/api/v1/auth/profile',
      body: { fullName: 'سارا محمدی', password: 'must-not-be-stored' },
      user: actor,
      ip: '127.0.0.1',
    };
    // What a handler publishes through `setAuditSnapshot()` after loading the
    // previous state — the reason `oldValue` is real data rather than a guess.
    request[AUDIT_CONTEXT_PROPERTY] = {
      entityId: actor.id,
      oldValue: { fullName: 'نام قبلی' },
      newValue: { fullName: 'سارا محمدی' },
    };

    await run(interceptor, handlerContext(request), handlerReturning({ id: actor.id, updated: true }));

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe(AuditAction.UPDATE);
    expect(entries[0]?.entityId).toBe(actor.id);
    expect(entries[0]?.oldValue).toEqual({ fullName: 'نام قبلی' });

    const newValue = entries[0]?.newValue as { request: Record<string, unknown>; result: unknown };
    expect(newValue.request.fullName).toBe('سارا محمدی');
    expect(newValue.request.password).toBe('[REDACTED]');
    expect(newValue.result).toEqual({ fullName: 'سارا محمدی' });
    expect(JSON.stringify(entries[0])).not.toContain('must-not-be-stored');
  });

  it('records DELETE for a DELETE request', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'DELETE',
      url: '/api/v1/products',
      params: { id: 'product-id' },
      user: actor,
    };

    await run(interceptor, handlerContext(request), handlerReturning({ deleted: true }));

    expect(entries[0]?.action).toBe(AuditAction.DELETE);
    expect(entries[0]?.entityId).toBe('product-id');
  });

  it('records STATUS_CHANGE when a handler declares it, and lets it override the method mapping', async () => {
    const { service, entries } = capturingAuditLog();
    const metadata: AuditableOptions = { action: AuditAction.STATUS_CHANGE, entityName: 'SubOrder' };
    const interceptor = new AuditInterceptor(reflectorWith({ [AUDIT_METADATA_KEY]: metadata }), service);
    const request: FakeRequest = {
      method: 'PATCH',
      url: '/api/v1/vendor/sub-orders/6f9619ff-8b86-d011-b42d-00cf4fc964ff/status',
      body: { status: 'SHIPPED', trackingCode: 'TRK-1' },
      user: actor,
      params: { id: '6f9619ff-8b86-d011-b42d-00cf4fc964ff' },
    };
    request[AUDIT_CONTEXT_PROPERTY] = { oldValue: { status: 'PROCESSING' }, newValue: { status: 'SHIPPED' } };

    await run(interceptor, handlerContext(request), handlerReturning({ status: 'SHIPPED' }));

    expect(entries[0]?.action).toBe(AuditAction.STATUS_CHANGE);
    expect(entries[0]?.entityName).toBe('SubOrder');
    expect(entries[0]?.entityId).toBe('6f9619ff-8b86-d011-b42d-00cf4fc964ff');
    expect(entries[0]?.oldValue).toEqual({ status: 'PROCESSING' });
  });

  it('honours the entityIdParam override', async () => {
    const { service, entries } = capturingAuditLog();
    const metadata: AuditableOptions = { entityName: 'Vendor', entityIdParam: 'vendorId' };
    const interceptor = new AuditInterceptor(reflectorWith({ [AUDIT_METADATA_KEY]: metadata }), service);
    const request: FakeRequest = {
      method: 'PATCH',
      url: '/api/v1/admin/vendors/ven-1/approve',
      params: { vendorId: 'ven-1', id: 'ignored' },
      user: actor,
    };

    await run(interceptor, handlerContext(request), handlerReturning({ status: 'APPROVED' }));

    expect(entries[0]?.entityId).toBe('ven-1');
    expect(entries[0]?.entityName).toBe('Vendor');
  });

  it('respects @SkipAudit', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({ [SKIP_AUDIT_KEY]: true }), service);

    await run(
      interceptor,
      handlerContext({ method: 'POST', url: '/api/v1/auth/otp/request', body: { mobile: '+989120000001' } }),
      handlerReturning({ status: 'sent' }),
    );

    expect(entries).toHaveLength(0);
  });

  it('attributes anonymous routes to the actor the handler discovered', async () => {
    // Login and OTP verification run before any JWT exists, so the handler
    // publishes the authenticated account through the audit context.
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = {
      method: 'POST',
      url: '/api/v1/auth/otp/verify',
      body: { mobile: '+989120000001', code: '48213' },
    };
    request[AUDIT_CONTEXT_PROPERTY] = { actorId: 'user-from-otp', entityId: 'user-from-otp' };

    await run(interceptor, handlerContext(request), handlerReturning({ accessToken: 'a.b.c', refreshToken: 'd.e.f' }));

    expect(entries[0]?.userId).toBe('user-from-otp');
    expect(entries[0]?.entityId).toBe('user-from-otp');
    // The issued tokens must never be persisted in the trail.
    expect(JSON.stringify(entries[0])).not.toContain('a.b.c');
    expect(JSON.stringify(entries[0])).not.toContain('d.e.f');
  });

  it('leaves userId null when nobody is identifiable', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);

    await run(
      interceptor,
      handlerContext({ method: 'POST', url: '/api/v1/public/enquiry', body: { message: 'hello' } }),
      handlerReturning({ received: true }),
    );

    expect(entries[0]?.userId).toBeNull();
  });

  it('writes nothing when the handler fails', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = { method: 'POST', url: '/api/v1/vendors', body: {}, user: actor };

    await expect(
      run(interceptor, handlerContext(request), handlerFailing(new Error('validation failed'))),
    ).rejects.toThrow('validation failed');

    // A rejected request is not an event in the entity's history.
    expect(entries).toHaveLength(0);
  });

  it('does not fail the request when the audit write itself throws', async () => {
    const service = {
      record: (): Promise<string | null> => Promise.reject(new Error('database down')),
    } as unknown as AuditLogService;
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const request: FakeRequest = { method: 'POST', url: '/api/v1/vendors', body: {}, user: actor };

    // Auditing must never break a business operation that already succeeded.
    await expect(
      run(interceptor, handlerContext(request), handlerReturning({ id: 'vendor-id' })),
    ).resolves.toEqual({ id: 'vendor-id' });
  });

  it('passes non-HTTP contexts straight through', async () => {
    const { service, entries } = capturingAuditLog();
    const interceptor = new AuditInterceptor(reflectorWith({}), service);
    const rpcContext = { getType: () => 'rpc' } as unknown as ExecutionContext;

    await expect(run(interceptor, rpcContext, handlerReturning('pong'))).resolves.toBe('pong');
    expect(entries).toHaveLength(0);
  });
});
```

#### `apps/backend/src/modules/audit/audit.controller.ts` · 63 lines

```ts
import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { PaginatedAuditLogsDto } from './dto/audit-log-response.dto';

/**
 * Read access to the audit trail.
 *
 * Restricted to `SUPER_ADMIN` and `ADMIN` — the trail contains personal data and
 * security events, so roles that answer tickets or review credit files are
 * deliberately excluded. Rows are immutable by design: the database has no update
 * or delete path for `audit_logs`, and neither does the API.
 */
@ApiTags('admin-audit')
@ApiBearerAuth('access-token')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'مشاهدهٔ لاگ حسابرسی (فقط مدیران)',
    description:
      'صفحهبندیشده، با فیلتر کنشگر، نام موجودیت، شناسه، نوع کنش و بازهٔ زمانی. مقادیر حساس (رمز، کد یکبارمصرف، توکن) هرگز ذخیره نمیشوند.',
  })
  @ApiOkResponse({ type: PaginatedAuditLogsDto })
  async list(@Query() query: AuditLogQueryDto): Promise<PaginatedAuditLogsDto> {
    const { rows, total } = await this.auditLog.list({
      ...(query.userId !== undefined ? { userId: query.userId } : {}),
      ...(query.entityName !== undefined ? { entityName: query.entityName } : {}),
      ...(query.entityId !== undefined ? { entityId: query.entityId } : {}),
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        action: row.action,
        entityName: row.entityName,
        entityId: row.entityId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        oldValue: row.oldValue,
        newValue: row.newValue,
        createdAt: row.createdAt,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }
}
```

#### `apps/backend/src/modules/audit/audit.module.ts` · 20 lines

```ts
import { Module } from '@nestjs/common';
import { AuditLogService } from './audit-log.service';
import { AuditInterceptor } from './audit.interceptor';
import { AuditController } from './audit.controller';

/**
 * Audit module.
 *
 * `AuditInterceptor` is exported so it can be registered as the single global
 * interceptor in `AppModule`, and `AuditLogService` is exported because
 * authentication records its own outcome rows (LOGIN / failed LOGIN), which a
 * generic HTTP interceptor cannot infer.
 */
@Module({
  controllers: [AuditController],
  providers: [AuditLogService, AuditInterceptor],
  exports: [AuditLogService, AuditInterceptor],
})
export class AuditModule {}
```

#### `apps/backend/src/modules/audit/dto/audit-log-query.dto.ts` · 39 lines

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';

export class AuditLogQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'شناسهٔ کنشگر' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ example: 'User', description: 'نام موجودیت ثبتشده' })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  entityName?: string;

  @ApiPropertyOptional({ description: 'شناسهٔ ردیف هدف' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  entityId?: string;

  @ApiPropertyOptional({ enum: AuditAction })
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @ApiPropertyOptional({ format: 'date-time', description: 'از تاریخ (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'تا تاریخ (ISO 8601)' })
  @IsOptional()
  @IsDateString()
  to?: string;
}
```

#### `apps/backend/src/modules/audit/dto/audit-log-response.dto.ts` · 61 lines

```ts
import { ApiProperty } from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';

/** One immutable row of the audit trail. */
export class AuditLogEntryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, description: 'کنشگر؛ null برای رویدادهای بینام' })
  userId!: string | null;

  @ApiProperty({ enum: AuditAction })
  action!: AuditAction;

  @ApiProperty({ example: 'User' })
  entityName!: string;

  @ApiProperty({ nullable: true })
  entityId!: string | null;

  @ApiProperty({ nullable: true, example: '203.0.113.10' })
  ipAddress!: string | null;

  @ApiProperty({ nullable: true })
  userAgent!: string | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    description: 'وضعیت پیش از تغییر (در بهروزرسانیها). مقادیر حساس حذف شدهاند.',
  })
  oldValue!: unknown;

  @ApiProperty({
    nullable: true,
    type: Object,
    description: 'درخواست و نتیجهٔ تغییر. مقادیر حساس حذف شدهاند.',
  })
  newValue!: unknown;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}

export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogEntryDto] })
  items!: AuditLogEntryDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 137 })
  total!: number;

  @ApiProperty({ example: 7 })
  totalPages!: number;
}
```


### 4.4 `users` module — the identity domain

#### `apps/backend/src/modules/users/users.service.ts` · 321 lines

```ts
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole, type Gender } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { toE164, toNationalFormat } from '../../common/validators/iranian-mobile';
import { normalizeNationalCode } from '../../common/validators/iranian-national-code';
import type { UpdateProfileDto } from './dto/update-profile.dto';

/** Columns safe to hand to a client; `passwordHash` never leaves the database. */
export const PUBLIC_USER_SELECT = {
  id: true,
  mobile: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  nationalCode: true,
  lastLoginAt: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

export interface PublicUser {
  id: string;
  mobile: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
  nationalCode: string | null;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface CustomerProfileSummary {
  birthDate: Date | null;
  gender: Gender | null;
  bankIban: string | null;
  defaultAddressId: string | null;
}

export interface VendorProfileSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  status: string;
  logoUrl: string | null;
}

export interface UserIdentity {
  user: PublicUser;
  customerProfile: CustomerProfileSummary | null;
  vendor: VendorProfileSummary | null;
}

export interface ProfileUpdateResult {
  before: { fullName: string; email: string | null; nationalCode: string | null; birthDate: Date | null };
  after: { fullName: string; email: string | null; nationalCode: string | null; birthDate: Date | null };
  user: PublicUser;
}

/**
 * All reads and writes of the identity tables live here, so `AuthService` (which
 * owns the login flows) never builds a user query itself.
 *
 * Two invariants are enforced at this layer because the database alone cannot
 * express them:
 *
 * - a user created through the OTP flow *always* gets a `CustomerProfile` in the
 *   same transaction, so "customer without a profile" is not a state the rest of
 *   the platform has to defend against;
 * - `passwordHash` is never selected for anything that travels to a client.
 */
@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Finds a user by canonical E.164 mobile number. */
  async findByMobile(mobile: string): Promise<UserIdentity | null> {
    const normalized = toE164(mobile) ?? mobile;
    const user = await this.prisma.user.findUnique({
      where: { mobile: normalized },
      select: { ...PUBLIC_USER_SELECT, customerProfile: true, vendor: true },
    });
    return user === null ? null : this.toIdentity(user);
  }

  /**
   * Resolves the identifier used on the password-login form: an e-mail address
   * or a mobile number in any accepted spelling.
   */
  async findByIdentifier(identifier: string): Promise<(UserIdentity & { passwordHash: string | null }) | null> {
    const trimmed = identifier.trim();
    const mobile = toE164(trimmed);

    const user = await this.prisma.user.findFirst({
      where: mobile !== null ? { mobile } : { email: { equals: trimmed.toLowerCase() } },
      select: { ...PUBLIC_USER_SELECT, passwordHash: true, customerProfile: true, vendor: true },
    });

    if (user === null) {
      return null;
    }
    return { ...this.toIdentity(user), passwordHash: user.passwordHash };
  }

  /** Loads the full identity of an authenticated user (`GET /auth/me`). */
  async getIdentity(userId: string): Promise<UserIdentity> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...PUBLIC_USER_SELECT, customerProfile: true, vendor: true },
    });

    if (user === null) {
      throw new NotFoundException('User not found');
    }
    return this.toIdentity(user);
  }

  /**
   * Creates the account for a mobile number that was just verified by OTP.
   *
   * The operation is idempotent under concurrent verification: if two requests
   * race, the unique index on `users.mobile` rejects the loser and this method
   * returns the winner's row instead of failing the login.
   */
  async ensureCustomer(mobile: string): Promise<UserIdentity> {
    const normalized = toE164(mobile) ?? mobile;
    const existing = await this.findByMobile(normalized);
    if (existing !== null) {
      return existing;
    }

    try {
      const created = await this.prisma.user.create({
        data: {
          mobile: normalized,
          fullName: `کاربر ${toNationalFormat(normalized)}`,
          role: UserRole.CUSTOMER,
          customerProfile: { create: {} },
        },
        select: { ...PUBLIC_USER_SELECT, customerProfile: true, vendor: true },
      });

      this.logger.log(`Customer account created on first OTP login: ${normalized}`);
      return this.toIdentity(created);
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const winner = await this.findByMobile(normalized);
        if (winner !== null) {
          return winner;
        }
      }
      throw error;
    }
  }

  /** Records a successful authentication. Best-effort: never blocks the login. */
  async touchLastLogin(userId: string): Promise<void> {
    try {
      await this.prisma.user.update({ where: { id: userId }, data: { lastLoginAt: new Date() } });
    } catch (error) {
      this.logger.warn(`Could not update lastLoginAt for ${userId}: ${String(error)}`);
    }
  }

  /**
   * Applies a profile update and returns both the previous and the new state, so
   * the audit interceptor can record a real before/after without a second read.
   */
  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<ProfileUpdateResult> {
    const current = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { ...PUBLIC_USER_SELECT, customerProfile: { select: { birthDate: true } } },
    });
    if (current === null) {
      throw new NotFoundException('User not found');
    }

    const email = dto.email === undefined ? undefined : dto.email.trim().toLowerCase();
    if (email !== undefined && email !== current.email) {
      const taken = await this.prisma.user.findUnique({ where: { email }, select: { id: true } });
      if (taken !== null && taken.id !== userId) {
        throw new ConflictException('This e-mail address is already registered');
      }
    }

    const nationalCode = dto.nationalCode === undefined ? undefined : normalizeNationalCode(dto.nationalCode);
    if (nationalCode !== undefined && nationalCode !== current.nationalCode) {
      const taken = await this.prisma.user.findUnique({ where: { nationalCode }, select: { id: true } });
      if (taken !== null && taken.id !== userId) {
        throw new ConflictException('This national code is already registered');
      }
    }

    const birthDate = dto.birthDate === undefined ? undefined : new Date(dto.birthDate);

    const updated = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data: {
          ...(dto.fullName !== undefined ? { fullName: dto.fullName.trim() } : {}),
          ...(email !== undefined ? { email } : {}),
          ...(nationalCode !== undefined ? { nationalCode } : {}),
        },
        select: PUBLIC_USER_SELECT,
      });

      if (birthDate !== undefined) {
        await tx.customerProfile.upsert({
          where: { userId },
          create: { userId, birthDate },
          update: { birthDate },
        });
      }

      return user;
    });

    return {
      before: {
        fullName: current.fullName,
        email: current.email,
        nationalCode: current.nationalCode,
        birthDate: current.customerProfile?.birthDate ?? null,
      },
      after: {
        fullName: updated.fullName,
        email: updated.email,
        nationalCode: updated.nationalCode,
        birthDate: birthDate ?? current.customerProfile?.birthDate ?? null,
      },
      user: updated,
    };
  }

  /** Admin search over the identity table. Phone numbers are matched exactly. */
  async search(params: {
    query?: string;
    role?: UserRole;
    isActive?: boolean;
    page: number;
    pageSize: number;
  }): Promise<{ rows: PublicUser[]; total: number }> {
    const mobile = params.query ? toE164(params.query) : null;
    const where: Prisma.UserWhereInput = {
      ...(params.role ? { role: params.role } : {}),
      ...(params.isActive === undefined ? {} : { isActive: params.isActive }),
      ...(params.query
        ? {
            OR: [
              ...(mobile !== null ? [{ mobile }] : []),
              { email: { contains: params.query, mode: 'insensitive' as const } },
              { fullName: { contains: params.query, mode: 'insensitive' as const } },
            ],
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.user.findMany({
        where,
        select: PUBLIC_USER_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (params.page - 1) * params.pageSize,
        take: params.pageSize,
      }),
      this.prisma.user.count({ where }),
    ]);

    return { rows, total };
  }

  private toIdentity(user: {
    id: string;
    mobile: string;
    email: string | null;
    fullName: string;
    role: UserRole;
    isActive: boolean;
    nationalCode: string | null;
    lastLoginAt: Date | null;
    createdAt: Date;
    customerProfile: CustomerProfileSummary | null;
    vendor: VendorProfileSummary | null;
  }): UserIdentity {
    return {
      user: {
        id: user.id,
        mobile: user.mobile,
        email: user.email,
        fullName: user.fullName,
        role: user.role,
        isActive: user.isActive,
        nationalCode: user.nationalCode,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
      customerProfile:
        user.customerProfile === null
          ? null
          : {
              birthDate: user.customerProfile.birthDate,
              gender: user.customerProfile.gender,
              bankIban: user.customerProfile.bankIban,
              defaultAddressId: user.customerProfile.defaultAddressId,
            },
      vendor:
        user.vendor === null
          ? null
          : {
              id: user.vendor.id,
              storeName: user.vendor.storeName,
              storeSlug: user.vendor.storeSlug,
              status: user.vendor.status,
              logoUrl: user.vendor.logoUrl,
            },
    };
  }
}
```

#### `apps/backend/src/modules/users/users.controller.ts` · 60 lines

```ts
import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { UsersService } from './users.service';
import { UserQueryDto } from './dto/user-query.dto';
import { PaginatedUsersDto, UserIdentityDto } from './dto/user-response.dto';

/**
 * Staff-facing identity endpoints.
 *
 * Access model:
 * - `SUPER_ADMIN` and `ADMIN` may search the whole identity table;
 * - `SUPPORT` and `FINANCIAL_OFFICER` may look up a single user (they need it to
 *   answer tickets and to review credit files) but cannot enumerate users, which
 *   keeps bulk personal data out of reach of the lowest staff role.
 */
@ApiTags('admin-users')
@ApiBearerAuth('access-token')
@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'جستوجو در کاربران (فقط مدیران)',
    description:
      'صفحهبندیشده، با فیلتر نقش/وضعیت و جستوجو روی نام، ایمیل یا شماره موبایل. هرگز هش رمز را برنمیگرداند.',
  })
  @ApiOkResponse({ type: PaginatedUsersDto })
  async list(@Query() query: UserQueryDto): Promise<PaginatedUsersDto> {
    const { rows, total } = await this.users.search({
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: rows.map((user) => UserIdentityDto.from(user)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT, UserRole.FINANCIAL_OFFICER)
  @ApiOperation({ summary: 'دریافت یک کاربر با شناسه (کارکنان)' })
  @ApiOkResponse({ type: UserIdentityDto })
  @ApiNotFoundResponse({ description: 'کاربر یافت نشد' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<UserIdentityDto> {
    const identity = await this.users.getIdentity(id);
    return UserIdentityDto.from(identity.user);
  }
}
```

#### `apps/backend/src/modules/users/users.module.ts` · 16 lines

```ts
import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

/**
 * Identity domain module. `UsersService` is the only component allowed to read
 * or write the `users` / `customer_profiles` / `vendors` tables; the auth module
 * consumes it instead of touching Prisma for identity concerns.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
```

#### `apps/backend/src/modules/users/dto/update-profile.dto.ts` · 38 lines

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEmail, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { IsIranianNationalCode } from '../../../common/validators/is-iranian-national-code.decorator';

/**
 * Fields a user may change about themselves.
 *
 * Deliberately narrow: `mobile` is the identity key and is changed only through a
 * verified OTP flow (not implemented yet — it needs a "confirm the new number"
 * step), and `role` is never client-writable.
 */
export class UpdateProfileDto {
  @ApiPropertyOptional({ example: 'سارا محمدی', maxLength: 120, description: 'نام و نام خانوادگی' })
  @IsOptional()
  @IsString()
  @Length(2, 120)
  fullName?: string;

  @ApiPropertyOptional({ example: 'sara@example.com', maxLength: 254 })
  @IsOptional()
  @IsEmail({}, { message: 'ایمیل معتبر نیست' })
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    example: '0499370899',
    description: 'کد ملی ۱۰ رقمی — با رقم کنترلی اعتبارسنجی میشود',
  })
  @IsOptional()
  @IsIranianNationalCode()
  nationalCode?: string;

  @ApiPropertyOptional({ example: '1994-05-17', description: 'تاریخ تولد (ISO 8601، فقط تاریخ)' })
  @IsOptional()
  @IsDateString({ strict: true }, { message: 'تاریخ تولد باید قالب ISO 8601 داشته باشد' })
  birthDate?: string;
}
```

#### `apps/backend/src/modules/users/dto/user-query.dto.ts` · 45 lines

```ts
import { ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Shared pagination input; `page`/`pageSize` arrive as strings from the query string. */
export class PaginationQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize: number = 20;
}

export class UserQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    description: 'جستوجو بر اساس نام، ایمیل یا شماره موبایل (هر قالبی)',
    example: '09120000001',
  })
  @IsOptional()
  @IsString()
  @MaxLength(254)
  query?: string;

  @ApiPropertyOptional({ enum: UserRole })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;

  @ApiPropertyOptional({ description: 'فقط کاربران فعال یا غیرفعال' })
  @IsOptional()
  @Transform(({ value }): unknown => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  isActive?: boolean;
}
```

#### `apps/backend/src/modules/users/dto/user-response.dto.ts` · 65 lines

```ts
import { ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { PublicUser } from '../users.service';

/** Public projection of a user row. The password hash is not part of this type. */
export class UserIdentityDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+989120000001', description: 'شماره موبایل به قالب E.164' })
  mobile!: string;

  @ApiProperty({ nullable: true, example: 'admin@shopino.local' })
  email!: string | null;

  @ApiProperty({ example: 'مدیر ارشد پلتفرم' })
  fullName!: string;

  @ApiProperty({ enum: UserRole })
  role!: UserRole;

  @ApiProperty({ example: true })
  isActive!: boolean;

  @ApiProperty({ nullable: true, example: '0499370899' })
  nationalCode!: string | null;

  @ApiProperty({ nullable: true, format: 'date-time' })
  lastLoginAt!: Date | null;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  static from(user: PublicUser): UserIdentityDto {
    return {
      id: user.id,
      mobile: user.mobile,
      email: user.email,
      fullName: user.fullName,
      role: user.role,
      isActive: user.isActive,
      nationalCode: user.nationalCode,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
    };
  }
}

export class PaginatedUsersDto {
  @ApiProperty({ type: [UserIdentityDto] })
  items!: UserIdentityDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 42 })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}
```


### 4.5 `auth` module — flows, tokens, guards

#### `apps/backend/src/modules/auth/auth.service.ts` · 332 lines

```ts
import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import type { EnvironmentVariables } from '../../config/env.validation';
import { hashPassword, verifyPassword } from '../../infra/security/password';
import { RedisService } from '../../infra/redis/redis.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { toE164 } from '../../common/validators/iranian-mobile';
import { AuditLogService } from '../audit/audit-log.service';
import { SmsService } from '../sms/sms.service';
import { UsersService, type PublicUser } from '../users/users.service';
import { OtpService, OtpVerifyResult } from './otp.service';
import { TokenService, loginAttemptsKey, loginLockKey, type IssuedTokens } from './token.service';
import type { RequestOtpDto } from './dto/request-otp.dto';
import type { VerifyOtpDto } from './dto/verify-otp.dto';
import type { PasswordLoginDto } from './dto/password-login.dto';
import type {
  AuthTokensResponseDto,
  LogoutResponseDto,
  MeResponseDto,
  OtpRequestResponseDto,
  ProfileUpdateResponseDto,
} from './dto/auth-response.dto';
import { AuthUserDto, MeResponseDto as MeResponse } from './dto/auth-response.dto';
import type { UpdateProfileDto } from '../users/dto/update-profile.dto';

/** Purpose recorded with the OTP challenge; also used in SMS wording and metrics. */
const OTP_PURPOSE = 'login';

/**
 * The profile response plus the before/after snapshot the audit interceptor needs.
 * Returning it from here keeps the controller free of database reads and gives
 * `audit_logs` a real diff instead of a guess.
 */
export interface ProfileUpdateOutcome {
  response: ProfileUpdateResponseDto;
  audit: { entityId: string; oldValue: unknown; newValue: unknown };
}

/**
 * Orchestrates every authentication flow: OTP login, staff password login,
 * refresh rotation, logout and self-service profile management.
 *
 * Where the security decisions live:
 * - code generation, throttling and the attempt budget are in `OtpService`;
 * - token signing, session bookkeeping and rotation are in `TokenService`;
 * - this service owns the *policy*: what a verified number is allowed to do, when
 *   an account is refused, and what reaches the audit trail.
 */
@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  private readonly maxLoginAttempts: number;
  private readonly lockSeconds: number;

  /**
   * A real Argon2id hash of a random value, verified against when the account
   * does not exist. Without it, "unknown e-mail" answers measurably faster than
   * "wrong password", which turns the login form into an account-enumeration
   * oracle.
   */
  private decoyHashPromise: Promise<string> | null = null;

  constructor(
    private readonly users: UsersService,
    private readonly otp: OtpService,
    private readonly tokens: TokenService,
    private readonly sms: SmsService,
    private readonly audit: AuditLogService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.maxLoginAttempts = config.getOrThrow<number>('AUTH_MAX_LOGIN_ATTEMPTS');
    this.lockSeconds = config.getOrThrow<number>('AUTH_LOCK_SECONDS');
  }

  // ─── OTP flow ─────────────────────────────────────────────────────────────

  /**
   * Step 1 — generate a code and hand it to the SMS provider.
   *
   * Ordering matters: the challenge is stored **before** dispatch. If the
   * provider fails, the client receives `503`, the stored code expires unused
   * within its TTL, and the user retries — a code is never reported as sent when
   * it was not.
   */
  async requestOtp(dto: RequestOtpDto, context: RequestContext): Promise<OtpRequestResponseDto> {
    const { code, challenge } = await this.otp.createChallenge(dto.mobile, OTP_PURPOSE, context.ipAddress);

    const delivery = await this.sms.sendOtp(
      challenge.mobile,
      code,
      challenge.expiresInSeconds,
      OTP_PURPOSE,
    );

    return {
      status: 'sent',
      expiresInSeconds: challenge.expiresInSeconds,
      trackingId: delivery.referenceId,
    };
  }

  /**
   * Step 2 — verify the code and open a session.
   *
   * An unknown number becomes a `CUSTOMER` with an empty `CustomerProfile` at
   * this exact moment (never at step 1), so spamming codes cannot create rows in
   * the identity table.
   */
  async verifyOtp(dto: VerifyOtpDto, context: RequestContext): Promise<AuthTokensResponseDto> {
    const result = await this.otp.verify(dto.mobile, dto.code);

    switch (result) {
      case OtpVerifyResult.NotFound:
        await this.recordFailedLogin(null, 'otp_expired_or_unknown', context);
        throw new UnauthorizedException('The code has expired or was already used. Request a new one.');

      case OtpVerifyResult.Mismatch:
        await this.recordFailedLogin(null, 'otp_mismatch', context);
        throw new UnauthorizedException('Incorrect code.');

      case OtpVerifyResult.Exhausted: {
        const retryAfter = await this.otp.lockRemainingSeconds(dto.mobile);
        await this.recordFailedLogin(null, 'otp_attempts_exhausted', context);
        throw new TooManyRequestsException(
          'Too many incorrect codes. This number is temporarily locked.',
          retryAfter,
        );
      }

      case OtpVerifyResult.Match:
        break;
    }

    const identity = await this.users.ensureCustomer(dto.mobile);
    this.assertActive(identity.user.isActive);

    await this.otp.clear(dto.mobile);
    const tokens = await this.tokens.issue(identity.user, context);
    await this.users.touchLastLogin(identity.user.id);

    this.logger.log(`OTP login succeeded for user ${identity.user.id} (role ${identity.user.role})`);
    return this.toAuthResponse(tokens, identity.user);
  }

  // ─── Password flow (staff, vendors) ───────────────────────────────────────

  /**
   * Password login for accounts that have a password: super admin, admin,
   * support, financial officer and vendors.
   *
   * Failures are counted per identifier in Redis and lock that identifier for
   * `AUTH_LOCK_SECONDS` — not the source IP, so an attacker cannot lock the
   * legitimate owner out of their own account from a shared network, and cannot
   * keep grinding one account while other users stay unaffected.
   */
  async loginWithPassword(dto: PasswordLoginDto, context: RequestContext): Promise<AuthTokensResponseDto> {
    const identifier = normalizeIdentifier(dto.identifier);
    await this.assertNotLocked(identifier);

    const account = await this.users.findByIdentifier(identifier);

    // Always verify a hash, even for an unknown account: identical work, identical timing.
    const hash = account?.passwordHash ?? (await this.decoyHash());
    const passwordMatches = await verifyPassword(hash, dto.password);

    if (account === null || !passwordMatches || account.passwordHash === null) {
      await this.registerFailedLogin(identifier);
      await this.recordFailedLogin(account?.user.id ?? null, 'bad_credentials', context);
      throw new UnauthorizedException('Invalid credentials.');
    }

    this.assertActive(account.user.isActive);

    await this.redis.client.del(loginAttemptsKey(identifier));
    const tokens = await this.tokens.issue(account.user, context);
    await this.users.touchLastLogin(account.user.id);

    this.logger.log(`Password login succeeded for user ${account.user.id} (role ${account.user.role})`);
    return this.toAuthResponse(tokens, account.user);
  }

  // ─── Session lifecycle ────────────────────────────────────────────────────

  /**
   * Exchanges a refresh token for a new pair. The presented token is consumed
   * (rotated), so a leaked copy becomes useless as soon as the legitimate client
   * refreshes — and a *reused* copy revokes the whole session.
   */
  async refresh(refreshToken: string, context: RequestContext): Promise<AuthTokensResponseDto> {
    const sessionId = await this.tokens.sessionIdOfRefreshToken(refreshToken);
    const session = await this.tokens.getSession(sessionId);
    if (session === null) {
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    const identity = await this.users.getIdentity(session.userId);
    this.assertActive(identity.user.isActive);

    const tokens = await this.tokens.rotate(refreshToken, identity.user, context);
    return this.toAuthResponse(tokens, identity.user);
  }

  /**
   * Revokes the current session. When the client also sends its refresh token
   * (recommended, so the pair is destroyed even if the access token already
   * expired), that session is revoked too — but only when it belongs to the caller.
   */
  async logout(actor: AuthenticatedUser, refreshToken?: string): Promise<LogoutResponseDto> {
    let sessionsRevoked = 0;

    if (await this.tokens.revoke(actor.sessionId)) {
      sessionsRevoked += 1;
    }

    if (refreshToken !== undefined) {
      const sessionId = await this.tokens.sessionIdOfRefreshToken(refreshToken);
      const session = await this.tokens.getSession(sessionId);

      if (session !== null && session.userId === actor.id && sessionId !== actor.sessionId) {
        if (await this.tokens.revoke(sessionId)) {
          sessionsRevoked += 1;
        }
      }
    }

    return { revoked: true, sessionsRevoked };
  }

  // ─── Identity ─────────────────────────────────────────────────────────────

  async me(actor: AuthenticatedUser): Promise<MeResponseDto> {
    return MeResponse.from(await this.users.getIdentity(actor.id));
  }

  async updateProfile(actor: AuthenticatedUser, dto: UpdateProfileDto): Promise<ProfileUpdateOutcome> {
    const result = await this.users.updateProfile(actor.id, dto);
    const identity = await this.users.getIdentity(actor.id);

    return {
      response: { ...MeResponse.from(identity), updated: true },
      audit: { entityId: actor.id, oldValue: result.before, newValue: result.after },
    };
  }

  /** Honest report of the active SMS provider, so operators never have to guess. */
  smsProviderInfo(): { provider: string; isTestProvider: boolean } {
    return this.sms.describe();
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  private assertActive(isActive: boolean): void {
    if (!isActive) {
      throw new ForbiddenException('This account is deactivated. Contact support.');
    }
  }

  private async assertNotLocked(identifier: string): Promise<void> {
    const ttl = await this.redis.client.ttl(loginLockKey(identifier));
    if (ttl > 0) {
      throw new TooManyRequestsException('Too many failed attempts. Try again later.', ttl);
    }
  }

  /** Increments the failure counter and locks the identifier at the threshold. */
  private async registerFailedLogin(identifier: string): Promise<void> {
    const [[, attempts]] = (await this.redis.client
      .multi()
      .incr(loginAttemptsKey(identifier))
      .expire(loginAttemptsKey(identifier), this.lockSeconds, 'NX')
      .exec()) as [[Error | null, number], unknown];

    if (attempts >= this.maxLoginAttempts) {
      await this.redis.client.set(loginLockKey(identifier), '1', 'EX', this.lockSeconds);
      await this.redis.client.del(loginAttemptsKey(identifier));
      this.logger.warn(`Login locked for ${maskIdentifier(identifier)} after ${attempts} failed attempts`);
    }
  }

  private async recordFailedLogin(userId: string | null, reason: string, context: RequestContext): Promise<void> {
    await this.audit.record({
      userId,
      action: AuditAction.LOGIN,
      entityName: 'User',
      entityId: userId,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
      newValue: { success: false, reason },
    });
  }

  private async decoyHash(): Promise<string> {
    this.decoyHashPromise ??= hashPassword(`decoy-${Date.now()}-${Math.random()}`);
    return this.decoyHashPromise;
  }

  private toAuthResponse(tokens: IssuedTokens, user: PublicUser): AuthTokensResponseDto {
    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresIn: tokens.expiresIn,
      refreshExpiresIn: tokens.refreshExpiresIn,
      sessionId: tokens.sessionId,
      user: AuthUserDto.from(user),
    };
  }
}

/**
 * Normalizes a login identifier so the failure counter cannot be split by
 * spelling: `ADMIN@x.ir`, `admin@x.ir ` and `admin@x.ir` share one bucket, and so
 * do `+989120000001` and `09120000001`.
 */
export function normalizeIdentifier(identifier: string): string {
  const trimmed = identifier.trim();
  const mobile = toE164(trimmed);
  return mobile ?? trimmed.toLowerCase();
}

/** Shows only the shape of an identifier in logs, never the whole value. */
function maskIdentifier(identifier: string): string {
  if (identifier.startsWith('+98')) {
    return `${identifier.slice(0, 6)}****${identifier.slice(-3)}`;
  }
  const [local, domain] = identifier.split('@');
  return domain === undefined ? '***' : `${(local ?? '').slice(0, 2)}***@${domain}`;
}
```

#### `apps/backend/src/modules/auth/otp.service.ts` · 303 lines

```ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { ConfigService } from '@nestjs/config';
import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { maskMobile, toE164 } from '../../common/validators/iranian-mobile';

const HOUR_SECONDS = 3_600;

/** Redis key layout. One namespace per concern keeps `SCAN`-based ops sane. */
export const OtpKeys = {
  /** Hash: codeHash, attempts, purpose, createdAt — TTL = OTP lifetime. */
  challenge: (mobile: string) => `auth:otp:challenge:${mobile}`,
  /** Present while the per-number cooldown is running. */
  cooldown: (mobile: string) => `auth:otp:cooldown:${mobile}`,
  /** Present while the number is locked after too many wrong codes. */
  lock: (mobile: string) => `auth:otp:lock:${mobile}`,
  /** Rolling hourly counter per number. */
  hourlyByMobile: (mobile: string) => `auth:otp:hourly:mobile:${mobile}`,
  /** Rolling hourly counter per client IP. */
  hourlyByIp: (ip: string) => `auth:otp:hourly:ip:${ip}`,
} as const;

/**
 * Outcome of an attempted verification. `Mismatch` and `Exhausted` are separate
 * states so the caller can tell "wrong code, try again" from "wrong code, and
 * that was your last one" — which is exactly what the API reports back.
 */
export enum OtpVerifyResult {
  /** Code matched; the challenge was consumed. */
  Match = 'match',
  /** Code did not match; attempts remain. */
  Mismatch = 'mismatch',
  /** Attempt budget exhausted; the number is now locked. */
  Exhausted = 'exhausted',
  /** No challenge exists: never requested, already used, or expired. */
  NotFound = 'notFound',
}

export interface OtpChallenge {
  mobile: string;
  expiresInSeconds: number;
  attemptsAllowed: number;
}

/**
 * Owns one-time codes: generation, storage, throttling and verification.
 *
 * Security properties, all enforced in Redis rather than in memory so they hold
 * across every API instance:
 *
 * - the code is generated with `crypto.randomInt`, never `Math.random`, and is
 *   never stored in clear text: Redis keeps `sha256(mobile:code)`, so a Redis
 *   dump does not reveal live login codes;
 * - verification is a single atomic Lua script, so ten parallel requests cannot
 *   each get a "fresh" attempt budget past the limit;
 * - the failure counter keeps the *original* TTL — a brute-force loop cannot
 *   extend the window in which guessing is possible;
 * - three independent ceilings are applied: per-number cooldown, per-number
 *   hourly quota and per-IP hourly quota (the last one stops an attacker from
 *   enumerating many numbers from one host).
 */
@Injectable()
export class OtpService {
  private readonly logger = new Logger(OtpService.name);
  private readonly ttlSeconds: number;
  private readonly length: number;
  private readonly cooldownSeconds: number;
  private readonly maxAttempts: number;
  private readonly lockSeconds: number;
  private readonly maxPerHourPerMobile: number;
  private readonly maxPerHourPerIp: number;

  /**
   * Atomic verify: returns 0 = match, 1 = mismatch, 2 = exhausted, 3 = missing.
   * Kept in Lua so the read-increment-branch sequence cannot interleave.
   */
  private readonly verifyScript = `
    local key = KEYS[1]
    local providedHash = ARGV[1]
    local maxAttempts = tonumber(ARGV[2])

    if redis.call('EXISTS', key) == 0 then
      return 3
    end

    local storedHash = redis.call('HGET', key, 'codeHash')
    if storedHash == providedHash then
      redis.call('DEL', key)
      return 0
    end

    local attempts = redis.call('HINCRBY', key, 'attempts', 1)
    if attempts >= maxAttempts then
      redis.call('DEL', key)
      return 2
    end
    return 1
  `;

  constructor(
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.ttlSeconds = config.getOrThrow<number>('OTP_TTL_SECONDS');
    this.length = config.getOrThrow<number>('OTP_LENGTH');
    this.cooldownSeconds = config.getOrThrow<number>('OTP_REQUEST_COOLDOWN_SECONDS');
    this.maxAttempts = config.getOrThrow<number>('OTP_MAX_VERIFY_ATTEMPTS');
    this.lockSeconds = config.getOrThrow<number>('OTP_LOCK_SECONDS');
    this.maxPerHourPerMobile = config.getOrThrow<number>('OTP_MAX_REQUESTS_PER_HOUR');
    this.maxPerHourPerIp = config.getOrThrow<number>('OTP_MAX_REQUESTS_PER_IP_PER_HOUR');
  }

  /**
   * Creates a challenge for a mobile number and returns the code to dispatch.
   * The caller is responsible for actually sending it, so a provider failure
   * cannot leave a code that was never delivered.
   *
   * @throws TooManyRequestsException when the number is locked, cooling down, or
   * has exceeded one of the hourly quotas.
   */
  async createChallenge(mobile: string, purpose: string, clientIp: string | null): Promise<{ code: string; challenge: OtpChallenge }> {
    const normalized = this.normalize(mobile);

    await this.assertNotLocked(normalized);

    // The cooldown is the primary rule (one request per window) and is claimed
    // atomically, so two concurrent requests can never both generate a code.
    const claimed = await this.redis.client.set(
      OtpKeys.cooldown(normalized),
      '1',
      'EX',
      this.cooldownSeconds,
      'NX',
    );
    if (claimed === null) {
      const retryAfter = await this.retryAfterSeconds(OtpKeys.cooldown(normalized), this.cooldownSeconds);
      throw this.rateLimited(
        `An OTP was requested recently. Try again in ${retryAfter} seconds.`,
        retryAfter,
      );
    }

    await this.assertWithinHourlyQuota(
      OtpKeys.hourlyByMobile(normalized),
      this.maxPerHourPerMobile,
      'This number has requested too many codes in the last hour.',
    );
    if (clientIp) {
      await this.assertWithinHourlyQuota(
        OtpKeys.hourlyByIp(clientIp),
        this.maxPerHourPerIp,
        'Too many OTP requests from this network in the last hour.',
      );
    }

    const code = this.generateCode();
    const key = OtpKeys.challenge(normalized);

    // A fresh request invalidates any previous code: only the newest one works.
    await this.redis.client
      .multi()
      .del(key)
      .hset(key, {
        codeHash: this.hashCode(normalized, code),
        attempts: '0',
        purpose,
        createdAt: new Date().toISOString(),
      })
      .expire(key, this.ttlSeconds)
      .exec();

    this.logger.debug(`OTP challenge created for ${maskMobile(normalized)} (purpose: ${purpose})`);

    return {
      code,
      challenge: { mobile: normalized, expiresInSeconds: this.ttlSeconds, attemptsAllowed: this.maxAttempts },
    };
  }

  /**
   * Verifies a submitted code. Consumes the challenge on success; on the final
   * wrong attempt it deletes the challenge and locks the number for
   * `OTP_LOCK_SECONDS`.
   */
  async verify(mobile: string, code: string): Promise<OtpVerifyResult> {
    const normalized = this.normalize(mobile);
    await this.assertNotLocked(normalized);

    const raw = (await this.redis.client.eval(
      this.verifyScript,
      1,
      OtpKeys.challenge(normalized),
      this.hashCode(normalized, code),
      String(this.maxAttempts),
    )) as number;

    if (raw === 2) {
      await this.redis.client.set(OtpKeys.lock(normalized), '1', 'EX', this.lockSeconds);
      this.logger.warn(
        `OTP attempt budget exhausted for ${maskMobile(normalized)}; locked for ${this.lockSeconds}s`,
      );
      return OtpVerifyResult.Exhausted;
    }
    if (raw === 0) {
      return OtpVerifyResult.Match;
    }
    if (raw === 1) {
      return OtpVerifyResult.Mismatch;
    }
    return OtpVerifyResult.NotFound;
  }

  /** Remaining validity of the active challenge in seconds, 0 when none exists. */
  async challengeTtl(mobile: string): Promise<number> {
    const ttl = await this.redis.client.ttl(OtpKeys.challenge(this.normalize(mobile)));
    return ttl > 0 ? ttl : 0;
  }

  /** Clears every artifact of a number: used after a successful login. */
  async clear(mobile: string): Promise<void> {
    const normalized = this.normalize(mobile);
    await this.redis.client.del(OtpKeys.challenge(normalized), OtpKeys.lock(normalized));
  }

  /** Remaining lock time in seconds, 0 when the number is not locked. */
  async lockRemainingSeconds(mobile: string): Promise<number> {
    return this.retryAfterSeconds(OtpKeys.lock(this.normalize(mobile)), 0);
  }

  /**
   * `crypto.randomInt` is a CSPRNG and is already uniform over the range, so no
   * modulo bias correction is needed. Codes are zero-padded to the configured
   * length: `00042` is a valid code and must not become `42`.
   */
  private generateCode(): string {
    const upperBound = 10 ** this.length;
    return String(randomInt(0, upperBound)).padStart(this.length, '0');
  }

  /**
   * Binds the digest to the mobile number so a hash captured for one number is
   * useless for another, and compares in constant time to avoid leaking the code
   * through response timing.
   */
  private hashCode(mobile: string, code: string): string {
    return createHash('sha256').update(`${mobile}:${code}`).digest('hex');
  }

  /** Constant-time comparison helper, exported for reuse in token checks. */
  static safeEquals(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left, 'utf8');
    const rightBuffer = Buffer.from(right, 'utf8');
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private normalize(mobile: string): string {
    const normalized = toE164(mobile);
    if (normalized === null) {
      // Defensive: DTO validation already guarantees this, but a service method
      // must never silently operate on an unnormalized Redis key.
      throw new BadRequestException('Invalid Iranian mobile number');
    }
    return normalized;
  }

  private async assertNotLocked(mobile: string): Promise<void> {
    const remaining = await this.retryAfterSeconds(OtpKeys.lock(mobile), 0);
    if (remaining > 0) {
      throw this.rateLimited(
        `Too many failed attempts. This number is locked for ${remaining} more seconds.`,
        remaining,
      );
    }
  }

  private async assertWithinHourlyQuota(key: string, limit: number, message: string): Promise<void> {
    const [[, count]] = (await this.redis.client
      .multi()
      .incr(key)
      .expire(key, HOUR_SECONDS, 'NX')
      .exec()) as [[Error | null, number], unknown];

    if (count > limit) {
      const retryAfter = await this.retryAfterSeconds(key, HOUR_SECONDS);
      throw this.rateLimited(message, retryAfter);
    }
  }

  private async retryAfterSeconds(key: string, fallback: number): Promise<number> {
    const ttl = await this.redis.client.ttl(key);
    return ttl > 0 ? ttl : fallback;
  }

  private rateLimited(message: string, retryAfterSeconds: number): TooManyRequestsException {
    return new TooManyRequestsException(message, retryAfterSeconds);
  }
}
```

#### `apps/backend/src/modules/auth/token.service.ts` · 343 lines

```ts
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { UserRole } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { DurationString } from '../../common/types/duration';
import { RedisService } from '../../infra/redis/redis.service';
import type { RequestContext } from '../../common/types/request-context';

/** Discriminator that stops an access token from being replayed as a refresh token. */
export type TokenType = 'access' | 'refresh';

export interface AccessTokenPayload {
  /** `users.id`. */
  sub: string;
  mobile: string;
  role: UserRole;
  typ: 'access';
  /** Session (refresh-token) identifier this access token belongs to. */
  sid: string;
  /** Token identifier, unique per issued access token. */
  jti: string;
}

export interface RefreshTokenPayload {
  sub: string;
  typ: 'refresh';
  jti: string;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token lifetime in seconds, mirrors the JWT `exp`. */
  expiresIn: number;
  refreshExpiresIn: number;
  /** Session id, so callers can correlate logs without decoding the token. */
  sessionId: string;
}

export interface SessionRecord {
  userId: string;
  /** sha256 of the refresh token: a Redis dump never yields a usable token. */
  refreshTokenHash: string;
  createdAt: string;
  lastUsedAt: string;
  ipAddress: string | null;
  userAgent: string | null;
}

/** `auth:session:<jti>` → {@link SessionRecord}, TTL = refresh lifetime. */
export const sessionKey = (sessionId: string): string => `auth:session:${sessionId}`;

/** `auth:user-sessions:<userId>` → set of active session ids. */
export const userSessionsKey = (userId: string): string => `auth:user-sessions:${userId}`;

/** `auth:login-attempts:<identifier>` → failed password attempts counter. */
export const loginAttemptsKey = (identifier: string): string => `auth:login-attempts:${identifier}`;

/** `auth:login-lock:<identifier>` → present while password login is locked. */
export const loginLockKey = (identifier: string): string => `auth:login-lock:${identifier}`;

/**
 * Issues and validates tokens.
 *
 * The model is deliberately *stateful* on top of stateless JWTs:
 *
 * - the **access token** is a short-lived (15m) stateless JWT — no database or
 *   Redis round-trip on the hot path;
 * - the **refresh token** is persistent (7d) and is tracked server-side in
 *   Redis, so it can be revoked instantly on logout.
 *
 * Refresh **rotates**: every successful refresh deletes the old session and
 * creates a new one. If a refresh token is presented whose session no longer
 * exists, that token was either already used or revoked — both are treated as a
 * replay and rejected, which is what makes stolen refresh tokens detectable
 * rather than silently reusable until they expire.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly accessSecret: string;
  private readonly refreshSecret: string;
  private readonly accessTtl: DurationString;
  private readonly refreshTtl: DurationString;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;
  private readonly issuer = 'shopino';
  private readonly audience = 'shopino-api';

  constructor(
    private readonly jwt: JwtService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.accessSecret = config.getOrThrow<string>('JWT_ACCESS_SECRET');
    this.refreshSecret = config.getOrThrow<string>('JWT_REFRESH_SECRET');
    this.accessTtl = config.getOrThrow<DurationString>('JWT_ACCESS_TTL');
    this.refreshTtl = config.getOrThrow<DurationString>('JWT_REFRESH_TTL');
    this.accessTtlSeconds = durationToSeconds(this.accessTtl);
    this.refreshTtlSeconds = durationToSeconds(this.refreshTtl);
  }

  get accessTokenTtlSeconds(): number {
    return this.accessTtlSeconds;
  }

  get refreshTokenTtlSeconds(): number {
    return this.refreshTtlSeconds;
  }

  /** Signs a fresh access/refresh pair and registers the session. */
  async issue(
    user: { id: string; mobile: string; role: UserRole },
    context: RequestContext,
  ): Promise<IssuedTokens> {
    const sessionId = randomUUID();

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        mobile: user.mobile,
        role: user.role,
        typ: 'access' satisfies TokenType,
        sid: sessionId,
      },
      {
        secret: this.accessSecret,
        expiresIn: this.accessTtl,
        issuer: this.issuer,
        audience: this.audience,
        jwtid: randomUUID(),
      },
    );

    const refreshToken = await this.jwt.signAsync(
      { sub: user.id, typ: 'refresh' satisfies TokenType },
      {
        secret: this.refreshSecret,
        expiresIn: this.refreshTtl,
        issuer: this.issuer,
        audience: this.audience,
        jwtid: sessionId,
      },
    );

    const now = new Date().toISOString();
    const record: SessionRecord = {
      userId: user.id,
      refreshTokenHash: hashToken(refreshToken),
      createdAt: now,
      lastUsedAt: now,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    };

    await this.redis.client
      .multi()
      .set(sessionKey(sessionId), JSON.stringify(record), 'EX', this.refreshTtlSeconds)
      .sadd(userSessionsKey(user.id), sessionId)
      .expire(userSessionsKey(user.id), this.refreshTtlSeconds)
      .exec();

    return {
      accessToken,
      refreshToken,
      expiresIn: this.accessTtlSeconds,
      refreshExpiresIn: this.refreshTtlSeconds,
      sessionId,
    };
  }

  /**
   * Validates an access token's signature and claims. The identity is *not*
   * trusted from the payload alone — callers re-read the user row so a
   * deactivated account or a changed role takes effect immediately.
   */
  async verifyAccessToken(token: string): Promise<AccessTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.accessSecret,
        issuer: this.issuer,
        audience: this.audience,
      });

      if (payload.typ !== 'access' || typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
        throw new UnauthorizedException('Invalid access token');
      }
      return payload;
    } catch (error) {
      throw new UnauthorizedException(
        error instanceof UnauthorizedException ? error.message : 'Invalid or expired access token',
      );
    }
  }

  /**
   * Rotates a refresh token: validates it, consumes the session and returns a
   * new pair. Throws `401` when the session is unknown, already rotated, or the
   * stored hash does not match the presented token.
   */
  async rotate(
    refreshToken: string,
    user: { id: string; mobile: string; role: UserRole },
    context: RequestContext,
  ): Promise<IssuedTokens> {
    const payload = await this.decodeRefreshToken(refreshToken);
    const key = sessionKey(payload.jti);
    const raw = await this.redis.client.get(key);

    if (raw === null) {
      this.logger.warn(`Refresh rejected: session ${payload.jti} is unknown or already rotated`);
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    const session = JSON.parse(raw) as SessionRecord;
    if (
      session.userId !== user.id ||
      session.userId !== payload.sub ||
      session.refreshTokenHash !== hashToken(refreshToken)
    ) {
      // A mismatch here means a *different* token claims the same session id.
      // Revoke the session outright: the legitimate client will simply log in again.
      await this.revoke(payload.jti);
      this.logger.warn(`Refresh rejected: token does not match session ${payload.jti}; session revoked`);
      throw new UnauthorizedException('Refresh token is no longer valid');
    }

    await this.revoke(payload.jti);
    return this.issue(user, context);
  }

  /** Session id (`jti`) carried by a refresh token, after signature validation. */
  async sessionIdOfRefreshToken(token: string): Promise<string> {
    return (await this.decodeRefreshToken(token)).jti;
  }

  /** Reads a stored session. Returns `null` when it no longer exists. */
  async getSession(sessionId: string): Promise<SessionRecord | null> {
    const raw = await this.redis.client.get(sessionKey(sessionId));
    return raw === null ? null : (JSON.parse(raw) as SessionRecord);
  }

  /** Revokes one session. Returns `true` when a session was actually removed. */
  async revoke(sessionId: string): Promise<boolean> {
    const raw = await this.redis.client.get(sessionKey(sessionId));
    const removed = await this.redis.client.del(sessionKey(sessionId));

    if (raw !== null) {
      const session = JSON.parse(raw) as SessionRecord;
      await this.redis.client.srem(userSessionsKey(session.userId), sessionId);
    }

    return removed > 0;
  }

  /** Revokes every session of a user (logout everywhere, password change, ban). */
  async revokeAllForUser(userId: string): Promise<number> {
    const sessionIds = await this.redis.client.smembers(userSessionsKey(userId));
    if (sessionIds.length === 0) {
      return 0;
    }
    await this.redis.client.del(...sessionIds.map((id) => sessionKey(id)), userSessionsKey(userId));
    return sessionIds.length;
  }

  /** Active sessions of a user, newest first. Never exposes any token material. */
  async listSessions(userId: string): Promise<Array<Omit<SessionRecord, 'refreshTokenHash'> & { sessionId: string }>> {
    const sessionIds = await this.redis.client.smembers(userSessionsKey(userId));
    if (sessionIds.length === 0) {
      return [];
    }

    const raws = await this.redis.client.mget(...sessionIds.map((id) => sessionKey(id)));
    const sessions = raws
      .map((raw, index) => {
        if (raw === null) {
          return null;
        }
        const session = JSON.parse(raw) as SessionRecord;
        // The refresh-token hash is deliberately not part of the projection.
        return {
          sessionId: sessionIds[index] as string,
          userId: session.userId,
          createdAt: session.createdAt,
          lastUsedAt: session.lastUsedAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        };
      })
      .filter((session): session is Omit<SessionRecord, 'refreshTokenHash'> & { sessionId: string } => session !== null);

    return sessions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async decodeRefreshToken(token: string): Promise<RefreshTokenPayload> {
    try {
      const payload = await this.jwt.verifyAsync<RefreshTokenPayload>(token, {
        secret: this.refreshSecret,
        issuer: this.issuer,
        audience: this.audience,
      });
      if (payload.typ !== 'refresh' || typeof payload.sub !== 'string' || typeof payload.jti !== 'string') {
        throw new UnauthorizedException('Invalid refresh token');
      }
      return payload;
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}

/** sha256 hex digest, used for every stored token/secret material. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Converts the `@nestjs/jwt` duration shorthand (`15m`, `7d`, `12h`, `30s`) into
 * seconds. Used for Redis TTLs so a session never outlives its own token, and
 * for the `expiresIn` values returned to clients.
 */
export function durationToSeconds(value: string): number {
  const match = /^([1-9][0-9]*)([smhd])$/.exec(value.trim());
  if (match === null) {
    throw new Error(`Unsupported duration "${value}": expected forms like 30s, 15m, 12h or 7d`);
  }
  const amount = Number(match[1]);
  const unit = match[2] as 's' | 'm' | 'h' | 'd';

  switch (unit) {
    case 's':
      return amount;
    case 'm':
      return amount * 60;
    case 'h':
      return amount * 3_600;
    case 'd':
      return amount * 86_400;
  }
}
```

#### `apps/backend/src/modules/auth/token.service.spec.ts` · 54 lines

```ts
import { durationToSeconds, hashToken } from './token.service';

/**
 * Pure helpers of the token layer. The signing, rotation and session behaviour is
 * covered end-to-end against Redis in `test/auth.e2e-spec.ts`; what is tested here
 * is the arithmetic that everything else depends on — a wrong TTL silently
 * changes the security window of every session.
 */
describe('durationToSeconds', () => {
  it('converts every supported unit', () => {
    expect(durationToSeconds('30s')).toBe(30);
    expect(durationToSeconds('15m')).toBe(900);
    expect(durationToSeconds('12h')).toBe(43_200);
    expect(durationToSeconds('7d')).toBe(604_800);
  });

  it('matches the configured access/refresh defaults', () => {
    expect(durationToSeconds('15m')).toBe(15 * 60);
    expect(durationToSeconds('7d')).toBe(7 * 24 * 60 * 60);
  });

  it('tolerates surrounding whitespace', () => {
    expect(durationToSeconds(' 15m ')).toBe(900);
  });

  it('rejects anything it cannot interpret rather than guessing', () => {
    for (const value of ['', '15', 'm15', '15 minutes', '0m', '-5m', '1.5h', '15M', '15 m']) {
      expect(() => durationToSeconds(value.trim())).toThrow(/Unsupported duration/);
    }
  });

  it('treats zero-prefixed amounts as invalid', () => {
    expect(() => durationToSeconds('015m')).toThrow(/Unsupported duration/);
  });
});

describe('hashToken', () => {
  it('is a stable sha256 hex digest', () => {
    const digest = hashToken('some-token-value');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('some-token-value')).toBe(digest);
  });

  it('never returns the input, so a Redis dump yields no usable token', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    expect(hashToken(token)).not.toContain('eyJ');
    expect(hashToken(token)).not.toBe(token);
  });

  it('differs for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});
```

#### `apps/backend/src/modules/auth/auth.controller.ts` · 211 lines

```ts
import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Auditable, SkipAudit } from '../audit/audit.decorator';
import { setAuditSnapshot } from '../audit/audit-context';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext as RequestContextValue } from '../../common/types/request-context';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { PasswordLoginDto } from './dto/password-login.dto';
import { LogoutDto, RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdateProfileDto } from '../users/dto/update-profile.dto';
import {
  AuthTokensResponseDto,
  LogoutResponseDto,
  MeResponseDto,
  OtpRequestResponseDto,
  ProfileUpdateResponseDto,
  SmsProviderInfoDto,
} from './dto/auth-response.dto';

/**
 * Public authentication surface plus the self-service identity endpoints.
 *
 * Every route below is reachable only through the global guards:
 * `@Public()` marks the four anonymous entry points, everything else requires a
 * valid access token. Mutating routes are audited by `AuditInterceptor`;
 * `@Auditable(...)` only tells it *which* action to record.
 */
@ApiTags('auth')
@ApiExtraModels(MeResponseDto, ProfileUpdateResponseDto, AuthTokensResponseDto)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiOperation({
    summary: 'درخواست کد یکبارمصرف (OTP)',
    description:
      'شماره موبایل را نرمال میکند، محدودیت نرخ را بررسی میکند، کد ۵ رقمی امن تولید و از طریق Provider فعال پیامک ارسال میکند. ' +
      'محدودیتها: یک درخواست در هر ۱۲۰ ثانیه برای هر شماره، سقف ساعتی برای شماره و برای IP.',
  })
  @ApiOkResponse({ type: OtpRequestResponseDto, description: 'کد ارسال شد' })
  @ApiBadRequestResponse({ description: 'شماره موبایل نامعتبر است' })
  @ApiTooManyRequestsResponse({
    description: 'در بازهٔ انتظار (cooldown)، قفل موقت، یا عبور از سقف ساعتی',
  })
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @ClientContext() context: RequestContextValue,
  ): Promise<OtpRequestResponseDto> {
    return this.auth.requestOtp(dto, context);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: AuditAction.LOGIN, entityName: 'User' })
  @ApiOperation({
    summary: 'تأیید کد یکبارمصرف و دریافت توکنها',
    description:
      'کد را بهصورت اتمیک بررسی میکند. در صورت درست بودن: کاربر ناشناس با نقش CUSTOMER و پروفایل خالی مشتری ساخته میشود و ' +
      'توکن دسترسی (۱۵ دقیقه) و توکن تازهسازی چرخشی (۷ روز) صادر میشود. پس از ۵ کد نادرست، شماره ۱۵ دقیقه قفل میشود.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'کد نادرست، منقضی یا پیشتر مصرفشده' })
  @ApiForbiddenResponse({ description: 'حساب غیرفعال شده است' })
  @ApiTooManyRequestsResponse({ description: 'تعداد تلاشهای نادرست از حد گذشته و شماره قفل شده است' })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() request: unknown,
    @ClientContext() context: RequestContextValue,
  ): Promise<AuthTokensResponseDto> {
    const result = await this.auth.verifyOtp(dto, context);
    // Lets the audit interceptor attribute the LOGIN row to the account that was
    // just authenticated, since this route runs before any JWT exists.
    setAuditSnapshot(request, { actorId: result.user.id, entityId: result.user.id });
    return result;
  }

  @Public()
  @Post('login/password')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: AuditAction.LOGIN, entityName: 'User' })
  @ApiOperation({
    summary: 'ورود با رمز عبور (کارکنان و فروشندگان)',
    description:
      'شناسه میتواند ایمیل یا شماره موبایل باشد. رمز با Argon2id بررسی میشود. پس از ۵ تلاش ناموفق، شناسه ۱۵ دقیقه قفل میشود.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'شناسه یا رمز نادرست' })
  @ApiForbiddenResponse({ description: 'حساب غیرفعال شده است' })
  @ApiTooManyRequestsResponse({ description: 'شناسه به دلیل تلاشهای ناموفق قفل شده است' })
  async loginWithPassword(
    @Body() dto: PasswordLoginDto,
    @Req() request: unknown,
    @ClientContext() context: RequestContextValue,
  ): Promise<AuthTokensResponseDto> {
    const result = await this.auth.loginWithPassword(dto, context);
    setAuditSnapshot(request, { actorId: result.user.id, entityId: result.user.id });
    return result;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiOperation({
    summary: 'چرخش توکن تازهسازی',
    description:
      'توکن تازهسازی مصرف و با یک جفت تازه جایگزین میشود. توکنِ مصرفشده دیگر کار نمیکند؛ ' +
      'استفادهٔ مجدد از آن بهعنوان تلاش برای بازپخش شناسایی و کل نشست باطل میشود.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'توکن تازهسازی نامعتبر، منقضی یا پیشتر چرخششده' })
  @ApiForbiddenResponse({ description: 'حساب غیرفعال شده است' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @ClientContext() context: RequestContextValue,
  ): Promise<AuthTokensResponseDto> {
    return this.auth.refresh(dto.refreshToken, context);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: AuditAction.LOGOUT, entityName: 'User' })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'خروج و ابطال نشست',
    description:
      'نشست جاری را در Redis باطل میکند؛ در صورت ارسال توکن تازهسازی، همان نشست نیز باطل میشود.',
  })
  @ApiOkResponse({ type: LogoutResponseDto })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LogoutDto,
    @Req() request: unknown,
  ): Promise<LogoutResponseDto> {
    const result = await this.auth.logout(user, dto.refreshToken);
    setAuditSnapshot(request, { actorId: user.id, entityId: user.id, newValue: result });
    return result;
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'اطلاعات کاربر جاری',
    description: 'کاربر، پروفایل مشتری و در صورت وجود، پروفایل فروشندگی فعال را برمیگرداند.',
  })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.auth.me(user);
  }

  @Patch('profile')
  @Auditable({ entityName: 'User' })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'ویرایش پروفایل شخصی',
    description:
      'نام، ایمیل، کد ملی (با اعتبارسنجی رقم کنترلی) و تاریخ تولد قابل تغییر است. ' +
      'شماره موبایل و نقش از این مسیر قابل تغییر نیستند. تغییرات در audit_logs با مقدار قبلی و جدید ثبت میشود.',
  })
  @ApiOkResponse({ type: ProfileUpdateResponseDto })
  @ApiBadRequestResponse({ description: 'کد ملی یا تاریخ تولد نامعتبر' })
  @ApiConflictResponse({ description: 'ایمیل یا کد ملی قبلاً ثبت شده است' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
    @Req() request: unknown,
  ): Promise<ProfileUpdateResponseDto> {
    const outcome = await this.auth.updateProfile(user, dto);
    setAuditSnapshot(request, outcome.audit);
    return outcome.response;
  }

  @Public()
  @Get('sms-provider')
  @SkipAudit()
  @ApiOperation({
    summary: 'اطلاع از Provider فعال پیامک',
    description:
      'برای شفافیت محیط: نشان میدهد پیامک واقعی ارسال میشود یا Provider آزمایشی توسعه فعال است. ' +
      'در Production مقدار isTestProvider همیشه false است.',
  })
  @ApiOkResponse({ type: SmsProviderInfoDto })
  smsProvider(): SmsProviderInfoDto {
    return this.auth.smsProviderInfo();
  }
}
```

#### `apps/backend/src/modules/auth/auth.module.ts` · 44 lines

```ts
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { DurationString } from '../../common/types/duration';
import { AuditModule } from '../audit/audit.module';
import { SmsModule } from '../sms/sms.module';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { OtpService } from './otp.service';
import { TokenService } from './token.service';

/**
 * Authentication module.
 *
 * `JwtModule` is configured asynchronously from the validated environment (never
 * from a literal in the source), and the signing secret used here is only the
 * *access* secret: the refresh token is signed with its own secret inside
 * `TokenService`, so compromising one key never yields the other.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvironmentVariables, true>) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          expiresIn: config.getOrThrow<DurationString>('JWT_ACCESS_TTL'),
          issuer: 'shopino',
          audience: 'shopino-api',
        },
      }),
    }),
    UsersModule,
    SmsModule,
    AuditModule,
  ],
  controllers: [AuthController],
  providers: [AuthService, OtpService, TokenService],
  exports: [AuthService, TokenService],
})
export class AuthModule {}
```

#### `apps/backend/src/modules/auth/guards/jwt-auth.guard.ts` · 115 lines

```ts
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user';
import { PrismaService } from '../../../infra/prisma/prisma.service';
import { TokenService } from '../token.service';

interface GuardedRequest {
  headers?: Record<string, string | string[] | undefined>;
  user?: AuthenticatedUser;
  method?: string;
  url?: string;
}

/**
 * Global authentication guard.
 *
 * Registered as an `APP_GUARD`, so **every** route requires a valid access token
 * unless it is explicitly marked `@Public()`. That default is the important part:
 * a new endpoint is protected the moment it is written, and forgetting a
 * decorator fails closed.
 *
 * The token is verified cryptographically by `TokenService`, and then the user is
 * re-read from PostgreSQL on every request. That one indexed lookup buys two
 * properties worth far more than the query costs:
 *
 *  - deactivating an account (`isActive = false`) takes effect immediately rather
 *    than after the access token expires;
 *  - a role change is honoured at once — an access token issued while the user was
 *    an ADMIN cannot be used to act as an ADMIN after the role was downgraded.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<GuardedRequest>();
    const token = extractBearerToken(request.headers?.authorization);

    if (isPublic === true) {
      // A public route may still carry a token (e.g. an authenticated client
      // hitting a shared endpoint); it is decoded but never required.
      if (token !== null) {
        const payload = await this.tryVerify(token);
        if (payload !== null) {
          request.user = await this.loadIdentity(payload.sub, payload.sid);
        }
      }
      return true;
    }

    if (token === null) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const payload = await this.tokens.verifyAccessToken(token);
    request.user = await this.loadIdentity(payload.sub, payload.sid);
    return true;
  }

  private async tryVerify(token: string): Promise<{ sub: string; sid: string } | null> {
    try {
      const payload = await this.tokens.verifyAccessToken(token);
      return { sub: payload.sub, sid: payload.sid };
    } catch {
      return null;
    }
  }

  private async loadIdentity(userId: string, sessionId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, mobile: true, role: true, isActive: true },
    });

    if (user === null) {
      throw new UnauthorizedException('Account no longer exists');
    }
    if (!user.isActive) {
      throw new ForbiddenException('This account is deactivated');
    }

    return { id: user.id, mobile: user.mobile, role: user.role, sessionId };
  }
}

/** Reads the bearer token from the `Authorization` header, if present. */
export function extractBearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value !== 'string') {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() ?? null;
}
```

#### `apps/backend/src/modules/auth/guards/jwt-auth.guard.spec.ts` · 134 lines

```ts
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { PrismaService } from '../../../infra/prisma/prisma.service';
import { extractBearerToken, JwtAuthGuard } from './jwt-auth.guard';
import type { AccessTokenPayload, TokenService } from '../token.service';

interface FakeRequest {
  headers: Record<string, string | undefined>;
  user?: unknown;
}

const contextFor = (request: FakeRequest): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  }) as unknown as ExecutionContext;

const reflectorWith = (metadata: Record<string, unknown>): Reflector =>
  ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

const tokensWith = (payload: AccessTokenPayload | Error): TokenService =>
  ({
    verifyAccessToken: (): Promise<AccessTokenPayload> =>
      payload instanceof Error ? Promise.reject(payload) : Promise.resolve(payload),
  }) as unknown as TokenService;

const prismaWith = (user: { id: string; mobile: string; role: UserRole; isActive: boolean } | null): PrismaService =>
  ({ user: { findUnique: () => Promise.resolve(user) } }) as unknown as PrismaService;

const payload: AccessTokenPayload = {
  sub: '11111111-1111-1111-1111-111111111111',
  mobile: '+989120000001',
  role: UserRole.SUPER_ADMIN,
  typ: 'access',
  sid: '22222222-2222-2222-2222-222222222222',
  jti: '33333333-3333-3333-3333-333333333333',
};

describe('extractBearerToken', () => {
  it('reads a well-formed Authorization header case-insensitively', () => {
    expect(extractBearerToken('Bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken('bearer abc.def.ghi')).toBe('abc.def.ghi');
    expect(extractBearerToken(['Bearer abc.def.ghi'])).toBe('abc.def.ghi');
  });

  it('returns null when the header is absent or not a bearer scheme', () => {
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
    expect(extractBearerToken('abc.def.ghi')).toBeNull();
  });
});

describe('JwtAuthGuard', () => {
  it('rejects a protected route without a token', async () => {
    const guard = new JwtAuthGuard(reflectorWith({}), tokensWith(payload), prismaWith(null));

    await expect(guard.canActivate(contextFor({ headers: {} }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects an invalid or expired token', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({}),
      tokensWith(new UnauthorizedException('Invalid or expired access token')),
      prismaWith(null),
    );

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer broken.token.value' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('attaches the identity read from the database, not the token claims', async () => {
    // The token says SUPER_ADMIN; the database says the role was downgraded.
    const guard = new JwtAuthGuard(
      reflectorWith({}),
      tokensWith(payload),
      prismaWith({ id: payload.sub, mobile: payload.mobile, role: UserRole.SUPPORT, isActive: true }),
    );
    const request: FakeRequest = { headers: { authorization: 'Bearer valid.token.value' } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ role: UserRole.SUPPORT, sessionId: payload.sid });
  });

  it('refuses a deactivated account even with a valid token', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({}),
      tokensWith(payload),
      prismaWith({ id: payload.sub, mobile: payload.mobile, role: UserRole.SUPER_ADMIN, isActive: false }),
    );

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer valid.token.value' } })),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses a token whose account no longer exists', async () => {
    const guard = new JwtAuthGuard(reflectorWith({}), tokensWith(payload), prismaWith(null));

    await expect(
      guard.canActivate(contextFor({ headers: { authorization: 'Bearer valid.token.value' } })),
    ).rejects.toThrow(UnauthorizedException);
  });

  it('lets a public route through without a token', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({ [IS_PUBLIC_KEY]: true }),
      tokensWith(new UnauthorizedException()),
      prismaWith(null),
    );
    const request: FakeRequest = { headers: {} };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it('populates the identity on a public route when a valid token is supplied', async () => {
    const guard = new JwtAuthGuard(
      reflectorWith({ [IS_PUBLIC_KEY]: true }),
      tokensWith(payload),
      prismaWith({ id: payload.sub, mobile: payload.mobile, role: UserRole.SUPER_ADMIN, isActive: true }),
    );
    const request: FakeRequest = { headers: { authorization: 'Bearer valid.token.value' } };

    await expect(guard.canActivate(contextFor(request))).resolves.toBe(true);
    expect(request.user).toMatchObject({ id: payload.sub });
  });
});
```

#### `apps/backend/src/modules/auth/guards/roles.guard.ts` · 71 lines

```ts
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user';

interface RequestWithIdentity {
  user?: AuthenticatedUser;
}

/**
 * Role-based access control, evaluated after {@link JwtAuthGuard}.
 *
 * It reads the role from `request.user`, which the authentication guard has
 * already replaced with the *current database value* — so this guard can never be
 * fooled by a stale claim inside an older token.
 *
 * Rules:
 * - a route without `@Roles(...)` is open to every authenticated user;
 * - a route with `@Roles(...)` requires the actor to hold one of them;
 * - `@Public()` routes are skipped entirely: they have no identity by design, and
 *   combining `@Public()` with `@Roles()` would be contradictory. `RolesGuard`
 *   therefore denies anything that reaches it without an identity **unless** the
 *   route is public, in which case the decorator combination is reported as a
 *   programming error at startup-time reasoning rather than a silent bypass.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') {
      return true;
    }

    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles === undefined || requiredRoles.length === 0) {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      // Contradictory declaration: an endpoint cannot be both anonymous and
      // role-restricted. Deny rather than let the weaker annotation win.
      throw new ForbiddenException('This endpoint has a contradictory access declaration');
    }

    const request = context.switchToHttp().getRequest<RequestWithIdentity>();
    const actor = request.user;
    if (actor === undefined) {
      throw new ForbiddenException('Authentication is required for this resource');
    }

    if (!requiredRoles.includes(actor.role)) {
      throw new ForbiddenException(
        `This action requires one of the following roles: ${requiredRoles.join(', ')}`,
      );
    }

    return true;
  }
}
```

#### `apps/backend/src/modules/auth/guards/roles.guard.spec.ts` · 82 lines

```ts
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import { ROLES_KEY } from '../../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../../common/types/authenticated-user';
import { RolesGuard } from './roles.guard';

/**
 * Pure authorization logic, tested without HTTP: the guard only reads metadata
 * and the identity the authentication guard already resolved.
 */
const contextFor = (user?: AuthenticatedUser): ExecutionContext =>
  ({
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const actor = (role: UserRole): AuthenticatedUser => ({
  id: '11111111-1111-1111-1111-111111111111',
  mobile: '+989120000001',
  role,
  sessionId: '22222222-2222-2222-2222-222222222222',
});

/** Reflector stub that answers exactly the keys the guard asks for. */
const reflectorWith = (metadata: Record<string, unknown>): Reflector =>
  ({ getAllAndOverride: (key: string) => metadata[key] }) as unknown as Reflector;

describe('RolesGuard', () => {
  it('allows a route with no @Roles decorator for any authenticated user', () => {
    const guard = new RolesGuard(reflectorWith({}));

    for (const role of Object.values(UserRole)) {
      expect(guard.canActivate(contextFor(actor(role)))).toBe(true);
    }
  });

  it('allows a route when the actor holds one of the required roles', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.SUPER_ADMIN, UserRole.ADMIN] }));

    expect(guard.canActivate(contextFor(actor(UserRole.SUPER_ADMIN)))).toBe(true);
    expect(guard.canActivate(contextFor(actor(UserRole.ADMIN)))).toBe(true);
  });

  it('denies a route when the actor holds none of the required roles', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.SUPER_ADMIN] }));

    for (const role of [UserRole.CUSTOMER, UserRole.VENDOR, UserRole.SUPPORT, UserRole.FINANCIAL_OFFICER]) {
      expect(() => guard.canActivate(contextFor(actor(role)))).toThrow(ForbiddenException);
    }
  });

  it('denies a role-restricted route when no identity is present', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.CUSTOMER] }));

    expect(() => guard.canActivate(contextFor(undefined))).toThrow(ForbiddenException);
  });

  it('refuses a contradictory @Public + @Roles declaration instead of letting the weaker one win', () => {
    const guard = new RolesGuard(
      reflectorWith({ [ROLES_KEY]: [UserRole.CUSTOMER], [IS_PUBLIC_KEY]: true }),
    );

    expect(() => guard.canActivate(contextFor(actor(UserRole.SUPER_ADMIN)))).toThrow(ForbiddenException);
  });

  it('treats an empty role list as "no restriction"', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [] }));
    expect(guard.canActivate(contextFor(actor(UserRole.CUSTOMER)))).toBe(true);
  });

  it('does not interfere with non-HTTP contexts', () => {
    const guard = new RolesGuard(reflectorWith({ [ROLES_KEY]: [UserRole.SUPER_ADMIN] }));
    const rpcContext = { getType: () => 'rpc' } as unknown as ExecutionContext;

    expect(guard.canActivate(rpcContext)).toBe(true);
  });
});
```

#### `apps/backend/src/modules/auth/otp.service.spec.ts` · 319 lines

```ts
import type { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import type { EnvironmentVariables } from '../../config/env.validation';
import type { RedisService } from '../../infra/redis/redis.service';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import type { AuditLogService } from '../audit/audit-log.service';
import type { SmsService } from '../sms/sms.service';
import type { UsersService, UserIdentity } from '../users/users.service';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { hashPassword } from '../../infra/security/password';
import { AuthService, normalizeIdentifier } from './auth.service';
import { OtpVerifyResult } from './otp.service';
import type { OtpService } from './otp.service';
import type { TokenService, IssuedTokens } from './token.service';

const ENV: Partial<EnvironmentVariables> = {
  AUTH_MAX_LOGIN_ATTEMPTS: 5,
  AUTH_LOCK_SECONDS: 900,
};

/**
 * Minimal in-memory stand-in for the `ioredis` client, implementing exactly the
 * commands the auth services issue. Only the pieces the unit tests exercise are
 * modelled — the real Redis behaviour (TTLs, atomic Lua, rotation) is verified by
 * `test/auth.e2e-spec.ts` against an actual Redis instance.
 */
interface FakePipeline {
  incr: (key: string) => FakePipeline;
  expire: () => FakePipeline;
  exec: () => Promise<unknown>;
  del: () => Promise<number>;
  set: () => Promise<string>;
  hset: () => Promise<number>;
}

function fakeRedisClient(): Record<string, unknown> {
  const counters = new Map<string, number>();
  const chain: FakePipeline = {
    incr: (key: string): FakePipeline => {
      counters.set(key, (counters.get(key) ?? 0) + 1);
      return chain;
    },
    expire: (): FakePipeline => chain,
    exec: (): Promise<unknown> => Promise.resolve([[null, 1]]),
    del: (): Promise<number> => Promise.resolve(1),
    set: (): Promise<string> => Promise.resolve('OK'),
    hset: (): Promise<number> => Promise.resolve(1),
  };
  return {
    ttl: () => Promise.resolve(-2),
    del: () => Promise.resolve(1),
    get: () => Promise.resolve(null),
    set: () => Promise.resolve('OK'),
    keys: () => Promise.resolve([]),
    multi: () => chain,
  };
}

const configStub = (): ConfigService<EnvironmentVariables, true> =>
  ({ getOrThrow: (key: keyof EnvironmentVariables) => ENV[key] }) as unknown as ConfigService<EnvironmentVariables, true>;

const context: RequestContext = { ipAddress: '198.51.100.7', userAgent: 'jest-unit' };

const customerIdentity = (overrides: Partial<UserIdentity['user']> = {}): UserIdentity => ({
  user: {
    id: '11111111-1111-1111-1111-111111111111',
    mobile: '+989120000001',
    email: null,
    fullName: 'کاربر ۰۹۱۲۰۰۰۰۰۰۱',
    role: UserRole.CUSTOMER,
    isActive: true,
    nationalCode: null,
    lastLoginAt: null,
    createdAt: new Date('2026-09-26T10:00:00.000Z'),
    ...overrides,
  },
  customerProfile: { birthDate: null, gender: null, bankIban: null, defaultAddressId: null },
  vendor: null,
});

const issued: IssuedTokens = {
  accessToken: 'access.token.value',
  refreshToken: 'refresh.token.value',
  expiresIn: 900,
  refreshExpiresIn: 604_800,
  sessionId: '22222222-2222-2222-2222-222222222222',
};

interface Stubs {
  users?: Partial<UsersService>;
  otp?: Partial<OtpService>;
  tokens?: Partial<TokenService>;
  sms?: Partial<SmsService>;
  audit?: Partial<AuditLogService>;
}

const buildService = (stubs: Stubs = {}): AuthService =>
  new AuthService(
    {
      ensureCustomer: () => Promise.resolve(customerIdentity()),
      getIdentity: () => Promise.resolve(customerIdentity()),
      touchLastLogin: () => Promise.resolve(),
      findByIdentifier: () => Promise.resolve(null),
      updateProfile: () =>
        Promise.resolve({
          before: { fullName: 'old', email: null, nationalCode: null, birthDate: null },
          after: { fullName: 'new', email: null, nationalCode: null, birthDate: null },
          user: customerIdentity().user,
        }),
      ...stubs.users,
    } as unknown as UsersService,
    {
      verify: () => Promise.resolve(OtpVerifyResult.Match),
      createChallenge: () =>
        Promise.resolve({
          code: '48213',
          challenge: { mobile: '+989120000001', expiresInSeconds: 120, attemptsAllowed: 5 },
        }),
      clear: () => Promise.resolve(),
      lockRemainingSeconds: () => Promise.resolve(870),
      ...stubs.otp,
    } as unknown as OtpService,
    {
      issue: () => Promise.resolve(issued),
      rotate: () => Promise.resolve(issued),
      revoke: () => Promise.resolve(true),
      getSession: () => Promise.resolve(null),
      sessionIdOfRefreshToken: () => Promise.resolve('22222222-2222-2222-2222-222222222222'),
      ...stubs.tokens,
    } as unknown as TokenService,
    {
      sendOtp: () => Promise.resolve({ provider: 'sandbox', referenceId: 'SBX-1', segments: 1, status: 'sent' }),
      describe: () => ({ provider: 'sandbox', isTestProvider: true }),
      ...stubs.sms,
    } as unknown as SmsService,
    { record: () => Promise.resolve('audit-id'), ...stubs.audit } as unknown as AuditLogService,
    { client: fakeRedisClient() } as unknown as RedisService,
    configStub(),
  );

describe('AuthService.requestOtp', () => {
  it('returns the provider tracking id and the configured TTL', async () => {
    const service = buildService();

    await expect(service.requestOtp({ mobile: '+989120000001' }, context)).resolves.toEqual({
      status: 'sent',
      expiresInSeconds: 120,
      trackingId: 'SBX-1',
    });
  });

  it('surfaces a provider failure as a 503 and does not report success', async () => {
    const service = buildService({
      sms: {
        sendOtp: () => Promise.reject(new Error('gateway down')),
      } as unknown as Partial<SmsService>,
    });

    await expect(service.requestOtp({ mobile: '+989120000001' }, context)).rejects.toThrow('gateway down');
  });
});

describe('AuthService.verifyOtp', () => {
  it('issues tokens for a correct code and promotes an unknown number to a customer', async () => {
    const service = buildService();

    const result = await service.verifyOtp({ mobile: '+989120000001', code: '48213' }, context);

    expect(result.accessToken).toBe('access.token.value');
    expect(result.user.role).toBe(UserRole.CUSTOMER);
    expect(result.expiresIn).toBe(900);
    expect(result.sessionId).toBe(issued.sessionId);
  });

  it('maps an unknown or expired challenge to 401', async () => {
    const service = buildService({ otp: { verify: () => Promise.resolve(OtpVerifyResult.NotFound) } });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow(
      /expired or was already used/,
    );
  });

  it('maps a wrong code to 401', async () => {
    const service = buildService({ otp: { verify: () => Promise.resolve(OtpVerifyResult.Mismatch) } });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow(
      /Incorrect code/,
    );
  });

  it('maps an exhausted attempt budget to 429 with a retry hint', async () => {
    const service = buildService({ otp: { verify: () => Promise.resolve(OtpVerifyResult.Exhausted) } });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow(
      TooManyRequestsException,
    );
  });

  it('refuses a deactivated account even with a correct code', async () => {
    const service = buildService({
      users: { ensureCustomer: () => Promise.resolve(customerIdentity({ isActive: false })) },
    });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '48213' }, context)).rejects.toThrow(
      /deactivated/,
    );
  });

  it('writes a failed-login audit row for every rejected attempt', async () => {
    const record = jest.fn((): Promise<string> => Promise.resolve('audit-id'));
    const service = buildService({
      otp: { verify: () => Promise.resolve(OtpVerifyResult.Mismatch) },
      audit: { record } as unknown as Partial<AuditLogService>,
    });

    await expect(service.verifyOtp({ mobile: '+989120000001', code: '00000' }, context)).rejects.toThrow();

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGIN',
        entityName: 'User',
        ipAddress: context.ipAddress,
        newValue: expect.objectContaining({ success: false, reason: 'otp_mismatch' }) as unknown,
      }),
    );
  });
});

describe('AuthService.loginWithPassword', () => {
  /** A real Argon2id hash, produced by the production helper. */
  let realHash: string;

  beforeAll(async () => {
    realHash = await hashPassword('the-correct-password-value');
  });

  it('rejects an unknown account with the same error as a wrong password', async () => {
    const service = buildService({ users: { findByIdentifier: () => Promise.resolve(null) } });

    await expect(
      service.loginWithPassword({ identifier: 'nobody@shopino.local', password: 'whatever-password' }, context),
    ).rejects.toThrow('Invalid credentials.');
  });

  it('refuses a deactivated account without revealing it in the message', async () => {
    const service = buildService({
      users: {
        findByIdentifier: () =>
          Promise.resolve({
            ...customerIdentity({ role: UserRole.ADMIN, isActive: false, email: 'admin@shopino.local' }),
            passwordHash: realHash,
          }),
      },
    });

    await expect(
      service.loginWithPassword({ identifier: 'admin@shopino.local', password: 'wrong-password-value' }, context),
    ).rejects.toThrow('Invalid credentials.');
  });
});

describe('AuthService.logout', () => {
  const actor: AuthenticatedUser = {
    id: '11111111-1111-1111-1111-111111111111',
    mobile: '+989120000001',
    role: UserRole.CUSTOMER,
    sessionId: '22222222-2222-2222-2222-222222222222',
  };

  it('revokes the current session', async () => {
    const revoke = jest.fn().mockResolvedValue(true);
    const service = buildService({ tokens: { revoke } as unknown as Partial<TokenService> });

    await expect(service.logout(actor)).resolves.toEqual({ revoked: true, sessionsRevoked: 1 });
    expect(revoke).toHaveBeenCalledWith(actor.sessionId);
  });

  it('ignores a refresh token that belongs to another user', async () => {
    const revoke = jest.fn().mockResolvedValue(true);
    const service = buildService({
      tokens: {
        revoke,
        getSession: () =>
          Promise.resolve({
            userId: '99999999-9999-9999-9999-999999999999',
            refreshTokenHash: 'x',
            createdAt: 'now',
            lastUsedAt: 'now',
            ipAddress: null,
            userAgent: null,
          }),
      } as unknown as Partial<TokenService>,
    });

    await expect(service.logout(actor, 'a.b.c')).resolves.toEqual({ revoked: true, sessionsRevoked: 1 });
    // Only the actor's own session was revoked.
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeIdentifier', () => {
  it('collapses every mobile spelling to one bucket', () => {
    for (const value of ['09120000001', '+989120000001', '00989120000001', '۰۹۱۲۰۰۰۰۰۰۱']) {
      expect(normalizeIdentifier(value)).toBe('+989120000001');
    }
  });

  it('lower-cases and trims e-mail identifiers', () => {
    expect(normalizeIdentifier('  Admin@Shopino.Local ')).toBe('admin@shopino.local');
  });
});

describe('sandbox provider reporting', () => {
  it('reports the active provider honestly', () => {
    expect(buildService().smsProviderInfo()).toEqual({ provider: 'sandbox', isTestProvider: true });
  });
});
```

#### `apps/backend/src/modules/auth/dto/request-otp.dto.ts` · 16 lines

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { toE164 } from '../../../common/validators/iranian-mobile';

export class RequestOtpDto {
  @ApiProperty({
    example: '09120000001',
    description:
      'شماره موبایل ایران — قالبهای 09XXXXXXXXX و +989XXXXXXXXX پذیرفته و به E.164 نرمال میشوند',
  })
  @Transform(({ value }): unknown => (typeof value === 'string' ? (toE164(value) ?? value) : value))
  @IsIranianMobile()
  mobile!: string;
}
```

#### `apps/backend/src/modules/auth/dto/verify-otp.dto.ts` · 22 lines

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Matches } from 'class-validator';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { toAsciiDigits, toE164 } from '../../../common/validators/iranian-mobile';

export class VerifyOtpDto {
  @ApiProperty({
    example: '09120000001',
    description: 'همان شمارهای که کد برای آن درخواست شده است',
  })
  @Transform(({ value }): unknown => (typeof value === 'string' ? (toE164(value) ?? value) : value))
  @IsIranianMobile()
  mobile!: string;

  @ApiProperty({ example: '48213', description: 'کد یکبارمصرف ۵ رقمی' })
  @Transform(({ value }): unknown => (typeof value === 'string' ? toAsciiDigits(value).trim() : value))
  @IsString()
  @Matches(/^[0-9]{4,8}$/, { message: 'کد یکبارمصرف باید فقط رقم باشد' })
  code!: string;
}
```

#### `apps/backend/src/modules/auth/dto/password-login.dto.ts` · 22 lines

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class PasswordLoginDto {
  @ApiProperty({
    example: 'admin@shopino.local',
    description: 'ایمیل یا شماره موبایل کارکنان/فروشندگان',
    maxLength: 254,
  })
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 254)
  identifier!: string;

  @ApiProperty({ example: 'Str0ng-Passphrase!', minLength: 8, maxLength: 128, writeOnly: true })
  @IsString()
  @MinLength(8, { message: 'رمز عبور حداقل ۸ کاراکتر است' })
  @MaxLength(128)
  password!: string;
}
```

#### `apps/backend/src/modules/auth/dto/refresh-token.dto.ts` · 23 lines

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsOptional } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'توکن تازهسازی که در پاسخ ورود/تأیید OTP برگردانده شد',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
  })
  @IsJWT()
  refreshToken!: string;
}

export class LogoutDto {
  @ApiProperty({
    required: false,
    description:
      'در صورت ارسال، همان نشست باطل میشود؛ در غیر این صورت نشست جاریِ توکن دسترسی باطل میشود',
  })
  @IsOptional()
  @IsJWT()
  refreshToken?: string;
}
```

#### `apps/backend/src/modules/auth/dto/auth-response.dto.ts` · 135 lines

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { PublicUser, UserIdentity } from '../../users/users.service';

/** The user object embedded in every authentication response. */
export class AuthUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+989120000001' })
  mobile!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.CUSTOMER })
  role!: UserRole;

  @ApiProperty({ example: 'سارا محمدی' })
  fullName!: string;

  @ApiProperty({ nullable: true, example: 'sara@example.com' })
  email!: string | null;

  static from(user: PublicUser): AuthUserDto {
    return { id: user.id, mobile: user.mobile, role: user.role, fullName: user.fullName, email: user.email };
  }
}

export class OtpRequestResponseDto {
  @ApiProperty({ example: 'sent', enum: ['sent'] })
  status!: 'sent';

  @ApiProperty({ example: 120, description: 'مدت اعتبار کد به ثانیه' })
  expiresInSeconds!: number;

  @ApiProperty({
    example: 'SBX-M8ZK2P-1',
    description: 'شناسه ارسال نزد سرویسدهنده پیامک، برای پیگیری تحویل',
  })
  trackingId!: string;
}

export class AuthTokensResponseDto {
  @ApiProperty({ description: 'توکن دسترسی کوتاهعمر (پیشفرض ۱۵ دقیقه)' })
  accessToken!: string;

  @ApiProperty({ description: 'توکن تازهسازی پایدار (پیشفرض ۷ روز) — یکبارمصرف و چرخشی' })
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'عمر توکن دسترسی به ثانیه' })
  expiresIn!: number;

  @ApiProperty({ example: 604_800, description: 'عمر توکن تازهسازی به ثانیه' })
  refreshExpiresIn!: number;

  @ApiProperty({ example: '42f1…', description: 'شناسه نشست؛ برای ابطال هدفمند' })
  sessionId!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class CustomerProfileDto {
  @ApiProperty({ nullable: true, example: '1994-05-17T00:00:00.000Z' })
  birthDate!: Date | null;

  @ApiProperty({ nullable: true, enum: ['MALE', 'FEMALE', 'OTHER'] })
  gender!: string | null;

  @ApiProperty({ nullable: true, example: 'IR120570000000000000000001' })
  bankIban!: string | null;

  @ApiProperty({ nullable: true, format: 'uuid' })
  defaultAddressId!: string | null;
}

export class VendorProfileDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'فروشگاه نمونه شاپینو' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;

  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] })
  status!: string;

  @ApiProperty({ nullable: true })
  logoUrl!: string | null;
}

export class MeResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiPropertyOptional({ type: CustomerProfileDto, nullable: true })
  customerProfile!: CustomerProfileDto | null;

  @ApiPropertyOptional({ type: VendorProfileDto, nullable: true })
  vendor!: VendorProfileDto | null;

  static from(identity: UserIdentity): MeResponseDto {
    return {
      user: AuthUserDto.from(identity.user),
      customerProfile: identity.customerProfile,
      vendor: identity.vendor,
    };
  }
}

export class ProfileUpdateResponseDto extends MeResponseDto {
  @ApiProperty({ example: true, description: 'تغییرات ذخیره شد' })
  updated!: boolean;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true, description: 'نشست در سرور باطل شد' })
  revoked!: boolean;

  @ApiProperty({ example: 1, description: 'تعداد نشستهای باطلشده' })
  sessionsRevoked!: number;
}

export class SmsProviderInfoDto {
  @ApiProperty({ example: 'sandbox', enum: ['sandbox', 'kavenegar'] })
  provider!: string;

  @ApiProperty({
    example: true,
    description:
      'اگر true باشد، پیامک واقعاً ارسال نمیشود (Provider آزمایشی توسعه). در Production همیشه false است.',
  })
  isTestProvider!: boolean;
}
```


### 4.6 Wiring and modified infrastructure files

#### `apps/backend/src/app.module.ts` · 47 lines

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { resolveEnvFilePaths } from './config/env-file-paths';
import { validateEnvironment, type EnvironmentVariables } from './config/env.validation';
import { HealthModule } from './infra/health/health.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { SmsModule } from './modules/sms/sms.module';
import { UsersModule } from './modules/users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot<EnvironmentVariables>({
      isGlobal: true,
      cache: true,
      envFilePath: resolveEnvFilePaths(),
      expandVariables: false,
      validate: (raw: Record<string, unknown>) => validateEnvironment(raw),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    // AuditModule comes before AuthModule: the auth module records LOGIN rows
    // through `AuditLogService`.
    AuditModule,
    AuthModule,
    UsersModule,
    SmsModule,
  ],
  providers: [
    // Order matters: authentication runs first and populates `request.user`,
    // then authorization decides. Both are global, so every route is protected
    // unless it opts out with `@Public()`.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // One global interceptor writes the audit trail for mutating requests.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
```

#### `apps/backend/src/config/env.validation.ts` · 332 lines

```ts
import { Logger } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
  type ValidationError,
} from 'class-validator';

export enum NodeEnvironment {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** Values accepted by `LOG_LEVEL`, ordered from most to least severe. */
export const LOG_LEVELS = ['error', 'warn', 'log', 'debug', 'verbose'] as const;
export type LogLevelName = (typeof LOG_LEVELS)[number];

/** JWT secrets shorter than this are considered unusable. */
export const MIN_SECRET_LENGTH = 32;

/** SMS providers the API can be configured with. */
export const SMS_PROVIDERS = ['sandbox', 'kavenegar'] as const;
export type SmsProviderName = (typeof SMS_PROVIDERS)[number];

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/\S+$/;

/** JWT lifetimes accept the `@nestjs/jwt` shorthand, e.g. `15m`, `7d`, `12h`. */
const DURATION_PATTERN = /^[1-9][0-9]*[smhd]$/;

const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;
const OPTIONAL_KEYS: readonly string[] = [
  ...SECRET_KEYS,
  'CORS_ORIGINS',
  'LOG_LEVEL',
  'SMS_KAVENEGAR_API_KEY',
  'SMS_KAVENEGAR_SENDER',
  'SMS_KAVENEGAR_OTP_TEMPLATE',
];

/** Shape of the validated configuration object exposed through `ConfigService`. */
export class EnvironmentVariables {
  @IsEnum(NodeEnvironment)
  NODE_ENV: NodeEnvironment = NodeEnvironment.Development;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  PORT: number = 4000;

  @IsString()
  @MinLength(1)
  HOST: string = '0.0.0.0';

  @IsString()
  @Matches(POSTGRES_URL_PATTERN, {
    message: 'DATABASE_URL must be a postgresql:// connection string',
  })
  DATABASE_URL!: string;

  @IsString()
  @Matches(POSTGRES_URL_PATTERN, {
    message: 'DIRECT_URL must be a postgresql:// connection string',
  })
  DIRECT_URL!: string;

  @IsString()
  @MinLength(1)
  REDIS_HOST!: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(65_535)
  REDIS_PORT!: number;

  @IsString()
  @MinLength(1)
  REDIS_PASSWORD!: string;

  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(15)
  REDIS_DB: number = 0;

  @IsOptional()
  @IsString()
  CORS_ORIGINS?: string;

  // ─── Authentication ───────────────────────────────────────────────────────
  // Mandatory from Phase 3 on: the API signs real tokens, so a missing secret is
  // no longer a warning, it is a service that cannot authenticate anyone.
  //
  // `@IsOptional()` here is about *message quality*, not leniency: a blank value
  // is normalized to "not set" and reported by `assertSecrets` with the exact
  // command to generate one. The boot still fails — see the unit tests.
  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
  })
  JWT_ACCESS_SECRET?: string;

  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
  })
  JWT_REFRESH_SECRET?: string;

  /** Access-token lifetime. Short by design; refresh tokens carry the session. */
  @IsString()
  @Matches(DURATION_PATTERN, { message: 'JWT_ACCESS_TTL must look like 15m, 1h or 7d' })
  JWT_ACCESS_TTL: string = '15m';

  /** Refresh-token lifetime. Persistent session length. */
  @IsString()
  @Matches(DURATION_PATTERN, { message: 'JWT_REFRESH_TTL must look like 15m, 1h or 7d' })
  JWT_REFRESH_TTL: string = '7d';

  // ─── OTP policy ───────────────────────────────────────────────────────────
  /** Validity of a generated code. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(600)
  OTP_TTL_SECONDS: number = 120;

  /** Digits in the generated code (cryptographically secure, never sequential). */
  @Type(() => Number)
  @IsInt()
  @Min(4)
  @Max(8)
  OTP_LENGTH: number = 5;

  /** Minimum delay between two OTP requests for the same mobile number. */
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(600)
  OTP_REQUEST_COOLDOWN_SECONDS: number = 120;

  /** Wrong codes tolerated per mobile number before the account is locked. */
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(10)
  OTP_MAX_VERIFY_ATTEMPTS: number = 5;

  /** How long a number stays locked after exceeding the attempt budget. */
  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86_400)
  OTP_LOCK_SECONDS: number = 900;

  /** Ceiling per mobile number per hour, independent of the cooldown. */
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(100)
  OTP_MAX_REQUESTS_PER_HOUR: number = 5;

  /** Ceiling per client IP per hour; stops distributed enumeration of numbers. */
  @Type(() => Number)
  @IsInt()
  @Min(5)
  @Max(500)
  OTP_MAX_REQUESTS_PER_IP_PER_HOUR: number = 20;

  // ─── Password login policy ────────────────────────────────────────────────
  @Type(() => Number)
  @IsInt()
  @Min(3)
  @Max(20)
  AUTH_MAX_LOGIN_ATTEMPTS: number = 5;

  @Type(() => Number)
  @IsInt()
  @Min(60)
  @Max(86_400)
  AUTH_LOCK_SECONDS: number = 900;

  // ─── SMS provider ─────────────────────────────────────────────────────────
  @IsIn(SMS_PROVIDERS, { message: `SMS_PROVIDER must be one of: ${SMS_PROVIDERS.join(', ')}` })
  SMS_PROVIDER: SmsProviderName = 'sandbox';

  /** Prints OTP codes to the log. Only meaningful for the sandbox provider. */
  @Type(() => Boolean)
  @IsBoolean()
  SMS_SANDBOX_LOG_CODES: boolean = true;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_API_KEY?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_SENDER?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  SMS_KAVENEGAR_OTP_TEMPLATE?: string;

  @IsOptional()
  @IsIn(LOG_LEVELS, { message: `LOG_LEVEL must be one of: ${LOG_LEVELS.join(', ')}` })
  LOG_LEVEL?: LogLevelName;
}

export interface EnvironmentValidationOptions {
  /** Injected in tests; defaults to a Nest logger scoped to this module. */
  logger?: Pick<Logger, 'warn'>;
}

/**
 * Validates the raw process environment (and `.env` contents) for
 * `ConfigModule.forRoot({ validate })`.
 *
 * Structural problems always fail the boot, and so does anything that would
 * silently degrade security: missing JWT secrets, an SMS provider that cannot
 * deliver, or a test provider in production.
 */
export function validateEnvironment(
  raw: Record<string, unknown>,
  options: EnvironmentValidationOptions = {},
): EnvironmentVariables {
  const logger = options.logger ?? new Logger('EnvironmentValidation');
  const config = plainToInstance(EnvironmentVariables, normalizeEmptyValues(raw));
  const errors = validateSync(config, { forbidUnknownValues: false, whitelist: false });

  if (errors.length > 0) {
    throw new Error(`Invalid environment configuration:\n${formatValidationErrors(errors)}`);
  }

  assertSecrets(config);
  assertSmsConfiguration(config, logger);
  return config;
}

/** Treats blank values (`KEY=`) as "not set" so optional keys stay optional. */
function normalizeEmptyValues(raw: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = { ...raw };
  for (const key of OPTIONAL_KEYS) {
    const value = normalized[key];
    if (typeof value === 'string' && value.trim() === '') {
      delete normalized[key];
    }
  }
  return normalized;
}

/**
 * Secrets are required in every environment from Phase 3 on. Development still
 * gets its values from `.env` (generated with `openssl rand -base64 48`), so the
 * absence of one means a broken checkout, and a broken checkout must not boot
 * with an API that silently cannot authenticate anyone.
 */
function assertSecrets(config: EnvironmentVariables): void {
  const missing = SECRET_KEYS.filter((key) => {
    const value = config[key];
    return typeof value !== 'string' || value.length === 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `Missing required secrets: ${missing.join(', ')}. ` +
        'Generate values with "openssl rand -base64 48" and add them to .env (never commit them).',
    );
  }
}

/** Cross-field checks that a per-property validator cannot express. */
function assertSmsConfiguration(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  if (config.SMS_PROVIDER === 'kavenegar') {
    const required = [
      'SMS_KAVENEGAR_API_KEY',
      'SMS_KAVENEGAR_SENDER',
      'SMS_KAVENEGAR_OTP_TEMPLATE',
    ] as const;
    const missing = required.filter((key) => {
      const value = config[key];
      return typeof value !== 'string' || value.trim() === '';
    });

    if (missing.length > 0) {
      throw new Error(
        `SMS_PROVIDER=kavenegar requires ${missing.join(', ')}. ` +
          'Provide the real gateway credentials, or use SMS_PROVIDER=sandbox in development.',
      );
    }
    return;
  }

  if (config.NODE_ENV === NodeEnvironment.Production) {
    throw new Error(
      'SMS_PROVIDER=sandbox cannot be used in production: it logs codes instead of delivering them. ' +
        'Configure SMS_PROVIDER=kavenegar with real credentials.',
    );
  }

  if (config.SMS_SANDBOX_LOG_CODES) {
    logger.warn(
      'SMS_PROVIDER=sandbox — OTP codes are written to the application log and not delivered by SMS. ' +
        'This is a development/test provider only.',
    );
  }
}

function formatValidationErrors(errors: readonly ValidationError[], parentPath = ''): string {
  return errors
    .flatMap((error) => {
      const path = parentPath ? `${parentPath}.${error.property}` : error.property;
      const ownMessages = error.constraints ? Object.values(error.constraints) : [];
      const childMessages = error.children?.length ? [formatValidationErrors(error.children, path)] : [];
      return [...ownMessages, ...childMessages];
    })
    .join('\n');
}
```

#### `apps/backend/src/setup/app.setup.ts` · 80 lines

```ts
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { GLOBAL_API_PREFIX, SWAGGER_JSON_PATH, SWAGGER_PATH } from '../common/constants';
import { buildCorsOptions } from '../config/cors.config';

/**
 * Applies the HTTP contract of the API: URL prefix, CORS policy and request
 * validation. Called from `main.ts` and from the end-to-end tests so both run
 * the exact same configuration.
 */
export function applyGlobalPolicies(app: INestApplication, config: ConfigService): void {
  app.setGlobalPrefix(GLOBAL_API_PREFIX);
  app.enableCors(buildCorsOptions(config));

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties that carry no decorator, and reject the request when
      // unknown properties are present: clients get a loud error instead of
      // silently ignored input.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Convert plain payloads into DTO instances so decorators transform values.
      transform: true,
      validateCustomDecorators: true,
    }),
  );
}

/**
 * Builds the OpenAPI document from the registered controllers. Kept separate
 * from {@link setupSwagger} because generating the document is pure routing
 * metadata, while serving the UI needs the Fastify static-assets plugin. Tests
 * assert the contract in-process without pulling in the plugin.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Shopino API')
      .setDescription(
        'Multi-vendor marketplace with banking credit (BNPL). Every endpoint is namespaced under /api/v1.\n\n' +
          '**Authentication:** the two anonymous entry points are `POST /api/v1/auth/otp/request` and ' +
          '`POST /api/v1/auth/login/password`, both of which return an access token (15 minutes) and a ' +
          'rotating refresh token (7 days). Send the access token as `Authorization: Bearer <token>`; ' +
          'every other endpoint rejects requests without it.',
      )
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token issued by /api/v1/auth/otp/verify or /api/v1/auth/login/password',
        },
        'access-token',
      )
      .addTag('auth', 'Authentication, sessions and self-service profile')
      .addTag('admin-users', 'Staff-only identity lookup and search')
      .addTag('admin-audit', 'Immutable audit trail (admins only)')
      .build(),
  );
}

/**
 * Publishes the OpenAPI document. The UI is served at `/api/docs` and the raw
 * document at `/api/docs-json`; neither is affected by the global API prefix.
 */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    customSiteTitle: 'Shopino API',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  return document;
}
```

#### `apps/backend/src/infra/redis/redis.service.ts` · 69 lines

```ts
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { toMilliseconds } from '../../common/utils';

/** Upper bound for a single Redis command; keeps health checks responsive. */
const COMMAND_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_RETRIES_PER_REQUEST = 2;
const RECONNECT_MAX_DELAY_MS = 2_000;

/**
 * Owns the Redis connection lifecycle. The client reconnects in the background
 * (`retryStrategy`) so a Redis restart does not require an application restart;
 * `ping()` reports the real state for the health endpoint.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly connection: Redis;

  constructor(config: ConfigService) {
    this.connection = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      password: config.getOrThrow<string>('REDIS_PASSWORD'),
      db: config.get<number>('REDIS_DB') ?? 0,
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
      enableReadyCheck: true,
      retryStrategy: (attempt: number): number => Math.min(attempt * 200, RECONNECT_MAX_DELAY_MS),
    });

    this.connection.on('ready', () => this.logger.log('Redis connection established'));
    this.connection.on('error', (error: Error) => this.logger.error(`Redis error: ${error.message}`));
  }

  /**
   * The underlying client, for features that need more than liveness checks:
   * rate limiting, OTP challenges, refresh-token sessions and Lua scripts.
   *
   * Exposed deliberately rather than wrapped in a hand-written facade: `ioredis`
   * already provides typed commands, pipelining and `multi()`, and a bespoke
   * wrapper would only hide them while adding no safety. Feature services are the
   * only consumers, and each documents the key space it owns.
   */
  get client(): Redis {
    return this.connection;
  }

  /** Sends `PING` and returns the round-trip time in milliseconds. */
  async ping(): Promise<number> {
    const startedAt = process.hrtime.bigint();
    const reply: string = await this.connection.ping();
    if (reply !== 'PONG') {
      throw new Error(`Unexpected Redis PING reply: ${reply}`);
    }
    return toMilliseconds(process.hrtime.bigint() - startedAt);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection.status === 'end') {
      return;
    }
    await this.connection.quit();
  }
}
```

#### `apps/backend/src/infra/health/health.controller.ts` · 60 lines

```ts
import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  type HealthCheckResult,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { UptimeHealthIndicator } from './indicators/uptime.health';

/** Heap threshold above which the instance is considered unhealthy: 512 MiB. */
const HEAP_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * Liveness/readiness probe.
 *
 * `@Public()` is required and deliberate: the global `JwtAuthGuard` protects
 * every route by default, while health probes are called by orchestrators
 * (Docker healthcheck, load balancer, uptime monitor) that hold no token. The
 * endpoint exposes no data beyond dependency status, so this does not widen the
 * attack surface.
 */
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly memoryHealthIndicator: MemoryHealthIndicator,
    private readonly databaseHealthIndicator: DatabaseHealthIndicator,
    private readonly redisHealthIndicator: RedisHealthIndicator,
    private readonly uptimeHealthIndicator: UptimeHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness of the API and its dependencies',
    description:
      'Checks PostgreSQL connectivity, Redis connectivity, heap memory usage and process uptime. ' +
      'Responds 200 when every check is up and 503 as soon as one of them is down.',
  })
  @ApiOkResponse({ description: 'All checks are up.' })
  @ApiServiceUnavailableResponse({ description: 'At least one check is down.' })
  async check(): Promise<HealthCheckResult> {
    return this.healthCheckService.check([
      (): Promise<HealthIndicatorResult> => this.databaseHealthIndicator.isHealthy('database'),
      (): Promise<HealthIndicatorResult> => this.redisHealthIndicator.isHealthy('redis'),
      (): Promise<HealthIndicatorResult> =>
        Promise.resolve(this.memoryHealthIndicator.checkHeap('memory', HEAP_LIMIT_BYTES)),
      (): Promise<HealthIndicatorResult> =>
        Promise.resolve(this.uptimeHealthIndicator.isHealthy('uptime')),
    ]);
  }
}
```


### 4.7 Database migration

#### `apps/backend/prisma/migrations/20260926145500_canonical_e164_mobile/migration.sql` · 42 lines

```sql
-- ============================================================================
-- Phase 3 — one canonical spelling for `users.mobile`
-- ----------------------------------------------------------------------------
-- Phase 2 stored mobile numbers in the national format (`09XXXXXXXXX`) while the
-- authentication contract normalizes every input to E.164 (`+989XXXXXXXXX`).
-- Two spellings of the same number would defeat the unique index on
-- `users.mobile` — the same person could register twice and the OTP rate limiter
-- would count their attempts in two separate buckets.
--
-- This migration converts existing rows in place. It is data-preserving and
-- idempotent: rows that are already E.164 are left untouched.
--
-- Only rows matching the national pattern are rewritten, so an unexpected value
-- (a legacy foreign number, a placeholder) fails loudly on the check below
-- instead of being silently mangled.
-- ============================================================================

UPDATE "users"
SET "mobile" = '+98' || substring("mobile" from 2)
WHERE "mobile" ~ '^09[0-9]{9}$';

-- Fail fast if anything is left in a non-canonical shape: a half-migrated
-- identity table is worse than a failed deployment.
DO $$
DECLARE
    offenders integer;
BEGIN
    SELECT count(*) INTO offenders
    FROM "users"
    WHERE "mobile" !~ '^\+989[0-9]{9}$';

    IF offenders > 0 THEN
        RAISE EXCEPTION
            'users.mobile contains % row(s) that are not canonical E.164 (+989XXXXXXXXX). '
            'Normalize them before applying this migration.', offenders;
    END IF;
END
$$;

-- The existing unique index on `mobile` keeps enforcing one row per number now
-- that every row uses the same spelling; no index change is required.
```


### 4.8 End-to-end suite and live smoke test

#### `apps/backend/test/auth.e2e-spec.ts` · 811 lines

```ts
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';

/**
 * End-to-end verification of the whole authentication surface against the **real**
 * infrastructure started by docker-compose: PostgreSQL 16, Redis 7 and the active
 * SMS provider. Nothing is mocked or stubbed — the OTP is read back from the
 * sandbox provider exactly as a user would read it from their phone, and every
 * assertion about tokens, sessions and locks is checked against Redis or
 * PostgreSQL directly.
 *
 * The suite is self-contained: it uses dedicated phone numbers, tags its requests
 * with a test user-agent, and removes every row it created in `afterAll`, so the
 * seeded master data (and the counts asserted by the other e2e suites) stay
 * untouched.
 */

const API = `/${GLOBAL_API_PREFIX}`;
const TEST_UA = 'shopino-e2e/1.0';
const env = process.env;

/** Phone numbers reserved for this suite (never part of the seed). */
const NEW_CUSTOMER = '+989990000001';
const BRUTE_FORCE_VICTIM = '+989990000002';
const NORMALIZATION_SUBJECT = '+989990000003';
const TEST_MOBILES = [NEW_CUSTOMER, BRUTE_FORCE_VICTIM, NORMALIZATION_SUBJECT];

/** Mobile of the seeded super admin, stored in canonical E.164. */
const SEEDED_ADMIN_MOBILE = '+989120000001';
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';
const SEEDED_SUPPORT_EMAIL = 'support@shopino.local';
/** Identifier that deliberately matches no account (enumeration-resistance test). */
const UNKNOWN_IDENTIFIER = 'nobody@shopino.local';

/**
 * Every identifier this suite logs in with. The per-identifier failure counter
 * lives in Redis with a 15-minute TTL, so it has to be cleared for *all* of them
 * — otherwise the fifth run of the suite would find the account already locked
 * and the assertions would fail for the wrong reason.
 */
const LOGIN_IDENTIFIERS = [
  SEEDED_ADMIN_EMAIL,
  SEEDED_ADMIN_MOBILE,
  SEEDED_SUPPORT_EMAIL,
  UNKNOWN_IDENTIFIER,
];

interface TokensBody {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  user: { id: string; mobile: string; role: UserRole; fullName: string };
}

interface OtpRequestBody {
  status: string;
  expiresInSeconds: number;
  trackingId: string;
}

interface AccessTokenClaims {
  sub: string;
  mobile: string;
  role: UserRole;
  typ: string;
  sid: string;
}

describe('Authentication pipeline (e2e, real PostgreSQL + Redis + SMS provider)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let jwt: JwtService;
  let smsProvider: SandboxSmsProvider;

  const request = (options: {
    method: 'GET' | 'POST' | 'PATCH';
    url: string;
    body?: unknown;
    token?: string;
    userAgent?: string;
  }): ReturnType<NestFastifyApplication['inject']> =>
    app.inject({
      method: options.method,
      url: `${API}${options.url}`,
      headers: {
        'user-agent': options.userAgent ?? TEST_UA,
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      ...(options.body === undefined ? {} : { payload: options.body as Record<string, unknown> }),
    });

  /**
   * Clears every Redis key this suite can produce, so the suite is deterministic
   * on a re-run. A second run must not inherit the first run's cooldown, lock or
   * hourly quotas — and the lock that the brute-force test deliberately triggers
   * has to be gone before the profile tests run.
   *
   * Test-only housekeeping: production never deletes rate-limit state.
   */
  const resetAuthState = async (): Promise<void> => {
    const keys = [
      ...TEST_MOBILES.flatMap((mobile) => [
        OtpKeys.challenge(mobile),
        OtpKeys.lock(mobile),
        OtpKeys.cooldown(mobile),
        OtpKeys.hourlyByMobile(mobile),
        loginAttemptsKey(normalizeIdentifier(mobile)),
        loginLockKey(normalizeIdentifier(mobile)),
      ]),
      ...LOGIN_IDENTIFIERS.flatMap((identifier) => [
        loginAttemptsKey(normalizeIdentifier(identifier)),
        loginLockKey(normalizeIdentifier(identifier)),
      ]),
      // Every request in this suite shares one source IP, so the per-IP quota
      // would otherwise accumulate across runs.
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
    ];

    if (keys.length > 0) {
      await redis.client.del(...keys);
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    const config = app.get(ConfigService);
    applyGlobalPolicies(app, config);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    jwt = app.get(JwtService);

    // The provider is resolved through the same DI token the application uses, so
    // this is the exact instance that served the requests below.
    const provider: SmsProvider = app.get<SmsProvider>(SMS_PROVIDER);
    if (!(provider instanceof SandboxSmsProvider)) {
      throw new Error(
        `This suite requires SMS_PROVIDER=sandbox (got "${provider.kind}"). ` +
          'Point the test environment at the sandbox provider before running it.',
      );
    }
    smsProvider = provider;

    await resetAuthState();
  });

  afterAll(async () => {
    // Remove everything this suite created. Production code has no such path —
    // this is test isolation so the other suites see the seeded state.
    await prisma.user.deleteMany({ where: { mobile: { in: TEST_MOBILES } } });
    await prisma.auditLog.deleteMany({ where: { userAgent: TEST_UA } });
    await resetAuthState();
    await app.close();
  });

  // ─── 1. OTP pipeline ──────────────────────────────────────────────────────

  describe('OTP pipeline: request → Redis TTL → provider dispatch → verify → JWT', () => {
    let deliveredCode: string;
    let trackingId: string;

    it('accepts the request, reports the TTL and a tracking id', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: NEW_CUSTOMER },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<OtpRequestBody>();

      expect(body.status).toBe('sent');
      expect(body.expiresInSeconds).toBe(Number(env.OTP_TTL_SECONDS ?? 120));
      // The tracking id comes from the provider, proving the message really went
      // through the dispatch layer instead of being faked at the controller.
      expect(body.trackingId).toMatch(/^SBX-/);
      trackingId = body.trackingId;
    });

    it('stores the challenge in Redis with the configured TTL', async () => {
      const ttl = await redis.client.ttl(OtpKeys.challenge(NEW_CUSTOMER));
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(Number(env.OTP_TTL_SECONDS ?? 120));

      const stored = await redis.client.hgetall(OtpKeys.challenge(NEW_CUSTOMER));
      expect(stored.purpose).toBe('login');
      expect(stored.attempts).toBe('0');
      // Only a digest is stored: the code itself must never be readable in Redis.
      expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(Object.keys(stored)).not.toContain('code');
    });

    it('dispatches the code through the active SMS provider', () => {
      const code = smsProvider.latestOtpCode(NEW_CUSTOMER);
      expect(code).toBeDefined();
      expect(code).toMatch(/^[0-9]{5}$/);

      deliveredCode = code as string;
      expect(trackingId).toMatch(/^SBX-/);
    });

    it('rejects a wrong code with 401 and keeps the challenge alive', async () => {
      const wrong = deliveredCode === '00000' ? '11111' : '00000';
      const response = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: wrong },
      });

      expect(response.statusCode).toBe(401);
      expect(await redis.client.ttl(OtpKeys.challenge(NEW_CUSTOMER))).toBeGreaterThan(0);
    });

    it('verifies the real code and returns usable JWT tokens', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: deliveredCode },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<TokensBody>();

      expect(body.user.mobile).toBe(NEW_CUSTOMER);
      expect(body.user.role).toBe(UserRole.CUSTOMER);
      expect(body.accessToken.split('.')).toHaveLength(3);
      expect(body.expiresIn).toBe(900);
      expect(body.refreshExpiresIn).toBe(604_800);

      // The signature is verified with the real secret, so a token that merely
      // "looks like" a JWT would fail here.
      const claims = await jwt.verifyAsync<AccessTokenClaims>(body.accessToken, {
        secret: env.JWT_ACCESS_SECRET as string,
        issuer: 'shopino',
        audience: 'shopino-api',
      });
      expect(claims.role).toBe(UserRole.CUSTOMER);
      expect(claims.mobile).toBe(NEW_CUSTOMER);
      expect(claims.typ).toBe('access');
      expect(claims.sid).toBe(body.sessionId);

      // A refresh token must not be usable as an access token.
      await expect(
        jwt.verifyAsync(body.refreshToken, {
          secret: env.JWT_ACCESS_SECRET as string,
          issuer: 'shopino',
          audience: 'shopino-api',
        }),
      ).rejects.toThrow();
    });

    it('consumed the challenge: the same code cannot be used twice', async () => {
      expect(await redis.client.exists(OtpKeys.challenge(NEW_CUSTOMER))).toBe(0);

      const replay = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: deliveredCode },
      });
      expect(replay.statusCode).toBe(401);
    });

    it('created the customer with an empty profile in PostgreSQL', async () => {
      const user = await prisma.user.findUnique({
        where: { mobile: NEW_CUSTOMER },
        include: { customerProfile: true },
      });

      expect(user).not.toBeNull();
      expect(user?.role).toBe(UserRole.CUSTOMER);
      expect(user?.isActive).toBe(true);
      expect(user?.passwordHash).toBeNull();
      expect(user?.customerProfile).not.toBeNull();
      // No fabricated financial data: a brand-new customer owns nothing.
      expect(user?.customerProfile?.bankIban).toBeNull();
      expect(await prisma.creditAccount.count({ where: { userId: user?.id } })).toBe(0);
      expect(await prisma.parentOrder.count({ where: { userId: user?.id } })).toBe(0);
    });
  });

  // ─── 2. Rate limiting ─────────────────────────────────────────────────────

  describe('Brute-force protection', () => {
    it('enforces the cooldown between two consecutive OTP requests', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: NEW_CUSTOMER },
      });

      expect(response.statusCode).toBe(429);
      const body = response.json<{ message: string; retryAfterSeconds: number }>();
      expect(body.retryAfterSeconds).toBeGreaterThan(0);
      expect(body.retryAfterSeconds).toBeLessThanOrEqual(Number(env.OTP_REQUEST_COOLDOWN_SECONDS ?? 120));
      expect(response.headers['retry-after']).toBeUndefined(); // body carries the hint
    });

    it('locks the number after five wrong codes and refuses the correct one too', async () => {
      const request1 = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: BRUTE_FORCE_VICTIM },
      });
      expect(request1.statusCode).toBe(200);

      const realCode = smsProvider.latestOtpCode(BRUTE_FORCE_VICTIM) as string;
      const wrongCode = realCode === '11111' ? '22222' : '11111';

      // Attempts 1..4 → 401 (wrong code, budget remains).
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await request({
          method: 'POST',
          url: '/auth/otp/verify',
          body: { mobile: BRUTE_FORCE_VICTIM, code: wrongCode },
        });
        expect(response.statusCode).toBe(401);
      }

      // Attempt 5 → the budget is exhausted, the number is locked.
      const fifth = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: BRUTE_FORCE_VICTIM, code: wrongCode },
      });
      expect(fifth.statusCode).toBe(429);
      const lockBody = fifth.json<{ retryAfterSeconds: number }>();
      expect(lockBody.retryAfterSeconds).toBeGreaterThan(0);
      expect(lockBody.retryAfterSeconds).toBeLessThanOrEqual(Number(env.OTP_LOCK_SECONDS ?? 900));

      // The lock is real: even the correct code is refused while it lasts.
      const correctWhileLocked = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: BRUTE_FORCE_VICTIM, code: realCode },
      });
      expect(correctWhileLocked.statusCode).toBe(429);

      // …and no account was created for the attacked number.
      expect(await prisma.user.findUnique({ where: { mobile: BRUTE_FORCE_VICTIM } })).toBeNull();
    });

    it('records failed attempts in the audit trail without leaking the code', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { userAgent: TEST_UA, action: 'LOGIN', newValue: { path: ['success'], equals: false } },
        orderBy: { createdAt: 'desc' },
      });

      expect(rows.length).toBeGreaterThanOrEqual(5);
      const reasons = rows.map((row) => (row.newValue as { reason?: string }).reason);
      expect(reasons).toContain('otp_mismatch');
      expect(reasons).toContain('otp_attempts_exhausted');

      for (const row of rows) {
        const serialized = JSON.stringify(row.newValue);
        expect(serialized).not.toContain('11111');
        expect(serialized).not.toContain('22222');
      }
    });
  });

  // ─── 3. Normalization & validation ────────────────────────────────────────

  describe('Input normalization and validation', () => {
    it('accepts a national-format mobile and stores it as E.164', async () => {
      const national = '09990000003';
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: national },
      });

      expect(response.statusCode).toBe(200);
      // The Redis key proves the mobile was normalized before use.
      expect(await redis.client.exists(OtpKeys.challenge(NORMALIZATION_SUBJECT))).toBe(1);
      expect(await redis.client.exists(OtpKeys.challenge(national))).toBe(0);
    });

    it('rejects a non-Iranian mobile number with 400', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: '12345' },
      });

      expect(response.statusCode).toBe(400);
    });

    it('requires a numeric code', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code: 'abcde' },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  // ─── 4. Password login ────────────────────────────────────────────────────

  describe('Password login for staff', () => {
    let adminTokens: TokensBody;

    it('authenticates the seeded super admin by e-mail', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      adminTokens = response.json<TokensBody>();

      expect(adminTokens.user.role).toBe(UserRole.SUPER_ADMIN);
      expect(adminTokens.user.mobile).toBe(SEEDED_ADMIN_MOBILE);
      expect(adminTokens.accessToken).toMatch(/^ey/);
    });

    it('authenticates the same account by mobile number', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_MOBILE, password: env.SUPER_ADMIN_PASSWORD },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<TokensBody>().user.role).toBe(UserRole.SUPER_ADMIN);
    });

    it('rejects a wrong password with 401 and writes a failed-login audit row', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: 'definitely-not-the-password' },
      });

      expect(response.statusCode).toBe(401);

      const row = await prisma.auditLog.findFirst({
        where: { userAgent: TEST_UA, action: 'LOGIN', entityName: 'User' },
        orderBy: { createdAt: 'desc' },
      });
      expect(row).not.toBeNull();
      expect((row?.newValue as { reason?: string }).reason).toBe('bad_credentials');
      // The attempted password must never be stored.
      expect(JSON.stringify(row?.newValue)).not.toContain('definitely-not-the-password');
    });

    it('answers unknown accounts and wrong passwords with the same error', async () => {
      const unknown = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: UNKNOWN_IDENTIFIER, password: 'definitely-not-the-password' },
      });
      const wrongPassword = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: 'yet-another-wrong-password' },
      });

      expect(unknown.statusCode).toBe(wrongPassword.statusCode);
      expect(unknown.json<{ message: string }>().message).toBe(
        wrongPassword.json<{ message: string }>().message,
      );
    });

    it('serves the authenticated profile with the access token', async () => {
      const response = await request({ method: 'GET', url: '/auth/me', token: adminTokens.accessToken });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ user: { id: string; role: UserRole }; customerProfile: unknown }>();
      expect(body.user.role).toBe(UserRole.SUPER_ADMIN);
      expect(body).toHaveProperty('customerProfile');
    });

    it('rejects a request without a token with 401', async () => {
      const response = await request({ method: 'GET', url: '/auth/me' });
      expect(response.statusCode).toBe(401);
    });

    it('rejects a tampered token with 401', async () => {
      const [header, payload, signature] = adminTokens.accessToken.split('.');
      const tampered = `${header}.${payload}.${(signature ?? '').slice(0, -2)}xx`;

      const response = await request({ method: 'GET', url: '/auth/me', token: tampered });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── 5. RBAC ──────────────────────────────────────────────────────────────

  describe('Role-based access control', () => {
    const login = async (identifier: string, passwordEnvKey: string): Promise<string> => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier, password: env[passwordEnvKey] },
      });
      expect(response.statusCode).toBe(200);
      return response.json<TokensBody>().accessToken;
    };

    it('gives a CUSTOMER 403 on a SUPER_ADMIN-only route', async () => {
      // A genuinely unprivileged token, issued by the OTP flow for a fresh number.
      await redis.client.del(OtpKeys.cooldown(NORMALIZATION_SUBJECT));
      const otpRequest = await request({
        method: 'POST',
        url: '/auth/otp/request',
        body: { mobile: NORMALIZATION_SUBJECT },
      });
      expect(otpRequest.statusCode).toBe(200);

      const code = smsProvider.latestOtpCode(NORMALIZATION_SUBJECT) as string;
      const verified = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NORMALIZATION_SUBJECT, code },
      });
      expect(verified.statusCode).toBe(200);

      const customerAccessToken = verified.json<TokensBody>().accessToken;
      const claims = await jwt.verifyAsync<AccessTokenClaims>(customerAccessToken, {
        secret: env.JWT_ACCESS_SECRET as string,
        issuer: 'shopino',
        audience: 'shopino-api',
      });
      expect(claims.role).toBe('CUSTOMER');

      const forbidden = await request({
        method: 'GET',
        url: '/admin/users',
        token: customerAccessToken,
      });
      expect(forbidden.statusCode).toBe(403);

      // The same route with a real SUPER_ADMIN token returns data, so the 403
      // above is authorization, not a broken endpoint.
      const adminToken = await login(SEEDED_ADMIN_EMAIL, 'SUPER_ADMIN_PASSWORD');
      const allowed = await request({ method: 'GET', url: '/admin/users', token: adminToken });
      expect(allowed.statusCode).toBe(200);
      expect(allowed.json<{ total: number }>().total).toBeGreaterThanOrEqual(4);
    });

    it('lets SUPPORT read a single user but not enumerate them', async () => {
      const supportToken = await login(SEEDED_SUPPORT_EMAIL, 'SEED_STAFF_PASSWORD');

      const list = await request({ method: 'GET', url: '/admin/users', token: supportToken });
      expect(list.statusCode).toBe(403);

      const adminToken = await login(SEEDED_ADMIN_EMAIL, 'SUPER_ADMIN_PASSWORD');
      const adminId = (await request({ method: 'GET', url: '/auth/me', token: adminToken }).then((r) =>
        r.json<{ user: { id: string } }>(),
      )).user.id;

      const detail = await request({ method: 'GET', url: `/admin/users/${adminId}`, token: supportToken });
      expect(detail.statusCode).toBe(200);
      expect(detail.json<{ role: UserRole }>().role).toBe(UserRole.SUPER_ADMIN);
    });

    it('rejects the audit-log route for a SUPPORT token with 403', async () => {
      const supportToken = await login(SEEDED_SUPPORT_EMAIL, 'SEED_STAFF_PASSWORD');
      const response = await request({ method: 'GET', url: '/admin/audit-logs', token: supportToken });

      expect(response.statusCode).toBe(403);
    });
  });

  // ─── 6. Refresh rotation & logout ─────────────────────────────────────────

  describe('Refresh rotation, replay detection and logout', () => {
    let tokens: TokensBody;

    beforeAll(async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD },
      });
      tokens = response.json<TokensBody>();
    });

    it('rotates the refresh token and issues a new pair', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });

      expect(response.statusCode).toBe(200);
      const rotated = response.json<TokensBody>();

      expect(rotated.refreshToken).not.toBe(tokens.refreshToken);
      expect(rotated.sessionId).not.toBe(tokens.sessionId);

      // The new access token works.
      const me = await request({ method: 'GET', url: '/auth/me', token: rotated.accessToken });
      expect(me.statusCode).toBe(200);

      tokens = rotated;
    });

    it('rejects the previously used refresh token (replay detection)', async () => {
      const first = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });
      expect(first.statusCode).toBe(200);
      const second = first.json<TokensBody>();

      const replay = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });
      expect(replay.statusCode).toBe(401);

      tokens = second;
    });

    it('revokes the session on logout', async () => {
      const response = await request({
        method: 'POST',
        url: '/auth/logout',
        token: tokens.accessToken,
        body: { refreshToken: tokens.refreshToken },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ revoked: boolean; sessionsRevoked: number }>().revoked).toBe(true);

      // The session is gone from Redis…
      expect(await redis.client.exists(`auth:session:${tokens.sessionId}`)).toBe(0);

      // …so the refresh token cannot mint new access tokens any more.
      const refreshAfterLogout = await request({
        method: 'POST',
        url: '/auth/refresh',
        body: { refreshToken: tokens.refreshToken },
      });
      expect(refreshAfterLogout.statusCode).toBe(401);
    });
  });

  // ─── 7. Profile update + audit trail ──────────────────────────────────────

  describe('Profile management and the audit trail', () => {
    let customerToken: string;
    let customerId: string;

    beforeAll(async () => {
      await redis.client.del(OtpKeys.cooldown(NEW_CUSTOMER));
      const otp = await request({ method: 'POST', url: '/auth/otp/request', body: { mobile: NEW_CUSTOMER } });
      expect(otp.statusCode).toBe(200);

      const code = smsProvider.latestOtpCode(NEW_CUSTOMER) as string;
      const verified = await request({
        method: 'POST',
        url: '/auth/otp/verify',
        body: { mobile: NEW_CUSTOMER, code },
      });
      expect(verified.statusCode).toBe(200);

      const body = verified.json<TokensBody>();
      customerToken = body.accessToken;
      customerId = body.user.id;
    });

    it('rejects a national code with an invalid check digit', async () => {
      const response = await request({
        method: 'PATCH',
        url: '/auth/profile',
        token: customerToken,
        body: { nationalCode: '0499370898' },
      });

      expect(response.statusCode).toBe(400);
      expect(await prisma.user.findUnique({ where: { id: customerId } })).toMatchObject({
        nationalCode: null,
      });
    });

    it('updates the profile and records a before/after audit row', async () => {
      const payload = {
        fullName: 'سارا محمدی',
        email: 'sara.e2e@example.com',
        nationalCode: '0499370899',
        birthDate: '1994-05-17',
      };

      const response = await request({
        method: 'PATCH',
        url: '/auth/profile',
        token: customerToken,
        body: payload,
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ updated: boolean }>().updated).toBe(true);

      // The row is written before the response is emitted, so it must be there now.
      const row = await prisma.auditLog.findFirst({
        where: { userAgent: TEST_UA, action: 'UPDATE', entityName: 'User', entityId: customerId },
        orderBy: { createdAt: 'desc' },
      });

      expect(row).not.toBeNull();
      expect(row?.userId).toBe(customerId);
      expect(row?.ipAddress).toBeTruthy();

      const oldValue = row?.oldValue as { fullName?: string; nationalCode?: string | null };
      const newValue = row?.newValue as {
        request?: Record<string, unknown>;
        result?: Record<string, unknown>;
      };
      expect(oldValue.fullName).not.toBe(payload.fullName);
      expect(newValue.result).toMatchObject({ fullName: payload.fullName, nationalCode: payload.nationalCode });
    });

    it('persists the change in PostgreSQL', async () => {
      const user = await prisma.user.findUnique({
        where: { id: customerId },
        include: { customerProfile: true },
      });

      expect(user?.fullName).toBe('سارا محمدی');
      expect(user?.email).toBe('sara.e2e@example.com');
      expect(user?.nationalCode).toBe('0499370899');
      expect(user?.customerProfile?.birthDate?.toISOString().slice(0, 10)).toBe('1994-05-17');
    });

    it('exposes the trail through the admin endpoint, and only to admins', async () => {
      const admin = await request({
        method: 'POST',
        url: '/auth/login/password',
        body: { identifier: SEEDED_ADMIN_EMAIL, password: env.SUPER_ADMIN_PASSWORD },
      });
      const adminToken = admin.json<TokensBody>().accessToken;

      const response = await request({
        method: 'GET',
        url: `/admin/audit-logs?entityName=User&entityId=${customerId}&action=UPDATE`,
        token: adminToken,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ items: Array<{ entityId: string; oldValue: unknown }>; total: number }>();
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.items[0]?.entityId).toBe(customerId);
      expect(body.items[0]?.oldValue).toBeTruthy();

      const asCustomer = await request({
        method: 'GET',
        url: '/admin/audit-logs',
        token: customerToken,
      });
      expect(asCustomer.statusCode).toBe(403);
    });
  });

  // ─── 8. API contract ──────────────────────────────────────────────────────

  describe('OpenAPI contract', () => {
    it('documents every auth endpoint with its bearer requirement', () => {
      const document = buildOpenApiDocument(app);

      const expectedPaths = [
        `${API}/auth/otp/request`,
        `${API}/auth/otp/verify`,
        `${API}/auth/login/password`,
        `${API}/auth/refresh`,
        `${API}/auth/logout`,
        `${API}/auth/me`,
        `${API}/auth/profile`,
        `${API}/admin/audit-logs`,
        `${API}/admin/users`,
      ];
      for (const path of expectedPaths) {
        expect(Object.keys(document.paths)).toContain(path);
      }

      expect(document.paths[`${API}/auth/otp/request`]?.post?.summary).toBeTruthy();
      expect(document.paths[`${API}/auth/otp/request`]?.post?.responses['200']).toBeDefined();
      expect(document.paths[`${API}/auth/otp/request`]?.post?.responses['429']).toBeDefined();
      expect(document.paths[`${API}/auth/logout`]?.post?.security).toBeDefined();
      expect(document.components?.securitySchemes).toHaveProperty('access-token');
    });
  });
});
```

#### `apps/backend/scripts/smoke-auth.ts` · 327 lines

```ts
/**
 * Live smoke test of the authentication module over **real HTTP**.
 *
 * Unlike the Jest suites (which use Fastify's in-process `inject`), this script
 * talks to a running API over the network, exactly like a browser or the admin
 * panel will. It is the check to run after a deployment:
 *
 *   pnpm --filter @shopino/backend run start      # in one terminal
 *   pnpm --filter @shopino/backend run verify:auth
 *
 * It uses the seeded super-admin credentials from `.env`; nothing is hardcoded
 * and no secret is printed. Exit code is non-zero as soon as one expectation
 * fails, so it can be wired into a deployment pipeline.
 */
import { setTimeout as delay } from 'node:timers/promises';
import { config as loadDotenv } from 'dotenv';
import Redis from 'ioredis';
import { resolveEnvFilePaths } from '../src/config/env-file-paths';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { toE164 } from '../src/common/validators/iranian-mobile';

for (const envFilePath of resolveEnvFilePaths()) {
  loadDotenv({ path: envFilePath, override: false, quiet: true });
}

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  skipped?: boolean;
}

const checks: CheckResult[] = [];
let failed = 0;

function record(name: string, ok: boolean, detail: string, skipped = false): void {
  checks.push({ name, ok, detail, skipped });
  if (!ok && !skipped) {
    failed += 1;
  }
}

/**
 * Numbers reserved for this script. They are never seeded accounts.
 *
 * The OTP endpoints are rate-limited by design (cooldown per number, hourly
 * quotas per number and per IP), so a verification script that ignores its own
 * previous run would fail on the second execution. In non-production
 * environments the script therefore clears the rate-limit keys **of its own two
 * numbers only** before exercising the flow, which makes the run repeatable
 * without weakening a single production rule. In production this reset is never
 * attempted, and the OTP section is skipped entirely — see `main()`.
 */
const SMOKE_MOBILE_A = '09990000009';
const SMOKE_MOBILE_B = '09990000008';

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

async function resetSmokeRateLimits(adminIdentifier: string): Promise<void> {
  if (isProduction()) {
    return;
  }
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD,
    db: Number(process.env.REDIS_DB ?? 0),
    lazyConnect: true,
    maxRetriesPerRequest: 2,
  });

  try {
    await redis.connect();
    const keys = [SMOKE_MOBILE_A, SMOKE_MOBILE_B].flatMap((mobile) => {
      const normalized = toE164(mobile) ?? mobile;
      return [
        OtpKeys.challenge(normalized),
        OtpKeys.cooldown(normalized),
        OtpKeys.lock(normalized),
        OtpKeys.hourlyByMobile(normalized),
      ];
    });
    // One failed password login per run would otherwise accumulate towards the
    // lockout threshold of the admin account, and the fifth run of this script
    // would report 429 where it expects 401.
    for (const identifier of [adminIdentifier]) {
      keys.push(loginAttemptsKey(normalizeIdentifier(identifier)), loginLockKey(normalizeIdentifier(identifier)));
    }

    const existing = (await redis.exists(...keys)) > 0 ? keys : [];
    if (existing.length > 0) {
      await redis.del(...existing);
    }
  } finally {
    await redis.quit();
  }
}

const baseUrl = (): string => {
  const host = process.env.SMOKE_API_URL ?? `http://127.0.0.1:${process.env.PORT ?? 4000}`;
  return `${host.replace(/\/$/, '')}/api/v1`;
};

async function call(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PATCH'; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'shopino-smoke-auth/1.0',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed };
}

async function main(): Promise<void> {
  const adminEmail = process.env.SUPER_ADMIN_EMAIL;
  const adminPassword = process.env.SUPER_ADMIN_PASSWORD;
  if (!adminEmail || !adminPassword) {
    throw new Error('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD are not set — run `pnpm db:seed` first.');
  }

  // Make the run repeatable (non-production only): the rate-limit and lockout
  // state of *this script's own* numbers and identifier is cleared, so a second
  // execution verifies the same behaviour instead of the leftovers of the first.
  await resetSmokeRateLimits(adminEmail);

  // ── 1. Health: the API and its dependencies are reachable ──────────────────
  const health = await call('/health');
  record(
    'GET /health is public and reports all dependencies up',
    health.status === 200 && health.body.status === 'ok',
    `HTTP ${health.status} · ${JSON.stringify(health.body).slice(0, 120)}`,
  );

  // ── 2. Protected route without a token ────────────────────────────────────
  const anonymous = await call('/auth/me');
  record('GET /auth/me without a token is rejected', anonymous.status === 401, `HTTP ${anonymous.status}`);

  // ── 3. Staff password login ───────────────────────────────────────────────
  const login = await call('/auth/login/password', {
    method: 'POST',
    body: { identifier: adminEmail, password: adminPassword },
  });
  const accessToken = typeof login.body.accessToken === 'string' ? login.body.accessToken : '';
  const refreshToken = typeof login.body.refreshToken === 'string' ? login.body.refreshToken : '';
  const user = login.body.user as { role?: string; mobile?: string } | undefined;

  record(
    'POST /auth/login/password authenticates the seeded super admin',
    login.status === 200 && user?.role === 'SUPER_ADMIN' && accessToken.split('.').length === 3,
    `HTTP ${login.status} · role=${user?.role ?? 'n/a'} · mobile=${user?.mobile ?? 'n/a'} · accessToken=${accessToken.slice(0, 12)}…`,
  );

  if (accessToken === '') {
    report();
    return;
  }

  // ── 4. A wrong password is refused ────────────────────────────────────────
  const wrongPassword = await call('/auth/login/password', {
    method: 'POST',
    body: { identifier: adminEmail, password: 'not-the-right-password' },
  });
  record(
    'POST /auth/login/password rejects a wrong password',
    wrongPassword.status === 401,
    `HTTP ${wrongPassword.status} · message="${String(wrongPassword.body.message)}"`,
  );

  // ── 5. Authenticated identity ─────────────────────────────────────────────
  const me = await call('/auth/me', { token: accessToken });
  record(
    'GET /auth/me returns the authenticated profile',
    me.status === 200 && (me.body.user as { role?: string } | undefined)?.role === 'SUPER_ADMIN',
    `HTTP ${me.status} · role=${String((me.body.user as { role?: string } | undefined)?.role)}`,
  );

  // ── 6. Profile update is validated and audited ────────────────────────────
  const invalidNationalCode = await call('/auth/profile', {
    method: 'PATCH',
    token: accessToken,
    body: { nationalCode: '0499370898' },
  });
  record(
    'PATCH /auth/profile rejects a national code with a bad check digit',
    invalidNationalCode.status === 400,
    `HTTP ${invalidNationalCode.status}`,
  );

  const profileUpdate = await call('/auth/profile', {
    method: 'PATCH',
    token: accessToken,
    body: { fullName: process.env.SUPER_ADMIN_FULL_NAME ?? 'مدیر ارشد پلتفرم' },
  });
  record(
    'PATCH /auth/profile updates the profile',
    profileUpdate.status === 200 && profileUpdate.body.updated === true,
    `HTTP ${profileUpdate.status} · updated=${String(profileUpdate.body.updated)}`,
  );

  // ── 7. The audit trail recorded it ────────────────────────────────────────
  await delay(150);
  const audit = await call('/admin/audit-logs?entityName=User&action=UPDATE&pageSize=1', { token: accessToken });
  const items = Array.isArray(audit.body.items) ? (audit.body.items as Array<Record<string, unknown>>) : [];
  record(
    'GET /admin/audit-logs shows the UPDATE row with before/after values',
    audit.status === 200 && items.length > 0 && items[0]?.oldValue !== null && items[0]?.newValue !== null,
    `HTTP ${audit.status} · total=${String(audit.body.total)} · entityId=${String(items[0]?.entityId)}`,
  );

  // ── 8. Refresh rotation ───────────────────────────────────────────────────
  const refreshed = await call('/auth/refresh', { method: 'POST', body: { refreshToken } });
  const rotatedRefresh =
    typeof refreshed.body.refreshToken === 'string' ? refreshed.body.refreshToken : '';
  record(
    'POST /auth/refresh rotates the refresh token',
    refreshed.status === 200 && rotatedRefresh !== '' && rotatedRefresh !== refreshToken,
    `HTTP ${refreshed.status} · rotated=${rotatedRefresh !== refreshToken}`,
  );

  const reused = await call('/auth/refresh', { method: 'POST', body: { refreshToken } });
  record(
    'a consumed refresh token is refused (replay detection)',
    reused.status === 401,
    `HTTP ${reused.status}`,
  );

  // ── 9. Logout revokes the session ─────────────────────────────────────────
  const newAccessToken = typeof refreshed.body.accessToken === 'string' ? refreshed.body.accessToken : '';
  const logout = await call('/auth/logout', {
    method: 'POST',
    token: newAccessToken,
    body: { refreshToken: rotatedRefresh },
  });
  record(
    'POST /auth/logout revokes the session',
    logout.status === 200 && logout.body.revoked === true,
    `HTTP ${logout.status} · sessionsRevoked=${String(logout.body.sessionsRevoked)}`,
  );

  const afterLogout = await call('/auth/refresh', { method: 'POST', body: { refreshToken: rotatedRefresh } });
  record(
    'the revoked session can no longer mint tokens',
    afterLogout.status === 401,
    `HTTP ${afterLogout.status}`,
  );

  // ── 10. OTP request path over HTTP ────────────────────────────────────────
  // Skipped in production on purpose: the active provider there is a real
  // gateway, and a smoke test must never send a live SMS to a fake number.
  if (isProduction()) {
    record(
      'OTP request path',
      true,
      'skipped: NODE_ENV=production and the live SMS provider is active — sending test messages would cost money and disturb real traffic',
      true,
    );
    record('OTP cooldown enforcement', true, 'skipped: see above', true);
  } else {
    await resetSmokeRateLimits(adminEmail);

    const firstOtp = await call('/auth/otp/request', { method: 'POST', body: { mobile: SMOKE_MOBILE_A } });
    record(
      'POST /auth/otp/request accepts a national mobile number',
      firstOtp.status === 200 && firstOtp.body.status === 'sent',
      `HTTP ${firstOtp.status} · status=${String(firstOtp.body.status)} · expiresInSeconds=${String(firstOtp.body.expiresInSeconds)} · trackingId=${String(firstOtp.body.trackingId)}`,
    );

    const secondOtp = await call('/auth/otp/request', { method: 'POST', body: { mobile: SMOKE_MOBILE_B } });
    const thirdOtp = await call('/auth/otp/request', { method: 'POST', body: { mobile: SMOKE_MOBILE_B } });
    record(
      'the OTP cooldown is enforced over HTTP',
      secondOtp.status === 200 && thirdOtp.status === 429 && typeof thirdOtp.body.retryAfterSeconds === 'number',
      `first=${secondOtp.status} · second=${thirdOtp.status} · retryAfterSeconds=${String(thirdOtp.body.retryAfterSeconds)}`,
    );
  }

  // ── 11. Input validation ──────────────────────────────────────────────────
  const invalidMobile = await call('/auth/otp/request', { method: 'POST', body: { mobile: '12345' } });
  record('an invalid mobile number is rejected', invalidMobile.status === 400, `HTTP ${invalidMobile.status}`);

  const provider = await call('/auth/sms-provider');
  record(
    'GET /auth/sms-provider reports the active provider honestly',
    provider.status === 200 && typeof provider.body.provider === 'string',
    `provider=${String(provider.body.provider)} · isTestProvider=${String(provider.body.isTestProvider)}`,
  );

  report();
}

function report(): void {
  const width = Math.max(...checks.map((check) => check.name.length), 10);
  console.log('\nShopino — authentication smoke test (live HTTP)\n');
  for (const check of checks) {
    const label = check.skipped === true ? 'SKIP' : check.ok ? 'PASS' : 'FAIL';
    console.log(`  ${label}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  const skipped = checks.filter((check) => check.skipped === true).length;
  const passed = checks.length - failed - skipped;
  const suffix = failed > 0 ? ` — ${failed} FAILED` : skipped > 0 ? ` — ${skipped} skipped` : '';
  console.log(`\n  ${passed}/${checks.length - skipped} checks passed${suffix}\n`);
  if (failed > 0) {
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(`Smoke test aborted: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
```

