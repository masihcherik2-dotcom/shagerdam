import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { UptimeHealthIndicator } from './indicators/uptime.health';
import { PublicStatusService } from './public-status.service';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [DatabaseHealthIndicator, RedisHealthIndicator, UptimeHealthIndicator, PublicStatusService],
})
export class HealthModule {}
