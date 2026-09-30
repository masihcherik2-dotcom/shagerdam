import { describe, expect, it } from 'vitest';

import { can, canAccess, homeForRole, ruleFor, safeNextPath } from './access';
import { isAccessTokenFresh, readAccessClaims } from './session-core';

const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const token = (payload: object): string => `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;

describe('route access', () => {
  it('leaves storefront pages public', () => {
    for (const path of ['/', '/search', '/products/x', '/categories/y', '/cart', '/login', '/payment/result']) {
      expect(ruleFor(path)).toBeNull();
      expect(canAccess(path, null)).toBe(true);
    }
  });

  it('guards the role areas', () => {
    expect(canAccess('/customer/orders', 'CUSTOMER')).toBe(true);
    expect(canAccess('/customer/orders', 'VENDOR')).toBe(false);
    expect(canAccess('/customer/orders', null)).toBe(false);
    expect(canAccess('/checkout', 'CUSTOMER')).toBe(true);
    expect(canAccess('/vendor/dashboard', 'VENDOR')).toBe(true);
    expect(canAccess('/vendor/dashboard', 'CUSTOMER')).toBe(false);
    expect(canAccess('/vendor/register', 'CUSTOMER')).toBe(true);
    expect(canAccess('/admin/vendors', 'SUPPORT')).toBe(true);
    expect(canAccess('/admin/vendors/create', 'SUPPORT')).toBe(false);
    expect(canAccess('/admin/vendors/create', 'ADMIN')).toBe(true);
    expect(canAccess('/vendor/landing', null)).toBe(true);
    expect(canAccess('/vendor/landingx', null)).toBe(false);
    expect(canAccess('/admin/settlements', 'SUPPORT')).toBe(false);
    expect(canAccess('/admin/branding', 'ADMIN')).toBe(true);
    expect(canAccess('/admin/branding', 'SUPER_ADMIN')).toBe(true);
    expect(canAccess('/admin/branding', 'SUPPORT')).toBe(false);
    expect(canAccess('/admin/branding', 'FINANCIAL_OFFICER')).toBe(false);
    expect(canAccess('/admin/settlements', 'FINANCIAL_OFFICER')).toBe(true);
    expect(canAccess('/admin/disputes/1', 'FINANCIAL_OFFICER')).toBe(false);
    expect(canAccess('/admin', 'CUSTOMER')).toBe(false);
    // Prefix matching is segment-based.
    expect(ruleFor('/vendorship')).toBeNull();
  });

  it('sends each role to its own area', () => {
    expect(homeForRole('CUSTOMER')).toBe('/customer/orders');
    expect(homeForRole('VENDOR')).toBe('/vendor/dashboard');
    expect(homeForRole('FINANCIAL_OFFICER')).toBe('/admin/financial');
    for (const role of ['CUSTOMER', 'VENDOR', 'FINANCIAL_OFFICER', 'SUPPORT', 'ADMIN', 'SUPER_ADMIN'] as const) {
      expect(canAccess(homeForRole(role), role)).toBe(true);
    }
  });

  it('accepts only same-site relative post-login targets', () => {
    expect(safeNextPath('/checkout')).toBe('/checkout');
    expect(safeNextPath('//evil.example')).toBeNull();
    expect(safeNextPath('https://evil.example')).toBeNull();
    expect(safeNextPath('/\\evil')).toBeNull();
    expect(safeNextPath('/api/v1/auth/me')).toBeNull();
    expect(safeNextPath(null)).toBeNull();
  });

  it('maps staff capabilities like the backend guards', () => {
    expect(can('FINANCIAL_OFFICER', 'processSettlements')).toBe(true);
    expect(can('ADMIN', 'processSettlements')).toBe(false);
    expect(can('FINANCIAL_OFFICER', 'arbitrateDisputes')).toBe(false);
    expect(can('SUPPORT', 'reviewVendors')).toBe(false);
  });
});

describe('access token claims', () => {
  it('reads sub/role/exp without trusting anything else', () => {
    const claims = readAccessClaims(token({ sub: 'u1', role: 'VENDOR', exp: 2_000_000_000, typ: 'access' }));
    expect(claims).toEqual({ sub: 'u1', role: 'VENDOR', exp: 2_000_000_000 });
    expect(isAccessTokenFresh(claims, 1_000)).toBe(true);
    expect(isAccessTokenFresh(claims, 2_000_000_000)).toBe(false);
  });

  it('rejects refresh tokens, garbage and missing claims', () => {
    expect(readAccessClaims(token({ sub: 'u1', role: 'VENDOR', exp: 1, typ: 'refresh' }))).toBeNull();
    expect(readAccessClaims('not-a-jwt')).toBeNull();
    expect(readAccessClaims('a.b.c')).toBeNull();
    expect(readAccessClaims(token({ sub: 'u1' }))).toBeNull();
    expect(readAccessClaims(undefined)).toBeNull();
  });
});
