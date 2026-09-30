import { hashPassword, isArgon2idHash, verifyPassword, MIN_PASSWORD_LENGTH } from './password';

const STRONG_PASSWORD = 'correct-horse-battery-staple';

describe('password hashing', () => {
  it('produces an Argon2id hash that never contains the plaintext', async () => {
    const stored = await hashPassword(STRONG_PASSWORD);

    expect(isArgon2idHash(stored)).toBe(true);
    expect(stored).not.toContain(STRONG_PASSWORD);
  });

  it('salts every hash, so identical passwords produce different digests', async () => {
    const first = await hashPassword(STRONG_PASSWORD);
    const second = await hashPassword(STRONG_PASSWORD);

    expect(first).not.toBe(second);
  });

  it('verifies the correct password and rejects a wrong one', async () => {
    const stored = await hashPassword(STRONG_PASSWORD);

    await expect(verifyPassword(stored, STRONG_PASSWORD)).resolves.toBe(true);
    await expect(verifyPassword(stored, 'wrong-password-value')).resolves.toBe(false);
  });

  it('refuses passwords below the minimum length', async () => {
    await expect(hashPassword('a'.repeat(MIN_PASSWORD_LENGTH - 1))).rejects.toThrow(
      /at least 12 characters/,
    );
  });
});
