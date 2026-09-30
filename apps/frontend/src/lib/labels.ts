import type {
  ContactMessageStatus,
  ContactMessageTopic,
  ComponentState,
  PublicStatusModule,
  CreditAccountStatus,
  CreditApplicationStatus,
  DisputeEventType,
  DisputeReason,
  DisputeStatus,
  InstallmentStatus,
  ParentOrderPaymentStatus,
  PaymentMethod,
  PaymentOutcome,
  ProductSort,
  SettlementStatus,
  SubOrderStatus,
  UserRole,
  VendorStatus,
  WalletBalanceBucket,
  WalletTransactionType,
} from './api/types';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'brand';

export const ROLE_LABELS: Record<UserRole, string> = {
  SUPER_ADMIN: 'مدیر ارشد',
  ADMIN: 'مدیر',
  VENDOR: 'فروشنده',
  CUSTOMER: 'مشتری',
  FINANCIAL_OFFICER: 'کارشناس مالی',
  SUPPORT: 'پشتیبانی',
};

export const SUB_ORDER_STATUS: Record<SubOrderStatus, { label: string; tone: Tone }> = {
  PENDING_APPROVAL: { label: 'در انتظار تأیید فروشنده', tone: 'warning' },
  PROCESSING: { label: 'در حال آماده‌سازی', tone: 'info' },
  SHIPPED: { label: 'ارسال شده', tone: 'brand' },
  DELIVERED: { label: 'تحویل شده', tone: 'success' },
  CANCELLED: { label: 'لغو شده', tone: 'neutral' },
  REFUNDED: { label: 'مرجوع/بازپرداخت شده', tone: 'danger' },
};

export const PAYMENT_STATUS: Record<ParentOrderPaymentStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'در انتظار پرداخت', tone: 'warning' },
  PAID: { label: 'پرداخت شده', tone: 'success' },
  FAILED: { label: 'پرداخت ناموفق', tone: 'danger' },
  CANCELLED: { label: 'لغو شده', tone: 'neutral' },
};

export const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  CASH_IPG: 'پرداخت آنلاین (درگاه بانکی)',
  BANK_CREDIT: 'اعتبار بانکی (اقساطی)',
  HYBRID: 'ترکیبی (اعتبار + درگاه)',
};

export const PAYMENT_OUTCOME: Record<PaymentOutcome, { label: string; tone: Tone; description: string }> = {
  PAID: { label: 'پرداخت موفق', tone: 'success', description: 'سفارش شما ثبت و پرداخت شد و برای فروشندگان ارسال شد.' },
  FAILED: { label: 'پرداخت ناموفق', tone: 'danger', description: 'پرداخت انجام نشد. اگر مبلغی از حساب شما کسر شده باشد، طبق مقررات شاپرک حداکثر ظرف ۷۲ ساعت برمی‌گردد.' },
  VERIFICATION_PENDING: { label: 'در انتظار تأیید بانک', tone: 'warning', description: 'نتیجهٔ پرداخت هنوز از بانک دریافت نشده است. وضعیت سفارش را چند دقیقهٔ دیگر بررسی کنید.' },
  PAID_REQUIRES_REFUND: { label: 'پرداخت دیرهنگام', tone: 'warning', description: 'پرداخت پس از پایان مهلت سفارش انجام شد؛ مبلغ توسط واحد مالی به حساب شما بازگردانده می‌شود.' },
};

export const VENDOR_STATUS: Record<VendorStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'در انتظار بررسی', tone: 'warning' },
  APPROVED: { label: 'تأیید شده', tone: 'success' },
  REJECTED: { label: 'رد شده', tone: 'danger' },
  SUSPENDED: { label: 'معلق', tone: 'neutral' },
};

export const SETTLEMENT_STATUS: Record<SettlementStatus, { label: string; tone: Tone }> = {
  REQUESTED: { label: 'ثبت شده', tone: 'warning' },
  PROCESSING: { label: 'در حال پردازش', tone: 'info' },
  PAID_PAYA: { label: 'واریز شده (پایا)', tone: 'success' },
  REJECTED: { label: 'رد شده', tone: 'danger' },
};

export const WALLET_BUCKET_LABELS: Record<WalletBalanceBucket, string> = {
  PENDING: 'در انتظار (امانی)',
  WITHDRAWABLE: 'قابل برداشت',
  SETTLEMENT_HOLD: 'در انتظار تسویه',
  DISPUTE_HOLD: 'مسدود بابت اختلاف',
};

export const WALLET_TX_LABELS: Record<WalletTransactionType, string> = {
  CREDIT_SALE_ESCROW_HOLD: 'فروش (نگهداری امانی)',
  ESCROW_RELEASE_TO_WITHDRAWABLE: 'آزادسازی پس از تحویل',
  COMMISSION_DEDUCTION: 'کسر کارمزد',
  SETTLEMENT_PAYOUT: 'واریز تسویه',
  REFUND_DEDUCTION: 'کسر بابت مرجوعی',
  SETTLEMENT_HOLD: 'انتقال به درخواست تسویه',
  SETTLEMENT_HOLD_RELEASE: 'بازگشت از تسویهٔ ردشده',
  DISPUTE_HOLD_LOCK: 'مسدودی بابت اختلاف',
  DISPUTE_HOLD_RELEASE: 'رفع مسدودی اختلاف',
};

export const CREDIT_ACCOUNT_STATUS: Record<CreditAccountStatus, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'فعال', tone: 'success' },
  FROZEN: { label: 'مسدود', tone: 'danger' },
  CLOSED: { label: 'بسته شده', tone: 'neutral' },
};

/** Provider decision codes (CreditApplication.decisionReason) → Persian. Unknown codes fall back to a generic text. */
export const CREDIT_DECISION_REASON: Record<string, string> = {
  SCORE_BELOW_THRESHOLD: 'امتیاز اعتباری شما کمتر از حد لازم بانک است.',
  NOT_ELIGIBLE: 'در حال حاضر واجد شرایط دریافت اعتبار نیستید.',
  BELOW_MINIMUM_LIMIT: 'مبلغ درخواستی کمتر از حداقل مبلغ قابل ارائهٔ بانک است.',
  CAPPED_AT_MAXIMUM: 'اعتبار تا سقف مجاز بانک تأیید شد.',
};

export function creditDecisionReason(code: string): string {
  return CREDIT_DECISION_REASON[code] ?? 'بانک دلیل دیگری برای این تصمیم اعلام کرده است.';
}

export const CREDIT_APPLICATION_STATUS: Record<CreditApplicationStatus, { label: string; tone: Tone }> = {
  DRAFT: { label: 'پیش‌نویس', tone: 'neutral' },
  PENDING_BANK_INQUIRY: { label: 'در انتظار استعلام بانک', tone: 'warning' },
  DOCS_REQUIRED: { label: 'نیاز به مدارک تکمیلی', tone: 'warning' },
  APPROVED: { label: 'تأیید شده', tone: 'success' },
  REJECTED: { label: 'رد شده', tone: 'danger' },
};

export const INSTALLMENT_STATUS: Record<InstallmentStatus, { label: string; tone: Tone }> = {
  PENDING: { label: 'سررسید نشده', tone: 'neutral' },
  PAID: { label: 'پرداخت شده', tone: 'success' },
  OVERDUE: { label: 'معوق', tone: 'danger' },
  WAIVED: { label: 'بخشوده', tone: 'info' },
};

export const DISPUTE_REASON_LABELS: Record<DisputeReason, string> = {
  WRONG_ITEM: 'کالای اشتباه ارسال شده',
  DAMAGED: 'کالا آسیب دیده است',
  NOT_AS_DESCRIBED: 'مغایرت با توضیحات',
  NOT_DELIVERED: 'کالا به دستم نرسیده',
  COUNTERFEIT: 'کالا تقلبی است',
};

export const DISPUTE_STATUS: Record<DisputeStatus, { label: string; tone: Tone }> = {
  OPEN: { label: 'باز — در انتظار پاسخ فروشنده', tone: 'warning' },
  VENDOR_RESPONDED: { label: 'پاسخ فروشنده ثبت شد', tone: 'info' },
  UNDER_ARBITRATION: { label: 'در حال داوری', tone: 'brand' },
  RESOLVED_BUYER_FAVOR: { label: 'رأی به نفع خریدار', tone: 'success' },
  RESOLVED_VENDOR_FAVOR: { label: 'رأی به نفع فروشنده', tone: 'danger' },
  CANCELLED: { label: 'لغو شده توسط خریدار', tone: 'neutral' },
};

export const DISPUTE_EVENT_LABELS: Record<DisputeEventType, string> = {
  OPENED: 'ثبت اختلاف',
  EVIDENCE_ADDED: 'افزودن مدرک',
  VENDOR_ACCEPTED_RETURN: 'پذیرش مرجوعی توسط فروشنده',
  VENDOR_DEFENDED: 'دفاعیهٔ فروشنده',
  ARBITRATED_BUYER_FAVOR: 'رأی داور به نفع خریدار',
  ARBITRATED_VENDOR_FAVOR: 'رأی داور به نفع فروشنده',
  CANCELLED_BY_CUSTOMER: 'لغو توسط خریدار',
  REFUND_NOTICE_SENT: 'اطلاع‌رسانی بازپرداخت',
  REFUND_NOTICE_FAILED: 'خطا در اطلاع‌رسانی بازپرداخت',
};

export const SORT_LABELS: Record<ProductSort, string> = {
  newest: 'جدیدترین',
  price_asc: 'ارزان‌ترین',
  price_desc: 'گران‌ترین',
  popular: 'پرفروش‌ترین',
};

export const TIMELINE_EVENT_LABELS: Record<string, string> = {
  ORDER_PLACED: 'ثبت سفارش',
  PAYMENT_CONFIRMED: 'تأیید پرداخت',
  ORDER_CANCELLED: 'لغو سفارش',
  PAYMENT_FAILED: 'پرداخت ناموفق',
  SUB_ORDER_STATUS: 'تغییر وضعیت مرسوله',
};

/** Forward progress of a package, for the order timeline stepper. */
export const PACKAGE_STEPS: readonly SubOrderStatus[] = ['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED', 'DELIVERED'];

export const CONTACT_TOPIC_LABELS: Record<ContactMessageTopic, string> = {
  ORDER: 'پیگیری سفارش',
  PAYMENT: 'پرداخت و بازگشت وجه',
  BNPL: 'خرید اقساطی و اعتبار',
  RETURN: 'مرجوعی و ضمانت',
  VENDOR: 'همکاری و فروشندگی',
  TECHNICAL: 'مشکل فنی سایت',
  OTHER: 'سایر موارد',
};

export const CONTACT_STATUS: Record<ContactMessageStatus, { label: string; tone: Tone }> = {
  NEW: { label: 'جدید', tone: 'warning' },
  IN_PROGRESS: { label: 'در حال پیگیری', tone: 'info' },
  RESOLVED: { label: 'پاسخ داده شد', tone: 'success' },
};

/** Business capabilities on the public status page (no internal component names). */
export const STATUS_MODULE_LABELS: Record<PublicStatusModule, { title: string; description: string }> = {
  storefront: { title: 'فروشگاه و کاتالوگ', description: 'مرور دسته‌ها، جست‌وجو و صفحهٔ محصولات' },
  orders: { title: 'ثبت و پیگیری سفارش', description: 'سبد خرید، ثبت سفارش و وضعیت مرسوله‌ها' },
  payments: { title: 'پرداخت آنلاین', description: 'اتصال به درگاه بانکی و ثبت نتیجهٔ پرداخت' },
  bnpl: { title: 'خرید اقساطی', description: 'اعتبار، طرح‌های اقساطی و پرداخت اقساط' },
  auth: { title: 'ورود و حساب کاربری', description: 'ارسال کد ورود و نشست کاربران' },
};

export const COMPONENT_STATE: Record<ComponentState, { label: string; tone: Tone }> = {
  operational: { label: 'فعال', tone: 'success' },
  degraded: { label: 'کندی یا اختلال جزئی', tone: 'warning' },
  outage: { label: 'قطع', tone: 'danger' },
};
