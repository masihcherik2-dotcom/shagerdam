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
