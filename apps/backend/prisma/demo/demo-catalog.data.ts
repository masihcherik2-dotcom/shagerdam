/**
 * Demo catalogue content: 4 stores and 54 products across the six storefront
 * departments (digital, fashion, home-kitchen, beauty-health, sport-travel,
 * tools-auto).
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
  key: 'digital' | 'style' | 'home' | 'gear';
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
    bio: 'پوشاک، کیف و کفش و محصولات مراقبت پوست؛ انتخاب‌شده با کیفیت دوخت و مواد اولیهٔ مطمئن.',
    bankIban: 'IR710550000000100000000022',
    commissionRateOverride: 12.5,
    logo: 'logo-2.jpg',
    brand: 'آرتا',
  },
  {
    key: 'home',
    storeSlug: 'demo-sepid-home',
    storeName: 'خانهٔ سپید',
    ownerFullName: 'مدیر فروشگاه خانهٔ سپید',
    defaultMobile: '+989120000023',
    instagramHandle: 'sepid.home',
    bio: 'لوازم خانگی کوچک و ظروف آشپزخانه برای خانه‌ای مرتب و آشپزی راحت‌تر.',
    bankIban: 'IR900120000000100000000023',
    commissionRateOverride: null,
    logo: 'logo-3.jpg',
    brand: 'سپید',
  },
  {
    key: 'gear',
    storeSlug: 'demo-kuhsar-gear',
    storeName: 'کوهسار گیر',
    ownerFullName: 'مدیر فروشگاه کوهسار گیر',
    defaultMobile: '+989120000024',
    instagramHandle: 'kuhsar.gear',
    bio: 'تجهیزات ورزشی، کوهنوردی و سفر در کنار ابزار و لوازم جانبی خودرو.',
    bankIban: 'IR430560000000100000000024',
    commissionRateOverride: 8,
    logo: 'logo-4.jpg',
    brand: 'کوهسار',
  },
];

const BLACK = { name: 'مشکی', hex: '#111827' };
const WHITE = { name: 'سفید', hex: '#FFFFFF' };
const GREY = { name: 'خاکستری', hex: '#6B7280' };
const NAVY = { name: 'سرمه‌ای', hex: '#1E3A8A' };

export const DEMO_PRODUCTS: readonly DemoProduct[] = [
  // ─── Digital (دیجی‌نو) ───────────────────────────────────────────────────
  { slug: 'demo-smartphone-n8-256', store: 'digital', categorySlug: 'mobile', title: 'گوشی موبایل N8 ظرفیت ۲۵۶ گیگابایت رم ۸ گیگابایت', description: 'نمایشگر AMOLED ۶.۶ اینچی با نرخ نوسازی ۱۲۰ هرتز، دوربین اصلی ۵۰ مگاپیکسل با لرزشگیر اپتیکال و باتری ۵۰۰۰ میلی‌آمپرساعتی با شارژ سریع ۶۷ وات.', image: 'digital-1.jpg', priceToman: 24_900_000, compareAtToman: 27_500_000, stock: 18, weightGrams: 195, guarantee: '۱۸ ماه گارانتی شرکتی', colors: [BLACK], specs: [['نمایشگر', 'اندازه', '۶.۶ اینچ'], ['نمایشگر', 'فناوری', 'AMOLED ۱۲۰ هرتز'], ['حافظه', 'حافظهٔ داخلی', '۲۵۶ گیگابایت'], ['حافظه', 'رم', '۸ گیگابایت'], ['دوربین', 'دوربین اصلی', '۵۰ مگاپیکسل OIS'], ['باتری', 'ظرفیت', '۵۰۰۰ میلی‌آمپرساعت']] },
  { slug: 'demo-smartphone-m5-128', store: 'digital', categorySlug: 'mobile', title: 'گوشی موبایل M5 ظرفیت ۱۲۸ گیگابایت رم ۶ گیگابایت', description: 'گوشی اقتصادی با طراحی سبک، نمایشگر ۶.۵ اینچی ۹۰ هرتز، دوربین سه‌گانه و باتری بادوام برای استفادهٔ روزمره.', image: 'digital-2.jpg', priceToman: 11_490_000, compareAtToman: null, stock: 30, weightGrams: 188, guarantee: '۱۸ ماه گارانتی شرکتی', colors: [{ name: 'سبز نعنایی', hex: '#A7F3D0' }, BLACK], specs: [['نمایشگر', 'اندازه', '۶.۵ اینچ'], ['حافظه', 'حافظهٔ داخلی', '۱۲۸ گیگابایت'], ['حافظه', 'رم', '۶ گیگابایت'], ['دوربین', 'دوربین اصلی', '۴۸ مگاپیکسل'], ['باتری', 'ظرفیت', '۵۰۰۰ میلی‌آمپرساعت']] },
  { slug: 'demo-laptop-work15', store: 'digital', categorySlug: 'laptop', title: 'لپ‌تاپ ۱۵.۶ اینچی Work15 پردازندهٔ Core i5 رم ۱۶ گیگابایت', description: 'لپ‌تاپ کاری با صفحه‌کلید کامل و بخش اعداد، حافظهٔ SSD پرسرعت ۵۱۲ گیگابایتی و نمایشگر Full HD ضدبازتاب.', image: 'digital-3.jpg', priceToman: 42_800_000, compareAtToman: 46_000_000, stock: 7, weightGrams: 1750, guarantee: '۲۴ ماه گارانتی', colors: [GREY], specs: [['پردازنده', 'مدل', 'Core i5 نسل ۱۳'], ['حافظه', 'رم', '۱۶ گیگابایت DDR4'], ['حافظه', 'ذخیره‌سازی', 'SSD ۵۱۲ گیگابایت'], ['نمایشگر', 'اندازه و دقت', '۱۵.۶ اینچ Full HD'], ['عمومی', 'وزن', '۱.۷۵ کیلوگرم']] },
  { slug: 'demo-laptop-air14', store: 'digital', categorySlug: 'laptop', title: 'لپ‌تاپ سبک ۱۴ اینچی Air14 رم ۱۶ گیگابایت SSD یک ترابایت', description: 'بدنهٔ آلومینیومی باریک، وزن ۱.۳ کیلوگرم، باتری تا ۱۲ ساعت و نمایشگر ۲.۲K مناسب کار و سفر.', image: 'digital-4.jpg', priceToman: 58_500_000, compareAtToman: null, stock: 5, weightGrams: 1300, guarantee: '۲۴ ماه گارانتی', colors: [NAVY], specs: [['پردازنده', 'مدل', 'Core Ultra 5'], ['حافظه', 'رم', '۱۶ گیگابایت LPDDR5'], ['حافظه', 'ذخیره‌سازی', 'SSD یک ترابایت'], ['نمایشگر', 'اندازه و دقت', '۱۴ اینچ ۲.۲K'], ['باتری', 'شارژدهی', 'تا ۱۲ ساعت']] },
  { slug: 'demo-earbuds-pod2', store: 'digital', categorySlug: 'digital-accessories', title: 'هدفون بی‌سیم توگوشی Pod2 با حذف نویز', description: 'ارتباط بلوتوث ۵.۳، حذف نویز فعال، ۶ ساعت پخش پیوسته و تا ۲۴ ساعت با کیس شارژ.', image: 'digital-5.jpg', priceToman: 1_890_000, compareAtToman: 2_350_000, stock: 60, weightGrams: 48, guarantee: '۱۲ ماه گارانتی', colors: [BLACK], specs: [['اتصال', 'نسخهٔ بلوتوث', '۵.۳'], ['صدا', 'حذف نویز', 'فعال (ANC)'], ['باتری', 'پخش پیوسته', '۶ ساعت'], ['باتری', 'با کیس شارژ', '۲۴ ساعت']] },
  { slug: 'demo-headphone-h700', store: 'digital', categorySlug: 'digital-accessories', title: 'هدفون بی‌سیم روگوشی H700', description: 'بالشتک‌های نرم، باتری ۴۰ ساعته، میکروفون داخلی برای مکالمه و قابلیت اتصال سیمی ۳.۵ میلی‌متری.', image: 'digital-6.jpg', priceToman: 2_750_000, compareAtToman: null, stock: 25, weightGrams: 250, guarantee: '۱۲ ماه گارانتی', colors: [GREY], specs: [['اتصال', 'نوع اتصال', 'بلوتوث ۵.۲ و جک ۳.۵'], ['باتری', 'شارژدهی', '۴۰ ساعت'], ['عمومی', 'وزن', '۲۵۰ گرم']] },
  { slug: 'demo-smartwatch-classic', store: 'digital', categorySlug: 'digital-accessories', title: 'ساعت هوشمند کلاسیک با بند چرمی', description: 'صفحهٔ گرد AMOLED، پایش ضربان قلب و اکسیژن خون، ردیابی ۱۰۰ حالت ورزشی و مقاومت در برابر آب تا ۵ اتمسفر.', image: 'digital-7.jpg', priceToman: 4_690_000, compareAtToman: 5_200_000, stock: 14, weightGrams: 52, guarantee: '۱۲ ماه گارانتی', colors: [{ name: 'قهوه‌ای', hex: '#92400E' }], specs: [['نمایشگر', 'نوع', 'AMOLED ۱.۴۳ اینچ'], ['سلامت', 'حسگرها', 'ضربان قلب، SpO2'], ['عمومی', 'ضدآب', '5ATM'], ['باتری', 'شارژدهی', 'تا ۱۰ روز']] },
  { slug: 'demo-powerbank-20000', store: 'digital', categorySlug: 'digital-accessories', title: 'پاوربانک ۲۰۰۰۰ میلی‌آمپرساعت با شارژ سریع ۲۲.۵ وات', description: 'دو خروجی USB-A و یک درگاه USB-C دوطرفه، نمایشگر درصد شارژ و محافظت در برابر اتصال کوتاه.', image: 'digital-8.jpg', priceToman: 1_290_000, compareAtToman: null, stock: 80, weightGrams: 420, guarantee: '۱۲ ماه گارانتی', colors: [BLACK], specs: [['باتری', 'ظرفیت', '۲۰۰۰۰ میلی‌آمپرساعت'], ['شارژ', 'حداکثر توان', '۲۲.۵ وات'], ['درگاه‌ها', 'خروجی', '۲× USB-A، ۱× USB-C']] },
  { slug: 'demo-speaker-go', store: 'digital', categorySlug: 'digital-accessories', title: 'اسپیکر بلوتوثی قابل‌حمل Go ضدآب', description: 'صدای ۱۰ واتی با بیس تقویت‌شده، استاندارد IPX7، بند آویز و ۱۲ ساعت پخش.', image: 'digital-9.jpg', priceToman: 1_550_000, compareAtToman: 1_890_000, stock: 40, weightGrams: 380, guarantee: '۱۲ ماه گارانتی', colors: [{ name: 'نارنجی', hex: '#EA580C' }], specs: [['صدا', 'توان خروجی', '۱۰ وات'], ['عمومی', 'ضدآب', 'IPX7'], ['باتری', 'پخش پیوسته', '۱۲ ساعت']] },

  // ─── Fashion (آرتا استایل) ──────────────────────────────────────────────
  { slug: 'demo-mens-tshirt-cotton', store: 'style', categorySlug: 'mens-clothing', title: 'تی‌شرت مردانهٔ نخی یقه‌گرد', description: 'پارچهٔ ۱۰۰٪ پنبه با بافت سینگل‌جرسی، دوخت دوسوزن و آب‌رفت کنترل‌شده.', image: 'fashion-1.jpg', priceToman: 389_000, compareAtToman: 450_000, stock: 20, weightGrams: 180, colors: [NAVY], sizes: ['M', 'L', 'XL'], specs: [['جنس', 'پارچه', 'پنبه ۱۰۰٪'], ['طرح', 'یقه', 'گرد'], ['نگهداری', 'شست‌وشو', 'ماشین، حداکثر ۳۰ درجه']] },
  { slug: 'demo-mens-jeans-slim', store: 'style', categorySlug: 'mens-clothing', title: 'شلوار جین مردانهٔ اسلیم‌فیت', description: 'دنیم کش‌دار با راحتی بالا، پنج جیب و رنگ‌ثابت.', image: 'fashion-2.jpg', priceToman: 1_190_000, compareAtToman: null, stock: 15, weightGrams: 650, colors: [{ name: 'آبی', hex: '#1D4ED8' }], sizes: ['30', '32', '34'], specs: [['جنس', 'پارچه', 'دنیم ۹۸٪ پنبه، ۲٪ الاستین'], ['طرح', 'فرم', 'اسلیم‌فیت']] },
  { slug: 'demo-mens-hoodie', store: 'style', categorySlug: 'mens-clothing', title: 'هودی مردانهٔ دورس کلاه‌دار', description: 'دورس پنبه‌ای با داخل کرکی، جیب کانگورویی و کلاه بنددار.', image: 'fashion-3.jpg', priceToman: 890_000, compareAtToman: 1_050_000, stock: 18, weightGrams: 520, colors: [GREY], sizes: ['L', 'XL'], specs: [['جنس', 'پارچه', 'دورس پنبه ۸۰٪'], ['طرح', 'جیب', 'کانگورویی']] },
  { slug: 'demo-womens-manteau-belted', store: 'style', categorySlug: 'womens-clothing', title: 'مانتو بلند زنانهٔ کمربنددار', description: 'مانتو بلند با پارچهٔ کرپ مازراتی، یقهٔ انگلیسی و کمربند هم‌رنگ.', image: 'fashion-4.jpg', priceToman: 1_650_000, compareAtToman: null, stock: 12, weightGrams: 600, colors: [{ name: 'کرم', hex: '#E7D3B1' }], sizes: ['38', '40', '42'], specs: [['جنس', 'پارچه', 'کرپ مازراتی'], ['طرح', 'قد', 'بلند'], ['طرح', 'یقه', 'انگلیسی']] },
  { slug: 'demo-womens-scarf-floral', store: 'style', categorySlug: 'womens-clothing', title: 'روسری ابریشم‌نما طرح گل', description: 'روسری نرم و سبک با چاپ دیجیتال و دور دوخت دستی؛ ابعاد ۱۴۰ در ۱۴۰ سانتی‌متر.', image: 'fashion-5.jpg', priceToman: 420_000, compareAtToman: 520_000, stock: 35, weightGrams: 90, specs: [['جنس', 'پارچه', 'ابریشم‌نما (ساتن)'], ['ابعاد', 'اندازه', '۱۴۰×۱۴۰ سانتی‌متر']] },
  { slug: 'demo-womens-knit-sweater', store: 'style', categorySlug: 'womens-clothing', title: 'بافت زنانهٔ طرح گیس', description: 'پلیور بافت گرم با طرح گیس کلاسیک، مناسب پاییز و زمستان.', image: 'fashion-6.jpg', priceToman: 980_000, compareAtToman: null, stock: 16, weightGrams: 450, colors: [{ name: 'شیری', hex: '#F5F0E1' }], sizes: ['S', 'M', 'L'], specs: [['جنس', 'نخ', 'اکریلیک و پشم'], ['طرح', 'بافت', 'گیس']] },
  { slug: 'demo-leather-handbag', store: 'style', categorySlug: 'bags-shoes', title: 'کیف دستی زنانهٔ چرم طبیعی', description: 'کیف چرم گاوی با دو دستهٔ محکم، زیپ اصلی و جیب‌های داخلی مجزا.', image: 'fashion-7.jpg', priceToman: 3_200_000, compareAtToman: 3_750_000, stock: 8, weightGrams: 900, colors: [{ name: 'قهوه‌ای', hex: '#92400E' }], specs: [['جنس', 'رویه', 'چرم طبیعی گاوی'], ['ابعاد', 'اندازه', '۳۲×۲۴×۱۲ سانتی‌متر']] },
  { slug: 'demo-white-sneakers', store: 'style', categorySlug: 'bags-shoes', title: 'کفش اسنیکر سفید چرمی', description: 'رویهٔ چرم مصنوعی باکیفیت، زیرهٔ لاستیکی دوخت‌دار و کفی طبی.', image: 'fashion-8.jpg', priceToman: 1_450_000, compareAtToman: null, stock: 22, weightGrams: 800, colors: [WHITE], sizes: ['40', '41', '42', '43'], specs: [['جنس', 'رویه', 'چرم مصنوعی'], ['جنس', 'زیره', 'لاستیک']] },
  { slug: 'demo-laptop-backpack', store: 'style', categorySlug: 'bags-shoes', title: 'کوله‌پشتی لپ‌تاپ ضدآب ۱۵.۶ اینچ', description: 'جای لپ‌تاپ ضربه‌گیر، درگاه شارژ USB بیرونی و پارچهٔ ضدآب.', image: 'fashion-9.jpg', priceToman: 1_150_000, compareAtToman: 1_390_000, stock: 26, weightGrams: 750, colors: [BLACK], specs: [['جنس', 'پارچه', 'پلی‌استر ضدآب'], ['ظرفیت', 'حجم', '۲۵ لیتر'], ['ظرفیت', 'جای لپ‌تاپ', 'تا ۱۵.۶ اینچ']] },

  // ─── Home & Kitchen (خانهٔ سپید) ────────────────────────────────────────
  { slug: 'demo-electric-kettle-steel', store: 'home', categorySlug: 'home-appliances', title: 'کتری برقی استیل ۱.۷ لیتری', description: 'بدنهٔ استیل ضدزنگ، توان ۲۲۰۰ وات، خاموشی خودکار و پایهٔ چرخشی ۳۶۰ درجه.', image: 'home-kitchen-1.jpg', priceToman: 1_390_000, compareAtToman: 1_650_000, stock: 30, weightGrams: 1100, guarantee: '۱۸ ماه گارانتی', specs: [['مشخصات', 'ظرفیت', '۱.۷ لیتر'], ['مشخصات', 'توان', '۲۲۰۰ وات'], ['ایمنی', 'خاموشی خودکار', 'دارد']] },
  { slug: 'demo-blender-glass', store: 'home', categorySlug: 'home-appliances', title: 'مخلوط‌کن پارچ شیشه‌ای ۱.۵ لیتری', description: 'موتور ۸۰۰ وات، تیغه‌های چهارپرهٔ استیل و ۳ سرعت به‌همراه حالت پالس.', image: 'home-kitchen-2.jpg', priceToman: 2_450_000, compareAtToman: null, stock: 14, weightGrams: 2600, guarantee: '۱۸ ماه گارانتی', specs: [['مشخصات', 'توان', '۸۰۰ وات'], ['مشخصات', 'ظرفیت پارچ', '۱.۵ لیتر'], ['مشخصات', 'سرعت', '۳ سرعت + پالس']] },
  { slug: 'demo-steam-iron', store: 'home', categorySlug: 'home-appliances', title: 'اتو بخار ۲۴۰۰ وات کف سرامیکی', description: 'بخار پیوسته ۳۵ گرم در دقیقه، ضربهٔ بخار ۱۵۰ گرمی و سیستم ضدرسوب.', image: 'home-kitchen-3.jpg', priceToman: 1_690_000, compareAtToman: 1_950_000, stock: 20, weightGrams: 1300, guarantee: '۱۸ ماه گارانتی', specs: [['مشخصات', 'توان', '۲۴۰۰ وات'], ['مشخصات', 'کف', 'سرامیکی'], ['بخار', 'ضربهٔ بخار', '۱۵۰ گرم']] },
  { slug: 'demo-cordless-vacuum', store: 'home', categorySlug: 'home-appliances', title: 'جاروشارژی عصایی ۲ در ۱', description: 'مکش ۱۸ کیلوپاسکال، باتری لیتیومی با ۳۵ دقیقه کارکرد و قابلیت تبدیل به جاروی دستی.', image: 'home-kitchen-4.jpg', priceToman: 6_900_000, compareAtToman: 7_800_000, stock: 9, weightGrams: 2400, guarantee: '۱۸ ماه گارانتی', colors: [BLACK], specs: [['مشخصات', 'قدرت مکش', '۱۸ کیلوپاسکال'], ['باتری', 'زمان کارکرد', '۳۵ دقیقه'], ['مشخصات', 'مخزن', '۰.۶ لیتر']] },
  { slug: 'demo-toaster-2slice', store: 'home', categorySlug: 'home-appliances', title: 'توستر دو اسلایس ۷ درجه', description: 'تنظیم ۷ درجهٔ برشته‌شدن، حالت یخ‌زدایی و سینی جمع‌آوری خرده نان.', image: 'home-kitchen-5.jpg', priceToman: 1_250_000, compareAtToman: null, stock: 17, weightGrams: 1200, guarantee: '۱۸ ماه گارانتی', colors: [WHITE], specs: [['مشخصات', 'توان', '۸۵۰ وات'], ['مشخصات', 'تعداد اسلایس', '۲']] },
  { slug: 'demo-nonstick-frypan-28', store: 'home', categorySlug: 'kitchenware', title: 'تابهٔ نچسب گرانیتی ۲۸ سانتی‌متر', description: 'پوشش گرانیتی پنج‌لایه، کف القایی و دستهٔ ضدحرارت.', image: 'home-kitchen-6.jpg', priceToman: 690_000, compareAtToman: 820_000, stock: 45, weightGrams: 900, specs: [['مشخصات', 'قطر', '۲۸ سانتی‌متر'], ['مشخصات', 'پوشش', 'گرانیتی ۵ لایه'], ['سازگاری', 'اجاق القایی', 'دارد']] },
  { slug: 'demo-cookware-set-8', store: 'home', categorySlug: 'kitchenware', title: 'سرویس قابلمهٔ استیل ۸ پارچه', description: 'چهار قابلمه با درب شیشه‌ای نشکن، کف سه‌لایه و مناسب همهٔ اجاق‌ها.', image: 'home-kitchen-7.jpg', priceToman: 4_850_000, compareAtToman: null, stock: 10, weightGrams: 6500, specs: [['مشخصات', 'تعداد', '۸ پارچه'], ['جنس', 'بدنه', 'استیل ۳۰۴'], ['سازگاری', 'اجاق القایی', 'دارد']] },
  { slug: 'demo-glass-teapot-set', store: 'home', categorySlug: 'kitchenware', title: 'قوری شیشه‌ای دم‌نوش با دو استکان', description: 'قوری پیرکس مقاوم در برابر حرارت با صافی استیل و دو استکان نعلبکی‌دار.', image: 'home-kitchen-8.jpg', priceToman: 540_000, compareAtToman: 640_000, stock: 28, weightGrams: 1000, specs: [['جنس', 'بدنه', 'شیشهٔ پیرکس'], ['مشخصات', 'ظرفیت قوری', '۷۵۰ میلی‌لیتر']] },
  { slug: 'demo-knife-block-set', store: 'home', categorySlug: 'kitchenware', title: 'سرویس چاقوی آشپزخانه ۶ پارچه با پایهٔ چوبی', description: 'تیغه‌های استیل ضدزنگ آلمانی با دستهٔ ارگونومیک و پایهٔ چوب بامبو.', image: 'home-kitchen-9.jpg', priceToman: 1_780_000, compareAtToman: null, stock: 12, weightGrams: 2000, specs: [['مشخصات', 'تعداد', '۶ پارچه'], ['جنس', 'تیغه', 'استیل ضدزنگ'], ['جنس', 'پایه', 'بامبو']] },

  // ─── Beauty & Health (آرتا استایل) ──────────────────────────────────────
  { slug: 'demo-moisturizer-cream', store: 'style', categorySlug: 'skincare', title: 'کرم آبرسان صورت مناسب پوست خشک ۵۰ میلی‌لیتر', description: 'حاوی هیالورونیک اسید و سرامید، جذب سریع و بدون چربی باقی‌مانده.', image: 'beauty-health-1.jpg', priceToman: 320_000, compareAtToman: 380_000, stock: 50, weightGrams: 90, specs: [['مشخصات', 'حجم', '۵۰ میلی‌لیتر'], ['مشخصات', 'نوع پوست', 'خشک و معمولی'], ['ترکیبات', 'مواد مؤثر', 'هیالورونیک اسید، سرامید']] },
  { slug: 'demo-sunscreen-spf50', store: 'style', categorySlug: 'skincare', title: 'کرم ضدآفتاب بی‌رنگ SPF50', description: 'محافظت گستردهٔ UVA/UVB، بافت سبک و مناسب پوست‌های حساس.', image: 'beauty-health-2.jpg', priceToman: 285_000, compareAtToman: null, stock: 60, weightGrams: 70, specs: [['مشخصات', 'حجم', '۵۰ میلی‌لیتر'], ['مشخصات', 'SPF', '۵۰'], ['مشخصات', 'رنگ', 'بی‌رنگ']] },
  { slug: 'demo-facial-cleanser-gel', store: 'style', categorySlug: 'skincare', title: 'ژل شست‌وشوی صورت ۲۰۰ میلی‌لیتر', description: 'پاک‌کنندهٔ ملایم بدون سولفات با عصارهٔ چای سبز.', image: 'beauty-health-3.jpg', priceToman: 210_000, compareAtToman: 250_000, stock: 55, weightGrams: 230, specs: [['مشخصات', 'حجم', '۲۰۰ میلی‌لیتر'], ['ترکیبات', 'ویژگی', 'بدون سولفات']] },
  { slug: 'demo-vitamin-c-serum', store: 'style', categorySlug: 'skincare', title: 'سرم ویتامین C روشن‌کننده ۳۰ میلی‌لیتر', description: 'ویتامین C پایدار ۱۰٪ برای یکنواختی رنگ پوست، در بطری تیره با قطره‌چکان.', image: 'beauty-health-4.jpg', priceToman: 450_000, compareAtToman: null, stock: 34, weightGrams: 80, specs: [['مشخصات', 'حجم', '۳۰ میلی‌لیتر'], ['ترکیبات', 'غلظت ویتامین C', '۱۰٪']] },
  { slug: 'demo-electric-toothbrush', store: 'style', categorySlug: 'personal-care', title: 'مسواک برقی سونیک شارژی', description: '۴۰ هزار ضربه در دقیقه، ۳ حالت تمیزکنندگی، تایمر ۲ دقیقه‌ای و ۳۰ روز شارژدهی.', image: 'beauty-health-5.jpg', priceToman: 1_150_000, compareAtToman: 1_350_000, stock: 24, weightGrams: 150, guarantee: '۱۲ ماه گارانتی', colors: [WHITE], specs: [['مشخصات', 'نوع', 'سونیک'], ['باتری', 'شارژدهی', '۳۰ روز'], ['مشخصات', 'حالت‌ها', '۳ حالت']] },
  { slug: 'demo-hair-dryer-2000', store: 'style', categorySlug: 'personal-care', title: 'سشوار ۲۰۰۰ وات یونیزه', description: 'فناوری یون منفی برای کاهش وز، ۳ دما و ۲ سرعت به‌همراه دکمهٔ باد سرد.', image: 'beauty-health-6.jpg', priceToman: 1_390_000, compareAtToman: null, stock: 19, weightGrams: 550, guarantee: '۱۲ ماه گارانتی', colors: [{ name: 'صورتی', hex: '#F9A8D4' }], specs: [['مشخصات', 'توان', '۲۰۰۰ وات'], ['مشخصات', 'دما', '۳ سطح'], ['مشخصات', 'یونیزه', 'دارد']] },
  { slug: 'demo-beard-trimmer', store: 'style', categorySlug: 'personal-care', title: 'ماشین اصلاح ریش و موی شارژی', description: 'تیغهٔ تیتانیومی، ۲۰ تنظیم طول و ۹۰ دقیقه کارکرد با هر بار شارژ.', image: 'beauty-health-7.jpg', priceToman: 980_000, compareAtToman: 1_150_000, stock: 27, weightGrams: 180, guarantee: '۱۲ ماه گارانتی', colors: [BLACK], specs: [['مشخصات', 'تیغه', 'تیتانیوم'], ['مشخصات', 'تنظیم طول', '۲۰ حالت'], ['باتری', 'زمان کارکرد', '۹۰ دقیقه']] },
  { slug: 'demo-shampoo-daily', store: 'style', categorySlug: 'personal-care', title: 'شامپو روزانهٔ مناسب موی معمولی ۴۰۰ میلی‌لیتر', description: 'فرمول ملایم با پروتئین گندم برای استفادهٔ روزانه.', image: 'beauty-health-8.jpg', priceToman: 165_000, compareAtToman: null, stock: 70, weightGrams: 440, specs: [['مشخصات', 'حجم', '۴۰۰ میلی‌لیتر'], ['مشخصات', 'نوع مو', 'معمولی']] },
  { slug: 'demo-glass-body-scale', store: 'style', categorySlug: 'personal-care', title: 'ترازوی دیجیتال شیشه‌ای حمام', description: 'صفحهٔ شیشهٔ سکوریت، دقت ۱۰۰ گرم و ظرفیت ۱۸۰ کیلوگرم.', image: 'beauty-health-9.jpg', priceToman: 690_000, compareAtToman: 790_000, stock: 21, weightGrams: 1600, guarantee: '۱۲ ماه گارانتی', specs: [['مشخصات', 'ظرفیت', '۱۸۰ کیلوگرم'], ['مشخصات', 'دقت', '۱۰۰ گرم']] },

  // ─── Sport & Travel (کوهسار گیر) ────────────────────────────────────────
  { slug: 'demo-yoga-mat-8mm', store: 'gear', categorySlug: 'fitness-equipment', title: 'مت یوگا ۸ میلی‌متری با بند حمل', description: 'فوم TPE ضدلغزش دوطرفه، سبک و قابل شست‌وشو؛ ابعاد ۱۸۳ در ۶۱ سانتی‌متر.', image: 'sport-travel-1.jpg', priceToman: 590_000, compareAtToman: 720_000, stock: 40, weightGrams: 900, colors: [{ name: 'بنفش', hex: '#7C3AED' }], specs: [['مشخصات', 'ضخامت', '۸ میلی‌متر'], ['جنس', 'فوم', 'TPE'], ['ابعاد', 'اندازه', '۱۸۳×۶۱ سانتی‌متر']] },
  { slug: 'demo-hex-dumbbell-pair', store: 'gear', categorySlug: 'fitness-equipment', title: 'دمبل شش‌ضلعی روکش لاستیکی (جفت)', description: 'دمبل چدنی با روکش لاستیکی ضدضربه و دستهٔ کروم آج‌دار.', image: 'sport-travel-2.jpg', priceToman: 1_250_000, compareAtToman: null, stock: 25, weightGrams: 10000, sizes: ['۵ کیلوگرم', '۱۰ کیلوگرم'], specs: [['جنس', 'بدنه', 'چدن با روکش لاستیک'], ['مشخصات', 'تعداد', 'یک جفت']] },
  { slug: 'demo-jump-rope', store: 'gear', categorySlug: 'fitness-equipment', title: 'طناب ورزشی بلبرینگی با دستهٔ فومی', description: 'کابل فولادی روکش‌دار با طول قابل تنظیم و بلبرینگ روان.', image: 'sport-travel-3.jpg', priceToman: 190_000, compareAtToman: 240_000, stock: 90, weightGrams: 200, colors: [BLACK], specs: [['مشخصات', 'طول', 'قابل تنظیم تا ۳ متر'], ['جنس', 'کابل', 'فولاد روکش‌دار']] },
  { slug: 'demo-soccer-ball-5', store: 'gear', categorySlug: 'fitness-equipment', title: 'توپ فوتبال سایز ۵ دوخت حرارتی', description: 'رویهٔ PU با دوخت حرارتی، مناسب چمن طبیعی و مصنوعی.', image: 'sport-travel-4.jpg', priceToman: 780_000, compareAtToman: null, stock: 33, weightGrams: 430, specs: [['مشخصات', 'سایز', '۵'], ['جنس', 'رویه', 'PU'], ['مشخصات', 'دوخت', 'حرارتی']] },
  { slug: 'demo-steel-water-bottle', store: 'gear', categorySlug: 'fitness-equipment', title: 'قمقمهٔ استیل ورزشی ۷۵۰ میلی‌لیتر', description: 'استیل ضدزنگ خوراکی، درب پیچی ضدنشت و حلقهٔ حمل.', image: 'sport-travel-5.jpg', priceToman: 350_000, compareAtToman: 420_000, stock: 65, weightGrams: 300, specs: [['مشخصات', 'ظرفیت', '۷۵۰ میلی‌لیتر'], ['جنس', 'بدنه', 'استیل ۳۰۴']] },
  { slug: 'demo-dome-tent-4p', store: 'gear', categorySlug: 'camping-travel', title: 'چادر مسافرتی گنبدی ۴ نفره', description: 'دولایه با پوشش ضدآب ۳۰۰۰ میلی‌متر، تیرک فایبرگلاس و برپایی سریع.', image: 'sport-travel-6.jpg', priceToman: 3_900_000, compareAtToman: 4_500_000, stock: 11, weightGrams: 4200, colors: [{ name: 'سبز', hex: '#15803D' }], specs: [['مشخصات', 'ظرفیت', '۴ نفر'], ['مشخصات', 'ضدآب', '۳۰۰۰ میلی‌متر'], ['جنس', 'تیرک', 'فایبرگلاس']] },
  { slug: 'demo-hiking-backpack-45', store: 'gear', categorySlug: 'camping-travel', title: 'کولهٔ کوهنوردی ۴۵ لیتری', description: 'سیستم پشتی تهویه‌دار، کمربند کمری پددار و کاور باران داخلی.', image: 'sport-travel-7.jpg', priceToman: 2_650_000, compareAtToman: null, stock: 13, weightGrams: 1400, colors: [{ name: 'نارنجی', hex: '#EA580C' }], specs: [['ظرفیت', 'حجم', '۴۵ لیتر'], ['امکانات', 'کاور باران', 'دارد']] },
  { slug: 'demo-sleeping-bag', store: 'gear', categorySlug: 'camping-travel', title: 'کیسه‌خواب سه‌فصل دمای آسایش ۵ درجه', description: 'الیاف توخالی سبک، زیپ دوطرفه و کیسهٔ فشرده‌ساز.', image: 'sport-travel-8.jpg', priceToman: 1_490_000, compareAtToman: 1_750_000, stock: 18, weightGrams: 1500, colors: [{ name: 'آبی', hex: '#1D4ED8' }], specs: [['مشخصات', 'دمای آسایش', '۵+ درجه'], ['مشخصات', 'فصل', 'سه‌فصل']] },
  { slug: 'demo-carry-on-suitcase', store: 'gear', categorySlug: 'camping-travel', title: 'چمدان کابین پلی‌کربنات ۲۰ اینچ', description: 'بدنهٔ سخت پلی‌کربنات، چهار چرخ ۳۶۰ درجه و قفل رمزدار TSA.', image: 'sport-travel-9.jpg', priceToman: 3_350_000, compareAtToman: null, stock: 9, weightGrams: 3100, colors: [GREY], specs: [['مشخصات', 'اندازه', '۲۰ اینچ (کابین)'], ['جنس', 'بدنه', 'پلی‌کربنات'], ['امکانات', 'قفل', 'TSA رمزدار']] },

  // ─── Tools & Auto (کوهسار گیر) ──────────────────────────────────────────
  { slug: 'demo-cordless-drill-20v', store: 'gear', categorySlug: 'power-tools', title: 'دریل پیچ‌گوشتی شارژی ۲۰ ولت با دو باتری', description: 'گشتاور ۴۵ نیوتن‌متر، دو سرعت مکانیکی، سه‌نظام آچاری ۱۰ میلی‌متر و کیف حمل.', image: 'tools-auto-1.jpg', priceToman: 3_450_000, compareAtToman: 3_990_000, stock: 15, weightGrams: 2300, guarantee: '۱۲ ماه گارانتی', specs: [['مشخصات', 'ولتاژ', '۲۰ ولت'], ['مشخصات', 'گشتاور', '۴۵ نیوتن‌متر'], ['اقلام همراه', 'باتری', '۲ عدد']] },
  { slug: 'demo-bit-set-46', store: 'gear', categorySlug: 'power-tools', title: 'جعبه بکس و سری پیچ‌گوشتی ۴۶ پارچه', description: 'آچار جغجغه‌ای، بکس‌های ۴ تا ۱۴ میلی‌متر و سری‌های پیچ‌گوشتی در کیف مقاوم.', image: 'tools-auto-2.jpg', priceToman: 890_000, compareAtToman: null, stock: 30, weightGrams: 1800, specs: [['مشخصات', 'تعداد', '۴۶ پارچه'], ['جنس', 'فولاد', 'کروم وانادیوم']] },
  { slug: 'demo-angle-grinder-115', store: 'gear', categorySlug: 'power-tools', title: 'مینی فرز ۸۵۰ وات ۱۱۵ میلی‌متر', description: 'موتور مسی، دستهٔ کمکی دو حالته و قفل محور برای تعویض سریع صفحه.', image: 'tools-auto-3.jpg', priceToman: 2_150_000, compareAtToman: 2_400_000, stock: 12, weightGrams: 1900, guarantee: '۱۲ ماه گارانتی', specs: [['مشخصات', 'توان', '۸۵۰ وات'], ['مشخصات', 'قطر صفحه', '۱۱۵ میلی‌متر']] },
  { slug: 'demo-toolbox-set', store: 'gear', categorySlug: 'power-tools', title: 'جعبه‌ابزار فلزی با ابزار دستی ۲۵ پارچه', description: 'چکش، انبردست، آچار فرانسه، پیچ‌گوشتی‌ها و متر در جعبهٔ فلزی دوطبقه.', image: 'tools-auto-4.jpg', priceToman: 2_490_000, compareAtToman: null, stock: 10, weightGrams: 5500, specs: [['مشخصات', 'تعداد ابزار', '۲۵ پارچه'], ['جنس', 'جعبه', 'فلزی']] },
  { slug: 'demo-tape-measure-5m', store: 'gear', categorySlug: 'power-tools', title: 'متر نواری ۵ متری', description: 'نوار فولادی ۲۵ میلی‌متری با قفل خودکار و بدنهٔ روکش لاستیکی.', image: 'tools-auto-5.jpg', priceToman: 185_000, compareAtToman: 220_000, stock: 100, weightGrams: 300, specs: [['مشخصات', 'طول', '۵ متر'], ['مشخصات', 'عرض نوار', '۲۵ میلی‌متر']] },
  { slug: 'demo-car-phone-holder', store: 'gear', categorySlug: 'car-accessories', title: 'پایهٔ نگهدارندهٔ موبایل داشبورد خودرو', description: 'مکش ژله‌ای قوی، بازوی قابل تنظیم و گیرهٔ فنری مناسب گوشی‌های ۴.۷ تا ۷ اینچ.', image: 'tools-auto-6.jpg', priceToman: 290_000, compareAtToman: null, stock: 75, weightGrams: 250, colors: [BLACK], specs: [['مشخصات', 'نوع نصب', 'داشبورد و شیشه'], ['سازگاری', 'اندازهٔ گوشی', '۴.۷ تا ۷ اینچ']] },
  { slug: 'demo-tire-inflator', store: 'gear', categorySlug: 'car-accessories', title: 'پمپ باد فندکی دیجیتال', description: 'نمایشگر فشار، توقف خودکار در فشار تعیین‌شده و چراغ LED اضطراری.', image: 'tools-auto-7.jpg', priceToman: 1_350_000, compareAtToman: 1_590_000, stock: 20, weightGrams: 900, guarantee: '۱۲ ماه گارانتی', specs: [['مشخصات', 'حداکثر فشار', '۱۵۰ PSI'], ['مشخصات', 'برق', 'فندکی ۱۲ ولت']] },
  { slug: 'demo-car-vacuum', store: 'gear', categorySlug: 'car-accessories', title: 'جاروبرقی فندکی خودرو ۱۲۰ وات', description: 'فیلتر HEPA قابل شست‌وشو، کابل ۴ متری و سری‌های باریک برای لابه‌لای صندلی.', image: 'tools-auto-8.jpg', priceToman: 850_000, compareAtToman: null, stock: 28, weightGrams: 1000, specs: [['مشخصات', 'توان', '۱۲۰ وات'], ['مشخصات', 'فیلتر', 'HEPA']] },
  { slug: 'demo-dash-cam-fhd', store: 'gear', categorySlug: 'car-accessories', title: 'دوربین ثبت وقایع خودرو Full HD', description: 'زاویهٔ دید ۱۴۰ درجه، دید در شب، ضبط حلقه‌ای و حسگر ضربه.', image: 'tools-auto-9.jpg', priceToman: 1_950_000, compareAtToman: 2_300_000, stock: 16, weightGrams: 350, guarantee: '۱۲ ماه گارانتی', specs: [['مشخصات', 'کیفیت ضبط', 'Full HD 1080p'], ['مشخصات', 'زاویهٔ دید', '۱۴۰ درجه'], ['امکانات', 'حسگر ضربه', 'دارد']] },
];
