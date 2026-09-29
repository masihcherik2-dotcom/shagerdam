import type { UserRole } from '@prisma/client';

/**
 * The identity attached to a request once `JwtAuthGuard` has verified the access
 * token. It is the *token* payload plus the fields the guards and handlers need;
 * anything else (profile, vendor) is loaded from the database on demand so a
 * revoked or role-changed account cannot keep acting on stale token claims.
 */
export interface AuthenticatedUser {
  /** `users.id` (UUID). */
  id: string;
  /** Canonical E.164 mobile number. */
  mobile: string;
  role: UserRole;
  /** JWT `jti`; used to correlate audit rows with a concrete access token. */
  sessionId: string;
}
