import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { Auditable, SkipAudit } from '../audit/audit.decorator';
import { setAuditSnapshot } from '../audit/audit-context';
import { BRANDING_SLOTS, isBrandingSlot } from '../media/branding-image';
import { MediaService } from '../media/media.service';
import type { MultipartRequest } from '../media/multipart-request';
import { readMultipartUpload } from '../media/multipart-upload';
import { BrandingService } from './branding.service';
import { AdminBrandingDto, BrandingAssetUploadResponseDto, UpdateBrandingDto } from './dto/branding.dto';

/**
 * Visual identity management for `SUPER_ADMIN` and `ADMIN`.
 *
 * PATCH is `@SkipAudit()`: the service writes the audit row (old and new
 * values) in the same transaction as the `system_configs` change.
 */
@ApiTags('admin-branding')
@ApiBearerAuth('access-token')
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only SUPER_ADMIN and ADMIN may manage branding' })
@Controller('admin/branding')
export class AdminBrandingController {
  constructor(
    private readonly branding: BrandingService,
    private readonly media: MediaService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'پیکربندی کامل هویت بصری با زمان آخرین تغییر هر کلید و تاریخچهٔ تغییرات' })
  @ApiOkResponse({ type: AdminBrandingDto })
  get(): Promise<AdminBrandingDto> {
    return this.branding.getAdmin();
  }

  @Patch()
  @SkipAudit()
  @ApiOperation({
    summary: 'به‌روزرسانی لوگو، فاوآیکن و بنرها',
    description:
      'فیلدهای ارسال‌نشده تغییر نمی‌کنند؛ null لوگو را حذف می‌کند (بازگشت به پیش‌فرض)؛ heroBanners کل فهرست را جایگزین می‌کند. ' +
      'هر آدرس تصویر باید پیش‌تر با POST /admin/branding/assets و slot متناظر بارگذاری شده باشد. پس از ثبت، کش عمومی پاک و AuditLog ثبت می‌شود.',
  })
  @ApiOkResponse({ type: AdminBrandingDto })
  @ApiBadRequestResponse({ description: 'BRANDING_ASSET_INVALID | BRANDING_INVALID_LINK | BRANDING_INVALID_BANNER | validation' })
  update(
    @Body() dto: UpdateBrandingDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminBrandingDto> {
    return this.branding.update(dto, { actorId: user.id, context });
  }

  @Post('assets')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['slot', 'file'],
      properties: {
        slot: { type: 'string', enum: [...BRANDING_SLOTS], description: 'باید پیش از file ارسال شود' },
        file: {
          type: 'string',
          format: 'binary',
          description: 'PNG، JPEG، WEBP (و GIF) — لوگو/فاوآیکن: SVG هم (حداکثر ۵۱۲ کیلوبایت، به WebP تبدیل می‌شود)',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'بارگذاری تصویر هویت بصری (لوگو، لوگوی موبایل، فاوآیکن، بنر)',
    description:
      'تصویر با Sharp به WebP بهینه تبدیل می‌شود: لوگو حداکثر ۸۰۰×۲۴۰، لوگوی موبایل ۵۱۲×۵۱۲، فاوآیکن مربع ۵۱۲ (+۶۴)، ' +
      'بنر حداکثر ۱۹۲۰×۱۰۸۰ با حداقل عرض ۸۰۰. SVG فقط برای لوگوها پذیرفته و rasterize می‌شود؛ هرگز به‌صورت SVG ذخیره نمی‌شود.',
  })
  @ApiCreatedResponse({ type: BrandingAssetUploadResponseDto })
  @ApiBadRequestResponse({ description: 'slot نامعتبر، نوع/اندازهٔ نامعتبر، تصویر خراب یا SVG ناامن' })
  @ApiPayloadTooLargeResponse({ description: 'حجم بدنه از سقف انتقال بیشتر است' })
  async upload(@Req() request: MultipartRequest, @CurrentUser() user: AuthenticatedUser): Promise<BrandingAssetUploadResponseDto> {
    const { file, fields } = await readMultipartUpload(request, ['slot']);
    const slot = fields['slot'];
    if (!isBrandingSlot(slot)) {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: 'BRANDING_INVALID_SLOT',
        message: `The "slot" field (sent before the file) must be one of: ${BRANDING_SLOTS.join(', ')}`,
      });
    }

    const result = await this.media.uploadBrandingImage(file, { ownerUserId: user.id, slot });
    setAuditSnapshot(request, {
      actorId: user.id,
      entityId: result.id,
      newValue: { slot, mimeType: result.mimeType, sizeBytes: result.sizeBytes, originalSizeBytes: result.originalSizeBytes, isPublic: true },
    });
    return {
      id: result.id,
      slot,
      url: result.url,
      thumbnailUrl: result.thumbnailUrl,
      mimeType: result.mimeType,
      width: result.width,
      height: result.height,
      sizeBytes: result.sizeBytes,
      originalSizeBytes: result.originalSizeBytes,
    };
  }
}
