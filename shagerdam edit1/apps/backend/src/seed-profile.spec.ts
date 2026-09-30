import { UserRole } from '@prisma/client';

import { normalizeIranMobile, productionStaffUsers, resolveSeedProfile } from '../prisma/seed';

/**
 * Pure parts of the seed's production profile (Phase 11). The database effects of
 * the profile (create-only master data, no sample vendor) are verified against a
 * real PostgreSQL through the migrator image — see docs/phase-11-verification.md.
 */
describe('seed production profile', () => {
  describe('resolveSeedProfile', () => {
    it('defaults to production only under NODE_ENV=production', () => {
      expect(resolveSeedProfile({ NODE_ENV: 'production' })).toBe('production');
      expect(resolveSeedProfile({ NODE_ENV: 'development' })).toBe('development');
      expect(resolveSeedProfile({ NODE_ENV: 'test' })).toBe('development');
    });

    it('honours an explicit SEED_PROFILE and rejects unknown values', () => {
      expect(resolveSeedProfile({ NODE_ENV: 'production', SEED_PROFILE: 'development' })).toBe('development');
      expect(resolveSeedProfile({ NODE_ENV: 'development', SEED_PROFILE: ' Production ' })).toBe('production');
      expect(() => resolveSeedProfile({ SEED_PROFILE: 'staging' })).toThrow(/SEED_PROFILE/);
    });
  });

  describe('normalizeIranMobile', () => {
    it.each([
      ['09121234567', '+989121234567'],
      ['+989121234567', '+989121234567'],
      ['00989121234567', '+989121234567'],
      ['0912 123 4567', '+989121234567'],
    ])('normalizes %s', (input, expected) => {
      expect(normalizeIranMobile('X', input)).toBe(expected);
    });

    it.each(['9121234567', '0812345678', '+98912123456', 'abc'])('rejects %s', (input) => {
      expect(() => normalizeIranMobile('SUPER_ADMIN_MOBILE', input)).toThrow(/SUPER_ADMIN_MOBILE/);
    });
  });

  describe('productionStaffUsers', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    function setAdmin(): void {
      process.env.SUPER_ADMIN_MOBILE = '09121112233';
      process.env.SUPER_ADMIN_EMAIL = 'owner@example.ir';
      process.env.SUPER_ADMIN_FULL_NAME = 'مدیر سامانه';
    }

    it('builds the super admin from the environment only', () => {
      setAdmin();
      const env: NodeJS.ProcessEnv = {};
      const users = productionStaffUsers(env);
      expect(users).toEqual([
        expect.objectContaining({ mobile: '+989121112233', email: 'owner@example.ir', role: UserRole.SUPER_ADMIN, passwordEnv: 'SUPER_ADMIN_PASSWORD' }),
      ]);
    });

    it('refuses to invent a super admin identity', () => {
      delete process.env.SUPER_ADMIN_MOBILE;
      expect(() => productionStaffUsers({})).toThrow(/SUPER_ADMIN_MOBILE is not set/);
    });

    it('adds optional staff only when all three variables are present', () => {
      setAdmin();
      const users = productionStaffUsers({ SEED_FINANCE_MOBILE: '09351234567', SEED_FINANCE_EMAIL: 'finance@example.ir', SEED_FINANCE_FULL_NAME: 'کارشناس مالی' });
      expect(users.map((user) => user.role)).toEqual([UserRole.SUPER_ADMIN, UserRole.FINANCIAL_OFFICER]);
      expect(users[1]).toEqual(expect.objectContaining({ mobile: '+989351234567', passwordEnv: 'SEED_STAFF_PASSWORD' }));
      expect(() => productionStaffUsers({ SEED_SUPPORT_EMAIL: 'support@example.ir' })).toThrow(/SEED_SUPPORT_MOBILE, SEED_SUPPORT_EMAIL and SEED_SUPPORT_FULL_NAME/);
    });
  });
});
