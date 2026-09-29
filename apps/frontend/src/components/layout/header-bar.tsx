'use client';

import {
  ChevronDown,
  LayoutDashboard,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Search,
  ShoppingCart,
  Store,
  User,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useCart } from '@/components/providers/cart-provider';
import { useSession } from '@/components/providers/session-provider';
import { apiGet } from '@/lib/api/client';
import type { CategoryTreeNode, Page, ProductListItem } from '@/lib/api/types';
import { homeForRole } from '@/lib/auth/access';
import { formatToman } from '@/lib/currency';
import { toPersianDigits } from '@/lib/format';
import { useDebounced } from '@/lib/hooks/use-api';
import { ROLE_LABELS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

import { BrandLogo } from './brand-logo';

export function HeaderBar({
  categories,
  categoriesError,
  logoUrl = null,
  mobileLogoUrl = null,
}: {
  categories: CategoryTreeNode[];
  categoriesError: boolean;
  logoUrl?: string | null;
  mobileLogoUrl?: string | null;
}) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <Link href="/" aria-label={`${PLATFORM_NAME} — صفحهٔ اصلی`} className="flex shrink-0 items-center gap-2 text-lg font-black text-brand-700">
          <BrandLogo variant="header" logoUrl={logoUrl} mobileLogoUrl={mobileLogoUrl} />
        </Link>
        <CategoryMenu categories={categories} failed={categoriesError} />
        <HeaderSearch />
        <div className="ms-auto flex items-center gap-1">
          <CartButton />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function CategoryMenu({ categories, failed }: { categories: CategoryTreeNode[]; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const activeNode = categories.find((node) => node.id === active) ?? categories[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
      >
        <LayoutGrid className="size-4" />
        <span className="hidden md:inline">دسته‌بندی‌ها</span>
        <ChevronDown className="size-4" />
      </button>
      {open ? (
        <div className="absolute start-0 top-12 z-50 w-[min(90vw,44rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          {failed ? (
            <p className="p-4 text-sm text-rose-700">فهرست دسته‌بندی‌ها بارگذاری نشد. صفحه را دوباره باز کنید.</p>
          ) : categories.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">هنوز دسته‌بندی فعالی ثبت نشده است.</p>
          ) : (
            <div className="flex max-h-[70vh]">
              <ul className="w-48 shrink-0 overflow-y-auto border-e border-slate-100 bg-slate-50 py-2">
                {categories.map((node) => (
                  <li key={node.id}>
                    <Link
                      href={`/categories/${node.slug}`}
                      onMouseEnter={() => setActive(node.id)}
                      onFocus={() => setActive(node.id)}
                      className={`flex items-center justify-between px-4 py-2 text-sm ${activeNode?.id === node.id ? 'bg-white font-bold text-brand-700' : 'text-slate-700'}`}
                    >
                      {node.titleFa}
                      <span className="text-xs text-slate-400">{toPersianDigits(node.totalProductCount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex-1 overflow-y-auto p-4">
                {activeNode ? (
                  <>
                    <Link href={`/categories/${activeNode.slug}`} className="mb-3 inline-block text-sm font-bold text-brand-700">
                      همهٔ {activeNode.titleFa} ←
                    </Link>
                    {activeNode.children.length === 0 ? (
                      <p className="text-sm text-slate-500">زیرشاخه‌ای ندارد.</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-4">
                        {activeNode.children.map((child) => (
                          <div key={child.id}>
                            <Link href={`/categories/${child.slug}`} className="text-sm font-medium text-slate-800 hover:text-brand-700">
                              {child.titleFa}
                            </Link>
                            {child.children.length > 0 ? (
                              <ul className="mt-1 flex flex-col gap-1">
                                {child.children.map((leaf) => (
                                  <li key={leaf.id}>
                                    <Link href={`/categories/${leaf.slug}`} className="text-xs text-slate-500 hover:text-brand-700">
                                      {leaf.titleFa}
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function HeaderSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const [term, setTerm] = useState('');
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<ProductListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const debounced = useDebounced(term.trim(), 300);

  useEffect(() => {
    setFocused(false);
  }, [pathname]);

  useEffect(() => {
    if (debounced.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiGet<Page<ProductListItem>>('/products', { query: { search: debounced, pageSize: 6 } })
      .then((page) => {
        if (!cancelled) {
          setResults(page.items);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = term.trim();
    setFocused(false);
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }

  const showPanel = focused && debounced.length >= 2;

  return (
    <form onSubmit={submit} role="search" className="relative min-w-0 flex-1 md:max-w-xl">
      <label htmlFor="header-search" className="sr-only">
        جست‌وجوی محصولات
      </label>
      <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
      <input
        id="header-search"
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="جست‌وجو در محصولات، برندها و فروشگاه‌ها…"
        autoComplete="off"
        className="h-10 w-full rounded-xl border border-slate-200 bg-slate-100 pe-3 ps-9 text-sm focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
      />
      {showPanel ? (
        <div className="absolute inset-x-0 top-12 z-50 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          {loading && results === null ? (
            <p className="flex items-center gap-2 p-4 text-sm text-slate-500">
              <LoaderCircle className="size-4 animate-spin" /> در حال جست‌وجو…
            </p>
          ) : failed ? (
            <p className="p-4 text-sm text-rose-700">جست‌وجو انجام نشد؛ دوباره تلاش کنید.</p>
          ) : results && results.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">محصولی با «{debounced}» پیدا نشد.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {(results ?? []).map((item) => (
                <li key={item.id}>
                  <Link href={`/products/${item.slug}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <span className="relative size-10 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                      {item.primaryImage ? (
                        <Image src={item.primaryImage.thumbnailUrl ?? item.primaryImage.url} alt="" fill sizes="40px" className="object-cover" unoptimized />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-slate-800">{item.title}</span>
                      <span className="block text-xs text-slate-500">{item.vendor.storeName}</span>
                    </span>
                    <span className="text-xs font-bold text-slate-700">{formatToman(item.priceRange.min)}</span>
                  </Link>
                </li>
              ))}
              <li>
                <button type="submit" className="w-full px-4 py-2.5 text-start text-sm font-medium text-brand-700 hover:bg-brand-50">
                  مشاهدهٔ همهٔ نتایج «{debounced}»
                </button>
              </li>
            </ul>
          )}
        </div>
      ) : null}
    </form>
  );
}

function CartButton() {
  const { count, loading } = useCart();
  return (
    <Link href="/cart" className="relative inline-flex size-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100" aria-label={`سبد خرید، ${toPersianDigits(count)} کالا`}>
      <ShoppingCart className="size-5" />
      {!loading && count > 0 ? (
        <span className="absolute -end-0.5 -top-0.5 flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[11px] font-bold leading-5 text-white">
          {toPersianDigits(count > 99 ? '99+' : count)}
        </span>
      ) : null}
    </Link>
  );
}

function UserMenu() {
  const { me, user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!user) {
    return (
      <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50">
        <LogIn className="size-4" /> <span className="hidden sm:inline">ورود | ثبت‌نام</span>
      </Link>
    );
  }

  const links: Array<{ href: string; label: string; icon: typeof User }> = [{ href: homeForRole(user.role), label: 'پنل کاربری', icon: LayoutDashboard }];
  if (user.role === 'CUSTOMER') {
    links.push({ href: '/customer/profile', label: 'حساب کاربری', icon: User });
    links.push({ href: '/vendor/register', label: me?.vendor ? 'وضعیت فروشگاه من' : 'فروشنده شوید', icon: Store });
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-slate-800 hover:bg-slate-100">
        <User className="size-4" />
        <span className="hidden max-w-32 truncate sm:inline">{user.fullName || `کاربر ${PLATFORM_NAME}`}</span>
        <ChevronDown className="size-4" />
      </button>
      {open ? (
        <div className="absolute end-0 top-12 z-50 w-60 overflow-hidden rounded-2xl border border-slate-200 bg-white py-2 shadow-xl">
          <div className="border-b border-slate-100 px-4 pb-2">
            <p className="truncate text-sm font-bold text-slate-900">{user.fullName || `کاربر ${PLATFORM_NAME}`}</p>
            <p className="text-xs text-slate-500">{ROLE_LABELS[user.role]}</p>
          </div>
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              <link.icon className="size-4" /> {link.label}
            </Link>
          ))}
          <button type="button" onClick={() => void signOut()} className="flex w-full items-center gap-2 px-4 py-2 text-sm text-rose-700 hover:bg-rose-50">
            <LogOut className="size-4" /> خروج
          </button>
        </div>
      ) : null}
    </div>
  );
}
