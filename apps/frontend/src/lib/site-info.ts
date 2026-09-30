import type { SiteInfo } from './api/types';

export const EMPTY_SITE_INFO: SiteInfo = {
  legalName: null,
  nationalId: null,
  registrationNumber: null,
  supportPhone: null,
  supportEmail: null,
  officeAddress: null,
  postalCode: null,
  workingHours: null,
  enamadLinkUrl: null,
  enamadImageUrl: null,
  samandehiLinkUrl: null,
  samandehiImageUrl: null,
  googleVerificationTag: null,
};

/** Keeps only string values of known fields; anything else is "not set". */
export function normalizeSiteInfo(raw: unknown): SiteInfo {
  if (typeof raw !== 'object' || raw === null) return EMPTY_SITE_INFO;
  const source = raw as Record<string, unknown>;
  const result = { ...EMPTY_SITE_INFO };
  for (const key of Object.keys(EMPTY_SITE_INFO) as Array<keyof SiteInfo>) {
    const value = source[key];
    result[key] = typeof value === 'string' && value.trim() !== '' ? value : null;
  }
  return result;
}

/** `tel:` target of a phone such as «021-91000000» (digits only). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`;
}

/** True when the footer has at least one legal identity line to show. */
export function hasLegalIdentity(info: SiteInfo): boolean {
  return Boolean(info.legalName || info.nationalId || info.registrationNumber || info.officeAddress || info.postalCode);
}

/** Admin form labels (also used to name the field in validation errors). */
export const SITE_INFO_FIELD_LABELS: Record<string, string> = {
  legalName: 'نام حقوقی کسب‌وکار',
  nationalId: 'شناسهٔ ملی',
  registrationNumber: 'شمارهٔ ثبت',
  supportPhone: 'تلفن پشتیبانی',
  supportEmail: 'ایمیل پشتیبانی',
  officeAddress: 'نشانی دفتر مرکزی',
  postalCode: 'کد پستی',
  workingHours: 'ساعات کاری',
  enamadLinkUrl: 'لینک تأیید اینماد',
  enamadImageUrl: 'تصویر نماد اینماد',
  samandehiLinkUrl: 'لینک تأیید ساماندهی',
  samandehiImageUrl: 'تصویر نشان ساماندهی',
  googleVerificationTag: 'کد تأیید Google Search Console',
};
