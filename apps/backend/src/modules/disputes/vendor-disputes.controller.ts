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
import { DisputeActionResultDto, VendorDisputeDto, VendorDisputePageDto, VendorDisputeQueryDto, VendorRespondDisputeDto } from './dto/dispute.dto';

@ApiTags('vendor-disputes')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Vendors with a store only' })
@Controller('vendor/disputes')
export class VendorDisputesController {
  constructor(
    private readonly disputes: DisputesService,
    private readonly queries: DisputeQueriesService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Disputes against my store', description: 'Newest first; includes the frozen amount of each dispute. Customer mobiles are masked.' })
  @ApiOkResponse({ type: VendorDisputePageDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or paging' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: VendorDisputeQueryDto): Promise<VendorDisputePageDto> {
    return this.queries.vendorList(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One dispute against my store', description: 'The complaint with the buyer’s evidence (downloadable by the store), timeline and hold.' })
  @ApiOkResponse({ type: VendorDisputeDto })
  @ApiNotFoundResponse({ description: 'Dispute not found (or against another store)' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', new ParseUUIDPipe({ version: '4' })) id: string): Promise<VendorDisputeDto> {
    return this.queries.vendorDetail(user.id, id);
  }

  @Post(':id/respond')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Answer a dispute',
    description:
      'Once, while the dispute is OPEN. ACCEPT_RETURN resolves it for the customer at once: package REFUNDED, the frozen earnings ' +
      'are deducted (REFUND_DEDUCTION), stock is restored for goods that never shipped or that came back (`itemReturned`), and the ' +
      'customer receives a refund notice. REJECT_WITH_DEFENSE records the defence and evidence and moves the dispute to UNDER_ARBITRATION.',
  })
  @ApiOkResponse({ type: DisputeActionResultDto })
  @ApiBadRequestResponse({ description: 'Validation error, or EVIDENCE_NOT_ACCEPTED' })
  @ApiNotFoundResponse({ description: 'Dispute not found (or against another store)' })
  @ApiConflictResponse({ description: 'DISPUTE_NOT_AWAITING_VENDOR, CREDIT_ORDER_REFUND_UNSUPPORTED or ESCROW_NOT_FROZEN' })
  respond(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: VendorRespondDisputeDto,
    @ClientContext() context: RequestContext,
  ): Promise<DisputeActionResultDto> {
    return this.disputes.respond(user, id, dto, { actorId: user.id, context });
  }
}
