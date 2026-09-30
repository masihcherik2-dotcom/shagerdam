import { Body, Controller, Get, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiServiceUnavailableResponse,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ClientContext, CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import type { RequestContext } from '../../common/types/request-context';
import { SkipAudit } from '../audit/audit.decorator';
import { CreateSettlementRequestDto, PaginatedSettlementRequestsDto, SettlementRequestDto, VendorSettlementQueryDto } from './dto/settlement.dto';
import { SettlementsService } from './settlements.service';

@ApiTags('vendor-wallet')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Vendors with a store only (requests: approved stores only)' })
@Controller('vendor/wallet/settlements')
export class VendorSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Post()
  @SkipAudit() // audited inside the transaction
  @ApiOperation({
    summary: 'Request a payout (settlement) to the store’s bank account',
    description:
      'The amount is taken from the withdrawable balance immediately and held until finance approves (PAYA transfer) or rejects ' +
      '(returned). Must be ≥ commerce.settlementMinimumAmount and ≤ withdrawableBalance; targetIban must be the IBAN on the store profile.',
  })
  @ApiResponse({ status: HttpStatus.CREATED, type: SettlementRequestDto })
  @ApiBadRequestResponse({ description: 'Validation error or AMOUNT_BELOW_MINIMUM' })
  @ApiConflictResponse({ description: 'INSUFFICIENT_WALLET_BALANCE, IBAN_MISMATCH or BANK_ACCOUNT_MISSING' })
  @ApiServiceUnavailableResponse({ description: 'The settlement minimum in system_configs is missing or invalid' })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSettlementRequestDto,
    @ClientContext() context: RequestContext,
  ): Promise<SettlementRequestDto> {
    return this.settlements.request(user.id, dto, { actorId: user.id, context });
  }

  @Get()
  @ApiOperation({ summary: 'My settlement requests, newest first' })
  @ApiOkResponse({ type: PaginatedSettlementRequestsDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  list(@CurrentUser() user: AuthenticatedUser, @Query() query: VendorSettlementQueryDto): Promise<PaginatedSettlementRequestsDto> {
    return this.settlements.listForVendor(user.id, query);
  }
}
