import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
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
import { AddressesService, MAX_ADDRESSES_PER_CUSTOMER } from './addresses.service';
import { CreateAddressDto, UpdateAddressDto } from './dto/address-input.dto';
import { AddressDto, AddressListDto, DeleteAddressResponseDto } from './dto/address-response.dto';

const UUID = new ParseUUIDPipe({ version: '4' });

/**
 * The signed-in customer's address book. Writes are `@SkipAudit()` because the
 * service writes a PII-free audit row inside each transaction.
 */
@ApiTags('customer-addresses')
@ApiBearerAuth('access-token')
@Roles(UserRole.CUSTOMER)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Only customers have an address book' })
@Controller('customer/addresses')
export class AddressesController {
  constructor(private readonly addresses: AddressesService) {}

  @Get()
  @ApiOperation({ summary: 'List saved addresses (default first)' })
  @ApiOkResponse({ type: AddressListDto })
  async list(@CurrentUser() user: AuthenticatedUser): Promise<AddressListDto> {
    const items = await this.addresses.list(user.id);
    return { items, total: items.length, limit: MAX_ADDRESSES_PER_CUSTOMER };
  }

  @Post()
  @SkipAudit()
  @ApiOperation({ summary: 'Add an address', description: 'The first address becomes the default automatically.' })
  @ApiCreatedResponse({ type: AddressDto })
  @ApiBadRequestResponse({ description: 'Validation failed (postal code, mobile, lengths)' })
  @ApiConflictResponse({ description: `Address book full (${MAX_ADDRESSES_PER_CUSTOMER})` })
  create(
    @Body() dto: CreateAddressDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AddressDto> {
    return this.addresses.create(user.id, dto, { actorId: user.id, context });
  }

  @Patch(':id')
  @SkipAudit()
  @ApiOperation({ summary: 'Update an address or make it the default' })
  @ApiOkResponse({ type: AddressDto })
  @ApiBadRequestResponse({ description: 'Validation failed, empty body, or isDefault=false' })
  @ApiNotFoundResponse({ description: 'No such address in this address book' })
  update(
    @Param('id', UUID) id: string,
    @Body() dto: UpdateAddressDto,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<AddressDto> {
    return this.addresses.update(user.id, id, dto, { actorId: user.id, context });
  }

  @Delete(':id')
  @SkipAudit()
  @ApiOperation({
    summary: 'Delete an address',
    description:
      'Hard delete. Always allowed: orders keep their own copy of the shipping address. Deleting the default promotes the newest remaining address.',
  })
  @ApiOkResponse({ type: DeleteAddressResponseDto })
  @ApiNotFoundResponse({ description: 'No such address in this address book' })
  remove(
    @Param('id', UUID) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @ClientContext() context: RequestContext,
  ): Promise<DeleteAddressResponseDto> {
    return this.addresses.remove(user.id, id, { actorId: user.id, context });
  }
}
