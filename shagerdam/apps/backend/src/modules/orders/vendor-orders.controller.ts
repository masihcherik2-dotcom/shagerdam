import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Query } from '@nestjs/common';
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
import { VendorOrderQueryDto, VendorUpdateSubOrderStatusDto } from './dto/order-input.dto';
import { PaginatedVendorSubOrdersDto, VendorSubOrderDetailDto, VendorSubOrderTransitionDto } from './dto/order-response.dto';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';

const UUID = new ParseUUIDPipe({ version: '4' });

@ApiTags('vendor-orders')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Not a vendor, or the store is neither APPROVED nor SUSPENDED' })
@Controller('vendor/orders')
export class VendorOrdersController {
  constructor(
    private readonly queries: OrderQueriesService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'My store’s packages (paid orders only), newest first',
    description: 'Only packages of PAID orders are listed: an unpaid order is not yet a commitment to ship.',
  })
  @ApiOkResponse({ type: PaginatedVendorSubOrdersDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: VendorOrderQueryDto): Promise<PaginatedVendorSubOrdersDto> {
    return this.queries.listForVendor(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Package detail with shipping address, items, commission and history' })
  @ApiOkResponse({ type: VendorSubOrderDetailDto })
  @ApiNotFoundResponse({ description: 'Unknown, unpaid or another store’s package' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', UUID) id: string): Promise<VendorSubOrderDetailDto> {
    return this.queries.detailForVendor(user.id, id);
  }

  @Patch(':id/status')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Move a package through fulfilment',
    description:
      'PENDING_APPROVAL → PROCESSING; PROCESSING → SHIPPED (trackingCode and shippingCarrier required); ' +
      'PENDING_APPROVAL or PROCESSING → CANCELLED (reason required; stock is returned to inventory and the package ' +
      'amount becomes due for refund to the customer).',
  })
  @ApiOkResponse({ type: VendorSubOrderTransitionDto })
  @ApiBadRequestResponse({ description: 'Validation failed (missing tracking code / carrier / reason)' })
  @ApiNotFoundResponse({ description: 'Unknown, unpaid or another store’s package' })
  @ApiConflictResponse({ description: 'INVALID_STATUS_TRANSITION (with allowedTransitions) or CONCURRENT_UPDATE' })
  async updateStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UUID) id: string,
    @Body() dto: VendorUpdateSubOrderStatusDto,
    @ClientContext() context: RequestContext,
  ): Promise<VendorSubOrderTransitionDto> {
    const result = await this.lifecycle.vendorTransition(user.id, id, dto, { actorId: user.id, context });
    return {
      previousStatus: result.previousStatus,
      stockAction: result.stockAction,
      walletAction: result.walletAction,
      auditLogId: result.auditLogId,
      subOrder: await this.queries.detailForVendor(user.id, id),
    };
  }
}
