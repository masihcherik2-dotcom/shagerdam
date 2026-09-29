import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { resolveEnvFilePaths } from './config/env-file-paths';
import { validateEnvironment, type EnvironmentVariables } from './config/env.validation';
import { HealthModule } from './infra/health/health.module';
import { PrismaModule } from './infra/prisma/prisma.module';
import { RedisModule } from './infra/redis/redis.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuditInterceptor } from './modules/audit/audit.interceptor';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { RolesGuard } from './modules/auth/guards/roles.guard';
import { MediaModule } from './modules/media/media.module';
import { SmsModule } from './modules/sms/sms.module';
import { StorageModule } from './modules/storage/storage.module';
import { UsersModule } from './modules/users/users.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { ProductsModule } from './modules/products/products.module';
import { ImporterModule } from './modules/importer/importer.module';
import { TorobIntegrationModule } from './modules/integrations/torob/torob.module';
import { BrandingModule } from './modules/branding/branding.module';
import { ShippingModule } from './modules/shipping/shipping.module';
import { AddressesModule } from './modules/addresses/addresses.module';
import { CartModule } from './modules/cart/cart.module';
import { BnplModule } from './modules/bnpl/bnpl.module';
import { CreditModule } from './modules/credit/credit.module';
import { DisputesModule } from './modules/disputes/disputes.module';
import { FinancialModule } from './modules/financial/financial.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SettlementsModule } from './modules/settlements/settlements.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot<EnvironmentVariables>({
      isGlobal: true,
      cache: true,
      envFilePath: resolveEnvFilePaths(),
      expandVariables: false,
      validate: (raw: Record<string, unknown>) => validateEnvironment(raw),
    }),
    PrismaModule,
    RedisModule,
    HealthModule,
    // AuditModule comes before AuthModule: the auth module records LOGIN rows
    // through `AuditLogService`.
    AuditModule,
    AuthModule,
    UsersModule,
    SmsModule,
    // Storage is imported before MediaModule for readability; MediaModule pulls it
    // in itself, and `StorageModule` is stateless, so the order is not load-bearing.
    StorageModule,
    MediaModule,
    VendorsModule,
    CategoriesModule,
    ProductsModule,
    ImporterModule,
    TorobIntegrationModule,
    BrandingModule,
    ShippingModule,
    AddressesModule,
    CartModule,
    OrdersModule,
    WalletModule,
    PaymentsModule,
    SettlementsModule,
    FinancialModule,
    CreditModule,
    BnplModule,
    DisputesModule,
  ],
  providers: [
    // Order matters: authentication runs first and populates `request.user`,
    // then authorization decides. Both are global, so every route is protected
    // unless it opts out with `@Public()`.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    // One global interceptor writes the audit trail for mutating requests.
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
