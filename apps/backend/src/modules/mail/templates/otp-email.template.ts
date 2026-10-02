import { PLATFORM_DISPLAY_NAME } from '../../../common/brand';
import type { MailMessage } from '../mail-provider.interface';

export interface OtpEmailInput {
  to: string;
  code: string;
  expiresInSeconds: number;
}

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

function toPersianDigits(value: number): string {
  return String(value).replace(/\d/g, (digit) => PERSIAN_DIGITS[Number(digit)]!);
}

function validity(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${toPersianDigits(seconds / 60)} دقیقه` : `${toPersianDigits(seconds)} ثانیه`;
}

/**
 * Sign-in code e-mail: Persian, right-to-left, inline styles only (mail clients
 * strip <style> and external CSS). The code stays in Latin digits so it can be
 * copied and auto-filled; it is the only run of digits in the plain-text body.
 * Nothing user-supplied is interpolated except the code (digits, validated).
 */
export function renderOtpEmail(input: OtpEmailInput): MailMessage {
  if (!/^\d{4,8}$/.test(input.code)) {
    throw new Error('Refusing to render an e-mail with a malformed code');
  }
  const minutes = validity(input.expiresInSeconds);
  const subject = `کد ورود به ${PLATFORM_DISPLAY_NAME}`;
  const text = [
    `کد ورود شما به ${PLATFORM_DISPLAY_NAME}:`,
    '',
    input.code,
    '',
    `این کد تا ${minutes} معتبر است و فقط یک بار قابل استفاده است.`,
    'این کد را به هیچ‌کس، حتی پشتیبانی، ندهید.',
    'اگر شما درخواست ورود نداده‌اید، این ایمیل را نادیده بگیرید؛ بدون این کد کسی وارد حساب شما نمی‌شود.',
  ].join('\n');

  const html = `<!doctype html>
<html lang="fa" dir="rtl">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${subject}</title></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Tahoma,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:16px;border:1px solid #e2e8f0;">
        <tr><td style="padding:28px 28px 8px;text-align:right;direction:rtl;">
          <div style="font-size:20px;font-weight:bold;color:#1d4ed8;">${PLATFORM_DISPLAY_NAME}</div>
          <h1 style="margin:16px 0 8px;font-size:18px;color:#0f172a;">کد ورود شما</h1>
          <p style="margin:0;font-size:14px;line-height:26px;color:#475569;">برای ورود یا ثبت‌نام، این کد را در صفحهٔ ورود وارد کنید:</p>
        </td></tr>
        <tr><td align="center" style="padding:16px 28px;">
          <div dir="ltr" style="display:inline-block;padding:14px 28px;border-radius:12px;background:#eff6ff;border:1px solid #bfdbfe;font-size:32px;letter-spacing:10px;font-weight:bold;color:#1e3a8a;font-family:'Courier New',monospace;">${input.code}</div>
        </td></tr>
        <tr><td style="padding:8px 28px 28px;text-align:right;direction:rtl;font-size:13px;line-height:24px;color:#475569;">
          <p style="margin:0 0 8px;">این کد تا <b>${minutes}</b> معتبر است و فقط یک بار قابل استفاده است.</p>
          <p style="margin:0 0 8px;color:#b91c1c;">این کد را به هیچ‌کس، حتی پشتیبانی ${PLATFORM_DISPLAY_NAME}، ندهید.</p>
          <p style="margin:0;color:#64748b;">اگر شما درخواست ورود نداده‌اید، این ایمیل را نادیده بگیرید؛ بدون این کد کسی وارد حساب شما نمی‌شود.</p>
        </td></tr>
      </table>
      <p style="margin:16px 0 0;font-size:11px;color:#94a3b8;direction:rtl;">این ایمیل خودکار است؛ به آن پاسخ ندهید.</p>
    </td></tr>
  </table>
</body>
</html>`;

  return { to: input.to, subject, text, html };
}
