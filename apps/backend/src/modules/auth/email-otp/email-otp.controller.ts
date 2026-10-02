import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ClientContext } from '../../../common/decorators/current-user.decorator';
import { Public } from '../../../common/decorators/public.decorator';
import type { RequestContext } from '../../../common/types/request-context';
import { SkipAudit } from '../../audit/audit.decorator';
import { AuthTokensResponseDto, OtpRequestResponseDto } from '../dto/auth-response.dto';
import { RequestOtpDto } from '../dto/request-otp.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import { EMAIL_SIGNUP_TICKET_HEADER, EmailOtpStatusDto, EmailOtpVerifyResponseDto, EmailSignupStateDto, RequestEmailOtpDto, VerifyEmailOtpDto } from './email-otp.dto';
import { EmailOtpService, type EmailOtpVerifyResult } from './email-otp.service';

@ApiTags('auth')
@Controller('auth/email-otp')
export class EmailOtpController {
  constructor(private readonly emailOtp: EmailOtpService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'وضعیت ورود با ایمیل', description: 'با MAIL_PROVIDER=none مقدار enabled=false است و فرانت تب «ورود با ایمیل» را نشان نمی‌دهد.' })
  @ApiOkResponse({ type: EmailOtpStatusDto })
  status(): EmailOtpStatusDto {
    return this.emailOtp.status();
  }

  @Public()
  @Post('request')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiOperation({
    summary: 'ارسال کد ورود به ایمیل',
    description:
      'برای هر ایمیل معتبر کد می‌فرستد، چه حسابی با آن باشد چه نباشد (هیچ اطلاعاتی دربارهٔ ثبت‌نام بودن ایمیل لو نمی‌رود). ' +
      'همان محدودیت‌های OTP پیامکی: یک درخواست در هر ۱۲۰ ثانیه برای هر ایمیل، سقف ساعتی برای ایمیل و برای IP (سقف IP با پیامک مشترک است). ' +
      'اگر ارسال ناموفق باشد، بازهٔ انتظار آزاد می‌شود.',
  })
  @ApiOkResponse({ type: OtpRequestResponseDto })
  @ApiBadRequestResponse({ description: 'ایمیل نامعتبر' })
  @ApiTooManyRequestsResponse({ description: 'cooldown، قفل یا سقف ساعتی' })
  @ApiBadGatewayResponse({ description: 'EMAIL_DELIVERY_FAILED — سرور SMTP ایمیل را نپذیرفت یا در دسترس نبود' })
  @ApiServiceUnavailableResponse({ description: 'EMAIL_NOT_CONFIGURED' })
  request(@Body() dto: RequestEmailOtpDto, @ClientContext() context: RequestContext): Promise<OtpRequestResponseDto> {
    return this.emailOtp.request(dto.email, context);
  }

  @Public()
  @Post('verify')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiOperation({
    summary: 'تأیید کد ایمیل',
    description:
      'اگر ایمیل متعلق به حسابی باشد که ایمیلش تأییدشده است → signed_in با توکن‌ها. ' +
      'در غیر این صورت (حساب جدید، یا ایمیلی که فقط در پروفایل وارد شده و تأیید نشده) → mobile_required با بلیت ۱۵ دقیقه‌ای برای تأیید یک‌بارهٔ موبایل. ' +
      'پس از ۵ کد نادرست، ایمیل ۱۵ دقیقه قفل می‌شود.',
  })
  @ApiOkResponse({ type: EmailOtpVerifyResponseDto })
  @ApiUnauthorizedResponse({ description: 'کد نادرست یا منقضی' })
  @ApiForbiddenResponse({ description: 'EMAIL_OTP_STAFF_NOT_ALLOWED یا حساب غیرفعال' })
  @ApiTooManyRequestsResponse({ description: 'قفل پس از کدهای نادرست' })
  verify(@Body() dto: VerifyEmailOtpDto, @ClientContext() context: RequestContext): Promise<EmailOtpVerifyResult> {
    return this.emailOtp.verify(dto.email, dto.code, context);
  }

  @Public()
  @Get('signup')
  @ApiHeader({ name: EMAIL_SIGNUP_TICKET_HEADER, required: true })
  @ApiOperation({ summary: 'اطلاعات مرحلهٔ تأیید موبایل پس از تأیید ایمیل' })
  @ApiOkResponse({ type: EmailSignupStateDto })
  @ApiUnauthorizedResponse({ description: 'EMAIL_OTP_SIGNUP_EXPIRED' })
  signup(@Headers(EMAIL_SIGNUP_TICKET_HEADER) ticket: string | undefined): Promise<EmailSignupStateDto> {
    return this.emailOtp.getSignup(ticket);
  }

  @Public()
  @Post('signup/otp')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiHeader({ name: EMAIL_SIGNUP_TICKET_HEADER, required: true })
  @ApiOperation({ summary: 'ارسال کد پیامکی برای تأیید موبایل (مرحلهٔ دوم ورود با ایمیل)' })
  @ApiOkResponse({ type: OtpRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'EMAIL_OTP_SIGNUP_EXPIRED' })
  @ApiTooManyRequestsResponse({ description: 'cooldown، قفل یا سقف ساعتی' })
  requestOtp(@Headers(EMAIL_SIGNUP_TICKET_HEADER) ticket: string | undefined, @Body() dto: RequestOtpDto, @ClientContext() context: RequestContext): Promise<OtpRequestResponseDto> {
    return this.emailOtp.requestSignupOtp(ticket, dto.mobile, context);
  }

  @Public()
  @Post('signup/verify')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiHeader({ name: EMAIL_SIGNUP_TICKET_HEADER, required: true })
  @ApiOperation({
    summary: 'تأیید موبایل و تکمیل ورود/ثبت‌نام با ایمیل',
    description:
      'اگر حسابی با این موبایل باشد، ایمیلِ اثبات‌شده به همان حساب داده و تأییدشده علامت می‌خورد؛ وگرنه حساب مشتری جدید ساخته می‌شود. ' +
      'اگر همین ایمیل به‌صورت تأییدنشده روی حساب مشتری/فروشندهٔ دیگری باشد، از آن حساب برداشته می‌شود (در لاگ ممیزی ثبت می‌شود). ' +
      'ایمیلِ تأییدشده یا متعلق به کارکنان هرگز جابه‌جا نمی‌شود.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiBadRequestResponse({ description: 'EMAIL_OTP_SIGNUP_MOBILE_MISMATCH' })
  @ApiUnauthorizedResponse({ description: 'کد نادرست/منقضی یا EMAIL_OTP_SIGNUP_EXPIRED' })
  @ApiForbiddenResponse({ description: 'EMAIL_OTP_STAFF_NOT_ALLOWED یا حساب غیرفعال' })
  @ApiConflictResponse({ description: 'EMAIL_OTP_EMAIL_TAKEN / EMAIL_OTP_MOBILE_HAS_OTHER_EMAIL / EMAIL_OTP_CONFLICT' })
  verifySignup(@Headers(EMAIL_SIGNUP_TICKET_HEADER) ticket: string | undefined, @Body() dto: VerifyOtpDto, @ClientContext() context: RequestContext): Promise<AuthTokensResponseDto> {
    return this.emailOtp.verifySignup(ticket, dto.mobile, dto.code, context);
  }
}
