/**
 * Detected file type, derived from the file's own bytes.
 *
 * `mimeType` is what the pipeline trusts; a client-supplied `Content-Type` or
 * file extension is only ever used as a first hint and never as the basis of a
 * decision. ``null`` means "not in the allow-list".
 */
export interface DetectedFileType {
  mimeType: string;
  /** Canonical extension without the dot, e.g. `png`. */
  extension: string;
  /** The family the media module reasons about. */
  family: 'image' | 'document';
}

/**
 * Magic-byte signatures.
 *
 * Each entry checks a fixed byte offset, which is what makes this reliable:
 * a `.png` renamed to `.jpg`, or a ZIP archive renamed to `.pdf`, is rejected
 * here rather than after it reaches the image pipeline.
 */
const SIGNATURES: ReadonlyArray<{
  offset: number;
  bytes: readonly number[];
  type: DetectedFileType;
}> = [
  {
    offset: 0,
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    type: { mimeType: 'image/png', extension: 'png', family: 'image' },
  },
  {
    offset: 0,
    bytes: [0xff, 0xd8, 0xff],
    type: { mimeType: 'image/jpeg', extension: 'jpg', family: 'image' },
  },
  {
    offset: 0,
    bytes: [0x47, 0x49, 0x46, 0x38],
    type: { mimeType: 'image/gif', extension: 'gif', family: 'image' },
  },
  {
    offset: 0,
    bytes: [0x25, 0x50, 0x44, 0x46, 0x2d], // "%PDF-"
    type: { mimeType: 'application/pdf', extension: 'pdf', family: 'document' },
  },
];

/**
 * WEBP is `RIFF....WEBP`: the `RIFF` marker at 0, the file size at 4, and the
 * format tag at 8. Checking both halves is what distinguishes a real WebP from
 * any other RIFF container (e.g. a WAV file).
 */
const RIFF_MARKER = [0x52, 0x49, 0x46, 0x46];
const WEBP_TAG = [0x57, 0x45, 0x42, 0x50];

/** Minimum number of bytes this module needs to identify anything. */
export const MAGIC_BYTE_PROBE_LENGTH = 12;

/**
 * Identifies a buffer from its leading bytes, or returns `null` when the file is
 * not one of the supported types.
 *
 * Supported: PNG, JPEG, GIF, WEBP (images) and PDF (documents). Everything else
 * — archives, executables, SVG (which can carry script), office documents — is
 * rejected by omission, which is safer than trying to enumerate what is bad.
 */
export function detectFileType(buffer: Buffer): DetectedFileType | null {
  if (buffer.length < MAGIC_BYTE_PROBE_LENGTH) {
    return null;
  }

  for (const signature of SIGNATURES) {
    if (matchesAt(buffer, signature.bytes, signature.offset)) {
      return signature.type;
    }
  }

  if (matchesAt(buffer, RIFF_MARKER, 0) && matchesAt(buffer, WEBP_TAG, 8)) {
    return { mimeType: 'image/webp', extension: 'webp', family: 'image' };
  }

  return null;
}

/** True when `buffer` would be accepted as an image. */
export function isDetectedImage(buffer: Buffer): boolean {
  return detectFileType(buffer)?.family === 'image';
}

function matchesAt(buffer: Buffer, bytes: readonly number[], offset: number): boolean {
  if (buffer.length < offset + bytes.length) {
    return false;
  }
  for (let index = 0; index < bytes.length; index += 1) {
    if (buffer[offset + index] !== bytes[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Rejects the extensions that are dangerous regardless of content, and caps the
 * length of a caller-supplied filename so it cannot be used to smuggle a path or
 * overflow a column.
 *
 * This runs *in addition* to magic-byte detection: the extension is never
 * trusted, only sanitized, because the original name is returned to the user and
 * stored for support purposes.
 */
const UNSAFE_EXTENSIONS = /\.(php\d?|phtml|jsp|x?html?|svgz?|exe|sh|bat|cmd|js|mjs|cjs|jar|zip|rar|7z|tar|gz)$/i;

/** Longest filename the `media_assets.original_name` column accepts. */
const MAX_ORIGINAL_NAME_LENGTH = 255;

/**
 * Produces a filename that is safe to store, log and hand back to a browser:
 *
 * - path separators are replaced, so `../../etc/passwd` cannot read as a path;
 * - control characters are dropped and whitespace runs collapsed;
 * - leading dots/underscores are stripped (no hidden or relative-looking names);
 * - an extension that could ever be executed or rendered by a browser is replaced
 *   with `.bin` — the *content* is already validated by magic bytes, this only
 *   stops the stored name from implying otherwise;
 * - the length is capped at the column width, keeping the extension intact so the
 *   truncated name is still meaningful.
 */
export function sanitizeOriginalName(name: string): string {
  const base = name
    .replace(/[\\/]+/g, '_')
    // Control characters are exactly what must be removed from a stored name;
    // matching them is the purpose of this line, not an accident.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s_]+/, '')
    .trim();

  const safeExtension = UNSAFE_EXTENSIONS.test(base) ? base.replace(UNSAFE_EXTENSIONS, '.bin') : base;
  if (safeExtension.length === 0) {
    return 'file';
  }
  return capLengthKeepingExtension(safeExtension);
}

function capLengthKeepingExtension(name: string): string {
  if (name.length <= MAX_ORIGINAL_NAME_LENGTH) {
    return name;
  }
  const dot = name.lastIndexOf('.');
  const hasUsableExtension = dot > 0 && name.length - dot <= 12;
  if (!hasUsableExtension) {
    return name.slice(0, MAX_ORIGINAL_NAME_LENGTH);
  }
  const extension = name.slice(dot);
  return `${name.slice(0, MAX_ORIGINAL_NAME_LENGTH - extension.length)}${extension}`;
}
