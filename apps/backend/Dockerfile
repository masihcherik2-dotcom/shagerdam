# syntax=docker/dockerfile:1.7
# =============================================================================
# Shopino API (NestJS + Fastify + Prisma) — production image
# -----------------------------------------------------------------------------
# Build from the REPOSITORY ROOT (pnpm workspace):
#   docker build -f apps/backend/Dockerfile -t shopino/backend .                 # runtime
#   docker build -f apps/backend/Dockerfile --target migrator -t shopino/migrator .
#
# Stages
#   base     node:22-alpine + pnpm (corepack) + openssl (Prisma engines)
#   deps     workspace install of the backend's dependency graph (cached layer)
#   builder  prisma generate + nest build, then `pnpm deploy --prod` into /prod
#   migrator full toolchain (Prisma CLI, ts-node): `prisma migrate deploy` and the
#            idempotent seed. Run once per release, never exposed.
#   runner   production dependencies + dist only, non-root `node`, dumb-init (PID 1)
#
# No secret is read at build time: configuration arrives as environment variables
# at run time (docker-compose.prod.yml → env_file), and the API validates it at
# boot (sandbox providers are refused under NODE_ENV=production).
# =============================================================================

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
# libc6-compat: prebuilt native addons (argon2, sharp) on musl; openssl: Prisma engines.
RUN apk add --no-cache libc6-compat openssl \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
# Manifests only, so the dependency layer is reused until they change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shopino/backend...

# ---------------------------------------------------------------------------
FROM deps AS builder
COPY turbo.json ./
COPY packages/config packages/config
COPY apps/backend apps/backend
RUN pnpm --filter @shopino/backend build
# Self-contained production tree: package.json, dist, prisma/ and prod node_modules.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter @shopino/backend deploy --prod /prod/backend \
 && rm -rf /prod/backend/dist && cp -r apps/backend/dist /prod/backend/dist \
 # The generated Prisma client lives inside node_modules; regenerate it for the
 # deployed tree with the builder's CLI (the CLI itself stays out of /prod).
 && cd /prod/backend \
 && /app/apps/backend/node_modules/.bin/prisma generate --schema=prisma/schema.prisma \
 && rm -rf /prod/backend/src /prod/backend/test /prod/backend/scripts \
            /prod/backend/Dockerfile /prod/backend/eslint.config.mjs /prod/backend/jest.config.js \
 # Size pruning, runtime-neutral (verified by booting the image against PostgreSQL):
 #  - the Prisma CLI tree pulled in as a peer of @prisma/client (CLI, schema/migration
 #    engines, effect, typescript) — migrations run from the `migrator` target;
 #  - wasm/edge query engines of databases other than PostgreSQL;
 #  - glibc builds of sharp/libvips (this image is musl).
 && cd /prod/backend/node_modules/.pnpm \
 && rm -rf prisma@* @prisma+engines@* @prisma+engines-version@* @prisma+fetch-engine@* @prisma+get-platform@* \
           effect@* typescript@* @img+sharp-linux-x64@* @img+sharp-libvips-linux-x64@* \
 && find . -path '*@prisma/client/runtime/*' \( -name '*mysql*' -o -name '*sqlite*' -o -name '*sqlserver*' -o -name '*cockroachdb*' \) -delete

# ---------------------------------------------------------------------------
FROM builder AS migrator
# Operational image: migrations + seed. Same source revision as the runner.
WORKDIR /app/apps/backend
RUN chown -R node:node /app/apps/backend
USER node
# Binaries are called directly (no pnpm/corepack at runtime): the migrator must
# work on hosts without registry access.
#   migrations : docker compose run --rm migrate                  (default CMD)
#   seed       : docker compose run --rm migrate ts-node --project tsconfig.json prisma/seed.ts
ENV NODE_ENV=production \
    PATH=/app/apps/backend/node_modules/.bin:$PATH
CMD ["prisma", "migrate", "deploy"]

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
RUN apk add --no-cache dumb-init openssl libc6-compat
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4000 \
    STORAGE_LOCAL_ROOT=/app/uploads
WORKDIR /app
COPY --from=builder --chown=node:node /prod/backend ./
# Writable only where the app must write: the local storage root (a volume in
# production when STORAGE_PROVIDER=local; unused with s3).
RUN mkdir -p /app/uploads && chown node:node /app/uploads
USER node
EXPOSE 4000
# Readiness = the API can reach PostgreSQL and Redis (GET /api/v1/health).
HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/v1/health" || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/main.js"]
