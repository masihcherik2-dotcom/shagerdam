/**
 * URL layout of the public API. Both values are used by the runtime bootstrap
 * and by the end-to-end tests, so the routing contract stays in one place.
 */
export const GLOBAL_API_PREFIX = 'api/v1';

/** Human-readable Swagger UI (not prefixed with the global API prefix). */
export const SWAGGER_PATH = 'api/docs';

/** Machine-readable OpenAPI document, consumed by client code generation. */
export const SWAGGER_JSON_PATH = 'api/docs-json';
