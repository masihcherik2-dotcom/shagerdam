import { Module, type Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../../config/env.validation';
import { RedisService } from '../../infra/redis/redis.service';
import { CreditModule } from '../credit/credit.module';
import { OrdersModule } from '../orders/orders.module';
import { PAYMENT_GATEWAY, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';
import { SandboxPaymentGatewayProvider } from './gateway/sandbox-payment-gateway.provider';
import { ZarinpalPaymentGatewayProvider } from './gateway/zarinpal-payment-gateway.provider';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { SandboxBankController } from './sandbox-bank.controller';

/**
 * Selects the gateway once, at boot, from PAYMENT_GATEWAY_PROVIDER (validated
 * in env.validation.ts: zarinpal needs a merchant id, sandbox is refused in
 * production). No business code branches on the provider.
 */
const gatewayProvider: Provider = {
  provide: PAYMENT_GATEWAY,
  inject: [ConfigService, RedisService],
  useFactory: (config: ConfigService<EnvironmentVariables, true>, redis: RedisService): PaymentGatewayProvider => {
    if (config.getOrThrow<string>('PAYMENT_GATEWAY_PROVIDER') === 'zarinpal') {
      return new ZarinpalPaymentGatewayProvider({
        merchantId: config.getOrThrow<string>('ZARINPAL_MERCHANT_ID'),
        apiBaseUrl: config.getOrThrow<string>('ZARINPAL_API_BASE_URL'),
        timeoutMs: config.getOrThrow<number>('PAYMENT_GATEWAY_TIMEOUT_MS'),
        fetch: (url, init) => fetch(url, init),
      });
    }
    return new SandboxPaymentGatewayProvider(redis, config.getOrThrow<string>('PUBLIC_API_ORIGIN'));
  },
};

@Module({
  imports: [CreditModule, OrdersModule],
  controllers: [PaymentsController, SandboxBankController],
  providers: [gatewayProvider, PaymentsService],
  exports: [PaymentsService, PAYMENT_GATEWAY],
})
export class PaymentsModule {}
