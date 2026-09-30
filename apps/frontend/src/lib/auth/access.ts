/**
 * Role-based routing: which area each role may open, and where each role
 * lands after signing in. Mirrors the backend's @Roles() guards so a user is
 * never shown a page whose API calls would all be refused. (The backend still
 * enforces every rule on its own.)
 */
import type { UserRole } from '../api/types';

interface RouteRule {
  prefix: string;
  roles: readonly UserRole[];
}

const ADMIN_READ: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
const FINANCE: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCIAL_OFFICER'];
const DISPUTE_STAFF: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'];
const PLATFORM_ADMIN: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN'];
const ALL_STAFF: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCIAL_OFFICER', 'SUPPORT'];

/** Public pages inside otherwise protected areas (checked before RULES). */
const PUBLIC_PATHS: readonly string[] = ['/vendor/landing'];

/** Most specific prefix first. */
const RULES: readonly RouteRule[] = [
  { prefix: '/vendor/register', roles: ['CUSTOMER', 'VENDOR'] },
  { prefix: '/vendor', roles: ['VENDOR'] },
  { prefix: '/admin/vendors/create', roles: PLATFORM_ADMIN },
  { prefix: '/admin/vendors', roles: ADMIN_READ },
  { prefix: '/admin/products', roles: ADMIN_READ },
  { prefix: '/admin/financial', roles: FINANCE },
  { prefix: '/admin/settlements', roles: FINANCE },
  { prefix: '/admin/disputes', roles: DISPUTE_STAFF },
  { prefix: '/admin/branding', roles: PLATFORM_ADMIN },
  { prefix: '/admin/site-info', roles: PLATFORM_ADMIN },
  { prefix: '/admin/support', roles: ADMIN_READ },
  { prefix: '/admin', roles: ALL_STAFF },
  { prefix: '/customer', roles: ['CUSTOMER'] },
  { prefix: '/checkout', roles: ['CUSTOMER'] },
];

function matches(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** The rule protecting a path, or null for public pages. */
export function ruleFor(pathname: string): RouteRule | null {
  if (PUBLIC_PATHS.some((path) => matches(pathname, path))) {
    return null;
  }
  return RULES.find((rule) => matches(pathname, rule.prefix)) ?? null;
}

export function canAccess(pathname: string, role: UserRole | null | undefined): boolean {
  const rule = ruleFor(pathname);
  if (rule === null) {
    return true;
  }
  return role !== null && role !== undefined && rule.roles.includes(role);
}

/** Landing page of each role's own area. */
export function homeForRole(role: UserRole): string {
  switch (role) {
    case 'VENDOR':
      return '/vendor/dashboard';
    case 'FINANCIAL_OFFICER':
      return '/admin/financial';
    case 'SUPPORT':
      return '/admin/disputes';
    case 'ADMIN':
    case 'SUPER_ADMIN':
      return '/admin/vendors';
    case 'CUSTOMER':
    default:
      return '/customer/orders';
  }
}

/** Only same-site relative paths are accepted as post-login targets (no open redirects). */
export function safeNextPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.startsWith('/\\') || value.startsWith('/api/')) {
    return null;
  }
  return value;
}

/** Staff capabilities that differ from mere page access (backend @Roles on the mutation routes). */
export const CAPABILITIES = {
  reviewVendors: ['SUPER_ADMIN', 'ADMIN'],
  /** Open stores and add products on a store's behalf (POST /admin/vendors, /admin/vendors/:id/products). */
  manageVendors: ['SUPER_ADMIN', 'ADMIN'],
  moderateProducts: ['SUPER_ADMIN', 'ADMIN'],
  processSettlements: ['SUPER_ADMIN', 'FINANCIAL_OFFICER'],
  arbitrateDisputes: ['SUPER_ADMIN', 'ADMIN', 'SUPPORT'],
} as const satisfies Record<string, readonly UserRole[]>;

export function can(role: UserRole | null | undefined, capability: keyof typeof CAPABILITIES): boolean {
  return role !== null && role !== undefined && (CAPABILITIES[capability] as readonly UserRole[]).includes(role);
}
