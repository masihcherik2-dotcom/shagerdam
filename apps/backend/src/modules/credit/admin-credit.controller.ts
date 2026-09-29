import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { AdminCreditService } from './admin-credit.service';
import { AdminCreditAccountPageDto, AdminCreditAccountsQueryDto, AdminCreditApplicationPageDto, AdminCreditApplicationsQueryDto } from './dto/credit.dto';

@ApiTags('admin-credit')
@ApiBearerAuth('access-token')
@Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN, UserRole.ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Finance officers and administrators only' })
@Controller('admin/credit')
export class AdminCreditController {
  constructor(private readonly credit: AdminCreditService) {}

  @Get('applications')
  @ApiOperation({ summary: 'Credit applications, newest first', description: 'National codes are masked (last 4 digits).' })
  @ApiOkResponse({ type: AdminCreditApplicationPageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  applications(@Query() query: AdminCreditApplicationsQueryDto): Promise<AdminCreditApplicationPageDto> {
    return this.credit.applications(query);
  }

  @Get('accounts')
  @ApiOperation({
    summary: 'Credit accounts with the aggregated credit exposure',
    description:
      '`exposure` aggregates all accounts matching the filters: limits, outstanding principal (used), reservations, unpaid and ' +
      'overdue instalments, and `ledgerConsistent` — every account satisfies the invariant and equals the replay of its credit ledger.',
  })
  @ApiOkResponse({ type: AdminCreditAccountPageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  accounts(@Query() query: AdminCreditAccountsQueryDto): Promise<AdminCreditAccountPageDto> {
    return this.credit.accounts(query);
  }
}
