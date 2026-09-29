import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
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
import { CheckoutService } from './checkout.service';
import { CheckoutDto } from './dto/order-input.dto';
import { CheckoutResponseDto } from './dto/order-response.dto';

@ApiTags('orders')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only customers can place orders' })
@Controller('orders')
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post('checkout')
  @SkipAudit() // audited inside the order transaction (without the address PII)
  @ApiOperation({
    summary: 'Place an order from the cart (one package per store)',
    description:
      'Re-validates every cart line against live stock and prices, then — in one database transaction — creates the parent order ' +
      '(payment PENDING, payment method CASH_IPG), one sub-order per store (PENDING_APPROVAL) with its shipping fee, platform ' +
      'commission and vendor earnings, immutable item snapshots, reserves stock and empties the cart.\n\n' +
      '409 codes: `CART_EMPTY`; `CART_NOT_CHECKOUTABLE` (with `lines`: unavailable items or quantity above stock); ' +
      '`CART_PRICES_CHANGED` (with `changes`: the cart has been updated to the current prices — show them and retry).\n\n' +
      'Unpaid orders are cancelled automatically after `paymentExpiresAt` and their stock is released.',
  })
  @ApiCreatedResponse({ type: CheckoutResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed' })
  @ApiNotFoundResponse({ description: 'Address not found (not one of the caller’s addresses)' })
  @ApiConflictResponse({ description: 'CART_EMPTY, CART_NOT_CHECKOUTABLE or CART_PRICES_CHANGED' })
  placeOrder(
    @Body() dto: CheckoutDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<CheckoutResponseDto> {
    return this.checkout.checkout(user.id, dto, { actorId: user.id, context });
  }
}
