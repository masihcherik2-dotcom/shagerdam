import { Body, Controller, Get, Patch } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { AdminSiteInfoDto, UpdateSiteInfoDto } from './dto/site-info.dto';
import { SiteInfoService } from './site-info.service';

/** Business identity management for SUPER_ADMIN and ADMIN; the service writes the audit row in the same transaction. */
@ApiTags('admin-site-info')
@ApiBearerAuth('access-token')
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only SUPER_ADMIN and ADMIN may manage the business identity' })
@Controller('admin/site-info')
export class AdminSiteInfoController {
  constructor(private readonly siteInfo: SiteInfoService) {}

  @Get()
  @ApiOperation({ summary: 'مشخصات حقوقی، راه‌های تماس و نمادهای اعتماد با زمان آخرین تغییر و تاریخچه' })
  @ApiOkResponse({ type: AdminSiteInfoDto })
  get(): Promise<AdminSiteInfoDto> {
    return this.siteInfo.getAdmin();
  }

  @Patch()
  @SkipAudit()
  @ApiOperation({ summary: 'به‌روزرسانی مشخصات کسب‌وکار', description: 'فیلد ارسال‌نشده تغییر نمی‌کند؛ null یا رشتهٔ خالی آن را پاک می‌کند. ارقام فارسی پذیرفته و به لاتین تبدیل می‌شوند.' })
  @ApiOkResponse({ type: AdminSiteInfoDto })
  @ApiBadRequestResponse({ description: 'SITE_INFO_INVALID_FIELD | validation' })
  update(@Body() dto: UpdateSiteInfoDto, @CurrentUser() user: AuthenticatedUser, @ClientContext() context: RequestContext): Promise<AdminSiteInfoDto> {
    return this.siteInfo.update(dto, { actorId: user.id, context });
  }
}
