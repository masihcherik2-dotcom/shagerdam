import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { PublicUser, UserIdentity } from '../../users/users.service';

/** The user object embedded in every authentication response. */
export class AuthUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+989120000001' })
  mobile!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.CUSTOMER })
  role!: UserRole;

  @ApiProperty({ example: 'سارا محمدی' })
  fullName!: string;

  @ApiProperty({ nullable: true, example: 'sara@example.com' })
  email!: string | null;

  static from(user: PublicUser): AuthUserDto {
    return { id: user.id, mobile: user.mobile, role: user.role, fullName: user.fullName, email: user.email };
  }
}

export class OtpRequestResponseDto {
  @ApiProperty({ example: 'sent', enum: ['sent'] })
  status!: 'sent';

  @ApiProperty({ example: 120, description: 'مدت اعتبار کد به ثانیه' })
  expiresInSeconds!: number;

  @ApiProperty({
    example: 'SBX-M8ZK2P-1',
    description: 'شناسه ارسال نزد سرویسدهنده پیامک، برای پیگیری تحویل',
  })
  trackingId!: string;
}

export class AuthTokensResponseDto {
  @ApiProperty({ description: 'توکن دسترسی کوتاهعمر (پیشفرض ۱۵ دقیقه)' })
  accessToken!: string;

  @ApiProperty({ description: 'توکن تازهسازی پایدار (پیشفرض ۷ روز) — یکبارمصرف و چرخشی' })
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'عمر توکن دسترسی به ثانیه' })
  expiresIn!: number;

  @ApiProperty({ example: 604_800, description: 'عمر توکن تازهسازی به ثانیه' })
  refreshExpiresIn!: number;

  @ApiProperty({ example: '42f1…', description: 'شناسه نشست؛ برای ابطال هدفمند' })
  sessionId!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class CustomerProfileDto {
  @ApiProperty({ nullable: true, example: '1994-05-17T00:00:00.000Z' })
  birthDate!: Date | null;

  @ApiProperty({ nullable: true, enum: ['MALE', 'FEMALE', 'OTHER'] })
  gender!: string | null;

  @ApiProperty({ nullable: true, example: 'IR120570000000000000000001' })
  bankIban!: string | null;

  @ApiProperty({ nullable: true, format: 'uuid' })
  defaultAddressId!: string | null;
}

/**
 * Compact store view embedded in `GET /auth/me`.
 *
 * Named `MeVendorSummaryDto` rather than `VendorProfileDto` because the vendors
 * module owns that name: two different classes sharing one OpenAPI schema name
 * produces a broken document (and a warning at boot).
 */
export class MeVendorSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'فروشگاه نمونه شاگردم' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;

  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] })
  status!: string;

  @ApiProperty({ nullable: true })
  logoUrl!: string | null;
}

export class MeResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiPropertyOptional({ type: CustomerProfileDto, nullable: true })
  customerProfile!: CustomerProfileDto | null;

  @ApiPropertyOptional({ type: MeVendorSummaryDto, nullable: true })
  vendor!: MeVendorSummaryDto | null;

  static from(identity: UserIdentity): MeResponseDto {
    return {
      user: AuthUserDto.from(identity.user),
      customerProfile: identity.customerProfile,
      vendor: identity.vendor,
    };
  }
}

export class ProfileUpdateResponseDto extends MeResponseDto {
  @ApiProperty({ example: true, description: 'تغییرات ذخیره شد' })
  updated!: boolean;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true, description: 'نشست در سرور باطل شد' })
  revoked!: boolean;

  @ApiProperty({ example: 1, description: 'تعداد نشستهای باطلشده' })
  sessionsRevoked!: number;
}

export class SmsProviderInfoDto {
  @ApiProperty({ example: 'sandbox', enum: ['sandbox', 'kavenegar'] })
  provider!: string;

  @ApiProperty({
    example: true,
    description:
      'اگر true باشد، پیامک واقعاً ارسال نمیشود (Provider آزمایشی توسعه). در Production همیشه false است.',
  })
  isTestProvider!: boolean;
}
