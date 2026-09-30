import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { UsersService } from './users.service';
import { UserQueryDto } from './dto/user-query.dto';
import { PaginatedUsersDto, UserIdentityDto } from './dto/user-response.dto';

/**
 * Staff-facing identity endpoints.
 *
 * Access model:
 * - `SUPER_ADMIN` and `ADMIN` may search the whole identity table;
 * - `SUPPORT` and `FINANCIAL_OFFICER` may look up a single user (they need it to
 *   answer tickets and to review credit files) but cannot enumerate users, which
 *   keeps bulk personal data out of reach of the lowest staff role.
 */
@ApiTags('admin-users')
@ApiBearerAuth('access-token')
@Controller('admin/users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'جستوجو در کاربران (فقط مدیران)',
    description:
      'صفحهبندیشده، با فیلتر نقش/وضعیت و جستوجو روی نام، ایمیل یا شماره موبایل. هرگز هش رمز را برنمیگرداند.',
  })
  @ApiOkResponse({ type: PaginatedUsersDto })
  async list(@Query() query: UserQueryDto): Promise<PaginatedUsersDto> {
    const { rows, total } = await this.users.search({
      ...(query.query !== undefined ? { query: query.query } : {}),
      ...(query.role !== undefined ? { role: query.role } : {}),
      ...(query.isActive !== undefined ? { isActive: query.isActive } : {}),
      page: query.page,
      pageSize: query.pageSize,
    });

    return {
      items: rows.map((user) => UserIdentityDto.from(user)),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  @Get(':id')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT, UserRole.FINANCIAL_OFFICER)
  @ApiOperation({ summary: 'دریافت یک کاربر با شناسه (کارکنان)' })
  @ApiOkResponse({ type: UserIdentityDto })
  @ApiNotFoundResponse({ description: 'کاربر یافت نشد' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string): Promise<UserIdentityDto> {
    const identity = await this.users.getIdentity(id);
    return UserIdentityDto.from(identity.user);
  }
}
