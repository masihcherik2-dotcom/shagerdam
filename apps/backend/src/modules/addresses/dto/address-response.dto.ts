import { ApiProperty } from '@nestjs/swagger';

export class AddressDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'تهران' })
  province!: string;

  @ApiProperty({ example: 'تهران' })
  city!: string;

  @ApiProperty({ example: 'خیابان ولیعصر، بالاتر از میدان ونک، کوچه نگار' })
  postalAddress!: string;

  @ApiProperty({ example: '1969833111' })
  postalCode!: string;

  @ApiProperty({ example: '12', nullable: true, type: String })
  buildingNumber!: string | null;

  @ApiProperty({ example: '4', nullable: true, type: String })
  unitNumber!: string | null;

  @ApiProperty({ example: 'مریم احمدی' })
  recipientName!: string;

  @ApiProperty({ example: '+989121234567', description: 'E.164' })
  recipientMobile!: string;

  @ApiProperty()
  isDefault!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class AddressListDto {
  @ApiProperty({ type: [AddressDto], description: 'Default address first, then newest first.' })
  items!: AddressDto[];

  @ApiProperty({ example: 2 })
  total!: number;

  @ApiProperty({ example: 20, description: 'Maximum number of addresses a customer can keep.' })
  limit!: number;
}

export class DeleteAddressResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: true })
  deleted!: boolean;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'When the deleted address was the default, the address promoted in its place (newest remaining).',
  })
  newDefaultAddressId!: string | null;
}
