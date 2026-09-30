import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../../common/decorators/public.decorator';
import { TorobFeedQueryDto, TorobFeedResponseDto, TorobProductDetailsQueryDto, TorobProductItemDto } from './dto/torob.dto';
import { TorobFeedService } from './torob-feed.service';

/**
 * Torob (ترب) price-comparison integration.
 *
 * Public by design: Torob's crawler calls these without credentials, and the
 * responses contain only what the storefront already shows publicly.
 */
@ApiTags('integrations-torob')
@Public()
@Controller('integrations/torob')
export class TorobController {
  constructor(private readonly feed: TorobFeedService) {}

  @Get('products')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({
    summary: 'فید کالاها برای ترب (کل بازار یا یک فروشگاه)',
    description:
      'هر تنوع فعالِ هر کالای قابل‌نمایش در فروشگاه یک آیتم است (page_unique = SKU). ' +
      'قیمت‌ها زنده از PostgreSQL خوانده می‌شوند؛ موجودی = موجودی انبار − رزرو. کالای ناموجود با availability=outofstock در فید می‌ماند؛ ' +
      'کالای منتشرنشده، مسدودشده، تنوع غیرفعال و فروشگاهِ تأییدنشده در فید نیستند. ' +
      'با vendorSlug فقط کالاهای همان فروشگاهِ تأییدشده برگردانده می‌شود. ' +
      'صفحه‌ها در Redis کش می‌شوند (TOROB_FEED_CACHE_TTL_SECONDS) و با هر تغییر کالا، قیمت یا موجودی باطل می‌شوند.',
  })
  @ApiOkResponse({ type: TorobFeedResponseDto })
  @ApiBadRequestResponse({ description: 'پارامتر نامعتبر (page، pageSize/limit حداکثر ۵۰۰، vendorSlug)' })
  @ApiNotFoundResponse({ description: 'TOROB_VENDOR_NOT_FOUND — فروشگاهی با این نامک وجود ندارد یا تأیید نشده است' })
  products(@Query() query: TorobFeedQueryDto): Promise<TorobFeedResponseDto> {
    return this.feed.feed(query);
  }

  @Get('product-details')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'قیمت و موجودی لحظه‌ای یک کالا برای ترب',
    description:
      'دقیقاً یکی از page_unique یا page_url لازم است. بدون کش: هر درخواست مستقیم از PostgreSQL خوانده می‌شود. ' +
      'کالایی که هنوز وجود دارد ولی دیگر نمایش داده نمی‌شود (منتشرنشده، مسدود، فروشگاه تعلیق‌شده، تنوع غیرفعال) با availability=outofstock برگردانده می‌شود.',
  })
  @ApiOkResponse({ type: TorobProductItemDto })
  @ApiBadRequestResponse({ description: 'TOROB_LOOKUP_REQUIRED (هیچ یا هر دو پارامتر) یا TOROB_INVALID_PAGE_URL (نشانی خارج از این فروشگاه)' })
  @ApiNotFoundResponse({ description: 'TOROB_PRODUCT_NOT_FOUND' })
  productDetails(@Query() query: TorobProductDetailsQueryDto): Promise<TorobProductItemDto> {
    return this.feed.details(query);
  }
}
