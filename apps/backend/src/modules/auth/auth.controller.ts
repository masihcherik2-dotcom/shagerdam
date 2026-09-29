import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuditAction } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Auditable, SkipAudit } from '../audit/audit.decorator';
import { setAuditSnapshot } from '../audit/audit-context';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext as RequestContextValue } from '../../common/types/request-context';
import { AuthService } from './auth.service';
import { RequestOtpDto } from './dto/request-otp.dto';
import { VerifyOtpDto } from './dto/verify-otp.dto';
import { PasswordLoginDto } from './dto/password-login.dto';
import { LogoutDto, RefreshTokenDto } from './dto/refresh-token.dto';
import { UpdateProfileDto } from '../users/dto/update-profile.dto';
import {
  AuthTokensResponseDto,
  LogoutResponseDto,
  MeResponseDto,
  OtpRequestResponseDto,
  ProfileUpdateResponseDto,
  SmsProviderInfoDto,
} from './dto/auth-response.dto';

/**
 * Public authentication surface plus the self-service identity endpoints.
 *
 * Every route below is reachable only through the global guards:
 * `@Public()` marks the four anonymous entry points, everything else requires a
 * valid access token. Mutating routes are audited by `AuditInterceptor`;
 * `@Auditable(...)` only tells it *which* action to record.
 */
@ApiTags('auth')
@ApiExtraModels(MeResponseDto, ProfileUpdateResponseDto, AuthTokensResponseDto)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('otp/request')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiOperation({
    summary: 'درخواست کد یکبارمصرف (OTP)',
    description:
      'شماره موبایل را نرمال میکند، محدودیت نرخ را بررسی میکند، کد ۵ رقمی امن تولید و از طریق Provider فعال پیامک ارسال میکند. ' +
      'محدودیتها: یک درخواست در هر ۱۲۰ ثانیه برای هر شماره، سقف ساعتی برای شماره و برای IP.',
  })
  @ApiOkResponse({ type: OtpRequestResponseDto, description: 'کد ارسال شد' })
  @ApiBadRequestResponse({ description: 'شماره موبایل نامعتبر است' })
  @ApiTooManyRequestsResponse({
    description: 'در بازهٔ انتظار (cooldown)، قفل موقت، یا عبور از سقف ساعتی',
  })
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @ClientContext() context: RequestContextValue,
  ): Promise<OtpRequestResponseDto> {
    return this.auth.requestOtp(dto, context);
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: AuditAction.LOGIN, entityName: 'User' })
  @ApiOperation({
    summary: 'تأیید کد یکبارمصرف و دریافت توکنها',
    description:
      'کد را بهصورت اتمیک بررسی میکند. در صورت درست بودن: کاربر ناشناس با نقش CUSTOMER و پروفایل خالی مشتری ساخته میشود و ' +
      'توکن دسترسی (۱۵ دقیقه) و توکن تازهسازی چرخشی (۷ روز) صادر میشود. پس از ۵ کد نادرست، شماره ۱۵ دقیقه قفل میشود.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'کد نادرست، منقضی یا پیشتر مصرفشده' })
  @ApiForbiddenResponse({ description: 'حساب غیرفعال شده است' })
  @ApiTooManyRequestsResponse({ description: 'تعداد تلاشهای نادرست از حد گذشته و شماره قفل شده است' })
  async verifyOtp(
    @Body() dto: VerifyOtpDto,
    @Req() request: unknown,
    @ClientContext() context: RequestContextValue,
  ): Promise<AuthTokensResponseDto> {
    const result = await this.auth.verifyOtp(dto, context);
    // Lets the audit interceptor attribute the LOGIN row to the account that was
    // just authenticated, since this route runs before any JWT exists.
    setAuditSnapshot(request, { actorId: result.user.id, entityId: result.user.id });
    return result;
  }

  @Public()
  @Post('login/password')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: AuditAction.LOGIN, entityName: 'User' })
  @ApiOperation({
    summary: 'ورود با رمز عبور (کارکنان و فروشندگان)',
    description:
      'شناسه میتواند ایمیل یا شماره موبایل باشد. رمز با Argon2id بررسی میشود. پس از ۵ تلاش ناموفق، شناسه ۱۵ دقیقه قفل میشود.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'شناسه یا رمز نادرست' })
  @ApiForbiddenResponse({ description: 'حساب غیرفعال شده است' })
  @ApiTooManyRequestsResponse({ description: 'شناسه به دلیل تلاشهای ناموفق قفل شده است' })
  async loginWithPassword(
    @Body() dto: PasswordLoginDto,
    @Req() request: unknown,
    @ClientContext() context: RequestContextValue,
  ): Promise<AuthTokensResponseDto> {
    const result = await this.auth.loginWithPassword(dto, context);
    setAuditSnapshot(request, { actorId: result.user.id, entityId: result.user.id });
    return result;
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @ApiOperation({
    summary: 'چرخش توکن تازهسازی',
    description:
      'توکن تازهسازی مصرف و با یک جفت تازه جایگزین میشود. توکنِ مصرفشده دیگر کار نمیکند؛ ' +
      'استفادهٔ مجدد از آن بهعنوان تلاش برای بازپخش شناسایی و کل نشست باطل میشود.',
  })
  @ApiOkResponse({ type: AuthTokensResponseDto })
  @ApiUnauthorizedResponse({ description: 'توکن تازهسازی نامعتبر، منقضی یا پیشتر چرخششده' })
  @ApiForbiddenResponse({ description: 'حساب غیرفعال شده است' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @ClientContext() context: RequestContextValue,
  ): Promise<AuthTokensResponseDto> {
    return this.auth.refresh(dto.refreshToken, context);
  }

  @Post('logout')
  @HttpCode(HttpStatus.OK)
  @Auditable({ action: AuditAction.LOGOUT, entityName: 'User' })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'خروج و ابطال نشست',
    description:
      'نشست جاری را در Redis باطل میکند؛ در صورت ارسال توکن تازهسازی، همان نشست نیز باطل میشود.',
  })
  @ApiOkResponse({ type: LogoutResponseDto })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: LogoutDto,
    @Req() request: unknown,
  ): Promise<LogoutResponseDto> {
    const result = await this.auth.logout(user, dto.refreshToken);
    setAuditSnapshot(request, { actorId: user.id, entityId: user.id, newValue: result });
    return result;
  }

  @Get('me')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'اطلاعات کاربر جاری',
    description: 'کاربر، پروفایل مشتری و در صورت وجود، پروفایل فروشندگی فعال را برمیگرداند.',
  })
  @ApiOkResponse({ type: MeResponseDto })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<MeResponseDto> {
    return this.auth.me(user);
  }

  @Patch('profile')
  @Auditable({ entityName: 'User' })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'ویرایش پروفایل شخصی',
    description:
      'نام، ایمیل، کد ملی (با اعتبارسنجی رقم کنترلی) و تاریخ تولد قابل تغییر است. ' +
      'شماره موبایل و نقش از این مسیر قابل تغییر نیستند. تغییرات در audit_logs با مقدار قبلی و جدید ثبت میشود.',
  })
  @ApiOkResponse({ type: ProfileUpdateResponseDto })
  @ApiBadRequestResponse({ description: 'کد ملی یا تاریخ تولد نامعتبر' })
  @ApiConflictResponse({ description: 'ایمیل یا کد ملی قبلاً ثبت شده است' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
    @Req() request: unknown,
  ): Promise<ProfileUpdateResponseDto> {
    const outcome = await this.auth.updateProfile(user, dto);
    setAuditSnapshot(request, outcome.audit);
    return outcome.response;
  }

  @Public()
  @Get('sms-provider')
  @SkipAudit()
  @ApiOperation({
    summary: 'اطلاع از Provider فعال پیامک',
    description:
      'برای شفافیت محیط: نشان میدهد پیامک واقعی ارسال میشود یا Provider آزمایشی توسعه فعال است. ' +
      'در Production مقدار isTestProvider همیشه false است.',
  })
  @ApiOkResponse({ type: SmsProviderInfoDto })
  smsProvider(): SmsProviderInfoDto {
    return this.auth.smsProviderInfo();
  }
}
