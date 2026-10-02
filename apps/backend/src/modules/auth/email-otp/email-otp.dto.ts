import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsString, Matches, MaxLength } from 'class-validator';
import { normalizeEmail } from '../../../common/validators/email';
import { toAsciiDigits } from '../../../common/validators/iranian-mobile';
import { AuthTokensResponseDto } from '../dto/auth-response.dto';

/** Header carrying the ticket of the mobile step (the BFF reads it from an httpOnly cookie). */
export const EMAIL_SIGNUP_TICKET_HEADER = 'x-email-signup-ticket';

const toEmail = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? (normalizeEmail(value) ?? value.trim()) : value);

export class RequestEmailOtpDto {
  @ApiProperty({ example: 'sara@gmail.com', maxLength: 254, description: 'ایمیل (کوچک‌حرف و trim می‌شود)' })
  @Transform(toEmail)
  @IsEmail({ require_tld: true, allow_display_name: false, allow_ip_domain: false }, { message: 'ایمیل معتبر نیست' })
  @MaxLength(254)
  email!: string;
}

export class VerifyEmailOtpDto extends RequestEmailOtpDto {
  @ApiProperty({ example: '48213', description: 'کد یکبارمصرف ارسال‌شده به ایمیل' })
  @Transform(({ value }): unknown => (typeof value === 'string' ? toAsciiDigits(value).trim() : value))
  @IsString()
  @Matches(/^[0-9]{4,8}$/, { message: 'کد یکبارمصرف باید فقط رقم باشد' })
  code!: string;
}

export class EmailOtpStatusDto {
  @ApiProperty({ description: 'false وقتی MAIL_PROVIDER=none است؛ تب «ورود با ایمیل» نمایش داده نمی‌شود.' })
  enabled!: boolean;

  @ApiProperty({ description: 'true برای Provider آزمایشی (sandbox) که ایمیل واقعی نمی‌فرستد.' })
  isTestProvider!: boolean;
}

export class EmailOtpVerifyResponseDto {
  @ApiProperty({ enum: ['signed_in', 'mobile_required'] })
  status!: 'signed_in' | 'mobile_required';

  @ApiPropertyOptional({ type: AuthTokensResponseDto, description: 'فقط برای signed_in' })
  tokens?: AuthTokensResponseDto;

  @ApiPropertyOptional({ description: 'فقط برای mobile_required — بلیت ۱۵ دقیقه‌ای مرحلهٔ تأیید موبایل' })
  ticket?: string;

  @ApiPropertyOptional({ example: 900 })
  expiresInSeconds?: number;

  @ApiPropertyOptional({ example: 'sara@gmail.com' })
  email?: string;
}

export class EmailSignupStateDto {
  @ApiProperty({ example: 'sara@gmail.com' })
  email!: string;

  @ApiProperty({ nullable: true, type: String, example: '+989121234567', description: 'شماره‌ای که کد برایش ارسال شده' })
  mobile!: string | null;

  @ApiProperty({ example: 812 })
  expiresInSeconds!: number;
}
