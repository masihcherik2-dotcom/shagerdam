import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { FinancialOverviewDto, FinancialOverviewQueryDto } from './dto/financial.dto';
import { FinancialService } from './financial.service';

@ApiTags('admin-financial')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Finance staff and admins only' })
@Controller('admin/financial')
export class AdminFinancialController {
  constructor(private readonly financial: FinancialService) {}

  @Get('overview')
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({
    summary: 'Platform financial overview',
    description:
      'GMV, shipping, cash collected, commission (earned on delivery vs pending), wallet totals (escrow held, withdrawable, ' +
      'held for settlement, paid out) with a live ledger reconciliation check, and settlement figures. Optional from/to window ' +
      'applies to sales (order paidAt), captured payments (paidAt) and paid settlements (processedAt); balances are current.',
  })
  @ApiOkResponse({ type: FinancialOverviewDto })
  @ApiBadRequestResponse({ description: 'Invalid window' })
  overview(@Query() query: FinancialOverviewQueryDto): Promise<FinancialOverviewDto> {
    return this.financial.overview(query);
  }
}
