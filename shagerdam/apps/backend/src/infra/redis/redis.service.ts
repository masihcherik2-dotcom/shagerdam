import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { toMilliseconds } from '../../common/utils';

/** Upper bound for a single Redis command; keeps health checks responsive. */
const COMMAND_TIMEOUT_MS = 2_000;
const CONNECT_TIMEOUT_MS = 5_000;
const MAX_RETRIES_PER_REQUEST = 2;
const RECONNECT_MAX_DELAY_MS = 2_000;

/**
 * Owns the Redis connection lifecycle. The client reconnects in the background
 * (`retryStrategy`) so a Redis restart does not require an application restart;
 * `ping()` reports the real state for the health endpoint.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly connection: Redis;

  constructor(config: ConfigService) {
    this.connection = new Redis({
      host: config.getOrThrow<string>('REDIS_HOST'),
      port: config.getOrThrow<number>('REDIS_PORT'),
      password: config.getOrThrow<string>('REDIS_PASSWORD'),
      db: config.get<number>('REDIS_DB') ?? 0,
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
      enableReadyCheck: true,
      retryStrategy: (attempt: number): number => Math.min(attempt * 200, RECONNECT_MAX_DELAY_MS),
    });

    this.connection.on('ready', () => this.logger.log('Redis connection established'));
    this.connection.on('error', (error: Error) => this.logger.error(`Redis error: ${error.message}`));
  }

  /**
   * The underlying client, for features that need more than liveness checks:
   * rate limiting, OTP challenges, refresh-token sessions and Lua scripts.
   *
   * Exposed deliberately rather than wrapped in a hand-written facade: `ioredis`
   * already provides typed commands, pipelining and `multi()`, and a bespoke
   * wrapper would only hide them while adding no safety. Feature services are the
   * only consumers, and each documents the key space it owns.
   */
  get client(): Redis {
    return this.connection;
  }

  /** Sends `PING` and returns the round-trip time in milliseconds. */
  async ping(): Promise<number> {
    const startedAt = process.hrtime.bigint();
    const reply: string = await this.connection.ping();
    if (reply !== 'PONG') {
      throw new Error(`Unexpected Redis PING reply: ${reply}`);
    }
    return toMilliseconds(process.hrtime.bigint() - startedAt);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.connection.status === 'end') {
      return;
    }
    await this.connection.quit();
  }
}
