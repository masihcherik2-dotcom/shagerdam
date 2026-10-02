import { maskEmail, normalizeEmail } from './email';

describe('normalizeEmail', () => {
  it.each([
    ['  Sara.Mohammadi@Gmail.COM ', 'sara.mohammadi@gmail.com'],
    ['a+shop@sub.example.ir', 'a+shop@sub.example.ir'],
    ["o'neil@example.co.uk", "o'neil@example.co.uk"],
  ])('accepts %p', (input, expected) => {
    expect(normalizeEmail(input)).toBe(expected);
  });

  it.each([
    [''],
    ['plain'],
    ['@example.com'],
    ['a@b'],
    ['a@example.c'],
    ['a b@example.com'],
    ['.a@example.com'],
    ['a.@example.com'],
    ['a..b@example.com'],
    ['a@-example.com'],
    ['Name <a@example.com>'],
    ['a@example.com\r\nBcc: x@y.com'],
    [`${'a'.repeat(65)}@example.com`],
    [`a@${'b'.repeat(250)}.com`],
    [42],
    [null],
  ])('rejects %p', (input) => {
    expect(normalizeEmail(input)).toBeNull();
  });

  it('keeps Gmail dots and +tags (different mailboxes elsewhere)', () => {
    expect(normalizeEmail('s.a.r.a+x@gmail.com')).toBe('s.a.r.a+x@gmail.com');
  });
});

describe('maskEmail', () => {
  it('keeps two characters and the domain', () => {
    expect(maskEmail('sara@gmail.com')).toBe('sa***@gmail.com');
    expect(maskEmail('s@x.ir')).toBe('s***@x.ir');
  });
});
