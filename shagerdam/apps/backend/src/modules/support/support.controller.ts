import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser, OptionalUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import {
  AdminContactMessageDto,
  AdminContactMessagePageDto,
  ContactMessageQueryDto,
  ContactMessageReceiptDto,
  CreateContactMessageDto,
  UpdateContactMessageDto,
} from './dto/contact-message.dto';
import { CONTACT_MAX_PER_IP_PER_HOUR, CONTACT_MAX_PER_MOBILE_PER_HOUR } from './contact-rules';
import { SupportService } from './support.service';

@ApiTags('support')
@Controller('support')
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post('contact-messages')
  @Public()
  @SkipAudit()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'ارسال پیام از فرم تماس با پشتیبانی',
    description: `بدون ورود هم ممکن است (کاربر واردشده به پیام پیوند می‌خورد). سقف: ${CONTACT_MAX_PER_IP_PER_HOUR} پیام در ساعت برای هر IP و ${CONTACT_MAX_PER_MOBILE_PER_HOUR} پیام برای هر موبایل.`,
  })
  @ApiCreatedResponse({ type: ContactMessageReceiptDto })
  @ApiBadRequestResponse({ description: 'validation | CONTACT_INVALID_FIELD | CONTACT_REJECTED' })
  @ApiTooManyRequestsResponse({ description: 'rate limit (retryAfterSeconds)' })
  submit(@Body() dto: CreateContactMessageDto, @OptionalUser() user: AuthenticatedUser | undefined, @ClientContext() context: RequestContext): Promise<ContactMessageReceiptDto> {
    return this.support.submit(dto, { userId: user?.id ?? null, context });
  }
}

@ApiTags('admin-support')
@ApiBearerAuth('access-token')
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only SUPER_ADMIN, ADMIN and SUPPORT may read contact messages' })
@Controller('admin/support/contact-messages')
export class AdminSupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @ApiOperation({ summary: 'صف پیام‌های فرم تماس (جدیدترین اول) با شمارش هر وضعیت' })
  @ApiOkResponse({ type: AdminContactMessagePageDto })
  list(@Query() query: ContactMessageQueryDto): Promise<AdminContactMessagePageDto> {
    return this.support.list(query);
  }

  @Patch(':id')
  @SkipAudit()
  @ApiOperation({ summary: 'تغییر وضعیت یا یادداشت پشتیبانی یک پیام (AuditLog در همان تراکنش)' })
  @ApiOkResponse({ type: AdminContactMessageDto })
  @ApiNotFoundResponse({ description: 'CONTACT_MESSAGE_NOT_FOUND' })
  update(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() dto: UpdateContactMessageDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminContactMessageDto> {
    return this.support.update(id, dto, { actorId: user.id, context });
  }
}
