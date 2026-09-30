import { cleanText, contactIpKey, contactMobileKey, stripFormulaPrefix } from './contact-rules';

describe('contact form rules', () => {
  it('cleans single-line fields', () => {
    expect(cleanText('  علی\t\u0000 رضایی \n ', false)).toBe('علی رضایی');
    expect(cleanText('سلام\u200b دنیا', false)).toBe('سلام دنیا');
  });

  it('keeps paragraphs in multi-line fields but caps blank lines', () => {
    expect(cleanText('خط اول  \r\n\r\n\r\n\r\nخط   دوم\u0007', true)).toBe('خط اول\n\nخط دوم');
  });

  it('neutralises spreadsheet formula prefixes', () => {
    expect(stripFormulaPrefix('=HYPERLINK("x")')).toBe('HYPERLINK("x")');
    expect(stripFormulaPrefix('+-@سفارش')).toBe('سفارش');
    expect(stripFormulaPrefix('سفارش ۱۲')).toBe('سفارش ۱۲');
  });

  it('namespaces the rate-limit keys', () => {
    expect(contactIpKey('1.2.3.4')).toBe('support:contact:ip:1.2.3.4');
    expect(contactMobileKey('+989121234567')).toBe('support:contact:mobile:+989121234567');
  });
});
