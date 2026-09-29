import { describe, expect, it } from 'vitest';

import { isExternalLink, isValidBannerLink } from './branding';

describe('isValidBannerLink (mirrors the backend rule)', () => {
  it.each(['/search?categorySlug=fashion', '/', 'https://example.com/x'])('accepts %s', (link) => {
    expect(isValidBannerLink(link)).toBe(true);
  });
  it.each(['//evil.example', '/\\evil', 'javascript:alert(1)', 'http://example.com', 'search', '/a b', 'https://u:p@x.com'])('refuses %s', (link) => {
    expect(isValidBannerLink(link)).toBe(false);
  });
});

describe('isExternalLink', () => {
  it('only https URLs are external', () => {
    expect(isExternalLink('https://example.com')).toBe(true);
    expect(isExternalLink('/search')).toBe(false);
  });
});
