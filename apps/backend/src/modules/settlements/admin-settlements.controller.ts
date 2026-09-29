import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
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
import {
  AdminSettlementQueryDto,
  PaginatedSettlementRequestsDto,
  PayoutSettlementDto,
  ProcessSettlementDto,
  SettlementProcessResultDto,
} from './dto/settlement.dto';
import { SettlementsService } from './settlements.service';

const UUID = new ParseUUIDPipe({ version: '4' });

@ApiTags('admin-settlements')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Finance staff only' })
@Controller('admin/settlements')
export class AdminSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @ApiOperation({ summary: 'Settlement requests, newest first', description: 'Filter by status (REQUESTED / PROCESSING / PAID_PAYA / REJECTED) and store.' })
  @ApiOkResponse({ type: PaginatedSettlementRequestsDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  list(@Query() query: AdminSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    return this.settlements.listForStaff(query);
  }

  @Patch(':id/process')
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Approve (paid by PAYA) or reject a settlement request',
    description:
      'APPROVE needs payaReferenceNumber: the held amount leaves the wallet (SETTLEMENT_PAYOUT) and the request becomes PAID_PAYA. ' +
      'REJECT needs rejectionReason: the held amount returns to the withdrawable balance. Only REQUESTED requests can be processed.',
  })
  @ApiOkResponse({ type: SettlementProcessResultDto })
  @ApiBadRequestResponse({ description: 'Missing payaReferenceNumber / rejectionReason' })
  @ApiNotFoundResponse({ description: 'Unknown settlement request' })
  @ApiConflictResponse({ description: 'SETTLEMENT_ALREADY_PROCESSED or PAYA_REFERENCE_IN_USE' })
  process(
    @Param('id', UUID) id: string,
    @Body() dto: ProcessSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<SettlementProcessResultDto> {
    return this.settlements.process(id, dto, { actorId: user.id, context });
  }

  @Post(':id/payout')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.FINANCIAL_OFFICER, UserRole.SUPER_ADMIN)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({ summary: 'Record the PAYA payout of a settlement request', description: 'Shortcut for PATCH …/process with action=APPROVE.' })
  @ApiOkResponse({ type: SettlementProcessResultDto })
  @ApiBadRequestResponse({ description: 'Missing or invalid payaReferenceNumber' })
  @ApiNotFoundResponse({ description: 'Unknown settlement request' })
  @ApiConflictResponse({ description: 'SETTLEMENT_ALREADY_PROCESSED or PAYA_REFERENCE_IN_USE' })
  payout(
    @Param('id', UUID) id: string,
    @Body() dto: PayoutSettlementDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<SettlementProcessResultDto> {
    return this.settlements.process(id, { action: 'APPROVE', payaReferenceNumber: dto.payaReferenceNumber }, { actorId: user.id, context });
  }
}
