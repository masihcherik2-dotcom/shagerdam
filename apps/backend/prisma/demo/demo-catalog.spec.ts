import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isValidSheba } from '../../src/common/validators/iranian-sheba';
import { CATEGORY_TREE } from '../seed';
import { DEMO_PRODUCTS, DEMO_STORES } from './demo-catalog.data';
import { demoVariants, resolveDemoMobiles, resolveDemoVisibility } from './demo-catalog';

const ASSETS = join(__dirname, 'assets');
const ROOT_SLUGS = CATEGORY_TREE.map((root) => root.slug);

describe('demo catalogue data', () => {
  it('has 2 complete stores (logo file, SHEBA, Instagram, bio)', () => {
    expect(DEMO_STORES).toHaveLength(2);
    for (const store of DEMO_STORES) {
      expect(isValidSheba(store.bankIban)).toBe(true);
      expect(store.instagramHandle.length).toBeGreaterThan(2);
      expect(store.bio.length).toBeGreaterThan(20);
      expect(existsSync(join(ASSETS, 'logos', store.logo))).toBe(true);
    }
    expect(new Set(DEMO_STORES.map((store) => store.storeSlug)).size).toBe(2);
  });

  it('places every product in one of the four storefront root categories', () => {
    expect(DEMO_PRODUCTS).toHaveLength(18);
    expect(DEMO_PRODUCTS.filter((product) => !ROOT_SLUGS.includes(product.categorySlug)).map((product) => product.slug)).toEqual([]);
    for (const slug of ['digital-goods', 'beauty-products', 'barber-salon-equipment']) {
      expect([slug, DEMO_PRODUCTS.some((product) => product.categorySlug === slug)]).toEqual([slug, true]);
    }
  });

  it('every product is complete: image file, specs, stock, valid prices, unique slug', () => {
    expect(new Set(DEMO_PRODUCTS.map((product) => product.slug)).size).toBe(DEMO_PRODUCTS.length);
    for (const product of DEMO_PRODUCTS) {
      expect(existsSync(join(ASSETS, 'products', product.image))).toBe(true);
      expect(product.specs.length).toBeGreaterThanOrEqual(2);
      expect(product.stock).toBeGreaterThan(0);
      expect(product.priceToman).toBeGreaterThan(0);
      if (product.compareAtToman !== null) expect(product.compareAtToman).toBeGreaterThan(product.priceToman);
      expect(DEMO_STORES.some((store) => store.key === product.store)).toBe(true);
    }
  });
});

describe('demo catalogue helpers', () => {
  it('hides demo data in production unless told otherwise', () => {
    expect(resolveDemoVisibility({ NODE_ENV: 'production' })).toBe('hidden');
    expect(resolveDemoVisibility({ NODE_ENV: 'development' })).toBe('live');
    expect(resolveDemoVisibility({ NODE_ENV: 'production', DEMO_VISIBILITY: 'LIVE' })).toBe('live');
    expect(() => resolveDemoVisibility({ DEMO_VISIBILITY: 'public' })).toThrow(/hidden" or "live/);
  });

  it('takes the owner mobiles from DEMO_VENDOR_MOBILES (exactly 2, normalised)', () => {
    expect(resolveDemoMobiles({})).toEqual(DEMO_STORES.map((store) => store.defaultMobile));
    expect(resolveDemoMobiles({ DEMO_VENDOR_MOBILES: '09120000001, +989120000002' })).toEqual(['+989120000001', '+989120000002']);
    expect(() => resolveDemoMobiles({ DEMO_VENDOR_MOBILES: '09120000001' })).toThrow(/2 Iranian mobiles/);
  });

  it('builds the colour × size matrix in Rials with stock split per cell', () => {
    const product = { ...DEMO_PRODUCTS[0]!, priceToman: 1_000, compareAtToman: 1_200, stock: 10, colors: [{ name: 'مشکی', hex: '#111827' }, { name: 'سفید', hex: '#FFFFFF' }], sizes: ['M', 'L'] };
    const variants = demoVariants(product, 'DEMO-001');
    expect(variants.map((variant) => variant.sku)).toEqual(['DEMO-001-01', 'DEMO-001-02', 'DEMO-001-03', 'DEMO-001-04']);
    expect(variants.every((variant) => variant.price === 10_000 && variant.compareAtPrice === 12_000 && variant.stockQuantity === 2)).toBe(true);
    expect(demoVariants({ ...product, colors: [], sizes: [] }, 'DEMO-002')).toHaveLength(1);
  });
});
