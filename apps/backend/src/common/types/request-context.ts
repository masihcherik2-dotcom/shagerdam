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
