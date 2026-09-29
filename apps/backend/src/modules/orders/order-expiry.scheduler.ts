import { Injectable, Logger, type OnApplicationBootstrap, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { OrderLifecycleService } from './order-lifecycle.service';

const LOCK_KEY = 'lock:orders:expiry-sweep';

/**
 * Periodically cancels unpaid orders whose payment window passed and releases
 * their stock. Several API instances may run this timer; a Redis `SET NX PX`
 * lock lets only one of them sweep at a time (correctness does not depend on
 * it — each order is re-checked under a row lock — it only avoids duplicate work).
 *
 * `ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=0` disables the timer (e.g. when a
 * dedicated worker takes over).
 */
@Injectable()
export class OrderExpiryScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(OrderExpiryScheduler.name);
  private readonly intervalMs: number;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;

  constructor(
    private readonly lifecycle: OrderLifecycleService,
    private readonly redis: RedisService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.intervalMs = config.getOrThrow<number>('ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS') * 1000;
  }

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) {
      this.logger.log('Unpaid-order expiry sweep is disabled (ORDER_EXPIRY_SWEEP_INTERVAL_SECONDS=0)');
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

  /** One sweep; returns the number of orders expired (0 when another instance holds the lock). */
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
          const expired = await this.lifecycle.expireOverdue();
          if (expired > 0) this.logger.log(`Expired ${expired} unpaid order(s) and released their stock`);
          return expired;
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
        this.logger.error(`Expiry sweep failed: ${error instanceof Error ? error.message : String(error)}`);
        return 0;
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }
}
