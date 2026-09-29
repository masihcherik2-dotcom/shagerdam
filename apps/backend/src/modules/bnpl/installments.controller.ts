import { Controller, Get, HttpStatus, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
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
import { InstallmentPaymentResponseDto, InstallmentsOverviewDto } from './dto/bnpl.dto';
import { InstallmentsService } from './installments.service';

@ApiTags('credit-installments')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Customers only' })
@Controller('credit/installments')
export class InstallmentsController {
  constructor(private readonly installments: InstallmentsService) {}

  @Get()
  @ApiOperation({
    summary: 'My instalments, grouped by order',
    description: 'Status PENDING, PAID or OVERDUE (a PENDING instalment whose due date — Asia/Tehran — has passed is marked OVERDUE).',
  })
  @ApiOkResponse({ type: InstallmentsOverviewDto })
  list(@CurrentUser() user: AuthenticatedUser): Promise<InstallmentsOverviewDto> {
    return this.installments.overview(user.id);
  }

  @Post(':id/pay')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Pay one instalment by card',
    description:
      'Opens a bank payment (the active IPG) for the amount due of a PENDING or OVERDUE instalment and returns its page. When the bank ' +
      'callback (`/payments/callback`) is verified, in one transaction the instalment becomes PAID with paidAt, and its principal returns ' +
      'to the credit line (used −= principal, available += principal) with an INSTALLMENT_REPAYMENT_RESTORE ledger row.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: InstallmentPaymentResponseDto })
  @ApiBadRequestResponse({ description: 'The id is not a UUID' })
  @ApiNotFoundResponse({ description: 'Instalment not found (or not yours)' })
  @ApiConflictResponse({ description: 'INSTALLMENT_NOT_PAYABLE (already PAID or WAIVED)' })
  @ApiTooManyRequestsResponse({ description: 'Too many open payment attempts for this instalment' })
  @ApiBadGatewayResponse({ description: 'GATEWAY_UNAVAILABLE: the payment gateway could not open a session' })
  pay(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @ClientContext() context: RequestContext,
  ): Promise<InstallmentPaymentResponseDto> {
    return this.installments.pay(user.id, id, { actorId: user.id, context });
  }
}
