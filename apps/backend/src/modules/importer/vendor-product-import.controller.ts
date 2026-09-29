import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { setAuditSnapshot } from '../audit/audit-context';
import { Auditable } from '../audit/audit.decorator';
import {
  ExtractSpecDto,
  ExtractSpecResponseDto,
  IngestImagesDto,
  IngestImagesResponseDto,
} from './dto/import.dto';
import { ProductImporterService } from './product-importer.service';

/**
 * Product importer for vendors: read a product page into a draft, and pull its
 * images into the media pipeline. `VENDOR` role only, and the store must be
 * `APPROVED`.
 *
 * Both calls are audited with the source URL/hosts, so the origin of imported
 * text and images stays traceable (content-rights questions are answered from
 * the audit trail).
 */
@ApiTags('vendor-product-import')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Not a vendor, or the store is not APPROVED' })
@ApiTooManyRequestsResponse({ description: 'Per-vendor import quota exhausted (see retryAfterSeconds)' })
@Controller('vendor/products/import')
export class VendorProductImportController {
  constructor(private readonly importer: ProductImporterService) {}

  @Post('extract-spec')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({
    summary: 'Read a product page into a draft (title, brand, description, specifications, image URLs)',
    description:
      'Digikala product URLs are read through Digikala’s public product API (full specification table and gallery); ' +
      'any other URL is parsed for schema.org Product JSON-LD, product microdata, WooCommerce attribute tables and ' +
      'OpenGraph tags. SSRF-guarded: http/https on ports 80/443, private/loopback/link-local/reserved targets are ' +
      'refused (also after DNS resolution and on every redirect); 10 s timeout; nothing is persisted.',
  })
  @ApiOkResponse({ type: ExtractSpecResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid URL, or a private/internal/reserved target (code IMPORT_INVALID_URL / IMPORT_BLOCKED_TARGET)' })
  @ApiUnprocessableEntityResponse({ description: 'Not a product page, product not found, unsupported content or too large (code IMPORT_NOT_A_PRODUCT / IMPORT_NOT_FOUND / IMPORT_UNSUPPORTED_CONTENT / IMPORT_TOO_LARGE)' })
  @ApiBadGatewayResponse({ description: 'The source site failed (code IMPORT_NETWORK / IMPORT_UPSTREAM_STATUS / IMPORT_TOO_MANY_REDIRECTS)' })
  @ApiGatewayTimeoutResponse({ description: 'The source site did not answer within 10 seconds (code IMPORT_TIMEOUT)' })
  async extractSpec(
    @Body() dto: ExtractSpecDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<ExtractSpecResponseDto> {
    const draft = await this.importer.extract(user.id, dto.url);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: {
        url: dto.url,
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        strategies: draft.strategies,
        specificationCount: draft.specifications.length,
        imageCount: draft.imageUrls.length,
      },
    });
    return draft;
  }

  @Post('ingest-images')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiOperation({
    summary: 'Download remote images into the media pipeline (WebP + thumbnail) for a product gallery',
    description:
      'Each image is fetched (SSRF-guarded, 10 s, size-capped at the image upload limit) and processed exactly like ' +
      'POST /media/upload/image with purpose product_image. The returned ids go into mediaIds of POST /vendor/products. ' +
      'An invalid or internal URL rejects the whole request; a failing download is reported in failures while the others are stored.',
  })
  @ApiOkResponse({ type: IngestImagesResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or one of the URLs is invalid/private/internal' })
  async ingestImages(
    @Body() dto: IngestImagesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<IngestImagesResponseDto> {
    const result = await this.importer.ingestImages(user.id, dto.imageUrls);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: {
        purpose: 'product_image',
        imported: result.items.map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
        failed: result.failures.map((failure) => ({ sourceUrl: failure.sourceUrl, code: failure.code })),
      },
    });
    return result;
  }
}
