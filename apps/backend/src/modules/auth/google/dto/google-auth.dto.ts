import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';
import { AuthTokensResponseDto } from '../../dto/auth-response.dto';

/** Header carrying the signup ticket of the mobile binding step (never a URL parameter, so it stays out of logs). */
export const GOOGLE_SIGNUP_TICKET_HEADER = 'x-google-signup-ticket';

export class GoogleStatusDto {
  @ApiProperty({ description: 'آیا ورود با گوگل روی این سرور پیکربندی و فعال است' })
  enabled!: boolean;
}

export class GoogleStartQueryDto {
  @ApiPropertyOptional({ example: '/cart', description: 'مسیر داخلی بازگشت پس از ورود (فقط مسیر نسبیِ همین سایت پذیرفته می‌شود)' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  next?: string;
}

export class GoogleStartResponseDto {
  @ApiProperty({ description: 'آدرس صفحهٔ ورود گوگل (کد مجوز + PKCE S256 + nonce)' })
  authorizationUrl!: string;

  @ApiProperty({ description: 'state یکبارمصرف؛ BFF آن را در کوکی httpOnly نگه می‌دارد و در بازگشت مقایسه می‌کند' })
  state!: string;

  @ApiProperty({ example: 600 })
  expiresInSeconds!: number;
}

export class GoogleCallbackQueryDto {
  @ApiProperty({ description: 'کد مجوزی که گوگل به redirect URI فرستاده است' })
  @IsString()
  @Length(1, 2048)
  code!: string;

  @ApiProperty({ description: 'state برگشتی از گوگل' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{32,128}$/, { message: 'state is malformed' })
  state!: string;
}

export class GoogleSignupProfileDto {
  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String })
  name!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'تصویر پروفایل گوگل (https)' })
  picture!: string | null;
}

export class GoogleSignupStateDto extends GoogleSignupProfileDto {
  @ApiProperty({ nullable: true, type: String })
  next!: string | null;

  @ApiProperty({ nullable: true, type: String, description: 'شماره‌ای که کد تأیید برای آن ارسال شده است' })
  mobile!: string | null;

  @ApiProperty({ example: 812 })
  expiresInSeconds!: number;
}

export class GoogleCallbackResponseDto {
  @ApiProperty({ enum: ['signed_in', 'mobile_required'] })
  status!: 'signed_in' | 'mobile_required';

  @ApiProperty({ nullable: true, type: String })
  next!: string | null;

  @ApiPropertyOptional({ type: AuthTokensResponseDto, description: 'فقط در signed_in' })
  tokens?: AuthTokensResponseDto;

  @ApiPropertyOptional({ description: 'فقط در mobile_required — بلیت مرحلهٔ تأیید موبایل (۱۵ دقیقه)' })
  ticket?: string;

  @ApiPropertyOptional({ example: 900 })
  expiresInSeconds?: number;

  @ApiPropertyOptional({ type: GoogleSignupProfileDto })
  profile?: GoogleSignupProfileDto;
}

export class GoogleSignupVerifyResponseDto {
  @ApiProperty({ nullable: true, type: String })
  next!: string | null;

  @ApiProperty({ type: AuthTokensResponseDto })
  tokens!: AuthTokensResponseDto;
}
