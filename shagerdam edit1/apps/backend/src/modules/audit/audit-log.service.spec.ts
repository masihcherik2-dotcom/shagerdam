import { sanitize } from './audit-log.service';

/**
 * The audit table is readable by admins, so it must never become a leak surface.
 * These assertions are the contract: secrets are replaced, structure is kept, and
 * the stored document is bounded so one large request cannot bloat the trail.
 */
describe('sanitize (audit trail redaction)', () => {
  it('redacts every credential-bearing key, whatever the casing', () => {
    const sanitized = sanitize({
      fullName: 'سارا محمدی',
      password: 'super-secret-value',
      currentPassword: 'old-secret',
      newPassword: 'new-secret',
      passwordHash: '$argon2id$v=19$…',
      otp: '48213',
      code: '48213',
      accessToken: 'eyJhbGciOi…',
      refreshToken: 'eyJhbGciOi…',
      authorization: 'Bearer abc.def.ghi',
      apiKey: 'kavenegar-key',
      secret: 'x',
    }) as Record<string, unknown>;

    expect(sanitized.fullName).toBe('سارا محمدی');
    expect(sanitized.password).toBe('[REDACTED]');
    expect(sanitized.currentPassword).toBe('[REDACTED]');
    expect(sanitized.newPassword).toBe('[REDACTED]');
    expect(sanitized.passwordHash).toBe('[REDACTED]');
    expect(sanitized.otp).toBe('[REDACTED]');
    expect(sanitized.code).toBe('[REDACTED]');
    expect(sanitized.accessToken).toBe('[REDACTED]');
    expect(sanitized.refreshToken).toBe('[REDACTED]');
    expect(sanitized.authorization).toBe('[REDACTED]');
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.secret).toBe('[REDACTED]');

    const serialized = JSON.stringify(sanitized);
    for (const secret of ['super-secret-value', 'old-secret', 'new-secret', '48213', 'kavenegar-key']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('redacts nested objects and arrays', () => {
    const sanitized = sanitize({
      user: { email: 'a@b.ir', password: 'nested-secret' },
      attempts: [{ password: 'first' }, { password: 'second' }],
    }) as { user: Record<string, unknown>; attempts: Array<Record<string, unknown>> };

    expect(sanitized.user.email).toBe('a@b.ir');
    expect(sanitized.user.password).toBe('[REDACTED]');
    expect(sanitized.attempts[0]?.password).toBe('[REDACTED]');
    expect(sanitized.attempts[1]?.password).toBe('[REDACTED]');
  });

  it('keeps numbers, booleans and null intact', () => {
    expect(sanitize({ amount: 125_000, isActive: true, note: null })).toEqual({
      amount: 125_000,
      isActive: true,
      note: null,
    });
  });

  it('converts dates to ISO strings so the JSON column stays readable', () => {
    const sanitized = sanitize({ paidAt: new Date('2026-09-26T10:00:00.000Z') }) as { paidAt: string };
    expect(sanitized.paidAt).toBe('2026-09-26T10:00:00.000Z');
  });

  it('bounds depth, array length and string length', () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 'too deep' } } } } } } };
    expect(JSON.stringify(sanitize(deep))).toContain('[TRUNCATED]');

    const longArray = Array.from({ length: 200 }, (_value, index) => index);
    expect((sanitize({ items: longArray }) as { items: number[] }).items).toHaveLength(50);

    const longString = 'x'.repeat(5_000);
    expect((sanitize({ note: longString }) as { note: string }).note).toHaveLength(2_000);
  });

  it('passes primitives through unchanged', () => {
    expect(sanitize('plain')).toBe('plain');
    expect(sanitize(42)).toBe(42);
    expect(sanitize(null)).toBeNull();
  });
});
