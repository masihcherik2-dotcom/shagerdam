import { Controller, Get, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiBearerAuth, ApiForbiddenResponse, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { PaginatedWalletTransactionsDto, WalletSummaryDto, WalletTransactionQueryDto } from './dto/wallet.dto';
import { WalletService } from './wallet.service';

@ApiTags('vendor-wallet')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Vendors with a store only' })
@Controller('vendor/wallet')
export class VendorWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  @ApiOperation({
    summary: 'My wallet balances',
    description:
      'pendingBalance = escrow of paid, undelivered packages; withdrawableBalance = released on delivery and requestable; ' +
      'settlementHoldBalance = reserved by open settlement requests. Amounts in IRR.',
  })
  @ApiOkResponse({ type: WalletSummaryDto })
  summary(@CurrentUser() user: AuthenticatedUser): Promise<WalletSummaryDto> {
    return this.wallet.summaryForVendor(user.id);
  }

  @Get('transactions')
  @ApiOperation({ summary: 'My wallet ledger, newest first', description: 'Every balance movement with its signed amount and the bucket balance after it.' })
  @ApiOkResponse({ type: PaginatedWalletTransactionsDto })
  @ApiBadRequestResponse({ description: 'Invalid filter or pagination' })
  transactions(@CurrentUser() user: AuthenticatedUser, @Query() query: WalletTransactionQueryDto): Promise<PaginatedWalletTransactionsDto> {
    return this.wallet.transactionsForVendor(user.id, query);
  }
}
