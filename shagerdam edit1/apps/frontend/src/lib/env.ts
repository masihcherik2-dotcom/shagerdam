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

const DEV_SITE_ORIGIN = 'http://localhost:3000';

/**
 * Public origin of the storefront (canonical URLs, sitemap, Open Graph):
 * `PUBLIC_WEB_ORIGIN` when set, otherwise `https://<SHOPINO_DOMAIN>` (both
 * passed to the frontend container by docker-compose.prod.yml). Development
 * falls back to localhost; production never guesses.
 */
export function resolveSiteOrigin(): string {
  const explicit = process.env.PUBLIC_WEB_ORIGIN?.trim();
  if (explicit) {
    return stripTrailingSlashes(explicit);
  }
  const domain = process.env.SHOPINO_DOMAIN?.trim();
  if (domain) {
    return `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('PUBLIC_WEB_ORIGIN or SHOPINO_DOMAIN must be set for production deployments.');
  }
  return DEV_SITE_ORIGIN;
}
