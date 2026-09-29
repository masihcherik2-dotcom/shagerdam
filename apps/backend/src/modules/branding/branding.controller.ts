import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { BrandingService } from './branding.service';
import { PublicBrandingDto } from './dto/branding.dto';

@ApiTags('branding')
@Controller('branding')
export class BrandingController {
  constructor(private readonly branding: BrandingService) {}

  @Get()
  @Public()
  // Served from Redis; `no-cache` so browsers/proxies revalidate and an admin
  // change shows on the next page load.
  @Header('Cache-Control', 'no-cache')
  @ApiOperation({
    summary: 'هویت بصری عمومی فروشگاه (لوگو، فاوآیکن، بنرهای فعال)',
    description: 'مقادیر null یعنی تنظیم نشده؛ فرانت‌اند لوگوی پیش‌فرض (مونوگرام) را نشان می‌دهد. فقط بنرهای فعال برگردانده می‌شوند.',
  })
  @ApiOkResponse({ type: PublicBrandingDto })
  get(): Promise<PublicBrandingDto> {
    return this.branding.getPublic();
  }
}
