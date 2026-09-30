import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser, OptionalUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { SkipAudit } from '../audit/audit.decorator';
import { CART_TOKEN_HEADER, CartToken } from './cart-token';
import { CartService, type CartIdentity } from './cart.service';
import { AddCartItemDto, UpdateCartItemDto } from './dto/cart-input.dto';
import { CartDto, MergeCartResponseDto } from './dto/cart-response.dto';

const UUID = new ParseUUIDPipe({ version: '4' });

const TOKEN_HEADER_DOC = {
  name: CART_TOKEN_HEADER,
  required: false,
  description:
    'Guest cart token (43 characters) returned as `cartToken` when the guest cart was created. Ignored when a valid bearer token is sent: signed-in users always use their own cart.',
};

const identityOf = (user: AuthenticatedUser | undefined, token: string | undefined): CartIdentity =>
  user ? { userId: user.id } : token !== undefined ? { token } : {};

/**
 * Cart for guests and signed-in users. Cart edits are not audited
 * (`@SkipAudit()`): they are high-volume, carry no authority, and the response
 * contains the guest token, which must never be written to the audit table.
 */
@ApiTags('cart')
@SkipAudit()
@ApiBadRequestResponse({ description: 'Malformed X-Cart-Token (code INVALID_CART_TOKEN) or validation failed' })
@Controller('cart')
export class CartController {
  constructor(private readonly carts: CartService) {}

  @Get()
  @Public()
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({
    summary: 'Current cart, grouped by store',
    description:
      'Every line is checked against live data: availability, stock and price. Changed prices are flagged (PRICE_CHANGED) until the customer acts on the line or checks out.',
  })
  @ApiOkResponse({ type: CartDto })
  get(@OptionalUser() user: AuthenticatedUser | undefined, @CartToken() token: string | undefined): Promise<CartDto> {
    return this.carts.get(identityOf(user, token));
  }

  @Post('items')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({
    summary: 'Add a product option to the cart',
    description:
      'Adds to the existing quantity of the same variant. The total may not exceed available stock. A guest without a token gets a new cart and its token in `cartToken` (returned once).',
  })
  @ApiOkResponse({ type: CartDto })
  @ApiBadRequestResponse({ description: 'Validation failed, malformed X-Cart-Token, or per-item cap exceeded' })
  @ApiNotFoundResponse({ description: 'Unknown variant' })
  @ApiConflictResponse({ description: 'Not purchasable, out of stock / insufficient stock (with availableQuantity), or cart full' })
  add(
    @Body() dto: AddCartItemDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @CartToken() token: string | undefined,
  ): Promise<CartDto> {
    return this.carts.addItem(identityOf(user, token), dto);
  }

  @Patch('items/:id')
  @Public()
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({ summary: 'Change the quantity of a cart line', description: 'Raising the quantity is checked against live stock; lowering it always works.' })
  @ApiOkResponse({ type: CartDto })
  @ApiNotFoundResponse({ description: 'No such line in the caller’s cart' })
  @ApiConflictResponse({ description: 'Insufficient stock or no longer purchasable' })
  update(
    @Param('id', UUID) id: string,
    @Body() dto: UpdateCartItemDto,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @CartToken() token: string | undefined,
  ): Promise<CartDto> {
    return this.carts.updateItem(identityOf(user, token), id, dto);
  }

  @Delete('items/:id')
  @Public()
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({ summary: 'Remove a line from the cart' })
  @ApiOkResponse({ type: CartDto })
  @ApiNotFoundResponse({ description: 'No such line in the caller’s cart' })
  remove(
    @Param('id', UUID) id: string,
    @OptionalUser() user: AuthenticatedUser | undefined,
    @CartToken() token: string | undefined,
  ): Promise<CartDto> {
    return this.carts.removeItem(identityOf(user, token), id);
  }

  @Post('clear')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiHeader(TOKEN_HEADER_DOC)
  @ApiOperation({ summary: 'Remove every line from the cart' })
  @ApiOkResponse({ type: CartDto })
  clear(@OptionalUser() user: AuthenticatedUser | undefined, @CartToken() token: string | undefined): Promise<CartDto> {
    return this.carts.clear(identityOf(user, token));
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiHeader({ ...TOKEN_HEADER_DOC, required: true, description: 'Token of the guest cart to merge into the account cart.' })
  @ApiOperation({
    summary: 'Merge the guest cart into the signed-in user’s cart (call right after login)',
    description:
      'Quantities of the same variant are added and limited to live stock; unavailable lines are dropped. The guest cart is deleted. Calling it again with the same token is a no-op.',
  })
  @ApiOkResponse({ type: MergeCartResponseDto })
  @ApiBadRequestResponse({ description: 'X-Cart-Token missing or malformed' })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  merge(@CurrentUser() user: AuthenticatedUser, @CartToken() token: string | undefined): Promise<MergeCartResponseDto> {
    if (token === undefined) {
      throw new BadRequestException(`${CART_TOKEN_HEADER} header is required`);
    }
    return this.carts.merge(user.id, token);
  }
}
