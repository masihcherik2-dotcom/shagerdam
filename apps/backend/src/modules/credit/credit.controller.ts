import { Body, Controller, Get, HttpStatus, Post } from '@nestjs/common';
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
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { CreditService, MAX_APPLICATIONS_PER_DAY } from './credit.service';
import { CreateCreditApplicationDto, CreditAccountDto, CreditApplicationDto, CreditPlansResponseDto } from './dto/credit.dto';

@ApiTags('credit')
@Controller('credit')
export class CreditController {
  constructor(private readonly credit: CreditService) {}

  @Post('applications')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth('access-token')
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Apply for a credit line (BNPL) with the active provider',
    description:
      'Validates the national code (checksum), runs the provider’s eligibility/score inquiry and submits the application. ' +
      'The result is stored as a CreditApplication (APPROVED, REJECTED with `decisionReason`, or DOCS_REQUIRED). On approval a ' +
      'CreditAccount is opened with totalLimit = available = approvedLimit and a CREDIT_ALLOCATION ledger row, and the national ' +
      `code is saved to the profile — all in one transaction. At most ${MAX_APPLICATIONS_PER_DAY} applications per customer per 24 hours. ` +
      'With SANDBOX_BANK (development only) the decision is instant and derived deterministically from the national code; no real bank is contacted.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: CreditApplicationDto, description: 'The recorded application (also when REJECTED).' })
  @ApiBadRequestResponse({ description: 'Validation error (national code checksum, whole-rial limit) or INVALID_DOCUMENTS' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiConflictResponse({
    description: 'CREDIT_PROVIDER_NOT_ACTIVE, CREDIT_ACCOUNT_EXISTS, NATIONAL_CODE_MISMATCH, NATIONAL_CODE_IN_USE or CREDIT_APPLICATION_IN_PROGRESS',
  })
  @ApiTooManyRequestsResponse({ description: 'Daily application quota exhausted' })
  @ApiBadGatewayResponse({ description: 'CREDIT_PROVIDER_UNAVAILABLE: the provider did not answer (nothing recorded)' })
  @ApiServiceUnavailableResponse({ description: 'CREDIT_DISABLED, CREDIT_PROVIDER_UNAVAILABLE / NOT_IMPLEMENTED / MISCONFIGURED / NOT_ALLOWED' })
  apply(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCreditApplicationDto,
    @ClientContext() context: RequestContext,
  ): Promise<CreditApplicationDto> {
    return this.credit.apply(user.id, dto, { actorId: user.id, context });
  }

  @Get('account')
  @Roles(UserRole.CUSTOMER)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'My credit line',
    description: 'totalLimit, used, reserved and available (invariant totalLimit = used + reserved + available), status, provider and unpaid instalments.',
  })
  @ApiOkResponse({ type: CreditAccountDto })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiForbiddenResponse({ description: 'Customers only' })
  @ApiNotFoundResponse({ description: 'CREDIT_ACCOUNT_NOT_FOUND' })
  account(@CurrentUser() user: AuthenticatedUser): Promise<CreditAccountDto> {
    return this.credit.account(user.id);
  }

  @Get('plans')
  @Public()
  @ApiOperation({
    summary: 'Instalment plans on offer',
    description:
      'Active plans of the active credit provider. Empty when `credit.enabled` is false, no provider is active, or the active ' +
      'provider has no integration in this build. Interest (Option A): totalInterest = floor(creditAmount × interestRatePercent / 100), ' +
      'principal and interest split evenly in whole rials with the remainder on the last instalment, due every 30 days.',
  })
  @ApiOkResponse({ type: CreditPlansResponseDto })
  @ApiServiceUnavailableResponse({ description: 'CREDIT_PROVIDER_MISCONFIGURED: the active provider’s configuration is invalid' })
  plans(): Promise<CreditPlansResponseDto> {
    return this.credit.plans();
  }
}
