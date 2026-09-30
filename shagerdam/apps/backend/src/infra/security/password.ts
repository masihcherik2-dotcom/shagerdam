import { hash, verify, Algorithm } from '@node-rs/argon2';

/**
 * Password hashing for platform credentials.
 *
 * Argon2id with the OWASP-recommended baseline (19 MiB memory, 2 iterations,
 * 1 degree of parallelism). The same helper is used by the deterministic seed
 * and, from the authentication phase onwards, by credential verification — one
 * implementation, one parameter set, no drift between environments.
 */
export const ARGON2_OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

/** Minimum length accepted for a platform password. */
export const MIN_PASSWORD_LENGTH = 12;

const ARGON2ID_PREFIX = '$argon2id$';

/**
 * Hashes a plaintext password. Never store the input anywhere else.
 *
 * Declared `async` on purpose: an invalid input becomes a rejected promise, so
 * callers handle every failure through one path instead of guarding against a
 * synchronous throw that could escape an awaited call chain.
 */
export async function hashPassword(plainPassword: string): Promise<string> {
  if (plainPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters long.`);
  }
  return hash(plainPassword, ARGON2_OPTIONS);
}

/** Constant-time verification of a password against a stored hash. */
export function verifyPassword(storedHash: string, plainPassword: string): Promise<boolean> {
  return verify(storedHash, plainPassword);
}

/** True when the stored value is an Argon2id hash produced by {@link hashPassword}. */
export function isArgon2idHash(value: string): boolean {
  return value.startsWith(ARGON2ID_PREFIX);
}
