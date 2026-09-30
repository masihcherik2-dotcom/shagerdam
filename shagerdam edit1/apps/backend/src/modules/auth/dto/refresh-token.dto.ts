import { ApiProperty } from '@nestjs/swagger';
import { IsJWT, IsOptional } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: 'توکن تازهسازی که در پاسخ ورود/تأیید OTP برگردانده شد',
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…',
  })
  @IsJWT()
  refreshToken!: string;
}

export class LogoutDto {
  @ApiProperty({
    required: false,
    description:
      'در صورت ارسال، همان نشست باطل میشود؛ در غیر این صورت نشست جاریِ توکن دسترسی باطل میشود',
  })
  @IsOptional()
  @IsJWT()
  refreshToken?: string;
}
