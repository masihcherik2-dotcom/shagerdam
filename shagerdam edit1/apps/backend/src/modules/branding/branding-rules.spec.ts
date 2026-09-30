import {
  BRANDING_KEYS,
  changedFields,
  linkUrlProblem,
  parseStoredBanners,
  serializeField,
  toPublicBranding,
  valuesFromRows,
  type BrandingValues,
  type StoredHeroBanner,
} from './branding-rules';

const banner = (overrides: Partial<StoredHeroBanner> = {}): StoredHeroBanner => ({
  id: '5b1f7c1e-2d7a-4c5e-9f1a-3c2b1a0d9e8f',
  imageUrl: 'https://api.example.ir/api/v1/media/files/images/branding_hero_banner/a.webp',
  title: null,
  linkUrl: null,
  sortOrder: 1,
  isActive: true,
  ...overrides,
});

describe('branding rules', () => {
  describe('valuesFromRows', () => {
    it('treats missing rows and empty strings as "not set"', () => {
      expect(valuesFromRows([])).toEqual({ logoUrl: null, mobileLogoUrl: null, faviconUrl: null, heroBanners: [] });
      expect(valuesFromRows([{ key: BRANDING_KEYS.logoUrl, value: '' }]).logoUrl).toBeNull();
    });

    it('reads configured values', () => {
      const values = valuesFromRows([
        { key: BRANDING_KEYS.logoUrl, value: 'https://x/logo.webp' },
        { key: BRANDING_KEYS.faviconUrl, value: 'https://x/fav.webp' },
        { key: BRANDING_KEYS.heroBanners, value: JSON.stringify([banner()]) },
        { key: 'unrelated.key', value: 'ignored' },
      ]);
      expect(values.logoUrl).toBe('https://x/logo.webp');
      expect(values.faviconUrl).toBe('https://x/fav.webp');
      expect(values.mobileLogoUrl).toBeNull();
      expect(values.heroBanners).toEqual([banner()]);
    });
  });

  describe('parseStoredBanners', () => {
    it('survives corrupt JSON, non-arrays and malformed entries, reporting each', () => {
      const reasons: string[] = [];
      expect(parseStoredBanners('{not json', (r) => reasons.push(r))).toEqual([]);
      expect(parseStoredBanners('{"a":1}', (r) => reasons.push(r))).toEqual([]);
      expect(parseStoredBanners(JSON.stringify([{ id: 'x' }, banner()]), (r) => reasons.push(r))).toEqual([banner()]);
      expect(reasons).toHaveLength(3);
    });

    it('sorts by sortOrder, stable on ties, and defaults isActive to true', () => {
      const a = banner({ id: 'a', sortOrder: 2 });
      const b = banner({ id: 'b', sortOrder: 1 });
      const c = { ...banner({ id: 'c', sortOrder: 2 }), isActive: undefined };
      const parsed = parseStoredBanners(JSON.stringify([a, b, c]));
      expect(parsed.map((x) => x.id)).toEqual(['b', 'a', 'c']);
      expect(parsed[2]?.isActive).toBe(true);
    });
  });

  describe('toPublicBranding', () => {
    it('exposes only active banners, without the isActive flag', () => {
      const values: BrandingValues = {
        logoUrl: 'L',
        mobileLogoUrl: null,
        faviconUrl: 'F',
        heroBanners: [banner({ id: 'on', sortOrder: 2, title: 'حراج' }), banner({ id: 'off', sortOrder: 1, isActive: false })],
      };
      expect(toPublicBranding(values)).toEqual({
        logoUrl: 'L',
        mobileLogoUrl: null,
        faviconUrl: 'F',
        heroBanners: [{ id: 'on', imageUrl: banner().imageUrl, title: 'حراج', linkUrl: null, sortOrder: 2 }],
      });
    });
  });

  describe('linkUrlProblem', () => {
    it.each(['/search?categorySlug=fashion', '/products/x', '/', 'https://example.com/landing?x=1'])('accepts %s', (link) => {
      expect(linkUrlProblem(link)).toBeNull();
    });

    it.each([
      '//evil.example',
      '/\\evil.example',
      'javascript:alert(1)',
      'data:text/html,x',
      'http://example.com',
      'https://user:pw@example.com',
      'search?x',
      '/a b',
      '/a\nb',
      `/${'a'.repeat(600)}`,
    ])('refuses %s', (link) => {
      expect(linkUrlProblem(link)).not.toBeNull();
    });
  });

  describe('changedFields / serializeField', () => {
    it('detects exactly the fields that differ', () => {
      const before: BrandingValues = { logoUrl: null, mobileLogoUrl: null, faviconUrl: 'F', heroBanners: [banner()] };
      expect(changedFields(before, { ...before })).toEqual([]);
      expect(changedFields(before, { ...before, logoUrl: 'L', heroBanners: [banner({ title: 't' })] })).toEqual(['logoUrl', 'heroBanners']);
    });

    it('stores a cleared logo as an empty string and banners as JSON', () => {
      const values: BrandingValues = { logoUrl: null, mobileLogoUrl: 'M', faviconUrl: null, heroBanners: [banner()] };
      expect(serializeField('logoUrl', values)).toBe('');
      expect(serializeField('mobileLogoUrl', values)).toBe('M');
      expect(JSON.parse(serializeField('heroBanners', values))).toEqual([banner()]);
    });
  });
});
