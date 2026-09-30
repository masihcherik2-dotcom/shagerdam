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
import { AdminOrderQueryDto, ForceSubOrderStatusDto } from './dto/order-input.dto';
import { AdminSubOrderTransitionDto, PaginatedAdminOrdersDto } from './dto/order-response.dto';
import { OrderLifecycleService } from './order-lifecycle.service';
import { OrderQueriesService } from './order-queries.service';

@ApiTags('admin-orders')
@ApiBearerAuth('access-token')
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Staff only' })
@Controller('admin')
export class AdminOrdersController {
  constructor(
    private readonly queries: OrderQueriesService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get('orders')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN, UserRole.SUPPORT)
  @ApiOperation({
    summary: 'All orders with global filters',
    description: 'Filter by payment status, package status, store, customer, number/mobile search and creation window.',
  })
  @ApiOkResponse({ type: PaginatedAdminOrdersDto })
  list(@Query() query: AdminOrderQueryDto): Promise<PaginatedAdminOrdersDto> {
    return this.queries.listForStaff(query);
  }

  @Patch('sub-orders/:id/force-status')
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN)
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Force a package to DELIVERED or REFUNDED (paid orders only)',
    description:
      'DELIVERED from PROCESSING or SHIPPED (e.g. carrier confirmation). REFUNDED from any non-refunded status; ' +
      'if the goods never shipped (PENDING_APPROVAL / PROCESSING) the stock is returned to inventory. ' +
      'The money movement of the refund is handled by the finance module, not here.',
  })
  @ApiOkResponse({ type: AdminSubOrderTransitionDto })
  @ApiBadRequestResponse({ description: 'Validation failed (status or reason)' })
  @ApiNotFoundResponse({ description: 'Unknown sub-order' })
  @ApiConflictResponse({ description: 'ORDER_NOT_PAID, INVALID_STATUS_TRANSITION or CONCURRENT_UPDATE' })
  async forceStatus(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ForceSubOrderStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AdminSubOrderTransitionDto> {
    const result = await this.lifecycle.staffForce(id, dto, { actorId: user.id, context });
    return {
      previousStatus: result.previousStatus,
      stockAction: result.stockAction,
      walletAction: result.walletAction,
      auditLogId: result.auditLogId,
      subOrder: await this.queries.subOrderForStaff(id),
    };
  }
}
