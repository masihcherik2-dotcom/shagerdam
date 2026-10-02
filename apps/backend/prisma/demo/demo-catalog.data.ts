/**
 * Demo catalogue content: 2 stores and 18 products in three of the four
 * storefront departments (digital-goods, beauty-products,
 * barber-salon-equipment). There is no demo content for home-decor yet.
 *
 * This is showcase content for a fresh platform, loaded ONLY through
 * `prisma/demo/demo-catalog.ts` (see that file for visibility rules): in
 * production it is created hidden (unpublished products, deactivated owner
 * accounts) so the operator can review it and replace it with real stores.
 *
 * Images are AI-generated, unbranded studio shots stored next to this file
 * (`assets/products/*.jpg`, `assets/logos/*.jpg`) and go through the real media
 * pipeline (WebP re-encode, thumbnail, active storage provider) when loaded.
 * Brands are the stores' own house labels — no third-party trademark is used.
 * Prices are in Toman here and converted to Rials (the API unit) by the loader.
 */

export interface DemoStore {
  key: 'digital' | 'style';
  storeSlug: string;
  storeName: string;
  ownerFullName: string;
  /** Default owner mobile (development); overridable with DEMO_VENDOR_MOBILES. */
  defaultMobile: string;
  instagramHandle: string;
  bio: string;
  /** Checksum-valid Iranian IBANs (ISO 13616) of the demo stores — not real accounts. */
  bankIban: string;
  commissionRateOverride: number | null;
  logo: string;
  brand: string;
}

export interface DemoProduct {
  slug: string;
  store: DemoStore['key'];
  categorySlug: string;
  title: string;
  description: string;
  image: string;
  /** Selling price in Toman. */
  priceToman: number;
  /** Strike-through price in Toman (a real discount), or null. */
  compareAtToman: number | null;
  stock: number;
  weightGrams: number;
  guarantee?: string;
  colors?: { name: string; hex: string }[];
  sizes?: string[];
  specs: [group: string, title: string, value: string][];
}

export const DEMO_STORES: readonly DemoStore[] = [
  {
    key: 'digital',
    storeSlug: 'demo-diginoo',
    storeName: 'دیجی‌نو',
    ownerFullName: 'مدیر فروشگاه دیجی‌نو',
    defaultMobile: '+989120000021',
    instagramHandle: 'diginoo.shop',
    bio: 'فروشگاه تخصصی کالای دیجیتال: گوشی، لپ‌تاپ و لوازم جانبی با گارانتی معتبر و ارسال سریع به سراسر کشور.',
    bankIban: 'IR800170000000100000000021',
    commissionRateOverride: null,
    logo: 'logo-1.jpg',
    brand: 'دیجی‌نو',
  },
  {
    key: 'style',
    storeSlug: 'demo-arta-style',
    storeName: 'آرتا استایل',
    ownerFullName: 'مدیر فروشگاه آرتا استایل',
    defaultMobile: '+989120000022',
    instagramHandle: 'arta.style',
    bio: 'محصولات زیبایی، مراقبت پوست و مو و تجهیزات آرایشگاهی؛ انتخاب‌شده با فرمولاسیون و مواد اولیهٔ مطمئن.',
    bankIban: 'IR710550000000100000000022',
    commissionRateOverride: 12.5,
    logo: 'logo-2.jpg',
    brand: 'آرتا',
  },
];

const BLACK = { name: 'مشکی', hex: '#111827' };
const WHITE = { name: 'سفید', hex: '#FFFFFF' };
const GREY = { name: 'خاکستری', hex: '#6B7280' };
const NAVY = { name: 'سرمه‌ای', hex: '#1E3A8A' };

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  // ─── Digital (دیجی‌نو) ───────────────────────────────────────────────────
  { slug: 'demo-smartphone-n8-256', store: 'digital', categorySlug: 'digital-goods', title: 'گوشی موبایل N8 ظرفیت ۲۵۶ گیگابایت رم ۸ گیگابایت', description: 'نمایشگر AMOLED ۶.۶ اینچی با نرخ نوسازی ۱۲۰ هرتز، دوربین اصلی ۵۰ مگاپیکسل با لرزشگیر اپتیکال و باتری ۵۰۰۰ میلی‌آمپرساعتی با شارژ سریع ۶۷ وات.', image: 'digital-1.jpg', priceToman: 24_900_000, compareAtToman: 27_500_000, stock: 18, weightGrams: 195, guarantee: '۱۸ ماه گارانتی شرکتی', colors: [BLACK], specs: [['نمایشگر', 'اندازه', '۶.۶ اینچ'], ['نمایشگر', 'فناوری', 'AMOLED ۱۲۰ هرتز'], ['حافظه', 'حافظهٔ داخلی', '۲۵۶ گیگابایت'], ['حافظه', 'رم', '۸ گیگابایت'], ['دوربین', 'دوربین اصلی', '۵۰ مگاپیکسل OIS'], ['باتری', 'ظرفیت', '۵۰۰۰ میلی‌آمپرساعت']] },
  { slug: 'demo-smartphone-m5-128', store: 'digital', categorySlug: 'digital-goods', title: 'گوشی موبایل M5 ظرفیت ۱۲۸ گیگابایت رم ۶ گیگابایت', description: 'گوشی اقتصادی با طراحی سبک، نمایشگر ۶.۵ اینچی ۹۰ هرتز، دوربین سه‌گانه و باتری بادوام برای استفادهٔ روزمره.', image: 'digital-2.jpg', priceToman: 11_490_000, compareAtToman: null, stock: 30, weightGrams: 188, guarantee: '۱۸ ماه گارانتی شرکتی', colors: [{ name: 'سبز نعنایی', hex: '#A7F3D0' }, BLACK], specs: [['نمایشگر', 'اندازه', '۶.۵ اینچ'], ['حافظه', 'حافظهٔ داخلی', '۱۲۸ گیگابایت'], ['حافظه', 'رم', '۶ گیگابایت'], ['دوربین', 'دوربین اصلی', '۴۸ مگاپیکسل'], ['باتری', 'ظرفیت', '۵۰۰۰ میلی‌آمپرساعت']] },
  { slug: 'demo-laptop-work15', store: 'digital', categorySlug: 'digital-goods', title: 'لپ‌تاپ ۱۵.۶ اینچی Work15 پردازندهٔ Core i5 رم ۱۶ گیگابایت', description: 'لپ‌تاپ کاری با صفحه‌کلید کامل و بخش اعداد، حافظهٔ SSD پرسرعت ۵۱۲ گیگابایتی و نمایشگر Full HD ضدبازتاب.', image: 'digital-3.jpg', priceToman: 42_800_000, compareAtToman: 46_000_000, stock: 7, weightGrams: 1750, guarantee: '۲۴ ماه گارانتی', colors: [GREY], specs: [['پردازنده', 'مدل', 'Core i5 نسل ۱۳'], ['حافظه', 'رم', '۱۶ گیگابایت DDR4'], ['حافظه', 'ذخیره‌سازی', 'SSD ۵۱۲ گیگابایت'], ['نمایشگر', 'اندازه و دقت', '۱۵.۶ اینچ Full HD'], ['عمومی', 'وزن', '۱.۷۵ کیلوگرم']] },
  { slug: 'demo-laptop-air14', store: 'digital', categorySlug: 'digital-goods', title: 'لپ‌تاپ سبک ۱۴ اینچی Air14 رم ۱۶ گیگابایت SSD یک ترابایت', description: 'بدنهٔ آلومینیومی باریک، وزن ۱.۳ کیلوگرم، باتری تا ۱۲ ساعت و نمایشگر ۲.۲K مناسب کار و سفر.', image: 'digital-4.jpg', priceToman: 58_500_000, compareAtToman: null, stock: 5, weightGrams: 1300, guarantee: '۲۴ ماه گارانتی', colors: [NAVY], specs: [['پردازنده', 'مدل', 'Core Ultra 5'], ['حافظه', 'رم', '۱۶ گیگابایت LPDDR5'], ['حافظه', 'ذخیره‌سازی', 'SSD یک ترابایت'], ['نمایشگر', 'اندازه و دقت', '۱۴ اینچ ۲.۲K'], ['باتری', 'شارژدهی', 'تا ۱۲ ساعت']] },
  { slug: 'demo-earbuds-pod2', store: 'digital', categorySlug: 'digital-goods', title: 'هدفون بی‌سیم توگوشی Pod2 با حذف نویز', description: 'ارتباط بلوتوث ۵.۳، حذف نویز فعال، ۶ ساعت پخش پیوسته و تا ۲۴ ساعت با کیس شارژ.', image: 'digital-5.jpg', priceToman: 1_890_000, compareAtToman: 2_350_000, stock: 60, weightGrams: 48, guarantee: '۱۲ ماه گارانتی', colors: [BLACK], specs: [['اتصال', 'نسخهٔ بلوتوث', '۵.۳'], ['صدا', 'حذف نویز', 'فعال (ANC)'], ['باتری', 'پخش پیوسته', '۶ ساعت'], ['باتری', 'با کیس شارژ', '۲۴ ساعت']] },
  { slug: 'demo-headphone-h700', store: 'digital', categorySlug: 'digital-goods', title: 'هدفون بی‌سیم روگوشی H700', description: 'بالشتک‌های نرم، باتری ۴۰ ساعته، میکروفون داخلی برای مکالمه و قابلیت اتصال سیمی ۳.۵ میلی‌متری.', image: 'digital-6.jpg', priceToman: 2_750_000, compareAtToman: null, stock: 25, weightGrams: 250, guarantee: '۱۲ ماه گارانتی', colors: [GREY], specs: [['اتصال', 'نوع اتصال', 'بلوتوث ۵.۲ و جک ۳.۵'], ['باتری', 'شارژدهی', '۴۰ ساعت'], ['عمومی', 'وزن', '۲۵۰ گرم']] },
  { slug: 'demo-smartwatch-classic', store: 'digital', categorySlug: 'digital-goods', title: 'ساعت هوشمند کلاسیک با بند چرمی', description: 'صفحهٔ گرد AMOLED، پایش ضربان قلب و اکسیژن خون، ردیابی ۱۰۰ حالت ورزشی و مقاومت در برابر آب تا ۵ اتمسفر.', image: 'digital-7.jpg', priceToman: 4_690_000, compareAtToman: 5_200_000, stock: 14, weightGrams: 52, guarantee: '۱۲ ماه گارانتی', colors: [{ name: 'قهوه‌ای', hex: '#92400E' }], specs: [['نمایشگر', 'نوع', 'AMOLED ۱.۴۳ اینچ'], ['سلامت', 'حسگرها', 'ضربان قلب، SpO2'], ['عمومی', 'ضدآب', '5ATM'], ['باتری', 'شارژدهی', 'تا ۱۰ روز']] },
  { slug: 'demo-powerbank-20000', store: 'digital', categorySlug: 'digital-goods', title: 'پاوربانک ۲۰۰۰۰ میلی‌آمپرساعت با شارژ سریع ۲۲.۵ وات', description: 'دو خروجی USB-A و یک درگاه USB-C دوطرفه، نمایشگر درصد شارژ و محافظت در برابر اتصال کوتاه.', image: 'digital-8.jpg', priceToman: 1_290_000, compareAtToman: null, stock: 80, weightGrams: 420, guarantee: '۱۲ ماه گارانتی', colors: [BLACK], specs: [['باتری', 'ظرفیت', '۲۰۰۰۰ میلی‌آمپرساعت'], ['شارژ', 'حداکثر توان', '۲۲.۵ وات'], ['درگاه‌ها', 'خروجی', '۲× USB-A، ۱× USB-C']] },
  { slug: 'demo-speaker-go', store: 'digital', categorySlug: 'digital-goods', title: 'اسپیکر بلوتوثی قابل‌حمل Go ضدآب', description: 'صدای ۱۰ واتی با بیس تقویت‌شده، استاندارد IPX7، بند آویز و ۱۲ ساعت پخش.', image: 'digital-9.jpg', priceToman: 1_550_000, compareAtToman: 1_890_000, stock: 40, weightGrams: 380, guarantee: '۱۲ ماه گارانتی', colors: [{ name: 'نارنجی', hex: '#EA580C' }], specs: [['صدا', 'توان خروجی', '۱۰ وات'], ['عمومی', 'ضدآب', 'IPX7'], ['باتری', 'پخش پیوسته', '۱۲ ساعت']] },
  { slug: 'demo-laptop-backpack', store: 'digital', categorySlug: 'digital-goods', title: 'کوله‌پشتی لپ‌تاپ ضدآب ۱۵.۶ اینچ', description: 'جای لپ‌تاپ ضربه‌گیر، درگاه شارژ USB بیرونی و پارچهٔ ضدآب.', image: 'fashion-9.jpg', priceToman: 1_150_000, compareAtToman: 1_390_000, stock: 26, weightGrams: 750, colors: [BLACK], specs: [['جنس', 'پارچه', 'پلی‌استر ضدآب'], ['ظرفیت', 'حجم', '۲۵ لیتر'], ['ظرفیت', 'جای لپ‌تاپ', 'تا ۱۵.۶ اینچ']] },

  // ─── Beauty & Salon (آرتا استایل) ──────────────────────────────────────
  { slug: 'demo-moisturizer-cream', store: 'style', categorySlug: 'beauty-products', title: 'کرم آبرسان صورت مناسب پوست خشک ۵۰ میلی‌لیتر', description: 'حاوی هیالورونیک اسید و سرامید، جذب سریع و بدون چربی باقی‌مانده.', image: 'beauty-health-1.jpg', priceToman: 320_000, compareAtToman: 380_000, stock: 50, weightGrams: 90, specs: [['مشخصات', 'حجم', '۵۰ میلی‌لیتر'], ['مشخصات', 'نوع پوست', 'خشک و معمولی'], ['ترکیبات', 'مواد مؤثر', 'هیالورونیک اسید، سرامید']] },
  { slug: 'demo-sunscreen-spf50', store: 'style', categorySlug: 'beauty-products', title: 'کرم ضدآفتاب بی‌رنگ SPF50', description: 'محافظت گستردهٔ UVA/UVB، بافت سبک و مناسب پوست‌های حساس.', image: 'beauty-health-2.jpg', priceToman: 285_000, compareAtToman: null, stock: 60, weightGrams: 70, specs: [['مشخصات', 'حجم', '۵۰ میلی‌لیتر'], ['مشخصات', 'SPF', '۵۰'], ['مشخصات', 'رنگ', 'بی‌رنگ']] },
  { slug: 'demo-facial-cleanser-gel', store: 'style', categorySlug: 'beauty-products', title: 'ژل شست‌وشوی صورت ۲۰۰ میلی‌لیتر', description: 'پاک‌کنندهٔ ملایم بدون سولفات با عصارهٔ چای سبز.', image: 'beauty-health-3.jpg', priceToman: 210_000, compareAtToman: 250_000, stock: 55, weightGrams: 230, specs: [['مشخصات', 'حجم', '۲۰۰ میلی‌لیتر'], ['ترکیبات', 'ویژگی', 'بدون سولفات']] },
  { slug: 'demo-vitamin-c-serum', store: 'style', categorySlug: 'beauty-products', title: 'سرم ویتامین C روشن‌کننده ۳۰ میلی‌لیتر', description: 'ویتامین C پایدار ۱۰٪ برای یکنواختی رنگ پوست، در بطری تیره با قطره‌چکان.', image: 'beauty-health-4.jpg', priceToman: 450_000, compareAtToman: null, stock: 34, weightGrams: 80, specs: [['مشخصات', 'حجم', '۳۰ میلی‌لیتر'], ['ترکیبات', 'غلظت ویتامین C', '۱۰٪']] },
  { slug: 'demo-electric-toothbrush', store: 'style', categorySlug: 'beauty-products', title: 'مسواک برقی سونیک شارژی', description: '۴۰ هزار ضربه در دقیقه، ۳ حالت تمیزکنندگی، تایمر ۲ دقیقه‌ای و ۳۰ روز شارژدهی.', image: 'beauty-health-5.jpg', priceToman: 1_150_000, compareAtToman: 1_350_000, stock: 24, weightGrams: 150, guarantee: '۱۲ ماه گارانتی', colors: [WHITE], specs: [['مشخصات', 'نوع', 'سونیک'], ['باتری', 'شارژدهی', '۳۰ روز'], ['مشخصات', 'حالت‌ها', '۳ حالت']] },
  { slug: 'demo-hair-dryer-2000', store: 'style', categorySlug: 'barber-salon-equipment', title: 'سشوار ۲۰۰۰ وات یونیزه', description: 'فناوری یون منفی برای کاهش وز، ۳ دما و ۲ سرعت به‌همراه دکمهٔ باد سرد.', image: 'beauty-health-6.jpg', priceToman: 1_390_000, compareAtToman: null, stock: 19, weightGrams: 550, guarantee: '۱۲ ماه گارانتی', colors: [{ name: 'صورتی', hex: '#F9A8D4' }], specs: [['مشخصات', 'توان', '۲۰۰۰ وات'], ['مشخصات', 'دما', '۳ سطح'], ['مشخصات', 'یونیزه', 'دارد']] },
  { slug: 'demo-beard-trimmer', store: 'style', categorySlug: 'barber-salon-equipment', title: 'ماشین اصلاح ریش و موی شارژی', description: 'تیغهٔ تیتانیومی، ۲۰ تنظیم طول و ۹۰ دقیقه کارکرد با هر بار شارژ.', image: 'beauty-health-7.jpg', priceToman: 980_000, compareAtToman: 1_150_000, stock: 27, weightGrams: 180, guarantee: '۱۲ ماه گارانتی', colors: [BLACK], specs: [['مشخصات', 'تیغه', 'تیتانیوم'], ['مشخصات', 'تنظیم طول', '۲۰ حالت'], ['باتری', 'زمان کارکرد', '۹۰ دقیقه']] },
  { slug: 'demo-shampoo-daily', store: 'style', categorySlug: 'beauty-products', title: 'شامپو روزانهٔ مناسب موی معمولی ۴۰۰ میلی‌لیتر', description: 'فرمول ملایم با پروتئین گندم برای استفادهٔ روزانه.', image: 'beauty-health-8.jpg', priceToman: 165_000, compareAtToman: null, stock: 70, weightGrams: 440, specs: [['مشخصات', 'حجم', '۴۰۰ میلی‌لیتر'], ['مشخصات', 'نوع مو', 'معمولی']] },
];
