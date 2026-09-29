import { Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Auditable } from '../audit/audit.decorator';
import { setAuditSnapshot } from '../audit/audit-context';
import { RegisterVendorDto } from './dto/register-vendor.dto';
import { SubmitVerificationDocumentsDto } from './dto/verification-documents.dto';
import { UpdateVendorProfileDto } from './dto/update-vendor-profile.dto';
import { UpdateVendorProfileResponseDto, VendorProfileDto } from './dto/vendor-response.dto';
import { VENDOR_SELF_ROLES, VendorsService } from './vendors.service';

/**
 * Store-owner endpoints.
 *
 * `POST /vendors/register` is open to any authenticated account (the service
 * rejects staff roles with an explanation); the remaining routes are restricted to
 * `CUSTOMER` and `VENDOR`, because those are the only roles that can own a store.
 */
@ApiTags('vendors')
@Controller('vendors')
export class VendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Post('register')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ entityName: 'Vendor' })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'ثبت فروشگاه جدید',
    description:
      'فروشگاه با وضعیت PENDING ساخته می‌شود و در همان تراکنش کیف پول فروشنده با موجودی صفر ایجاد می‌گردد. ' +
      'نقش کاربر تا تأیید کارشناس، CUSTOMER می‌ماند؛ بنابراین فروشگاه تازه ثبت‌شده نمی‌تواند محصول منتشر کند. ' +
      'شماره شبا با رقم کنترل ISO 13616 و شناسهٔ فروشگاه با یکتایی سنجیده می‌شود.',
  })
  @ApiCreatedResponse({ type: VendorProfileDto, description: 'فروشگاه و کیف پول ایجاد شد' })
  @ApiBadRequestResponse({ description: 'ورودی نامعتبر (شبا، slug رزرو‌شده، متن کوتاه)' })
  @ApiConflictResponse({ description: 'نامک یکتا تکراری است یا این حساب پیش‌تر فروشگاه ساخته است' })
  @ApiForbiddenResponse({ description: 'حساب غیرفعال یا حساب کارکنان نمی‌تواند فروشگاه بسازد' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async register(
    @Body() dto: RegisterVendorDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<VendorProfileDto> {
    const profile = await this.vendors.register({
      userId: user.id,
      storeName: dto.storeName,
      storeSlug: dto.storeSlug,
      ...(dto.instagramHandle !== undefined ? { instagramHandle: dto.instagramHandle } : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
      bankIban: dto.bankIban,
      bankAccountHolder: dto.bankAccountHolder,
    });

    setAuditSnapshot(request, {
      entityId: profile.vendor.id,
      newValue: {
        storeName: profile.vendor.storeName,
        storeSlug: profile.vendor.storeSlug,
        status: profile.vendor.status,
        walletInitialized: profile.wallet !== null,
      },
    });

    return VendorProfileDto.from(profile);
  }

  @Get('me')
  @Roles(...VENDOR_SELF_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'پروفایل فروشگاه من',
    description:
      'پروفایل فروشگاه، وضعیت احراز هویت (و در صورت رد شدن، متن دلیل) و خلاصهٔ کیف پول را برمی‌گرداند. ' +
      'اگر این حساب فروشگاهی ندارد، ۴۰۴ با راهنمای ثبت فروشگاه پاسخ می‌گیرد.',
  })
  @ApiOkResponse({ type: VendorProfileDto })
  @ApiNotFoundResponse({ description: 'این حساب فروشگاه ندارد' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async me(@CurrentUser() user: AuthenticatedUser): Promise<VendorProfileDto> {
    return VendorProfileDto.from(await this.vendors.getMyProfile(user.id));
  }

  @Patch('me')
  @Auditable({ entityName: 'Vendor' })
  @Roles(...VENDOR_SELF_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'ویرایش پروفایل فروشگاه',
    description:
      'نام فروشگاه، معرفی، اینستاگرام و لوگو را ویرایش می‌کند (آدرس لوگو باید تصویری باشد که خود همین فروشگاه آپلود کرده است). ' +
      'تغییر شماره شبا فقط همراه با bankAccountProofUrl پذیرفته می‌شود و وضعیت فروشگاه را به PENDING برمی‌گرداند؛ ' +
      'این هشدار در فیلد warnings پاسخ داده می‌شود.',
  })
  @ApiOkResponse({ type: UpdateVendorProfileResponseDto })
  @ApiBadRequestResponse({ description: 'ورودی خالی/نامعتبر یا فایل مالکیت بانکی ارسال نشده' })
  @ApiForbiddenResponse({ description: 'فایل ارجاع‌شده به این فروشگاه تعلق ندارد' })
  @ApiNotFoundResponse({ description: 'این حساب فروشگاه ندارد' })
  async updateMe(
    @Body() dto: UpdateVendorProfileDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<UpdateVendorProfileResponseDto> {
    const current = await this.vendors.getMyProfile(user.id);

    const result = await this.vendors.updateMyProfile({
      userId: user.id,
      ...(dto.storeName !== undefined ? { storeName: dto.storeName } : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
      ...(dto.instagramHandle !== undefined ? { instagramHandle: dto.instagramHandle } : {}),
      ...(dto.logoUrl !== undefined ? { logoUrl: dto.logoUrl } : {}),
      ...(dto.bankIban !== undefined ? { bankIban: dto.bankIban } : {}),
      ...(dto.bankAccountProofUrl !== undefined ? { bankAccountProofUrl: dto.bankAccountProofUrl } : {}),
    });

    setAuditSnapshot(request, {
      entityId: result.profile.vendor.id,
      oldValue: {
        storeName: current.vendor.storeName,
        bio: current.vendor.bio,
        instagramHandle: current.vendor.instagramHandle,
        logoUrl: current.vendor.logoUrl,
        status: current.vendor.status,
        bankIban: current.vendor.bankIban,
      },
      newValue: {
        storeName: result.profile.vendor.storeName,
        bio: result.profile.vendor.bio,
        instagramHandle: result.profile.vendor.instagramHandle,
        logoUrl: result.profile.vendor.logoUrl,
        status: result.profile.vendor.status,
        bankIban: result.profile.vendor.bankIban,
        warnings: result.warnings,
      },
    });

    return UpdateVendorProfileResponseDto.from(result.profile, result.warnings);
  }

  @Post('verification/documents')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'VendorVerification' })
  @Roles(...VENDOR_SELF_ROLES)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'ارسال یا اصلاح مدارک احراز هویت',
    description:
      'کارت ملی اجباری است و مجوز کسب‌وکار و مدرک مالکیت حساب بانکی اختیاری‌اند. ' +
      'هر نشانی باید به مدرکی اشاره کند که با POST /media/upload/document توسط همین کاربر آپلود شده باشد ' +
      '(در غیر این صورت ۴۰۰/۴۰۳). ارسال مجدد، ارسالِ بررسی‌نشدهٔ قبلی را به‌روز می‌کند و ' +
      'برای فروشگاهی که رد شده بود، وضعیت را به PENDING برمی‌گرداند تا امکان اصلاح وجود داشته باشد.',
  })
  @ApiOkResponse({ type: VendorProfileDto, description: 'مدارک ثبت شد و در انتظار بررسی است' })
  @ApiBadRequestResponse({ description: 'نشانی مدرک نامعتبر است یا فایلی ارسال نشده' })
  @ApiForbiddenResponse({ description: 'مدرک به حساب دیگری تعلق دارد' })
  @ApiNotFoundResponse({ description: 'این حساب فروشگاه ندارد' })
  async submitDocuments(
    @Body() dto: SubmitVerificationDocumentsDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<VendorProfileDto> {
    const result = await this.vendors.submitVerificationDocuments({
      userId: user.id,
      nationalIdCardUrl: dto.nationalIdCardUrl,
      ...(dto.businessLicenseUrl !== undefined ? { businessLicenseUrl: dto.businessLicenseUrl } : {}),
      ...(dto.bankAccountProofUrl !== undefined ? { bankAccountProofUrl: dto.bankAccountProofUrl } : {}),
    });

    setAuditSnapshot(request, {
      entityId: result.profile.verification?.id ?? result.profile.vendor.id,
      newValue: {
        status: result.status,
        replacedPendingSubmission: result.replacedPendingSubmission,
        hasBusinessLicense: dto.businessLicenseUrl !== undefined,
        hasBankProof: dto.bankAccountProofUrl !== undefined,
      },
    });

    return VendorProfileDto.from(result.profile);
  }
}
