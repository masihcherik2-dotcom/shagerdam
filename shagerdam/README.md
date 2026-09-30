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
- **After a fresh clone or `pnpm install`, run the database tasks through the
  pipeline, not the Prisma CLI directly.** `pnpm db:seed` and `pnpm db:reset`
  depend on `db:generate`, so the Prisma Client is always generated from this
  schema before anything touches the database. Calling `prisma db seed` by hand
  on a fresh checkout can run against a client that does not know the models yet.
- **Ephemeral sandboxes:** the PostgreSQL data directory is owned by uid 999 with
  mode `0700`. A workspace snapshot taken by an unprivileged user cannot read it,
  so in throwaway environments the development database may come back empty after
  a restart. `pnpm db:deploy && pnpm db:seed` restores the full schema and master
  data in seconds — which is exactly the property decision 2 (migrations + seed)
  was designed to guarantee. Production uses managed storage and is unaffected.

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
