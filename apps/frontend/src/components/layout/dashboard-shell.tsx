'use client';

import { Banknote, BarChart3, CreditCard, Gavel, LayoutDashboard, MapPin, Package, PackageCheck, Palette, Scale, ShieldCheck, ShoppingBag, Store, User, Wallet, type LucideIcon } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { canAccess } from '@/lib/auth/access';
import { ROLE_LABELS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

export type DashboardArea = 'customer' | 'vendor' | 'admin';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: Record<DashboardArea, { title: string; items: NavItem[] }> = {
  customer: {
    title: 'حساب کاربری',
    items: [
      { href: '/customer/orders', label: 'سفارش‌ها', icon: ShoppingBag },
      { href: '/customer/credit', label: 'اعتبار و اقساط', icon: CreditCard },
      { href: '/customer/disputes', label: 'اختلاف‌ها و مرجوعی', icon: Scale },
      { href: '/customer/addresses', label: 'نشانی‌ها', icon: MapPin },
      { href: '/customer/profile', label: 'اطلاعات حساب', icon: User },
    ],
  },
  vendor: {
    title: 'پنل فروشنده',
    items: [
      { href: '/vendor/dashboard', label: 'پیشخوان', icon: LayoutDashboard },
      { href: '/vendor/orders', label: 'مرسوله‌ها', icon: PackageCheck },
      { href: '/vendor/products', label: 'محصولات', icon: Package },
      { href: '/vendor/wallet', label: 'کیف پول و تسویه', icon: Wallet },
      { href: '/vendor/disputes', label: 'اختلاف‌ها', icon: Scale },
      { href: '/vendor/register', label: 'فروشگاه و مدارک', icon: Store },
    ],
  },
  admin: {
    title: 'پنل مدیریت',
    items: [
      { href: '/admin/vendors', label: 'فروشندگان و احراز هویت', icon: ShieldCheck },
      { href: '/admin/products', label: 'نظارت بر محصولات', icon: Package },
      { href: '/admin/financial', label: 'گزارش مالی', icon: BarChart3 },
      { href: '/admin/settlements', label: 'تسویه‌ها', icon: Banknote },
      { href: '/admin/disputes', label: 'داوری اختلاف‌ها', icon: Gavel },
      { href: '/admin/branding', label: 'هویت بصری و بنرها', icon: Palette },
    ],
  },
};

export function DashboardShell({ area, children }: { area: DashboardArea; children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useSession();
  const nav = NAV[area];
  // Only links whose pages (and API guards) accept the current role.
  const items = nav.items.filter((item) => canAccess(item.href, user?.role));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row">
      <aside className="lg:w-60 lg:shrink-0">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:sticky lg:top-20">
          <div className="border-b border-slate-100 px-2 pb-3">
            <p className="text-sm font-bold text-slate-900">{nav.title}</p>
            {user ? (
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {user.fullName || `کاربر ${PLATFORM_NAME}`} · {ROLE_LABELS[user.role]}
              </p>
            ) : null}
          </div>
          <nav className="mt-2 flex gap-1 overflow-x-auto lg:flex-col" aria-label={nav.title}>
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm ${active ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
