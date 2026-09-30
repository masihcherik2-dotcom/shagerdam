import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
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
import { DisputeQueriesService } from './dispute-queries.service';
import { DisputesService } from './disputes.service';
import { AdminDisputeDossierDto, AdminDisputePageDto, AdminDisputeQueryDto, ArbitrateDisputeDto, DisputeActionResultDto } from './dto/dispute.dto';

@ApiTags('admin-disputes')
@ApiBearerAuth('access-token')
@Roles(UserRole.SUPPORT, UserRole.ADMIN, UserRole.SUPER_ADMIN)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Support staff and administrators only' })
@Controller('admin/disputes')
export class AdminDisputesController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly queries: DisputeQueriesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'All disputes', description: 'Filter by status, reason, store, customer and opening date; newest first.' })
  @ApiOkResponse({ type: AdminDisputePageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or paging' })
  list(@Query() query: AdminDisputeQueryDto): Promise<AdminDisputePageDto> {
    return this.queries.adminList(query);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Dispute dossier',
    description: 'Everything needed to decide: order and payments, items, package status history, complaint, defence, evidence of both parties, timeline, the hold and the store’s current wallet.',
  })
  @ApiOkResponse({ type: AdminDisputeDossierDto })
  @ApiNotFoundResponse({ description: 'Dispute not found' })
  dossier(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<AdminDisputeDossierDto> {
    return this.queries.dossier(id);
  }

  @Post(':id/arbitrate')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction (DISPUTE_RESOLUTION on the dispute and on the package)
  @ApiOperation({
    summary: 'Arbitrate a dispute',
    description:
      'Any running dispute (OPEN or UNDER_ARBITRATION). Atomic: wallet ledger, package status, dispute and audit rows commit together. ' +
      'BUYER_FAVOR → package REFUNDED, frozen earnings deducted (REFUND_DEDUCTION; a delivered-package shortfall is recovered from the ' +
      'current withdrawable balance, the rest reported as `hold.unrecovered`), stock restored when appropriate, refund notice SMS to the ' +
      'customer after commit. VENDOR_FAVOR → package DELIVERED, frozen earnings released to WITHDRAWABLE (DISPUTE_HOLD_RELEASE).',
  })
  @ApiOkResponse({ type: DisputeActionResultDto })
  @ApiBadRequestResponse({ description: 'Validation error' })
  @ApiNotFoundResponse({ description: 'Dispute not found' })
  @ApiConflictResponse({ description: 'DISPUTE_ALREADY_CLOSED, CREDIT_ORDER_REFUND_UNSUPPORTED, INVALID_STATUS_TRANSITION or ESCROW_NOT_FROZEN' })
  arbitrate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ArbitrateDisputeDto,
    @ClientContext() context: RequestContext,
  ): Promise<DisputeActionResultDto> {
    return this.disputes.arbitrate(user, id, dto, { actorId: user.id, context });
  }
}
