import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { errorMessage } from '../../common/utils';

const CONNECT_MAX_ATTEMPTS = 5;
const CONNECT_RETRY_DELAY_MS = 1_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    super({
      datasourceUrl: config.getOrThrow<string>('DATABASE_URL'),
      log: ['warn', 'error'],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.connectWithRetry();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Executes a trivial query; used by the health check and by operational probes. */
  async ping(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  /**
   * A dependency that is down must not turn into a crash loop, otherwise the
   * process can never serve `/api/v1/health` and operators lose their signal.
   * The API therefore retries briefly and then keeps running with a loud error;
   * every database-backed request fails with 5xx until the connection recovers.
   */
  private async connectWithRetry(): Promise<void> {
    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt += 1) {
      try {
        await this.$connect();
        this.logger.log('PostgreSQL connection established');
        return;
      } catch (error) {
        const message = errorMessage(error);
        if (attempt === CONNECT_MAX_ATTEMPTS) {
          this.logger.error(
            `PostgreSQL unreachable after ${CONNECT_MAX_ATTEMPTS} attempts: ${message}`,
          );
          return;
        }
        this.logger.warn(`PostgreSQL connection attempt ${attempt}/${CONNECT_MAX_ATTEMPTS} failed: ${message}`);
        await new Promise((resolve) => setTimeout(resolve, CONNECT_RETRY_DELAY_MS));
      }
    }
  }
}
