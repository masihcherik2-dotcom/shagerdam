import { Module } from '@nestjs/common';
import { CategoriesModule } from '../categories/categories.module';
import { MediaModule } from '../media/media.module';
import { DIGIKALA_API_ORIGIN, DIGIKALA_PUBLIC_API_ORIGIN, DigikalaExtractor } from './extractors/digikala.extractor';
import { GenericSchemaOrgExtractor } from './extractors/generic-schema.extractor';
import { IMPORT_NETWORK_POLICY, PUBLIC_INTERNET_POLICY } from './net/address-policy';
import { SafeHttpClient } from './net/safe-http-client';
import { ProductImporterService } from './product-importer.service';
import { VendorProductImportController } from './vendor-product-import.controller';

/**
 * Smart product importer (feature add-on): Digikala API + generic
 * Schema.org/OpenGraph extraction, SSRF-guarded fetching and remote-image
 * ingestion through the media pipeline.
 *
 * The network policy and the Digikala API origin are providers, not settings:
 * production always runs with the public-internet policy and the real API; only
 * the automated test suite overrides them (Nest `overrideProvider`) to serve
 * fixtures from a local server.
 */
@Module({
  imports: [MediaModule, CategoriesModule],
  controllers: [VendorProductImportController],
  providers: [
    { provide: IMPORT_NETWORK_POLICY, useValue: PUBLIC_INTERNET_POLICY },
    { provide: DIGIKALA_API_ORIGIN, useValue: DIGIKALA_PUBLIC_API_ORIGIN },
    SafeHttpClient,
    GenericSchemaOrgExtractor,
    DigikalaExtractor,
    ProductImporterService,
  ],
})
export class ImporterModule {}
