import { Cpu, Tag, Tent } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { CATEGORY_ICONS, categoryIcon } from './category-icon';

describe('categoryIcon', () => {
  it('maps every seeded category slug', () => {
    const seeded = ['digital', 'mobile', 'laptop', 'digital-accessories', 'home-kitchen', 'home-appliances', 'kitchenware', 'fashion', 'mens-clothing', 'womens-clothing', 'bags-shoes', 'beauty-health', 'skincare', 'personal-care', 'supermarket', 'food-beverage', 'dairy', 'books-stationery', 'books', 'sport-travel', 'fitness-equipment', 'camping-travel', 'tools-auto', 'power-tools', 'car-accessories'];
    expect(seeded.filter((slug) => !CATEGORY_ICONS[slug])).toEqual([]);
  });

  it('falls back to the parent icon, then to a neutral tag', () => {
    expect(categoryIcon('camping-travel')).toBe(Tent);
    expect(categoryIcon('new-child', 'digital')).toBe(Cpu);
    expect(categoryIcon('unknown')).toBe(Tag);
  });
});
