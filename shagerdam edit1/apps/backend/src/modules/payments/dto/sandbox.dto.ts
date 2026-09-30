import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export class SandboxDecisionDto {
  @ApiProperty({ enum: ['PAY', 'DECLINE'], description: 'The simulated payer’s choice on the sandbox bank page.' })
  @IsIn(['PAY', 'DECLINE'])
  decision!: 'PAY' | 'DECLINE';
}
