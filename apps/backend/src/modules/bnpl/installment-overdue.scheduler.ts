import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { InstallmentsService } from './installments.service';

const LOCK_KEY = 'lock:credit:installment-overdue-sweep';

/**
 * Periodically marks PENDING instalments whose due date (Asia/Tehran) has passed
 * as OVERDUE. Several API instances may run this timer; a Redis `SET NX PX` lock
 * lets only one of them sweep at a time (the update itself is idempotent).
 * Late penalties are not computed in this phase.
 *
 * `INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=0` disables the timer (e.g. when a
 * dedicated worker takes over).
 */
@Injectable()
export class InstallmentOverdueScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(InstallmentOverdueScheduler.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly installments: InstallmentsService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS') * 1000;
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('Instalment overdue sweep is disabled (INSTALLMENT_OVERDUE_SWEEP_INTERVAL_SECONDS=0)');
      return;
    }
    this.timer = setInterval(() => {
      void this.sweep();
    }, this.intervalMs);
    this.timer.unref(); // never keeps the process alive on its own
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.running?.catch(() => 0);
  }

  /** One sweep; returns the number of instalments marked OVERDUE (0 when another instance holds the lock). */
  async sweep(): Promise<number> {
    if (this.running) {
      return 0;
    }
    const owner = randomUUID();
    this.running = (async (): Promise<number> => {
      try {
        const acquired = await this.redis.client.set(LOCK_KEY, owner, 'PX', Math.max(this.intervalMs, 30_000), 'NX');
        if (acquired !== 'OK') return 0;
        try {
          const marked = await this.installments.markOverdue();
          if (marked > 0) this.logger.log(`Marked ${marked} instalment(s) OVERDUE`);
          return marked;
        } finally {
          // Release only our own lock.
          await this.redis.client.eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            LOCK_KEY,
            owner,
          );
        }
      } catch (error) {
        this.logger.error(`Instalment overdue sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
