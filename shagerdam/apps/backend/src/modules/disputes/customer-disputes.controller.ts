import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { MAX_DISPUTES_PER_DAY } from './dispute-policy';
import { DisputeQueriesService } from './dispute-queries.service';
import { DisputesService } from './disputes.service';
import { CancelDisputeDto, CreateDisputeDto, CustomerDisputeQueryDto, DisputeActionResultDto, DisputeDto, DisputePageDto } from './dto/dispute.dto';

@ApiTags('customer-disputes')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Customers only' })
@Controller('customer/disputes')
export class CustomerDisputesController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly queries: DisputeQueriesService,
  ) {}

  @Post()
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Open a dispute about a package',
    description:
      'Only packages of your own PAID orders in PROCESSING, SHIPPED or DELIVERED; at most one active dispute per package, and a package whose ' +
      'dispute was already decided cannot be disputed again. In one transaction: the dispute (OPEN), its evidence and timeline are written ' +
      "and the package's vendor earnings are frozen in the store's DISPUTE_HOLD balance (from PENDING before delivery, from WITHDRAWABLE " +
      'after delivery — whatever the store already withdrew is recorded as `hold.shortfall`). While the dispute is active, delivery ' +
      `confirmation and status changes of the package are refused (409 SUB_ORDER_UNDER_DISPUTE). At most ${MAX_DISPUTES_PER_DAY} disputes per customer per 24 hours.`,
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: DisputeActionResultDto, description: 'Dispute opened; walletAction FROZEN (or NONE for zero earnings).' })
  @ApiBadRequestResponse({ description: 'Validation error, or EVIDENCE_NOT_ACCEPTED (not your own dispute_evidence upload)' })
  @ApiNotFoundResponse({ description: 'The package does not exist or is not yours' })
  @ApiConflictResponse({ description: 'ORDER_NOT_PAID, SUB_ORDER_NOT_DISPUTABLE, DISPUTE_ALREADY_ACTIVE, DISPUTE_ALREADY_DECIDED or ESCROW_NOT_FREEZABLE' })
  @ApiTooManyRequestsResponse({ description: 'Daily dispute quota exhausted' })
  open(@CurrentUser() user: AuthenticatedUser, @Body() dto: CreateDisputeDto, @ClientContext() context: RequestContext): Promise<DisputeActionResultDto> {
    return this.disputes.open(user, dto, { actorId: user.id, context });
  }

  @Get()
  @ApiOperation({ summary: 'My disputes', description: 'Newest first, each with its status, the store’s answer, the outcome and the full timeline.' })
  @ApiOkResponse({ type: DisputePageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or paging' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: CustomerDisputeQueryDto): Promise<DisputePageDto> {
    return this.queries.customerList(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One of my disputes', description: 'Complaint, evidence of both parties, the store’s response, the outcome (refund amount) and the timeline.' })
  @ApiOkResponse({ type: DisputeDto })
  @ApiNotFoundResponse({ description: 'Dispute not found (or not yours)' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<DisputeDto> {
    return this.queries.customerDetail(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Withdraw my dispute',
    description:
      'Allowed while the dispute is OPEN or UNDER_ARBITRATION. The frozen earnings go back to where they were frozen from ' +
      '(escrow PENDING before delivery → RETURNED_TO_ESCROW; WITHDRAWABLE for a delivered package → RELEASED_TO_WITHDRAWABLE); ' +
      'the package status does not change. A new dispute about the same package may be opened later.',
  })
  @ApiOkResponse({ type: DisputeActionResultDto })
  @ApiNotFoundResponse({ description: 'Dispute not found (or not yours)' })
  @ApiConflictResponse({ description: 'DISPUTE_NOT_CANCELLABLE (already decided or cancelled) or ESCROW_NOT_FROZEN' })
  cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelDisputeDto,
    @ClientContext() context: RequestContext,
  ): Promise<DisputeActionResultDto> {
    return this.disputes.cancel(user, id, dto, { actorId: user.id, context });
  }
}
