import { Module } from '@nestjs/common';
import { UsersService } from './users.service';
import { UsersController } from './users.controller';

/**
 * Identity domain module. `UsersService` is the only component allowed to read
 * or write the `users` / `customer_profiles` / `vendors` tables; the auth module
 * consumes it instead of touching Prisma for identity concerns.
 */
@Module({
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
