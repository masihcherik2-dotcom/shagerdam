import { Controller, Get, Header } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/decorators/public.decorator';
import { PublicSiteInfoDto } from './dto/site-info.dto';
import { SiteInfoService } from './site-info.service';

@ApiTags('site-info')
@Controller('site-info')
export class SiteInfoController {
  constructor(private readonly siteInfo: SiteInfoService) {}

  @Get()
  @Public()
  @Header('Cache-Control', 'no-cache')
  @ApiOperation({
    summary: 'مشخصات حقوقی و راه‌های تماس کسب‌وکار (فوتر، صفحهٔ تماس) و نمادهای اعتماد',
    description: 'null یعنی مدیر هنوز این فیلد را ثبت نکرده و فرانت‌اند آن را نمایش نمی‌دهد. نماد اینماد/ساماندهی فقط وقتی هر دو نشانی (لینک و تصویر) ثبت شده باشد برگردانده می‌شود.',
  })
  @ApiOkResponse({ type: PublicSiteInfoDto })
  get(): Promise<PublicSiteInfoDto> {
    return this.siteInfo.getPublic();
  }
}
