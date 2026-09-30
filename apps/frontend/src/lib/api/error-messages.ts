import { formatToman } from '@/lib/currency';
import { SITE_INFO_FIELD_LABELS } from '@/lib/site-info';

/**
 * Persian texts for the backend's stable error codes. The backend keeps some
 * messages in English (they are also read by API clients and logs); the UI is
 * Persian-only, so known codes are translated here and unknown English
 * messages fall back to a status-based Persian sentence.
 */
const CODE_MESSAGES: Record<string, string | ((details: Record<string, unknown>) => string)> = {
  AMOUNT_BELOW_MINIMUM: (details) => (typeof details.minimumAmount === 'string' ? `حداقل مبلغ تسویه ${formatToman(details.minimumAmount)} است.` : 'مبلغ کمتر از حداقل مجاز است.'),
  AMOUNT_NOT_WHOLE_RIALS: 'مبلغ باید عدد صحیح ریال باشد.',
  BANK_ACCOUNT_MISSING: 'حساب بانکی فروشگاه ثبت نشده است.',
  BRANDING_ASSET_INVALID: 'تصویر باید از طریق همین صفحه و در جایگاه مربوط بارگذاری شده باشد.',
  BRANDING_IMAGE_TOO_SMALL: (details) =>
    typeof details.minWidth === 'number' && typeof details.minHeight === 'number'
      ? `ابعاد تصویر برای این جایگاه کوچک است؛ حداقل ${details.minWidth}×${details.minHeight} پیکسل لازم است.`
      : 'ابعاد تصویر برای این جایگاه کوچک است.',
  BRANDING_INVALID_BANNER: 'اطلاعات بنرها معتبر نیست؛ صفحه را تازه کنید و دوباره تلاش کنید.',
  BRANDING_INVALID_LINK: 'لینک بنر باید مسیر داخلی سایت (مثل /search?categorySlug=fashion) یا نشانی https:// باشد.',
  BRANDING_INVALID_SLOT: 'جایگاه تصویر نامعتبر است.',
  BRANDING_SVG_NOT_ALLOWED: 'SVG فقط برای لوگو و فاوآیکن پذیرفته می‌شود؛ برای بنر PNG، JPEG یا WEBP بارگذاری کنید.',
  BRANDING_SVG_REJECTED: 'این فایل SVG پذیرفته نشد (بیش از ۵۱۲ کیلوبایت، یا دارای entity یا ارجاع به منابع بیرونی).',
  CART_EMPTY: 'سبد خرید خالی است.',
  CART_FULL: 'سبد خرید به حداکثر ظرفیت رسیده است.',
  CONTACT_INVALID_FIELD: 'متن واردشده کوتاه یا نامعتبر است؛ فیلدها را کامل‌تر بنویسید.',
  CONTACT_INVALID_MOBILE: 'شمارهٔ موبایل معتبر نیست.',
  CONTACT_MESSAGE_NOT_FOUND: 'این پیام پیدا نشد.',
  CONTACT_NOTHING_TO_UPDATE: 'تغییری برای ثبت وجود ندارد.',
  CONTACT_REJECTED: 'پیام پذیرفته نشد؛ صفحه را تازه کنید و دوباره تلاش کنید.',
  CONCURRENT_UPDATE: 'اطلاعات هم‌زمان تغییر کرد؛ صفحه را تازه کنید و دوباره تلاش کنید.',
  CREDIT_ORDER_REFUND_UNSUPPORTED: 'بازپرداخت یا لغو مرسوله‌های سفارش اعتباری/ترکیبی به‌صورت خودکار پشتیبانی نمی‌شود؛ باید با بانک اعتباردهنده به‌صورت دستی پیگیری شود.',
  CREDIT_ACCOUNT_EXISTS: 'شما از قبل حساب اعتباری فعال دارید.',
  CREDIT_ACCOUNT_EXPIRED: 'اعتبار شما منقضی شده است.',
  CREDIT_ACCOUNT_NOT_ACTIVE: 'حساب اعتباری شما فعال نیست.',
  CREDIT_ACCOUNT_NOT_FOUND: 'حساب اعتباری ندارید.',
  CREDIT_ACCOUNT_REQUIRED: 'برای خرید اقساطی ابتدا اعتبار دریافت کنید.',
  CREDIT_APPLICATION_IN_PROGRESS: 'درخواست اعتبار قبلی شما هنوز در حال بررسی است.',
  CREDIT_PROVIDER_NOT_ACTIVE: 'این تأمین‌کنندهٔ اعتبار فعال نیست.',
  CREDIT_PROVIDER_UNAVAILABLE: 'سامانهٔ بانک در دسترس نیست؛ کمی بعد دوباره تلاش کنید.',
  CREDIT_RESERVATION_NOT_HELD: 'رزرو اعتبار این سفارش معتبر نیست.',
  DISPUTE_ALREADY_ACTIVE: 'برای این مرسوله اختلاف فعالی وجود دارد.',
  DISPUTE_ALREADY_CLOSED: 'این اختلاف بسته شده است.',
  DISPUTE_ALREADY_DECIDED: 'برای این مرسوله قبلاً رأی صادر شده است.',
  DISPUTE_NOT_AWAITING_VENDOR: 'این اختلاف در انتظار پاسخ فروشنده نیست.',
  DISPUTE_NOT_CANCELLABLE: 'این اختلاف دیگر قابل پس گرفتن نیست.',
  ESCROW_FROZEN_BY_DISPUTE: 'مبلغ این مرسوله به‌دلیل اختلاف مسدود است.',
  ESCROW_NOT_FREEZABLE: 'مبلغ این مرسوله قابل مسدودسازی نیست.',
  ESCROW_NOT_FROZEN: 'مبلغ این مرسوله مسدود نیست.',
  GATEWAY_UNAVAILABLE: 'درگاه پرداخت در دسترس نیست؛ کمی بعد دوباره تلاش کنید.',
  GATEWAY_UNREACHABLE: 'ارتباط با درگاه پرداخت برقرار نشد.',
  HYBRID_NOT_REQUIRED: 'اعتبار شما برای کل مبلغ کافی است؛ «پرداخت اعتباری» را انتخاب کنید.',
  IBAN_MISMATCH: 'شبای مقصد باید همان شبای ثبت‌شده در پروفایل فروشگاه باشد.',
  BULK_BUSY: 'واردکنندهٔ گروهی هم‌اکنون مشغول فروشگاه‌های دیگر است؛ چند دقیقهٔ دیگر دوباره تلاش کنید.',
  BULK_INVALID_URL: (details) => `یکی از لینک‌ها قابل درون‌ریزی نیست${typeof details.message === 'string' ? ` (${details.message})` : ''}.`,
  BULK_JOB_NOT_RUNNING: 'این درون‌ریزی دیگر در حال اجرا نیست.',
  BULK_JOB_RUNNING: 'یک درون‌ریزی گروهی برای این فروشگاه در حال اجراست؛ صبر کنید تمام شود یا آن را متوقف کنید.',
  BULK_NOTHING_TO_RETRY: 'موردی برای تلاش دوباره نمانده است.',
  IMPORT_BLOCKED_TARGET: 'این نشانی به شبکهٔ داخلی یا یک نشانی غیرعمومی اشاره می‌کند و قابل دریافت نیست.',
  IMPORT_INVALID_URL: 'لینک معتبر نیست؛ نشانی کامل صفحهٔ کالا را با http:// یا https:// وارد کنید.',
  IMPORT_NETWORK: 'ارتباط با سایت مبدأ برقرار نشد.',
  IMPORT_NO_PRODUCTS_FOUND: 'در نقشهٔ سایت (sitemap) این فروشگاه صفحهٔ محصولی پیدا نشد. اگر سایت از سرور ما باز نمی‌شود، متن نقشهٔ سایت یا فهرست لینک‌ها را در کادر «چسباندن» وارد کنید.',
  IMPORT_NOT_A_PRODUCT: 'در این صفحه اطلاعات ساخت‌یافتهٔ کالا پیدا نشد؛ لینک صفحهٔ خود کالا را وارد کنید.',
  IMPORT_NOT_FOUND: 'این کالا در سایت مبدأ پیدا نشد یا دیگر فعال نیست.',
  IMPORT_TIMEOUT: 'سایت مبدأ در ۱۰ ثانیه پاسخ نداد؛ کمی بعد دوباره تلاش کنید.',
  IMPORT_TOO_LARGE: 'حجم صفحهٔ مبدأ بیش از حد مجاز است.',
  IMPORT_TOO_MANY_REDIRECTS: 'سایت مبدأ بیش از حد تغییر مسیر داد.',
  IMPORT_UNSUPPORTED_CONTENT: 'این لینک به یک صفحهٔ وب اشاره نمی‌کند.',
  IMPORT_UPSTREAM_STATUS: 'سایت مبدأ درخواست را رد کرد یا با خطا پاسخ داد.',
  INSTALLMENT_NOT_PAYABLE: 'این قسط قابل پرداخت نیست.',
  INSTALLMENT_PLAN_NOT_AVAILABLE: 'این طرح اقساطی در دسترس نیست.',
  INSUFFICIENT_CREDIT: 'اعتبار قابل استفادهٔ شما کافی نیست.',
  INSUFFICIENT_STOCK: 'موجودی کالا کافی نیست.',
  INSUFFICIENT_WALLET_BALANCE: 'موجودی قابل برداشت کافی نیست.',
  INVALID_AMOUNT: 'مبلغ نامعتبر است.',
  INVALID_CART_TOKEN: 'سبد خرید نامعتبر است؛ صفحه را تازه کنید.',
  INVALID_DOCUMENTS: 'مدارک ارسالی نامعتبر است.',
  INVALID_STATUS_TRANSITION: 'این تغییر وضعیت در حالت فعلی مجاز نیست.',
  NATIONAL_CODE_IN_USE: 'این کد ملی برای حساب دیگری ثبت شده است.',
  NATIONAL_CODE_MISMATCH: 'کد ملی با کد ملی پروفایل شما یکسان نیست.',
  ORDER_NOT_PAID: 'این سفارش پرداخت نشده است.',
  ORDER_NOT_PAYABLE: 'این سفارش قابل پرداخت نیست.',
  ORDER_PAYMENT_EXPIRED: 'مهلت پرداخت این سفارش به پایان رسیده است.',
  OUT_OF_STOCK: 'کالا ناموجود است.',
  PAYA_REFERENCE_IN_USE: 'این شمارهٔ پیگیری پایا قبلاً ثبت شده است.',
  PRICE_CHANGED: 'قیمت کالا تغییر کرده است.',
  SETTLEMENT_ALREADY_PROCESSED: 'این درخواست تسویه قبلاً رسیدگی شده است.',
  SITE_INFO_INVALID_FIELD: (details) => (typeof details.field === 'string' ? `مقدار «${SITE_INFO_FIELD_LABELS[details.field] ?? details.field}» معتبر نیست.` : 'یکی از مقادیر معتبر نیست.'),
  SUB_ORDER_NOT_DISPUTABLE: 'برای این مرسوله در وضعیت فعلی نمی‌توان اختلاف ثبت کرد.',
  SUB_ORDER_UNDER_DISPUTE: 'این مرسوله اختلاف فعال دارد و تا پایان رسیدگی قابل تغییر نیست.',
};

const STATUS_MESSAGES: Record<number, string> = {
  400: 'اطلاعات ارسالی معتبر نیست.',
  401: 'نشست شما به پایان رسیده است؛ دوباره وارد شوید.',
  403: 'اجازهٔ انجام این کار را ندارید.',
  404: 'مورد درخواستی پیدا نشد.',
  409: 'این عملیات با وضعیت فعلی سازگار نیست.',
  413: 'حجم فایل بیش از حد مجاز است.',
  415: 'نوع فایل پشتیبانی نمی‌شود.',
  422: 'اطلاعات ارسالی قابل پردازش نیست.',
  429: 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.',
  500: 'خطای داخلی سرور رخ داد.',
  502: 'سرویس بیرونی پاسخ نداد؛ کمی بعد دوباره تلاش کنید.',
  503: 'سرویس موقتاً در دسترس نیست.',
};

const PERSIAN_LETTER = /[\u0600-\u06FF]/;

/** Persian UI message for a failed HTTP response. */
export function localizeErrorMessage(status: number, code: string | undefined, backendMessage: string | undefined, details: unknown): string {
  const mapped = code ? CODE_MESSAGES[code] : undefined;
  if (mapped) {
    return typeof mapped === 'function' ? mapped(typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}) : mapped;
  }
  if (backendMessage && PERSIAN_LETTER.test(backendMessage)) {
    return backendMessage;
  }
  const generic = STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500] : `درخواست با خطای ${status} رد شد.`);
  // Validation details stay visible (they name the offending field) for 400/422.
  return backendMessage && (status === 400 || status === 422) ? `${generic} (${backendMessage})` : (generic ?? `درخواست با خطای ${status} رد شد.`);
}

/** Persian text of a known machine code (e.g. a bulk-import item's `IMPORT_TIMEOUT`), or `undefined`. */
export function messageForCode(code: string, details: Record<string, unknown> = {}): string | undefined {
  const mapped = CODE_MESSAGES[code];
  if (mapped === undefined) return undefined;
  return typeof mapped === 'function' ? mapped(details) : mapped;
}
