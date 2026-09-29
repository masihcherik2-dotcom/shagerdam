import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { DOCUMENT_URL_HINT, DOCUMENT_URL_PATTERN } from '../../media/media-urls';
import { IsString, Matches, MaxLength } from 'class-validator';

/**
 * `POST /vendors/verification/documents` — submits (or re-submits) the documents
 * a staff member needs to verify the store.
 *
 * Each URL must be the download URL returned by `POST /media/upload/document`: a
 * document the platform itself stored for this account. The shape is enforced here
 * and the ownership in the service, so neither a foreign host nor another store's
 * document can be attached to a application.
 */

const DOCUMENT_URL_MESSAGE = `$property must be the URL returned by ${DOCUMENT_URL_HINT} for a document uploaded by this account`;

export class SubmitVerificationDocumentsDto {
  @ApiProperty({
    example: '/api/v1/media/documents/3f1a7c4e-0f0b-4d61-9c2a-4a6a2f9a1b77/download',
    description: 'National ID card (or passport) of the store owner. Required for every submission.',
  })
  @IsString()
  @MaxLength(512)
  @Matches(DOCUMENT_URL_PATTERN, { message: DOCUMENT_URL_MESSAGE })
  nationalIdCardUrl!: string;

  @ApiPropertyOptional({
    example: '/api/v1/media/documents/9a2b7c31-5d4e-4a10-8f77-0f1c2d3e4b55/download',
    description: 'Business licence / trade permit. Optional for natural-person stores.',
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(512)
  @Matches(DOCUMENT_URL_PATTERN, { message: DOCUMENT_URL_MESSAGE })
  businessLicenseUrl?: string;

  @ApiPropertyOptional({
    example: '/api/v1/media/documents/2b8f0c11-7a6d-4f39-b0a5-9c8e7d6f5a44/download',
    description:
      'Proof that the declared IBAN belongs to the store owner (bank statement, cheque or account-opening letter).',
  })
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(512)
  @Matches(DOCUMENT_URL_PATTERN, { message: DOCUMENT_URL_MESSAGE })
  bankAccountProofUrl?: string;
}
