import { durationToSeconds, hashToken } from './token.service';

/**
 * Pure helpers of the token layer. The signing, rotation and session behaviour is
 * covered end-to-end against Redis in `test/auth.e2e-spec.ts`; what is tested here
 * is the arithmetic that everything else depends on — a wrong TTL silently
 * changes the security window of every session.
 */
describe('durationToSeconds', () => {
  it('converts every supported unit', () => {
    expect(durationToSeconds('30s')).toBe(30);
    expect(durationToSeconds('15m')).toBe(900);
    expect(durationToSeconds('12h')).toBe(43_200);
    expect(durationToSeconds('7d')).toBe(604_800);
  });

  it('matches the configured access/refresh defaults', () => {
    expect(durationToSeconds('15m')).toBe(15 * 60);
    expect(durationToSeconds('7d')).toBe(7 * 24 * 60 * 60);
  });

  it('tolerates surrounding whitespace', () => {
    expect(durationToSeconds(' 15m ')).toBe(900);
  });

  it('rejects anything it cannot interpret rather than guessing', () => {
    for (const value of ['', '15', 'm15', '15 minutes', '0m', '-5m', '1.5h', '15M', '15 m']) {
      expect(() => durationToSeconds(value.trim())).toThrow(/Unsupported duration/);
    }
  });

  it('treats zero-prefixed amounts as invalid', () => {
    expect(() => durationToSeconds('015m')).toThrow(/Unsupported duration/);
  });
});

describe('hashToken', () => {
  it('is a stable sha256 hex digest', () => {
    const digest = hashToken('some-token-value');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken('some-token-value')).toBe(digest);
  });

  it('never returns the input, so a Redis dump yields no usable token', () => {
    const token = 'eyJhbGciOiJIUzI1NiJ9.payload.signature';
    expect(hashToken(token)).not.toContain('eyJ');
    expect(hashToken(token)).not.toBe(token);
  });

  it('differs for different tokens', () => {
    expect(hashToken('a')).not.toBe(hashToken('b'));
  });
});
