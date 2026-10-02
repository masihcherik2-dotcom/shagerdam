import { Lamp, MonitorSmartphone, Scissors, Sparkles, Tag } from 'lucide-react';
import { describe, expect, it } from 'vitest';

import { CATEGORY_ICONS, categoryIcon } from './category-icon';

describe('categoryIcon', () => {
  it('maps exactly the four seeded root categories to their own icons', () => {
    expect(Object.keys(CATEGORY_ICONS).sort()).toEqual(['barber-salon-equipment', 'beauty-products', 'digital-goods', 'home-decor']);
    expect(categoryIcon('digital-goods')).toBe(MonitorSmartphone);
    expect(categoryIcon('home-decor')).toBe(Lamp);
    expect(categoryIcon('beauty-products')).toBe(Sparkles);
    expect(categoryIcon('barber-salon-equipment')).toBe(Scissors);
  });

  it('falls back to the parent icon, then to a neutral tag', () => {
    expect(categoryIcon('hair-clippers', 'barber-salon-equipment')).toBe(Scissors);
    expect(categoryIcon('unknown')).toBe(Tag);
    expect(categoryIcon('unknown', 'also-unknown')).toBe(Tag);
  });
});
