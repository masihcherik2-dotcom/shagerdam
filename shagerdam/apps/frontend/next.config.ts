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
  // Production image (apps/frontend/Dockerfile) sets NEXT_OUTPUT=standalone so the
  // build emits a self-contained server.js with only the traced dependencies.
  // Local `next start` keeps the default output.
  ...(process.env.NEXT_OUTPUT === 'standalone' ? { output: 'standalone' as const } : {}),
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
