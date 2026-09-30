import { BRANDING_IMAGE_PROFILES, MAX_SVG_BYTES, isBrandingSlot, isSvgDocument, svgRejectionReason } from './branding-image';

const svg = (body: string, prologue = ''): Buffer =>
  Buffer.from(`${prologue}<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40">${body}</svg>`);

describe('branding image rules', () => {
  describe('isSvgDocument', () => {
    it('recognises SVG with or without an XML prologue, BOM, comments or doctype', () => {
      expect(isSvgDocument(svg('<rect/>'))).toBe(true);
      expect(isSvgDocument(svg('<rect/>', '<?xml version="1.0" encoding="UTF-8"?>\n'))).toBe(true);
      expect(isSvgDocument(svg('<rect/>', '\uFEFF<!-- logo -->\n'))).toBe(true);
      expect(
        isSvgDocument(svg('<rect/>', '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n')),
      ).toBe(true);
    });

    it('does not mistake other files for SVG', () => {
      expect(isSvgDocument(Buffer.from('<html><svg></svg></html>'))).toBe(false);
      expect(isSvgDocument(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe(false);
      expect(isSvgDocument(Buffer.from('<svgfoo/>'))).toBe(false);
    });
  });

  describe('svgRejectionReason', () => {
    it('accepts a self-contained SVG (internal refs and embedded raster data are fine)', () => {
      expect(svgRejectionReason(svg('<defs><linearGradient id="g"/></defs><rect fill="url(#g)"/><use href="#g"/>'))).toBeNull();
      expect(svgRejectionReason(svg('<image href="data:image/png;base64,iVBORw0KGgo="/>'))).toBeNull();
    });

    it('refuses entity declarations (billion laughs / XXE)', () => {
      const doc = Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "aaaa">]><svg xmlns="http://www.w3.org/2000/svg">&a;</svg>');
      expect(svgRejectionReason(doc)).toMatch(/entities/);
    });

    it('refuses external references', () => {
      expect(svgRejectionReason(svg('<image href="https://tracker.example/p.png"/>'))).toMatch(/external/);
      expect(svgRejectionReason(svg('<image xlink:href="file:///etc/passwd"/>'))).toMatch(/external/);
      expect(svgRejectionReason(svg('<style>@import "https://x/y.css";</style>'))).toMatch(/external/);
      expect(svgRejectionReason(svg('<rect style="fill:url(https://x/y)"/>'))).toMatch(/external/);
    });

    it('refuses oversize SVG', () => {
      expect(svgRejectionReason(Buffer.alloc(MAX_SVG_BYTES + 1, 0x20))).toMatch(/KB/);
    });
  });

  it('only logo slots accept SVG; the favicon is square', () => {
    expect(BRANDING_IMAGE_PROFILES.hero_banner.acceptsSvg).toBe(false);
    expect(BRANDING_IMAGE_PROFILES.logo.acceptsSvg && BRANDING_IMAGE_PROFILES.mobile_logo.acceptsSvg && BRANDING_IMAGE_PROFILES.favicon.acceptsSvg).toBe(true);
    expect(BRANDING_IMAGE_PROFILES.favicon.fit).toBe('contain');
    expect(BRANDING_IMAGE_PROFILES.favicon.width).toBe(BRANDING_IMAGE_PROFILES.favicon.height);
  });

  it('isBrandingSlot guards the multipart field', () => {
    expect(isBrandingSlot('logo')).toBe(true);
    expect(isBrandingSlot('store_logo')).toBe(false);
    expect(isBrandingSlot(undefined)).toBe(false);
  });
});
