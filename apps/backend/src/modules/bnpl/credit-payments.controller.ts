import { Body, Controller, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
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
import { CreditCheckoutService } from './credit-checkout.service';
import { CreditPaymentInitiateResponseDto, InitiateCreditPaymentDto } from './dto/bnpl.dto';

@ApiTags('credit-payments')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@Controller('payments/credit')
export class CreditPaymentsController {
  constructor(private readonly checkout: CreditCheckoutService) {}

  @Post('initiate')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Pay a PENDING order with bank credit (BANK_CREDIT) or credit + card (HYBRID)',
    description:
      'BANK_CREDIT (available ≥ finalPayableAmount): credit is reserved and committed at once — the order becomes PAID, its packages ' +
      'PENDING_APPROVAL, stock is committed, each store’s earnings enter escrow and the instalment schedule of the plan is created. ' +
      'Returns `status: COMPLETED`. HYBRID (available < finalPayableAmount): all available credit (whole rials) is reserved and a Payment ' +
      'with creditAmount + cashAmount is INITIATED; returns `status: IPG_REQUIRED` with the bank page for cashAmount. When the card part ' +
      'is verified (`/payments/callback`) the credit is committed and the schedule created; if it fails, the gateway cannot open a session, ' +
      'or the order expires/is cancelled first, the reservation is released. Every balance change writes a credit ledger row.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreditPaymentInitiateResponseDto })
  @ApiBadRequestResponse({ description: 'Validation error or INSTALLMENT_PLAN_NOT_AVAILABLE' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiNotFoundResponse({ description: 'Order not found (or not yours)' })
  @ApiConflictResponse({
    description:
      'ORDER_NOT_PAYABLE, ORDER_PAYMENT_EXPIRED, CREDIT_ACCOUNT_REQUIRED, CREDIT_ACCOUNT_NOT_ACTIVE, CREDIT_ACCOUNT_EXPIRED, ' +
      'INSUFFICIENT_CREDIT, HYBRID_NOT_REQUIRED or AMOUNT_NOT_WHOLE_RIALS',
  })
  @ApiTooManyRequestsResponse({ description: 'Too many open payment attempts for this order' })
  @ApiBadGatewayResponse({ description: 'CREDIT_PROVIDER_UNAVAILABLE (reservation failed) or GATEWAY_UNAVAILABLE (HYBRID card session; credit released)' })
  @ApiServiceUnavailableResponse({ description: 'CREDIT_DISABLED or the active provider is unavailable / not implemented / misconfigured' })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiateCreditPaymentDto,
    @ClientContext() context: RequestContext,
  ): Promise<CreditPaymentInitiateResponseDto> {
    return this.checkout.initiate(user.id, dto, { actorId: user.id, context });
  }
}
