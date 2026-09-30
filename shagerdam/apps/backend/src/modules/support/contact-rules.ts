/**
 * Pure rules of the public contact form (`POST /support/contact-messages`).
 * Unit-tested in `contact-rules.spec.ts`.
 */

export const CONTACT_LIMITS = {
  fullName: { min: 2, max: 120 },
  subject: { min: 3, max: 150 },
  message: { min: 10, max: 2000 },
  staffNote: { max: 2000 },
} as const;

/** Anonymous abuse guard (Redis counters, rolling hour). */
export const CONTACT_MAX_PER_IP_PER_HOUR = 5;
export const CONTACT_MAX_PER_MOBILE_PER_HOUR = 3;
export const CONTACT_WINDOW_SECONDS = 3600;

export function contactIpKey(ip: string): string {
  return `support:contact:ip:${ip}`;
}

export function contactMobileKey(mobile: string): string {
  return `support:contact:mobile:${mobile}`;
}

/**
 * Normalises free text before storage: removes control characters (except
 * newlines in multi-line fields), trims, collapses runs of spaces and caps
 * consecutive blank lines. The text is always rendered escaped (React), so
 * this is about data quality and log/CSV safety, not HTML.
 */
export function cleanText(value: string, multiline: boolean): string {
  // eslint-disable-next-line no-control-regex
  const withoutControls = value.replace(/\r\n?/g, '\n').replace(multiline ? /[\u0000-\u0009\u000b-\u001f\u007f\u200b-\u200d\u2028\u2029]/g : /[\u0000-\u001f\u007f\u200b-\u200d\u2028\u2029]/g, multiline ? '' : ' ');
  if (!multiline) {
    return withoutControls.replace(/\s+/g, ' ').trim();
  }
  return withoutControls
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Characters that make a CSV/spreadsheet cell a formula; neutralised at the start of short fields. */
export function stripFormulaPrefix(value: string): string {
  return value.replace(/^[=+\-@]+/, '').trim();
}
