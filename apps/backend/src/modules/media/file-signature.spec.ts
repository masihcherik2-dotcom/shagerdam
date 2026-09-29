import {
  MAGIC_BYTE_PROBE_LENGTH,
  detectFileType,
  isDetectedImage,
  sanitizeOriginalName,
} from './file-signature';

/**
 * The security boundary of the media pipeline.
 *
 * Every other guard in the module assumes this function is right: if a text file
 * or a ZIP archive were identified as an image here, the Sharp pipeline would be
 * the only thing left between an attacker and a stored, publicly served object.
 * The cases below are therefore written as attacks (“renamed archive”, “SVG with
 * an image extension”, “truncated header”) rather than as happy-path examples.
 */

const png = (): Buffer => {
  const header = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([header, Buffer.alloc(64, 0x11)]);
};

const jpeg = (): Buffer => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 0x22)]);

const gif = (): Buffer => Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64, 0x33)]);

const webp = (): Buffer => {
  const bytes = Buffer.alloc(64, 0x44);
  bytes.write('RIFF', 0, 'latin1');
  bytes.write('WEBP', 8, 'latin1');
  return bytes;
};

const pdf = (): Buffer => Buffer.concat([Buffer.from('%PDF-1.7\n', 'latin1'), Buffer.alloc(64, 0x55)]);

describe('detectFileType (magic bytes, never the extension)', () => {
  it('identifies the four image formats the platform accepts', () => {
    expect(detectFileType(png())).toEqual({ mimeType: 'image/png', extension: 'png', family: 'image' });
    expect(detectFileType(jpeg())).toEqual({ mimeType: 'image/jpeg', extension: 'jpg', family: 'image' });
    expect(detectFileType(gif())).toEqual({ mimeType: 'image/gif', extension: 'gif', family: 'image' });
    expect(detectFileType(webp())).toEqual({ mimeType: 'image/webp', extension: 'webp', family: 'image' });
  });

  it('identifies PDF as a document, not an image', () => {
    expect(detectFileType(pdf())).toEqual({
      mimeType: 'application/pdf',
      extension: 'pdf',
      family: 'document',
    });
  });

  it('rejects another RIFF container: a WAV is not a WebP', () => {
    const wav = Buffer.alloc(64, 0x66);
    wav.write('RIFF', 0, 'latin1');
    wav.write('WAVE', 8, 'latin1');

    expect(detectFileType(wav)).toBeNull();
  });

  it('rejects SVG, which is a script container with an image-shaped name', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'utf8');

    expect(detectFileType(svg)).toBeNull();
    expect(isDetectedImage(svg)).toBe(false);
  });

  it('rejects HTML and plain text', () => {
    expect(detectFileType(Buffer.from('<!doctype html><html></html>', 'utf8'))).toBeNull();
    expect(detectFileType(Buffer.from('name,price\nکالا,1000\n', 'utf8'))).toBeNull();
  });

  it('rejects a ZIP archive however it is named, so "invoice.pdf" cannot be a payload', () => {
    const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 0x00)]);

    expect(detectFileType(zip)).toBeNull();
  });

  it('rejects an executable and a shell script', () => {
    expect(detectFileType(Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.alloc(32)]))).toBeNull();
    expect(detectFileType(Buffer.from('#!/bin/sh\nrm -rf /\n', 'utf8'))).toBeNull();
  });

  it('rejects a truncation of a valid header: seven of eight PNG bytes is not a PNG', () => {
    expect(detectFileType(png().subarray(0, 7))).toBeNull();
  });

  it('rejects buffers shorter than the probe length instead of reading past the end', () => {
    expect(detectFileType(Buffer.from([0x89, 0x50]))).toBeNull();
    expect(detectFileType(Buffer.from([0xff, 0xd8, 0xff]))).toBeNull();
    expect(detectFileType(Buffer.alloc(0))).toBeNull();
    expect(MAGIC_BYTE_PROBE_LENGTH).toBe(12);
  });

  it('never trusts an extension, because it does not receive one', () => {
    // The function signature is the guarantee: there is no parameter an extension
    // could travel through, so no call site can accidentally trust a filename.
    expect(detectFileType.length).toBe(1);
  });

  it('reports image versus document families consistently', () => {
    expect(isDetectedImage(png())).toBe(true);
    expect(isDetectedImage(jpeg())).toBe(true);
    expect(isDetectedImage(webp())).toBe(true);
    expect(isDetectedImage(pdf())).toBe(false);
  });
});

describe('sanitizeOriginalName (stored, logged and shown back to a browser)', () => {
  it('collapses a path traversal into a flat, unusable name', () => {
    const name = sanitizeOriginalName('../../../etc/passwd');

    expect(name).not.toContain('/');
    expect(name).not.toContain('..');
    expect(name).toBe('etc_passwd');
  });

  it('neutralises Windows separators and executable extensions', () => {
    const name = sanitizeOriginalName('..\\..\\windows\\system32\\cmd.exe');

    expect(name).not.toContain('\\');
    expect(name).toBe('windows_system32_cmd.bin');
  });

  it('replaces extensions a browser would render or execute', () => {
    expect(sanitizeOriginalName('payload.html')).toBe('payload.bin');
    expect(sanitizeOriginalName('payload.svg')).toBe('payload.bin');
    expect(sanitizeOriginalName('payload.js')).toBe('payload.bin');
    expect(sanitizeOriginalName('archive.tar.gz')).toBe('archive.tar.bin');
  });

  it('keeps ordinary names untouched, including Persian filenames', () => {
    expect(sanitizeOriginalName('store-logo.png')).toBe('store-logo.png');
    expect(sanitizeOriginalName('کارت ملی.jpg')).toBe('کارت ملی.jpg');
  });

  it('strips control characters and collapses whitespace', () => {
    expect(sanitizeOriginalName('bad\u0000name\u001f  .png')).toBe('badname .png');
  });

  it('never returns an empty name', () => {
    expect(sanitizeOriginalName('   ')).toBe('file');
    expect(sanitizeOriginalName('')).toBe('file');
    expect(sanitizeOriginalName('...')).toBe('file');
  });

  it('caps the length at the column width while keeping the extension readable', () => {
    const name = sanitizeOriginalName(`${'a'.repeat(400)}.png`);

    expect(name.length).toBe(255);
    expect(name.endsWith('.png')).toBe(true);
  });

  it('ignores a client-supplied directory component but keeps the file name', () => {
    expect(sanitizeOriginalName('2026/09/statement.pdf')).toBe('2026_09_statement.pdf');
  });
});
