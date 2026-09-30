import {
  BookOpen,
  Car,
  CookingPot,
  Cpu,
  Droplets,
  Dumbbell,
  Footprints,
  HeartPulse,
  Headphones,
  Laptop,
  Milk,
  Refrigerator,
  Shirt,
  ShoppingBasket,
  Smartphone,
  Sofa,
  Sparkles,
  Tag,
  Tent,
  Wrench,
  Hammer,
  Mountain,
  type LucideIcon,
} from 'lucide-react';

/**
 * Icon of a storefront category, by slug. Covers the seeded taxonomy (every
 * root and child); a category an admin adds later falls back to its parent
 * root's icon when known, otherwise to a neutral tag — never to a blank tile.
 */
export const CATEGORY_ICONS: Readonly<Record<string, LucideIcon>> = {
  digital: Cpu,
  mobile: Smartphone,
  laptop: Laptop,
  'digital-accessories': Headphones,
  'home-kitchen': Sofa,
  'home-appliances': Refrigerator,
  kitchenware: CookingPot,
  fashion: Shirt,
  'mens-clothing': Shirt,
  'womens-clothing': Sparkles,
  'bags-shoes': Footprints,
  'beauty-health': HeartPulse,
  skincare: Droplets,
  'personal-care': Sparkles,
  supermarket: ShoppingBasket,
  'food-beverage': ShoppingBasket,
  dairy: Milk,
  'books-stationery': BookOpen,
  books: BookOpen,
  'sport-travel': Mountain,
  'fitness-equipment': Dumbbell,
  'camping-travel': Tent,
  'tools-auto': Wrench,
  'power-tools': Hammer,
  'car-accessories': Car,
};

export function categoryIcon(slug: string, parentSlug?: string | null): LucideIcon {
  return CATEGORY_ICONS[slug] ?? (parentSlug ? CATEGORY_ICONS[parentSlug] : undefined) ?? Tag;
}

export function CategoryIcon({ slug, parentSlug, className }: { slug: string; parentSlug?: string | null; className?: string }) {
  const Icon = categoryIcon(slug, parentSlug);
  return <Icon className={className} aria-hidden="true" />;
}
