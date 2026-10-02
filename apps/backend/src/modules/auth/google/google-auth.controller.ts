import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
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
import { OtpRequestResponseDto } from '../dto/auth-response.dto';
import { RequestOtpDto } from '../dto/request-otp.dto';
import { VerifyOtpDto } from '../dto/verify-otp.dto';
import {
  GOOGLE_SIGNUP_TICKET_HEADER,
  GoogleCallbackQueryDto,
  GoogleCallbackResponseDto,
  GoogleSignupStateDto,
  GoogleSignupVerifyResponseDto,
  GoogleStartQueryDto,
  GoogleStartResponseDto,
  GoogleStatusDto,
} from './dto/google-auth.dto';
import { GoogleAuthService, type GoogleCallbackResult } from './google-auth.service';

/**
 * Sign-in with Google. These endpoints are called server-to-server by the
 * storefront's session layer (`/api/session/google/*`), which keeps the state
 * in an httpOnly cookie, receives the tokens and writes the session cookies —
 * tokens never reach browser JavaScript. The storefront's public `/api/v1`
 * proxy blocks every route here except `status`.
 *
 * Audit: logins (and refusals) are written by the service itself, because the
 * callback is a GET.
 */
@ApiTags('auth')
@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly google: GoogleAuthService) {}

  @Public()
  @Get('status')
  @ApiOperation({ summary: 'وضعیت ورود با گوگل', description: 'وقتی GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET تنظیم نشده باشند enabled=false است و دکمهٔ گوگل نمایش داده نمی‌شود.' })
  @ApiOkResponse({ type: GoogleStatusDto })
  status(): GoogleStatusDto {
    return { enabled: this.google.enabled };
  }

  @Public()
  @Get()
  @ApiOperation({
    summary: 'شروع ورود با گوگل',
    description: 'state، PKCE verifier و nonce را ۱۰ دقیقه در Redis نگه می‌دارد و آدرس صفحهٔ ورود گوگل را برمی‌گرداند. سقف ۳۰ بار در ساعت برای هر IP.',
  })
  @ApiOkResponse({ type: GoogleStartResponseDto })
  @ApiServiceUnavailableResponse({ description: 'GOOGLE_NOT_CONFIGURED' })
  @ApiTooManyRequestsResponse({ description: 'سقف ساعتی شروع ورود از این IP' })
  start(@Query() query: GoogleStartQueryDto, @ClientContext() context: RequestContext): Promise<GoogleStartResponseDto> {
    return this.google.start(query.next, context);
  }

  @Public()
  @Get('callback')
  @ApiOperation({
    summary: 'بازگشت از گوگل',
    description:
      'state را مصرف می‌کند (یکبارمصرف)، کد را با verifier نزد گوگل مبادله و ID token را اعتبارسنجی می‌کند. ' +
      'اگر حساب گوگل قبلاً متصل باشد یا ایمیلِ تأییدشدهٔ گوگل متعلق به حسابی باشد → signed_in با توکن‌ها. ' +
      'در غیر این صورت mobile_required با بلیت ۱۵ دقیقه‌ای برای مرحلهٔ تأیید موبایل.',
  })
  @ApiOkResponse({ type: GoogleCallbackResponseDto })
  @ApiBadRequestResponse({ description: 'GOOGLE_STATE_INVALID' })
  @ApiUnauthorizedResponse({ description: 'GOOGLE_EXCHANGE_FAILED' })
  @ApiForbiddenResponse({ description: 'GOOGLE_STAFF_NOT_ALLOWED یا حساب غیرفعال' })
  @ApiConflictResponse({ description: 'GOOGLE_ACCOUNT_CONFLICT' })
  @ApiBadGatewayResponse({ description: 'GOOGLE_UNAVAILABLE' })
  callback(@Query() query: GoogleCallbackQueryDto, @ClientContext() context: RequestContext): Promise<GoogleCallbackResult> {
    return this.google.callback(query.code, query.state, context);
  }

  @Public()
  @Get('signup')
  @ApiHeader({ name: GOOGLE_SIGNUP_TICKET_HEADER, required: true })
  @ApiOperation({ summary: 'اطلاعات مرحلهٔ تأیید موبایل (نام، ایمیل و تصویر گوگل)' })
  @ApiOkResponse({ type: GoogleSignupStateDto })
  @ApiUnauthorizedResponse({ description: 'GOOGLE_SIGNUP_EXPIRED' })
  signup(@Headers(GOOGLE_SIGNUP_TICKET_HEADER) ticket: string | undefined): Promise<GoogleSignupStateDto> {
    return this.google.getSignup(ticket);
  }

  @Public()
  @Post('signup/otp')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiHeader({ name: GOOGLE_SIGNUP_TICKET_HEADER, required: true })
  @ApiOperation({ summary: 'ارسال کد تأیید به موبایل برای تکمیل ورود با گوگل', description: 'همان محدودیت‌های OTP ورود (۱۲۰ ثانیه، سقف ساعتی شماره و IP).' })
  @ApiOkResponse({ type: OtpRequestResponseDto })
  @ApiUnauthorizedResponse({ description: 'GOOGLE_SIGNUP_EXPIRED' })
  @ApiTooManyRequestsResponse({ description: 'cooldown، قفل یا سقف ساعتی' })
  requestOtp(
    @Headers(GOOGLE_SIGNUP_TICKET_HEADER) ticket: string | undefined,
    @Body() dto: RequestOtpDto,
    @ClientContext() context: RequestContext,
  ): Promise<OtpRequestResponseDto> {
    return this.google.requestSignupOtp(ticket, dto.mobile, context);
  }

  @Public()
  @Post('signup/verify')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiHeader({ name: GOOGLE_SIGNUP_TICKET_HEADER, required: true })
  @ApiOperation({
    summary: 'تأیید موبایل و تکمیل ورود با گوگل',
    description:
      'اگر حسابی با این موبایل وجود داشته باشد، حساب گوگل به همان حساب متصل می‌شود؛ وگرنه حساب مشتری با نام و ایمیل تأییدشدهٔ گوگل ساخته می‌شود. ' +
      'حساب‌های کارکنان پذیرفته نمی‌شوند.',
  })
  @ApiOkResponse({ type: GoogleSignupVerifyResponseDto })
  @ApiBadRequestResponse({ description: 'GOOGLE_SIGNUP_MOBILE_MISMATCH' })
  @ApiUnauthorizedResponse({ description: 'کد نادرست/منقضی یا GOOGLE_SIGNUP_EXPIRED' })
  @ApiForbiddenResponse({ description: 'GOOGLE_STAFF_NOT_ALLOWED یا حساب غیرفعال' })
  @ApiConflictResponse({ description: 'GOOGLE_MOBILE_LINKED_ELSEWHERE / GOOGLE_ACCOUNT_CONFLICT' })
  verify(
    @Headers(GOOGLE_SIGNUP_TICKET_HEADER) ticket: string | undefined,
    @Body() dto: VerifyOtpDto,
    @ClientContext() context: RequestContext,
  ): Promise<GoogleSignupVerifyResponseDto> {
    return this.google.verifySignup(ticket, dto.mobile, dto.code, context);
  }
}
