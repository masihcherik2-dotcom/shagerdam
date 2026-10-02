import { Lamp, MonitorSmartphone, Scissors, Sparkles, Tag, type LucideIcon } from 'lucide-react';

/**
 * Icon of a storefront category, by slug. Covers the four root departments of
 * the seeded taxonomy; a category an admin adds later falls back to its parent
 * root's icon when known, otherwise to a neutral tag — never to a blank tile.
 */
export const CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
  'digital-goods': MonitorSmartphone,
  'home-decor': Lamp,
  'beauty-products': Sparkles,
  'barber-salon-equipment': Scissors,
};

export function categoryIcon(slug: string, parentSlug?: string | null): LucideIcon {
  return CATEGORY_ICONS[slug] ?? (parentSlug ? CATEGORY_ICONS[parentSlug] : undefined) ?? Tag;
}

export function CategoryIcon({ slug, parentSlug, className }: { slug: string; parentSlug?: string | null; className?: string }) {
  const Icon = categoryIcon(slug, parentSlug);
  return <Icon className={className} aria-hidden="true" />;
}
