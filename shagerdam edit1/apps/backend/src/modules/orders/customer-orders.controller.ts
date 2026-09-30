import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import {
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
import { CancelOrderDto, CustomerOrderQueryDto } from './dto/order-input.dto';
import { CancelOrderResponseDto, CustomerDeliveryConfirmationDto, CustomerOrderDetailDto, PaginatedCustomerOrdersDto } from './dto/order-response.dto';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';

const UUID = new ParseUUIDPipe({ version: '4' });

@ApiTags('customer-orders')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Customers only' })
@Controller('customer/orders')
export class CustomerOrdersController {
  constructor(
    private readonly queries: OrderQueriesService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'My orders, newest first, with a per-store package breakdown' })
  @ApiOkResponse({ type: PaginatedCustomerOrdersDto })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: CustomerOrderQueryDto): Promise<PaginatedCustomerOrdersDto> {
    return this.queries.listForCustomer(user.id, query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Order detail: packages, items, tracking codes and timeline' })
  @ApiOkResponse({ type: CustomerOrderDetailDto })
  @ApiNotFoundResponse({ description: 'Unknown order or not the caller’s' })
  detail(@CurrentUser() user: AuthenticatedUser, @Param('id', UUID) id: string): Promise<CustomerOrderDetailDto> {
    return this.queries.detailForCustomer(user.id, id);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Cancel an unpaid order',
    description: 'Only while payment is PENDING. All packages become CANCELLED and the reserved stock is released. Paid orders are cancelled by the store or support.',
  })
  @ApiOkResponse({ type: CancelOrderResponseDto })
  @ApiNotFoundResponse({ description: 'Unknown order or not the caller’s' })
  @ApiConflictResponse({ description: 'ORDER_NOT_CANCELLABLE (already paid, cancelled or failed)' })
  async cancel(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UUID) id: string,
    @Body() dto: CancelOrderDto,
    @ClientContext() context: RequestContext,
  ): Promise<CancelOrderResponseDto> {
    const auditLogId = await this.lifecycle.cancelByCustomer(user.id, id, dto.reason, { actorId: user.id, context });
    return { ...(await this.queries.detailForCustomer(user.id, id)), auditLogId };
  }

  @Post(':id/sub-orders/:subOrderId/confirm-delivery')
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Confirm receipt of a shipped package',
    description:
      'Moves a SHIPPED package of a paid order to DELIVERED. In the same transaction the store’s earnings for the package are ' +
      'released from escrow to its withdrawable balance (once; repeated calls are rejected).',
  })
  @ApiOkResponse({ type: CustomerDeliveryConfirmationDto })
  @ApiNotFoundResponse({ description: 'Unknown order/package or not the caller’s' })
  @ApiConflictResponse({ description: 'INVALID_STATUS_TRANSITION (only SHIPPED packages can be confirmed)' })
  async confirmDelivery(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', UUID) id: string,
    @Param('subOrderId', UUID) subOrderId: string,
    @ClientContext() context: RequestContext,
  ): Promise<CustomerDeliveryConfirmationDto> {
    const result = await this.lifecycle.confirmDeliveryByCustomer(user.id, id, subOrderId, { actorId: user.id, context });
    return {
      previousStatus: result.previousStatus,
      stockAction: result.stockAction,
      walletAction: result.walletAction,
      auditLogId: result.auditLogId,
      order: await this.queries.detailForCustomer(user.id, id),
    };
  }
}
