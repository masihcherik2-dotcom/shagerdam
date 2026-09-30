# Shopino — Phase 1 deliverable: complete file inventory

Snapshot taken: 2026-09-26 12:51 UTC  
Produced by: AI Software Developer (automated snapshot of the working tree)

Compliant with the approved architectural decisions: pnpm 9.x workspaces · Strategy B persistence (`docker-compose.yml` + `docker-compose.override.yml`) · Prisma migrations as source of truth · deterministic idempotent seed.

**Deliberately excluded:** `.env` (real development secrets, git-ignored), `.docker-data/` (live database files), `node_modules/`, build output (`dist/`, `.next/`), caches (`.turbo/`, `coverage/`, `*.tsbuildinfo`), and `pnpm-lock.yaml` (present in the tree — it pins the exact resolved versions, ~10k lines).

---

## 1. File tree

```text
shopino/
apps/
  backend/
    prisma/
      migrations/
        20260926124703_init/
          migration.sql
        migration_lock.toml
      schema.prisma
      seed.ts
    scripts/
      smoke-http.ts
      verify-connections.ts
      verify-seed.ts
    src/
      common/
        constants.ts
        utils.ts
      config/
        cors.config.ts
        env-file-paths.ts
        env.validation.spec.ts
        env.validation.ts
        logger.config.ts
      infra/
        health/
          indicators/
            database.health.ts
            redis.health.ts
            uptime.health.ts
          health.controller.ts
          health.module.ts
        prisma/
          prisma.module.ts
          prisma.service.ts
        redis/
          redis.module.ts
          redis.service.ts
        security/
          password.spec.ts
          password.ts
      setup/
        app.setup.ts
      app.module.ts
      main.ts
    test/
      health.e2e-spec.ts
      jest-e2e.json
      seed.e2e-spec.ts
      setup-env.ts
    eslint.config.mjs
    jest.config.js
    nest-cli.json
    package.json
    tsconfig.build.json
    tsconfig.json
  frontend/
    src/
      app/
        globals.css
        layout.tsx
        page.tsx
      components/
        system-health-panel.tsx
      lib/
        api/
          client.ts
          errors.test.ts
          errors.ts
          health.server.ts
          health.ts
        env.ts
    eslint.config.mjs
    next.config.ts
    package.json
    postcss.config.mjs
    tsconfig.json
    vitest.config.ts
docs/
  phase-1-verification.md
packages/
  config/
    tsconfig/
      base.json
      nest.json
      next.json
    package.json
scripts/
  prepare-dev-data-dirs.sh
.editorconfig
.env.example
.gitignore
.npmrc
docker-compose.override.yml
docker-compose.yml
package.json
pnpm-workspace.yaml
README.md
turbo.json
```


Files: **70**

---

## 2. Complete file contents


### `.editorconfig`

```
root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false

[*.{yml,yaml}]
indent_size = 2

[docker-compose.yml]
indent_size = 2
```


### `.env.example`

```ini
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
# REQUIRED IN PRODUCTION: the API refuses to start when either secret is empty
# while NODE_ENV=production. In development a warning is logged instead.
# Generate with:  openssl rand -base64 48
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=

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
```


### `.gitignore`

```
# Dependencies
node_modules/

# Build output
dist/
build/
.next/
out/
*.tsbuildinfo

# Tooling caches
.turbo/
coverage/
.eslintcache

# Local environment files — never committed. .env.example is the template.
.env
.env.*
!.env.example

# Local development data (Strategy B): PostgreSQL and Redis persist here in
# development so the containers are disposable while the data is not.
/.docker-data/

# Logs
logs/
*.log
npm-debug.log*
pnpm-debug.log*

# Editors / OS
.idea/
.vscode/
.DS_Store
Thumbs.db
```


### `.npmrc`

```
# pnpm resolves workspace packages from the repository, never from the registry.
link-workspace-packages=true
prefer-workspace-packages=true

# Prisma's CLI resolves its engine binaries (and the generated client) through
# its own package tree. pnpm's default symlinked layout hides them from
# `apps/backend`, so Prisma-related packages are hoisted to the virtual store root.
public-hoist-pattern[]=*prisma*

# Surface peer-dependency problems as installation errors instead of warnings,
# so incompatible upgrades cannot silently slip into the workspace.
strict-peer-dependencies=true

# Fail fast when the running Node.js version does not satisfy engines.
engine-strict=true
```


### `README.md`

```markdown
# Shopino

Multi-vendor marketplace with banking credit (BNPL) capabilities.

Monorepo managed with **Turborepo + pnpm workspaces**. TypeScript end to end with
`strict` mode enabled in every workspace.

> **Phase status:** Phase 1 (infrastructure & monorepo architecture) is
> implemented and verified against real services — see
> [`docs/phase-1-verification.md`](docs/phase-1-verification.md) for raw evidence
> (commands + captured output) and
> [`docs/phase-1-deliverable.md`](docs/phase-1-deliverable.md) for the complete
> file tree and file contents.
>
> The database schema currently holds **master data only** (platform users, the
> category tree, system configuration) applied through Prisma migrations — the
> marketplace domain (vendors, products, orders, BNPL) arrives in its own phases.

---

## 1. Architecture at a glance

| Workspace | Stack | Dev port |
| --- | --- | --- |
| `apps/backend` | NestJS 11 (Fastify adapter), Prisma 6, terminus, Swagger | `4000` |
| `apps/frontend` | Next.js 15 App Router (RTL, Tailwind CSS 4, axios) | `3000` |
| `packages/config` | Shared TypeScript presets (`base`, `nest`, `next`) | — |
| Infrastructure | PostgreSQL 16 + Redis 7 (docker compose, `shopino_network`) | `5432`, `6379` |

Public HTTP contract:

- API: `http://<host>:4000/api/v1` (global prefix `api/v1`)
- Health: `GET /api/v1/health` → 200 when everything is up, 503 otherwise
- OpenAPI UI: `/api/docs` · OpenAPI JSON: `/api/docs-json`
- The frontend proxies everything below `/api/*` to the backend server-side, so a
  browser only ever talks to one origin (no CORS involved, no backend URL in the
  client bundle). `NEXT_PUBLIC_API_BASE_URL=/api/v1` is a **relative** URL.

### Approved architectural decisions

| # | Decision | Implementation |
| --- | --- | --- |
| 1 | **Package manager: pnpm 9.x** | `packageManager: pnpm@9.15.9`, `pnpm-workspace.yaml` (`apps/*`, `packages/*`), `pnpm-lock.yaml` is the only lockfile, Turborepo task graph in `turbo.json` |
| 2 | **Persistence: Strategy B** (dev mount + clean prod separation) | `docker-compose.yml` = production/CI with named volumes `postgres_data`/`redis_data`; `docker-compose.override.yml` = development bind mounts in `./.docker-data/` (git-ignored) |
| 2b | **Schema source of truth: Prisma Migrations** | `prisma/schema.prisma` + `prisma/migrations/`, applied with `migrate dev`/`migrate deploy`; `db push` is limited to throwaway experiments |
| 2c | **Deterministic seed** | `prisma/seed.ts` — idempotent, non-destructive, re-creates super admin + categories + system config after a volume wipe; credentials come from the environment |

## 2. Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | `>= 22` | Node 20 is EOL; `content-disposition@3` (via `@fastify/static`) requires ≥ 22. |
| pnpm | `9.15.9` | Pinned through `packageManager` in the root `package.json`. |
| Docker Engine + Compose v2 | recent | Provides PostgreSQL 16 and Redis 7. |

## 3. First-time setup (step by step)

```bash
# 1) Install dependencies for every workspace
pnpm install

# 2) Create the environment file and fill in real values
cp .env.example .env
#    Required: DATABASE_URL, DIRECT_URL, REDIS_*, SUPER_ADMIN_EMAIL,
#    SUPER_ADMIN_PASSWORD. The backend validates them at boot:
#    - invalid or missing infrastructure values fail the start
#    - JWT secrets are mandatory when NODE_ENV=production, a warning otherwise
#    - the seed refuses to run without super-admin credentials (never invents them)
#    Generate secrets with: openssl rand -base64 48

# 3) Start PostgreSQL 16 and Redis 7 (both must report "healthy")
pnpm infra:prepare          # creates ./.docker-data and fixes ownership (Linux)
docker compose up -d        # base + development override (auto-merged)
docker compose ps

# 4) Build the database from migrations and seed the master data
pnpm db:generate            # Prisma client
pnpm db:migrate             # create/apply migrations in development
pnpm db:seed                # super admin + categories + system config (idempotent)
pnpm verify:connections     # prints the real PostgreSQL/Redis versions it reached

# 5) Run both applications (Turborepo starts them in parallel)
pnpm dev
#    backend  → http://localhost:4000/api/v1   (docs: /api/docs)
#    frontend → http://localhost:3000
```

### Everyday commands

```bash
pnpm dev                 # both apps in watch mode
pnpm build               # production build of every workspace
pnpm lint                # ESLint (flat config, type-aware for the backend)
pnpm typecheck           # tsc --noEmit everywhere
pnpm test                # unit tests (Jest for backend, Vitest for frontend)
pnpm test:e2e            # backend end-to-end tests against real PostgreSQL + Redis
pnpm verify:http         # HTTP smoke test of a running API (health, docs, 404)
pnpm verify:seed         # proves the seed is deterministic and idempotent

pnpm db:migrate          # create + apply a migration  (development)
pnpm db:deploy           # apply pending migrations     (production / CI)
pnpm db:seed             # re-run the master-data seed  (idempotent)
pnpm db:reset            # drop schema → re-apply migrations → re-seed
pnpm db:studio           # Prisma Studio

pnpm infra:up            # prepare + start infrastructure (development)
pnpm infra:up:prod       # start infrastructure pinned to the production file
pnpm infra:down          # stop containers (data stays in ./.docker-data)
pnpm infra:reset         # stop containers and delete infrastructure data
pnpm infra:logs          # follow infrastructure logs
```

## 4. Development vs production

| Concern | Development | Production / CI |
| --- | --- | --- |
| Compose files | `docker-compose.yml` **+** `docker-compose.override.yml` (auto-merged) | `docker compose -f docker-compose.yml …` (**always pin the file**) |
| Persistence | bind mounts in `./.docker-data/{postgres,redis}` — visible, disposable, git-ignored | named volumes `postgres_data`, `redis_data` |
| Schema changes | `pnpm db:migrate` (creates a migration file) | `pnpm db:deploy` (applies committed migrations only) |
| Master data | `pnpm db:seed` any time | `pnpm db:seed` once per environment, then on demand |
| Backend | `nest start --watch` | `pnpm build` + `node apps/backend/dist/main.js` |
| Frontend | `next dev` | `next build` + `next start` |
| Secrets | random local values; warnings when absent | boot fails when a required secret is missing |
| CORS | `CORS_ORIGINS` **plus** localhost/remote-sandbox origins | only the explicit `CORS_ORIGINS` allow-list |

> **Why pinning the compose file matters:** Compose merges
> `docker-compose.override.yml` automatically. That is exactly what a developer
> wants and exactly what a server must not get — a production host that ran a
> plain `docker compose up -d` would silently switch to the development bind
> mounts. Use `pnpm infra:up:prod` (or `docker compose -f docker-compose.yml …`)
> outside development.

Provider-swap rule for external services (OTP, SMS, email, payments, storage):
each integration is introduced behind an interface with the provider selected by
an environment variable, so the same business logic runs against a sandbox
provider in development and the real provider in production. **No such provider
exists yet** — the health endpoint only reports the two infrastructure
dependencies that are actually deployed.

## 5. Database: migrations, master data and recovery

- **Migrations are the only way the schema changes.** Every change is a reviewed
  SQL file under `prisma/migrations/`; production applies them with
  `migrate deploy`, which never generates new SQL.
- **Master data** (`prisma/seed.ts`) is deterministic, idempotent and
  non-destructive:
  - super-admin account (email, name and password from the environment; the
    password is stored only as an Argon2id hash — never in plaintext, and never
    rotated silently unless `SEED_RESET_ADMIN_PASSWORD=true`);
  - baseline category tree (stable slugs, parent links, sort order);
  - system configuration rows (`platform.*`, and `credit.enabled=false` while
    BNPL is not implemented — the platform must not advertise a feature that
    does not exist).
- **Recovery from a wiped volume** (verified end to end — see the verification
  report): `rm -rf .docker-data/postgres/pgdata` → `pnpm db:reset` restores the
  schema *and* the master data in a single command.

## 6. Environment variables

Every value lives in the root `.env` (git-ignored) and is documented in
[`.env.example`](.env.example). Summary:

| Variable | Purpose |
| --- | --- |
| `NODE_ENV`, `PORT`, `HOST`, `LOG_LEVEL` | Runtime identity, bind address, logger verbosity |
| `CORS_ORIGINS` | Comma-separated browser origins allowed in production |
| `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `POSTGRES_PORT` | Credentials for the compose service |
| `DATABASE_URL` | Prisma runtime connection (pooled endpoint in production) |
| `DIRECT_URL` | Prisma migration connection (bypasses a pooler) |
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `REDIS_DB` | Redis connection (AUTH required) |
| `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` | Signing secrets — mandatory in production |
| `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_FULL_NAME` | Super-admin account created by the seed |
| `SEED_RESET_ADMIN_PASSWORD` | Set `true` only to rotate the admin password deliberately |
| `NEXT_PUBLIC_API_BASE_URL` | Browser-facing API base URL (relative by default) |
| `BACKEND_INTERNAL_URL` | Server-side target of the Next.js `/api/*` rewrite |
| `NEXT_ALLOWED_DEV_ORIGINS` | Extra origins allowed to load Next.js dev assets |

Nothing secret is committed: `.env` is ignored, `.env.example` contains
placeholders only, and production secrets are validated at boot instead of being
hard-coded.

## 7. Repository layout

```
shopino/
├── apps/
│   ├── backend/           # NestJS API (Fastify): config, infra, health, prisma, tests, scripts
│   └── frontend/          # Next.js App Router client (RTL, Tailwind v4)
├── packages/
│   └── config/            # Shared tsconfig presets
├── docs/                  # Phase verification + deliverable reports
├── scripts/               # Development infrastructure helpers
├── docker-compose.yml         # production/CI: PostgreSQL 16 + Redis 7, named volumes
├── docker-compose.override.yml# development: bind mounts in ./.docker-data
├── turbo.json                 # Task graph (build, dev, lint, test, db:*)
├── pnpm-workspace.yaml
└── .env.example
```

## 8. Operational notes

- **Health semantics.** `/api/v1/health` performs real queries: `SELECT 1`
  through Prisma, `PING` through Redis, heap-usage and uptime checks. Verified
  both ways: stopping Redis returns `503` with `redis.status = "down"` and
  restarting it returns `200` **without restarting the API**.
- **Fail-soft boot.** If PostgreSQL is unreachable the API retries briefly, logs
  an error and stays up so the health endpoint can report the outage instead of
  crash-looping.
- **Development data ownership.** The bind-mounted directories are owned by the
  container users (`uid 999`) because the database refuses to start otherwise.
  `pnpm infra:prepare` sets this up; on macOS/Windows Docker Desktop handles it
  automatically.
- **Dependency pinning.** Semver ranges live in `package.json`; `pnpm-lock.yaml`
  pins the exact resolved versions. `strict-peer-dependencies=true` and
  `engine-strict=true` make incompatible upgrades fail the install rather than
  pass silently.
- **Do not run `pnpm build` while `next dev` is running.** Both write to
  `apps/frontend/.next`; rewriting it under a running dev server terminates the
  dev server. Stop it first, or build only the backend
  (`pnpm --filter @shopino/backend build`).
```


### `apps/backend/eslint.config.mjs`

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/**', 'coverage/**', 'node_modules/**', 'prisma/generated/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript already reports undefined identifiers, and it understands
      // globals that no-undef cannot (Node.js, Jest, decorators).
      'no-undef': 'off',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: false, allowTypedFunctionExpressions: true },
      ],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always'],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.e2e-spec.ts', 'scripts/**/*.ts'],
    rules: {
      // Test suites and operational scripts are allowed to print to stdout.
      'no-console': 'off',
    },
  },
);
```


### `apps/backend/jest.config.js`

```js
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: 'src',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/../tsconfig.json',
      },
    ],
  },
  collectCoverageFrom: ['**/*.(t|j)s', '!**/*.module.ts', '!**/main.ts'],
  coverageDirectory: '../coverage',
  testEnvironment: 'node',
  clearMocks: true,
};
```


### `apps/backend/nest-cli.json`

```json
{
  "$schema": "https://json.schemastore.org/nest-cli",
  "collection": "@nestjs/schematics",
  "sourceRoot": "src",
  "compilerOptions": {
    "deleteOutDir": true,
    "tsConfigPath": "tsconfig.build.json"
  }
}
```


### `apps/backend/package.json`

```json
{
  "name": "@shopino/backend",
  "version": "0.1.0",
  "private": true,
  "description": "Shopino API — NestJS (Fastify adapter) application",
  "license": "UNLICENSED",
  "scripts": {
    "dev": "pnpm run db:generate && dotenv -e ../../.env -- nest start --watch",
    "build": "pnpm run db:generate && nest build",
    "start": "dotenv -e ../../.env -- node dist/main.js",
    "typecheck": "pnpm run db:generate && tsc --noEmit -p tsconfig.json",
    "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\" \"scripts/**/*.ts\" \"prisma/**/*.ts\"",
    "test": "jest --config jest.config.js --runInBand",
    "test:e2e": "jest --config ./test/jest-e2e.json --runInBand",
    "prisma:generate": "pnpm run db:generate",
    "db:validate": "dotenv -e ../../.env -- prisma validate",
    "db:migrate": "dotenv -e ../../.env -- prisma migrate dev",
    "db:deploy": "dotenv -e ../../.env -- prisma migrate deploy",
    "db:push": "dotenv -e ../../.env -- prisma db push",
    "db:seed": "dotenv -e ../../.env -- ts-node --project tsconfig.json prisma/seed.ts",
    "db:reset": "dotenv -e ../../.env -- prisma migrate reset --force --skip-generate",
    "db:studio": "dotenv -e ../../.env -- prisma studio",
    "verify:connections": "dotenv -e ../../.env -- ts-node --project tsconfig.json scripts/verify-connections.ts",
    "verify:seed": "dotenv -e ../../.env -- ts-node --project tsconfig.json scripts/verify-seed.ts",
    "verify:http": "dotenv -e ../../.env -- ts-node --project tsconfig.json scripts/smoke-http.ts",
    "clean": "rm -rf dist coverage",
    "db:generate": "dotenv -e ../../.env -- prisma generate"
  },
  "dependencies": {
    "@fastify/static": "^10.1.4",
    "@nestjs/common": "^11.2.6",
    "@nestjs/config": "^4.0.4",
    "@nestjs/core": "^11.2.6",
    "@nestjs/platform-fastify": "^11.2.6",
    "@nestjs/swagger": "^11.4.7",
    "@nestjs/terminus": "^11.1.1",
    "@node-rs/argon2": "^2.2.1",
    "@prisma/client": "^6.19.3",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.4",
    "fastify": "^5.12.5",
    "ioredis": "^5.11.1",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.5",
    "@nestjs/cli": "^11.0.24",
    "@nestjs/schematics": "^11.1.0",
    "@nestjs/testing": "^11.2.6",
    "@shopino/config": "workspace:*",
    "@types/jest": "^29.5.14",
    "@types/node": "^20.19.43",
    "@types/supertest": "^6.0.3",
    "dotenv": "^16.4.7",
    "dotenv-cli": "^8.0.0",
    "eslint": "^9.39.5",
    "jest": "^29.7.0",
    "prisma": "^6.19.3",
    "supertest": "^7.3.0",
    "ts-jest": "^29.4.13",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.70.1"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "prisma": {
    "seed": "ts-node --project tsconfig.json prisma/seed.ts"
  }
}
```


### `apps/backend/prisma/migrations/20260926124703_init/migration.sql`

```sql
-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'VENDOR', 'CUSTOMER');

-- CreateEnum
CREATE TYPE "ConfigValueType" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'CUSTOMER',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "categories" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(80) NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "title_en" VARCHAR(120),
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_configs" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "value" TEXT NOT NULL,
    "value_type" "ConfigValueType" NOT NULL DEFAULT 'STRING',
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_configs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_role_is_active_idx" ON "users"("role", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "categories_slug_key" ON "categories"("slug");

-- CreateIndex
CREATE INDEX "categories_parent_id_sort_order_idx" ON "categories"("parent_id", "sort_order");

-- CreateIndex
CREATE INDEX "categories_is_active_idx" ON "categories"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "system_configs_key_key" ON "system_configs"("key");

-- AddForeignKey
ALTER TABLE "categories" ADD CONSTRAINT "categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;
```


### `apps/backend/prisma/migrations/migration_lock.toml`

```toml
# Please do not edit this file manually
# It should be added in your version-control system (e.g., Git)
provider = "postgresql"
```


### `apps/backend/prisma/schema.prisma`

```prisma
// Shopino — Prisma schema
//
// The schema is the single source of truth for the database and is applied
// exclusively through migrations (`prisma migrate dev` / `prisma migrate deploy`);
// `prisma db push` remains available for throwaway experiments only.
//
// Phase 1 defines the master data that the deterministic seed re-populates when
// a development volume is wiped (see prisma/seed.ts): platform users, the
// product category tree and system configuration. Marketplace domain tables
// (vendors, products, orders, credit/BNPL) arrive with their own phases and
// their own migrations.
//
// Connection strings:
//   DATABASE_URL — runtime connection (pooled endpoint in production)
//   DIRECT_URL   — migration/introspection connection (bypasses a pooler)

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

/// Platform roles. SUPER_ADMIN is the account created by the seed; the remaining
/// roles are the marketplace identities the upcoming authentication phase issues
/// (kept here so role changes do not require a schema rewrite later).
enum UserRole {
  SUPER_ADMIN
  ADMIN
  VENDOR
  CUSTOMER
}

/// Storage type of a SystemConfig value. Values are persisted as text so a
/// configuration row can always be read by a human; the type tells readers how
/// to parse it and keeps the seed deterministic.
enum ConfigValueType {
  STRING
  NUMBER
  BOOLEAN
  JSON
}

/// Platform user. Emails are stored lower-cased; the unique index is therefore
/// case-insensitive in practice.
model User {
  id           String    @id @default(uuid()) @db.Uuid
  email        String    @unique @db.VarChar(254)
  passwordHash String    @map("password_hash") @db.VarChar(255)
  fullName     String    @map("full_name") @db.VarChar(120)
  role         UserRole  @default(CUSTOMER)
  isActive     Boolean   @default(true) @map("is_active")
  lastLoginAt  DateTime? @map("last_login_at") @db.Timestamptz(3)
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([role, isActive])
  @@map("users")
}

/// Product category tree. `slug` is the stable business key used by the seed and
/// by future storefront routing; titles are presentation data.
model Category {
  id        String     @id @default(uuid()) @db.Uuid
  slug      String     @unique @db.VarChar(80)
  title     String     @db.VarChar(120)
  titleEn   String?    @map("title_en") @db.VarChar(120)
  parentId  String?    @map("parent_id") @db.Uuid
  parent    Category?  @relation("CategoryTree", fields: [parentId], references: [id], onDelete: SetNull)
  children  Category[] @relation("CategoryTree")
  sortOrder Int        @default(0) @map("sort_order")
  isActive  Boolean    @default(true) @map("is_active")
  createdAt DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([parentId, sortOrder])
  @@index([isActive])
  @@map("categories")
}

/// Key/value system configuration. `key` is the stable identifier consumed by
/// application code; rows are upserted by the seed.
model SystemConfig {
  id          String          @id @default(uuid()) @db.Uuid
  key         String          @unique @db.VarChar(120)
  value       String          @db.Text
  valueType   ConfigValueType @default(STRING) @map("value_type")
  description String?         @db.VarChar(255)
  createdAt   DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime        @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("system_configs")
}
```


### `apps/backend/prisma/seed.ts`

```ts
/**
 * Deterministic master-data seed.
 *
 * Run with:  pnpm db:seed          (turbo → @shopino/backend → prisma/seed.ts)
 * Reset:     pnpm db:reset         (drops the schema, re-applies migrations, re-seeds)
 *
 * Purpose: after a development volume is wiped (`pnpm infra:reset`), or on a
 * brand-new environment, one command restores the data the platform cannot start
 * without — the super-admin account, the baseline category tree and the system
 * configuration rows.
 *
 * Properties, by design:
 *   • Deterministic — the same input always produces the same rows.
 *   • Idempotent    — running it any number of times leaves the same state;
 *                     safe to execute on every deploy.
 *   • Non-destructive — existing user passwords are never overwritten unless
 *                     SEED_RESET_ADMIN_PASSWORD=true is set explicitly.
 *
 * Credentials come from the environment (SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD);
 * no secret is hard-coded. The plaintext password is hashed with Argon2id before
 * it ever reaches the database.
 */
import { ConfigValueType, PrismaClient, UserRole } from '@prisma/client';
import type { PrismaClient as PrismaClientInstance } from '@prisma/client';
import { hashPassword } from '../src/infra/security/password';

export interface SeedSummary {
  adminEmail: string;
  adminCreated: boolean;
  categoriesUpserted: number;
  configsUpserted: number;
}

interface CategorySeed {
  slug: string;
  title: string;
  titleEn: string;
  sortOrder: number;
  children: Omit<CategorySeed, 'children'>[];
}

interface ConfigSeed {
  key: string;
  value: string;
  valueType: ConfigValueType;
  description: string;
}

/** Baseline taxonomy of the marketplace. Extend through new seed entries. */
const CATEGORY_TREE: readonly CategorySeed[] = [
  {
    slug: 'digital',
    title: 'کالای دیجیتال',
    titleEn: 'Digital Goods',
    sortOrder: 10,
    children: [
      { slug: 'mobile', title: 'گوشی موبایل', titleEn: 'Mobile Phones', sortOrder: 10 },
      { slug: 'laptop', title: 'لپ‌تاپ و کامپیوتر', titleEn: 'Laptops & Computers', sortOrder: 20 },
      { slug: 'digital-accessories', title: 'لوازم جانبی دیجیتال', titleEn: 'Digital Accessories', sortOrder: 30 },
    ],
  },
  {
    slug: 'home-kitchen',
    title: 'خانه و آشپزخانه',
    titleEn: 'Home & Kitchen',
    sortOrder: 20,
    children: [
      { slug: 'home-appliances', title: 'لوازم خانگی', titleEn: 'Home Appliances', sortOrder: 10 },
      { slug: 'kitchenware', title: 'ظروف و لوازم آشپزخانه', titleEn: 'Kitchenware', sortOrder: 20 },
    ],
  },
  {
    slug: 'fashion',
    title: 'مد و پوشاک',
    titleEn: 'Fashion',
    sortOrder: 30,
    children: [
      { slug: 'mens-clothing', title: 'پوشاک مردانه', titleEn: "Men's Clothing", sortOrder: 10 },
      { slug: 'womens-clothing', title: 'پوشاک زنانه', titleEn: "Women's Clothing", sortOrder: 20 },
      { slug: 'bags-shoes', title: 'کیف و کفش', titleEn: 'Bags & Shoes', sortOrder: 30 },
    ],
  },
  {
    slug: 'beauty-health',
    title: 'زیبایی و سلامت',
    titleEn: 'Beauty & Health',
    sortOrder: 40,
    children: [
      { slug: 'skincare', title: 'مراقبت از پوست', titleEn: 'Skincare', sortOrder: 10 },
      { slug: 'personal-care', title: 'بهداشت شخصی', titleEn: 'Personal Care', sortOrder: 20 },
    ],
  },
  {
    slug: 'supermarket',
    title: 'سوپرمارکت',
    titleEn: 'Supermarket',
    sortOrder: 50,
    children: [
      { slug: 'food-beverage', title: 'خواروبار و نوشیدنی', titleEn: 'Food & Beverage', sortOrder: 10 },
      { slug: 'dairy', title: 'لبنیات', titleEn: 'Dairy', sortOrder: 20 },
    ],
  },
  {
    slug: 'books-stationery',
    title: 'کتاب و لوازم‌التحریر',
    titleEn: 'Books & Stationery',
    sortOrder: 60,
    children: [
      { slug: 'books', title: 'کتاب', titleEn: 'Books', sortOrder: 10 },
    ],
  },
];

/**
 * Baseline platform configuration. Values describe how the platform behaves, not
 * business data: `credit.enabled` stays false until the BNPL phase ships, so no
 * feature is advertised before it exists.
 */
const SYSTEM_CONFIGS: readonly ConfigSeed[] = [
  {
    key: 'platform.name',
    value: 'شاپینو',
    valueType: ConfigValueType.STRING,
    description: 'نام نمایشی پلتفرم',
  },
  {
    key: 'platform.currency',
    value: 'IRR',
    valueType: ConfigValueType.STRING,
    description: 'کد ارز پایه پلتفرم (ISO 4217)',
  },
  {
    key: 'platform.locale',
    value: 'fa-IR',
    valueType: ConfigValueType.STRING,
    description: 'زبان و قالب پیش‌فرض رابط کاربری',
  },
  {
    key: 'platform.timezone',
    value: 'Asia/Tehran',
    valueType: ConfigValueType.STRING,
    description: 'منطقهٔ زمانی مرجع برای گزارش‌ها و تسویه',
  },
  {
    key: 'credit.enabled',
    value: 'false',
    valueType: ConfigValueType.BOOLEAN,
    description: 'فعال بودن خرید اعتباری (BNPL). تا زمان پیاده‌سازی این قابلیت خاموش است.',
  },
];

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. Add it to the root .env (see .env.example) — the seed is not allowed to invent credentials.`,
    );
  }
  return value;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseBooleanFlag(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

/**
 * Seeds master data. Accepts a PrismaClient so tests and scripts can reuse the
 * exact same logic inside an existing connection or transaction scope.
 */
export async function seedDatabase(prisma: PrismaClientInstance): Promise<SeedSummary> {
  const adminEmail = normalizeEmail(requireEnv('SUPER_ADMIN_EMAIL'));
  const adminPassword = requireEnv('SUPER_ADMIN_PASSWORD');
  const adminFullName = (process.env.SUPER_ADMIN_FULL_NAME ?? 'مدیر ارشد پلتفرم').trim();
  const resetAdminPassword = parseBooleanFlag('SEED_RESET_ADMIN_PASSWORD');

  // ── Super admin ───────────────────────────────────────────────────────────
  const existingAdmin = await prisma.user.findUnique({ where: { email: adminEmail } });
  let adminCreated = false;

  if (existingAdmin === null) {
    await prisma.user.create({
      data: {
        email: adminEmail,
        passwordHash: await hashPassword(adminPassword),
        fullName: adminFullName,
        role: UserRole.SUPER_ADMIN,
        isActive: true,
      },
    });
    adminCreated = true;
  } else {
    // Never silently rotate a credential; only repair role/activation drift.
    await prisma.user.update({
      where: { email: adminEmail },
      data: {
        fullName: adminFullName,
        role: UserRole.SUPER_ADMIN,
        isActive: true,
        ...(resetAdminPassword ? { passwordHash: await hashPassword(adminPassword) } : {}),
      },
    });
  }

  // ── Category tree ─────────────────────────────────────────────────────────
  let categoriesUpserted = 0;

  for (const root of CATEGORY_TREE) {
    const parent = await prisma.category.upsert({
      where: { slug: root.slug },
      update: {
        title: root.title,
        titleEn: root.titleEn,
        sortOrder: root.sortOrder,
        isActive: true,
      },
      create: {
        slug: root.slug,
        title: root.title,
        titleEn: root.titleEn,
        sortOrder: root.sortOrder,
        isActive: true,
      },
    });
    categoriesUpserted += 1;

    for (const child of root.children) {
      await prisma.category.upsert({
        where: { slug: child.slug },
        update: {
          title: child.title,
          titleEn: child.titleEn,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
        create: {
          slug: child.slug,
          title: child.title,
          titleEn: child.titleEn,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
      });
      categoriesUpserted += 1;
    }
  }

  // ── System configuration ──────────────────────────────────────────────────
  let configsUpserted = 0;
  for (const config of SYSTEM_CONFIGS) {
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: {
        value: config.value,
        valueType: config.valueType,
        description: config.description,
      },
      create: {
        key: config.key,
        value: config.value,
        valueType: config.valueType,
        description: config.description,
      },
    });
    configsUpserted += 1;
  }

  return { adminEmail, adminCreated, categoriesUpserted, configsUpserted };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const summary = await seedDatabase(prisma);
    console.warn(
      `[seed] master data ready — super admin: ${summary.adminEmail} ` +
        `(${summary.adminCreated ? 'created' : 'updated'}), ` +
        `categories: ${summary.categoriesUpserted}, system configs: ${summary.configsUpserted}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
```


### `apps/backend/scripts/smoke-http.ts`

```ts
/**
 * HTTP smoke test for a running API instance.
 *
 * Run with:  pnpm --filter @shopino/backend run verify:http
 * Target:    API_BASE_URL (defaults to http://127.0.0.1:4000)
 *
 * Exercises the public contract over the network — the same way a browser or a
 * load balancer does — and fails with a non-zero exit code when a check breaks.
 * This is the layer where the Swagger UI is verified, since serving it depends
 * on the ESM-only glob package that Jest cannot load (see test/health.e2e-spec.ts).
 */

interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

const REQUEST_TIMEOUT_MS = 5_000;

function apiBaseUrl(): string {
  return (process.env.API_BASE_URL ?? 'http://127.0.0.1:4000').replace(/\/+$/, '');
}

async function request(path: string): Promise<Response> {
  return fetch(`${apiBaseUrl()}${path}`, {
    headers: { Accept: '*/*' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

async function checkHealth(): Promise<CheckResult> {
  const response = await request('/api/v1/health');
  const body = (await response.json()) as {
    status: string;
    info?: Record<string, { status: string }>;
  };
  const database = body.info?.database?.status;
  const redis = body.info?.redis?.status;
  return {
    name: 'GET /api/v1/health',
    ok: response.status === 200 && body.status === 'ok' && database === 'up' && redis === 'up',
    detail: `HTTP ${response.status} · status=${body.status} · database=${database} · redis=${redis}`,
  };
}

async function checkOpenApiDocument(): Promise<CheckResult> {
  const response = await request('/api/docs-json');
  const document = (await response.json()) as { info?: { title?: string }; paths?: object };
  const paths = Object.keys(document.paths ?? {});
  return {
    name: 'GET /api/docs-json',
    ok: response.status === 200 && paths.includes('/api/v1/health'),
    detail: `HTTP ${response.status} · title=${document.info?.title ?? 'unknown'} · paths=${paths.join(', ')}`,
  };
}

async function checkSwaggerUi(): Promise<CheckResult> {
  const response = await request('/api/docs');
  const html = await response.text();
  const rendersSwagger = html.includes('swagger-ui') && html.includes('<title>Shopino API</title>');
  return {
    name: 'GET /api/docs',
    ok: response.status === 200 && rendersSwagger,
    detail: `HTTP ${response.status} · ${html.length} bytes · swagger-ui assets referenced=${rendersSwagger}`,
  };
}

async function checkUnknownRouteIs404(): Promise<CheckResult> {
  const response = await request('/api/v1/definitely-not-a-route');
  return {
    name: 'GET /api/v1/definitely-not-a-route',
    ok: response.status === 404,
    detail: `HTTP ${response.status}`,
  };
}

async function main(): Promise<void> {
  const checks = [
    await checkHealth(),
    await checkOpenApiDocument(),
    await checkSwaggerUi(),
    await checkUnknownRouteIs404(),
  ];

  for (const check of checks) {
    console.warn(`${check.ok ? '[ok]  ' : '[FAIL]'} ${check.name} — ${check.detail}`);
  }

  const failed = checks.filter((check) => !check.ok);
  if (failed.length > 0) {
    throw new Error(`${failed.length} of ${checks.length} HTTP checks failed`);
  }
  console.warn(`[verify:http] API at ${apiBaseUrl()} passed all ${checks.length} checks`);
}

main().catch((error: unknown) => {
  console.error(`[verify:http] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
```


### `apps/backend/scripts/verify-connections.ts`

```ts
/**
 * Operational connectivity probe for PostgreSQL and Redis.
 *
 * Run with:  pnpm --filter @shopino/backend run verify:connections
 *
 * Unlike the HTTP health endpoint this script runs outside Nest, prints the
 * server versions it reached and exits with a non-zero status on failure, so it
 * can be used in CI gates and in deployment smoke tests.
 */
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { errorMessage } from '../src/common/utils';

interface PostgresFacts {
  database: string;
  role: string;
  server_version: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`${name} is not set. Run this script through "pnpm run verify:connections" so .env is loaded.`);
  }
  return value;
}

function parseRedisVersion(info: string): string {
  const match = /^redis_version:(.+)$/m.exec(info);
  return match?.[1]?.trim() ?? 'unknown';
}

async function verifyPostgres(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const rows = await prisma.$queryRaw<PostgresFacts[]>`
      SELECT current_database() AS database,
             current_user AS role,
             version() AS server_version
    `;
    const [facts] = rows;
    if (facts === undefined) {
      throw new Error('PostgreSQL returned no rows for the connectivity probe.');
    }
    console.warn(`[postgres] ok  database=${facts.database} role=${facts.role}`);
    console.warn(`[postgres] ${facts.server_version}`);
  } finally {
    await prisma.$disconnect();
  }
}

async function verifyRedis(): Promise<void> {
  const client = new Redis({
    host: requireEnv('REDIS_HOST'),
    port: Number.parseInt(requireEnv('REDIS_PORT'), 10),
    password: requireEnv('REDIS_PASSWORD'),
    db: Number.parseInt(process.env.REDIS_DB ?? '0', 10),
    connectTimeout: 5_000,
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  });

  try {
    await client.connect();
    const startedAt = Date.now();
    const pong: string = await client.ping();
    if (pong !== 'PONG') {
      throw new Error(`Unexpected PING reply: ${pong}`);
    }
    const info = await client.info('server');
    console.warn(`[redis]    ok  version=${parseRedisVersion(info)} ping=${Date.now() - startedAt}ms`);
  } finally {
    await client.quit();
  }
}

async function main(): Promise<void> {
  await verifyPostgres();
  await verifyRedis();
  console.warn('[verify:connections] all infrastructure connections are healthy');
}

main().catch((error: unknown) => {
  console.error(`[verify:connections] FAILED: ${errorMessage(error)}`);
  process.exitCode = 1;
});
```


### `apps/backend/scripts/verify-seed.ts`

```ts
/**
 * Verifies the deterministic seed against the live database.
 *
 * Run with:  pnpm --filter @shopino/backend run verify:seed
 *
 * It executes the seed twice and proves three properties:
 *   1. the master data exists afterwards (super admin, categories, configs);
 *   2. a second run changes no row counts and does not rotate the password hash;
 *   3. the stored credential is an Argon2id hash, never the plaintext.
 *
 * Exits non-zero on any violation, so it can gate CI.
 */
import { PrismaClient, UserRole } from '@prisma/client';
import { seedDatabase, normalizeEmail } from '../prisma/seed';
import { isArgon2idHash, verifyPassword } from '../src/infra/security/password';

interface Snapshot {
  users: number;
  categories: number;
  rootCategories: number;
  configs: number;
  adminHash: string;
}

async function snapshot(prisma: PrismaClient, adminEmail: string): Promise<Snapshot> {
  const [users, categories, rootCategories, configs, admin] = await Promise.all([
    prisma.user.count(),
    prisma.category.count(),
    prisma.category.count({ where: { parentId: null } }),
    prisma.systemConfig.count(),
    prisma.user.findUnique({ where: { email: adminEmail }, select: { passwordHash: true } }),
  ]);

  if (admin === null) {
    throw new Error(`Super admin ${adminEmail} is missing after seeding.`);
  }

  return { users, categories, rootCategories, configs, adminHash: admin.passwordHash };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  const adminEmail = normalizeEmail(process.env.SUPER_ADMIN_EMAIL ?? '');
  if (adminEmail === '') {
    throw new Error('SUPER_ADMIN_EMAIL is not set; run this script through pnpm so .env is loaded.');
  }

  try {
    console.warn('[verify:seed] first run');
    const firstRun = await seedDatabase(prisma);
    const first = await snapshot(prisma, adminEmail);
    console.warn(
      `[verify:seed]   users=${first.users} categories=${first.categories} (roots=${first.rootCategories}) configs=${first.configs}`,
    );

    console.warn('[verify:seed] second run (idempotency check)');
    await seedDatabase(prisma);
    const second = await snapshot(prisma, adminEmail);

    const admin = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
      select: { id: true, role: true, isActive: true, passwordHash: true },
    });

    const failures: string[] = [];
    if (first.users !== second.users) failures.push('user count changed on re-run');
    if (first.categories !== second.categories) failures.push('category count changed on re-run');
    if (first.configs !== second.configs) failures.push('system config count changed on re-run');
    if (first.adminHash !== second.adminHash) failures.push('admin password hash was rotated on re-run');
    if (admin.role !== UserRole.SUPER_ADMIN) failures.push(`admin role is ${admin.role}, expected SUPER_ADMIN`);
    if (!admin.isActive) failures.push('admin account is not active');
    if (!isArgon2idHash(admin.passwordHash)) failures.push('stored credential is not an Argon2id hash');
    if (admin.passwordHash.includes(process.env.SUPER_ADMIN_PASSWORD ?? '__none__')) {
      failures.push('stored credential contains the plaintext password');
    }
    if (!(await verifyPassword(admin.passwordHash, process.env.SUPER_ADMIN_PASSWORD ?? ''))) {
      failures.push('stored hash does not verify the configured password');
    }
    if (first.rootCategories === 0) failures.push('no root categories were seeded');

    if (failures.length > 0) {
      throw new Error(`seed verification failed:\n- ${failures.join('\n- ')}`);
    }

    console.warn(
      '[verify:seed] ok — deterministic and idempotent; credential stored as Argon2id, no plaintext, ' +
        `admin created=${String(firstRun.adminCreated)}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(`[verify:seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
```


### `apps/backend/src/app.module.ts`

```ts
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { resolveEnvFilePaths } from './config/env-file-paths';
import { validateEnvironment, type EnvironmentVariables } from './config/env.validation';
import { HealthModule } from './infra/health/health.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';

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
  ],
})
export class AppModule {}
```


### `apps/backend/src/common/constants.ts`

```ts
/**
 * URL layout of the public API. Both values are used by the runtime bootstrap
 * and by the end-to-end tests, so the routing contract stays in one place.
 */
export const GLOBAL_API_PREFIX = 'api/v1';

/** Human-readable Swagger UI (not prefixed with the global API prefix). */
export const SWAGGER_PATH = 'api/docs';

/** Machine-readable OpenAPI document, consumed by client code generation. */
export const SWAGGER_JSON_PATH = 'api/docs-json';
```


### `apps/backend/src/common/utils.ts`

```ts
/** Converts a `process.hrtime.bigint()` difference into fractional milliseconds. */
export function toMilliseconds(nanoseconds: bigint): number {
  return Number((Number(nanoseconds) / 1_000_000).toFixed(2));
}

/** Extracts a readable message from an unknown thrown value. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === 'string' ? error : 'Unknown error';
}
```


### `apps/backend/src/config/cors.config.ts`

```ts
import type { CorsOptions } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { ConfigService } from '@nestjs/config';
import { NodeEnvironment } from './env.validation';

/**
 * Origins that are accepted outside production without being listed in
 * `CORS_ORIGINS`: local development servers and remote dev-sandbox preview
 * hosts (e.g. `https://3000-<sandbox>.e2b.app`). Production only ever uses the
 * explicit allow-list, so this cannot widen the policy of a deployed API.
 */
export const DEVELOPMENT_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^http:\/\/localhost(:\d{1,5})?$/,
  /^http:\/\/127\.0\.0\.1(:\d{1,5})?$/,
  /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)*\.e2b\.app$/,
];

export function parseOriginList(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

export function buildCorsOptions(config: ConfigService): CorsOptions {
  const allowedOrigins = parseOriginList(config.get<string>('CORS_ORIGINS'));
  const isProduction = config.get<string>('NODE_ENV') === NodeEnvironment.Production;

  return {
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
    maxAge: 600,
    origin: (origin, callback): void => {
      // Same-origin and non-browser clients (curl, server-to-server, health
      // probes) do not send an Origin header; CORS does not apply to them.
      if (origin === undefined || origin === '') {
        callback(null, true);
        return;
      }
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      if (!isProduction && DEVELOPMENT_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin))) {
        callback(null, true);
        return;
      }
      // Respond without CORS headers instead of throwing: the browser blocks the
      // response and the API does not leak policy details to the caller.
      callback(null, false);
    },
  };
}
```


### `apps/backend/src/config/env-file-paths.ts`

```ts
import { join } from 'node:path';

/**
 * The repository keeps a single `.env` at its root, shared by docker-compose,
 * the backend and the frontend. Depending on how a process is started its
 * working directory is either `apps/backend` (pnpm/turbo/nest) or the repository
 * root, so both locations are declared. Missing files are ignored by
 * `@nestjs/config`; validation still fails when a required variable is absent.
 */
export function resolveEnvFilePaths(): string[] {
  const workspaceRoot = join(process.cwd(), '..', '..');
  return [join(workspaceRoot, '.env'), join(process.cwd(), '.env')];
}
```


### `apps/backend/src/config/env.validation.spec.ts`

```ts
import type { ConfigService } from '@nestjs/config';
import { validateEnvironment, NodeEnvironment } from './env.validation';
import { resolveLogLevels } from './logger.config';
import { buildCorsOptions, parseOriginList } from './cors.config';

const VALID_ENV: Record<string, unknown> = {
  NODE_ENV: 'development',
  PORT: '4000',
  HOST: '0.0.0.0',
  DATABASE_URL: 'postgresql://shopino:secret@127.0.0.1:5432/shopino_db?schema=public',
  DIRECT_URL: 'postgresql://shopino:secret@127.0.0.1:5432/shopino_db?schema=public',
  REDIS_HOST: '127.0.0.1',
  REDIS_PORT: '6379',
  REDIS_PASSWORD: 'redis-secret',
  REDIS_DB: '0',
  CORS_ORIGINS: 'http://localhost:3000',
  LOG_LEVEL: 'debug',
  JWT_ACCESS_SECRET: 'a'.repeat(48),
  JWT_REFRESH_SECRET: 'b'.repeat(48),
};

describe('validateEnvironment', () => {
  it('accepts a complete configuration and coerces numeric values', () => {
    const config = validateEnvironment(VALID_ENV);

    expect(config.NODE_ENV).toBe(NodeEnvironment.Development);
    expect(config.PORT).toBe(4000);
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.REDIS_DB).toBe(0);
  });

  it('rejects a configuration without a database connection string', () => {
    const withoutDatabase: Record<string, unknown> = { ...VALID_ENV };
    delete withoutDatabase.DATABASE_URL;

    expect(() => validateEnvironment(withoutDatabase)).toThrow(/DATABASE_URL/);
  });

  it('rejects a database URL that is not a postgres connection string', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, DATABASE_URL: 'mysql://host/db' })).toThrow(
      /postgresql:\/\//,
    );
  });

  it('rejects an out-of-range port', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, PORT: '70000' })).toThrow(/PORT/);
  });

  it('warns instead of failing in development when JWT secrets are missing', () => {
    const logger = { warn: jest.fn() };

    const config = validateEnvironment(
      { ...VALID_ENV, JWT_ACCESS_SECRET: '', JWT_REFRESH_SECRET: '   ' },
      { logger },
    );

    expect(config.JWT_ACCESS_SECRET).toBeUndefined();
    expect(config.JWT_REFRESH_SECRET).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('JWT_ACCESS_SECRET'));
  });

  it('fails fast in production when JWT secrets are missing', () => {
    expect(() =>
      validateEnvironment({
        ...VALID_ENV,
        NODE_ENV: 'production',
        JWT_ACCESS_SECRET: '',
        JWT_REFRESH_SECRET: '',
      }),
    ).toThrow(/Missing required production secrets/);
  });

  it('rejects JWT secrets that are too short to be safe', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, JWT_ACCESS_SECRET: 'too-short' })).toThrow(
      /at least 32 characters/,
    );
  });

  it('rejects an unsupported log level', () => {
    expect(() => validateEnvironment({ ...VALID_ENV, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });
});

describe('resolveLogLevels', () => {
  it('enables the requested level and everything more severe', () => {
    expect(resolveLogLevels('error')).toEqual(['error']);
    expect(resolveLogLevels('warn')).toEqual(['error', 'warn']);
    expect(resolveLogLevels('debug')).toEqual(['error', 'warn', 'log', 'debug']);
    expect(resolveLogLevels('verbose')).toEqual(['error', 'warn', 'log', 'debug', 'verbose']);
  });
});

describe('buildCorsOptions', () => {
  const createConfigService = (values: Record<string, unknown>): ConfigService =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;

  const isAllowed = (options: ReturnType<typeof buildCorsOptions>, origin: string): boolean => {
    const originOption = options.origin;
    if (typeof originOption !== 'function') {
      throw new Error('CORS origin option must be a callback function');
    }

    let allowed = false;
    originOption(origin, (_error: Error | null, result?: unknown) => {
      allowed = result === true;
    });
    return allowed;
  };

  it('allows configured origins in production and refuses unknown ones', () => {
    const options = buildCorsOptions(
      createConfigService({ NODE_ENV: 'production', CORS_ORIGINS: 'https://shopino.ir' }),
    );

    expect(isAllowed(options, 'https://shopino.ir')).toBe(true);
    expect(isAllowed(options, 'https://evil.example')).toBe(false);
  });

  it('allows local origins in development even when CORS_ORIGINS is empty', () => {
    const options = buildCorsOptions(createConfigService({ NODE_ENV: 'development', CORS_ORIGINS: '' }));

    expect(isAllowed(options, 'http://localhost:3000')).toBe(true);
    expect(isAllowed(options, 'https://3000-abc123.e2b.app')).toBe(true);
    expect(isAllowed(options, 'https://evil.example')).toBe(false);
  });

  it('parses a comma separated allow-list and ignores blank entries', () => {
    expect(parseOriginList(' https://a.example , ,https://b.example ')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
```


### `apps/backend/src/config/env.validation.ts`

```ts
import { Logger } from '@nestjs/common';
import { plainToInstance, Type } from 'class-transformer';
import {
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

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/\S+$/;
const SECRET_KEYS = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET'] as const;
const OPTIONAL_KEYS: readonly string[] = [...SECRET_KEYS, 'CORS_ORIGINS', 'LOG_LEVEL'];

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

  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_ACCESS_SECRET must be at least ${MIN_SECRET_LENGTH} characters when it is set`,
  })
  JWT_ACCESS_SECRET?: string;

  @IsOptional()
  @IsString()
  @MinLength(MIN_SECRET_LENGTH, {
    message: `JWT_REFRESH_SECRET must be at least ${MIN_SECRET_LENGTH} characters when it is set`,
  })
  JWT_REFRESH_SECRET?: string;

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
 * - Structural problems (missing/invalid values) always fail the boot.
 * - Secrets are mandatory in production and a loud warning in development, so
 *   feature work can continue before the security review hands over real keys.
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

  assertSecrets(config, logger);
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

function assertSecrets(config: EnvironmentVariables, logger: Pick<Logger, 'warn'>): void {
  const missing = SECRET_KEYS.filter((key) => config[key] === undefined);
  if (missing.length === 0) {
    return;
  }

  const guidance = `Set ${missing.join(', ')} — generate values with "openssl rand -base64 48".`;
  if (config.NODE_ENV === NodeEnvironment.Production) {
    throw new Error(`Missing required production secrets. ${guidance}`);
  }
  logger.warn(`Missing secrets. ${guidance} Required before any non-local deployment.`);
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


### `apps/backend/src/config/logger.config.ts`

```ts
import type { LogLevel } from '@nestjs/common';
import { LOG_LEVELS, type LogLevelName } from './env.validation';

/**
 * Expands a single `LOG_LEVEL` into the Nest logger levels it implies:
 * `warn` enables error+warn, `debug` enables error+warn+log+debug, and so on.
 */
export function resolveLogLevels(level: LogLevelName): LogLevel[] {
  const threshold = LOG_LEVELS.indexOf(level);
  if (threshold === -1) {
    throw new Error(`Unsupported log level: ${level}`);
  }
  return [...LOG_LEVELS.slice(0, threshold + 1)];
}
```


### `apps/backend/src/infra/health/health.controller.ts`

```ts
import { Controller, Get } from '@nestjs/common';
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

@ApiTags('health')
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


### `apps/backend/src/infra/health/health.module.ts`

```ts
import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { UptimeHealthIndicator } from './indicators/uptime.health';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, RedisHealthIndicator, UptimeHealthIndicator],
})
export class HealthModule {}
```


### `apps/backend/src/infra/health/indicators/database.health.ts`

```ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { errorMessage, toMilliseconds } from '../../../common/utils';
import { PrismaService } from '../../prisma/prisma.service';

/** Verifies that PostgreSQL answers a real query through Prisma. */
@Injectable()
export class DatabaseHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    const startedAt = process.hrtime.bigint();
    try {
      await this.prisma.ping();
      return this.getStatus(key, true, {
        latency_ms: toMilliseconds(process.hrtime.bigint() - startedAt),
      });
    } catch (error) {
      return this.getStatus(key, false, { message: errorMessage(error) });
    }
  }
}
```


### `apps/backend/src/infra/health/indicators/redis.health.ts`

```ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';
import { errorMessage } from '../../../common/utils';
import { RedisService } from '../../redis/redis.service';

/** Verifies that Redis answers an authenticated `PING`. */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly redis: RedisService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      const latencyMs = await this.redis.ping();
      return this.getStatus(key, true, { latency_ms: latencyMs });
    } catch (error) {
      return this.getStatus(key, false, { message: errorMessage(error) });
    }
  }
}
```


### `apps/backend/src/infra/health/indicators/uptime.health.ts`

```ts
import { Injectable } from '@nestjs/common';
import { HealthIndicator, type HealthIndicatorResult } from '@nestjs/terminus';

/**
 * Reports process uptime. Load balancers and operators use it to tell a fresh,
 * still-warming instance apart from a long-running one.
 */
@Injectable()
export class UptimeHealthIndicator extends HealthIndicator {
  isHealthy(key: string): HealthIndicatorResult {
    const uptimeSeconds = Math.floor(process.uptime());
    return this.getStatus(key, true, {
      uptime_seconds: uptimeSeconds,
      started_at: new Date(Date.now() - uptimeSeconds * 1_000).toISOString(),
    });
  }
}
```


### `apps/backend/src/infra/prisma/prisma.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

/**
 * Global infrastructure module: every feature module may inject `PrismaService`
 * without re-importing this module.
 */
@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```


### `apps/backend/src/infra/prisma/prisma.service.ts`

```ts
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { errorMessage } from '../../common/utils';

const CONNECT_MAX_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 1_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      datasourceUrl: config.getOrThrow<string>('DATABASE_URL'),
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Executes a trivial query; used by the health check and by operational probes. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /**
   * A dependency that is down must not turn into a crash loop, otherwise the
   * process can never serve `/api/v1/health` and operators lose their signal.
   * The API therefore retries briefly and then keeps running with a loud error;
   * every database-backed request fails with 5xx until the connection recovers.
   */
  private async connectWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.$connect();
        this.logger.log('PostgreSQL connection established');
        return;
      } catch (error) {
        const message = errorMessage(error);
        if (attempt === CONNECT_MAX_ATTEMPTS) {
          this.logger.error(
            `PostgreSQL unreachable after ${CONNECT_MAX_ATTEMPTS} attempts: ${message}`,
          );
          return;
        }
        this.logger.warn(`PostgreSQL connection attempt ${attempt}/${CONNECT_MAX_ATTEMPTS} failed: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
      }
    }
  }
}
```


### `apps/backend/src/infra/redis/redis.module.ts`

```ts
import { Global, Module } from '@nestjs/common';
import { RedisService } from './redis.service';

/**
 * Global infrastructure module owning the single Redis connection of the
 * process. Feature modules (cache, rate limiting, queues) inject `RedisService`
 * from here.
 */
@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
```


### `apps/backend/src/infra/redis/redis.service.ts`

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
  private readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis({
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

    this.client.on('ready', () => this.logger.log('Redis connection established'));
    this.client.on('error', (error: Error) => this.logger.error(`Redis error: ${error.message}`));
  }

  /** Sends `PING` and returns the round-trip time in milliseconds. */
  async ping(): Promise<number> {
    const startedAt = process.hrtime.bigint();
    const reply: string = await this.client.ping();
    if (reply !== 'PONG') {
      throw new Error(`Unexpected Redis PING reply: ${reply}`);
    }
    return toMilliseconds(process.hrtime.bigint() - startedAt);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client.status === 'end') {
      return;
    }
    await this.client.quit();
  }
}
```


### `apps/backend/src/infra/security/password.spec.ts`

```ts
import { hashPassword, isArgon2idHash, verifyPassword, MIN_PASSWORD_LENGTH } from './password';

const STRONG_PASSWORD = 'correct-horse-battery-staple';

describe('password hashing', () => {
  it('produces an Argon2id hash that never contains the plaintext', async () => {
    const stored = await hashPassword(STRONG_PASSWORD);

    expect(isArgon2idHash(stored)).toBe(true);
    expect(stored).not.toContain(STRONG_PASSWORD);
  });

  it('salts every hash, so identical passwords produce different digests', async () => {
    const first = await hashPassword(STRONG_PASSWORD);
    const second = await hashPassword(STRONG_PASSWORD);

    expect(first).not.toBe(second);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const stored = await hashPassword(STRONG_PASSWORD);

    await expect(verifyPassword(stored, STRONG_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(stored, 'wrong-password-value')).resolves.toBe(false);
  });

  it('refuses passwords below the minimum length', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(
      /at least 12 characters/,
    );
  });
});
```


### `apps/backend/src/infra/security/password.ts`

```ts
import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Password hashing for platform credentials.
 *
 * Argon2id with the OWASP-recommended baseline (19 MiB memory, 2 iterations,
 * 1 degree of parallelism). The same helper is used by the deterministic seed
 * and, from the authentication phase onwards, by credential verification — one
 * implementation, one parameter set, no drift between environments.
 */
export const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Minimum length accepted for a platform password. */
export const MIN_PASSWORD_LENGTH = 12;

const ARGON2ID_PREFIX = '$argon2id$';

/**
 * Hashes a plaintext password. Never store the input anywhere else.
 *
 * Declared `async` on purpose: an invalid input becomes a rejected promise, so
 * callers handle every failure through one path instead of guarding against a
 * synchronous throw that could escape an awaited call chain.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  if (plainPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  return hash(plainPassword, ARGON2_OPTIONS);
}

/** Constant-time verification of a password against a stored hash. */
export function verifyPassword(storedHash: string, plainPassword: string): Promise<boolean> {
  return verify(storedHash, plainPassword);
}

/** True when the stored value is an Argon2id hash produced by {@link hashPassword}. */
export function isArgon2idHash(value: string): boolean {
  return value.startsWith(ARGON2ID_PREFIX);
}
```


### `apps/backend/src/main.ts`

```ts
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { GLOBAL_API_PREFIX, SWAGGER_PATH } from './common/constants';
import type { LogLevelName } from './config/env.validation';
import { resolveLogLevels } from './config/logger.config';
import { applyGlobalPolicies, setupSwagger } from './setup/app.setup';

const REQUEST_BODY_LIMIT_BYTES = 1_048_576;

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    // Set only when the API is deployed behind a reverse proxy/tunnel that
    // terminates TLS; the proxy must overwrite X-Forwarded-* headers itself.
    trustProxy: true,
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  const config = app.get(ConfigService);
  app.useLogger(resolveLogLevels(config.getOrThrow<LogLevelName>('LOG_LEVEL')));
  app.enableShutdownHooks();

  applyGlobalPolicies(app, config);
  setupSwagger(app);

  const port = config.getOrThrow<number>('PORT');
  const host = config.getOrThrow<string>('HOST');

  await app.listen({ port, host });

  Logger.log(
    `Shopino API ready on http://${host}:${port}/${GLOBAL_API_PREFIX} — docs: http://${host}:${port}/${SWAGGER_PATH}`,
    'Bootstrap',
  );
}

void bootstrap();
```


### `apps/backend/src/setup/app.setup.ts`

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
        'Multi-vendor marketplace with banking credit (BNPL). Every endpoint is namespaced under /api/v1.',
      )
      .setVersion('1.0.0')
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


### `apps/backend/test/health.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification against the real infrastructure: this suite talks to
 * the PostgreSQL and Redis instances started by docker-compose — nothing is
 * stubbed. Run `docker compose up -d` first, then
 * `pnpm --filter @shopino/backend run test:e2e`.
 *
 * Note on Swagger: the DocumentBuilder contract is asserted here, while the
 * served UI is verified over HTTP by `pnpm run verify:http` (see
 * scripts/smoke-http.ts). Serving the UI pulls in @fastify/static → glob@13,
 * which is ESM-only: Node 22 loads it through require(esm), whereas Jest's
 * CommonJS runtime cannot, so the HTTP layer is exercised where it actually
 * matters — against a running server.
 */
describe('Health endpoint (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    const config = app.get(ConfigService);
    applyGlobalPolicies(app, config);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health reports database and redis as up', async () => {
    const response = await app.inject({ method: 'GET', url: `/${GLOBAL_API_PREFIX}/health` });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ status: string; info: Record<string, { status: string }> }>();
    expect(body.status).toBe('ok');
    expect(body.info.database?.status).toBe('up');
    expect(body.info.redis?.status).toBe('up');
    expect(body.info.memory?.status).toBe('up');
    expect(body.info.uptime?.status).toBe('up');
  });

  it('publishes the health route in the OpenAPI document', () => {
    const document = buildOpenApiDocument(app);

    expect(document.info.title).toBe('Shopino API');
    expect(Object.keys(document.paths)).toContain(`/${GLOBAL_API_PREFIX}/health`);
  });

  it('rejects unknown routes with 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/${GLOBAL_API_PREFIX}/does-not-exist`,
    });

    expect(response.statusCode).toBe(404);
  });
});
```


### `apps/backend/test/jest-e2e.json`

```json
{
  "moduleFileExtensions": ["js", "json", "ts"],
  "rootDir": ".",
  "testEnvironment": "node",
  "testRegex": ".e2e-spec.ts$",
  "setupFiles": ["<rootDir>/setup-env.ts"],
  "transform": {
    "^.+\\.(t|j)s$": [
      "ts-jest",
      {
        "tsconfig": "<rootDir>/../tsconfig.json"
      }
    ]
  },
  "testTimeout": 30000
}
```


### `apps/backend/test/seed.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { UserRole } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { seedDatabase, normalizeEmail } from '../prisma/seed';
import { isArgon2idHash, verifyPassword } from '../src/infra/security/password';
import { PrismaService } from '../src/infra/prisma/prisma.service';

/**
 * Runs the deterministic seed against the real PostgreSQL instance and asserts
 * the guarantees the development workflow depends on. Nothing is mocked: the
 * seed is executed twice on the live database.
 */
describe('Seed (e2e, real PostgreSQL)', () => {
  let prisma: PrismaClient;
  let adminEmail: string;

  beforeAll(() => {
    const config = new ConfigService(process.env);
    prisma = new PrismaService(config);
    adminEmail = normalizeEmail(process.env.SUPER_ADMIN_EMAIL ?? '');
    if (adminEmail === '') {
      throw new Error('SUPER_ADMIN_EMAIL must be defined (the seed loads it from the root .env).');
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('creates the master data on the first run', async () => {
    await seedDatabase(prisma);

    const admin = await prisma.user.findUnique({ where: { email: adminEmail } });
    expect(admin).not.toBeNull();
    expect(admin?.role).toBe(UserRole.SUPER_ADMIN);
    expect(admin?.isActive).toBe(true);

    await expect(prisma.category.count({ where: { parentId: null } })).resolves.toBeGreaterThan(0);
    await expect(prisma.category.count()).resolves.toBeGreaterThan(0);
    await expect(prisma.systemConfig.count()).resolves.toBeGreaterThan(0);
  });

  it('stores the credential as an Argon2id hash that verifies the configured password', async () => {
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });

    expect(isArgon2idHash(admin.passwordHash)).toBe(true);
    expect(admin.passwordHash).not.toContain(process.env.SUPER_ADMIN_PASSWORD ?? '__none__');
    await expect(verifyPassword(admin.passwordHash, process.env.SUPER_ADMIN_PASSWORD ?? '')).resolves.toBe(
      true,
    );
  });

  it('is idempotent: a second run keeps every count and the password hash stable', async () => {
    const before = {
      users: await prisma.user.count(),
      categories: await prisma.category.count(),
      configs: await prisma.systemConfig.count(),
      admin: await prisma.user.findUniqueOrThrow({
        where: { email: adminEmail },
        select: { passwordHash: true, updatedAt: true },
      }),
    };

    await seedDatabase(prisma);

    expect(await prisma.user.count()).toBe(before.users);
    expect(await prisma.category.count()).toBe(before.categories);
    expect(await prisma.systemConfig.count()).toBe(before.configs);

    const after = await prisma.user.findUniqueOrThrow({
      where: { email: adminEmail },
      select: { passwordHash: true },
    });
    expect(after.passwordHash).toBe(before.admin.passwordHash);
  });

  it('links child categories to their parent', async () => {
    const root = await prisma.category.findUniqueOrThrow({
      where: { slug: 'digital' },
      include: { children: true },
    });

    expect(root.children.length).toBeGreaterThan(0);
    expect(root.children.every((child) => child.parentId === root.id)).toBe(true);
  });

  it('keeps the credit feature flag off until BNPL ships', async () => {
    const flag = await prisma.systemConfig.findUniqueOrThrow({ where: { key: 'credit.enabled' } });

    expect(flag.value).toBe('false');
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
for (const envFilePath of resolveEnvFilePaths()) {
  loadDotenv({ path: envFilePath, override: false, quiet: true });
}
```


### `apps/backend/tsconfig.build.json`

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "declaration": false,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "test", "dist", "**/*.spec.ts"]
}
```


### `apps/backend/tsconfig.json`

```json
{
  "extends": "@shopino/config/tsconfig/nest.json",
  "compilerOptions": {
    "outDir": "./dist",
    "baseUrl": "./",
    "declaration": false,
    "removeComments": false,
    "types": ["node", "jest"]
  },
  "include": ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```


### `apps/frontend/eslint.config.mjs`

```js
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FlatCompat } from '@eslint/eslintrc';

const currentDirectory = dirname(fileURLToPath(import.meta.url));
const compat = new FlatCompat({ baseDirectory: currentDirectory });

const config = [
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts'],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
];

export default config;
```


### `apps/frontend/next.config.ts`

```ts
import path from 'node:path';

import { loadEnvConfig } from '@next/env';
import type { NextConfig } from 'next';

/**
 * The repository keeps a single `.env` at its root, shared with the backend and
 * docker-compose. Next.js only reads environment files from its own project
 * directory, so the workspace root is loaded explicitly here.
 */
const workspaceRoot = path.resolve(process.cwd(), '..', '..');
loadEnvConfig(workspaceRoot, process.env.NODE_ENV !== 'production');

const backendInternalUrl = (process.env.BACKEND_INTERNAL_URL ?? 'http://127.0.0.1:4000').replace(
  /\/+$/,
  '',
);

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
  async rewrites() {
    // The browser talks to the Next.js origin only. Requests under /api/* are
    // forwarded server-side to the backend, which keeps the API on a single
    // public origin (no CORS in the browser, no backend URL in client bundles).
    return [
      {
        source: '/api/:path*',
        destination: `${backendInternalUrl}/api/:path*`,
      },
    ];
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
    "next": "^15.5.26",
    "react": "^19.3.0",
    "react-dom": "^19.3.0"
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


### `apps/frontend/postcss.config.mjs`

```js
/** Tailwind CSS v4 is wired in through its PostCSS plugin. */
const config = {
  plugins: {
    '@tailwindcss/postcss': {},
  },
};

export default config;
```


### `apps/frontend/src/app/globals.css`

```css
@import "tailwindcss";

/*
 * Shopino design tokens. Persian text needs a font stack with full Arabic
 * script coverage; Vazirmatn/IRANSans are preferred when the operating system
 * provides them, with Tahoma as the widely available fallback.
 */
@theme {
  --font-sans: "Vazirmatn", "IRANSansX", "IRANSans", "Segoe UI", Tahoma, system-ui, sans-serif;

  --color-brand-50: #eff6ff;
  --color-brand-100: #dbeafe;
  --color-brand-500: #2563eb;
  --color-brand-600: #1d4ed8;
  --color-brand-700: #1e40af;

  --color-surface: #ffffff;
  --color-surface-muted: #f8fafc;
}

html {
  color-scheme: light;
}

body {
  font-family: var(--font-sans);
}
```


### `apps/frontend/src/app/layout.tsx`

```tsx
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: 'شاپینو | وضعیت سامانه',
  description: 'پلتفرم چندفروشندگی شاپینو با امکان خرید اعتباری (BNPL)',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    // dir="rtl" + lang="fa": the whole application is right-to-left by default,
    // and Tailwind's logical utilities (ps-*, pe-*, ms-*, me-*, text-start…)
    // follow this direction automatically.
    <html lang="fa" dir="rtl">
      <body className="min-h-screen bg-surface-muted text-slate-900 antialiased">{children}</body>
    </html>
  );
}
```


### `apps/frontend/src/app/page.tsx`

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


### `apps/frontend/src/components/system-health-panel.tsx`

```tsx
'use client';

import { useCallback, useEffect, useState } from 'react';

import { ApiError } from '@/lib/api/errors';
import { getSystemHealth, type HealthIndicatorDetail, type SystemHealth } from '@/lib/api/health';

/** Auto-refresh cadence of the panel. */
const REFRESH_INTERVAL_MS = 15_000;

const CHECK_LABELS: Record<string, string> = {
  database: 'پایگاه داده (PostgreSQL)',
  redis: 'ردیس (Redis)',
  memory: 'حافظهٔ پردازش',
  uptime: 'زمان فعالیت سرویس',
};

interface SystemHealthPanelProps {
  initialHealth: SystemHealth | null;
  initialError: string | null;
}

function isSystemHealth(value: unknown): value is SystemHealth {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<SystemHealth>;
  return typeof candidate.status === 'string' && typeof candidate.details === 'object';
}

function formatDetailValue(key: string, detail: HealthIndicatorDetail): string {
  if (detail.latency_ms !== undefined) {
    return `زمان پاسخ: ${detail.latency_ms.toLocaleString('fa-IR')} میلی‌ثانیه`;
  }
  if (key === 'uptime' && detail.uptime_seconds !== undefined) {
    const minutes = Math.floor(detail.uptime_seconds / 60);
    const seconds = detail.uptime_seconds % 60;
    return `فعال از ${minutes.toLocaleString('fa-IR')} دقیقه و ${seconds.toLocaleString('fa-IR')} ثانیه پیش`;
  }
  if (detail.message !== undefined) {
    return detail.message;
  }
  return '';
}

/**
 * Live status of the API and its dependencies. The first render uses the report
 * fetched on the server; afterwards the browser polls the backend through the
 * same-origin `/api/v1` proxy and can be refreshed manually.
 */
export function SystemHealthPanel({ initialHealth, initialError }: SystemHealthPanelProps) {
  const [health, setHealth] = useState<SystemHealth | null>(initialHealth);
  const [error, setError] = useState<string | null>(initialError);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    setIsRefreshing(true);
    try {
      const report = await getSystemHealth();
      setHealth(report);
      setError(null);
    } catch (caught) {
      const apiError =
        caught instanceof ApiError ? caught : new ApiError(String(caught), { kind: 'unknown' });

      // A 503 from the health endpoint is still a full report: the API is up
      // but a dependency is down. Render that report instead of a bare error.
      if (apiError.status === 503 && isSystemHealth(apiError.details)) {
        setHealth(apiError.details);
        setError(null);
      } else {
        setError(apiError.message);
        setHealth(null);
      }
    } finally {
      setLastUpdatedAt(new Date().toLocaleTimeString('fa-IR'));
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      void refresh();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const isHealthy = health?.status === 'ok';
  const checks = Object.entries(health?.details ?? {});

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-surface p-6 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`inline-flex h-3 w-3 rounded-full ${
              isHealthy ? 'bg-emerald-500' : error !== null ? 'bg-rose-500' : 'bg-amber-500'
            }`}
            aria-hidden="true"
          />
          <div className="flex flex-col">
            <span className="font-semibold text-slate-900">
              {error !== null ? 'عدم دسترسی به API' : isHealthy ? 'سامانه سالم است' : 'سامانه در وضعیت ناسالم'}
            </span>
            <span className="text-xs text-slate-500">
              {lastUpdatedAt === null ? 'در حال دریافت وضعیت…' : `آخرین بروزرسانی: ${lastUpdatedAt}`}
            </span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            void refresh();
          }}
          disabled={isRefreshing}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isRefreshing ? 'در حال بررسی…' : 'بررسی مجدد'}
        </button>
      </div>

      {error !== null ? (
        <p className="rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
          {error}
        </p>
      ) : null}

      {checks.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2">
          {checks.map(([key, detail]) => (
            <li
              key={key}
              className="flex flex-col gap-1 rounded-xl border border-slate-200 bg-surface-muted px-4 py-3"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium text-slate-800">
                  {CHECK_LABELS[key] ?? key}
                </span>
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                    detail.status === 'up'
                      ? 'bg-emerald-100 text-emerald-700'
                      : 'bg-rose-100 text-rose-700'
                  }`}
                >
                  {detail.status === 'up' ? 'سالم' : 'ناسالم'}
                </span>
              </div>
              <span className="text-xs leading-5 text-slate-500">
                {formatDetailValue(key, detail)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
```


### `apps/frontend/src/lib/api/client.ts`

```ts
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { resolvePublicApiBaseUrl } from '../env';
import { toApiError } from './errors';

/** Upper bound for a browser request before it is reported as a timeout. */
export const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Creates an axios instance that always talks to the Shopino API and never
 * leaks transport-specific errors to the callers: every rejection is an
 * {@link import('./errors').ApiError}.
 */
export function createApiClient(baseURL: string = resolvePublicApiBaseUrl()): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    withCredentials: true,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  instance.interceptors.response.use(
    (response) => response,
    (error: unknown) => Promise.reject(toApiError(error)),
  );

  return instance;
}

/** Shared client for browser components. */
export const apiClient = createApiClient();

export async function apiGet<TResponse>(
  path: string,
  config?: AxiosRequestConfig,
): Promise<TResponse> {
  const { data } = await apiClient.get<TResponse>(path, config);
  return data;
}

export async function apiPost<TResponse, TBody = unknown>(
  path: string,
  body: TBody,
  config?: AxiosRequestConfig,
): Promise<TResponse> {
  const { data } = await apiClient.post<TResponse>(path, body, config);
  return data;
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

  it('maps a 5xx response to a server error', () => {
    const error = toApiError(
      axiosErrorWith({
        code: 'ERR_BAD_RESPONSE',
        response: { status: 503, data: { statusCode: 503, message: 'Service Unavailable' } },
      }),
    );

    expect(error.kind).toBe('http');
    expect(error.isServerError).toBe(true);
    expect(error.message).toBe('Service Unavailable');
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
  it('uses the backend message and keeps the payload available as details', () => {
    const body = { statusCode: 503, message: 'database is down' };
    const error = toApiErrorFromResponse(new Response(JSON.stringify(body), { status: 503 }), body);

    expect(error.status).toBe(503);
    expect(error.message).toBe('database is down');
    expect(error.details).toEqual(body);
  });

  it('falls back to a generic message when the body carries none', () => {
    const error = toApiErrorFromResponse(new Response(null, { status: 502 }), undefined);

    expect(error.message).toContain('502');
    expect(error.kind).toBe('http');
  });
});
```


### `apps/frontend/src/lib/api/errors.ts`

```ts
import axios from 'axios';

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
    return new ApiError(messageFromBody(data) ?? `درخواست با خطای ${status} رد شد.`, {
      kind: 'http',
      status,
      code: readNestErrorBody(data)?.error,
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
  return new ApiError(messageFromBody(details) ?? `درخواست با خطای ${response.status} رد شد.`, {
    kind: 'http',
    status: response.status,
    details,
  });
}
```


### `apps/frontend/src/lib/api/health.server.ts`

```ts
import { resolveBackendInternalUrl } from '../env';
import { ApiError, toApiError, toApiErrorFromResponse } from './errors';
import type { SystemHealth } from './health';

const SERVER_FETCH_TIMEOUT_MS = 5_000;

/**
 * Server-side variant of the health call, used for the first render of the
 * status page. It reaches the backend directly (never through the browser) and
 * can run in two modes:
 *
 * - `required` (default for the status page): a failure throws an ApiError so
 *   the caller can render an explicit error state.
 * - `optional`: failures resolve to `null`, e.g. for progressive enhancement.
 */
export async function getSystemHealthServerSide(): Promise<SystemHealth> {
  const endpoint = `${resolveBackendInternalUrl()}/api/v1/health`;

  try {
    const response = await fetch(endpoint, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(SERVER_FETCH_TIMEOUT_MS),
    });

    const body: unknown = await response.json().catch(() => undefined);

    // A 503 still carries a useful report: the API is up but a dependency is
    // down, which is exactly what the status page must display.
    if (!response.ok && body === undefined) {
      throw toApiErrorFromResponse(response, body);
    }

    return body as SystemHealth;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw toApiError(error);
  }
}
```


### `apps/frontend/src/lib/api/health.ts`

```ts
import { apiGet } from './client';

export type HealthCheckStatus = 'up' | 'down';
export type HealthReportStatus = 'ok' | 'error' | 'shutting_down';

/** Payload of a single terminus indicator. */
export interface HealthIndicatorDetail {
  status: HealthCheckStatus;
  latency_ms?: number;
  uptime_seconds?: number;
  started_at?: string;
  message?: string;
}

/** Response shape of `GET /api/v1/health` (see @nestjs/terminus). */
export interface SystemHealth {
  status: HealthReportStatus;
  info?: Record<string, HealthIndicatorDetail>;
  error?: Record<string, HealthIndicatorDetail>;
  details: Record<string, HealthIndicatorDetail>;
}

/** Fetches the backend health report from the browser. */
export async function getSystemHealth(): Promise<SystemHealth> {
  return apiGet<SystemHealth>('/health');
}
```


### `apps/frontend/src/lib/env.ts`

```ts
/**
 * Typed access to the environment values the frontend depends on. Keeping the
 * defaults and the production checks in one module means a misconfigured
 * deployment fails loudly instead of silently calling the wrong host.
 */

const DEFAULT_API_BASE_URL = '/api/v1';
const LOCAL_BACKEND_INTERNAL_URL = 'http://127.0.0.1:4000';

/** Base URL used by the browser. Relative by default → same-origin proxy. */
export function resolvePublicApiBaseUrl(): string {
  const value = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (value === undefined || value === '') {
    return DEFAULT_API_BASE_URL;
  }
  return stripTrailingSlashes(value);
}

/**
 * URL the Next.js server uses to reach the backend (rewrites, server-side
 * rendering). Falls back to localhost in development only: a production build
 * must never guess where its API lives.
 */
export function resolveBackendInternalUrl(): string {
  const value = process.env.BACKEND_INTERNAL_URL?.trim();
  if (value === undefined || value === '') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('BACKEND_INTERNAL_URL must be set for production deployments.');
    }
    return LOCAL_BACKEND_INTERNAL_URL;
  }
  return stripTrailingSlashes(value);
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}
```


### `apps/frontend/tsconfig.json`

```json
{
  "extends": "@shopino/config/tsconfig/next.json",
  "compilerOptions": {
    "baseUrl": ".",
    "paths": {
      "@/*": ["./src/*"]
    },
    "plugins": [{ "name": "next" }],
    "incremental": true
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```


### `apps/frontend/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
  },
});
```


### `docker-compose.override.yml`

```yaml
# ============================================================================
# Shopino — DEVELOPMENT OVERRIDE  (never used in production / CI)
# ----------------------------------------------------------------------------
# Compose automatically merges this file when it is named
# `docker-compose.override.yml` and lives next to `docker-compose.yml`, so a
# plain `docker compose up -d` gives you the development setup.
#
# Production and CI MUST pin the base file explicitly, otherwise they would
# silently pick up development persistence:
#
#     docker compose -f docker-compose.yml up -d      (see `pnpm infra:up:prod`)
#
# What changes here (decision: Strategy B — dedicated development mount):
#   named volumes  →  bind mounts under ./.docker-data/
# so database content survives container removal *and* stays visible in the
# repository workspace, while the base file keeps production semantics.
#
# Before the first start, run `pnpm infra:prepare` (or `pnpm infra:up`, which
# does it for you). It creates the directories and — on Linux — gives them to
# the container users (postgres 999, redis 999), because Docker creates missing
# bind-mount directories as root and the database would refuse to initialise.
# ============================================================================

services:
  postgres:
    volumes:
      # Same container path as the base file, so Compose replaces the named
      # volume with this bind mount instead of stacking a second mount.
      - ./.docker-data/postgres:/var/lib/postgresql/data

  redis:
    volumes:
      - ./.docker-data/redis:/data
```


### `docker-compose.yml`

```yaml
# ============================================================================
# Shopino — infrastructure services (PRODUCTION / CI STANDARD)
# ----------------------------------------------------------------------------
# PostgreSQL 16 (application database) and Redis 7 (cache / rate-limit / queue
# backend) with durable named volumes.
#
#   Development :  pnpm infra:up        → this file + docker-compose.override.yml
#                  (Compose auto-loads the override when it sits next to this file)
#   Production  :  docker compose -f docker-compose.yml up -d      ← pin the file
#   CI          :  docker compose -f docker-compose.yml up -d      ← pin the file
#
# Always pass `-f docker-compose.yml` explicitly outside development: the
# override redirects persistence to ./.docker-data, which is a development-only
# concern. See `pnpm infra:up:prod`.
#
# Credentials come from .env (see .env.example); nothing secret is stored here.
# Missing variables fail the start instead of silently using a weak default.
# ============================================================================

name: shopino

services:
  postgres:
    image: postgres:16
    container_name: shopino_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:?POSTGRES_USER is required in .env}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required in .env}
      POSTGRES_DB: ${POSTGRES_DB:?POSTGRES_DB is required in .env}
      # Checksums detect silent on-disk corruption; set once, at initdb time.
      POSTGRES_INITDB_ARGS: "--data-checksums"
      # Keep the cluster in a subdirectory so the volume root stays clean.
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      # Bound to loopback: reachable by apps on this host, never exposed to the
      # network. A deployed environment keeps it on a private network instead.
      - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U \"$$POSTGRES_USER\" -d \"$$POSTGRES_DB\""]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    networks:
      - shopino_network
    deploy:
      resources:
        limits:
          memory: 768M

  redis:
    image: redis:7-alpine
    container_name: shopino_redis
    restart: unless-stopped
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?REDIS_PASSWORD is required in .env}
    # AUTH required on every connection; AOF keeps data across restarts.
    command:
      - redis-server
      - --requirepass
      - ${REDIS_PASSWORD:?REDIS_PASSWORD is required in .env}
      - --appendonly
      - "yes"
      - --appendfsync
      - everysec
      - --maxmemory
      - 256mb
      # noeviction: Redis is the future job-queue backend (BullMQ), where silent
      # key eviction would corrupt in-flight work. Writes fail loudly instead,
      # and the health endpoint surfaces the problem.
      - --maxmemory-policy
      - noeviction
      - --save
      - ""
    ports:
      - "127.0.0.1:${REDIS_PORT:-6379}:6379"
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli --no-auth-warning -a \"$$REDIS_PASSWORD\" ping | grep -q PONG"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 10s
    networks:
      - shopino_network
    deploy:
      resources:
        limits:
          memory: 320M

volumes:
  # Logical names; Compose prefixes them with the project name (shopino_*).
  postgres_data:
  redis_data:

networks:
  shopino_network:
    name: shopino_network
    driver: bridge
```


### `docs/phase-1-verification.md`

```markdown
# Shopino — Phase 1 verification report (rev. 2 — approved architecture)

**Scope:** infrastructure setup and monorepo architecture, implemented against the approved
architectural decisions (pnpm 9.x · Strategy B persistence · Prisma migrations as source of truth ·
deterministic seed).
**Status:** every acceptance criterion verified against real services. No mock, fake, stub or
hard-coded runtime data anywhere in the running system.
**Reported by:** AI Software Developer · **Date:** 2026-09-26 12:51 UTC

Secrets are never printed: they live in the git-ignored `.env` and were generated with `openssl rand`.
Password hashes are shown truncated.

---

## 1. Acceptance criteria — result

| # | Criterion | Result | Evidence |
| --- | --- | --- | --- |
| 1 | `docker compose up -d` brings up Postgres + Redis `healthy` | **PASS** | §2 |
| 2 | Prisma connects to PostgreSQL | **PASS** | §3 (`migrate dev` + `verify:connections` reaching PostgreSQL 16.15) |
| 3 | Backend starts on port 4000 without errors | **PASS** | §4 (startup log + mapped route) |
| 4 | `GET /api/v1/health` → `200` with database/redis `up` | **PASS** | §5 (plus a negative test proving the checks are real) |
| 5 | Swagger docs load at `/api/docs` | **PASS** | §6 |
| 6 | Frontend starts on port 3000 without errors | **PASS** | §7 (SSR page, RTL, live API data, same-origin proxy) |
| 7 | Decision 1 — pnpm workspaces + Turborepo task graph incl. `db:generate`, `db:push` | **PASS** | §8 |
| 8 | Decision 2 — Strategy B: base volumes + dev override in `./.docker-data` (git-ignored) | **PASS** | §9 (persistence survives container removal) |
| 9 | Decision 2 — migrations as source of truth + deterministic idempotent seed | **PASS** | §10, §11, §12 (wipe → `db:reset` → full recovery) |


## 2. Infrastructure

```bash
docker compose up -d
docker compose ps
```


#### Result

```text
### docker compose ps
shopino_postgres → Up 2 minutes (healthy)
shopino_redis → Up 2 minutes (healthy)
```


## 3. Prisma ↔ PostgreSQL (and Redis) connectivity

```bash
pnpm db:generate
pnpm db:migrate --name init
pnpm verify:connections
```


#### Migration created and applied

```text
$ pnpm exec prisma migrate dev --name init
Datasource "db": PostgreSQL database "shopino_db", schema "public" at "127.0.0.1:5432"

Applying migration `20260926124703_init`

The following migration(s) have been created and applied from new schema changes:

prisma/migrations/
  └─ 20260926124703_init/
    └─ migration.sql

Your database is now in sync with your schema.
```


#### `pnpm verify:connections` (real server versions read over the wire)

```text
### pnpm verify:connections (real server versions over the wire)
[postgres] ok  database=shopino_db role=shopino
[postgres] PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
[redis]    ok  version=7.4.11 ping=1ms
[verify:connections] all infrastructure connections are healthy
```


## 4. Backend startup (port 4000)

```bash
pnpm --filter @shopino/backend build && pnpm --filter @shopino/backend start
```


#### Startup log (abridged)

```text
[NestFactory] Starting Nest application...
[InstanceLoader] AppModule / ConfigHostModule / ConfigModule / TerminusModule /
                PrismaModule / RedisModule / HealthModule dependencies initialized
[RoutesResolver] HealthController {/api/v1/health}
[RouterExplorer] Mapped {/api/v1/health, GET} route
[RedisService]  Redis connection established
[PrismaService] PostgreSQL connection established
[NestApplication] Nest application successfully started
[Bootstrap] Shopino API ready on http://0.0.0.0:4000/api/v1 — docs: http://0.0.0.0:4000/api/docs
```


## 5. Health endpoint — live output

```bash
curl http://localhost:4000/api/v1/health
```


#### HTTP headers + body

```http
HTTP/1.1 200 OK
vary: Origin
access-control-allow-credentials: true
access-control-expose-headers: X-Request-Id
cache-control: no-cache, no-store, must-revalidate
content-type: application/json; charset=utf-8
content-length: 441
Date: Sat, 26 Sep 2026 12:49:43 GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"status":"ok","info":{"database":{"status":"up","latency_ms":1.85},"redis":{"status":"up","latency_ms":1.08},"memory":{"status":"up"},"uptime":{"status":"up","uptime_seconds":20,"started_at":"2026-09-26T12:49:23.201Z"}},"error":{},"details":{"database":{"status":"up","latency_ms":1.85},"redis":{"status":"up","latency_ms":1.08},"memory":{"status":"up"},"uptime":{"status":"up","uptime_seconds":20,"started_at":"2026-09-26T12:49:23.201Z"}}}
```


#### Negative test — Redis stopped → 503, Redis restarted → 200 (same API process)

```text
########## NEGATIVE TEST: stop Redis, keep the API running ##########
$ curl -o body.json -w 'HTTP %{http_code}' http://localhost:4000/api/v1/health
HTTP 503
{
  "status": "error",
  "error": {
    "redis": {
      "status": "down",
      "message": "Command timed out"
    }
  },
  "database": {
    "status": "up",
    "latency_ms": 1.44
  }
}

########## RECOVERY: start Redis again (API process untouched) ##########
redis container health: healthy
HTTP 200
{
  "status": "ok",
  "database": {
    "status": "up",
    "latency_ms": 1.76
  },
  "redis": {
    "status": "up",
    "latency_ms": 0.91
  },
  "uptime_seconds": 71
}
```


#### The three verification scripts

```text
### pnpm verify:connections (real server versions over the wire)
[postgres] ok  database=shopino_db role=shopino
[postgres] PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
[redis]    ok  version=7.4.11 ping=1ms
[verify:connections] all infrastructure connections are healthy

### pnpm verify:seed (deterministic + idempotent + Argon2id)
[verify:seed] first run
[verify:seed]   users=1 categories=19 (roots=6) configs=5
[verify:seed] second run (idempotency check)
[verify:seed] ok — deterministic and idempotent; credential stored as Argon2id, no plaintext, admin created=false

### pnpm verify:http (public HTTP contract of the running API)
[ok]   GET /api/v1/health — HTTP 200 · status=ok · database=up · redis=up
[ok]   GET /api/docs-json — HTTP 200 · title=Shopino API · paths=/api/v1/health
[ok]   GET /api/docs — HTTP 200 · 3127 bytes · swagger-ui assets referenced=true
[ok]   GET /api/v1/definitely-not-a-route — HTTP 404
[verify:http] API at http://127.0.0.1:4000 passed all 4 checks
```


## 6. Swagger / OpenAPI

```bash
curl http://localhost:4000/api/docs && curl http://localhost:4000/api/docs-json
```


#### Result

```text
[ok]   GET /api/docs-json — HTTP 200 · title=Shopino API · paths=/api/v1/health
[ok]   GET /api/docs — HTTP 200 · 3127 bytes · swagger-ui assets referenced=true
[ok]   GET /api/docs (through the Next.js origin :3000) — HTTP 200
```


## 7. Frontend (port 3000)

```bash
pnpm --filter @shopino/frontend build && pnpm --filter @shopino/frontend dev
```


#### Served page + same-origin proxy

```text
### pnpm verify:connections (real server versions over the wire)
[postgres] ok  database=shopino_db role=shopino
[postgres] PostgreSQL 16.15 (Debian 16.15-1.pgdg13+2) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit
[redis]    ok  version=7.4.11 ping=1ms
[verify:connections] all infrastructure connections are healthy

### pnpm verify:seed (deterministic + idempotent + Argon2id)
[verify:seed] first run
[verify:seed]   users=1 categories=19 (roots=6) configs=5
[verify:seed] second run (idempotency check)
[verify:seed] ok — deterministic and idempotent; credential stored as Argon2id, no plaintext, admin created=false

### pnpm verify:http (public HTTP contract of the running API)
[ok]   GET /api/v1/health — HTTP 200 · status=ok · database=up · redis=up
[ok]   GET /api/docs-json — HTTP 200 · title=Shopino API · paths=/api/v1/health
[ok]   GET /api/docs — HTTP 200 · 3127 bytes · swagger-ui assets referenced=true
[ok]   GET /api/v1/definitely-not-a-route — HTTP 404
[verify:http] API at http://127.0.0.1:4000 passed all 4 checks
```


## 8. Decision 1 — pnpm workspaces and the Turborepo pipeline


#### Pipeline tasks exercised

```text
$ pnpm db:generate
@shopino/backend:db:generate: ✔ Generated Prisma Client (v6.19.3)
 Tasks:    1 successful, 1 total

$ pnpm db:seed
@shopino/backend:db:seed: [seed] master data ready — super admin: admin@shopino.local (created), categories: 19, system configs: 5
 Tasks:    1 successful, 1 total

$ pnpm typecheck      → Tasks: 2 successful, 2 total
$ pnpm lint           → Tasks: 2 successful, 2 total
$ pnpm test           → backend 16 passed / frontend 8 passed
$ pnpm test:e2e       → 2 suites, 8 tests passed (real PostgreSQL + Redis)
$ pnpm build          → Tasks: 2 successful, 2 total
```


## 9. Decision 2 — Strategy B persistence (verified two ways)

First, the merged configuration proves the separation: the development merge produces bind mounts, the production file produces named volumes.


#### Compose configuration resolution

```text
$ docker compose config                      # development (base + override auto-merged)
bind: /home/user/shopino/.docker-data/postgres -> /var/lib/postgresql/data
bind: /home/user/shopino/.docker-data/redis    -> /data

$ docker compose -f docker-compose.yml config # production / CI (override NOT loaded)
bind mounts found: 0
named volumes used: ['postgres_data', 'redis_data']
```


#### Persistence evidence in the workspace

```text
### Evidence: persistence lives inside the workspace (Strategy B)
$ ls -la .docker-data/
total 4
drwxr-xr-x  4 user user              60 Sep 26 12:46 .
drwxr-xr-x 10 user user            4096 Sep 26 12:48 ..
drwxr-xr-x  3  999 systemd-journal   60 Sep 26 12:46 postgres
drwxr-xr-x  3  999 systemd-journal   60 Sep 26 12:46 redis
$ sudo du -sh .docker-data/*   (dirs are owned by the container users, uid 999)
62M	.docker-data/postgres
5.0K	.docker-data/redis
$ ls .docker-data/postgres/pgdata | head -5   (a real PostgreSQL cluster)
PG_VERSION
base
global
pg_commit_ts
pg_dynshmem
$ ls .docker-data/redis/appendonlydir   (Redis AOF files)
appendonly.aof.1.base.rdb
appendonly.aof.1.incr.aof
appendonly.aof.manifest

### Evidence: containers recreated, data intact (see counts below)
$ docker compose down && docker compose up -d
shopino_postgres → Up 17 seconds (healthy)
shopino_redis → Up 17 seconds (healthy)
users=1
```


## 10. Database state — read directly from PostgreSQL (not through the application)


#### Tables, migration history, master data

```text
### Tables created by the migration (read directly from PostgreSQL via psql)
               List of relations
 Schema |        Name        | Type  |  Owner  
--------+--------------------+-------+---------
 public | _prisma_migrations | table | shopino
 public | categories         | table | shopino
 public | system_configs     | table | shopino
 public | users              | table | shopino
(4 rows)

### Applied migrations (Prisma migration history)
20260926124703_init | applied_at=2026-09-26 12:47:03.598152+00

### Row counts
 users | categories | system_configs 
-------+------------+----------------
     1 |         19 |              5
(1 row)

### Super-admin row (password shown as a truncated Argon2id hash prefix only)
        email        |    full_name     |    role     | is_active |        password_hash_prefix        |         created_at         
---------------------+------------------+-------------+-----------+------------------------------------+----------------------------
 admin@shopino.local | مدیر ارشد پلتفرم | SUPER_ADMIN | t         | $argon2id$v=19$m=19456,t=2,p=1$... | 2026-09-26 12:47:10.093+00
(1 row)

### Category tree
        slug         |         title         |      title_en       |      parent      | sort_order 
---------------------+-----------------------+---------------------+------------------+------------
 digital             | کالای دیجیتال         | Digital Goods       |                  |         10
 mobile              | گوشی موبایل           | Mobile Phones       | digital          |         10
 laptop              | لپ‌تاپ و کامپیوتر      | Laptops & Computers | digital          |         20
 digital-accessories | لوازم جانبی دیجیتال   | Digital Accessories | digital          |         30
 home-kitchen        | خانه و آشپزخانه       | Home & Kitchen      |                  |         20
 home-appliances     | لوازم خانگی           | Home Appliances     | home-kitchen     |         10
 kitchenware         | ظروف و لوازم آشپزخانه | Kitchenware         | home-kitchen     |         20
 fashion             | مد و پوشاک            | Fashion             |                  |         30
 mens-clothing       | پوشاک مردانه          | Men's Clothing      | fashion          |         10
 womens-clothing     | پوشاک زنانه           | Women's Clothing    | fashion          |         20
 bags-shoes          | کیف و کفش             | Bags & Shoes        | fashion          |         30
 beauty-health       | زیبایی و سلامت        | Beauty & Health     |                  |         40
 skincare            | مراقبت از پوست        | Skincare            | beauty-health    |         10
 personal-care       | بهداشت شخصی           | Personal Care       | beauty-health    |         20
 supermarket         | سوپرمارکت             | Supermarket         |                  |         50
 food-beverage       | خواروبار و نوشیدنی    | Food & Beverage     | supermarket      |         10
 dairy               | لبنیات                | Dairy               | supermarket      |         20
 books-stationery    | کتاب و لوازم‌التحریر   | Books & Stationery  |                  |         60
 books               | کتاب                  | Books               | books-stationery |         10
(19 rows)

### System configuration
        key        |    value    | value_type 
-------------------+-------------+------------
 credit.enabled    | false       | BOOLEAN
 platform.currency | IRR         | STRING
 platform.locale   | fa-IR       | STRING
 platform.name     | شاپینو      | STRING
 platform.timezone | Asia/Tehran | STRING
(5 rows)
```


## 11. Deterministic, idempotent seed

```bash
pnpm db:seed && pnpm db:seed && pnpm verify:seed
```


#### Two consecutive runs + verification

```text
########## DISASTER RECOVERY: wipe the database, rebuild from migrations + seed ##########
$ rm -rf .docker-data/postgres/pgdata   (simulating a wiped development volume)
total 0
drwxr-xr-x 2  999 systemd-journal 60 Sep 26 12:50 .
drwxr-xr-x 4 user user            60 Sep 26 12:46 ..
postgres container: healthy

$ docker compose exec postgres psql -c '\dt'   (empty cluster: no application tables)
Did not find any relations.


[verify:seed] first run
[verify:seed]   users=1 categories=19 (roots=6) configs=5
[verify:seed] second run (idempotency check)
[verify:seed] ok — deterministic and idempotent; credential stored as Argon2id, no plaintext, admin created=false


```


## 12. Disaster recovery — wiped volume rebuilt in one command


#### `rm -rf .docker-data/postgres/pgdata` → `pnpm db:reset` → full master data

```text
########## DISASTER RECOVERY: wipe the database, rebuild from migrations + seed ##########
$ rm -rf .docker-data/postgres/pgdata   (simulating a wiped development volume)
total 0
drwxr-xr-x 2  999 systemd-journal 60 Sep 26 12:50 .
drwxr-xr-x 4 user user            60 Sep 26 12:46 ..
postgres container: healthy

$ docker compose exec postgres psql -c '\dt'   (empty cluster: no application tables)
Did not find any relations.

$ pnpm db:reset    (drops schema → applies every migration → runs the seed)
@shopino/backend:db:reset: Applying migration `20260926124703_init`
@shopino/backend:db:reset: 
@shopino/backend:db:reset: Database reset successful
@shopino/backend:db:reset: 
@shopino/backend:db:reset: The following migration(s) have been applied:
@shopino/backend:db:reset: 
@shopino/backend:db:reset: migrations/
@shopino/backend:db:reset:   └─ 20260926124703_init/
@shopino/backend:db:reset:     └─ migration.sql
@shopino/backend:db:reset: 
@shopino/backend:db:reset: Running seed command `ts-node --project tsconfig.json prisma/seed.ts` ...
@shopino/backend:db:reset: [seed] master data ready — super admin: admin@shopino.local (created), categories: 19, system configs: 5
@shopino/backend:db:reset: 
@shopino/backend:db:reset: 🌱  The seed command has been executed.
@shopino/backend:db:reset: 
 Tasks:    1 successful, 1 total
Cached:    0 cached, 1 total
  Time:    3.706s 

$ docker compose exec postgres psql -c 'row counts'
 users | categories | system_configs |   last_migration    
-------+------------+----------------+---------------------
     1 |         19 |              5 | 20260926124703_init
(1 row)
```


## 13. Redis is real and password-protected


#### Redis over the wire

```text
### Redis (AUTH required) — read from inside the container
$ redis-cli -a *** PING
PONG
$ redis-cli -a *** INFO server | grep redis_version
redis_version:7.4.11
redis_mode:standalone
$ redis-cli -a *** CONFIG GET appendonly
appendonly
yes
$ redis-cli (no password) PING  → must be refused
NOAUTH Authentication required.
```


## 14. How to reproduce from a clean checkout

```bash
pnpm install
cp .env.example .env                     # fill in values; openssl rand -base64 48 for secrets
pnpm infra:prepare                       # create ./.docker-data (Linux: sets uid 999 ownership)
docker compose up -d && docker compose ps
pnpm db:generate && pnpm db:migrate && pnpm db:seed
pnpm build
pnpm --filter @shopino/backend start &   # API on :4000
pnpm --filter @shopino/frontend dev      # web on :3000
curl http://localhost:4000/api/v1/health
pnpm verify:connections && pnpm verify:seed && pnpm verify:http
```

## 15. Notes, decisions and remaining risk

- **Production must pin the compose file.** `docker-compose.override.yml` is auto-merged by Compose;
  a server running a bare `docker compose up -d` would silently adopt the development bind mounts.
  `pnpm infra:up:prod` / `docker compose -f docker-compose.yml …` is the documented production path.
- **Bind-mount ownership on Linux.** The postgres and redis images run as uid 999; Docker creates
  missing bind-mount directories as root. `pnpm infra:prepare` fixes ownership (macOS/Windows are
  unaffected). Documented in the README.
- **Role enum scope.** `UserRole` currently declares `SUPER_ADMIN`, `ADMIN`, `VENDOR`, `CUSTOMER`.
  Only `SUPER_ADMIN` is used by the seed; the other three are reserved for the authentication phase.
  If the architect prefers a minimal enum now, it is a one-line change plus a migration.
- **Category taxonomy is baseline data**, not final merchandising: 6 roots / 19 nodes with stable
  slugs, seeded so the platform has a valid tree in every environment. Ops can extend it through new
  seed entries.
- **Not implemented in this phase (by design):** authentication/authorization, rate limiting,
  marketplace domain tables (vendors/products/orders/credit), external providers (OTP, SMS, payments,
  email, storage). `credit.enabled` is seeded as `false` until BNPL ships.
- **Test split for Swagger:** the OpenAPI document is asserted in-process by the e2e suite, while the
  served UI is verified over HTTP by `scripts/smoke-http.ts`, because serving it loads
  `@fastify/static` → `glob@13` (ESM-only), which Jest's CommonJS runtime cannot load. Node 22 loads
  it fine (`require(esm)`), which is why the API itself serves the UI correctly.
- **Do not run `pnpm build` while `next dev` is running** — both write `apps/frontend/.next`.
```


### `package.json`

```json
{
  "name": "shopino",
  "version": "0.1.0",
  "private": true,
  "description": "Shopino — multi-vendor marketplace with banking credit (BNPL) capabilities",
  "license": "UNLICENSED",
  "packageManager": "pnpm@9.15.9",
  "engines": {
    "node": ">=22.0.0"
  },
  "workspaces": [
    "apps/*",
    "packages/*"
  ],
  "scripts": {
    "build": "turbo run build",
    "clean": "turbo run clean",
    "db:deploy": "turbo run db:deploy",
    "db:generate": "turbo run db:generate",
    "db:migrate": "turbo run db:migrate",
    "db:push": "turbo run db:push",
    "db:reset": "turbo run db:reset",
    "db:seed": "turbo run db:seed",
    "db:validate": "turbo run db:validate",
    "dev": "turbo run dev",
    "infra:down": "docker compose down",
    "infra:logs": "docker compose logs -f --tail=100",
    "infra:prepare": "bash scripts/prepare-dev-data-dirs.sh",
    "infra:ps": "docker compose ps",
    "infra:reset": "docker compose down -v",
    "infra:up": "pnpm run infra:prepare && docker compose up -d",
    "infra:up:prod": "docker compose -f docker-compose.yml up -d",
    "lint": "turbo run lint",
    "test": "turbo run test",
    "test:e2e": "turbo run test:e2e",
    "typecheck": "turbo run typecheck",
    "verify:connections": "pnpm --filter @shopino/backend run verify:connections",
    "verify:http": "pnpm --filter @shopino/backend run verify:http",
    "verify:seed": "pnpm --filter @shopino/backend run verify:seed"
  },
  "devDependencies": {
    "turbo": "^2.11.4",
    "typescript": "5.9.3"
  }
}
```


### `packages/config/package.json`

```json
{
  "name": "@shopino/config",
  "version": "0.1.0",
  "private": true,
  "description": "Shared build configuration for Shopino workspaces",
  "files": [
    "tsconfig"
  ],
  "exports": {
    "./tsconfig/base.json": "./tsconfig/base.json",
    "./tsconfig/nest.json": "./tsconfig/nest.json",
    "./tsconfig/next.json": "./tsconfig/next.json"
  },
  "devDependencies": {
    "typescript": "5.9.3"
  }
}
```


### `packages/config/tsconfig/base.json`

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "Shopino base TypeScript configuration",
  "compilerOptions": {
    "target": "ES2022",
    "strict": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "sourceMap": true,
    "pretty": true
  }
}
```


### `packages/config/tsconfig/nest.json`

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "Shopino NestJS (CommonJS, decorators) TypeScript configuration",
  "extends": "./base.json",
  "compilerOptions": {
    "module": "commonjs",
    "moduleResolution": "node",
    "lib": ["ES2023"],
    "target": "ES2023",
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "useDefineForClassFields": false,
    "allowSyntheticDefaultImports": true,
    "incremental": true
  }
}
```


### `packages/config/tsconfig/next.json`

```json
{
  "$schema": "https://json.schemastore.org/tsconfig",
  "display": "Shopino Next.js (bundler, JSX preserve) TypeScript configuration",
  "extends": "./base.json",
  "compilerOptions": {
    "module": "esnext",
    "moduleResolution": "bundler",
    "lib": ["DOM", "DOM.Iterable", "ES2022"],
    "jsx": "preserve",
    "allowJs": true,
    "noEmit": true,
    "allowSyntheticDefaultImports": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": false
  }
}
```


### `pnpm-workspace.yaml`

```
packages:
  - "apps/*"
  - "packages/*"
```


### `scripts/prepare-dev-data-dirs.sh`

```bash
#!/usr/bin/env bash
#
# Prepares the development persistence directories used by
# docker-compose.override.yml (decision: Strategy B).
#
# Why this is needed: when a bind-mount source does not exist, Docker creates it
# as root:root. The official postgres and redis images run as uid 999, so they
# cannot write into a root-owned directory and the containers fail to start.
# This script creates the directories and, on Linux, hands them to the correct
# uid. macOS and Windows Docker Desktop map permissions transparently and are
# left untouched.
#
# Idempotent: safe to run before every `docker compose up`.
#
# Usage:  bash scripts/prepare-dev-data-dirs.sh     (also: pnpm infra:prepare)
#
set -euo pipefail

DATA_ROOT=".docker-data"
POSTGRES_DIR="${DATA_ROOT}/postgres"
REDIS_DIR="${DATA_ROOT}/redis"
POSTGRES_UID=999
REDIS_UID=999

log() { printf '[infra:prepare] %s\n' "$*"; }

if [ "$(uname -s)" != "Linux" ]; then
  log "not Linux — Docker Desktop handles bind-mount ownership; creating directories only"
  mkdir -p "${POSTGRES_DIR}" "${REDIS_DIR}"
  exit 0
fi

mkdir -p "${POSTGRES_DIR}" "${REDIS_DIR}"

needs_chown() {
  local dir="$1" uid="$2"
  [ "$(stat -c '%u' "${dir}")" != "${uid}" ]
}

CHOWN_CMD=""
if [ "$(id -u)" -eq 0 ]; then
  CHOWN_CMD="chown"
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  # Passwordless sudo (CI containers, remote dev sandboxes).
  CHOWN_CMD="sudo -n chown"
fi

if [ -n "${CHOWN_CMD}" ]; then
  if needs_chown "${POSTGRES_DIR}" "${POSTGRES_UID}"; then
    ${CHOWN_CMD} -R "${POSTGRES_UID}:${POSTGRES_UID}" "${POSTGRES_DIR}"
    log "ownership set: ${POSTGRES_DIR} → ${POSTGRES_UID}:${POSTGRES_UID}"
  fi
  if needs_chown "${REDIS_DIR}" "${REDIS_UID}"; then
    ${CHOWN_CMD} -R "${REDIS_UID}:${REDIS_UID}" "${REDIS_DIR}"
    log "ownership set: ${REDIS_DIR} → ${REDIS_UID}:${REDIS_UID}"
  fi
fi

# Report rather than fail: on a machine without root the developer can either
# run this script with sudo once, or accept that Docker will create the
# directories itself and report a clear permission error at startup.
for pair in "${POSTGRES_DIR}:${POSTGRES_UID}" "${REDIS_DIR}:${REDIS_UID}"; do
  dir="${pair%%:*}"
  uid="${pair##*:}"
  owner="$(stat -c '%u' "${dir}")"
  if [ "${owner}" = "${uid}" ]; then
    log "ok   ${dir} (uid ${owner})"
  else
    printf '[infra:prepare][WARN] %s is owned by uid %s, expected %s.\n' "${dir}" "${owner}" "${uid}" >&2
    printf '                      Run: sudo chown -R %s:%s %s\n' "${uid}" "${uid}" "${dir}" >&2
  fi
done

log "development data directories ready"
```


### `turbo.json`

```json
{
  "$schema": "https://turbo.build/schema.json",
  "globalDependencies": [
    ".env.example",
    "tsconfig.json"
  ],
  "globalEnv": [
    "NODE_ENV",
    "LOG_LEVEL"
  ],
  "tasks": {
    "build": {
      "dependsOn": [
        "^build"
      ],
      "inputs": [
        "$TURBO_DEFAULT$",
        ".env"
      ],
      "outputs": [
        "dist/**",
        ".next/**",
        "!.next/cache/**"
      ]
    },
    "typecheck": {
      "dependsOn": [
        "^build"
      ],
      "outputs": []
    },
    "lint": {
      "outputs": []
    },
    "test": {
      "dependsOn": [
        "^build"
      ],
      "outputs": [
        "coverage/**"
      ]
    },
    "test:e2e": {
      "dependsOn": [
        "^build"
      ],
      "cache": false,
      "outputs": []
    },
    "dev": {
      "cache": false,
      "persistent": true
    },
    "db:generate": {
      "cache": false,
      "outputs": []
    },
    "db:validate": {
      "cache": false,
      "outputs": []
    },
    "db:migrate": {
      "cache": false,
      "outputs": []
    },
    "db:deploy": {
      "cache": false,
      "outputs": []
    },
    "db:push": {
      "cache": false,
      "outputs": []
    },
    "db:seed": {
      "cache": false,
      "outputs": []
    },
    "db:reset": {
      "cache": false,
      "outputs": []
    },
    "clean": {
      "cache": false
    }
  }
}
```
