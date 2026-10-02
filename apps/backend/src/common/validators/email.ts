/**
 * E-mail addresses as identities (sign-in by e-mailed code).
 *
 * Normalisation is deliberately conservative: trim + Unicode NFC + lower-case.
 * Provider-specific rewrites (Gmail dots, `+tags`) are NOT applied — they are
 * different mailboxes for every other provider, and folding them would let one
 * person claim another's address.
 */

/** RFC 5321 limits: 64-octet local part, 254-octet path. */
const MAX_LENGTH = 254;
const MAX_LOCAL_LENGTH = 64;

/** Practical address shape: printable local part, dotted domain with a 2+ letter TLD, no spaces or angle brackets. */
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}$/;

/** Lower-cased canonical form, or `null` when the value is not a usable address. */
export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.normalize('NFC').trim().toLowerCase();
  if (email.length === 0 || email.length > MAX_LENGTH) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0 || at > MAX_LOCAL_LENGTH) return null;
  const local = email.slice(0, at);
  if (local.startsWith('.') || local.endsWith('.') || local.includes('..')) return null;
  return EMAIL_PATTERN.test(email) ? email : null;
}

/** `sa***@gmail.com` — for logs. */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, Math.min(2, at))}***${email.slice(at)}`;
}
