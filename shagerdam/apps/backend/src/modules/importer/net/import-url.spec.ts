import { PUBLIC_INTERNET_POLICY } from './address-policy';
import { MAX_IMPORT_URL_LENGTH, parseImportUrl, socketHostname } from './import-url';
import { ImportError, type ImportErrorCode } from '../import-error';

function rejection(raw: string): ImportErrorCode | 'ACCEPTED' {
  try {
    parseImportUrl(raw, PUBLIC_INTERNET_POLICY);
    return 'ACCEPTED';
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

describe('parseImportUrl (SSRF guard)', () => {
  it.each([
    'http://127.0.0.1:4000',
    'http://192.168.1.1',
    'http://127.0.0.1/',
    'https://10.0.0.8/admin',
    'http://172.16.5.4/',
    'http://172.31.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fd00::1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    // Numeric host tricks: WHATWG URL canonicalises them to 127.0.0.1 / 10.0.0.1
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0x0a.0.0.1/',
    // Internal names
    'http://localhost/',
    'http://LOCALHOST./',
    'http://api.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://router.home.arpa/',
    'http://postgres/',
    'http://backend/api/v1/health',
    // Non-web ports on public hosts
    'http://example.com:8080/',
    'https://example.com:5432/',
    'http://example.com:22/',
  ])('rejects %s as BLOCKED_TARGET', (url) => {
    expect(rejection(url)).toBe('BLOCKED_TARGET');
  });

  it.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'gopher://example.com/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'dict://example.com:11211/',
    'http://user:secret@example.com/',
    'https://:token@example.com/',
    'not a url',
    '',
    '   ',
    'example.com/product/1',
    `https://example.com/${'a'.repeat(MAX_IMPORT_URL_LENGTH)}`,
  ])('rejects %p as INVALID_URL', (url) => {
    expect(rejection(url)).toBe('INVALID_URL');
  });

  it.each([
    'https://www.digikala.com/product/dkp-13196935/',
    'http://example.com/',
    'https://shop.example.ir:443/product/1?color=red',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
    '  https://www.allbirds.com/products/mens-tree-runners  ',
  ])('accepts public URL %p', (url) => {
    expect(rejection(url)).toBe('ACCEPTED');
  });

  it('returns the parsed URL (trimmed)', () => {
    const url = parseImportUrl('  https://Shop.Example.com/p/1?x=1  ', PUBLIC_INTERNET_POLICY);
    expect(url.hostname).toBe('shop.example.com');
    expect(url.search).toBe('?x=1');
  });

  it('socketHostname strips brackets and the trailing dot', () => {
    expect(socketHostname(new URL('http://[::1]/'))).toBe('::1');
    expect(socketHostname(new URL('http://Example.COM./'))).toBe('example.com');
  });
});
