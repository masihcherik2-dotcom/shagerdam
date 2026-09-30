import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { toE164 } from '../../../common/validators/iranian-mobile';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { IsIranianSheba } from '../../../common/validators/is-iranian-sheba.decorator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { STORE_SLUG_PATTERN } from './register-vendor.dto';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

/**
 * `POST /admin/vendors` — an administrator opens a store on behalf of a seller.
 *
 * The store is `APPROVED` immediately: the administrator creating it takes
 * responsibility for the seller's identity check (recorded in the audit row as
 * `kycBy: 'ADMIN_CREATED'`). The seller signs in with the owner mobile through the
 * normal OTP login at `/login`; no password is created here.
 */
export class AdminCreateVendorDto {
  @ApiProperty({ example: 'فروشگاه نمونه', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @Length(2, 120)
  storeName!: string;

  @ApiProperty({ example: 'sample-store', maxLength: 140 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value))
  @IsString()
  @Length(3, 140)
  @Matches(STORE_SLUG_PATTERN, { message: 'storeSlug must contain lowercase letters, digits and single hyphens only (e.g. my-store-1)' })
  storeSlug!: string;

  @ApiProperty({ example: '09121234567', description: 'موبایل مالک فروشگاه؛ ورود فروشنده با همین شماره و کد یک‌بارمصرف انجام می‌شود.' })
  @Transform(({ value }): unknown => (typeof value === 'string' ? (toE164(value) ?? value) : value))
  @IsIranianMobile()
  ownerMobile!: string;

  @ApiProperty({ example: 'علی رضایی', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @Length(3, 120)
  ownerFullName!: string;

  @ApiProperty({ example: 'IR820540102680020817909002', description: 'شبای حساب تسویهٔ فروشگاه' })
  @Transform(trim)
  @IsString()
  @IsIranianSheba()
  bankIban!: string;

  @ApiPropertyOptional({ example: 'علی رضایی', maxLength: 120, description: 'نام صاحب حساب؛ اگر خالی باشد نام مالک استفاده می‌شود.' })
  @IsOptionalNonNullable()
  @Transform(trim)
  @IsString()
  @Length(3, 120)
  bankAccountHolder?: string;

  @ApiPropertyOptional({ example: 7.5, nullable: true, description: 'کمیسیون اختصاصی (درصد، حداکثر دو رقم اعشار)؛ null یعنی نرخ دسته‌بندی.' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false }, { message: 'commissionRateOverride must be a percentage with at most two decimal places' })
  @Min(0)
  @Max(100)
  commissionRateOverride?: number | null;

  @ApiPropertyOptional({ example: 'sample.store', maxLength: 60 })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(60)
  instagramHandle?: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(2000)
  bio?: string;
}
