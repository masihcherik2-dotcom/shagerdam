import { GoogleKeys, sanitizeNextPath } from './google-auth.service';

describe('sanitizeNextPath', () => {
  it('keeps same-site paths with their query', () => {
    expect(sanitizeNextPath('/cart')).toBe('/cart');
    expect(sanitizeNextPath('/products/x?variant=A-1#top')).toBe('/products/x?variant=A-1#top');
  });

  it('drops anything that could leave the site or is not a path', () => {
    for (const value of ['https://evil.example/', '//evil.example', '/\\evil.example', 'cart', '', '/a\nb', `/${'x'.repeat(600)}`, 42, null, undefined]) {
      expect(sanitizeNextPath(value)).toBeNull();
    }
  });
});

describe('GoogleKeys', () => {
  it('never stores a signup ticket in clear in the Redis key', () => {
    const ticket = 'T'.repeat(43);
    expect(GoogleKeys.signup(ticket)).toMatch(/^auth:google:signup:[0-9a-f]{64}$/);
    expect(GoogleKeys.signup(ticket)).not.toContain(ticket);
    expect(GoogleKeys.state('abc')).toBe('auth:google:state:abc');
  });
});
