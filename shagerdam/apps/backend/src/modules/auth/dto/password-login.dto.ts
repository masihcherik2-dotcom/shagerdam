import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsString, Length, MaxLength, MinLength } from 'class-validator';

export class PasswordLoginDto {
  @ApiProperty({
    example: 'admin@shopino.local',
    description: 'ایمیل یا شماره موبایل کارکنان/فروشندگان',
    maxLength: 254,
  })
  @Transform(({ value }): unknown => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(3, 254)
  identifier!: string;

  @ApiProperty({ example: 'Str0ng-Passphrase!', minLength: 8, maxLength: 128, writeOnly: true })
  @IsString()
  @MinLength(8, { message: 'رمز عبور حداقل ۸ کاراکتر است' })
  @MaxLength(128)
  password!: string;
}
