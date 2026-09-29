import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { AuditLogQueryDto } from './dto/audit-log-query.dto';
import { PaginatedAuditLogsDto } from './dto/audit-log-response.dto';

/**
 * Read access to the audit trail.
 *
 * Restricted to `SUPER_ADMIN` and `ADMIN` — the trail contains personal data and
 * security events, so roles that answer tickets or review credit files are
 * deliberately excluded. Rows are immutable by design: the database has no update
 * or delete path for `audit_logs`, and neither does the API.
 */
@ApiTags('admin-audit')
@ApiBearerAuth('access-token')
@Controller('admin/audit-logs')
export class AuditController {
  constructor(private readonly auditLog: AuditLogService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'مشاهدهٔ لاگ حسابرسی (فقط مدیران)',
    description:
      'صفحهبندیشده، با فیلتر کنشگر، نام موجودیت، شناسه، نوع کنش و بازهٔ زمانی. مقادیر حساس (رمز، کد یکبارمصرف، توکن) هرگز ذخیره نمیشوند.',
  })
  @ApiOkResponse({ type: PaginatedAuditLogsDto })
  async list(@Query() query: AuditLogQueryDto): Promise<PaginatedAuditLogsDto> {
    const { rows, total } = await this.auditLog.list({
      ...(query.userId !== undefined ? { userId: query.userId } : {}),
      ...(query.entityName !== undefined ? { entityName: query.entityName } : {}),
      ...(query.entityId !== undefined ? { entityId: query.entityId } : {}),
      ...(query.action !== undefined ? { action: query.action } : {}),
      ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
      ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        action: row.action,
        entityName: row.entityName,
        entityId: row.entityId,
        ipAddress: row.ipAddress,
        userAgent: row.userAgent,
        oldValue: row.oldValue,
        newValue: row.newValue,
        createdAt: row.createdAt,
      })),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }
}
