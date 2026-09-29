import { Controller, Get } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ApiOkResponse, ApiOperation, ApiServiceUnavailableResponse, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  HealthCheckService,
  MemoryHealthIndicator,
  type HealthCheckResult,
  type HealthIndicatorResult,
} from '@nestjs/terminus';
import { DatabaseHealthIndicator } from './indicators/database.health';
import { RedisHealthIndicator } from './indicators/redis.health';
import { UptimeHealthIndicator } from './indicators/uptime.health';

/** Heap threshold above which the instance is considered unhealthy: 512 MiB. */
const HEAP_LIMIT_BYTES = 512 * 1024 * 1024;

/**
 * Liveness/readiness probe.
 *
 * `@Public()` is required and deliberate: the global `JwtAuthGuard` protects
 * every route by default, while health probes are called by orchestrators
 * (Docker healthcheck, load balancer, uptime monitor) that hold no token. The
 * endpoint exposes no data beyond dependency status, so this does not widen the
 * attack surface.
 */
@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly healthCheckService: HealthCheckService,
    private readonly memoryHealthIndicator: MemoryHealthIndicator,
    private readonly databaseHealthIndicator: DatabaseHealthIndicator,
    private readonly redisHealthIndicator: RedisHealthIndicator,
    private readonly uptimeHealthIndicator: UptimeHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary: 'Readiness of the API and its dependencies',
    description:
      'Checks PostgreSQL connectivity, Redis connectivity, heap memory usage and process uptime. ' +
      'Responds 200 when every check is up and 503 as soon as one of them is down.',
  })
  @ApiOkResponse({ description: 'All checks are up.' })
  @ApiServiceUnavailableResponse({ description: 'At least one check is down.' })
  async check(): Promise<HealthCheckResult> {
    return this.healthCheckService.check([
      (): Promise<HealthIndicatorResult> => this.databaseHealthIndicator.isHealthy('database'),
      (): Promise<HealthIndicatorResult> => this.redisHealthIndicator.isHealthy('redis'),
      (): Promise<HealthIndicatorResult> =>
        Promise.resolve(this.memoryHealthIndicator.checkHeap('memory', HEAP_LIMIT_BYTES)),
      (): Promise<HealthIndicatorResult> =>
        Promise.resolve(this.uptimeHealthIndicator.isHealthy('uptime')),
    ]);
  }
}
