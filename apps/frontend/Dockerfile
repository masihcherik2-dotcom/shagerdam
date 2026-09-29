# syntax=docker/dockerfile:1.7
# =============================================================================
# Shopino web (Next.js 15 App Router) — production image, standalone output
# -----------------------------------------------------------------------------
# Build from the REPOSITORY ROOT (pnpm workspace):
#   docker build -f apps/frontend/Dockerfile -t shopino/frontend .
#
# Stages
#   base     node:22-alpine + pnpm (corepack)
#   deps     workspace install of the frontend's dependency graph (cached layer)
#   builder  `next build` with NEXT_OUTPUT=standalone (self-contained server.js)
#   runner   standalone server + static assets only, non-root `node`, dumb-init
#
# Runtime configuration (read on the server, never baked in):
#   BACKEND_INTERNAL_URL   e.g. http://backend:4000 — the BFF's upstream
# Build-time (inlined into the browser bundle, not secret):
#   NEXT_PUBLIC_API_BASE_URL (default /api/v1 — the same-origin BFF)
# =============================================================================

ARG NODE_IMAGE=node:22-alpine

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1
RUN apk add --no-cache libc6-compat \
 && corepack enable \
 && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app

# ---------------------------------------------------------------------------
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/config/package.json packages/config/
COPY apps/backend/package.json apps/backend/
COPY apps/frontend/package.json apps/frontend/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @shopino/frontend...

# ---------------------------------------------------------------------------
FROM deps AS builder
ARG NEXT_PUBLIC_API_BASE_URL=/api/v1
ENV NEXT_PUBLIC_API_BASE_URL=${NEXT_PUBLIC_API_BASE_URL} \
    NEXT_OUTPUT=standalone \
    NODE_ENV=production
COPY turbo.json ./
COPY packages/config packages/config
COPY apps/frontend apps/frontend
RUN pnpm --filter @shopino/frontend build

# ---------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runner
RUN apk add --no-cache dumb-init
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
WORKDIR /app
# outputFileTracingRoot is the monorepo root, so the standalone tree mirrors it:
# /app/apps/frontend/server.js + the traced node_modules.
COPY --from=builder --chown=node:node /app/apps/frontend/.next/standalone ./
COPY --from=builder --chown=node:node /app/apps/frontend/.next/static ./apps/frontend/.next/static
USER node
EXPOSE 3000
# Liveness of the Next.js server: GET /api/session without cookies is answered
# locally ({ user: null }) and does not depend on the backend.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/api/session" || exit 1
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "apps/frontend/server.js"]
