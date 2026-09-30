import type { AdminCreateVendorInput } from './api/types';
import { toLatinDigits } from './format';
import { IRAN_MOBILE_PATTERN, isValidSheba } from './iran';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface AdminVendorForm {
  storeName: string;
  storeSlug: string;
  ownerMobile: string;
  ownerFullName: string;
  bankIban: string;
  bankAccountHolder: string;
  commission: string;
  instagramHandle: string;
  bio: string;
}

export const EMPTY_ADMIN_VENDOR_FORM: AdminVendorForm = { storeName: '', storeSlug: '', ownerMobile: '', ownerFullName: '', bankIban: '', bankAccountHolder: '', commission: '', instagramHandle: '', bio: '' };

/** Client-side mirror of AdminCreateVendorDto (the API validates again). */
export function validateAdminVendor(form: AdminVendorForm): { errors: Partial<Record<keyof AdminVendorForm, string>>; payload: AdminCreateVendorInput | null } {
  const errors: Partial<Record<keyof AdminVendorForm, string>> = {};
  const storeName = form.storeName.trim();
  if (storeName.length < 2 || storeName.length > 120) errors.storeName = 'نام فروشگاه ۲ تا ۱۲۰ نویسه است.';
  const storeSlug = form.storeSlug.trim().toLowerCase();
  if (storeSlug.length < 3 || storeSlug.length > 140 || !SLUG.test(storeSlug)) errors.storeSlug = 'فقط حروف کوچک لاتین، رقم و خط تیره (دست‌کم ۳ نویسه).';
  const ownerMobile = toLatinDigits(form.ownerMobile.trim()).replace(/[\s-]/g, '');
  if (!IRAN_MOBILE_PATTERN.test(ownerMobile)) errors.ownerMobile = 'شمارهٔ موبایل معتبر نیست (مثل ۰۹۱۲۱۲۳۴۵۶۷).';
  const ownerFullName = form.ownerFullName.trim();
  if (ownerFullName.length < 3 || ownerFullName.length > 120) errors.ownerFullName = 'نام مالک ۳ تا ۱۲۰ نویسه است.';
  const bankIban = toLatinDigits(form.bankIban.trim()).replace(/\s/g, '').toUpperCase();
  if (!isValidSheba(bankIban)) errors.bankIban = 'شمارهٔ شبا معتبر نیست.';
  const holder = form.bankAccountHolder.trim();
  if (holder && (holder.length < 3 || holder.length > 120)) errors.bankAccountHolder = 'نام صاحب حساب ۳ تا ۱۲۰ نویسه است.';
  let commissionRateOverride: number | null = null;
  const commissionText = toLatinDigits(form.commission.trim());
  if (commissionText) {
    const rate = Number(commissionText);
    if (!Number.isFinite(rate) || rate < 0 || rate > 100 || !/^\d+(\.\d{1,2})?$/.test(commissionText)) errors.commission = 'درصدی بین ۰ تا ۱۰۰ با حداکثر دو رقم اعشار.';
    else commissionRateOverride = rate;
  }
  const instagramHandle = form.instagramHandle.trim().replace(/^@/, '');
  if (instagramHandle.length > 60) errors.instagramHandle = 'حداکثر ۶۰ نویسه.';
  const bio = form.bio.trim();
  if (bio.length > 2000) errors.bio = 'حداکثر ۲۰۰۰ نویسه.';
  if (Object.keys(errors).length > 0) return { errors, payload: null };
  return {
    errors,
    payload: {
      storeName,
      storeSlug,
      ownerMobile,
      ownerFullName,
      bankIban,
      ...(holder ? { bankAccountHolder: holder } : {}),
      commissionRateOverride,
      ...(instagramHandle ? { instagramHandle } : {}),
      ...(bio ? { bio } : {}),
    },
  };
}

