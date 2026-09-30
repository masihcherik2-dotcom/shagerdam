import { Module } from '@nestjs/common';
import { AdminFinancialController } from './admin-financial.controller';
import { FinancialService } from './financial.service';

@Module({
  controllers: [AdminFinancialController],
  providers: [FinancialService],
})
export class FinancialModule {}
