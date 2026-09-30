import { Body, Controller, Get, HttpCode, HttpStatus, Post, Query, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { FastifyReply } from 'fastify';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import type { EnvironmentVariables } from '../../config/env.validation';
import { SkipAudit } from '../audit/audit.decorator';
import { InitiatePaymentDto, InitiatePaymentResponseDto, PaymentOutcomeDto } from './dto/payment.dto';
import { PaymentsService } from './payments.service';

const CALLBACK_DESCRIPTION =
  'Where the bank sends the customer’s browser after the payment page (Zarinpal: `Authority` + `Status=OK|NOK`). ' +
  'The redirect parameters are never trusted: the payment is verified server-to-server with the gateway for the stored amount. ' +
  'On success the order becomes PAID in one transaction (stock committed, each store’s earnings held in escrow, packages visible to ' +
  'vendors as PENDING_APPROVAL, Payment SUCCESSFUL with the bank RRN). On failure the Payment becomes FAILED and the order stays ' +
  'PENDING with its stock reserved, so the customer can retry until the payment window closes. Repeated callbacks return the same ' +
  'outcome without a second verification. Answers JSON, or a 303 redirect to PAYMENT_RESULT_REDIRECT_URL when that is configured ' +
  '(query: orderNumber, outcome, paymentId, parentOrderId and rrn when the bank returned one).';

@ApiTags('payments')
@Controller('payments')
export class PaymentsController {
  private readonly resultRedirectUrl: string | null;

  constructor(
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.resultRedirectUrl = config.get<string | undefined>('PAYMENT_RESULT_REDIRECT_URL') ?? null;
  }

  @Post('initiate')
  @HttpCode(HttpStatus.CREATED)
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth('access-token')
  @SkipAudit() // audited inside the transaction that creates the payment
  @ApiOperation({
    summary: 'Start paying an unpaid order',
    description:
      'Creates an INITIATED payment for the order’s payable amount and opens a session with the active gateway. ' +
      'Redirect the customer to `redirectUrl`. Allowed while the order is PENDING and inside its payment window; ' +
      'after a failed attempt a new one can be initiated.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: InitiatePaymentResponseDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiNotFoundResponse({ description: 'Unknown order or not the caller’s' })
  @ApiConflictResponse({ description: 'ORDER_NOT_PAYABLE (already paid, cancelled or failed) or ORDER_PAYMENT_EXPIRED' })
  @ApiTooManyRequestsResponse({ description: 'Too many open payment attempts for this order' })
  @ApiResponse({ status: HttpStatus.BAD_GATEWAY, description: 'GATEWAY_UNAVAILABLE: the gateway refused or could not be reached' })
  initiate(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: InitiatePaymentDto,
    @ClientContext() context: RequestContext,
  ): Promise<InitiatePaymentResponseDto> {
    return this.payments.initiate(user.id, dto.parentOrderId, { actorId: user.id, context });
  }

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Bank callback (GET)', description: CALLBACK_DESCRIPTION })
  @ApiQuery({ name: 'Authority', required: true, description: 'Gateway session token' })
  @ApiQuery({ name: 'Status', required: false, enum: ['OK', 'NOK'] })
  @ApiOkResponse({ type: PaymentOutcomeDto })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to PAYMENT_RESULT_REDIRECT_URL?orderNumber=…&outcome=…&paymentId=… (when configured)' })
  @ApiBadRequestResponse({ description: 'INVALID_CALLBACK: no payment token' })
  @ApiNotFoundResponse({ description: 'Unknown payment token' })
  async callbackGet(
    @Query() query: Record<string, unknown>,
    @ClientContext() context: RequestContext,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    await this.respond(reply, await this.payments.handleCallback(query, { actorId: null, context }));
  }

  @Post('callback')
  @Public()
  @HttpCode(HttpStatus.OK)
  @SkipAudit() // audited inside the settlement transaction
  @ApiOperation({ summary: 'Bank callback (POST, form or JSON body)', description: CALLBACK_DESCRIPTION })
  @ApiOkResponse({ type: PaymentOutcomeDto })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to PAYMENT_RESULT_REDIRECT_URL (when configured)' })
  @ApiBadRequestResponse({ description: 'INVALID_CALLBACK: no payment token' })
  @ApiNotFoundResponse({ description: 'Unknown payment token' })
  async callbackPost(
    @Query() query: Record<string, unknown>,
    @Body() body: Record<string, unknown> | undefined,
    @ClientContext() context: RequestContext,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const params = { ...query, ...(typeof body === 'object' && body !== null ? body : {}) };
    await this.respond(reply, await this.payments.handleCallback(params, { actorId: null, context }));
  }

  private async respond(reply: FastifyReply, outcome: PaymentOutcomeDto): Promise<void> {
    void reply.header('Cache-Control', 'no-store');
    if (this.resultRedirectUrl) {
      const separator = this.resultRedirectUrl.includes('?') ? '&' : '?';
      const query = buildResultRedirectQuery(outcome);
      await reply.status(HttpStatus.SEE_OTHER).header('Location', `${this.resultRedirectUrl}${separator}${query.toString()}`).send();
      return;
    }
    await reply.status(HttpStatus.OK).send(outcome);
  }
}

/**
 * Query string of the storefront result page. It carries only what the
 * customer already sees on the bank page (order number, outcome, payment id,
 * the bank's retrieval reference number) plus the order id for the "track my
 * order" link, and the purpose (checkout vs instalment repayment) — the result page re-reads the order itself before trusting it.
 */
export function buildResultRedirectQuery(outcome: PaymentOutcomeDto): URLSearchParams {
  const query = new URLSearchParams({
    orderNumber: outcome.orderNumber,
    outcome: outcome.outcome,
    paymentId: outcome.paymentId,
    parentOrderId: outcome.parentOrderId,
    purpose: outcome.purpose,
  });
  if (outcome.bankRrn !== null) {
    query.set('rrn', outcome.bankRrn);
  }
  return query;
}
