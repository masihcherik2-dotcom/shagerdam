import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ContactMessageStatus, ContactMessageTopic } from '@prisma/client';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { IsIranianMobile } from '../../../common/validators/is-iranian-mobile.decorator';
import { PaginationQueryDto } from '../../users/dto/user-query.dto';
import { CONTACT_LIMITS } from '../contact-rules';

export class CreateContactMessageDto {
  @ApiProperty({ example: 'علی رضایی', minLength: CONTACT_LIMITS.fullName.min, maxLength: CONTACT_LIMITS.fullName.max })
  @IsString()
  @MinLength(CONTACT_LIMITS.fullName.min)
  @MaxLength(CONTACT_LIMITS.fullName.max)
  fullName!: string;

  @ApiProperty({ example: '09121234567', description: 'موبایل ایران در هر قالب رایج؛ به E.164 ذخیره می‌شود' })
  @IsString()
  @IsIranianMobile()
  mobile!: string;

  @ApiPropertyOptional({ example: 'ali@example.com' })
  @IsOptional()
  @ValidateIf((_, value) => value !== '')
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiProperty({ enum: ContactMessageTopic })
  @IsEnum(ContactMessageTopic)
  topic!: ContactMessageTopic;

  @ApiProperty({ example: 'پیگیری سفارش', minLength: CONTACT_LIMITS.subject.min, maxLength: CONTACT_LIMITS.subject.max })
  @IsString()
  @MinLength(CONTACT_LIMITS.subject.min)
  @MaxLength(CONTACT_LIMITS.subject.max)
  subject!: string;

  @ApiProperty({ minLength: CONTACT_LIMITS.message.min, maxLength: CONTACT_LIMITS.message.max })
  @IsString()
  @MinLength(CONTACT_LIMITS.message.min)
  @MaxLength(CONTACT_LIMITS.message.max)
  message!: string;

  @ApiPropertyOptional({ description: 'Honeypot — must stay empty (hidden from people, filled by bots).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  website?: string;
}

export class ContactMessageReceiptDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'کد پیگیری کوتاه برای ارجاع در تماس تلفنی', example: 'C-1A2B3C4D' }) reference!: string;
  @ApiProperty() createdAt!: string;
}

export class ContactMessageQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ContactMessageStatus })
  @IsOptional()
  @IsEnum(ContactMessageStatus)
  status?: ContactMessageStatus;

  @ApiPropertyOptional({ enum: ContactMessageTopic })
  @IsOptional()
  @IsEnum(ContactMessageTopic)
  topic?: ContactMessageTopic;
}

export class UpdateContactMessageDto {
  @ApiPropertyOptional({ enum: ContactMessageStatus })
  @IsOptional()
  @IsEnum(ContactMessageStatus)
  status?: ContactMessageStatus;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: CONTACT_LIMITS.staffNote.max })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(CONTACT_LIMITS.staffNote.max)
  staffNote?: string | null;
}

export class ContactMessageActorDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() fullName!: string;
}

export class AdminContactMessageDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() reference!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ example: '09121234567' }) mobile!: string;
  @ApiProperty({ type: String, nullable: true }) email!: string | null;
  @ApiProperty({ enum: ContactMessageTopic }) topic!: ContactMessageTopic;
  @ApiProperty() subject!: string;
  @ApiProperty() message!: string;
  @ApiProperty({ enum: ContactMessageStatus }) status!: ContactMessageStatus;
  @ApiProperty({ type: String, nullable: true }) staffNote!: string | null;
  @ApiProperty({ type: ContactMessageActorDto, nullable: true, description: 'کاربر واردشده‌ای که پیام را فرستاده' }) sender!: ContactMessageActorDto | null;
  @ApiProperty({ type: ContactMessageActorDto, nullable: true }) handledBy!: ContactMessageActorDto | null;
  @ApiProperty({ type: String, nullable: true }) handledAt!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class AdminContactMessagePageDto {
  @ApiProperty({ type: [AdminContactMessageDto] }) items!: AdminContactMessageDto[];
  @ApiProperty() page!: number;
  @ApiProperty() pageSize!: number;
  @ApiProperty() total!: number;
  @ApiProperty() totalPages!: number;
  @ApiProperty({ type: Object, example: { NEW: 3, IN_PROGRESS: 1, RESOLVED: 12 } }) counts!: Record<ContactMessageStatus, number>;
}
