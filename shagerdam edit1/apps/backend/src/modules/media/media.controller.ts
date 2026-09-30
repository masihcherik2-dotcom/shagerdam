import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { MediaKind, UserRole } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { Auditable, SkipAudit } from '../audit/audit.decorator';
import { setAuditSnapshot } from '../audit/audit-context';
import { AuditAction } from '@prisma/client';
import { MediaService } from './media.service';
import {
  DocumentUploadResponseDto,
  ImageUploadResponseDto,
  MediaAssetDto,
  StorageProviderInfoDto,
  toMediaAssetDto,
} from './dto/media-response.dto';
import type { MultipartRequest } from './multipart-request';
import { readMultipartUpload } from './multipart-upload';

/** Purposes a client may declare, and whether the resulting asset is public. */
const IMAGE_PURPOSES = new Map<string, boolean>([
  ['avatar', true],
  ['store_logo', true],
  ['store_banner', true],
  ['product_image', true],
  ['kyc_document', false],
]);

const DOCUMENT_PURPOSES = new Set([
  'kyc_national_id',
  'kyc_business_license',
  'kyc_bank_proof',
  /** Proof attached to a dispute (Phase 9): private; readable by the dispute's buyer, vendor and staff. */
  'dispute_evidence',
  'other',
]);

/**
 * Media endpoints.
 *
 * Read routes are `@Public()` **only** for objects the platform has explicitly
 * marked public (store logos, product images): the row in `media_assets` is the
 * authority, not the URL, so guessing a path never reveals a KYC scan. Private
 * objects are served through an authenticated endpoint that checks ownership or
 * a staff role.
 */
@ApiTags('media')
@Controller('media')
export class MediaController {
  constructor(private readonly media: MediaService) {}

  @Post('upload/image')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'PNG, JPEG، GIF یا WEBP — حداکثر ۵ مگابایت' },
        purpose: {
          type: 'string',
          enum: [...IMAGE_PURPOSES.keys()],
          default: 'product_image',
          description: 'کاربرد فایل؛ تعیین می‌کند تصویر عمومی باشد یا خصوصی',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'آپلود تصویر با پردازش خودکار',
    description:
      'نوع واقعی فایل با امضای بایتی (magic bytes) تشخیص داده می‌شود، سپس Sharp آن را می‌چرخاند (اصلاح جهت EXIF)، ' +
      'به WebP تبدیل و به حداکثر ۱۶۰۰ پیکسل محدود می‌کند و یک بندانگشتی ۳۰۰×۳۰۰ می‌سازد. ' +
      'فایل‌های غیرتصویری یا خراب و فایل‌های بزرگ‌تر از سقف، با ۴۰۰ رد می‌شوند.',
  })
  @ApiOkResponse({ type: ImageUploadResponseDto, description: 'تصویر پردازش و ذخیره شد' })
  @ApiBadRequestResponse({ description: 'فایل خالی، نوع پشتیبانی‌نشده، تصویر خراب یا بیش از حد بزرگ' })
  @ApiPayloadTooLargeResponse({ description: 'حجم بدنه درخواست از سقف انتقال بیشتر است' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async uploadImage(
    @Req() request: MultipartRequest,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ImageUploadResponseDto> {
    const { file, fields } = await readMultipartUpload(request);
    const purpose = fields['purpose'] ?? 'product_image';
    const isPublic = IMAGE_PURPOSES.get(purpose);

    if (isPublic === undefined) {
      throw new BadRequestException(
        `Unsupported purpose "${purpose}". Allowed: ${[...IMAGE_PURPOSES.keys()].join(', ')}`,
      );
    }

    const result = await this.media.uploadImage(file, { ownerUserId: user.id, purpose, isPublic });

    setAuditSnapshot(request, {
      actorId: user.id,
      entityId: result.id,
      newValue: {
        purpose,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        originalSizeBytes: result.originalSizeBytes,
        isPublic,
      },
    });
    return result;
  }

  @Post('upload/document')
  @HttpCode(HttpStatus.CREATED)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiBearerAuth('access-token')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'PDF، PNG یا JPEG — حداکثر ۱۰ مگابایت' },
        purpose: {
          type: 'string',
          enum: [...DOCUMENT_PURPOSES],
          default: 'kyc_national_id',
          description: 'نوع مدرک برای پیگیری در فرایند احراز هویت',
        },
      },
    },
  })
  @ApiOperation({
    summary: 'آپلود مدرک (KYC)',
    description:
      'مدارک PDF/PNG/JPEG را بدون تغییر ذخیره می‌کند (بازکدگذاری، ارزش اثباتی مدرک را از بین می‌برد). ' +
      'همهٔ مدارک خصوصی هستند و فقط مالک یا کارکنان مجاز می‌توانند آن‌ها را دانلود کنند.',
  })
  @ApiOkResponse({ type: DocumentUploadResponseDto })
  @ApiBadRequestResponse({ description: 'نوع نامعتبر، فایل خراب یا بزرگ‌تر از سقف' })
  @ApiUnauthorizedResponse({ description: 'توکن دسترسی نامعتبر یا منقضی' })
  async uploadDocument(
    @Req() request: MultipartRequest,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<DocumentUploadResponseDto> {
    const { file, fields } = await readMultipartUpload(request);
    const purpose = fields['purpose'] ?? 'kyc_national_id';

    if (!DOCUMENT_PURPOSES.has(purpose)) {
      throw new BadRequestException(
        `Unsupported purpose "${purpose}". Allowed: ${[...DOCUMENT_PURPOSES].join(', ')}`,
      );
    }

    const result = await this.media.uploadDocument(file, { ownerUserId: user.id, purpose });

    setAuditSnapshot(request, {
      actorId: user.id,
      entityId: result.id,
      newValue: { purpose, mimeType: result.mimeType, sizeBytes: result.sizeBytes, isPublic: false },
    });
    return result;
  }

  @Get('storage-provider')
  @Public()
  @SkipAudit()
  @ApiOperation({
    summary: 'اطلاع از Provider فعال ذخیره‌سازی',
    description: 'مشخص می‌کند فایل‌ها روی دیسک همین سرور ذخیره می‌شوند یا در Object Storage، و سقف‌های حجم را اعلام می‌کند.',
  })
  @ApiOkResponse({ type: StorageProviderInfoDto })
  storageProvider(): StorageProviderInfoDto {
    const info = this.media.storageProviderInfo();
    const limits = this.media.limits;
    return {
      provider: info.provider,
      isLocal: info.isLocal,
      maxImageBytes: limits.imageBytes,
      maxDocumentBytes: limits.documentBytes,
    };
  }

  @Get('assets/:id')
  @ApiBearerAuth('access-token')
  @SkipAudit()
  @ApiOperation({
    summary: 'اطلاعات یک فایل ذخیره‌شده',
    description: 'فایل عمومی برای همه؛ فایل خصوصی فقط برای مالک یا کارکنان.',
  })
  @ApiOkResponse({ type: MediaAssetDto, description: 'فرادادهٔ فایل' })
  @ApiForbiddenResponse({ description: 'این فایل خصوصی است و به شما تعلق ندارد' })
  @ApiNotFoundResponse({ description: 'فایل یافت نشد' })
  async asset(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<MediaAssetDto> {
    const asset = await this.media.findAsset(id);
    if (asset === null) {
      throw new NotFoundException('Media asset not found');
    }
    if (!asset.isPublic && !(await this.media.canAccessPrivateAsset({ asset, user }))) {
      throw new ForbiddenException('This asset is private');
    }
    return toMediaAssetDto(asset);
  }

  /**
   * Anonymous file route for public objects (store logos, product images).
   *
   * It is `@Public()` because the files are meant to be embedded in a storefront,
   * but it still consults the database: only rows with `is_public = true` are
   * served, so a leaked or guessed object key yields `404` rather than content.
   */
  @Get('files/*')
  @Public()
  @SkipAudit()
  @ApiOperation({
    summary: 'دریافت فایل عمومی',
    description:
      'فقط فایل‌هایی که در پایگاه داده عمومی علامت خورده‌اند سرو می‌شوند. مسیر با قواعد سخت‌گیرانه اعتبارسنجی می‌شود ' +
      'و هر تلاش برای خروج از پوشهٔ آپلود با ۴۰۰/۴۰۴ پاسخ می‌گیرد.',
  })
  @ApiOkResponse({ description: 'محتوای فایل' })
  @ApiNotFoundResponse({ description: 'فایل عمومی با این مسیر وجود ندارد' })
  async publicFile(@Req() request: { params: Record<string, string> }, @Res() reply: FastifyReply): Promise<void> {
    // Fastify's unnamed wildcard (`files/*`) arrives as the `*` parameter. The
    // value is never used to build a filesystem path directly: it is looked up in
    // `media_assets`, and only a row marked public resolves to a file.
    const path = request.params['*'];
    if (path === undefined || path.length === 0) {
      throw new BadRequestException('A file path is required');
    }

    const found = await this.media.findPublicAssetByPath(path);
    if (found === null) {
      throw new NotFoundException('File not found');
    }

    await this.media.streamAsset(found.asset, reply, found.storagePath);
  }

  @Get('documents/:id/download')
  @Roles(
    UserRole.CUSTOMER,
    UserRole.VENDOR,
    UserRole.SUPPORT,
    UserRole.FINANCIAL_OFFICER,
    UserRole.ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @Auditable({ action: AuditAction.STATUS_CHANGE, entityName: 'MediaAsset', entityIdParam: 'id' })
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'دانلود مدرک خصوصی',
    description:
      'مدارک KYC هرگز آدرس عمومی ندارند؛ این مسیر پس از بررسی مالکیت یا نقش کارکنان، فایل را با اعتبارنامه‌های سرور می‌خواند و جریان می‌دهد. ' +
      'هر دانلود در audit_logs ثبت می‌شود.',
  })
  @ApiOkResponse({ description: 'محتوای مدرک' })
  @ApiForbiddenResponse({ description: 'این مدرک به شما تعلق ندارد' })
  @ApiNotFoundResponse({ description: 'مدرک یافت نشد' })
  async downloadDocument(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const asset = await this.media.findAsset(id);
    if (asset === null) {
      throw new NotFoundException('Document not found');
    }
    if (asset.kind !== MediaKind.DOCUMENT) {
      throw new BadRequestException('This asset is not a document');
    }
    if (!(await this.media.canAccessPrivateAsset({ asset, user }))) {
      throw new ForbiddenException('This document belongs to another account');
    }

    reply.header('content-disposition', `attachment; filename="${asset.originalName ?? 'document'}"`);
    await this.media.streamAsset(asset, reply);
  }
}

/**
 * Reads the single file out of a multipart request.
 *
 * Validation lives here rather than in a pipe because the decision needs the file
 * bytes and the declared field name together. A request without a file, or with
 * the file under the wrong field name, is a client error with a message that says
 * exactly what is missing.
 */
