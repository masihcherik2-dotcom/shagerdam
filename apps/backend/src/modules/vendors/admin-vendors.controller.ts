import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
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
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { AdminCreateVendorDto } from './dto/admin-create-vendor.dto';
import { VerifyVendorDto } from './dto/verify-vendor.dto';
import { VendorQueryDto } from './dto/vendor-query.dto';
import {
  AdminCreateVendorResponseDto,
  PaginatedVendorsDto,
  VendorAdminDetailDto,
  VendorAdminSummaryDto,
  VendorProfileDto,
  VerifyVendorResponseDto,
} from './dto/vendor-response.dto';
import { VendorsService } from './vendors.service';

/**
 * Admin-facing vendor management.
 *
 * Role split:
 * - `SUPER_ADMIN`, `ADMIN` and `SUPPORT` may list and inspect stores — support
 *   needs the context to answer a vendor's ticket, and reading is not the same as
 *   deciding;
 * - only `SUPER_ADMIN` and `ADMIN` may publish a verification decision, because
 *   approval grants the vendor role and creates the account that will receive money.
 */
@ApiTags('admin-vendors')
@ApiBearerAuth('access-token')
@Controller('admin/vendors')
export class AdminVendorsController {
  constructor(private readonly vendors: VendorsService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({
    summary: 'فهرست فروشگاه‌ها (کارکنان)',
    description:
      'صفحه‌بندی‌شده با فیلتر وضعیت و جست‌وجو روی نام فروشگاه یا شناسه (slug). ' +
      'خلاصهٔ کیف پول و تعداد محصولات هر فروشگاه نیز بازگردانده می‌شود.',
  })
  @ApiOkResponse({ type: PaginatedVendorsDto })
  @ApiForbiddenResponse({ description: 'نقش کاربر اجازهٔ مشاهدهٔ فهرست فروشگاه‌ها را ندارد' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async list(@Query() query: VendorQueryDto): Promise<PaginatedVendorsDto> {
    const { rows, total } = await this.vendors.listForAdmin({
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.search !== undefined ? { search: query.search } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: rows.map((row) => VendorAdminSummaryDto.from(row)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  /**
   * `@SkipAudit()`: the service writes the audit row inside the creation
   * transaction (store, owner, wallet and audit commit together).
   */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  @SkipAudit()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'ایجاد فروشگاه توسط مدیر (تأییدشده)',
    description:
      'حساب مالک با شمارهٔ موبایل پیدا یا ساخته می‌شود و نقش VENDOR می‌گیرد؛ فروشگاه، کیف پول و ردیف audit در یک تراکنش ثبت می‌شوند. ' +
      'فروشگاه بلافاصله APPROVED است و مسئولیت احراز هویت با مدیر ایجادکننده است (kycBy=ADMIN_CREATED). ' +
      'فروشنده با همان موبایل و کد یک‌بارمصرف از /login وارد می‌شود.',
  })
  @ApiCreatedResponse({ type: AdminCreateVendorResponseDto })
  @ApiBadRequestResponse({ description: 'ورودی نامعتبر (شبا، موبایل، شناسه) یا شناسهٔ رزروشده' })
  @ApiConflictResponse({ description: 'شناسه تکراری، موبایل متعلق به کارکنان/فروشگاه دیگر یا حساب غیرفعال' })
  @ApiForbiddenResponse({ description: 'فقط SUPER_ADMIN و ADMIN' })
  async create(
    @Body() dto: AdminCreateVendorDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminCreateVendorResponseDto> {
    const result = await this.vendors.createByAdmin({
      actorId: user.id,
      context,
      storeName: dto.storeName,
      storeSlug: dto.storeSlug,
      ownerMobile: dto.ownerMobile,
      ownerFullName: dto.ownerFullName,
      bankIban: dto.bankIban,
      ...(dto.bankAccountHolder !== undefined ? { bankAccountHolder: dto.bankAccountHolder } : {}),
      commissionRateOverride: dto.commissionRateOverride ?? null,
      ...(dto.instagramHandle !== undefined ? { instagramHandle: dto.instagramHandle } : {}),
      ...(dto.bio !== undefined ? { bio: dto.bio } : {}),
    });
    return { profile: VendorProfileDto.from(result.profile), ownerCreated: result.ownerCreated, auditLogId: result.auditLogId };
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({
    summary: 'جزئیات کامل یک فروشگاه (کارکنان)',
    description:
      'شامل اطلاعات مالک، شماره شبا، تاریخچهٔ مدارک احراز هویت با نام بررسی‌کننده، ' +
      'فایل‌های آپلودشده و ۵۰ رویداد آخر audit مرتبط با فروشگاه و مدارکش.',
  })
  @ApiOkResponse({ type: VendorAdminDetailDto })
  @ApiForbiddenResponse({ description: 'نقش کاربر اجازهٔ مشاهدهٔ این فروشگاه را ندارد' })
  @ApiNotFoundResponse({ description: 'فروشگاه یافت نشد' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<VendorAdminDetailDto> {
    return VendorAdminDetailDto.detail(await this.vendors.getForAdmin(id));
  }

  /**
   * The verification decision.
   *
   * `@SkipAudit()` is deliberate: the audit row for this action is written *inside*
   * the decision transaction by `VendorsService.verifyVendor` (vendor status,
   * reviewer stamp, wallet, role and audit row commit or roll back together). The
   * interceptor would produce a second, weaker row for the same event.
   */
  @Post(':id/verify')
  @HttpCode(HttpStatus.OK)
  @SkipAudit()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'تأیید یا رد فروشگاه (مدیران)',
    description:
      'کل تصمیم در یک تراکنش انجام می‌شود: (۱) وضعیت فروشگاه، (۲) ثبت بررسی‌کننده و زمان روی مدارک، ' +
      '(۳) در صورت تأیید، اطمینان از وجود کیف پول فروشنده و ارتقای نقش کاربر به VENDOR، (۴) ثبت ردیف audit. ' +
      'اگر هر مرحله شکست بخورد، هیچ بخشی از تغییرات ذخیره نمی‌شود. متن دلیل رد برای فروشنده قابل مشاهده است.',
  })
  @ApiOkResponse({ type: VerifyVendorResponseDto })
  @ApiBadRequestResponse({ description: 'دلیل رد نامعتبر است یا هنگام تأیید ارسال شده' })
  @ApiConflictResponse({ description: 'مدرکی برای بررسی وجود ندارد یا آخرین ارسال پیش‌تر بررسی شده است' })
  @ApiForbiddenResponse({ description: 'فقط SUPER_ADMIN و ADMIN می‌توانند تصمیم بگیرند' })
  @ApiNotFoundResponse({ description: 'فروشگاه یافت نشد' })
  async verify(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: VerifyVendorDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<VerifyVendorResponseDto> {
    const result = await this.vendors.verifyVendor({
      vendorId: id,
      reviewerId: user.id,
      status: dto.status,
      rejectionReason: dto.rejectionReason ?? null,
      commissionRateOverride: dto.commissionRateOverride ?? null,
      context,
    });

    return VerifyVendorResponseDto.from(result);
  }
}
