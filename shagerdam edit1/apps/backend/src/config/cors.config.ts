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
