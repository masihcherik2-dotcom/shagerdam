import { ApiProperty } from '@nestjs/swagger';
import { PUBLIC_STATUS_MODULES, type ComponentState, type PublicStatusModule, type PublicStatusReport } from './public-status';

const STATES: ComponentState[] = ['operational', 'degraded', 'outage'];

export class PublicModuleStatusDto {
  @ApiProperty({ enum: PUBLIC_STATUS_MODULES, example: 'storefront' })
  key!: PublicStatusModule;

  @ApiProperty({ enum: STATES, example: 'operational' })
  status!: ComponentState;
}

export class PublicStatusReportDto implements PublicStatusReport {
  @ApiProperty({ enum: STATES, example: 'operational', description: 'بدترین وضعیت میان قابلیت‌ها' })
  status!: ComponentState;

  @ApiProperty({ example: '2026-10-01T08:00:00.000Z', description: 'زمان آخرین بررسی (ISO 8601)' })
  checkedAt!: string;

  @ApiProperty({ type: [PublicModuleStatusDto] })
  modules!: PublicModuleStatusDto[];
}
