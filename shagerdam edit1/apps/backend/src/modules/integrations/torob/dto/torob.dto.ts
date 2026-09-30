import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min } from 'class-validator';
import { SKU_PATTERN } from '../../../products/product-rules';
import { STORE_SLUG_PATTERN } from '../../../vendors/dto/register-vendor.dto';
import { TOROB_AVAILABILITY, type TorobAvailability, type TorobProductItem } from '../torob-item.mapper';

export const TOROB_DEFAULT_PAGE_SIZE = 100;
export const TOROB_MAX_PAGE_SIZE = 500;
/** Deepest page served; 10 000 × 500 = 5 M offers, far beyond any real catalogue. */
export const TOROB_MAX_PAGE = 10_000;

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

export class TorobFeedQueryDto {
  @ApiPropertyOptional({ description: 'شمارهٔ صفحه (از ۱)', default: 1, minimum: 1, maximum: TOROB_MAX_PAGE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TOROB_MAX_PAGE)
  page?: number;

  @ApiPropertyOptional({ description: 'تعداد کالا در هر صفحه', default: TOROB_DEFAULT_PAGE_SIZE, minimum: 1, maximum: TOROB_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TOROB_MAX_PAGE_SIZE)
  pageSize?: number;

  @ApiPropertyOptional({ description: 'نام دیگر pageSize (اگر هر دو ارسال شوند، pageSize معتبر است)', minimum: 1, maximum: TOROB_MAX_PAGE_SIZE })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TOROB_MAX_PAGE_SIZE)
  limit?: number;

  @ApiPropertyOptional({ description: 'فید اختصاصی یک فروشگاه تأییدشده (storeSlug)', example: 'shopino-sample-store' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(140)
  @Matches(STORE_SLUG_PATTERN, { message: 'vendorSlug must be a store slug (lowercase letters, digits and single hyphens)' })
  vendorSlug?: string;
}

export class TorobProductDetailsQueryDto {
  @ApiPropertyOptional({ description: 'شناسهٔ یکتای کالا در فید (SKU تنوع)', example: 'SHP-VAR-10023' })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @Matches(SKU_PATTERN, { message: 'page_unique must be a SKU (A–Z, 0–9, ".", "_" or "-")' })
  page_unique?: string;

  @ApiPropertyOptional({
    description: 'نشانی صفحهٔ کالا در همین فروشگاه؛ بدون ?variant اولین تنوع موجود برگردانده می‌شود',
    example: 'https://shagerdam.ir/products/samsung-s24-ultra?variant=SHP-VAR-10023',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2048)
  page_url?: string;
}

export class TorobProductItemDto implements TorobProductItem {
  @ApiProperty({ description: 'شناسهٔ یکتا و ثابت: SKU تنوع (پس از ثبت قابل تغییر نیست)', example: 'SHP-VAR-10023' })
  page_unique!: string;

  @ApiProperty({ description: 'عنوان فارسی کالا به‌همراه رنگ/سایز تنوع', example: 'گوشی موبایل سامسونگ مدل Galaxy S24 Ultra، رنگ مشکی تیتانیوم' })
  title!: string;

  @ApiProperty({ description: 'قیمت فروش فعلی (عدد صحیح، واحد طبق TOROB_PRICE_UNIT: ریال یا تومان)', example: 620000000 })
  price!: number;

  @ApiProperty({ description: 'قیمت قبل از تخفیف؛ فقط وقتی از قیمت فعلی بیشتر است', nullable: true, type: Number, example: 650000000 })
  old_price!: number | null;

  @ApiProperty({ enum: Object.values(TOROB_AVAILABILITY), description: 'instock وقتی موجودی قابل فروش (موجودی − رزرو) بیشتر از صفر است' })
  availability!: TorobAvailability;

  @ApiProperty({ description: 'نشانی مطلق صفحهٔ کالا با انتخاب همین تنوع', example: 'https://shagerdam.ir/products/samsung-s24-ultra?variant=SHP-VAR-10023' })
  page_url!: string;

  @ApiProperty({ type: [String], description: 'نشانی مطلق تصاویر (حداکثر ۱۰، تصویر اصلی اول)' })
  image_links!: string[];

  @ApiProperty({ description: 'مسیر دسته‌بندی', nullable: true, type: String, example: 'کالای دیجیتال > گوشی موبایل' })
  category_name!: string | null;

  @ApiProperty({
    description: 'مشخصات فنی کالا و ویژگی‌های تنوع (رنگ، سایز، گارانتی، برند)',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { رنگ: 'مشکی تیتانیوم', 'حافظه داخلی': '256 گیگابایت' },
  })
  spec!: Record<string, string>;

  @ApiProperty({ nullable: true, type: String, example: 'گارانتی ۱۸ ماهه شرکتی' })
  guarantee!: string | null;

  @ApiProperty({ description: 'هزینهٔ ارسال یک مرسولهٔ تک‌کالایی از این فروشگاه (همان فرمول تسویهٔ سبد خرید)', example: 500000 })
  delivery_fee!: number;
}

export class TorobFeedResponseDto {
  @ApiProperty({ description: 'تعداد کل کالاها (تنوع‌ها) در فید', example: 1250 })
  count!: number;

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 13 })
  totalPages!: number;

  @ApiProperty({ type: [TorobProductItemDto] })
  products!: TorobProductItemDto[];
}
