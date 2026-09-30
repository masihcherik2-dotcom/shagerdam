# Smart Product Spec Importer + «شاگردم» rebrand — deliverable

Base: `0765a1e`. Verification: [importer-verification.md](importer-verification.md).

## File structure (new and changed files)

```
apps/backend/package.json   (changed)
apps/backend/prisma/migrations/20261002090000_importer_specs_branding/migration.sql   (new)
apps/backend/prisma/schema.prisma   (changed)
apps/backend/prisma/seed.ts   (changed)
apps/backend/src/app.module.ts   (changed)
apps/backend/src/common/brand.ts   (new)
apps/backend/src/main.ts   (changed)
apps/backend/src/modules/auth/dto/auth-response.dto.ts   (changed)
apps/backend/src/modules/bnpl/credit-checkout.service.ts   (changed)
apps/backend/src/modules/bnpl/installments.service.ts   (changed)
apps/backend/src/modules/cart/dto/cart-response.dto.ts   (changed)
apps/backend/src/modules/disputes/dispute-notifier.ts   (changed)
apps/backend/src/modules/importer/dto/import.dto.ts   (new)
apps/backend/src/modules/importer/extractors/digikala.extractor.spec.ts   (new)
apps/backend/src/modules/importer/extractors/digikala.extractor.ts   (new)
apps/backend/src/modules/importer/extractors/extracted-product.ts   (new)
apps/backend/src/modules/importer/extractors/generic-schema.extractor.spec.ts   (new)
apps/backend/src/modules/importer/extractors/generic-schema.extractor.ts   (new)
apps/backend/src/modules/importer/import-error.ts   (new)
apps/backend/src/modules/importer/importer.module.ts   (new)
apps/backend/src/modules/importer/net/address-policy.spec.ts   (new)
apps/backend/src/modules/importer/net/address-policy.ts   (new)
apps/backend/src/modules/importer/net/import-url.spec.ts   (new)
apps/backend/src/modules/importer/net/import-url.ts   (new)
apps/backend/src/modules/importer/net/safe-http-client.spec.ts   (new)
apps/backend/src/modules/importer/net/safe-http-client.ts   (new)
apps/backend/src/modules/importer/product-importer.service.spec.ts   (new)
apps/backend/src/modules/importer/product-importer.service.ts   (new)
apps/backend/src/modules/importer/vendor-product-import.controller.ts   (new)
apps/backend/src/modules/payments/payments.service.ts   (changed)
apps/backend/src/modules/payments/sandbox-bank.controller.ts   (changed)
apps/backend/src/modules/products/catalog-search.service.ts   (changed)
apps/backend/src/modules/products/dto/product-input.dto.ts   (changed)
apps/backend/src/modules/products/dto/product-response.dto.ts   (changed)
apps/backend/src/modules/products/product-rules.spec.ts   (changed)
apps/backend/src/modules/products/product-rules.ts   (changed)
apps/backend/src/modules/products/product-views.ts   (changed)
apps/backend/src/modules/products/products.service.ts   (changed)
apps/backend/src/setup/app.setup.ts   (changed)
apps/backend/test/fixtures/importer/README.md   (new)
apps/backend/test/fixtures/importer/digikala-dkp-13196935.json   (new)
apps/backend/test/fixtures/importer/digikala-dkp-18010600.json   (new)
apps/backend/test/fixtures/importer/microdata-product.html   (new)
apps/backend/test/fixtures/importer/shopify-product.html   (new)
apps/backend/test/fixtures/importer/woocommerce-product.html   (new)
apps/backend/test/health.e2e-spec.ts   (changed)
apps/backend/test/importer.e2e-spec.ts   (new)
apps/frontend/src/app/(store)/categories/[slug]/page.tsx   (changed)
apps/frontend/src/app/(store)/checkout/page.tsx   (changed)
apps/frontend/src/app/(store)/page.tsx   (changed)
apps/frontend/src/app/(store)/products/[slug]/page.tsx   (changed)
apps/frontend/src/app/customer/profile/page.tsx   (changed)
apps/frontend/src/app/globals.css   (changed)
apps/frontend/src/app/layout.tsx   (changed)
apps/frontend/src/app/status/page.tsx   (changed)
apps/frontend/src/app/vendor/disputes/[id]/page.tsx   (changed)
apps/frontend/src/app/vendor/products/[id]/page.tsx   (changed)
apps/frontend/src/app/vendor/products/new/page.tsx   (changed)
apps/frontend/src/app/vendor/register/page.tsx   (changed)
apps/frontend/src/components/auth/login-form.tsx   (changed)
apps/frontend/src/components/catalog/product-specifications.tsx   (new)
apps/frontend/src/components/disputes/dispute-view.tsx   (changed)
apps/frontend/src/components/layout/dashboard-shell.tsx   (changed)
apps/frontend/src/components/layout/header-bar.tsx   (changed)
apps/frontend/src/components/layout/site-footer.tsx   (changed)
apps/frontend/src/components/vendor/product-import-panel.tsx   (new)
apps/frontend/src/components/vendor/specification-editor.tsx   (new)
apps/frontend/src/lib/api/client.ts   (changed)
apps/frontend/src/lib/api/error-messages.ts   (changed)
apps/frontend/src/lib/api/types.ts   (changed)
apps/frontend/src/lib/brand.ts   (new)
apps/frontend/src/lib/product-specs.test.ts   (new)
apps/frontend/src/lib/product-specs.ts   (new)
deploy/nginx/templates/shopino.conf.template   (changed)
docs/importer-verification.md   (new)
```

## Complete file contents

### `apps/backend/package.json`

```json
{
  "name": "@shopino/backend",
  "version": "0.1.0",
  "private": true,
  "description": "Shopino API — NestJS (Fastify adapter) application",
  "license": "UNLICENSED",
  "scripts": {
    "dev": "pnpm run db:generate && dotenv -e ../../.env -- nest start --watch",
    "build": "pnpm run db:generate && nest build",
    "start": "dotenv -e ../../.env -- node dist/main.js",
    "typecheck": "pnpm run db:generate && tsc --noEmit -p tsconfig.json",
    "lint": "eslint \"src/**/*.ts\" \"test/**/*.ts\" \"scripts/**/*.ts\" \"prisma/**/*.ts\"",
    "test": "jest --config jest.config.js --runInBand",
    "test:e2e": "jest --config ./test/jest-e2e.json",
    "prisma:generate": "pnpm run db:generate",
    "db:validate": "dotenv -e ../../.env -- prisma validate",
    "db:migrate": "dotenv -e ../../.env -- prisma migrate dev",
    "db:deploy": "dotenv -e ../../.env -- prisma migrate deploy",
    "db:push": "dotenv -e ../../.env -- prisma db push",
    "db:seed": "dotenv -e ../../.env -- ts-node --project tsconfig.json prisma/seed.ts",
    "db:reset": "dotenv -e ../../.env -- prisma migrate reset --force --skip-generate",
    "db:studio": "dotenv -e ../../.env -- prisma studio",
    "verify:connections": "dotenv -e ../../.env -- ts-node --project tsconfig.json scripts/verify-connections.ts",
    "verify:seed": "dotenv -e ../../.env -- ts-node --project tsconfig.json scripts/verify-seed.ts",
    "verify:http": "dotenv -e ../../.env -- ts-node --project tsconfig.json scripts/smoke-http.ts",
    "clean": "rm -rf dist coverage",
    "db:generate": "dotenv -e ../../.env -- prisma generate",
    "verify:auth": "dotenv -e ../../.env -- ts-node --project tsconfig.json scripts/smoke-auth.ts"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.1141.0",
    "@fastify/multipart": "^10.1.2",
    "@fastify/static": "^10.1.4",
    "@nestjs/common": "^11.2.6",
    "@nestjs/config": "^4.0.4",
    "@nestjs/core": "^11.2.6",
    "@nestjs/jwt": "^11.0.2",
    "@nestjs/platform-fastify": "^11.2.6",
    "@nestjs/swagger": "^11.4.7",
    "@nestjs/terminus": "^11.1.1",
    "@node-rs/argon2": "^2.2.1",
    "@prisma/client": "^6.19.3",
    "class-transformer": "^0.5.1",
    "class-validator": "^0.14.4",
    "fastify": "^5.12.5",
    "ioredis": "^5.11.1",
    "node-html-parser": "^7.1.0",
    "reflect-metadata": "^0.2.2",
    "rxjs": "^7.8.2",
    "sharp": "^0.35.4"
  },
  "devDependencies": {
    "@eslint/js": "^9.39.5",
    "@nestjs/cli": "^11.0.24",
    "@nestjs/schematics": "^11.1.0",
    "@nestjs/testing": "^11.2.6",
    "@shopino/config": "workspace:*",
    "@types/jest": "^29.5.14",
    "@types/node": "^20.19.43",
    "@types/supertest": "^6.0.3",
    "dotenv": "^16.4.7",
    "dotenv-cli": "^8.0.0",
    "eslint": "^9.39.5",
    "form-data": "^4.0.6",
    "jest": "^29.7.0",
    "prisma": "^6.19.3",
    "supertest": "^7.3.0",
    "ts-jest": "^29.4.13",
    "ts-node": "^10.9.2",
    "tsconfig-paths": "^4.2.0",
    "typescript": "5.9.3",
    "typescript-eslint": "^8.70.1"
  },
  "engines": {
    "node": ">=22.0.0"
  },
  "prisma": {
    "seed": "ts-node --project tsconfig.json prisma/seed.ts"
  }
}
```

### `apps/backend/prisma/migrations/20261002090000_importer_specs_branding/migration.sql`

```sql
-- Feature add-on: product specifications (importer) + platform rebranding.
--
-- 1. `product_specifications`: key/value technical specs per product. Additive;
--    no existing row changes. Rows die with their product (ON DELETE CASCADE),
--    exactly like variants and gallery entries.
-- 2. `platform.name` becomes «شاگردم». Only the untouched default «شاپینو» is
--    rewritten, so a name an operator already customised is never overwritten.

CREATE TABLE "product_specifications" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "group_title" VARCHAR(100),
    "title" VARCHAR(150) NOT NULL,
    "value" VARCHAR(2000) NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_specifications_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "product_specifications_title_check" CHECK (char_length(btrim("title")) > 0),
    CONSTRAINT "product_specifications_value_check" CHECK (char_length(btrim("value")) > 0),
    CONSTRAINT "product_specifications_group_title_check" CHECK ("group_title" IS NULL OR char_length(btrim("group_title")) > 0)
);

CREATE INDEX "product_specifications_product_id_sort_order_idx" ON "product_specifications"("product_id", "sort_order");

ALTER TABLE "product_specifications" ADD CONSTRAINT "product_specifications_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "system_configs"
   SET "value" = 'شاگردم', "updated_at" = CURRENT_TIMESTAMP
 WHERE "key" = 'platform.name' AND "value" = 'شاپینو';
```

### `apps/backend/prisma/schema.prisma`

```prisma
// ============================================================================
// Shopino — Prisma schema
// Phase 2: complete marketplace + banking-credit (BNPL) data model
// ----------------------------------------------------------------------------
// Conventions applied throughout this file:
//
//  • Primary keys   — uuid v4 (`@default(uuid())`), stored as PostgreSQL UUID.
//  • Money          — `Decimal(15, 2)`, never floating point. The unit follows
//                     `platform.currency` in SystemConfig (IRR = Rial).
//  • Percentages    — `Decimal(5, 2)` (0.00–100.00).
//  • Timestamps     — `timestamptz(3)`. Mutable rows carry `createdAt` +
//                     `@updatedAt`; append-only rows (ledgers, audit trail,
//                     order lines) carry `createdAt` only, because rewriting
//                     them would destroy their evidential value.
//  • Foreign keys   — every relation declares `onDelete` explicitly:
//                       Cascade  → the child cannot exist without the parent
//                                  (order lines, cart lines, media, evidence),
//                       Restrict → financial/legal records that must never be
//                                  orphaned or silently disappear (payments,
//                                  ledger entries, settlements),
//                       SetNull  → optional back-references that may outlive
//                                  their target (ledger → order link).
//  • Table names    — snake_case plural (`@@map`), columns snake_case (`@map`).
//
// The schema is applied exclusively through migrations
// (`prisma migrate dev` / `prisma migrate deploy`); see README §5.
// ============================================================================

generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")
}

// ============================================================================
// 1. IDENTITY, ACCESS & AUDIT
// ============================================================================

/// Platform identity. One row per human, whatever their role.
enum UserRole {
  SUPER_ADMIN
  ADMIN
  VENDOR
  CUSTOMER
  FINANCIAL_OFFICER
  SUPPORT
}

enum Gender {
  MALE
  FEMALE
  OTHER
}

/// Actions recorded in the immutable audit trail.
enum AuditAction {
  CREATE
  UPDATE
  DELETE
  LOGIN
  LOGOUT
  STATUS_CHANGE
  SETTLEMENT_TRIGGER
  PAYMENT_CAPTURE
  CREDIT_DECISION
  DISPUTE_RESOLUTION
}

/// Platform user. `mobile` is the primary business key: it is mandatory, unique
/// and the identifier customers register with. `email` and `nationalCode` are
/// optional but unique when present (they are required later in the process for
/// vendors and credit applicants).
model User {
  id           String    @id @default(uuid()) @db.Uuid
  mobile       String    @unique @db.VarChar(15)
  email        String?   @unique @db.VarChar(254)
  nationalCode String?   @unique @map("national_code") @db.VarChar(10)
  fullName     String    @map("full_name") @db.VarChar(120)
  role         UserRole  @default(CUSTOMER)
  isActive     Boolean   @default(true) @map("is_active")
  /// Argon2id hash. Nullable because OTP-only customer accounts exist before a
  /// password is ever set; staff accounts always have one (enforced by the
  /// authentication phase).
  passwordHash String?   @map("password_hash") @db.VarChar(255)
  lastLoginAt  DateTime? @map("last_login_at") @db.Timestamptz(3)
  createdAt    DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  customerProfile       CustomerProfile?
  addresses             Address[]
  vendor                Vendor?
  auditLogs             AuditLog[]
  carts                 Cart[]
  parentOrders          ParentOrder[]
  creditAccounts        CreditAccount[]
  creditApplications    CreditApplication[]
  disputesRaised        Dispute[]
  disputeEvidence       DisputeEvidence[]
  disputesResponded     Dispute[]               @relation("DisputeVendorResponder")
  disputesResolved      Dispute[]               @relation("DisputeResolver")
  disputeEvents         DisputeEvent[]
  verificationsReview   VendorVerification[]    @relation("VerificationReviewer")
  mediaAssets           MediaAsset[]            @relation("MediaAssetOwner")
  settlementsProcessed  SettlementRequest[]     @relation("SettlementProcessor")
  subOrderStatusChanges SubOrderStatusHistory[] @relation("SubOrderStatusActor")
  productsBlocked       Product[]               @relation("ProductBlockedBy")

  @@index([role, isActive])
  @@index([createdAt])
  @@map("users")
}

/// Role-specific customer data. Absent for staff and for vendors.
model CustomerProfile {
  id               String    @id @default(uuid()) @db.Uuid
  userId           String    @unique @map("user_id") @db.Uuid
  user             User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  birthDate        DateTime? @map("birth_date") @db.Date
  gender           Gender?
  /// Sheba/IBAN: "IR" + 24 digits.
  bankIban         String?   @map("bank_iban") @db.VarChar(26)
  defaultAddressId String?   @unique @map("default_address_id") @db.Uuid
  defaultAddress   Address?  @relation("CustomerDefaultAddress", fields: [defaultAddressId], references: [id], onDelete: SetNull)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("customer_profiles")
}

/// Delivery address of a user. Rows are kept even when no longer default, so
/// historical orders can still explain where they were shipped.
model Address {
  id              String   @id @default(uuid()) @db.Uuid
  userId          String   @map("user_id") @db.Uuid
  user            User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  province        String   @db.VarChar(60)
  city            String   @db.VarChar(60)
  postalAddress   String   @map("postal_address") @db.Text
  postalCode      String   @map("postal_code") @db.VarChar(10)
  buildingNumber  String?  @map("building_number") @db.VarChar(20)
  unitNumber      String?  @map("unit_number") @db.VarChar(20)
  recipientName   String   @map("recipient_name") @db.VarChar(120)
  recipientMobile String   @map("recipient_mobile") @db.VarChar(15)
  isDefault       Boolean  @default(false) @map("is_default")
  createdAt       DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  defaultForProfile CustomerProfile? @relation("CustomerDefaultAddress")

  @@index([userId, isDefault])
  @@index([userId, createdAt])
  @@map("addresses")
}

/// Append-only audit trail. Rows are never updated or deleted: `oldValue` /
/// `newValue` capture the state transition, and the pair (entityName, entityId)
/// is the query path for "history of this record".
model AuditLog {
  id         String      @id @default(uuid()) @db.Uuid
  userId     String?     @map("user_id") @db.Uuid
  user       User?       @relation(fields: [userId], references: [id], onDelete: SetNull)
  action     AuditAction
  entityName String      @map("entity_name") @db.VarChar(80)
  entityId   String?     @map("entity_id") @db.VarChar(64)
  ipAddress  String?     @map("ip_address") @db.VarChar(45)
  userAgent  String?     @map("user_agent") @db.VarChar(512)
  oldValue   Json?       @map("old_value")
  newValue   Json?       @map("new_value")
  createdAt  DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([entityName, entityId])
  @@index([userId, createdAt])
  @@index([action, createdAt])
  @@map("audit_logs")
}

// ============================================================================
// 2. VENDOR MANAGEMENT & VERIFICATION
// ============================================================================

enum VendorStatus {
  PENDING
  APPROVED
  REJECTED
  SUSPENDED
}

/// A store operating on the marketplace. Created together with its owner User
/// (role VENDOR); `verifiedAt` is stamped only when a reviewer approves the
/// verification documents.
model Vendor {
  id                     String       @id @default(uuid()) @db.Uuid
  userId                 String       @unique @map("user_id") @db.Uuid
  user                   User         @relation(fields: [userId], references: [id], onDelete: Restrict)
  storeName              String       @map("store_name") @db.VarChar(120)
  storeSlug              String       @unique @map("store_slug") @db.VarChar(140)
  instagramHandle        String?      @map("instagram_handle") @db.VarChar(60)
  logoUrl                String?      @map("logo_url") @db.VarChar(512)
  bio                    String?      @db.Text
  bankIban               String       @map("bank_iban") @db.VarChar(26)
  /// Legal name of the account holder; payouts must match the IBAN holder.
  bankAccountHolder      String?      @map("bank_account_holder") @db.VarChar(120)
  /// Vendor-specific commission; when null, the category rate applies.
  commissionRateOverride Decimal?     @map("commission_rate_override") @db.Decimal(5, 2)
  /// Flat shipping fee for this store's packages; null = platform default.
  shippingFeeOverride    Decimal?     @map("shipping_fee_override") @db.Decimal(15, 2)
  /// Package subtotal at which this store ships for free; null = platform default, 0 = never free.
  freeShippingThreshold  Decimal?     @map("free_shipping_threshold") @db.Decimal(15, 2)
  status                 VendorStatus @default(PENDING)
  verifiedAt             DateTime?    @map("verified_at") @db.Timestamptz(3)
  createdAt              DateTime     @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt              DateTime     @updatedAt @map("updated_at") @db.Timestamptz(3)

  verifications      VendorVerification[]
  mediaAssets        MediaAsset[]         @relation("VendorMediaAssets")
  products           Product[]
  subOrders          SubOrder[]
  disputes           Dispute[]
  wallet             VendorWallet?
  settlementRequests SettlementRequest[]

  @@index([status])
  @@index([status, createdAt])
  @@map("vendors")
}

/// Verification dossier of a vendor. A vendor may have several rows over time
/// (resubmission after a rejection); the review outcome is recorded per row.
model VendorVerification {
  id                  String    @id @default(uuid()) @db.Uuid
  vendorId            String    @map("vendor_id") @db.Uuid
  vendor              Vendor    @relation(fields: [vendorId], references: [id], onDelete: Cascade)
  nationalCardDocUrl  String    @map("national_card_doc_url") @db.VarChar(512)
  businessDocUrl      String?   @map("business_doc_url") @db.VarChar(512)
  /// Proof that the declared IBAN belongs to the store owner (bank statement / cheque).
  bankAccountProofUrl String?   @map("bank_account_proof_url") @db.VarChar(512)
  rejectionReason     String?   @map("rejection_reason") @db.Text
  reviewedByUserId    String?   @map("reviewed_by_user_id") @db.Uuid
  reviewedBy          User?     @relation("VerificationReviewer", fields: [reviewedByUserId], references: [id], onDelete: SetNull)
  reviewedAt          DateTime? @map("reviewed_at") @db.Timestamptz(3)
  createdAt           DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([vendorId, createdAt])
  @@index([reviewedByUserId])
  @@map("vendor_verifications")
}

// ============================================================================
// 3. CATALOG, HIERARCHICAL CATEGORIES & VARIANTS
// ============================================================================

/// Self-referencing category tree. `defaultCommissionRate` is the platform's
/// commission for products in this category unless the vendor has an override.
model Category {
  id                    String     @id @default(uuid()) @db.Uuid
  parentId              String?    @map("parent_id") @db.Uuid
  parent                Category?  @relation("CategoryTree", fields: [parentId], references: [id], onDelete: SetNull)
  children              Category[] @relation("CategoryTree")
  slug                  String     @unique @db.VarChar(80)
  titleFa               String     @map("title_fa") @db.VarChar(120)
  titleEn               String?    @map("title_en") @db.VarChar(120)
  defaultCommissionRate Decimal    @default(0) @map("default_commission_rate") @db.Decimal(5, 2)
  sortOrder             Int        @default(0) @map("sort_order")
  isActive              Boolean    @default(true) @map("is_active")
  createdAt             DateTime   @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime   @updatedAt @map("updated_at") @db.Timestamptz(3)

  products Product[]

  @@index([parentId, sortOrder])
  @@index([isActive])
  @@map("categories")
}

/// A product published by exactly one vendor. `basePrice` is the display price;
/// the price actually charged is the selected variant's `price`.
model Product {
  id               String    @id @default(uuid()) @db.Uuid
  vendorId         String    @map("vendor_id") @db.Uuid
  vendor           Vendor    @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  categoryId       String    @map("category_id") @db.Uuid
  category         Category  @relation(fields: [categoryId], references: [id], onDelete: Restrict)
  title            String    @db.VarChar(200)
  slug             String    @unique @db.VarChar(220)
  description      String?   @db.Text
  brand            String?   @db.VarChar(80)
  basePrice        Decimal   @map("base_price") @db.Decimal(15, 2)
  /// Vendor-controlled visibility. Cannot be switched on while `isBlockedByAdmin` is true.
  isPublished      Boolean   @default(false) @map("is_published")
  /// Staff moderation flag: a blocked product is never public, whatever the vendor sets.
  isBlockedByAdmin Boolean   @default(false) @map("is_blocked_by_admin")
  blockedReason    String?   @map("blocked_reason") @db.VarChar(500)
  blockedAt        DateTime? @map("blocked_at") @db.Timestamptz(3)
  blockedByUserId  String?   @map("blocked_by_user_id") @db.Uuid
  blockedBy        User?     @relation("ProductBlockedBy", fields: [blockedByUserId], references: [id], onDelete: SetNull)
  createdAt        DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt        DateTime  @updatedAt @map("updated_at") @db.Timestamptz(3)

  variants       ProductVariant[]
  media          ProductMedia[]
  specifications ProductSpecification[]

  @@index([vendorId, isPublished])
  @@index([categoryId, isPublished])
  @@index([isPublished, createdAt])
  @@index([isPublished, isBlockedByAdmin, createdAt])
  /// pg_trgm GIN indexes: substring (ILIKE '%…%') search on Persian text.
  @@index([title(ops: raw("gin_trgm_ops"))], type: Gin, map: "products_title_trgm_idx")
  @@index([description(ops: raw("gin_trgm_ops"))], type: Gin, map: "products_description_trgm_idx")
  @@index([brand(ops: raw("gin_trgm_ops"))], type: Gin, map: "products_brand_trgm_idx")
  @@map("products")
}

/// Sellable unit of a product: the only thing that can be added to a cart or
/// referenced by an order line. `compareAtPrice` drives the "was/now" display.
model ProductVariant {
  id               String   @id @default(uuid()) @db.Uuid
  productId        String   @map("product_id") @db.Uuid
  product          Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  sku              String   @unique @db.VarChar(64)
  colorName        String?  @map("color_name") @db.VarChar(40)
  colorHex         String?  @map("color_hex") @db.VarChar(7)
  size             String?  @db.VarChar(20)
  guarantee        String?  @db.VarChar(60)
  price            Decimal  @db.Decimal(15, 2)
  compareAtPrice   Decimal? @map("compare_at_price") @db.Decimal(15, 2)
  /// On-hand units. DB CHECK: stock_quantity >= 0 AND reserved_quantity >= 0 AND reserved_quantity <= stock_quantity.
  stockQuantity    Int      @default(0) @map("stock_quantity")
  /// Units held by unfinished checkouts; sellable = stockQuantity - reservedQuantity.
  reservedQuantity Int      @default(0) @map("reserved_quantity")
  weightGrams      Int?     @map("weight_grams")
  isActive         Boolean  @default(true) @map("is_active")
  createdAt        DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt        DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  cartItems  CartItem[]
  orderItems OrderItem[]

  @@index([productId, isActive])
  @@index([isActive, price])
  @@map("product_variants")
}

/// Gallery of a product. Exactly one row should have `isPrimary = true`.
/// One stored file.
///
/// Every upload leaves a row here, so the platform always knows what exists in
/// the object store, who owns it and whether it may be served anonymously. It is
/// deliberately independent of `ProductMedia` (which links catalogue rows to
/// their images): logos, avatars and KYC documents are not catalogue data.
model MediaAsset {
  id              String    @id @default(uuid()) @db.Uuid
  ownerUserId     String?   @map("owner_user_id") @db.Uuid
  owner           User?     @relation("MediaAssetOwner", fields: [ownerUserId], references: [id], onDelete: SetNull)
  vendorId        String?   @map("vendor_id") @db.Uuid
  vendor          Vendor?   @relation("VendorMediaAssets", fields: [vendorId], references: [id], onDelete: SetNull)
  kind            MediaKind
  /// Business purpose, e.g. `store_logo`, `avatar`, `kyc_national_id`.
  purpose         String    @db.VarChar(60)
  /// Which provider wrote the file, so a migration between providers is traceable.
  storageProvider String    @map("storage_provider") @db.VarChar(20)
  /// Provider-relative object key. Unique: one file, one row.
  path            String    @unique @db.VarChar(512)
  thumbnailPath   String?   @map("thumbnail_path") @db.VarChar(512)
  url             String    @db.VarChar(1024)
  thumbnailUrl    String?   @map("thumbnail_url") @db.VarChar(1024)
  mimeType        String    @map("mime_type") @db.VarChar(100)
  originalName    String?   @map("original_name") @db.VarChar(255)
  sizeBytes       Int       @map("size_bytes")
  width           Int?
  height          Int?
  /// Documents default to private: KYC material must never be world-readable.
  isPublic        Boolean   @default(false) @map("is_public")
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(3)

  productMedia    ProductMedia[]
  disputeEvidence DisputeEvidence[]

  @@index([ownerUserId, kind, createdAt])
  @@index([vendorId, purpose])
  @@index([kind, isPublic, createdAt])
  @@map("media_assets")
}

model ProductMedia {
  id           String      @id @default(uuid()) @db.Uuid
  productId    String      @map("product_id") @db.Uuid
  product      Product     @relation(fields: [productId], references: [id], onDelete: Cascade)
  /// The uploaded file (Phase-4 storage pipeline) this gallery entry was created from.
  mediaAssetId String?     @map("media_asset_id") @db.Uuid
  mediaAsset   MediaAsset? @relation(fields: [mediaAssetId], references: [id], onDelete: SetNull)
  url          String      @db.VarChar(512)
  thumbnailUrl String?     @map("thumbnail_url") @db.VarChar(512)
  isPrimary    Boolean     @default(false) @map("is_primary")
  sortOrder    Int         @default(0) @map("sort_order")
  createdAt    DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([productId, sortOrder])
  @@index([mediaAssetId])
  @@map("product_media")
}

/// One technical-specification row of a product (key/value, optionally grouped),
/// e.g. group «حافظه» › «حافظه داخلی» = «256 گیگابایت». Typed by the vendor or
/// pre-filled by the product importer; the vendor's save is what persists it, and
/// an update replaces the whole list. DB CHECKs: non-blank title and value.
model ProductSpecification {
  id         String   @id @default(uuid()) @db.Uuid
  productId  String   @map("product_id") @db.Uuid
  product    Product  @relation(fields: [productId], references: [id], onDelete: Cascade)
  groupTitle String?  @map("group_title") @db.VarChar(100)
  title      String   @db.VarChar(150)
  value      String   @db.VarChar(2000)
  sortOrder  Int      @default(0) @map("sort_order")
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([productId, sortOrder])
  @@map("product_specifications")
}

// ============================================================================
// 4. CART, MULTI-VENDOR ORDER SPLITTING & LOGISTICS
// ============================================================================

/// What a stored file is. Images run through the Sharp pipeline; documents are
/// stored as received and are never publicly readable.
enum MediaKind {
  IMAGE
  DOCUMENT
}

enum PaymentMethod {
  CASH_IPG
  BANK_CREDIT
  HYBRID
}

enum ParentOrderPaymentStatus {
  PENDING
  PAID
  FAILED
  CANCELLED
}

enum SubOrderStatus {
  PENDING_APPROVAL
  PROCESSING
  SHIPPED
  DELIVERED
  CANCELLED
  REFUNDED
}

/// Shopping cart. Either owned by a registered user (`userId`) or anonymous
/// (`sessionToken`); both are unique so a cart is addressable by exactly one
/// key. The application layer guarantees one of the two is always set.
model Cart {
  id           String   @id @default(uuid()) @db.Uuid
  userId       String?  @unique @map("user_id") @db.Uuid
  user         User?    @relation(fields: [userId], references: [id], onDelete: Cascade)
  sessionToken String?  @unique @map("session_token") @db.VarChar(64)
  createdAt    DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt    DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  items CartItem[]

  @@index([updatedAt])
  @@map("carts")
}

/// One line of a cart. A variant appears at most once per cart: quantity changes
/// are an update, never a second row.
model CartItem {
  id                String         @id @default(uuid()) @db.Uuid
  cartId            String         @map("cart_id") @db.Uuid
  cart              Cart           @relation(fields: [cartId], references: [id], onDelete: Cascade)
  productVariantId  String         @map("product_variant_id") @db.Uuid
  productVariant    ProductVariant @relation(fields: [productVariantId], references: [id], onDelete: Cascade)
  quantity          Int
  /// Unit price the customer last saw for this line; checkout compares it with the live price.
  unitPriceSnapshot Decimal        @map("unit_price_snapshot") @db.Decimal(15, 2)
  createdAt         DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@unique([cartId, productVariantId])
  @@index([productVariantId])
  @@map("cart_items")
}

/// A customer checkout, which may span several vendors. Totals here are the
/// authoritative amounts for payment; per-vendor money lives on SubOrder.
/// `shippingAddressSnapshot` freezes the delivery address at checkout time so a
/// later address edit cannot rewrite order history.
model ParentOrder {
  id                      String                   @id @default(uuid()) @db.Uuid
  orderNumber             String                   @unique @map("order_number") @db.VarChar(20)
  userId                  String                   @map("user_id") @db.Uuid
  user                    User                     @relation(fields: [userId], references: [id], onDelete: Restrict)
  shippingAddressSnapshot Json                     @map("shipping_address_snapshot")
  totalItemsAmount        Decimal                  @map("total_items_amount") @db.Decimal(15, 2)
  totalShippingFee        Decimal                  @default(0) @map("total_shipping_fee") @db.Decimal(15, 2)
  totalDiscountAmount     Decimal                  @default(0) @map("total_discount_amount") @db.Decimal(15, 2)
  finalPayableAmount      Decimal                  @map("final_payable_amount") @db.Decimal(15, 2)
  paymentMethod           PaymentMethod            @map("payment_method")
  paymentStatus           ParentOrderPaymentStatus @default(PENDING) @map("payment_status")
  customerNote            String?                  @map("customer_note") @db.VarChar(500)
  /// Unpaid orders are cancelled (and their reservations released) after this instant.
  paymentExpiresAt        DateTime?                @map("payment_expires_at") @db.Timestamptz(3)
  paidAt                  DateTime?                @map("paid_at") @db.Timestamptz(3)
  cancelledAt             DateTime?                @map("cancelled_at") @db.Timestamptz(3)
  cancellationReason      String?                  @map("cancellation_reason") @db.VarChar(500)
  createdAt               DateTime                 @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt               DateTime                 @updatedAt @map("updated_at") @db.Timestamptz(3)

  subOrders            SubOrder[]
  payments             Payment[]
  creditTransactions   CreditTransaction[]
  installmentSchedules InstallmentSchedule[]

  @@index([userId, createdAt])
  @@index([paymentStatus, createdAt])
  @@index([paymentStatus, paymentExpiresAt])
  @@index([createdAt])
  @@map("parent_orders")
}

/// Per-vendor slice of a parent order. Carries the money split: what the vendor
/// earns (`vendorEarningsAmount`) versus what the platform keeps
/// (`platformCommissionAmount`).
model SubOrder {
  id                       String         @id @default(uuid()) @db.Uuid
  parentOrderId            String         @map("parent_order_id") @db.Uuid
  parentOrder              ParentOrder    @relation(fields: [parentOrderId], references: [id], onDelete: Cascade)
  vendorId                 String         @map("vendor_id") @db.Uuid
  vendor                   Vendor         @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  subOrderNumber           String         @unique @map("sub_order_number") @db.VarChar(24)
  itemsSubtotal            Decimal        @map("items_subtotal") @db.Decimal(15, 2)
  shippingFee              Decimal        @default(0) @map("shipping_fee") @db.Decimal(15, 2)
  platformCommissionAmount Decimal        @map("platform_commission_amount") @db.Decimal(15, 2)
  vendorEarningsAmount     Decimal        @map("vendor_earnings_amount") @db.Decimal(15, 2)
  status                   SubOrderStatus @default(PENDING_APPROVAL)
  trackingCode             String?        @map("tracking_code") @db.VarChar(40)
  carrierName              String?        @map("carrier_name") @db.VarChar(80)
  shippedAt                DateTime?      @map("shipped_at") @db.Timestamptz(3)
  deliveredAt              DateTime?      @map("delivered_at") @db.Timestamptz(3)
  cancelledAt              DateTime?      @map("cancelled_at") @db.Timestamptz(3)
  cancellationReason       String?        @map("cancellation_reason") @db.VarChar(500)
  /// Set when the escrowed amount moves from pendingBalance to withdrawable.
  escrowReleasedAt         DateTime?      @map("escrow_released_at") @db.Timestamptz(3)
  createdAt                DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  items              OrderItem[]
  walletTransactions WalletTransaction[]
  disputes           Dispute[]
  statusHistory      SubOrderStatusHistory[]

  @@index([parentOrderId])
  @@index([vendorId, status, createdAt])
  @@index([status, createdAt])
  @@map("sub_orders")
}

/// Append-only timeline of sub-order status changes (who, when, why).
model SubOrderStatusHistory {
  id          String          @id @default(uuid()) @db.Uuid
  subOrderId  String          @map("sub_order_id") @db.Uuid
  subOrder    SubOrder        @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
  fromStatus  SubOrderStatus? @map("from_status")
  toStatus    SubOrderStatus  @map("to_status")
  /// Null for system transitions (payment timeout, gateway callbacks).
  actorUserId String?         @map("actor_user_id") @db.Uuid
  actorUser   User?           @relation("SubOrderStatusActor", fields: [actorUserId], references: [id], onDelete: SetNull)
  actorRole   String          @map("actor_role") @db.VarChar(20)
  note        String?         @db.VarChar(500)
  createdAt   DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([subOrderId, createdAt])
  @@map("sub_order_status_history")
}

/// Immutable order line. Every value that can change later (title, variant,
/// price, discount, commission) is captured as a snapshot at placement time, so
/// editing a product never rewrites history. `productVariantId` is nullable with
/// SET NULL: the line survives even if the variant is removed from the catalog.
model OrderItem {
  id                      String          @id @default(uuid()) @db.Uuid
  subOrderId              String          @map("sub_order_id") @db.Uuid
  subOrder                SubOrder        @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
  productVariantId        String?         @map("product_variant_id") @db.Uuid
  productVariant          ProductVariant? @relation(fields: [productVariantId], references: [id], onDelete: SetNull)
  productTitleSnapshot    String          @map("product_title_snapshot") @db.VarChar(200)
  vendorStoreNameSnapshot String          @map("vendor_store_name_snapshot") @db.VarChar(120)
  /// SKU at checkout; the variant row may later change or disappear.
  skuSnapshot             String          @map("sku_snapshot") @db.VarChar(64)
  /// { colorName, colorHex, size, guarantee } captured at checkout.
  variantDetailsSnapshot  Json            @map("variant_details_snapshot")
  unitPriceSnapshot       Decimal         @map("unit_price_snapshot") @db.Decimal(15, 2)
  discountSnapshot        Decimal         @default(0) @map("discount_snapshot") @db.Decimal(15, 2)
  commissionRateSnapshot  Decimal         @map("commission_rate_snapshot") @db.Decimal(5, 2)
  quantity                Int
  totalLineAmount         Decimal         @map("total_line_amount") @db.Decimal(15, 2)
  createdAt               DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([subOrderId])
  @@index([productVariantId])
  @@map("order_items")
}

// ============================================================================
// 5. PAYMENTS, ESCROW & VENDOR SETTLEMENTS
// ============================================================================

enum PaymentPurpose {
  ORDER_CHECKOUT
  INSTALLMENT_REPAYMENT
}

enum PaymentStatus {
  INITIATED
  SUCCESSFUL
  FAILED
  REFUNDED
}

enum WalletTransactionType {
  CREDIT_SALE_ESCROW_HOLD
  ESCROW_RELEASE_TO_WITHDRAWABLE
  COMMISSION_DEDUCTION
  SETTLEMENT_PAYOUT
  REFUND_DEDUCTION
  /// Withdrawable → settlement hold when a vendor requests a payout.
  SETTLEMENT_HOLD
  /// Settlement hold → withdrawable when finance rejects the request.
  SETTLEMENT_HOLD_RELEASE
  /// Escrow (PENDING) or WITHDRAWABLE → DISPUTE_HOLD when a customer opens a dispute (Phase 9).
  DISPUTE_HOLD_LOCK
  /// DISPUTE_HOLD → WITHDRAWABLE (vendor favour) or back to its source bucket (dispute cancelled).
  DISPUTE_HOLD_RELEASE
}

/// Balance bucket of a vendor wallet a ledger row moves money in.
enum WalletBalanceBucket {
  PENDING
  WITHDRAWABLE
  SETTLEMENT_HOLD
  /// Earnings frozen while a dispute about the package is open (Phase 9).
  DISPUTE_HOLD
}

enum SettlementStatus {
  REQUESTED
  PROCESSING
  PAID_PAYA
  REJECTED
}

/// Payment attempt against a parent order. A hybrid order settles partly from
/// the customer's wallet/IPG (`cashAmount`) and partly from bank credit
/// (`creditAmount`); the two always add up to the order's final payable amount.
/// `gatewayName` is a string, not an enum: gateways are configuration, and
/// adding one must not require a migration.
model Payment {
  id                    String               @id @default(uuid()) @db.Uuid
  parentOrderId         String               @map("parent_order_id") @db.Uuid
  parentOrder           ParentOrder          @relation(fields: [parentOrderId], references: [id], onDelete: Restrict)
  /// What the money is for: the order itself, or one instalment of a BNPL order.
  purpose               PaymentPurpose       @default(ORDER_CHECKOUT)
  /// How this attempt splits the amount (CASH_IPG = card only, BANK_CREDIT = credit only, HYBRID = both).
  paymentMethod         PaymentMethod        @default(CASH_IPG) @map("payment_method")
  /// Credit line used by a BANK_CREDIT / HYBRID attempt.
  creditAccountId       String?              @map("credit_account_id") @db.Uuid
  creditAccount         CreditAccount?       @relation(fields: [creditAccountId], references: [id], onDelete: Restrict)
  /// Instalment plan chosen for the credit part.
  installmentPlanId     String?              @map("installment_plan_id") @db.Uuid
  installmentPlan       InstallmentPlan?     @relation(fields: [installmentPlanId], references: [id], onDelete: Restrict)
  /// Provider reservation reference of the credit part (reserve → commit | release).
  creditReservationRef  String?              @map("credit_reservation_ref") @db.VarChar(80)
  /// The instalment an INSTALLMENT_REPAYMENT payment settles.
  installmentScheduleId String?              @map("installment_schedule_id") @db.Uuid
  installmentSchedule   InstallmentSchedule? @relation(fields: [installmentScheduleId], references: [id], onDelete: Restrict)
  gatewayName           String               @map("gateway_name") @db.VarChar(40)
  gatewayTrackingToken  String?              @map("gateway_tracking_token") @db.VarChar(120)
  bankRrn               String?              @map("bank_rrn") @db.VarChar(40)
  cashAmount            Decimal              @default(0) @map("cash_amount") @db.Decimal(15, 2)
  creditAmount          Decimal              @default(0) @map("credit_amount") @db.Decimal(15, 2)
  status                PaymentStatus        @default(INITIATED)
  paidAt                DateTime?            @map("paid_at") @db.Timestamptz(3)
  metadata              Json?
  createdAt             DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime             @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([parentOrderId, status])
  @@index([status, createdAt])
  @@index([gatewayTrackingToken])
  @@index([installmentScheduleId, status])
  @@index([creditAccountId])
  @@map("payments")
}

/// Escrow wallet of a vendor. The balance columns are the projection of the
/// ledger (`WalletTransaction`), maintained in the same database transaction as
/// every ledger write, one column per ledger bucket:
///   pendingBalance         — PENDING bucket: vendor earnings of paid packages
///                            that are not delivered yet (escrow),
///   withdrawableBalance    — WITHDRAWABLE bucket: released, requestable,
///   settlementHoldBalance  — SETTLEMENT_HOLD bucket: reserved by open
///                            settlement requests awaiting finance,
///   totalEarnedBalance     — earnings released on delivery (minus refunds of
///                            delivered packages),
///   totalWithdrawnAmount   — lifetime amount paid out by PAYA.
/// CHECK constraints keep every balance >= 0 (migration phase7_finance).
model VendorWallet {
  id                    String   @id @default(uuid()) @db.Uuid
  vendorId              String   @unique @map("vendor_id") @db.Uuid
  vendor                Vendor   @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  pendingBalance        Decimal  @default(0) @map("pending_balance") @db.Decimal(15, 2)
  withdrawableBalance   Decimal  @default(0) @map("withdrawable_balance") @db.Decimal(15, 2)
  settlementHoldBalance Decimal  @default(0) @map("settlement_hold_balance") @db.Decimal(15, 2)
  /// Earnings frozen by open disputes; never withdrawable (Phase 9).
  disputeHoldBalance    Decimal  @default(0) @map("dispute_hold_balance") @db.Decimal(15, 2)
  totalEarnedBalance    Decimal  @default(0) @map("total_earned_balance") @db.Decimal(15, 2)
  totalWithdrawnAmount  Decimal  @default(0) @map("total_withdrawn_amount") @db.Decimal(15, 2)
  createdAt             DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt             DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  transactions WalletTransaction[]

  @@index([updatedAt])
  @@map("vendor_wallets")
}

/// Append-only wallet ledger. Every row moves money in exactly one bucket of
/// the wallet: `amount` is the signed change (negative = debit) and
/// `balanceAfter` is that bucket's balance right after the row, so for every
/// wallet and bucket SUM(amount) equals the wallet column. A transfer between
/// two buckets (escrow release, settlement hold/release) is written as a pair
/// of rows with the same type that sum to zero.
/// Partial unique indexes (migration phase7_finance) make each sub-order and
/// settlement movement happen at most once per type and bucket.
model WalletTransaction {
  id                  String                @id @default(uuid()) @db.Uuid
  walletId            String                @map("wallet_id") @db.Uuid
  wallet              VendorWallet          @relation(fields: [walletId], references: [id], onDelete: Cascade)
  subOrderId          String?               @map("sub_order_id") @db.Uuid
  subOrder            SubOrder?             @relation(fields: [subOrderId], references: [id], onDelete: SetNull)
  settlementRequestId String?               @map("settlement_request_id") @db.Uuid
  settlementRequest   SettlementRequest?    @relation(fields: [settlementRequestId], references: [id], onDelete: SetNull)
  /// Dispute whose freeze / resolution produced this row (Phase 9).
  disputeId           String?               @map("dispute_id") @db.Uuid
  dispute             Dispute?              @relation(fields: [disputeId], references: [id], onDelete: SetNull)
  type                WalletTransactionType
  bucket              WalletBalanceBucket
  amount              Decimal               @db.Decimal(15, 2)
  balanceAfter        Decimal               @map("balance_after") @db.Decimal(15, 2)
  description         String?               @db.VarChar(255)
  createdAt           DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([walletId, createdAt])
  @@index([walletId, bucket])
  @@index([subOrderId])
  @@index([settlementRequestId])
  @@index([disputeId])
  @@map("wallet_transactions")
}

/// Vendor payout request. `amount` is validated against the wallet's
/// withdrawable balance by the settlement service; `processedByUserId` records
/// which staff member authorised the bank transfer (PAYA).
model SettlementRequest {
  id                String           @id @default(uuid()) @db.Uuid
  vendorId          String           @map("vendor_id") @db.Uuid
  vendor            Vendor           @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  amount            Decimal          @db.Decimal(15, 2)
  targetIban        String           @map("target_iban") @db.VarChar(26)
  status            SettlementStatus @default(REQUESTED)
  bankPayaReference String?          @map("bank_paya_reference") @db.VarChar(60)
  processedByUserId String?          @map("processed_by_user_id") @db.Uuid
  processedBy       User?            @relation("SettlementProcessor", fields: [processedByUserId], references: [id], onDelete: SetNull)
  processedAt       DateTime?        @map("processed_at") @db.Timestamptz(3)
  rejectionReason   String?          @map("rejection_reason") @db.VarChar(500)
  createdAt         DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime         @updatedAt @map("updated_at") @db.Timestamptz(3)

  walletTransactions WalletTransaction[]

  @@index([vendorId, status, createdAt])
  @@index([status, createdAt])
  @@map("settlement_requests")
}

// ============================================================================
// 6. BANKING CREDIT, BNPL ENGINE & INSTALLMENTS
// ============================================================================

enum CreditAccountStatus {
  ACTIVE
  FROZEN
  CLOSED
}

enum CreditApplicationStatus {
  DRAFT
  PENDING_BANK_INQUIRY
  DOCS_REQUIRED
  APPROVED
  REJECTED
}

enum CreditTransactionType {
  CREDIT_ALLOCATION
  PURCHASE_RESERVE_HOLD
  PURCHASE_COMMIT
  RESERVATION_RELEASE
  INSTALLMENT_REPAYMENT_RESTORE
  REFUND_RESTORE
}

enum InstallmentStatus {
  PENDING
  PAID
  OVERDUE
  WAIVED
}

/// Bank or fintech partner that issues credit. `code` is the stable identifier
/// used by configuration (`SANDBOX_BANK`, `SAMAN_BANK`, `BLUBANK`, `DIGIPAY`);
/// `config` holds provider-specific settings (base URL, merchant id, …) so that
/// onboarding a provider is a data change, not a deploy.
model CreditProvider {
  id        String   @id @default(uuid()) @db.Uuid
  name      String   @db.VarChar(80)
  code      String   @unique @db.VarChar(40)
  isActive  Boolean  @default(false) @map("is_active")
  config    Json?
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt DateTime @updatedAt @map("updated_at") @db.Timestamptz(3)

  accounts         CreditAccount[]
  applications     CreditApplication[]
  installmentPlans InstallmentPlan[]

  @@index([isActive])
  @@map("credit_providers")
}

/// Credit line of a customer at one provider. `availableAmount` is stored (not
/// computed on read) because checkout must reject an over-limit purchase under a
/// row lock. The ledger (`CreditTransaction`) is the source of truth; the four
/// amounts are its maintained projection.
/// Invariant enforced by the credit service: available = total − used − reserved.
model CreditAccount {
  id              String              @id @default(uuid()) @db.Uuid
  userId          String              @map("user_id") @db.Uuid
  user            User                @relation(fields: [userId], references: [id], onDelete: Restrict)
  providerId      String              @map("provider_id") @db.Uuid
  provider        CreditProvider      @relation(fields: [providerId], references: [id], onDelete: Restrict)
  totalLimit      Decimal             @map("total_limit") @db.Decimal(15, 2)
  usedAmount      Decimal             @default(0) @map("used_amount") @db.Decimal(15, 2)
  reservedAmount  Decimal             @default(0) @map("reserved_amount") @db.Decimal(15, 2)
  availableAmount Decimal             @map("available_amount") @db.Decimal(15, 2)
  status          CreditAccountStatus @default(ACTIVE)
  expiresAt       DateTime?           @map("expires_at") @db.Timestamptz(3)
  createdAt       DateTime            @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt       DateTime            @updatedAt @map("updated_at") @db.Timestamptz(3)

  transactions         CreditTransaction[]
  installmentSchedules InstallmentSchedule[]
  payments             Payment[]

  @@unique([userId, providerId])
  @@index([userId, status])
  @@index([providerId, status])
  @@map("credit_accounts")
}

/// Loan application submitted to a provider. The bank's raw answer is stored in
/// `bankScoreResponse` for audit; `approvedLimit` is what the decision service
/// used when opening or updating the CreditAccount.
model CreditApplication {
  id                          String                  @id @default(uuid()) @db.Uuid
  userId                      String                  @map("user_id") @db.Uuid
  user                        User                    @relation(fields: [userId], references: [id], onDelete: Restrict)
  providerId                  String                  @map("provider_id") @db.Uuid
  provider                    CreditProvider          @relation(fields: [providerId], references: [id], onDelete: Restrict)
  requestedLimit              Decimal                 @map("requested_limit") @db.Decimal(15, 2)
  approvedLimit               Decimal?                @map("approved_limit") @db.Decimal(15, 2)
  status                      CreditApplicationStatus @default(DRAFT)
  bankApplicationTrackingCode String?                 @map("bank_application_tracking_code") @db.VarChar(60)
  bankScoreResponse           Json?                   @map("bank_score_response")
  /// Short machine-readable reason of a REJECTED decision (e.g. SCORE_BELOW_THRESHOLD).
  decisionReason              String?                 @map("decision_reason") @db.VarChar(120)
  decidedAt                   DateTime?               @map("decided_at") @db.Timestamptz(3)
  createdAt                   DateTime                @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                   DateTime                @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@index([userId, status, createdAt])
  @@index([providerId, status])
  @@index([bankApplicationTrackingCode])
  @@map("credit_applications")
}

/// Append-only credit ledger. Every movement of a credit line is one row; the
/// order or repayment that caused it is referenced by `parentOrderId` and
/// `referenceCode`. Balance semantics per type:
///   CREDIT_ALLOCATION                → available +amount (limit granted/increased)
///   PURCHASE_RESERVE_HOLD            → reserved +amount, available −amount
///   PURCHASE_COMMIT                  → reserved −amount, used +amount
///   RESERVATION_RELEASE              → reserved −amount, available +amount
///   INSTALLMENT_REPAYMENT_RESTORE    → used −amount, available +amount
///   REFUND_RESTORE                   → used −amount, available +amount
/// `amount` is always positive (the type carries the direction); `balanceAfter`
/// is the account's availableAmount after the movement. `referenceCode` is the
/// application id (allocation), the provider reservation ref (hold / commit /
/// release) or the instalment id (repayment); (type, referenceCode) is unique,
/// and a reservation ends at most once (commit XOR release) — migration phase8_credit.
model CreditTransaction {
  id              String                @id @default(uuid()) @db.Uuid
  creditAccountId String                @map("credit_account_id") @db.Uuid
  creditAccount   CreditAccount         @relation(fields: [creditAccountId], references: [id], onDelete: Restrict)
  parentOrderId   String?               @map("parent_order_id") @db.Uuid
  parentOrder     ParentOrder?          @relation(fields: [parentOrderId], references: [id], onDelete: SetNull)
  type            CreditTransactionType
  amount          Decimal               @db.Decimal(15, 2)
  balanceAfter    Decimal               @map("balance_after") @db.Decimal(15, 2)
  referenceCode   String                @map("reference_code") @db.VarChar(80)
  createdAt       DateTime              @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([creditAccountId, createdAt])
  @@index([parentOrderId])
  @@index([referenceCode])
  @@map("credit_transactions")
}

/// Productised instalment offer of a provider (3 × 0 %, 6 × …, 12 × …).
/// `penaltyRatePercentPerMonth` is the late-payment penalty applied per month of
/// delay, used when an InstallmentSchedule turns OVERDUE.
model InstallmentPlan {
  id                         String         @id @default(uuid()) @db.Uuid
  providerId                 String         @map("provider_id") @db.Uuid
  provider                   CreditProvider @relation(fields: [providerId], references: [id], onDelete: Restrict)
  title                      String         @db.VarChar(120)
  durationMonths             Int            @map("duration_months")
  interestRatePercent        Decimal        @map("interest_rate_percent") @db.Decimal(5, 2)
  penaltyRatePercentPerMonth Decimal        @map("penalty_rate_percent_per_month") @db.Decimal(5, 2)
  isActive                   Boolean        @default(true) @map("is_active")
  createdAt                  DateTime       @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt                  DateTime       @updatedAt @map("updated_at") @db.Timestamptz(3)

  payments Payment[]

  @@unique([providerId, durationMonths])
  @@index([providerId, isActive])
  @@map("installment_plans")
}

/// One instalment of a BNPL purchase. The full schedule is generated at
/// checkout inside the same transaction that commits the credit line, so the
/// customer's obligations and the credit ledger can never disagree.
/// (order, instalmentNumber) is unique: a schedule cannot contain duplicates.
model InstallmentSchedule {
  id                String            @id @default(uuid()) @db.Uuid
  parentOrderId     String            @map("parent_order_id") @db.Uuid
  parentOrder       ParentOrder       @relation(fields: [parentOrderId], references: [id], onDelete: Restrict)
  creditAccountId   String            @map("credit_account_id") @db.Uuid
  creditAccount     CreditAccount     @relation(fields: [creditAccountId], references: [id], onDelete: Restrict)
  installmentNumber Int               @map("installment_number")
  totalInstallments Int               @map("total_installments")
  dueDate           DateTime          @map("due_date") @db.Date
  principalAmount   Decimal           @map("principal_amount") @db.Decimal(15, 2)
  interestAmount    Decimal           @default(0) @map("interest_amount") @db.Decimal(15, 2)
  totalAmount       Decimal           @map("total_amount") @db.Decimal(15, 2)
  penaltyAmount     Decimal           @default(0) @map("penalty_amount") @db.Decimal(15, 2)
  paidAmount        Decimal           @default(0) @map("paid_amount") @db.Decimal(15, 2)
  status            InstallmentStatus @default(PENDING)
  paidAt            DateTime?         @map("paid_at") @db.Timestamptz(3)
  bankTransactionId String?           @map("bank_transaction_id") @db.VarChar(80)
  createdAt         DateTime          @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt         DateTime          @updatedAt @map("updated_at") @db.Timestamptz(3)

  payments Payment[]

  @@unique([parentOrderId, installmentNumber])
  @@index([creditAccountId, status])
  @@index([status, dueDate])
  @@map("installment_schedules")
}

// ============================================================================
// 7. DISPUTES & CUSTOMER SUPPORT
// ============================================================================

enum DisputeReason {
  WRONG_ITEM
  DAMAGED
  NOT_AS_DESCRIBED
  NOT_DELIVERED
  COUNTERFEIT
}

enum DisputeStatus {
  OPEN
  VENDOR_RESPONDED
  UNDER_ARBITRATION
  RESOLVED_BUYER_FAVOR
  RESOLVED_VENDOR_FAVOR
  CANCELLED
}

/// What the vendor answered to a dispute (Phase 9).
enum DisputeVendorAction {
  ACCEPT_RETURN
  REJECT_WITH_DEFENSE
}

/// Entries of a dispute's append-only timeline (Phase 9).
enum DisputeEventType {
  OPENED
  EVIDENCE_ADDED
  VENDOR_ACCEPTED_RETURN
  VENDOR_DEFENDED
  ARBITRATED_BUYER_FAVOR
  ARBITRATED_VENDOR_FAVOR
  CANCELLED_BY_CUSTOMER
  REFUND_NOTICE_SENT
  REFUND_NOTICE_FAILED
}

/// Complaint raised by a customer about one vendor's slice of an order.
/// Disputes live as long as the sub-order they belong to. At most one dispute
/// per sub-order is active (OPEN / VENDOR_RESPONDED / UNDER_ARBITRATION) —
/// enforced by a partial unique index (migration phase9_disputes).
///
/// Escrow freeze (Phase 9): on opening, the package's earnings move into the
/// vendor wallet's DISPUTE_HOLD bucket — from PENDING if not delivered yet, or
/// from WITHDRAWABLE (as much as is there) if already delivered. `holdSource`,
/// `holdAmount` and `holdShortfall` record exactly what was frozen, so the
/// resolution moves back or refunds precisely that amount.
model Dispute {
  id                      String               @id @default(uuid()) @db.Uuid
  subOrderId              String               @map("sub_order_id") @db.Uuid
  subOrder                SubOrder             @relation(fields: [subOrderId], references: [id], onDelete: Cascade)
  /// Store the dispute is against (denormalised from the sub-order for the vendor panel).
  vendorId                String               @map("vendor_id") @db.Uuid
  vendor                  Vendor               @relation(fields: [vendorId], references: [id], onDelete: Restrict)
  raisedByUserId          String               @map("raised_by_user_id") @db.Uuid
  raisedBy                User                 @relation(fields: [raisedByUserId], references: [id], onDelete: Restrict)
  reason                  DisputeReason
  description             String               @db.Text
  status                  DisputeStatus        @default(OPEN)
  /// Package status when the dispute was opened (PROCESSING / SHIPPED / DELIVERED).
  subOrderStatusAtOpen    SubOrderStatus       @map("sub_order_status_at_open")
  /// Bucket the frozen earnings came from: PENDING or WITHDRAWABLE; null when nothing could be frozen.
  holdSource              WalletBalanceBucket? @map("hold_source")
  holdAmount              Decimal              @default(0) @map("hold_amount") @db.Decimal(15, 2)
  /// Earnings that could not be frozen because the vendor had already withdrawn them.
  holdShortfall           Decimal              @default(0) @map("hold_shortfall") @db.Decimal(15, 2)
  vendorAction            DisputeVendorAction? @map("vendor_action")
  vendorDefenseNotes      String?              @map("vendor_defense_notes") @db.Text
  vendorRespondedAt       DateTime?            @map("vendor_responded_at") @db.Timestamptz(3)
  vendorRespondedByUserId String?              @map("vendor_responded_by_user_id") @db.Uuid
  vendorRespondedBy       User?                @relation("DisputeVendorResponder", fields: [vendorRespondedByUserId], references: [id], onDelete: SetNull)
  resolutionNotes         String?              @map("resolution_notes") @db.Text
  resolvedAt              DateTime?            @map("resolved_at") @db.Timestamptz(3)
  resolvedByUserId        String?              @map("resolved_by_user_id") @db.Uuid
  resolvedBy              User?                @relation("DisputeResolver", fields: [resolvedByUserId], references: [id], onDelete: SetNull)
  /// Buyer-favour only: whether the goods came back (drives restocking of shipped packages).
  itemReturned            Boolean?             @map("item_returned")
  restocked               Boolean              @default(false)
  /// Buyer-favour only: amount owed back to the customer (package items + shipping).
  refundAmount            Decimal?             @map("refund_amount") @db.Decimal(15, 2)
  /// Buyer-favour only: vendor earnings that could not be recovered from the wallet (vendor debt).
  refundUnrecoveredAmount Decimal              @default(0) @map("refund_unrecovered_amount") @db.Decimal(15, 2)
  cancelledAt             DateTime?            @map("cancelled_at") @db.Timestamptz(3)
  createdAt               DateTime             @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt               DateTime             @updatedAt @map("updated_at") @db.Timestamptz(3)

  evidence           DisputeEvidence[]
  events             DisputeEvent[]
  walletTransactions WalletTransaction[]

  @@index([subOrderId])
  @@index([status, createdAt])
  @@index([raisedByUserId, createdAt])
  @@index([vendorId, status, createdAt])
  @@map("disputes")
}

/// Uploaded proof for a dispute (photo, invoice, chat export). The uploader is
/// recorded separately from the raiser because staff and vendors may add files.
/// Since Phase 9 every row references the uploader's own media asset.
model DisputeEvidence {
  id               String      @id @default(uuid()) @db.Uuid
  disputeId        String      @map("dispute_id") @db.Uuid
  dispute          Dispute     @relation(fields: [disputeId], references: [id], onDelete: Cascade)
  uploadedByUserId String      @map("uploaded_by_user_id") @db.Uuid
  uploadedBy       User        @relation(fields: [uploadedByUserId], references: [id], onDelete: Restrict)
  mediaAssetId     String?     @map("media_asset_id") @db.Uuid
  mediaAsset       MediaAsset? @relation(fields: [mediaAssetId], references: [id], onDelete: SetNull)
  fileUrl          String      @map("file_url") @db.VarChar(512)
  fileType         String?     @map("file_type") @db.VarChar(40)
  caption          String?     @db.VarChar(255)
  createdAt        DateTime    @default(now()) @map("created_at") @db.Timestamptz(3)

  @@unique([disputeId, mediaAssetId])
  @@index([disputeId, createdAt])
  @@index([uploadedByUserId])
  @@index([mediaAssetId])
  @@map("dispute_evidence")
}

/// Append-only timeline of a dispute: who did what, when, and the status change.
model DisputeEvent {
  id          String           @id @default(uuid()) @db.Uuid
  disputeId   String           @map("dispute_id") @db.Uuid
  dispute     Dispute          @relation(fields: [disputeId], references: [id], onDelete: Cascade)
  type        DisputeEventType
  actorUserId String?          @map("actor_user_id") @db.Uuid
  actorUser   User?            @relation(fields: [actorUserId], references: [id], onDelete: SetNull)
  /// CUSTOMER / VENDOR / STAFF / SYSTEM.
  actorRole   String           @map("actor_role") @db.VarChar(20)
  fromStatus  DisputeStatus?   @map("from_status")
  toStatus    DisputeStatus?   @map("to_status")
  note        String?          @db.VarChar(1000)
  data        Json?
  createdAt   DateTime         @default(now()) @map("created_at") @db.Timestamptz(3)

  @@index([disputeId, createdAt])
  @@map("dispute_events")
}

// ============================================================================
// PLATFORM CONFIGURATION (Phase 1)
// ============================================================================

enum ConfigValueType {
  STRING
  NUMBER
  BOOLEAN
  JSON
}

/// Key/value platform configuration. `key` is the stable identifier consumed by
/// application code; rows are upserted by the seed and never invented at runtime.
model SystemConfig {
  id          String          @id @default(uuid()) @db.Uuid
  key         String          @unique @db.VarChar(120)
  value       String          @db.Text
  valueType   ConfigValueType @default(STRING) @map("value_type")
  description String?         @db.VarChar(255)
  createdAt   DateTime        @default(now()) @map("created_at") @db.Timestamptz(3)
  updatedAt   DateTime        @updatedAt @map("updated_at") @db.Timestamptz(3)

  @@map("system_configs")
}
```

### `apps/backend/prisma/seed.ts`

```ts
/**
 * Deterministic master-data seed.
 *
 * Run with:  pnpm db:seed      (turbo → @shopino/backend → prisma/seed.ts)
 * Reset:     pnpm db:reset     (drops the schema, re-applies migrations, re-seeds)
 *
 * Purpose: after a development volume is wiped, or on a brand-new environment,
 * one command restores the data the platform cannot operate without — staff
 * accounts, a verified vendor with a real catalogue, the category tree with its
 * commission rates, the credit provider portfolio and the system configuration.
 *
 * Properties, by design:
 *   • Deterministic    — the same input always produces the same rows; every
 *                        entity is addressed by a stable natural key
 *                        (mobile / slug / sku / provider code / config key).
 *   • Idempotent       — running it any number of times leaves the same state;
 *                        safe to execute on every deploy.
 *   • Non-destructive  — existing rows are corrected, never deleted, and user
 *                        passwords are never rotated unless the corresponding
 *                        SEED_RESET_*_PASSWORD flag is set explicitly.
 *   • No fabricated financial data — no wallet balance, no credit line, no order
 *                        and no payment is invented here. Those rows are created
 *                        by the real business flows (checkout, settlement,
 *                        credit decision) and by nothing else.
 *
 * Credentials come from the environment; no secret is hard-coded. Passwords are
 * hashed with Argon2id before they reach the database.
 *
 * Profiles (SEED_PROFILE, default: `production` when NODE_ENV=production, else
 * `development`):
 *   • development — everything above: fixed staff accounts, the sample vendor
 *                   and its catalogue; seeded rows are corrected on every run.
 *   • production  — master data only: the super admin (identity from
 *                   SUPER_ADMIN_MOBILE / SUPER_ADMIN_EMAIL / SUPER_ADMIN_FULL_NAME),
 *                   optional support/finance accounts (SEED_SUPPORT_* /
 *                   SEED_FINANCE_*), the category tree, the credit portfolio and
 *                   the system configuration. No sample vendor, product or
 *                   document. Categories, providers, plans and configs are
 *                   create-only: values an operator changed are never
 *                   overwritten by a later deploy. Credit starts disabled
 *                   (`credit.enabled=false`, no active provider) until a real
 *                   bank integration is configured.
 */
import { ConfigValueType, PrismaClient, UserRole, VendorStatus, type CreditProvider } from '@prisma/client';
import type { PrismaClient as PrismaClientInstance } from '@prisma/client';
import { hashPassword } from '../src/infra/security/password';

// ─── Seed inputs ─────────────────────────────────────────────────────────────

export type SeedProfile = 'development' | 'production';

export interface SeedSummary {
  profile: SeedProfile;
  users: { created: string[]; updated: number };
  categories: { upserted: number; roots: number };
  /** Null in the production profile, which seeds no sample vendor. */
  vendor: { slug: string; created: boolean; products: number; variants: number } | null;
  credit: { providers: number; plans: number };
  configs: number;
}

interface SeedUser {
  /**
   * Stable natural key — unique in the database.
   *
   * Stored in canonical E.164 (`+989XXXXXXXXX`) because that is the single format
   * the authentication layer reads and writes: the login flow normalizes every
   * input to it, and the unique index on `users.mobile` would not catch a number
   * registered under two different spellings. `09…` is presentation only.
   */
  mobile: string;
  email: string;
  fullName: string;
  role: UserRole;
  /** Environment variable holding the password; absent for non-login accounts. */
  passwordEnv?: string;
  resetPasswordEnv?: string;
}

const STAFF_USERS: readonly SeedUser[] = [
  {
    mobile: '+989120000001',
    email: 'admin@shopino.local',
    fullName: 'مدیر ارشد پلتفرم',
    role: UserRole.SUPER_ADMIN,
    passwordEnv: 'SUPER_ADMIN_PASSWORD',
    resetPasswordEnv: 'SEED_RESET_ADMIN_PASSWORD',
  },
  {
    mobile: '+989120000002',
    email: 'support@shopino.local',
    fullName: 'کارشناس پشتیبانی',
    role: UserRole.SUPPORT,
    passwordEnv: 'SEED_STAFF_PASSWORD',
  },
  {
    mobile: '+989120000003',
    email: 'finance@shopino.local',
    fullName: 'کارشناس مالی',
    role: UserRole.FINANCIAL_OFFICER,
    passwordEnv: 'SEED_STAFF_PASSWORD',
  },
];

/** Owner account of the sample vendor shop. */
const VENDOR_OWNER: SeedUser = {
  mobile: '+989120000010',
  email: 'vendor@shopino.local',
  fullName: 'مدیر فروشگاه نمونه',
  role: UserRole.VENDOR,
  passwordEnv: 'SEED_VENDOR_PASSWORD',
};

interface CategorySeed {
  slug: string;
  titleFa: string;
  titleEn: string;
  /** Platform commission for products in this category, in percent. */
  defaultCommissionRate: string;
  sortOrder: number;
  children: Omit<CategorySeed, 'children'>[];
}

/** Baseline taxonomy and the commission the platform charges per category. */
const CATEGORY_TREE: readonly CategorySeed[] = [
  {
    slug: 'digital',
    titleFa: 'کالای دیجیتال',
    titleEn: 'Digital Goods',
    defaultCommissionRate: '8.00',
    sortOrder: 10,
    children: [
      { slug: 'mobile', titleFa: 'گوشی موبایل', titleEn: 'Mobile Phones', defaultCommissionRate: '5.00', sortOrder: 10 },
      { slug: 'laptop', titleFa: 'لپ‌تاپ و کامپیوتر', titleEn: 'Laptops & Computers', defaultCommissionRate: '6.00', sortOrder: 20 },
      { slug: 'digital-accessories', titleFa: 'لوازم جانبی دیجیتال', titleEn: 'Digital Accessories', defaultCommissionRate: '12.00', sortOrder: 30 },
    ],
  },
  {
    slug: 'home-kitchen',
    titleFa: 'خانه و آشپزخانه',
    titleEn: 'Home & Kitchen',
    defaultCommissionRate: '10.00',
    sortOrder: 20,
    children: [
      { slug: 'home-appliances', titleFa: 'لوازم خانگی', titleEn: 'Home Appliances', defaultCommissionRate: '7.00', sortOrder: 10 },
      { slug: 'kitchenware', titleFa: 'ظروف و لوازم آشپزخانه', titleEn: 'Kitchenware', defaultCommissionRate: '15.00', sortOrder: 20 },
    ],
  },
  {
    slug: 'fashion',
    titleFa: 'مد و پوشاک',
    titleEn: 'Fashion',
    defaultCommissionRate: '14.00',
    sortOrder: 30,
    children: [
      { slug: 'mens-clothing', titleFa: 'پوشاک مردانه', titleEn: "Men's Clothing", defaultCommissionRate: '14.00', sortOrder: 10 },
      { slug: 'womens-clothing', titleFa: 'پوشاک زنانه', titleEn: "Women's Clothing", defaultCommissionRate: '14.00', sortOrder: 20 },
      { slug: 'bags-shoes', titleFa: 'کیف و کفش', titleEn: 'Bags & Shoes', defaultCommissionRate: '16.00', sortOrder: 30 },
    ],
  },
  {
    slug: 'beauty-health',
    titleFa: 'زیبایی و سلامت',
    titleEn: 'Beauty & Health',
    defaultCommissionRate: '13.00',
    sortOrder: 40,
    children: [
      { slug: 'skincare', titleFa: 'مراقبت از پوست', titleEn: 'Skincare', defaultCommissionRate: '13.00', sortOrder: 10 },
      { slug: 'personal-care', titleFa: 'بهداشت شخصی', titleEn: 'Personal Care', defaultCommissionRate: '11.00', sortOrder: 20 },
    ],
  },
  {
    slug: 'supermarket',
    titleFa: 'سوپرمارکت',
    titleEn: 'Supermarket',
    defaultCommissionRate: '9.00',
    sortOrder: 50,
    children: [
      { slug: 'food-beverage', titleFa: 'خواروبار و نوشیدنی', titleEn: 'Food & Beverage', defaultCommissionRate: '9.00', sortOrder: 10 },
      { slug: 'dairy', titleFa: 'لبنیات', titleEn: 'Dairy', defaultCommissionRate: '6.00', sortOrder: 20 },
    ],
  },
  {
    slug: 'books-stationery',
    titleFa: 'کتاب و لوازم‌التحریر',
    titleEn: 'Books & Stationery',
    defaultCommissionRate: '10.00',
    sortOrder: 60,
    children: [
      { slug: 'books', titleFa: 'کتاب', titleEn: 'Books', defaultCommissionRate: '10.00', sortOrder: 10 },
    ],
  },
];

interface VariantSeed {
  sku: string;
  colorName?: string;
  colorHex?: string;
  size?: string;
  guarantee?: string;
  price: string;
  compareAtPrice?: string;
  stockQuantity: number;
  weightGrams?: number;
}

interface MediaSeed {
  url: string;
  thumbnailUrl?: string;
  isPrimary: boolean;
  sortOrder: number;
}

interface ProductSeed {
  slug: string;
  title: string;
  description: string;
  brand: string;
  basePrice: string;
  categorySlug: string;
  isPublished: boolean;
  media: MediaSeed[];
  variants: VariantSeed[];
}

/**
 * Catalogue of the sample vendor. Prices are the real catalogue values the shop
 * sells at — the seed does not invent promotional numbers, and no stock figure
 * here is a placeholder for a database-backed counter.
 */
const VENDOR_PRODUCTS: readonly ProductSeed[] = [
  {
    slug: 'shopino-sample-smartphone-x1',
    title: 'گوشی موبایل نمونه X1',
    description: 'گوشی هوشمند با نمایشگر ۶.۷ اینچی، حافظهٔ ۲۵۶ گیگابایت و دوربین سه‌گانه.',
    brand: 'Shagerdam Sample',
    basePrice: '42500000.00',
    categorySlug: 'mobile',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-smartphone-x1/front.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-smartphone-x1/front-thumb.jpg', isPrimary: true, sortOrder: 10 },
      { url: 'https://cdn.shopino.local/products/sample-smartphone-x1/back.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-smartphone-x1/back-thumb.jpg', isPrimary: false, sortOrder: 20 },
    ],
    variants: [
      { sku: 'SHP-X1-256-BLK', colorName: 'مشکی', colorHex: '#111827', guarantee: '۱۸ ماه گارانتی شرکتی', price: '42500000.00', compareAtPrice: '45000000.00', stockQuantity: 12, weightGrams: 202 },
      { sku: 'SHP-X1-256-BLU', colorName: 'آبی', colorHex: '#1D4ED8', guarantee: '۱۸ ماه گارانتی شرکتی', price: '42900000.00', compareAtPrice: '45000000.00', stockQuantity: 7, weightGrams: 202 },
    ],
  },
  {
    slug: 'shopino-sample-laptop-pro14',
    title: 'لپ‌تاپ نمونه پرو ۱۴ اینچ',
    description: 'لپ‌تاپ ۱۴ اینچی با پردازندهٔ نسل جدید، ۱۶ گیگابایت رم و حافظهٔ SSD یک ترابایتی.',
    brand: 'Shagerdam Sample',
    basePrice: '78900000.00',
    categorySlug: 'laptop',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-laptop-pro14/main.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-laptop-pro14/main-thumb.jpg', isPrimary: true, sortOrder: 10 },
    ],
    variants: [
      { sku: 'SHP-PRO14-16-1T-SLV', colorName: 'نقره‌ای', colorHex: '#D1D5DB', guarantee: '۲۴ ماه گارانتی بین‌المللی', price: '78900000.00', stockQuantity: 5, weightGrams: 1450 },
      { sku: 'SHP-PRO14-16-1T-GRY', colorName: 'خاکستری', colorHex: '#4B5563', guarantee: '۲۴ ماه گارانتی بین‌المللی', price: '79900000.00', stockQuantity: 3, weightGrams: 1450 },
    ],
  },
  {
    slug: 'shopino-sample-cotton-tshirt',
    title: 'تی‌شرت نخی نمونه',
    description: 'تی‌شرت پنبه‌ای با دوخت صنعتی، مناسب استفادهٔ روزمره.',
    brand: 'Shagerdam Sample',
    basePrice: '890000.00',
    categorySlug: 'mens-clothing',
    isPublished: true,
    media: [
      { url: 'https://cdn.shopino.local/products/sample-cotton-tshirt/white.jpg', thumbnailUrl: 'https://cdn.shopino.local/products/sample-cotton-tshirt/white-thumb.jpg', isPrimary: true, sortOrder: 10 },
    ],
    variants: [
      { sku: 'SHP-TSHIRT-WHT-L', colorName: 'سفید', colorHex: '#FFFFFF', size: 'L', price: '890000.00', compareAtPrice: '1150000.00', stockQuantity: 40, weightGrams: 180 },
      { sku: 'SHP-TSHIRT-WHT-XL', colorName: 'سفید', colorHex: '#FFFFFF', size: 'XL', price: '890000.00', compareAtPrice: '1150000.00', stockQuantity: 25, weightGrams: 195 },
      { sku: 'SHP-TSHIRT-BLK-L', colorName: 'مشکی', colorHex: '#111827', size: 'L', price: '920000.00', stockQuantity: 18, weightGrams: 180 },
    ],
  },
];

const SAMPLE_VENDOR = {
  storeSlug: 'shopino-sample-store',
  storeName: 'فروشگاه نمونه شاگردم',
  instagramHandle: 'shopino.sample',
  bio: 'فروشگاه نمونهٔ پلتفرم با کاتالوگ واقعی برای توسعه و تست جریان‌های خرید.',
  bankIban: 'IR620170000000000000000001',
};

interface CreditProviderSeed {
  code: string;
  name: string;
  isActive: boolean;
  config: Record<string, string>;
  plans: { durationMonths: number; title: string; interestRatePercent: string; penaltyRatePercentPerMonth: string }[];
}

/**
 * Credit portfolio. Only the sandbox provider is active in development; the real
 * banks are seeded as inactive so that switching provider is a configuration
 * change (`credits.activeProvider` / provider row) rather than a code change.
 */
const CREDIT_PROVIDERS: readonly CreditProviderSeed[] = [
  {
    code: 'SANDBOX_BANK',
    name: 'بانک آزمایشی (Sandbox)',
    isActive: true,
    config: {
      environment: 'sandbox',
      baseUrl: 'https://sandbox.credit.local/api/v1',
      merchantId: 'shopino-sandbox-merchant',
      // Simulation rules of the development-only SandboxBankProvider (Phase 8):
      // approve when the simulated score (derived from the national code) is at
      // least minApprovalScore and the requested limit is at least
      // minRequestedLimit; the approved limit is capped at maxApprovedLimit.
      // Whole rials. Not business data of any real bank.
      minApprovalScore: '600',
      minRequestedLimit: '10000000',
      maxApprovedLimit: '500000000',
    },
    plans: [
      { durationMonths: 3, title: 'خرید اعتباری ۳ ماهه (بدون سود)', interestRatePercent: '0.00', penaltyRatePercentPerMonth: '2.00' },
      { durationMonths: 6, title: 'خرید اعتباری ۶ ماهه', interestRatePercent: '9.00', penaltyRatePercentPerMonth: '2.00' },
      { durationMonths: 12, title: 'خرید اعتباری ۱۲ ماهه', interestRatePercent: '18.00', penaltyRatePercentPerMonth: '2.50' },
    ],
  },
  {
    code: 'SAMAN_BANK',
    name: 'بانک سامان',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
  {
    code: 'BLUBANK',
    name: 'بلوبانک',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
  {
    code: 'DIGIPAY',
    name: 'دیجی‌پی',
    isActive: false,
    config: { environment: 'production', baseUrl: '', merchantId: '' },
    plans: [],
  },
];

interface ConfigSeed {
  key: string;
  value: string;
  valueType: ConfigValueType;
  description: string;
}

/**
 * Baseline platform configuration. The BNPL flow exists since Phase 8, so
 * `credit.enabled` is true; `credits.activeProvider` names the sandbox
 * explicitly so the active (development-only) provider is always visible in
 * configuration. Production must point it at a real bank integration.
 */
const SYSTEM_CONFIGS: readonly ConfigSeed[] = [
  { key: 'platform.name', value: 'شاگردم', valueType: ConfigValueType.STRING, description: 'نام نمایشی پلتفرم' },
  { key: 'platform.currency', value: 'IRR', valueType: ConfigValueType.STRING, description: 'کد ارز پایه پلتفرم (ISO 4217)' },
  { key: 'platform.locale', value: 'fa-IR', valueType: ConfigValueType.STRING, description: 'زبان و قالب پیش‌فرض رابط کاربری' },
  { key: 'platform.timezone', value: 'Asia/Tehran', valueType: ConfigValueType.STRING, description: 'منطقهٔ زمانی مرجع برای گزارش‌ها و تسویه' },
  { key: 'credit.enabled', value: 'true', valueType: ConfigValueType.BOOLEAN, description: 'فعال بودن خرید اعتباری (BNPL). با false هیچ درخواست اعتبار یا خرید اعتباری جدیدی پذیرفته نمی‌شود.' },
  { key: 'credits.activeProvider', value: 'SANDBOX_BANK', valueType: ConfigValueType.STRING, description: 'کد ارائه‌دهندهٔ اعتبار فعال در محیط جاری' },
  { key: 'commerce.defaultCommissionRate', value: '12.00', valueType: ConfigValueType.NUMBER, description: 'نرخ کمیسیون پیش‌فرض پلتفرم (درصد) وقتی دسته‌بندی نرخ اختصاصی ندارد' },
  { key: 'commerce.escrowHoldDays', value: '7', valueType: ConfigValueType.NUMBER, description: 'مدت نگه‌داری وجه در حساب امانی پس از تحویل (روز)' },
  { key: 'commerce.settlementMinimumAmount', value: '5000000.00', valueType: ConfigValueType.NUMBER, description: 'حداقل مبلغ قابل درخواست تسویه (ریال)' },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. Add it to the root .env (see .env.example) — the seed is not allowed to invent credentials.`,
    );
  }
  return value;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseBooleanFlag(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true';
}

/** SEED_PROFILE, defaulting to `production` under NODE_ENV=production. */
export function resolveSeedProfile(env: NodeJS.ProcessEnv = process.env): SeedProfile {
  const raw = (env.SEED_PROFILE ?? '').trim().toLowerCase();
  if (raw === '') {
    return env.NODE_ENV === 'production' ? 'production' : 'development';
  }
  if (raw === 'development' || raw === 'production') {
    return raw;
  }
  throw new Error(`SEED_PROFILE must be "development" or "production" (got "${raw}").`);
}

/** Iranian mobile in E.164 (+989XXXXXXXXX); accepts 09XXXXXXXXX as well. */
export function normalizeIranMobile(name: string, value: string): string {
  const digits = value.trim().replace(/[\s-]/g, '');
  const normalized = digits.startsWith('+98') ? digits : digits.startsWith('0098') ? `+${digits.slice(2)}` : digits.startsWith('0') ? `+98${digits.slice(1)}` : digits;
  if (!/^\+989\d{9}$/.test(normalized)) {
    throw new Error(`${name} must be an Iranian mobile number such as 09121234567 (got "${value}").`);
  }
  return normalized;
}

/** An optional staff account: all of its variables or none of them. */
function optionalStaff(prefix: 'SEED_SUPPORT' | 'SEED_FINANCE', role: UserRole, env: NodeJS.ProcessEnv): SeedUser | null {
  const mobile = env[`${prefix}_MOBILE`]?.trim() ?? '';
  const email = env[`${prefix}_EMAIL`]?.trim() ?? '';
  const fullName = env[`${prefix}_FULL_NAME`]?.trim() ?? '';
  if (mobile === '' && email === '' && fullName === '') {
    return null;
  }
  if (mobile === '' || email === '' || fullName === '') {
    throw new Error(`${prefix}_MOBILE, ${prefix}_EMAIL and ${prefix}_FULL_NAME must be set together (or all left empty).`);
  }
  return { mobile: normalizeIranMobile(`${prefix}_MOBILE`, mobile), email, fullName, role, passwordEnv: 'SEED_STAFF_PASSWORD' };
}

/** Accounts of the production profile: the super admin plus optional support/finance staff, all from the environment. */
export function productionStaffUsers(env: NodeJS.ProcessEnv = process.env): SeedUser[] {
  const admin: SeedUser = {
    mobile: normalizeIranMobile('SUPER_ADMIN_MOBILE', requireEnv('SUPER_ADMIN_MOBILE')),
    email: requireEnv('SUPER_ADMIN_EMAIL').trim(),
    fullName: requireEnv('SUPER_ADMIN_FULL_NAME').trim(),
    role: UserRole.SUPER_ADMIN,
    passwordEnv: 'SUPER_ADMIN_PASSWORD',
    resetPasswordEnv: 'SEED_RESET_ADMIN_PASSWORD',
  };
  return [admin, optionalStaff('SEED_SUPPORT', UserRole.SUPPORT, env), optionalStaff('SEED_FINANCE', UserRole.FINANCIAL_OFFICER, env)].filter(
    (user): user is SeedUser => user !== null,
  );
}

/**
 * Production starting values that differ from development: credit is off and no
 * provider is active until a real bank integration exists (SANDBOX_BANK is also
 * refused by the API in production).
 */
const PRODUCTION_CONFIG_VALUES: Readonly<Record<string, string>> = {
  'credit.enabled': 'false',
  'credits.activeProvider': '',
};

// ─── Seed sections ───────────────────────────────────────────────────────────

async function seedUsers(
  prisma: PrismaClientInstance,
  users: readonly SeedUser[],
): Promise<{ created: string[]; updated: number }> {
  const created: string[] = [];
  let updated = 0;

  for (const user of users) {
    const email = normalizeEmail(user.email);
    const existing = await prisma.user.findUnique({ where: { mobile: user.mobile } });
    const passwordHash =
      user.passwordEnv === undefined
        ? undefined
        : await hashPassword(requireEnv(user.passwordEnv));
    const resetPassword =
      user.resetPasswordEnv !== undefined && parseBooleanFlag(user.resetPasswordEnv);

    if (existing === null) {
      if (passwordHash === undefined) {
        throw new Error(`${email} has no password source configured; refusing to create a login account without one.`);
      }
      await prisma.user.create({
        data: {
          mobile: user.mobile,
          email,
          fullName: user.fullName,
          role: user.role,
          passwordHash,
          isActive: true,
        },
      });
      created.push(email);
      continue;
    }

    // Repair identity drift (name/role/email) without touching the credential.
    await prisma.user.update({
      where: { mobile: user.mobile },
      data: {
        email,
        fullName: user.fullName,
        role: user.role,
        isActive: true,
        ...(resetPassword && passwordHash !== undefined ? { passwordHash } : {}),
      },
    });
    updated += 1;
  }

  return { created, updated };
}

async function seedCategories(prisma: PrismaClientInstance, createOnly: boolean): Promise<{ upserted: number; roots: number }> {
  let upserted = 0;

  for (const root of CATEGORY_TREE) {
    const parent = await prisma.category.upsert({
      where: { slug: root.slug },
      update: createOnly ? {} : {
        titleFa: root.titleFa,
        titleEn: root.titleEn,
        defaultCommissionRate: root.defaultCommissionRate,
        sortOrder: root.sortOrder,
        isActive: true,
      },
      create: {
        slug: root.slug,
        titleFa: root.titleFa,
        titleEn: root.titleEn,
        defaultCommissionRate: root.defaultCommissionRate,
        sortOrder: root.sortOrder,
        isActive: true,
      },
    });
    upserted += 1;

    for (const child of root.children) {
      await prisma.category.upsert({
        where: { slug: child.slug },
        update: createOnly ? {} : {
          titleFa: child.titleFa,
          titleEn: child.titleEn,
          defaultCommissionRate: child.defaultCommissionRate,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
        create: {
          slug: child.slug,
          titleFa: child.titleFa,
          titleEn: child.titleEn,
          defaultCommissionRate: child.defaultCommissionRate,
          sortOrder: child.sortOrder,
          parentId: parent.id,
          isActive: true,
        },
      });
      upserted += 1;
    }
  }

  return { upserted, roots: CATEGORY_TREE.length };
}

async function seedVendor(
  prisma: PrismaClientInstance,
): Promise<{ slug: string; created: boolean; products: number; variants: number }> {
  const owner = await prisma.user.findUniqueOrThrow({ where: { mobile: VENDOR_OWNER.mobile } });

  const existingVendor = await prisma.vendor.findUnique({ where: { storeSlug: SAMPLE_VENDOR.storeSlug } });

  const vendor = await prisma.vendor.upsert({
    where: { storeSlug: SAMPLE_VENDOR.storeSlug },
    update: {
      storeName: SAMPLE_VENDOR.storeName,
      instagramHandle: SAMPLE_VENDOR.instagramHandle,
      bio: SAMPLE_VENDOR.bio,
      bankIban: SAMPLE_VENDOR.bankIban,
      status: VendorStatus.APPROVED,
    },
    create: {
      userId: owner.id,
      storeName: SAMPLE_VENDOR.storeName,
      storeSlug: SAMPLE_VENDOR.storeSlug,
      instagramHandle: SAMPLE_VENDOR.instagramHandle,
      bio: SAMPLE_VENDOR.bio,
      bankIban: SAMPLE_VENDOR.bankIban,
      status: VendorStatus.APPROVED,
      verifiedAt: new Date('2026-01-05T09:00:00.000Z'),
    },
  });

  // A wallet is created when the vendor is approved; balances stay at zero until
  // real sales move them (the seed never fabricates a balance).
  await prisma.vendorWallet.upsert({
    where: { vendorId: vendor.id },
    update: {},
    create: { vendorId: vendor.id },
  });

  // Verification dossier of the approved vendor, keyed by its national card file.
  const nationalCardDocUrl = 'https://cdn.shopino.local/vendor-docs/sample/national-card.jpg';
  const existingVerification = await prisma.vendorVerification.findFirst({
    where: { vendorId: vendor.id, nationalCardDocUrl },
  });
  if (existingVerification === null) {
    await prisma.vendorVerification.create({
      data: {
        vendorId: vendor.id,
        nationalCardDocUrl,
        businessDocUrl: 'https://cdn.shopino.local/vendor-docs/sample/business-license.jpg',
        reviewedAt: new Date('2026-01-05T09:00:00.000Z'),
      },
    });
  }

  let products = 0;
  let variants = 0;

  for (const product of VENDOR_PRODUCTS) {
    const category = await prisma.category.findUniqueOrThrow({ where: { slug: product.categorySlug } });

    const row = await prisma.product.upsert({
      where: { slug: product.slug },
      update: {
        title: product.title,
        description: product.description,
        brand: product.brand,
        basePrice: product.basePrice,
        categoryId: category.id,
        vendorId: vendor.id,
        isPublished: product.isPublished,
      },
      create: {
        vendorId: vendor.id,
        categoryId: category.id,
        title: product.title,
        slug: product.slug,
        description: product.description,
        brand: product.brand,
        basePrice: product.basePrice,
        isPublished: product.isPublished,
      },
    });
    products += 1;

    for (const variant of product.variants) {
      await prisma.productVariant.upsert({
        where: { sku: variant.sku },
        update: {
          productId: row.id,
          colorName: variant.colorName ?? null,
          colorHex: variant.colorHex ?? null,
          size: variant.size ?? null,
          guarantee: variant.guarantee ?? null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          stockQuantity: variant.stockQuantity,
          weightGrams: variant.weightGrams ?? null,
          isActive: true,
        },
        create: {
          productId: row.id,
          sku: variant.sku,
          colorName: variant.colorName ?? null,
          colorHex: variant.colorHex ?? null,
          size: variant.size ?? null,
          guarantee: variant.guarantee ?? null,
          price: variant.price,
          compareAtPrice: variant.compareAtPrice ?? null,
          stockQuantity: variant.stockQuantity,
          weightGrams: variant.weightGrams ?? null,
          isActive: true,
        },
      });
      variants += 1;
    }

    for (const media of product.media) {
      const existingMedia = await prisma.productMedia.findFirst({
        where: { productId: row.id, url: media.url },
      });
      if (existingMedia === null) {
        await prisma.productMedia.create({
          data: {
            productId: row.id,
            url: media.url,
            thumbnailUrl: media.thumbnailUrl ?? null,
            isPrimary: media.isPrimary,
            sortOrder: media.sortOrder,
          },
        });
      }
    }
  }

  return {
    slug: vendor.storeSlug,
    created: existingVendor === null,
    products,
    variants,
  };
}

async function seedCreditPortfolio(
  prisma: PrismaClientInstance,
  profile: SeedProfile,
): Promise<{ providers: number; plans: number }> {
  const createOnly = profile === 'production';
  let plans = 0;

  for (const provider of CREDIT_PROVIDERS) {
    // The sandbox is created inactive in production (the API refuses it there anyway).
    const isActive = profile === 'production' && provider.code === 'SANDBOX_BANK' ? false : provider.isActive;
    const row: CreditProvider = await prisma.creditProvider.upsert({
      where: { code: provider.code },
      update: createOnly ? {} : { name: provider.name, isActive, config: provider.config },
      create: { code: provider.code, name: provider.name, isActive, config: provider.config },
    });

    for (const plan of provider.plans) {
      await prisma.installmentPlan.upsert({
        where: { providerId_durationMonths: { providerId: row.id, durationMonths: plan.durationMonths } },
        update: createOnly ? {} : {
          title: plan.title,
          interestRatePercent: plan.interestRatePercent,
          penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth,
          isActive: true,
        },
        create: {
          providerId: row.id,
          title: plan.title,
          durationMonths: plan.durationMonths,
          interestRatePercent: plan.interestRatePercent,
          penaltyRatePercentPerMonth: plan.penaltyRatePercentPerMonth,
          isActive: true,
        },
      });
      plans += 1;
    }
  }

  return { providers: CREDIT_PROVIDERS.length, plans };
}

async function seedSystemConfigs(prisma: PrismaClientInstance, profile: SeedProfile): Promise<number> {
  for (const config of SYSTEM_CONFIGS) {
    const value = profile === 'production' ? (PRODUCTION_CONFIG_VALUES[config.key] ?? config.value) : config.value;
    await prisma.systemConfig.upsert({
      where: { key: config.key },
      update: profile === 'production' ? {} : { value, valueType: config.valueType, description: config.description },
      create: {
        key: config.key,
        value,
        valueType: config.valueType,
        description: config.description,
      },
    });
  }
  return SYSTEM_CONFIGS.length;
}

/**
 * Seeds master data. Accepts a PrismaClient so tests and scripts can reuse the
 * exact same logic inside an existing connection or transaction scope.
 */
export async function seedDatabase(prisma: PrismaClientInstance, profile: SeedProfile = resolveSeedProfile()): Promise<SeedSummary> {
  const production = profile === 'production';
  const users = await seedUsers(prisma, production ? productionStaffUsers() : [...STAFF_USERS, VENDOR_OWNER]);
  const categories = await seedCategories(prisma, production);
  const vendor = production ? null : await seedVendor(prisma);
  const credit = await seedCreditPortfolio(prisma, profile);
  const configs = await seedSystemConfigs(prisma, profile);

  return { profile, users, categories, vendor, credit, configs };
}

async function main(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const summary = await seedDatabase(prisma);
    console.warn(
      `[seed] master data ready (profile: ${summary.profile})\n` +
        `  users          : ${summary.users.created.length} created (${summary.users.created.join(', ') || '—'}), ${summary.users.updated} updated\n` +
        `  categories     : ${summary.categories.upserted} rows (${summary.categories.roots} roots) with commission rates\n` +
        (summary.vendor
          ? `  vendor         : ${summary.vendor.slug} (${summary.vendor.created ? 'created' : 'updated'}) — ${summary.vendor.products} products, ${summary.vendor.variants} variants\n`
          : `  vendor         : none (production profile seeds no sample data)\n`) +
        `  credit         : ${summary.credit.providers} providers, ${summary.credit.plans} installment plans\n` +
        `  system configs : ${summary.configs} keys`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(`[seed] FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
```

### `apps/backend/src/app.module.ts`

```ts
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
```

### `apps/backend/src/common/brand.ts`

```ts
/**
 * Platform display identity (TM decision: «شاگردم»).
 *
 * These are the *display* names used in user-facing text the backend produces:
 * SMS bodies, payment-gateway descriptions, the sandbox bank page and the API
 * docs title. Technical identifiers (package scope `@shopino/*`, container and
 * database names, cookie names, seeded slugs and e-mail domains) are deliberately
 * unchanged: renaming them would break deployments, backups and live sessions
 * without any user-visible benefit.
 *
 * `platform.name` in `system_configs` carries the same value for operators.
 */
export const PLATFORM_DISPLAY_NAME = 'شاگردم';
export const PLATFORM_DISPLAY_NAME_EN = 'Shagerdam';
export const PLATFORM_TAGLINE = 'پلتفرم هوشمند خرید و فروش اقساطی';
```

### `apps/backend/src/main.ts`

```ts
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { GLOBAL_API_PREFIX, SWAGGER_PATH } from './common/constants';
import type { LogLevelName } from './config/env.validation';
import { resolveLogLevels } from './config/logger.config';
import { applyGlobalPolicies, setupSwagger } from './setup/app.setup';

const REQUEST_BODY_LIMIT_BYTES = 1_048_576;

async function bootstrap(): Promise<void> {
  const adapter = new FastifyAdapter({
    // Set only when the API is deployed behind a reverse proxy/tunnel that
    // terminates TLS; the proxy must overwrite X-Forwarded-* headers itself.
    trustProxy: true,
    bodyLimit: REQUEST_BODY_LIMIT_BYTES,
  });

  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter);

  const config = app.get(ConfigService);
  app.useLogger(resolveLogLevels(config.getOrThrow<LogLevelName>('LOG_LEVEL')));
  app.enableShutdownHooks();

  applyGlobalPolicies(app, config);
  setupSwagger(app);

  const port = config.getOrThrow<number>('PORT');
  const host = config.getOrThrow<string>('HOST');

  await app.listen({ port, host });

  Logger.log(
    `Shagerdam API ready on http://${host}:${port}/${GLOBAL_API_PREFIX} — docs: http://${host}:${port}/${SWAGGER_PATH}`,
    'Bootstrap',
  );
}

void bootstrap();
```

### `apps/backend/src/modules/auth/dto/auth-response.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import type { PublicUser, UserIdentity } from '../../users/users.service';

/** The user object embedded in every authentication response. */
export class AuthUserDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '+989120000001' })
  mobile!: string;

  @ApiProperty({ enum: UserRole, example: UserRole.CUSTOMER })
  role!: UserRole;

  @ApiProperty({ example: 'سارا محمدی' })
  fullName!: string;

  @ApiProperty({ nullable: true, example: 'sara@example.com' })
  email!: string | null;

  static from(user: PublicUser): AuthUserDto {
    return { id: user.id, mobile: user.mobile, role: user.role, fullName: user.fullName, email: user.email };
  }
}

export class OtpRequestResponseDto {
  @ApiProperty({ example: 'sent', enum: ['sent'] })
  status!: 'sent';

  @ApiProperty({ example: 120, description: 'مدت اعتبار کد به ثانیه' })
  expiresInSeconds!: number;

  @ApiProperty({
    example: 'SBX-M8ZK2P-1',
    description: 'شناسه ارسال نزد سرویسدهنده پیامک، برای پیگیری تحویل',
  })
  trackingId!: string;
}

export class AuthTokensResponseDto {
  @ApiProperty({ description: 'توکن دسترسی کوتاهعمر (پیشفرض ۱۵ دقیقه)' })
  accessToken!: string;

  @ApiProperty({ description: 'توکن تازهسازی پایدار (پیشفرض ۷ روز) — یکبارمصرف و چرخشی' })
  refreshToken!: string;

  @ApiProperty({ example: 900, description: 'عمر توکن دسترسی به ثانیه' })
  expiresIn!: number;

  @ApiProperty({ example: 604_800, description: 'عمر توکن تازهسازی به ثانیه' })
  refreshExpiresIn!: number;

  @ApiProperty({ example: '42f1…', description: 'شناسه نشست؛ برای ابطال هدفمند' })
  sessionId!: string;

  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;
}

export class CustomerProfileDto {
  @ApiProperty({ nullable: true, example: '1994-05-17T00:00:00.000Z' })
  birthDate!: Date | null;

  @ApiProperty({ nullable: true, enum: ['MALE', 'FEMALE', 'OTHER'] })
  gender!: string | null;

  @ApiProperty({ nullable: true, example: 'IR120570000000000000000001' })
  bankIban!: string | null;

  @ApiProperty({ nullable: true, format: 'uuid' })
  defaultAddressId!: string | null;
}

/**
 * Compact store view embedded in `GET /auth/me`.
 *
 * Named `MeVendorSummaryDto` rather than `VendorProfileDto` because the vendors
 * module owns that name: two different classes sharing one OpenAPI schema name
 * produces a broken document (and a warning at boot).
 */
export class MeVendorSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'فروشگاه نمونه شاگردم' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;

  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'] })
  status!: string;

  @ApiProperty({ nullable: true })
  logoUrl!: string | null;
}

export class MeResponseDto {
  @ApiProperty({ type: AuthUserDto })
  user!: AuthUserDto;

  @ApiPropertyOptional({ type: CustomerProfileDto, nullable: true })
  customerProfile!: CustomerProfileDto | null;

  @ApiPropertyOptional({ type: MeVendorSummaryDto, nullable: true })
  vendor!: MeVendorSummaryDto | null;

  static from(identity: UserIdentity): MeResponseDto {
    return {
      user: AuthUserDto.from(identity.user),
      customerProfile: identity.customerProfile,
      vendor: identity.vendor,
    };
  }
}

export class ProfileUpdateResponseDto extends MeResponseDto {
  @ApiProperty({ example: true, description: 'تغییرات ذخیره شد' })
  updated!: boolean;
}

export class LogoutResponseDto {
  @ApiProperty({ example: true, description: 'نشست در سرور باطل شد' })
  revoked!: boolean;

  @ApiProperty({ example: 1, description: 'تعداد نشستهای باطلشده' })
  sessionsRevoked!: number;
}

export class SmsProviderInfoDto {
  @ApiProperty({ example: 'sandbox', enum: ['sandbox', 'kavenegar'] })
  provider!: string;

  @ApiProperty({
    example: true,
    description:
      'اگر true باشد، پیامک واقعاً ارسال نمیشود (Provider آزمایشی توسعه). در Production همیشه false است.',
  })
  isTestProvider!: boolean;
}
```

### `apps/backend/src/modules/bnpl/credit-checkout.service.ts`

```ts
import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, CreditAccountStatus, ParentOrderPaymentStatus, PaymentMethod, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from '../credit/credit-ledger.service';
import { splitPayment } from '../credit/credit-math';
import { CreditOrderService, type ProviderFollowUp, type ScheduleSummary } from '../credit/credit-order.service';
import { CreditProviderError, type CreditProviderAdapter, type CreditReservation } from '../credit/providers/credit-provider.interface';
import { CreditProviderRegistry } from '../credit/providers/credit-provider.registry';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import { MAX_OPEN_ATTEMPTS, PaymentsService } from '../payments/payments.service';
import type { CreditPaymentInitiateResponseDto, InitiateCreditPaymentDto } from './dto/bnpl.dto';
import { PLATFORM_DISPLAY_NAME } from '../../common/brand';

/**
 * Credit and hybrid checkout (TM brief §3–4).
 *
 * Sequence: validate (order PENDING and payable, active account, active plan,
 * split) → provider `reserveCredit` (outside any transaction) → one transaction
 * that locks the parent order, then the credit account, writes the
 * PURCHASE_RESERVE_HOLD row and the Payment. BANK_CREDIT completes in that same
 * transaction: commit (PURCHASE_COMMIT), instalment schedule, order PAID via the
 * shared lifecycle (stock committed, vendor escrow funded, packages
 * PENDING_APPROVAL). HYBRID then opens a bank session for the card part; if the
 * gateway fails (now, or at the callback) the reservation is released.
 *
 * If the transaction fails after the provider reserved, the provider
 * reservation is released immediately (nothing was recorded locally).
 */
@Injectable()
export class CreditCheckoutService {
  private readonly logger = new Logger(CreditCheckoutService.name);
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CreditProviderRegistry,
    private readonly ledger: CreditLedgerService,
    private readonly creditOrders: CreditOrderService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  async initiate(userId: string, dto: InitiateCreditPaymentDto, actor: OrderActor): Promise<CreditPaymentInitiateResponseDto> {
    await this.registry.assertEnabled();
    const now = new Date();
    const order = await this.prisma.parentOrder.findFirst({
      where: { id: dto.parentOrderId, userId },
      select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true, finalPayableAmount: true, user: { select: { mobile: true } } },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    assertPayable(order, now);

    const provider = await this.registry.requireActiveProvider();
    const adapter = this.registry.adapterFor(provider);
    const account = await this.prisma.creditAccount.findUnique({
      where: { userId_providerId: { userId, providerId: provider.id } },
      select: { id: true, status: true, availableAmount: true, expiresAt: true },
    });
    if (!account) {
      throw conflictWith('CREDIT_ACCOUNT_REQUIRED', `You have no credit account with ${provider.code}; apply first`);
    }
    if (account.status !== CreditAccountStatus.ACTIVE) {
      throw conflictWith('CREDIT_ACCOUNT_NOT_ACTIVE', `The credit account is ${account.status}`, { accountStatus: account.status });
    }
    if (account.expiresAt !== null && account.expiresAt <= now) {
      throw conflictWith('CREDIT_ACCOUNT_EXPIRED', 'The credit account has expired', { expiresAt: account.expiresAt });
    }
    const plan = await this.prisma.installmentPlan.findFirst({
      where: { id: dto.planId, providerId: provider.id, isActive: true },
      select: { id: true, title: true, durationMonths: true, interestRatePercent: true },
    });
    if (!plan) {
      throw badRequestWith('INSTALLMENT_PLAN_NOT_AVAILABLE', 'This instalment plan is not offered by the active credit provider');
    }
    const split = splitPayment(dto.paymentMethod, order.finalPayableAmount, account.availableAmount);
    if ('rejected' in split) {
      throw this.rejection(split.rejected, order.finalPayableAmount, account.availableAmount);
    }
    const open = await this.prisma.payment.count({
      where: { parentOrderId: order.id, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(now.getTime() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this order; finish or wait for one of them', this.graceMs / 1000);
    }

    const reservation = await this.reserveAtProvider(adapter, account.id, split.creditAmount, order.id);
    const method = dto.paymentMethod;
    const followUps: ProviderFollowUp[] = [];
    let result: { paymentId: string; schedule: ScheduleSummary | null; orderPaymentStatus: ParentOrderPaymentStatus };
    try {
      result = await this.prisma.$transaction(async (tx) => {
        await lockParentOrder(tx, order.id);
        const current = await tx.parentOrder.findUniqueOrThrow({ where: { id: order.id }, select: { paymentStatus: true, paymentExpiresAt: true } });
        assertPayable(current, new Date());
        await this.ledger.hold(tx, account.id, split.creditAmount, reservation.reservationRef, order.id);
        const payment = await tx.payment.create({
          data: {
            parentOrderId: order.id,
            purpose: PaymentPurpose.ORDER_CHECKOUT,
            paymentMethod: method,
            creditAccountId: account.id,
            installmentPlanId: plan.id,
            creditReservationRef: reservation.reservationRef,
            // BANK_CREDIT never touches a card gateway: the "gateway" is the credit provider.
            gatewayName: method === PaymentMethod.BANK_CREDIT ? provider.code : this.payments.gatewayName,
            cashAmount: split.cashAmount,
            creditAmount: split.creditAmount,
            status: PaymentStatus.INITIATED,
            metadata: { stage: 'credit_reserved', provider: provider.code, reservation: reservation.details } as Prisma.InputJsonValue,
          },
          select: { id: true, parentOrderId: true, creditAmount: true, creditAccountId: true, creditReservationRef: true, installmentPlanId: true },
        });
        await writeOrderAudit(tx, actor, {
          action: AuditAction.CREATE,
          entityName: 'Payment',
          entityId: payment.id,
          newValue: {
            parentOrderId: order.id,
            orderNumber: order.orderNumber,
            paymentMethod: method,
            providerCode: provider.code,
            planId: plan.id,
            creditAmount: split.creditAmount.toFixed(2),
            cashAmount: split.cashAmount.toFixed(2),
            creditReservationRef: reservation.reservationRef,
          },
        });
        if (method !== PaymentMethod.BANK_CREDIT) {
          return { paymentId: payment.id, schedule: null, orderPaymentStatus: current.paymentStatus };
        }

        const paidAt = new Date();
        const committed = await this.creditOrders.commitAndScheduleLocked(tx, payment, paidAt);
        followUps.push(committed.followUp);
        const application = await this.lifecycle.applyPaymentLocked(tx, order.id, actor, { paymentId: payment.id, paymentMethod: PaymentMethod.BANK_CREDIT });
        if (!application.applied) {
          throw new Error(`Order ${order.id} was PENDING under lock but the credit payment could not be applied`);
        }
        followUps.push(...(await this.creditOrders.releaseOpenReservationsLocked(tx, order.id, payment.id)));
        await tx.payment.update({
          where: { id: payment.id },
          data: {
            status: PaymentStatus.SUCCESSFUL,
            paidAt,
            metadata: {
              stage: 'credit_committed',
              provider: provider.code,
              reservation: reservation.details,
              schedule: committed.schedule,
              escrowHeld: application.escrowHeld,
            } as unknown as Prisma.InputJsonValue,
          },
        });
        await writeOrderAudit(tx, actor, {
          action: AuditAction.PAYMENT_CAPTURE,
          entityName: 'Payment',
          entityId: payment.id,
          oldValue: { status: PaymentStatus.INITIATED },
          newValue: {
            status: PaymentStatus.SUCCESSFUL,
            orderNumber: order.orderNumber,
            paymentMethod: method,
            creditAmount: split.creditAmount.toFixed(2),
            creditReservationRef: reservation.reservationRef,
            installments: committed.schedule.installments,
            escrowHeld: application.escrowHeld,
          },
        });
        return { paymentId: payment.id, schedule: committed.schedule, orderPaymentStatus: ParentOrderPaymentStatus.PAID };
      });
    } catch (error) {
      // Nothing was recorded locally: undo the provider-side reservation now.
      await adapter.releaseCredit(reservation.reservationRef).catch((releaseError: unknown) => {
        this.logger.error(`Could not release provider reservation ${reservation.reservationRef} after a failed checkout: ${String(releaseError)}`);
      });
      throw error;
    }
    await this.creditOrders.followUp(followUps);

    const base = {
      paymentId: result.paymentId,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      paymentMethod: method,
      creditAmount: split.creditAmount.toFixed(2),
      cashAmount: split.cashAmount.toFixed(2),
      currency: 'IRR',
      plan: { id: plan.id, title: plan.title, durationMonths: plan.durationMonths, interestRatePercent: plan.interestRatePercent.toFixed(2) },
    };
    if (method === PaymentMethod.BANK_CREDIT) {
      return { ...base, status: 'COMPLETED', orderPaymentStatus: result.orderPaymentStatus, redirectUrl: null, gatewayName: null, paymentExpiresAt: null, schedule: result.schedule };
    }
    // HYBRID: open the bank session for the card part (on failure the reservation is released and 502 is thrown).
    const initiation = await this.payments.startGatewaySession({
      paymentId: result.paymentId,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      amount: split.cashAmount,
      description: `پرداخت نقدی سفارش ${order.orderNumber} (ترکیبی با اعتبار) — ${PLATFORM_DISPLAY_NAME}`,
      customerMobile: order.user.mobile,
    });
    return {
      ...base,
      status: 'IPG_REQUIRED',
      orderPaymentStatus: result.orderPaymentStatus,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.payments.gatewayName,
      paymentExpiresAt: order.paymentExpiresAt,
      schedule: null,
    };
  }

  private async reserveAtProvider(adapter: CreditProviderAdapter, accountId: string, amount: Prisma.Decimal, parentOrderId: string): Promise<CreditReservation> {
    try {
      return await adapter.reserveCredit(accountId, amount, parentOrderId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Provider ${adapter.code} could not reserve credit for order ${parentOrderId}: ${message}`);
      throw new BadGatewayException({
        statusCode: 502,
        error: 'Bad Gateway',
        code: 'CREDIT_PROVIDER_UNAVAILABLE',
        message: 'The credit provider could not reserve the credit; try again later',
        providerCode: error instanceof CreditProviderError ? error.code : 'PROVIDER_ERROR',
      });
    }
  }

  private rejection(reason: 'INSUFFICIENT_CREDIT' | 'HYBRID_NOT_REQUIRED' | 'AMOUNT_NOT_WHOLE_RIALS', payable: Prisma.Decimal, available: Prisma.Decimal): Error {
    const details = { finalPayableAmount: payable.toFixed(2), availableAmount: available.toFixed(2) };
    switch (reason) {
      case 'INSUFFICIENT_CREDIT':
        return conflictWith('INSUFFICIENT_CREDIT', 'Your available credit does not cover this payment method; use HYBRID or card', details);
      case 'HYBRID_NOT_REQUIRED':
        return conflictWith('HYBRID_NOT_REQUIRED', 'Your available credit covers the whole order; use BANK_CREDIT', details);
      case 'AMOUNT_NOT_WHOLE_RIALS':
        return conflictWith('AMOUNT_NOT_WHOLE_RIALS', 'The order amount is not in whole rials and cannot be financed', details);
    }
  }
}

function assertPayable(order: { paymentStatus: ParentOrderPaymentStatus; paymentExpiresAt: Date | null }, now: Date): void {
  if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
    throw conflictWith('ORDER_NOT_PAYABLE', `This order is ${order.paymentStatus}; only PENDING orders can be paid`, { paymentStatus: order.paymentStatus });
  }
  if (order.paymentExpiresAt !== null && order.paymentExpiresAt <= now) {
    throw conflictWith('ORDER_PAYMENT_EXPIRED', 'The payment window of this order has closed; place the order again', { paymentExpiresAt: order.paymentExpiresAt });
  }
}
```

### `apps/backend/src/modules/bnpl/installments.service.ts`

```ts
import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, InstallmentStatus, PaymentMethod, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { conflictWith } from '../../common/http-errors';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { amountDue } from '../credit/credit-order.service';
import { calendarDateToDb, dbDateToCalendar, platformDate } from '../credit/installment-math';
import { writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { MAX_OPEN_ATTEMPTS, PaymentsService } from '../payments/payments.service';
import type { InstallmentDto, InstallmentPaymentResponseDto, InstallmentsOverviewDto, OrderInstallmentsDto } from './dto/bnpl.dto';
import { PLATFORM_DISPLAY_NAME } from '../../common/brand';

const ZERO = new Prisma.Decimal(0);

const installmentSelect = {
  id: true,
  parentOrderId: true,
  installmentNumber: true,
  totalInstallments: true,
  dueDate: true,
  principalAmount: true,
  interestAmount: true,
  penaltyAmount: true,
  totalAmount: true,
  paidAmount: true,
  status: true,
  paidAt: true,
} satisfies Prisma.InstallmentScheduleSelect;

type InstallmentRow = Prisma.InstallmentScheduleGetPayload<{ select: typeof installmentSelect }>;

/**
 * Instalments of a customer's credit purchases, and their repayment.
 *
 * Repayment goes through the platform card gateway (Phase 7 IPG): `pay` opens a
 * bank session for the amount due; the verified bank callback marks the
 * instalment PAID and restores its principal to the credit line
 * (INSTALLMENT_REPAYMENT_RESTORE) in one transaction — see PaymentsService.
 */
@Injectable()
export class InstallmentsService {
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  /**
   * PENDING instalments whose due date (Asia/Tehran calendar) has passed become
   * OVERDUE. Due on the due date itself is still PENDING. Optionally limited to
   * one customer's accounts (used before listing them).
   */
  async markOverdue(now: Date = new Date(), userId?: string): Promise<number> {
    const today = calendarDateToDb(platformDate(now));
    const result = await this.prisma.installmentSchedule.updateMany({
      where: { status: InstallmentStatus.PENDING, dueDate: { lt: today }, ...(userId ? { creditAccount: { userId } } : {}) },
      data: { status: InstallmentStatus.OVERDUE },
    });
    return result.count;
  }

  async overview(userId: string): Promise<InstallmentsOverviewDto> {
    await this.markOverdue(new Date(), userId);
    const rows = await this.prisma.installmentSchedule.findMany({
      where: { creditAccount: { userId } },
      select: installmentSelect,
      orderBy: [{ parentOrderId: 'asc' }, { installmentNumber: 'asc' }],
    });
    const orderIds = [...new Set(rows.map((row) => row.parentOrderId))];
    const [orders, creditPayments] = await Promise.all([
      this.prisma.parentOrder.findMany({ where: { id: { in: orderIds } }, select: { id: true, orderNumber: true, paymentMethod: true, paidAt: true } }),
      this.prisma.payment.findMany({
        where: { parentOrderId: { in: orderIds }, purpose: PaymentPurpose.ORDER_CHECKOUT, status: PaymentStatus.SUCCESSFUL, installmentPlanId: { not: null } },
        select: { parentOrderId: true, installmentPlan: { select: { id: true, title: true, durationMonths: true, interestRatePercent: true } } },
      }),
    ]);
    const planByOrder = new Map(creditPayments.map((payment) => [payment.parentOrderId, payment.installmentPlan]));
    const byOrder = new Map<string, InstallmentRow[]>();
    for (const row of rows) {
      byOrder.set(row.parentOrderId, [...(byOrder.get(row.parentOrderId) ?? []), row]);
    }
    const groups: OrderInstallmentsDto[] = orders
      .sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0))
      .map((order) => {
        const lines = byOrder.get(order.id) ?? [];
        const sum = (pick: (row: InstallmentRow) => Prisma.Decimal): Prisma.Decimal => lines.reduce((acc, row) => acc.plus(pick(row)), ZERO);
        const remaining = lines.reduce((acc, row) => acc.plus(isOpen(row.status) ? amountDue(row) : ZERO), ZERO);
        const plan = planByOrder.get(order.id) ?? null;
        return {
          parentOrderId: order.id,
          orderNumber: order.orderNumber,
          paymentMethod: order.paymentMethod,
          paidAt: order.paidAt,
          plan: plan ? { id: plan.id, title: plan.title, durationMonths: plan.durationMonths, interestRatePercent: plan.interestRatePercent.toFixed(2) } : null,
          creditAmount: sum((row) => row.principalAmount).toFixed(2),
          totalInterest: sum((row) => row.interestAmount).toFixed(2),
          totalPayable: sum((row) => row.totalAmount.plus(row.penaltyAmount)).toFixed(2),
          paidAmount: sum((row) => row.paidAmount).toFixed(2),
          remainingAmount: remaining.toFixed(2),
          paidCount: lines.filter((row) => row.status === InstallmentStatus.PAID).length,
          overdueCount: lines.filter((row) => row.status === InstallmentStatus.OVERDUE).length,
          installments: lines.map(toInstallmentDto),
        };
      });
    return {
      orders: groups,
      totalRemaining: groups.reduce((acc, group) => acc.plus(group.remainingAmount), ZERO).toFixed(2),
      overdueCount: groups.reduce((acc, group) => acc + group.overdueCount, 0),
    };
  }

  /** Opens a card payment for the amount due of one PENDING or OVERDUE instalment. */
  async pay(userId: string, installmentId: string, actor: OrderActor): Promise<InstallmentPaymentResponseDto> {
    const installment = await this.prisma.installmentSchedule.findFirst({
      where: { id: installmentId, creditAccount: { userId } },
      select: { ...installmentSelect, parentOrder: { select: { orderNumber: true, user: { select: { mobile: true } } } } },
    });
    if (!installment) {
      throw new NotFoundException('Instalment not found');
    }
    if (!isOpen(installment.status)) {
      throw conflictWith('INSTALLMENT_NOT_PAYABLE', `This instalment is ${installment.status}`, { installmentStatus: installment.status });
    }
    const due = amountDue(installment);
    if (!due.greaterThan(0)) {
      throw conflictWith('INSTALLMENT_NOT_PAYABLE', 'Nothing is due on this instalment', { installmentStatus: installment.status });
    }
    const open = await this.prisma.payment.count({
      where: { installmentScheduleId: installment.id, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(Date.now() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this instalment; finish or wait for one of them', this.graceMs / 1000);
    }
    const orderNumber = installment.parentOrder.orderNumber;
    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: {
          parentOrderId: installment.parentOrderId,
          purpose: PaymentPurpose.INSTALLMENT_REPAYMENT,
          paymentMethod: PaymentMethod.CASH_IPG,
          installmentScheduleId: installment.id,
          gatewayName: this.payments.gatewayName,
          cashAmount: due,
          creditAmount: 0,
          status: PaymentStatus.INITIATED,
        },
        select: { id: true },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Payment',
        entityId: created.id,
        newValue: {
          purpose: PaymentPurpose.INSTALLMENT_REPAYMENT,
          installmentScheduleId: installment.id,
          installmentNumber: installment.installmentNumber,
          orderNumber,
          amount: due.toFixed(2),
          gatewayName: this.payments.gatewayName,
        },
      });
      return created;
    });
    const initiation = await this.payments.startGatewaySession({
      paymentId: payment.id,
      parentOrderId: installment.parentOrderId,
      orderNumber,
      amount: due,
      description: `پرداخت قسط ${installment.installmentNumber} از ${installment.totalInstallments} سفارش ${orderNumber} — ${PLATFORM_DISPLAY_NAME}`,
      customerMobile: installment.parentOrder.user.mobile,
    });
    return {
      paymentId: payment.id,
      installmentId: installment.id,
      installmentNumber: installment.installmentNumber,
      totalInstallments: installment.totalInstallments,
      orderNumber,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.payments.gatewayName,
      amount: due.toFixed(2),
      currency: 'IRR',
    };
  }
}

function isOpen(status: InstallmentStatus): boolean {
  return status === InstallmentStatus.PENDING || status === InstallmentStatus.OVERDUE;
}

function toInstallmentDto(row: InstallmentRow): InstallmentDto {
  return {
    id: row.id,
    installmentNumber: row.installmentNumber,
    totalInstallments: row.totalInstallments,
    dueDate: dbDateToCalendar(row.dueDate),
    principalAmount: row.principalAmount.toFixed(2),
    interestAmount: row.interestAmount.toFixed(2),
    penaltyAmount: row.penaltyAmount.toFixed(2),
    totalAmount: row.totalAmount.toFixed(2),
    paidAmount: row.paidAmount.toFixed(2),
    amountDue: (isOpen(row.status) ? amountDue(row) : ZERO).toFixed(2),
    status: row.status,
    paidAt: row.paidAt,
  };
}
```

### `apps/backend/src/modules/cart/dto/cart-response.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const CART_ISSUE_CODES = [
  'VARIANT_INACTIVE',
  'PRODUCT_UNPUBLISHED',
  'PRODUCT_BLOCKED',
  'STORE_UNAVAILABLE',
  'CATEGORY_UNAVAILABLE',
  'OUT_OF_STOCK',
  'INSUFFICIENT_STOCK',
  'PRICE_CHANGED',
] as const;
export type CartIssueCode = (typeof CART_ISSUE_CODES)[number];

export const MERGE_DROP_REASONS = [...CART_ISSUE_CODES, 'CART_FULL'] as const;
export type MergeDropReason = (typeof MERGE_DROP_REASONS)[number];

export class CartIssueDto {
  @ApiProperty({ enum: CART_ISSUE_CODES })
  code!: CartIssueCode;

  @ApiProperty({ example: 'Only 2 left in stock' })
  message!: string;
}

export class CartImageDto {
  @ApiProperty()
  url!: string;

  @ApiProperty({ nullable: true, type: String })
  thumbnailUrl!: string | null;
}

export class CartLineDto {
  @ApiProperty({ format: 'uuid', description: 'Cart line id (use it for PATCH/DELETE /cart/items/:id).' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productVariantId!: string;

  @ApiProperty({ example: 'SHP-X1-256-BLK' })
  sku!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ example: 'shopino-sample-smartphone-x1' })
  productSlug!: string;

  @ApiProperty({ example: 'گوشی موبایل نمونه X1' })
  productTitle!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ type: CartImageDto, nullable: true })
  image!: CartImageDto | null;

  @ApiProperty({ example: 1 })
  quantity!: number;

  @ApiProperty({ example: '42500000.00', description: 'Live selling price of the variant.' })
  unitPrice!: string;

  @ApiProperty({ example: '42000000.00', description: 'Price the customer last saw for this line.' })
  priceWhenAdded!: string;

  @ApiProperty({ example: '45000000.00', nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ example: '42500000.00', description: 'unitPrice × quantity.' })
  lineTotal!: string;

  @ApiProperty({ example: 12, description: 'Units that can still be bought right now.' })
  availableQuantity!: number;

  @ApiProperty({ description: 'False when the variant cannot be bought at all (see issues).' })
  isPurchasable!: boolean;

  @ApiProperty({ type: [CartIssueDto] })
  issues!: CartIssueDto[];

  @ApiProperty()
  addedAt!: Date;
}

export class CartVendorDto {
  @ApiProperty({ example: 'فروشگاه نمونه شاگردم' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;
}

export class CartShippingDto {
  @ApiProperty({ example: '500000.00' })
  fee!: string;

  @ApiProperty()
  isFree!: boolean;

  @ApiProperty({ example: '10000000.00', description: 'Free-shipping threshold for this store ("0.00" = none).' })
  freeThreshold!: string;

  @ApiProperty({ example: '1500000.00', nullable: true, type: String, description: 'Missing amount for free shipping.' })
  remainingForFreeShipping!: string | null;
}

export class CartVendorGroupDto {
  @ApiProperty({ type: CartVendorDto })
  vendor!: CartVendorDto;

  @ApiProperty({ type: [CartLineDto] })
  lines!: CartLineDto[];

  @ApiProperty({ example: '85000000.00', description: 'Sum of line totals of purchasable lines.' })
  itemsSubtotal!: string;

  @ApiProperty({ type: CartShippingDto, description: 'Estimate for this store package with the current policy.' })
  shipping!: CartShippingDto;

  @ApiProperty({ example: '85500000.00' })
  packageTotal!: string;
}

export class CartDto {
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Guest cart token, returned only in the response that created the guest cart. Send it back in the X-Cart-Token header.',
  })
  cartToken!: string | null;

  @ApiProperty({ enum: ['user', 'guest', 'none'], description: '"none": no cart exists yet.' })
  owner!: 'user' | 'guest' | 'none';

  @ApiProperty({ type: [CartVendorGroupDto], description: 'Lines grouped by store, in the order stores were added.' })
  groups!: CartVendorGroupDto[];

  @ApiProperty({ example: 3, description: 'Total units.' })
  itemCount!: number;

  @ApiProperty({ example: 2 })
  lineCount!: number;

  @ApiProperty({ example: '85000000.00' })
  itemsSubtotal!: string;

  @ApiProperty({ example: '500000.00' })
  shippingTotal!: string;

  @ApiProperty({ example: '85500000.00' })
  payableAmount!: string;

  @ApiProperty({ description: 'True when at least one line has a changed price.' })
  hasPriceChanges!: boolean;

  @ApiProperty({ description: 'True when the cart is non-empty and no line has an issue.' })
  canCheckout!: boolean;
}

export class MergeAdjustmentDto {
  @ApiProperty({ format: 'uuid' })
  productVariantId!: string;

  @ApiProperty({ example: 'SHP-X1-256-BLK' })
  sku!: string;

  @ApiPropertyOptional({ example: 5, description: 'Quantity the merge wanted to place.' })
  requested?: number;

  @ApiPropertyOptional({ example: 3, description: 'Quantity actually placed (limited by stock).' })
  applied?: number;

  @ApiPropertyOptional({ enum: MERGE_DROP_REASONS, description: 'Why the line was dropped.' })
  reason?: MergeDropReason;
}

export class MergeReportDto {
  @ApiProperty({ example: 2, description: 'Guest lines moved into the account cart (new or combined).' })
  mergedLines!: number;

  @ApiProperty({ type: [MergeAdjustmentDto], description: 'Lines whose combined quantity exceeded stock.' })
  clampedLines!: MergeAdjustmentDto[];

  @ApiProperty({ type: [MergeAdjustmentDto], description: 'Lines that could not be merged (unavailable, no stock, cart full).' })
  droppedLines!: MergeAdjustmentDto[];
}

export class MergeCartResponseDto {
  @ApiProperty({ type: CartDto })
  cart!: CartDto;

  @ApiProperty({ type: MergeReportDto })
  report!: MergeReportDto;
}
```

### `apps/backend/src/modules/disputes/dispute-notifier.ts`

```ts
import { Injectable, Logger } from '@nestjs/common';
import { DisputeEventType } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { SmsService } from '../sms/sms.service';

/** Transactional SMS sent to the customer when a dispute is decided in their favour. `{key}` placeholders are filled by the provider. */
export const DISPUTE_REFUND_TEMPLATE =
  'شاگردم: اختلاف مرسولهٔ {subOrderNumber} به نفع شما حل شد. مبلغ {amount} ریال به شما بازگردانده می‌شود.';

export interface RefundNotice {
  disputeId: string;
  mobile: string;
  subOrderNumber: string;
  amount: string;
}

/**
 * Refund notice of a buyer-favour decision. Runs **after** the decision has
 * committed: an SMS outage must never roll back a financial resolution. The
 * outcome (sent with the provider reference, or failed) is appended to the
 * dispute timeline so staff can see who still has to be told.
 */
@Injectable()
export class DisputeNotifier {
  private readonly logger = new Logger(DisputeNotifier.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sms: SmsService,
  ) {}

  async refundNotice(notice: RefundNotice): Promise<void> {
    try {
      const sent = await this.sms.sendTransactional(notice.mobile, DISPUTE_REFUND_TEMPLATE, {
        subOrderNumber: notice.subOrderNumber,
        amount: notice.amount,
      });
      await this.record(notice.disputeId, DisputeEventType.REFUND_NOTICE_SENT, 'Refund notice sent by SMS', {
        provider: sent.provider,
        referenceId: sent.referenceId,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Refund notice for dispute ${notice.disputeId} failed: ${detail}`);
      await this.record(notice.disputeId, DisputeEventType.REFUND_NOTICE_FAILED, 'Refund notice could not be sent; contact the customer', {
        error: detail.slice(0, 300),
      }).catch((recordError: unknown) => {
        this.logger.error(`Could not record the failed refund notice of dispute ${notice.disputeId}: ${String(recordError)}`);
      });
    }
  }

  private async record(disputeId: string, type: DisputeEventType, note: string, data: Record<string, string>): Promise<void> {
    await this.prisma.disputeEvent.create({ data: { disputeId, type, actorRole: 'SYSTEM', note, data } });
  }
}
```

### `apps/backend/src/modules/importer/dto/import.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsString, MaxLength, MinLength } from 'class-validator';
import { MAX_MEDIA_PER_PRODUCT } from '../../products/product-rules';
import { MAX_IMPORT_URL_LENGTH } from '../net/import-url';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const trimEach = ({ value }: { value: unknown }): unknown =>
  Array.isArray(value) ? (value as unknown[]).map((entry): unknown => (typeof entry === 'string' ? entry.trim() : entry)) : value;

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export class ExtractSpecDto {
  @ApiProperty({
    example: 'https://www.digikala.com/product/dkp-13196935/',
    maxLength: MAX_IMPORT_URL_LENGTH,
    description:
      'Product page to read: a Digikala product URL (…/product/dkp-<id>/…) or any storefront page publishing ' +
      'schema.org Product (JSON-LD / microdata), WooCommerce attributes or OpenGraph product tags. http(s) on ports 80/443 only; ' +
      'private, loopback and reserved network targets are refused.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_IMPORT_URL_LENGTH)
  url!: string;
}

export class IngestImagesDto {
  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_MEDIA_PER_PRODUCT,
    example: ['https://dkstatics-public.digikala.com/digikala-products/47ed1a2e4cc50360e929b6e8a1ca3f0696d69be8_1698777217.jpg'],
    description: `Remote images to download into the media pipeline (at most ${MAX_MEDIA_PER_PRODUCT}, the size of a product gallery). Duplicates are ignored.`,
  })
  @Transform(trimEach)
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_MEDIA_PER_PRODUCT)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(MAX_IMPORT_URL_LENGTH, { each: true })
  imageUrls!: string[];
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

export class ExtractedSpecificationDto {
  @ApiProperty({ example: 'حافظه', nullable: true, type: String, description: 'Specification group on the source page.' })
  group!: string | null;

  @ApiProperty({ example: 'حافظه داخلی' })
  title!: string;

  @ApiProperty({ example: '256 گیگابایت' })
  value!: string;
}

export class ExtractSpecResponseDto {
  @ApiProperty({ enum: ['DIGIKALA', 'GENERIC'], example: 'DIGIKALA' })
  source!: 'DIGIKALA' | 'GENERIC';

  @ApiProperty({
    type: [String],
    example: ['DIGIKALA_API'],
    description: 'Parsers whose data is in this draft: DIGIKALA_API, JSON_LD, MICRODATA, WOOCOMMERCE_ATTRIBUTES, OPEN_GRAPH, HTML_META.',
  })
  strategies!: string[];

  @ApiProperty({ example: 'https://www.digikala.com/product/dkp-13196935/' })
  sourceUrl!: string;

  @ApiProperty({ example: 'dkp-13196935', nullable: true, type: String })
  sourceProductId!: string | null;

  @ApiProperty({ example: 'گوشی موبایل سامسونگ مدل Galaxy S24 Ultra' })
  title!: string;

  @ApiProperty({ example: 'Samsung Galaxy S24 Ultra', nullable: true, type: String })
  titleEn!: string | null;

  @ApiProperty({ example: 'سامسونگ', nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ example: 'توضیحات و نقد و بررسی محصول…', nullable: true, type: String, description: 'Plain text; paragraphs separated by line breaks.' })
  description!: string | null;

  @ApiProperty({ example: 'گوشی موبایل', nullable: true, type: String })
  suggestedCategory!: string | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Active local category whose name matches the source category (or one of its breadcrumb parents), if any.',
  })
  suggestedCategoryId!: string | null;

  @ApiProperty({ type: () => [ExtractedSpecificationDto] })
  specifications!: ExtractedSpecificationDto[];

  @ApiProperty({ type: [String], description: 'Absolute image URLs, best available resolution, primary image first.' })
  imageUrls!: string[];
}

export class IngestedImageDto {
  @ApiProperty({ description: 'The remote URL this asset was created from.' })
  sourceUrl!: string;

  @ApiProperty({ format: 'uuid', description: 'Media asset id — usable in mediaIds of POST /vendor/products.' })
  id!: string;

  @ApiProperty({ example: '/api/v1/media/files/images/product_image/2026/10/….webp' })
  url!: string;

  @ApiProperty({ example: '/api/v1/media/files/images/product_image/2026/10/…_thumb.webp' })
  thumbnailUrl!: string;

  @ApiProperty({ example: 1200 })
  width!: number;

  @ApiProperty({ example: 1200 })
  height!: number;

  @ApiProperty({ example: 84210, description: 'Stored WebP size in bytes.' })
  sizeBytes!: number;
}

export class FailedImageDto {
  @ApiProperty()
  sourceUrl!: string;

  @ApiProperty({ example: 'TOO_LARGE', description: 'Importer error code, or INVALID_IMAGE when the media pipeline rejected the file.' })
  code!: string;

  @ApiProperty({ example: 'The response is larger than 5 MB' })
  message!: string;
}

export class IngestImagesResponseDto {
  @ApiProperty({ type: () => [IngestedImageDto], description: 'Stored assets, in the order requested.' })
  items!: IngestedImageDto[];

  @ApiProperty({ type: () => [FailedImageDto], description: 'Images that could not be imported, with the reason. The others are still stored.' })
  failures!: FailedImageDto[];
}
```

### `apps/backend/src/modules/importer/extractors/digikala.extractor.spec.ts`

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DigikalaExtractor,
  digikalaProductId,
  originalDigikalaImage,
  parseDigikalaProduct,
  type DigikalaApiResponse,
} from './digikala.extractor';
import type { ExtractedProduct } from './extracted-product';
import type { GenericSchemaOrgExtractor } from './generic-schema.extractor';
import { ImportError } from '../import-error';
import type { SafeFetchResult, SafeHttpClient } from '../net/safe-http-client';

const FIXTURES = join(__dirname, '../../../../test/fixtures/importer');
const fixture = (id: string): DigikalaApiResponse =>
  JSON.parse(readFileSync(join(FIXTURES, `digikala-dkp-${id}.json`), 'utf8')) as DigikalaApiResponse;

function product(document: DigikalaApiResponse, id: string): ExtractedProduct {
  const result = parseDigikalaProduct(document, id);
  if (result.kind !== 'product') throw new Error(`expected a product, got ${result.kind}`);
  return result.product;
}

describe('digikalaProductId', () => {
  it.each([
    ['https://www.digikala.com/product/dkp-13196935/', '13196935'],
    ['https://digikala.com/product/dkp-13196935/%D8%A8%D8%B1%DA%86%D8%B3%D8%A8', '13196935'],
    ['https://www.digikala.com/product/dkp-18010600/slug/?variant=1', '18010600'],
    ['https://m.digikala.com/product/dkp-42/', '42'],
  ])('reads %s', (url, id) => {
    expect(digikalaProductId(new URL(url))).toBe(id);
  });

  it.each([
    'https://www.digikala.com/search/category-mobile-phone/',
    'https://www.digikala.com/product/abc/',
    'https://digikala.com.evil.example/product/dkp-1/',
    'https://evil-digikala.com/product/dkp-1/',
    'https://example.com/product/dkp-13196935/',
  ])('ignores %s', (url) => {
    expect(digikalaProductId(new URL(url))).toBeNull();
  });
});

describe('originalDigikalaImage', () => {
  it('drops the resize query to get the original upload', () => {
    expect(
      originalDigikalaImage(
        'https://dkstatics-public.digikala.com/digikala-products/abc_1.jpg?x-oss-process=image/resize,m_lfit,h_800,w_800/quality,q_90',
      ),
    ).toBe('https://dkstatics-public.digikala.com/digikala-products/abc_1.jpg');
  });

  it('refuses non-Digikala or non-https hosts', () => {
    expect(originalDigikalaImage('https://evil.example/digikala-products/abc.jpg')).toBeNull();
    expect(originalDigikalaImage('http://dkstatics-public.digikala.com/a.jpg')).toBeNull();
    expect(originalDigikalaImage('')).toBeNull();
    expect(originalDigikalaImage(null)).toBeNull();
  });
});

describe('parseDigikalaProduct — captured response dkp-13196935 (cover sticker)', () => {
  const draft = product(fixture('13196935'), '13196935');

  it('maps identity, titles and brand', () => {
    expect(draft.source).toBe('DIGIKALA');
    expect(draft.strategies).toEqual(['DIGIKALA_API']);
    expect(draft.sourceProductId).toBe('dkp-13196935');
    expect(draft.sourceUrl).toBe('https://www.digikala.com/product/dkp-13196935/');
    expect(draft.title).toBe('برچسب پوششی ماهوت مدل Iran Tile 11 مناسب برای گوشی موبایل هوآوی Y5 Lite');
    expect(draft.titleEn).toBe('MAHOOT Iran Tile 11 Cover Sticker for Huawei Y5 Lite');
    expect(draft.brand).toBe('ماهوت');
    expect(draft.description).toBe('طرح کاشی 11 از سری طرح های محصولات ماهوت.');
  });

  it('uses the category and the breadcrumb (most specific first, without home and product)', () => {
    expect(draft.suggestedCategory).toBe('کیف و کاور گوشی');
    expect(draft.categoryCandidates).toEqual(['کیف و کاور گوشی', 'لوازم جانبی گوشی موبایل', 'لوازم جانبی کالای دیجیتال', 'کالای دیجیتال']);
  });

  it('extracts every specification, trimmed, with its group', () => {
    expect(draft.specifications).toHaveLength(7);
    expect(draft.specifications.slice(0, 6)).toEqual([
      { group: 'مشخصات', title: 'جنس', value: 'پلی کربنات' },
      { group: 'مشخصات', title: 'وزن', value: '5 گرم' },
      { group: 'مشخصات', title: 'سازگار با گوشی موبایل', value: 'سایر گوشی‌های موبایل' },
      { group: 'مشخصات', title: 'ساختار', value: 'مات' },
      { group: 'مشخصات', title: 'سطح پوشش', value: 'قاب پشتی' },
      { group: 'مشخصات', title: 'ویژگی‌های کیف و کاور', value: 'مقاوم در برابر آب' },
    ]);
  });

  it('keeps multi-line values as lines, normalising CRLF and Arabic letters', () => {
    const other = draft.specifications.find((spec) => spec.title === 'سایر توضیحات');
    const lines = other?.value.split('\n') ?? [];
    expect(lines).toHaveLength(7);
    expect(lines[0]).toBe('ضخامت 0.2 میلیمتر');
    // The source writes «امكان» with an Arabic kaf (U+0643); it is stored with the Persian «ک».
    expect(lines[5]).toBe('امکان استفاده همزمان با گارد و بامپر');
    expect(other?.value).not.toMatch(/\r|\u0643|\s$/);
  });

  it('collects the gallery at original resolution without duplicates', () => {
    expect(draft.imageUrls).toEqual([
      'https://dkstatics-public.digikala.com/digikala-products/47ed1a2e4cc50360e929b6e8a1ca3f0696d69be8_1698777217.jpg',
      'https://dkstatics-public.digikala.com/digikala-products/c12f7a31bc4120ac140cbc4ea7af7feb153fe23c_1698777218.jpg',
      'https://dkstatics-public.digikala.com/digikala-products/2a77338a8ae4b75f5f1c8c33e697290058d69fb7_1698777219.jpg',
      'https://dkstatics-public.digikala.com/digikala-products/fb5a186a8e1ab7e1f76f9fae3eec7ba17c0541e6_1698777218.jpg',
    ]);
  });
});

describe('parseDigikalaProduct — captured response dkp-18010600 (Galaxy S24 Ultra)', () => {
  const draft = product(fixture('18010600'), '18010600');

  it('maps a phone with a grouped specification table', () => {
    expect(draft.title).toContain('Galaxy S24 Ultra');
    expect(draft.title).not.toContain('  '); // double space in the source title collapsed
    expect(draft.titleEn).toBe('Samsung Galaxy S24 Ultra Dual SIM 256GB And 12GB RAM Mobile Phone - Vietnam');
    expect(draft.brand).toBe('سامسونگ');
    expect(draft.suggestedCategory).toBe('گوشی موبایل');
    expect(new Set(draft.specifications.map((spec) => spec.group))).toEqual(new Set(['دوربین', 'ارتباطات']));
    expect(draft.specifications).toContainEqual({ group: 'دوربین', title: 'رزولوشن دوربین اصلی', value: '200 مگاپیکسل' });
  });

  it('joins several values of one attribute with a Persian comma', () => {
    expect(draft.specifications).toContainEqual({
      group: 'ارتباطات',
      title: 'فناوری مکان‌یابی (GPS)',
      value: 'GPS، GLONASS، GALILEO، BDS(Beidou)',
    });
    expect(draft.specifications).toContainEqual({ group: 'ارتباطات', title: 'شبکه‌های ارتباطی قابل پشتیبانی', value: 'Wi-Fi، بلوتوث' });
  });

  it('decodes HTML entities such as &zwnj; in the review text', () => {
    expect(draft.description).toContain('گوشی‌های پرچمدار');
    expect(draft.description).not.toContain('&zwnj;');
    expect(draft.description?.split('\n')).toHaveLength(2);
  });

  it('returns the full 10-image gallery', () => {
    expect(draft.imageUrls).toHaveLength(10);
    expect(draft.imageUrls.every((url) => url.startsWith('https://dkstatics-public.digikala.com/') && !url.includes('?'))).toBe(true);
  });
});

describe('parseDigikalaProduct — edge cases', () => {
  it('reports a missing product', () => {
    expect(parseDigikalaProduct({ status: 404 }, '1')).toEqual({ kind: 'not-found' });
    expect(parseDigikalaProduct({ status: 200, data: { product: null } }, '1')).toEqual({ kind: 'not-found' });
    expect(parseDigikalaProduct({ status: 200, data: { product: { id: 1, title_fa: '  ', title_en: '' } } }, '1')).toEqual({
      kind: 'not-found',
    });
  });

  it('follows the API redirect to a merged product', () => {
    expect(parseDigikalaProduct({ status: 302, redirect_url: { uri: '/product/dkp-777/' } }, '1')).toEqual({
      kind: 'redirect',
      productId: '777',
    });
  });

  it('drops placeholder brands', () => {
    const base = fixture('13196935');
    const misc = structuredClone(base);
    misc.data!.product!.brand = { title_fa: 'متفرقه', title_en: 'Miscellaneous' };
    expect(product(misc, '13196935').brand).toBeNull();
    const flagged = structuredClone(base);
    flagged.data!.product!.brand = { title_fa: 'برند', is_miscellaneous: true };
    expect(product(flagged, '13196935').brand).toBeNull();
  });

  it('skips attributes without a title or value and de-duplicates repeated ones', () => {
    const doc = structuredClone(fixture('13196935'));
    doc.data!.product!.specifications = [
      {
        title: 'کلی',
        attributes: [
          { title: 'وزن', values: ['5 گرم'] },
          { title: 'وزن', values: ['6 گرم'] },
          { title: '', values: ['x'] },
          { title: 'رنگ', values: ['  ', ''] },
        ],
      },
    ];
    expect(product(doc, '13196935').specifications).toEqual([{ group: 'کلی', title: 'وزن', value: '5 گرم' }]);
  });
});

describe('DigikalaExtractor', () => {
  const json = (body: unknown, status = 200): SafeFetchResult => ({
    url: new URL('https://api.digikala.com/v2/product/1/'),
    status,
    contentType: 'application/json',
    body: Buffer.from(JSON.stringify(body)),
  });

  interface Harness {
    extractor: DigikalaExtractor;
    calls: string[];
    fallbackCalls: jest.Mock;
  }

  function build(responses: Array<SafeFetchResult | ImportError>, fallback?: ExtractedProduct | ImportError): Harness {
    const calls: string[] = [];
    const http = {
      fetch: jest.fn((url: string | URL) => {
        calls.push(String(url));
        const next = responses.shift();
        if (!next) throw new Error('unexpected request');
        return next instanceof ImportError ? Promise.reject(next) : Promise.resolve(next);
      }),
    } as unknown as SafeHttpClient;
    const fallbackCalls = jest.fn(() =>
      fallback instanceof ImportError || fallback === undefined
        ? Promise.reject(fallback ?? new ImportError('NOT_A_PRODUCT', 'no fallback'))
        : Promise.resolve(fallback),
    );
    const generic = { extract: fallbackCalls } as unknown as GenericSchemaOrgExtractor;
    return { extractor: new DigikalaExtractor(http, generic, 'https://api.digikala.com'), calls, fallbackCalls };
  }

  const url = new URL('https://www.digikala.com/product/dkp-13196935/slug/');

  it('reads the product from the public API endpoint', async () => {
    const { extractor, calls } = build([json(fixture('13196935'))]);
    const result = await extractor.extract(url);
    expect(calls).toEqual(['https://api.digikala.com/v2/product/13196935/']);
    expect(result.title).toContain('Iran Tile 11');
    expect(result.specifications).toHaveLength(7);
  });

  it('follows one product redirect', async () => {
    const { extractor, calls } = build([json({ status: 302, redirect_url: { uri: '/product/dkp-18010600/' } }), json(fixture('18010600'))]);
    const result = await extractor.extract(url);
    expect(calls[1]).toBe('https://api.digikala.com/v2/product/18010600/');
    expect(result.sourceProductId).toBe('dkp-18010600');
  });

  it('reports an unknown product as NOT_FOUND without trying the page', async () => {
    const { extractor, fallbackCalls } = build([json({ status: 404 }, 404)]);
    await expect(extractor.extract(url)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(fallbackCalls).not.toHaveBeenCalled();
  });

  it('falls back to the product page when the API is unavailable', async () => {
    const pageDraft: ExtractedProduct = {
      source: 'GENERIC',
      strategies: ['JSON_LD'],
      sourceUrl: url.toString(),
      sourceProductId: null,
      title: 'from page',
      titleEn: null,
      brand: null,
      description: null,
      suggestedCategory: null,
      categoryCandidates: [],
      specifications: [],
      imageUrls: [],
    };
    const { extractor } = build([new ImportError('TIMEOUT', 'slow')], pageDraft);
    await expect(extractor.extract(url)).resolves.toMatchObject({ title: 'from page', source: 'DIGIKALA', sourceProductId: 'dkp-13196935' });
  });

  it('surfaces the API error when the fallback also fails', async () => {
    const { extractor } = build([json({}, 503)], new ImportError('NOT_A_PRODUCT', 'client-rendered page'));
    await expect(extractor.extract(url)).rejects.toMatchObject({ code: 'UPSTREAM_STATUS' });
  });

  it('rejects a non-JSON API answer as unsupported content (then tries the page)', async () => {
    const { extractor, fallbackCalls } = build([{ ...json({}), body: Buffer.from('<html>captcha</html>') }]);
    await expect(extractor.extract(url)).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' });
    expect(fallbackCalls).toHaveBeenCalledTimes(1);
  });

  it('rejects URLs that are not Digikala product pages', async () => {
    const { extractor } = build([]);
    await expect(extractor.extract(new URL('https://www.digikala.com/search/'))).rejects.toMatchObject({ code: 'INVALID_URL' });
  });
});
```

### `apps/backend/src/modules/importer/extractors/digikala.extractor.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ImportError } from '../import-error';
import { SafeHttpClient } from '../net/safe-http-client';
import {
  finalizeProduct,
  htmlToText,
  type ExtractedProduct,
  type ExtractedSpecification,
} from './extracted-product';
import { GenericSchemaOrgExtractor } from './generic-schema.extractor';

/**
 * Origin of Digikala's public product API. A provider token (not configuration)
 * so only the automated test suite can point it at a local fixture server.
 */
export const DIGIKALA_API_ORIGIN = Symbol('DIGIKALA_API_ORIGIN');
export const DIGIKALA_PUBLIC_API_ORIGIN = 'https://api.digikala.com';

const DIGIKALA_HOSTS = new Set(['digikala.com', 'www.digikala.com', 'm.digikala.com']);
const PRODUCT_PATH = /\/product\/dkp-(\d{1,12})(?:[/?#]|$)/i;
/** Digikala's CDN; gallery URLs outside it are ignored. */
const IMAGE_HOST_SUFFIX = '.digikala.com';
/** The API JSON of a product is ~50–400 KB; 4 MB leaves ample headroom. */
const MAX_API_RESPONSE_BYTES = 4 * 1024 * 1024;
/** Brands Digikala uses for "no brand" — not a brand a vendor should inherit. */
const PLACEHOLDER_BRANDS = new Set(['متفرقه', 'miscellaneous', 'نامشخص', 'غیره']);

/** `dkp-…` id of a Digikala product URL, or `null` when the URL is not one. */
export function digikalaProductId(url: URL): string | null {
  if (!DIGIKALA_HOSTS.has(url.hostname.toLowerCase().replace(/\.$/, ''))) {
    return null;
  }
  const match = PRODUCT_PATH.exec(url.pathname);
  return match ? match[1]! : null;
}

// ---------------------------------------------------------------------------
// Response shape (only the fields we read; everything is optional because the
// API is not a contract we control)
// ---------------------------------------------------------------------------

interface DkImage {
  url?: Array<string | null> | null;
}

interface DkProduct {
  id?: number;
  title_fa?: string | null;
  title_en?: string | null;
  is_inactive?: boolean;
  brand?: { title_fa?: string | null; title_en?: string | null; is_miscellaneous?: boolean } | null;
  category?: { title_fa?: string | null } | null;
  breadcrumb?: Array<{ title?: string | null; url?: { uri?: string | null } | null }> | null;
  images?: { main?: DkImage | null; list?: DkImage[] | null } | null;
  review?: { description?: string | null } | null;
  expert_reviews?: { description?: string | null; short_review?: string | null } | null;
  specifications?: Array<{
    title?: string | null;
    attributes?: Array<{ title?: string | null; values?: Array<string | null> | null }> | null;
  }> | null;
}

export interface DigikalaApiResponse {
  status?: number;
  data?: { product?: DkProduct | null } | null;
  redirect_url?: { uri?: string | null } | null;
}

/** Outcome of reading one API document: a product, a redirect to another id, or nothing. */
export type DigikalaParseResult =
  | { kind: 'product'; product: ExtractedProduct }
  | { kind: 'redirect'; productId: string }
  | { kind: 'not-found' };

/**
 * Original-resolution URL of a CDN image. Digikala serves resized variants
 * through an `x-oss-process` query; dropping the query yields the original
 * upload, which our own pipeline then resizes to 1600 px and a 300 px thumbnail.
 */
export function originalDigikalaImage(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) {
    return null;
  }
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || !url.hostname.endsWith(IMAGE_HOST_SUFFIX)) {
      return null;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Pure mapping of a Digikala `v2/product/{id}` document to a product draft.
 * Kept free of I/O so it is unit-tested against captured API responses.
 */
export function parseDigikalaProduct(document: DigikalaApiResponse, productId: string): DigikalaParseResult {
  if (document.status === 302) {
    const target = document.redirect_url?.uri ? PRODUCT_PATH.exec(document.redirect_url.uri) : null;
    return target ? { kind: 'redirect', productId: target[1]! } : { kind: 'not-found' };
  }
  const product = document.data?.product;
  if (document.status !== 200 || !product) {
    return { kind: 'not-found' };
  }
  const titleFa = product.title_fa?.trim() ?? '';
  const titleEn = product.title_en?.trim() ?? '';
  if (titleFa.length === 0 && titleEn.length === 0) {
    return { kind: 'not-found' };
  }

  const specifications: ExtractedSpecification[] = [];
  for (const group of product.specifications ?? []) {
    for (const attribute of group.attributes ?? []) {
      const values = (attribute.values ?? []).filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
      if (!attribute.title || values.length === 0) continue;
      // Several values of one attribute ("5G", "4G", "3G") are one comma list;
      // a single multi-line value keeps its own line breaks.
      specifications.push({ group: group.title ?? null, title: attribute.title, value: values.map((value) => value.trim()).join('، ') });
    }
  }

  const imageUrls = [product.images?.main, ...(product.images?.list ?? [])]
    .map((image) => originalDigikalaImage(image?.url?.[0]))
    .filter((url): url is string => url !== null);

  const brandTitle = product.brand?.title_fa?.trim() || product.brand?.title_en?.trim() || '';
  const brand =
    product.brand?.is_miscellaneous === true || PLACEHOLDER_BRANDS.has(brandTitle.toLowerCase()) ? null : brandTitle || null;

  const descriptionHtml =
    product.expert_reviews?.description?.trim() || product.review?.description?.trim() || product.expert_reviews?.short_review?.trim() || '';

  // Breadcrumb: [Digikala home, …categories…, the product itself] → categories, most specific first.
  const crumbs = (product.breadcrumb ?? [])
    .filter((crumb) => crumb.url?.uri && !crumb.url.uri.startsWith('/product/') && crumb.url.uri !== '/')
    .map((crumb) => crumb.title ?? '')
    .reverse();
  const category = product.category?.title_fa?.trim() || null;

  return {
    kind: 'product',
    product: finalizeProduct({
      source: 'DIGIKALA',
      strategies: ['DIGIKALA_API'],
      sourceUrl: `https://www.digikala.com/product/dkp-${product.id ?? productId}/`,
      sourceProductId: `dkp-${product.id ?? productId}`,
      title: titleFa || titleEn,
      titleEn: titleEn || null,
      brand,
      description: descriptionHtml ? htmlToText(descriptionHtml) : null,
      suggestedCategory: category,
      categoryCandidates: [...(category ? [category] : []), ...crumbs],
      specifications,
      imageUrls,
    }),
  };
}

/**
 * Strategy A — Digikala.
 *
 * Reads the product through Digikala's public JSON API (`/v2/product/{id}/`),
 * which carries the full specification table and gallery that the
 * client-rendered HTML page does not. If the API is unreachable or answers with
 * an error, the product *page* is tried with the generic Schema.org/OpenGraph
 * parser before giving up.
 */
@Injectable()
export class DigikalaExtractor {
  private readonly logger = new Logger(DigikalaExtractor.name);

  constructor(
    private readonly http: SafeHttpClient,
    private readonly generic: GenericSchemaOrgExtractor,
    @Inject(DIGIKALA_API_ORIGIN) private readonly apiOrigin: string,
  ) {}

  matches(url: URL): boolean {
    return digikalaProductId(url) !== null;
  }

  async extract(url: URL): Promise<ExtractedProduct> {
    let productId = digikalaProductId(url);
    if (productId === null) {
      throw new ImportError('INVALID_URL', 'Not a Digikala product URL (expected …/product/dkp-<number>/…)');
    }

    try {
      // One redirect (a merged/renumbered product) is followed; more means a loop.
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = parseDigikalaProduct(await this.fetchApi(productId), productId);
        if (result.kind === 'product') return result.product;
        if (result.kind === 'not-found') {
          throw new ImportError('NOT_FOUND', `Digikala has no active product dkp-${productId}`);
        }
        productId = result.productId;
      }
      throw new ImportError('NOT_FOUND', 'Digikala redirected this product more than once');
    } catch (error) {
      if (!(error instanceof ImportError) || error.code === 'NOT_FOUND' || error.code === 'BLOCKED_TARGET') {
        throw error;
      }
      this.logger.warn(`Digikala API failed for dkp-${productId} (${error.code}: ${error.message}); trying the product page`);
      try {
        const fallback = await this.generic.extract(url);
        return { ...fallback, source: 'DIGIKALA', sourceProductId: `dkp-${productId}` };
      } catch (fallbackError) {
        this.logger.warn(`Digikala page fallback failed: ${String(fallbackError)}`);
        throw error;
      }
    }
  }

  private async fetchApi(productId: string): Promise<DigikalaApiResponse> {
    const response = await this.http.fetch(`${this.apiOrigin}/v2/product/${productId}/`, {
      accept: 'application/json',
      maxBytes: MAX_API_RESPONSE_BYTES,
      headers: { referer: 'https://www.digikala.com/', origin: 'https://www.digikala.com' },
    });
    // The API answers unknown ids with an HTTP error *or* a JSON `status`; both are handled.
    if (response.status === 404) {
      return { status: 404 };
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ImportError('UPSTREAM_STATUS', `Digikala answered HTTP ${response.status}`);
    }
    try {
      return JSON.parse(response.body.toString('utf8')) as DigikalaApiResponse;
    } catch {
      throw new ImportError('UNSUPPORTED_CONTENT', 'Digikala returned a response that is not JSON');
    }
  }
}
```

### `apps/backend/src/modules/importer/extractors/extracted-product.ts`

```ts
import {
  MAX_SPECIFICATIONS_PER_PRODUCT,
  SPECIFICATION_GROUP_MAX_LENGTH,
  SPECIFICATION_TITLE_MAX_LENGTH,
  SPECIFICATION_VALUE_MAX_LENGTH,
} from '../../products/product-rules';
import { normalizePersianParagraphs, normalizePersianText } from '../../products/catalog-text';

export type ImportSource = 'DIGIKALA' | 'GENERIC';

/** Which parser produced (part of) the draft; reported so a vendor can judge its reliability. */
export type ExtractionStrategy =
  | 'DIGIKALA_API'
  | 'JSON_LD'
  | 'MICRODATA'
  | 'OPEN_GRAPH'
  | 'HTML_META'
  | 'WOOCOMMERCE_ATTRIBUTES';

export interface ExtractedSpecification {
  group: string | null;
  title: string;
  value: string;
}

/**
 * Draft product data taken from a remote page. It is only a *suggestion*: the
 * vendor reviews it in the form, and nothing is persisted until they save the
 * product through the normal (validated) product endpoint.
 */
export interface ExtractedProduct {
  source: ImportSource;
  strategies: ExtractionStrategy[];
  /** Canonical URL of the product page. */
  sourceUrl: string;
  /** The source's own product id when it has one (e.g. `dkp-13196935`). */
  sourceProductId: string | null;
  title: string;
  titleEn: string | null;
  brand: string | null;
  description: string | null;
  /** Most specific category name the source uses. */
  suggestedCategory: string | null;
  /** Category names from most to least specific, used to match the local tree. */
  categoryCandidates: string[];
  specifications: ExtractedSpecification[];
  /** Absolute http(s) image URLs, best quality available, primary first. */
  imageUrls: string[];
}

// Limits mirror the product DTO so a draft can always be saved as-is.
export const MAX_TITLE_LENGTH = 200;
export const MAX_BRAND_LENGTH = 80;
export const MAX_DESCRIPTION_LENGTH = 20_000;
export const MAX_EXTRACTED_IMAGES = 24;

const ENTITY_MAP: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  zwnj: '\u200c',
  zwj: '\u200d',
  laquo: '«',
  raquo: '»',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
};

/** Decodes the HTML entities that occur in real product text (named subset + numeric). */
export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITY_MAP[entity.toLowerCase()] ?? match;
  });
}

/**
 * Turns an HTML fragment into plain paragraphs: block tags become line breaks,
 * every other tag is dropped, entities are decoded. Nothing of the markup
 * survives, so the result is safe to store and render as text.
 */
export function htmlToText(value: string): string {
  const withBreaks = value
    .replace(/<\s*(script|style|noscript|template)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/?\s*(p|div|li|ul|ol|h[1-6]|tr|table|section|article|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ');
  return normalizePersianParagraphs(decodeEntities(withBreaks).replace(/\u00a0/g, ' '));
}

/** Single-line clean text (titles, brands, spec labels). */
export function cleanLine(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return '';
  }
  return normalizePersianText(decodeEntities(String(value)).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
}

/** Multi-line value (spec values keep their line structure). */
export function cleanMultiline(value: string): string {
  return decodeEntities(value)
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => normalizePersianText(line))
    .filter((line) => line.length > 0)
    .join('\n');
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) {
    return value;
  }
  const cut = value.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut}…`;
}

/** Resolves a (possibly relative / protocol-relative) image reference to an absolute http(s) URL. */
export function absoluteHttpUrl(reference: unknown, base: URL | string): string | null {
  if (typeof reference !== 'string') {
    return null;
  }
  const text = decodeEntities(reference.trim());
  if (text.length === 0 || text.startsWith('data:') || text.length > 2048) {
    return null;
  }
  try {
    const url = new URL(text, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * Best-quality form of a known CDN image URL. Shopify (`cdn.shopify.com`,
 * `/cdn/shop/…`) serves resized copies through `width`/`height`/`crop` query
 * parameters, and structured data often references a 100–300 px copy; without
 * them the CDN returns the original upload. Other hosts are left untouched,
 * because their query strings may be part of the file's identity.
 */
export function bestQualityImageUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const isShopify = url.hostname === 'cdn.shopify.com' || url.pathname.includes('/cdn/shop/');
    if (isShopify) {
      for (const key of ['width', 'height', 'crop', 'pad_color']) url.searchParams.delete(key);
      return url.toString();
    }
    return raw;
  } catch {
    return raw;
  }
}

/** Order-preserving de-duplication. */
export function unique<T>(values: Iterable<T>): T[] {
  return [...new Set(values)];
}

/**
 * Final shaping shared by every strategy: clean text, DTO-compatible lengths,
 * de-duplicated specifications (first occurrence of a group/title wins) and
 * images, and a bounded number of each.
 */
export function finalizeProduct(draft: ExtractedProduct): ExtractedProduct {
  const seenSpecs = new Set<string>();
  const specifications: ExtractedSpecification[] = [];
  for (const spec of draft.specifications) {
    const title = truncate(cleanLine(spec.title), SPECIFICATION_TITLE_MAX_LENGTH);
    const value = truncate(cleanMultiline(spec.value), SPECIFICATION_VALUE_MAX_LENGTH);
    const group = spec.group ? truncate(cleanLine(spec.group), SPECIFICATION_GROUP_MAX_LENGTH) : '';
    if (title.length === 0 || value.length === 0) continue;
    const key = `${group}\u0000${title}`.toLocaleLowerCase('fa');
    if (seenSpecs.has(key)) continue;
    seenSpecs.add(key);
    specifications.push({ group: group.length > 0 ? group : null, title, value });
    if (specifications.length >= MAX_SPECIFICATIONS_PER_PRODUCT) break;
  }

  const brand = draft.brand ? truncate(cleanLine(draft.brand), MAX_BRAND_LENGTH) : '';
  const description = draft.description ? truncate(draft.description, MAX_DESCRIPTION_LENGTH) : '';
  const titleEn = draft.titleEn ? truncate(cleanLine(draft.titleEn), MAX_TITLE_LENGTH) : '';
  const suggestedCategory = draft.suggestedCategory ? cleanLine(draft.suggestedCategory) : '';

  return {
    ...draft,
    title: truncate(cleanLine(draft.title), MAX_TITLE_LENGTH),
    titleEn: titleEn.length > 0 ? titleEn : null,
    brand: brand.length > 0 ? brand : null,
    description: description.length > 0 ? description : null,
    suggestedCategory: suggestedCategory.length > 0 ? suggestedCategory : null,
    categoryCandidates: unique(draft.categoryCandidates.map((name) => cleanLine(name)).filter((name) => name.length > 0)),
    specifications,
    imageUrls: unique(draft.imageUrls.map((url) => bestQualityImageUrl(url))).slice(0, MAX_EXTRACTED_IMAGES),
    strategies: unique(draft.strategies),
  };
}
```

### `apps/backend/src/modules/importer/extractors/generic-schema.extractor.spec.ts`

```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bestQualityImageUrl } from './extracted-product';
import { decodeHtml, GenericSchemaOrgExtractor, parseJsonLd, parseProductHtml } from './generic-schema.extractor';
import { ImportError } from '../import-error';
import type { SafeFetchResult, SafeHttpClient } from '../net/safe-http-client';

const FIXTURES = join(__dirname, '../../../../test/fixtures/importer');
const html = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');

describe('parseProductHtml — WooCommerce page', () => {
  const draft = parseProductHtml(html('woocommerce-product.html'), new URL('https://shop.fixture.test/product/redmi-note-13/?utm=x'));

  it('reads the product from the WooCommerce JSON-LD graph', () => {
    expect(draft.source).toBe('GENERIC');
    expect(draft.title).toBe('گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت');
    expect(draft.brand).toBe('شیائومی');
    expect(draft.sourceProductId).toBe('RN13-256');
    expect(draft.sourceUrl).toBe('https://shop.fixture.test/product/redmi-note-13/');
  });

  it('turns the HTML description into plain text and drops scripts', () => {
    expect(draft.description).toBe('صفحه نمایش AMOLED & باتری 5000 میلی‌آمپر.\n\nگارانتی 18 ماهه');
    expect(draft.description).not.toMatch(/<|alert/);
  });

  it('suggests the category from the Yoast breadcrumb', () => {
    expect(draft.suggestedCategory).toBe('گوشی موبایل');
    expect(draft.categoryCandidates).toEqual(['گوشی موبایل', 'موبایل']);
  });

  it('reads the additional-information attribute table', () => {
    expect(draft.specifications).toEqual([
      { group: null, title: 'وزن', value: '188 گرم' },
      { group: null, title: 'حافظه RAM', value: '8 گیگابایت' },
      { group: null, title: 'شبکه ارتباطی', value: '4G, 3G' },
      { group: null, title: 'رنگ', value: 'مشکی، آبی' },
    ]);
  });

  it('takes full-size gallery images and resolves relative URLs', () => {
    expect(draft.imageUrls).toEqual([
      'https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front.jpg',
      'https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-back.jpg',
    ]);
  });

  it('reports only the strategies that contributed', () => {
    expect(draft.strategies).toEqual(['JSON_LD', 'WOOCOMMERCE_ATTRIBUTES', 'OPEN_GRAPH']);
  });
});

describe('parseProductHtml — Shopify ProductGroup', () => {
  const draft = parseProductHtml(html('shopify-product.html'), new URL('https://outfitters.fixture.test/products/trail-runner-wool'));

  it('tolerates a trailing comma in the JSON-LD and reads the group', () => {
    expect(draft.title).toBe('Trail Runner Wool');
    expect(draft.brand).toBe('Fixture Outfitters');
    expect(draft.sourceProductId).toBe('7421');
    expect(draft.description).toBe('A breathable\nwool runner, with a sugarcane sole.');
    expect(draft.specifications).toEqual([{ group: null, title: 'جنس', value: 'Merino wool' }]);
  });

  it('collects variant images at full size, once each', () => {
    expect(draft.imageUrls).toEqual([
      'https://cdn.shopify.com/s/files/1/0001/files/trail-runner-side.png?v=1751165486',
      'https://cdn.shopify.com/s/files/1/0001/files/trail-runner-grey.png?v=1751165490',
      'http://outfitters.fixture.test/cdn/shop/files/trail-runner-side.png?v=1751165486',
    ]);
  });
});

describe('parseProductHtml — microdata only', () => {
  const draft = parseProductHtml(html('microdata-product.html'), new URL('https://micro.fixture.test/p/x14'));

  it('reads name, brand, description, properties and images', () => {
    expect(draft.strategies).toEqual(['MICRODATA']);
    expect(draft.title).toBe('لپ‌تاپ ۱۴ اینچی مدل X14');
    expect(draft.brand).toBe('نمونه‌تک');
    expect(draft.description).toBe('پردازنده هشت‌هسته‌ای و باتری ۱۲ ساعته.');
    expect(draft.specifications).toEqual([
      { group: null, title: 'پردازنده', value: 'Core i7-1360P' },
      { group: null, title: 'حافظه', value: '16 گیگابایت' },
    ]);
    expect(draft.imageUrls).toEqual(['https://micro.fixture.test/images/x14-front.jpg', 'https://micro.fixture.test/images/x14-open.jpg']);
  });
});

describe('parseProductHtml — OpenGraph and rejection', () => {
  const page = (head: string): string => `<!doctype html><html><head>${head}</head><body><p>text</p></body></html>`;

  it('accepts an OpenGraph product page and strips the site-name suffix', () => {
    const draft = parseProductHtml(
      page(`<meta property="og:type" content="og:product">
            <meta property="og:site_name" content="دیجی‌استور">
            <meta property="og:title" content="هدفون بی‌سیم مدل Q30 | دیجی‌استور">
            <meta property="og:description" content="هدفون با نویزگیر فعال">
            <meta property="og:image" content="/img/q30.jpg">
            <meta property="product:brand" content="Anker">`),
      new URL('https://store.fixture.test/p/q30'),
    );
    expect(draft.title).toBe('هدفون بی‌سیم مدل Q30');
    expect(draft.brand).toBe('Anker');
    expect(draft.description).toBe('هدفون با نویزگیر فعال');
    expect(draft.imageUrls).toEqual(['https://store.fixture.test/img/q30.jpg']);
    expect(draft.strategies).toEqual(['OPEN_GRAPH']);
  });

  it('rejects an ordinary article page (og:type=article, no product data)', () => {
    const run = (): unknown =>
      parseProductHtml(
        page(`<title>News</title><meta property="og:type" content="article"><meta property="og:title" content="Story"><meta property="og:image" content="https://news.fixture.test/a.jpg">`),
        new URL('https://news.fixture.test/story'),
      );
    expect(run).toThrow(ImportError);
    expect(run).toThrow(expect.objectContaining({ code: 'NOT_A_PRODUCT' }) as Error);
  });

  it('rejects a page with only a <title>', () => {
    expect(() => parseProductHtml(page('<title>Example Domain</title>'), new URL('https://example.com/'))).toThrow(
      expect.objectContaining({ code: 'NOT_A_PRODUCT' }) as Error,
    );
  });

  it('ignores unsafe image URLs', () => {
    const draft = parseProductHtml(
      page(`<script type="application/ld+json">{"@type":"Product","name":"X","image":["javascript:alert(1)","data:image/png;base64,AAA","ftp://h/a.jpg","https://ok.fixture.test/a.jpg"]}</script>`),
      new URL('https://ok.fixture.test/p'),
    );
    expect(draft.imageUrls).toEqual(['https://ok.fixture.test/a.jpg']);
  });

  it('caps the number of specifications at the product limit', () => {
    const properties = Array.from({ length: 200 }, (_, i) => ({ '@type': 'PropertyValue', name: `ویژگی ${i}`, value: `${i}` }));
    const draft = parseProductHtml(
      page(`<script type="application/ld+json">${JSON.stringify({ '@type': 'Product', name: 'X', additionalProperty: properties })}</script>`),
      new URL('https://ok.fixture.test/p'),
    );
    expect(draft.specifications).toHaveLength(150);
  });
});

describe('parseJsonLd', () => {
  it('repairs common real-world defects', () => {
    expect(parseJsonLd('<![CDATA[{"@type":"Product","name":"A"}]]>')).toEqual({ '@type': 'Product', name: 'A' });
    expect(parseJsonLd('<!-- {"name":"B"} -->')).toEqual({ name: 'B' });
    expect(parseJsonLd('{"name":"C\nD",}')).toEqual({ name: 'C D' });
    expect(parseJsonLd('{"list":[1,2,],}')).toEqual({ list: [1, 2] });
  });

  it('returns undefined for hopeless input', () => {
    expect(parseJsonLd('')).toBeUndefined();
    expect(parseJsonLd('{not json')).toBeUndefined();
  });
});

describe('decodeHtml', () => {
  // «سلام» in windows-1256, as still served by some older Iranian shops.
  const salaamCp1256 = Buffer.from([0xd3, 0xe1, 0xc7, 0xe3]);

  it('uses the Content-Type charset', () => {
    expect(decodeHtml(salaamCp1256, 'text/html; charset=windows-1256')).toBe('سلام');
  });

  it('falls back to <meta charset>', () => {
    const body = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1256"></head><body>'), salaamCp1256]);
    expect(decodeHtml(body, 'text/html')).toContain('سلام');
  });

  it('defaults to UTF-8 and survives an unknown charset', () => {
    expect(decodeHtml(Buffer.from('سلام'), null)).toBe('سلام');
    expect(decodeHtml(Buffer.from('سلام'), 'text/html; charset=x-bogus')).toBe('سلام');
  });
});

describe('bestQualityImageUrl', () => {
  it('removes Shopify resize parameters but keeps the version', () => {
    expect(bestQualityImageUrl('https://cdn.shopify.com/s/files/1/a.png?v=12&width=100&height=100&crop=center')).toBe(
      'https://cdn.shopify.com/s/files/1/a.png?v=12',
    );
    expect(bestQualityImageUrl('https://www.allbirds.com/cdn/shop/files/a.png?v=1&width=100')).toBe('https://www.allbirds.com/cdn/shop/files/a.png?v=1');
  });

  it('leaves other hosts untouched', () => {
    expect(bestQualityImageUrl('https://img.fixture.test/a.jpg?width=100')).toBe('https://img.fixture.test/a.jpg?width=100');
  });
});

describe('GenericSchemaOrgExtractor', () => {
  const respond = (partial: Partial<SafeFetchResult>): SafeHttpClient =>
    ({
      fetch: () =>
        Promise.resolve({
          url: new URL('https://shop.fixture.test/product/redmi-note-13/'),
          status: 200,
          contentType: 'text/html; charset=utf-8',
          body: Buffer.from(html('woocommerce-product.html')),
          ...partial,
        }),
    }) as unknown as SafeHttpClient;
  const url = new URL('https://shop.fixture.test/product/redmi-note-13/');

  it('parses a fetched page', async () => {
    await expect(new GenericSchemaOrgExtractor(respond({})).extract(url)).resolves.toMatchObject({ title: expect.stringContaining('Redmi') as string });
  });

  it.each([
    [{ status: 404 }, 'NOT_FOUND'],
    [{ status: 410 }, 'NOT_FOUND'],
    [{ status: 403 }, 'UPSTREAM_STATUS'],
    [{ status: 500 }, 'UPSTREAM_STATUS'],
    [{ contentType: 'application/pdf' }, 'UNSUPPORTED_CONTENT'],
    [{ contentType: 'image/jpeg' }, 'UNSUPPORTED_CONTENT'],
  ])('maps %p to %s', async (partial, code) => {
    await expect(new GenericSchemaOrgExtractor(respond(partial)).extract(url)).rejects.toMatchObject({ code });
  });
});
```

### `apps/backend/src/modules/importer/extractors/generic-schema.extractor.ts`

```ts
import { Injectable } from '@nestjs/common';
import { parse, type HTMLElement } from 'node-html-parser';
import { ImportError } from '../import-error';
import { SafeHttpClient } from '../net/safe-http-client';
import {
  absoluteHttpUrl,
  cleanLine,
  finalizeProduct,
  htmlToText,
  unique,
  type ExtractedProduct,
  type ExtractedSpecification,
  type ExtractionStrategy,
} from './extracted-product';

/** Product pages rarely exceed 1–2 MB of HTML; anything above 5 MB is not worth parsing. */
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const PRODUCT_TYPES = new Set(['product', 'productgroup', 'productmodel', 'individualproduct', 'someproducts', 'vehicle', 'car']);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

interface PartialDraft {
  strategy?: ExtractionStrategy;
  title?: string;
  description?: string;
  brand?: string;
  category?: string;
  images: string[];
  specifications: ExtractedSpecification[];
}

// ---------------------------------------------------------------------------
// Decoding
// ---------------------------------------------------------------------------

/**
 * Decodes an HTML body using the charset from the `Content-Type` header, else
 * from `<meta charset>` / `http-equiv`, else UTF-8. Older Iranian shops still
 * serve `windows-1256`, which Node's ICU-enabled `TextDecoder` understands.
 */
export function decodeHtml(body: Buffer, contentType: string | null): string {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType ?? '')?.[1];
  const head = body.subarray(0, 4096).toString('latin1');
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (fromHeader ?? fromMeta ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(body);
  } catch {
    return new TextDecoder('utf-8').decode(body);
  }
}

// ---------------------------------------------------------------------------
// JSON-LD
// ---------------------------------------------------------------------------

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function typesOf(node: JsonObject): string[] {
  const raw = node['@type'];
  const list = Array.isArray(raw) ? raw : [raw];
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.replace(/^.*[/#:]/, '').toLowerCase());
}

/** Every object node of a JSON-LD document (arrays, `@graph`, nested values). */
function* walk(value: JsonValue | undefined, depth = 0): Generator<JsonObject> {
  if (depth > 12 || value === undefined || value === null) return;
  if (Array.isArray(value)) {
    for (const entry of value) yield* walk(entry, depth + 1);
    return;
  }
  if (isObject(value)) {
    yield value;
    for (const [key, entry] of Object.entries(value)) {
      if (key !== '@context') yield* walk(entry, depth + 1);
    }
  }
}

/** Parses a JSON-LD script tolerantly (CDATA wrappers, HTML comments, raw control characters, trailing commas). */
export function parseJsonLd(text: string): JsonValue | undefined {
  const cleaned = text
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/^\s*<!--/, '')
    .replace(/-->\s*$/, '')
    .trim();
  if (cleaned.length === 0) return undefined;
  // eslint-disable-next-line no-control-regex -- raw control characters inside JSON strings are exactly what is being repaired
  const repaired = cleaned.replace(/[\u0000-\u001f]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  for (const candidate of [cleaned, repaired]) {
    try {
      return JSON.parse(candidate) as JsonValue;
    } catch {
      // try the next repair
    }
  }
  return undefined;
}

function textValue(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    return text.length > 0 ? text : undefined;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = textValue(entry);
      if (text !== undefined) return text;
    }
    return undefined;
  }
  if (isObject(value)) {
    return textValue(value['name']) ?? textValue(value['@value']);
  }
  return undefined;
}

function imageValues(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap((entry) => imageValues(entry));
  if (isObject(value)) {
    const direct = [value['contentUrl'], value['url']].find((entry) => typeof entry === 'string');
    return typeof direct === 'string' ? [direct] : [];
  }
  return [];
}

function quantitativeValue(value: JsonValue | undefined): string | undefined {
  if (isObject(value)) {
    const amount = textValue(value['value']);
    const unit = textValue(value['unitText']) ?? textValue(value['unitCode']);
    return amount === undefined ? undefined : unit ? `${amount} ${unit}` : amount;
  }
  return textValue(value);
}

/** Labels for schema.org properties that are genuine specifications. */
const SCHEMA_SPEC_FIELDS: ReadonlyArray<[string, string]> = [
  ['model', 'مدل'],
  ['color', 'رنگ'],
  ['material', 'جنس'],
  ['size', 'اندازه'],
  ['weight', 'وزن'],
  ['width', 'عرض'],
  ['height', 'ارتفاع'],
  ['depth', 'عمق'],
  ['mpn', 'شماره قطعه سازنده (MPN)'],
  ['gtin13', 'بارکد (GTIN-13)'],
  ['gtin', 'بارکد (GTIN)'],
];

function fromJsonLdProduct(node: JsonObject, base: URL): PartialDraft {
  const images = imageValues(node['image']);
  // Shopify: a ProductGroup lists per-variant images under hasVariant.
  const variants = node['hasVariant'];
  if (Array.isArray(variants)) {
    for (const variant of variants) {
      if (isObject(variant)) images.push(...imageValues(variant['image']));
    }
  }

  const specifications: ExtractedSpecification[] = [];
  const properties = node['additionalProperty'];
  for (const property of Array.isArray(properties) ? properties : properties ? [properties] : []) {
    if (!isObject(property)) continue;
    const title = textValue(property['name']);
    const raw = property['value'];
    const value = Array.isArray(raw) ? raw.map((entry) => textValue(entry)).filter(Boolean).join('، ') : textValue(raw);
    const unit = textValue(property['unitText']);
    if (title && value) specifications.push({ group: null, title, value: unit ? `${value} ${unit}` : value });
  }
  for (const [field, label] of SCHEMA_SPEC_FIELDS) {
    const value = quantitativeValue(node[field]);
    if (value !== undefined && !/^https?:\/\//i.test(value)) specifications.push({ group: null, title: label, value });
  }

  const category = textValue(node['category']);
  return {
    title: textValue(node['name']),
    description: textValue(node['description']),
    brand: textValue(node['brand']) ?? textValue(node['manufacturer']),
    category: category?.split(/\s*[>/|›»]\s*/).filter(Boolean).pop(),
    images: images.map((image) => absoluteHttpUrl(image, base)).filter((url): url is string => url !== null),
    specifications,
  };
}

/** Category names from a BreadcrumbList, most specific first (the product itself excluded). */
function breadcrumbCategories(nodes: JsonObject[], productName: string | undefined): string[] {
  for (const node of nodes) {
    if (!typesOf(node).includes('breadcrumblist')) continue;
    const items = Array.isArray(node['itemListElement']) ? node['itemListElement'] : [];
    const names = items
      .filter(isObject)
      .sort((a, b) => Number(a['position'] ?? 0) - Number(b['position'] ?? 0))
      .map((item) => textValue(item['name']) ?? (isObject(item['item']) ? textValue(item['item']['name']) : undefined))
      .filter((name): name is string => name !== undefined);
    const categories = names.slice(1).filter((name) => cleanLine(name) !== cleanLine(productName ?? ''));
    if (categories.length > 0) return categories.reverse();
  }
  return [];
}

// ---------------------------------------------------------------------------
// Microdata
// ---------------------------------------------------------------------------

function itemPropValue(element: HTMLElement): string | undefined {
  const tag = element.tagName?.toLowerCase();
  const value =
    element.getAttribute('content') ??
    (tag === 'img' || tag === 'source' ? element.getAttribute('src') ?? element.getAttribute('data-src') : undefined) ??
    (tag === 'a' || tag === 'link' ? element.getAttribute('href') : undefined) ??
    (tag === 'meta' ? undefined : element.innerHTML);
  const text = value === undefined ? '' : tag === 'meta' || tag === 'img' || tag === 'link' || tag === 'a' ? value : htmlToText(value);
  return text.trim().length > 0 ? text.trim() : undefined;
}

function fromMicrodata(root: HTMLElement, base: URL): PartialDraft | null {
  const scope = root
    .querySelectorAll('[itemscope][itemtype]')
    .find((element) => /schema\.org\/(Product|ProductGroup|IndividualProduct)\b/i.test(element.getAttribute('itemtype') ?? ''));
  if (!scope) return null;

  const first = (prop: string): HTMLElement | undefined => scope.querySelector(`[itemprop="${prop}"]`) ?? undefined;
  const brandElement = first('brand');
  const brand = brandElement
    ? brandElement.hasAttribute('itemscope')
      ? (brandElement.querySelector('[itemprop="name"]') ? itemPropValue(brandElement.querySelector('[itemprop="name"]')!) : undefined)
      : itemPropValue(brandElement)
    : undefined;

  const specifications: ExtractedSpecification[] = [];
  for (const property of scope.querySelectorAll('[itemprop="additionalProperty"]')) {
    const name = property.querySelector('[itemprop="name"]');
    const value = property.querySelector('[itemprop="value"]');
    const title = name ? itemPropValue(name) : undefined;
    const text = value ? itemPropValue(value) : undefined;
    if (title && text) specifications.push({ group: null, title, value: text });
  }

  // The product's own name: the first `name` that is not inside a nested item (brand, offer, review…).
  const name = scope
    .querySelectorAll('[itemprop="name"]')
    .find((element) => {
      let parent = element.parentNode;
      while (parent && parent !== scope) {
        if (parent.hasAttribute?.('itemscope')) return false;
        parent = parent.parentNode;
      }
      return true;
    });
  const descriptionElement = first('description');

  return {
    title: name ? itemPropValue(name) : undefined,
    description: descriptionElement ? itemPropValue(descriptionElement) : undefined,
    brand,
    category: first('category') ? itemPropValue(first('category')!) : undefined,
    images: scope
      .querySelectorAll('[itemprop="image"]')
      .map((element) => absoluteHttpUrl(itemPropValue(element), base))
      .filter((url): url is string => url !== null),
    specifications,
  };
}

// ---------------------------------------------------------------------------
// OpenGraph / HTML meta
// ---------------------------------------------------------------------------

interface MetaData {
  ogTitle?: string;
  ogDescription?: string;
  ogType?: string;
  ogSiteName?: string;
  ogImages: string[];
  productBrand?: string;
  hasPrice: boolean;
  metaDescription?: string;
  documentTitle?: string;
  canonical?: string;
}

function readMeta(root: HTMLElement, base: URL): MetaData {
  const meta: MetaData = { ogImages: [], hasPrice: false };
  for (const element of root.querySelectorAll('meta')) {
    const key = (element.getAttribute('property') ?? element.getAttribute('name') ?? '').trim().toLowerCase();
    const content = element.getAttribute('content')?.trim();
    if (!key || !content) continue;
    switch (key) {
      case 'og:title':
        meta.ogTitle ??= content;
        break;
      case 'twitter:title':
        meta.ogTitle ??= content;
        break;
      case 'og:description':
      case 'twitter:description':
        meta.ogDescription ??= content;
        break;
      case 'og:type':
        meta.ogType = content.toLowerCase();
        break;
      case 'og:site_name':
        meta.ogSiteName = content;
        break;
      case 'og:image':
      case 'og:image:url':
      case 'og:image:secure_url':
      case 'twitter:image':
      case 'twitter:image:src': {
        const url = absoluteHttpUrl(content, base);
        if (url) meta.ogImages.push(url);
        break;
      }
      case 'product:brand':
      case 'og:brand':
        meta.productBrand ??= content;
        break;
      case 'product:price:amount':
      case 'og:price:amount':
        meta.hasPrice = true;
        break;
      case 'description':
        meta.metaDescription ??= content;
        break;
      default:
        break;
    }
  }
  meta.documentTitle = root.querySelector('title')?.text.trim() || undefined;
  meta.canonical = absoluteHttpUrl(root.querySelector('link[rel="canonical"]')?.getAttribute('href'), base) ?? undefined;
  return meta;
}

/** "Product name | Shop" → "Product name" when the suffix is the site's name. */
function stripSiteSuffix(title: string, siteName: string | undefined): string {
  if (!siteName) return title;
  const parts = title.split(/\s+[|\-–—:]\s+/);
  if (parts.length > 1 && cleanLine(parts[parts.length - 1]!) === cleanLine(siteName)) {
    return parts.slice(0, -1).join(' - ');
  }
  return title;
}

// ---------------------------------------------------------------------------
// WooCommerce (very common among Iranian shops)
// ---------------------------------------------------------------------------

function fromWooCommerce(root: HTMLElement, base: URL): { specifications: ExtractedSpecification[]; images: string[] } {
  const specifications: ExtractedSpecification[] = [];
  for (const row of root.querySelectorAll('table.woocommerce-product-attributes tr, table.shop_attributes tr')) {
    const label = row.querySelector('th');
    const value = row.querySelector('td');
    if (label && value) {
      // Term lists are rendered as `<a>4G</a>, <a>3G</a>`; drop the space the tags leave before the comma.
      specifications.push({ group: null, title: label.text, value: htmlToText(value.innerHTML).replace(/[ \t]+([,،])/g, '$1') });
    }
  }
  const images: string[] = [];
  for (const element of root.querySelectorAll('.woocommerce-product-gallery__image')) {
    const link = element.querySelector('a')?.getAttribute('href');
    const image = element.querySelector('img');
    const candidate = image?.getAttribute('data-large_image') ?? link ?? image?.getAttribute('data-src') ?? image?.getAttribute('src');
    const url = absoluteHttpUrl(candidate, base);
    if (url) images.push(url);
  }
  return { specifications, images };
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * Pure HTML → draft mapping (no I/O), unit-tested against real-world page
 * shapes. Sources are merged by reliability: JSON-LD, then microdata, then the
 * WooCommerce attribute table, then OpenGraph and plain HTML metadata.
 *
 * Throws `NOT_A_PRODUCT` for pages that carry no product signal at all — a
 * blog post's OpenGraph title is not a product.
 */
export function parseProductHtml(html: string, pageUrl: URL): ExtractedProduct {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: false, noscript: false, pre: true } });

  const jsonLdNodes: JsonObject[] = [];
  for (const script of root.querySelectorAll('script')) {
    if (!/application\/ld\+json/i.test(script.getAttribute('type') ?? '')) continue;
    jsonLdNodes.push(...walk(parseJsonLd(script.rawText)));
  }
  const productNodes = jsonLdNodes.filter((node) => typesOf(node).some((type) => PRODUCT_TYPES.has(type)));
  // Prefer a top-level product with a name; a ProductGroup over its own variants.
  const productNode =
    productNodes.find((node) => typesOf(node).includes('productgroup') && textValue(node['name'])) ??
    productNodes.find((node) => textValue(node['name']));

  const parts: PartialDraft[] = [];
  if (productNode) {
    parts.push({ ...fromJsonLdProduct(productNode, pageUrl), strategy: 'JSON_LD' });
  }

  const microdata = fromMicrodata(root, pageUrl);
  if (microdata && (microdata.title || microdata.images.length > 0 || microdata.specifications.length > 0)) {
    parts.push({ ...microdata, strategy: 'MICRODATA' });
  }

  const woo = fromWooCommerce(root, pageUrl);
  if (woo.specifications.length > 0 || woo.images.length > 0) {
    parts.push({ images: woo.images, specifications: woo.specifications, strategy: 'WOOCOMMERCE_ATTRIBUTES' });
  }

  const meta = readMeta(root, pageUrl);
  const ogIsProduct = meta.ogType?.includes('product') === true || meta.hasPrice || meta.productBrand !== undefined;
  if (meta.ogTitle || meta.ogImages.length > 0) {
    parts.push({
      title: meta.ogTitle ? stripSiteSuffix(meta.ogTitle, meta.ogSiteName) : undefined,
      description: meta.ogDescription,
      brand: meta.productBrand,
      images: meta.ogImages,
      specifications: [],
      strategy: 'OPEN_GRAPH',
    });
  }
  if (meta.documentTitle || meta.metaDescription) {
    parts.push({
      title: meta.documentTitle ? stripSiteSuffix(meta.documentTitle, meta.ogSiteName) : undefined,
      description: meta.metaDescription,
      images: [],
      specifications: [],
      strategy: 'HTML_META',
    });
  }

  const hasProductSignal = productNode !== undefined || microdata !== null || woo.specifications.length > 0 || ogIsProduct;
  const pick = (field: 'title' | 'description' | 'brand' | 'category'): PartialDraft | undefined =>
    parts.find((part) => {
      const value = part[field];
      return value !== undefined && cleanLine(value).length > 0;
    });
  const titlePart = pick('title');
  const title = titlePart?.title;
  if (!hasProductSignal || !title) {
    throw new ImportError(
      'NOT_A_PRODUCT',
      'No product information was found on this page (no schema.org Product, product microdata, WooCommerce attributes or OpenGraph product tags)',
    );
  }

  const descriptionPart = pick('description');
  const brandPart = pick('brand');
  const categoryPart = pick('category');
  const description = descriptionPart?.description;
  const category = categoryPart?.category;
  const breadcrumbs = breadcrumbCategories(jsonLdNodes, title);

  // Report only the strategies whose data actually ended up in the draft.
  const contributing = new Set<PartialDraft>([titlePart, ...[descriptionPart, brandPart, categoryPart].filter((part): part is PartialDraft => part !== undefined)]);
  for (const part of parts) {
    if (part.images.length > 0 || part.specifications.length > 0) contributing.add(part);
  }
  const strategies = parts.filter((part) => contributing.has(part)).map((part) => part.strategy!);

  return finalizeProduct({
    source: 'GENERIC',
    strategies,
    sourceUrl: meta.canonical ?? pageUrl.toString(),
    sourceProductId: productNode
      ? (textValue(productNode['sku']) ?? textValue(productNode['productID']) ?? textValue(productNode['productGroupID']) ?? null)
      : null,
    title,
    titleEn: null,
    brand: brandPart?.brand ?? null,
    description: description ? htmlToText(description) : null,
    suggestedCategory: category ?? breadcrumbs[0] ?? null,
    categoryCandidates: unique([...(category ? [category] : []), ...breadcrumbs]),
    specifications: parts.flatMap((part) => part.specifications),
    imageUrls: unique(parts.flatMap((part) => part.images)),
  });
}

/**
 * Strategy B — any storefront that publishes structured data (WooCommerce,
 * Shopify, Magento, custom shops with schema.org/OpenGraph tags).
 */
@Injectable()
export class GenericSchemaOrgExtractor {
  constructor(private readonly http: SafeHttpClient) {}

  async extract(url: URL): Promise<ExtractedProduct> {
    const response = await this.http.fetch(url, {
      accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
      maxBytes: MAX_HTML_BYTES,
    });
    if (response.status === 404 || response.status === 410) {
      throw new ImportError('NOT_FOUND', `The page does not exist (HTTP ${response.status})`);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new ImportError('UPSTREAM_STATUS', `The site answered HTTP ${response.status}`);
    }
    const type = (response.contentType ?? '').toLowerCase();
    if (type !== '' && !type.includes('html') && !type.includes('xml')) {
      throw new ImportError('UNSUPPORTED_CONTENT', `The URL is not a web page (content type ${type.split(';')[0]})`);
    }
    return parseProductHtml(decodeHtml(response.body, response.contentType), response.url);
  }
}
```

### `apps/backend/src/modules/importer/import-error.ts`

```ts
import { HttpException, HttpStatus } from '@nestjs/common';

/**
 * Failure vocabulary of the importer. Each code maps to exactly one HTTP status,
 * so a client can tell "your URL is wrong" (400) from "that site is not a
 * product page" (422) from "that site failed us" (502/504).
 */
export type ImportErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_TARGET'
  | 'TIMEOUT'
  | 'TOO_LARGE'
  | 'TOO_MANY_REDIRECTS'
  | 'NETWORK'
  | 'UPSTREAM_STATUS'
  | 'UNSUPPORTED_CONTENT'
  | 'NOT_A_PRODUCT'
  | 'NOT_FOUND';

export class ImportError extends Error {
  constructor(
    readonly code: ImportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ImportError';
  }
}

const STATUS: Record<ImportErrorCode, HttpStatus> = {
  INVALID_URL: HttpStatus.BAD_REQUEST,
  BLOCKED_TARGET: HttpStatus.BAD_REQUEST,
  TIMEOUT: HttpStatus.GATEWAY_TIMEOUT,
  TOO_LARGE: HttpStatus.UNPROCESSABLE_ENTITY,
  UNSUPPORTED_CONTENT: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_A_PRODUCT: HttpStatus.UNPROCESSABLE_ENTITY,
  NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  TOO_MANY_REDIRECTS: HttpStatus.BAD_GATEWAY,
  NETWORK: HttpStatus.BAD_GATEWAY,
  UPSTREAM_STATUS: HttpStatus.BAD_GATEWAY,
};

const REASON: Partial<Record<HttpStatus, string>> = {
  [HttpStatus.BAD_REQUEST]: 'Bad Request',
  [HttpStatus.UNPROCESSABLE_ENTITY]: 'Unprocessable Entity',
  [HttpStatus.BAD_GATEWAY]: 'Bad Gateway',
  [HttpStatus.GATEWAY_TIMEOUT]: 'Gateway Timeout',
};

/**
 * Translates an importer failure into the HTTP exception the API answers with.
 * The body keeps Nest's standard shape (`statusCode`, `error`, `message`) and
 * adds the machine-readable `code`, namespaced as `IMPORT_<code>` because API
 * error codes share one namespace across modules (the UI translates them).
 */
export function toHttpException(error: ImportError): HttpException {
  const status = STATUS[error.code];
  return new HttpException({ statusCode: status, error: REASON[status] ?? 'Error', message: error.message, code: `IMPORT_${error.code}` }, status);
}
```

### `apps/backend/src/modules/importer/importer.module.ts`

```ts
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
```

### `apps/backend/src/modules/importer/net/address-policy.spec.ts`

```ts
import { embeddedIPv4, expandIPv6, isReservedAddress, PUBLIC_INTERNET_POLICY } from './address-policy';

describe('isReservedAddress', () => {
  it.each([
    ['127.0.0.1', 'loopback'],
    ['127.255.255.254', 'loopback /8'],
    ['10.0.0.1', 'RFC 1918 10/8'],
    ['10.255.255.255', 'RFC 1918 10/8 upper edge'],
    ['172.16.0.1', 'RFC 1918 172.16/12 lower edge'],
    ['172.20.0.5', 'Docker bridge network'],
    ['172.31.255.255', 'RFC 1918 172.16/12 upper edge'],
    ['192.168.1.1', 'RFC 1918 192.168/16'],
    ['169.254.169.254', 'cloud metadata (link-local)'],
    ['169.254.0.1', 'link-local'],
    ['0.0.0.0', 'unspecified'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.2.10', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['224.0.0.1', 'multicast'],
    ['255.255.255.255', 'broadcast'],
  ])('blocks IPv4 %s (%s)', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });

  it.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fe80::1', 'link-local'],
    ['fe80::1%eth0', 'link-local with zone id'],
    ['fc00::1', 'unique local'],
    ['fd12:3456:789a::1', 'unique local'],
    ['ff02::1', 'multicast'],
    ['2001:db8::1', 'documentation'],
    ['2002:7f00:1::', '6to4 (tunnels to an embedded IPv4)'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback, hex form'],
    ['::ffff:192.168.1.1', 'IPv4-mapped private'],
    ['::ffff:a9fe:a9fe', 'IPv4-mapped metadata endpoint, hex form'],
    ['::10.0.0.1', 'IPv4-compatible private'],
    ['64:ff9b::10.0.0.1', 'NAT64 to a private address'],
    ['64:ff9b::a9fe:a9fe', 'NAT64 to the metadata endpoint'],
  ])('blocks IPv6 %s (%s)', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });

  it.each([
    ['8.8.8.8'],
    ['1.1.1.1'],
    ['93.184.215.14'],
    ['172.15.255.255'], // just below 172.16/12
    ['172.32.0.1'], // just above 172.16/12
    ['192.169.0.1'], // just above 192.168/16
    ['169.255.0.1'], // just above 169.254/16
    ['2606:4700:4700::1111'], // public IPv6
    ['::ffff:8.8.8.8'], // IPv4-mapped public
    ['64:ff9b::808:808'], // NAT64 to a public address
  ])('allows public address %s', (address) => {
    expect(isReservedAddress(address)).toBe(false);
  });

  it.each([['not-an-ip'], [''], ['999.1.1.1'], ['example.com']])('treats unparseable input %p as blocked', (address) => {
    expect(isReservedAddress(address)).toBe(true);
  });
});

describe('IPv6 helpers', () => {
  it('expands compressed and dotted-quad forms', () => {
    expect(expandIPv6('::1')).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIPv6('::ffff:127.0.0.1')).toEqual([0, 0, 0, 0, 0, 0xffff, 0x7f00, 0x0001]);
    expect(expandIPv6('2001:db8::8a2e:370:7334')).toEqual([0x2001, 0xdb8, 0, 0, 0, 0x8a2e, 0x370, 0x7334]);
    expect(expandIPv6('127.0.0.1')).toBeNull();
  });

  it('extracts the IPv4 hidden in mapped, compatible and NAT64 addresses', () => {
    expect(embeddedIPv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(embeddedIPv4('::10.1.2.3')).toBe('10.1.2.3');
    expect(embeddedIPv4('64:ff9b::c0a8:101')).toBe('192.168.1.1');
    expect(embeddedIPv4('2606:4700::1111')).toBeNull();
    expect(embeddedIPv4('::1')).toBeNull();
  });
});

describe('PUBLIC_INTERNET_POLICY', () => {
  it('only allows the standard web ports', () => {
    expect(PUBLIC_INTERNET_POLICY.isAllowedPort(80)).toBe(true);
    expect(PUBLIC_INTERNET_POLICY.isAllowedPort(443)).toBe(true);
    for (const port of [22, 25, 3000, 4000, 5432, 6379, 8080, 9000]) {
      expect(PUBLIC_INTERNET_POLICY.isAllowedPort(port)).toBe(false);
    }
  });

  it('uses the reserved-address check', () => {
    expect(PUBLIC_INTERNET_POLICY.isBlockedAddress('192.168.1.1')).toBe(true);
    expect(PUBLIC_INTERNET_POLICY.isBlockedAddress('8.8.8.8')).toBe(false);
  });
});
```

### `apps/backend/src/modules/importer/net/address-policy.ts`

```ts
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

/**
 * SSRF guard: which network targets the importer may contact.
 *
 * The importer fetches URLs chosen by a user, from inside the platform's private
 * network (the backend container sits next to PostgreSQL, Redis and the cloud
 * metadata endpoint). Every address the client would connect to is therefore
 * checked against the reserved ranges below — the literal IP of the URL, every
 * address DNS returns for its host, and again for every redirect hop.
 *
 * The check runs inside the socket's own `lookup`, so the address that was
 * validated is the address that is connected to: a DNS answer that changes
 * between "check" and "connect" (DNS rebinding) cannot slip through.
 */

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/**
 * Network policy injected into the HTTP client. Production always uses
 * {@link PUBLIC_INTERNET_POLICY}; only the automated E2E suite substitutes a
 * policy (through Nest's `overrideProvider`, never through configuration) so it
 * can serve fixture pages from a local HTTP server.
 */
export interface ImportNetworkPolicy {
  /** `true` when the address must never be contacted. */
  isBlockedAddress(address: string): boolean;
  /** Ports a URL may name explicitly. */
  isAllowedPort(port: number): boolean;
  /** Resolves every address of a host (A and AAAA). */
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export const IMPORT_NETWORK_POLICY = Symbol('IMPORT_NETWORK_POLICY');

/** IPv4 ranges that are not the public internet (RFC 6890 special-purpose registry). */
const BLOCKED_IPV4_SUBNETS: ReadonlyArray<[string, number]> = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // RFC 1918 private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // RFC 1918 private (Docker's default bridge networks live here)
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // TEST-NET-1
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // RFC 1918 private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // TEST-NET-2
  ['203.0.113.0', 24], // TEST-NET-3
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast 255.255.255.255
];

/** IPv6 ranges that are not the public internet. Embedded-IPv4 forms are unwrapped separately. */
const BLOCKED_IPV6_SUBNETS: ReadonlyArray<[string, number]> = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard-only
  ['2001::', 23], // IETF protocol assignments (Teredo, ORCHID, …)
  ['2001:db8::', 32], // documentation
  ['2002::', 16], // 6to4 — tunnels to an arbitrary embedded IPv4
  ['fc00::', 7], // unique local (the IPv6 "private" range)
  ['fe80::', 10], // link-local
  ['fec0::', 10], // deprecated site-local
  ['ff00::', 8], // multicast
];

const blockList = new BlockList();
for (const [network, prefix] of BLOCKED_IPV4_SUBNETS) blockList.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of BLOCKED_IPV6_SUBNETS) blockList.addSubnet(network, prefix, 'ipv6');

/**
 * Expands an IPv6 literal into its eight 16-bit groups (handles `::` and a
 * trailing dotted-quad). Returns `null` for anything that is not IPv6.
 */
export function expandIPv6(address: string): number[] | null {
  if (isIP(address) !== 6) {
    return null;
  }
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone >= 0) text = text.slice(0, zone);

  // A trailing IPv4 (e.g. ::ffff:127.0.0.1) becomes two hex groups.
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const headGroups = head ? head.split(':').filter((part) => part.length > 0) : [];
  const tailGroups = tail ? tail.split(':').filter((part) => part.length > 0) : [];
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) {
    return null;
  }
  const groups = [...headGroups, ...new Array<string>(missing).fill('0'), ...tailGroups].map((part) => parseInt(part, 16));
  return groups.length === 8 && groups.every((group) => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

/**
 * The IPv4 address hidden inside an IPv6 one, if any: IPv4-mapped
 * (`::ffff:a.b.c.d`), IPv4-compatible (`::a.b.c.d`) and NAT64 (`64:ff9b::a.b.c.d`).
 * Connecting to any of these reaches the embedded IPv4, so that is what must be
 * checked.
 */
export function embeddedIPv4(address: string): string | null {
  const groups = expandIPv6(address);
  if (groups === null) {
    return null;
  }
  const high = groups.slice(0, 6);
  const isMapped = high.slice(0, 5).every((group) => group === 0) && high[5] === 0xffff;
  const isCompatible = high.every((group) => group === 0) && (groups[6] !== 0 || groups[7]! > 1);
  const isNat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((group) => group === 0);
  if (!isMapped && !isCompatible && !isNat64) {
    return null;
  }
  const g6 = groups[6]!;
  const g7 = groups[7]!;
  return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
}

/** `true` for every address the importer must not connect to (and for anything unparseable). */
export function isReservedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    return blockList.check(address, 'ipv4');
  }
  if (version === 6) {
    const inner = embeddedIPv4(address);
    if (inner !== null) {
      return blockList.check(inner, 'ipv4');
    }
    const zone = address.indexOf('%');
    return blockList.check(zone >= 0 ? address.slice(0, zone) : address, 'ipv6');
  }
  return true;
}

/** Default policy: public internet on the standard web ports only. */
export const PUBLIC_INTERNET_POLICY: ImportNetworkPolicy = {
  isBlockedAddress: isReservedAddress,
  isAllowedPort: (port) => port === 80 || port === 443,
  async resolve(hostname) {
    const answers = await dnsLookup(hostname, { all: true, verbatim: true });
    return answers.map((answer) => ({ address: answer.address, family: answer.family === 6 ? 6 : 4 }));
  },
};
```

### `apps/backend/src/modules/importer/net/import-url.spec.ts`

```ts
import { PUBLIC_INTERNET_POLICY } from './address-policy';
import { MAX_IMPORT_URL_LENGTH, parseImportUrl, socketHostname } from './import-url';
import { ImportError, type ImportErrorCode } from '../import-error';

function rejection(raw: string): ImportErrorCode | 'ACCEPTED' {
  try {
    parseImportUrl(raw, PUBLIC_INTERNET_POLICY);
    return 'ACCEPTED';
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

describe('parseImportUrl (SSRF guard)', () => {
  it.each([
    'http://127.0.0.1:4000',
    'http://192.168.1.1',
    'http://127.0.0.1/',
    'https://10.0.0.8/admin',
    'http://172.16.5.4/',
    'http://172.31.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://0.0.0.0/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[::ffff:7f00:1]/',
    'http://[fd00::1]/',
    'http://[64:ff9b::a9fe:a9fe]/',
    // Numeric host tricks: WHATWG URL canonicalises them to 127.0.0.1 / 10.0.0.1
    'http://2130706433/',
    'http://0x7f000001/',
    'http://0177.0.0.1/',
    'http://127.1/',
    'http://0x0a.0.0.1/',
    // Internal names
    'http://localhost/',
    'http://LOCALHOST./',
    'http://api.localhost/',
    'http://printer.local/',
    'http://metadata.google.internal/',
    'http://router.home.arpa/',
    'http://postgres/',
    'http://backend/api/v1/health',
    // Non-web ports on public hosts
    'http://example.com:8080/',
    'https://example.com:5432/',
    'http://example.com:22/',
  ])('rejects %s as BLOCKED_TARGET', (url) => {
    expect(rejection(url)).toBe('BLOCKED_TARGET');
  });

  it.each([
    'ftp://example.com/file',
    'file:///etc/passwd',
    'gopher://example.com/',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'dict://example.com:11211/',
    'http://user:secret@example.com/',
    'https://:token@example.com/',
    'not a url',
    '',
    '   ',
    'example.com/product/1',
    `https://example.com/${'a'.repeat(MAX_IMPORT_URL_LENGTH)}`,
  ])('rejects %p as INVALID_URL', (url) => {
    expect(rejection(url)).toBe('INVALID_URL');
  });

  it.each([
    'https://www.digikala.com/product/dkp-13196935/',
    'http://example.com/',
    'https://shop.example.ir:443/product/1?color=red',
    'https://8.8.8.8/',
    'https://[2606:4700:4700::1111]/',
    '  https://www.allbirds.com/products/mens-tree-runners  ',
  ])('accepts public URL %p', (url) => {
    expect(rejection(url)).toBe('ACCEPTED');
  });

  it('returns the parsed URL (trimmed)', () => {
    const url = parseImportUrl('  https://Shop.Example.com/p/1?x=1  ', PUBLIC_INTERNET_POLICY);
    expect(url.hostname).toBe('shop.example.com');
    expect(url.search).toBe('?x=1');
  });

  it('socketHostname strips brackets and the trailing dot', () => {
    expect(socketHostname(new URL('http://[::1]/'))).toBe('::1');
    expect(socketHostname(new URL('http://Example.COM./'))).toBe('example.com');
  });
});
```

### `apps/backend/src/modules/importer/net/import-url.ts`

```ts
import { isIP } from 'node:net';
import type { ImportNetworkPolicy } from './address-policy';
import { ImportError } from '../import-error';

/** Longest URL accepted from a client (typical browser/CDN limits sit around 2–8 KB). */
export const MAX_IMPORT_URL_LENGTH = 2048;

/**
 * Host names that only make sense inside a private network. They are refused by
 * name before any DNS query, so an internal resolver is never even asked about
 * them (`localhost` and `*.localhost` always mean loopback — RFC 6761).
 */
const INTERNAL_SUFFIXES = ['.localhost', '.local', '.localdomain', '.internal', '.intranet', '.lan', '.home.arpa', '.corp'];

/** Hostname as the socket layer wants it: lower-case, no trailing dot, IPv6 without brackets. */
export function socketHostname(url: URL): string {
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

/**
 * Validates a user-supplied URL for the importer and returns it parsed.
 *
 * Checks, in order: length; WHATWG parsing (which also canonicalises numeric
 * host tricks such as `http://2130706433/` or `http://0x7f.1/` into
 * `127.0.0.1`); `http:`/`https:` only; no embedded credentials; the port;
 * internal host names; and — when the host is an IP literal — the address
 * itself. Host names are resolved and checked later, at connect time, by the
 * HTTP client (see `SafeHttpClient`), because only that check is immune to DNS
 * rebinding.
 */
export function parseImportUrl(raw: string, policy: ImportNetworkPolicy): URL {
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_IMPORT_URL_LENGTH) {
    throw new ImportError('INVALID_URL', `The URL must be 1–${MAX_IMPORT_URL_LENGTH} characters long`);
  }

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ImportError('INVALID_URL', 'The URL is not valid');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImportError('INVALID_URL', 'Only http:// and https:// URLs can be imported');
  }
  if (url.username !== '' || url.password !== '') {
    throw new ImportError('INVALID_URL', 'URLs with embedded credentials are not accepted');
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!policy.isAllowedPort(port)) {
    throw new ImportError('BLOCKED_TARGET', `Port ${port} is not allowed; only standard web ports (80, 443) can be imported`);
  }

  const host = socketHostname(url);
  if (host.length === 0) {
    throw new ImportError('INVALID_URL', 'The URL has no host');
  }

  if (isIP(host) !== 0) {
    if (policy.isBlockedAddress(host)) {
      throw new ImportError('BLOCKED_TARGET', 'The URL points to a private, loopback or reserved network address');
    }
    return url;
  }

  if (host === 'localhost' || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new ImportError('BLOCKED_TARGET', 'The URL points to an internal host name');
  }
  // A single-label name ("backend", "postgres", "redis") is an intranet or
  // container service name, never a public web site.
  if (!host.includes('.')) {
    throw new ImportError('BLOCKED_TARGET', 'The URL must use a fully qualified public domain name');
  }
  return url;
}
```

### `apps/backend/src/modules/importer/net/safe-http-client.spec.ts`

```ts
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { isReservedAddress, PUBLIC_INTERNET_POLICY, type ImportNetworkPolicy, type ResolvedAddress } from './address-policy';
import { BROWSER_USER_AGENT, SafeHttpClient } from './safe-http-client';
import { ImportError, type ImportErrorCode } from '../import-error';

/**
 * Real sockets against a local server. The policy below is the production
 * reserved-address check with exactly one exception — 127.0.0.1, where the test
 * server listens — and a fake DNS table, so that "a public name that resolves
 * to a private address" can be exercised without a real resolver.
 */
const DNS: Record<string, ResolvedAddress[]> = {
  'site.fixture.test': [{ address: '127.0.0.1', family: 4 }],
  'private.fixture.test': [{ address: '10.1.2.3', family: 4 }],
  'metadata.fixture.test': [{ address: '::ffff:169.254.169.254', family: 6 }],
  // A mixed answer must be refused even though one address is acceptable.
  'mixed.fixture.test': [
    { address: '127.0.0.1', family: 4 },
    { address: '192.168.0.10', family: 4 },
  ],
  'empty.fixture.test': [],
};

const testPolicy: ImportNetworkPolicy = {
  isBlockedAddress: (address) => address !== '127.0.0.1' && isReservedAddress(address),
  isAllowedPort: () => true,
  resolve: (hostname) => Promise.resolve(DNS[hostname] ?? []),
};

let server: Server;
let base: string;
let lastHeaders: IncomingHttpHeaders = {};

beforeAll(async () => {
  server = createServer((req, res) => {
    lastHeaders = req.headers;
    const path = req.url ?? '/';
    const port = (server.address() as AddressInfo).port;
    if (path === '/ok') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>سلام</h1>');
    } else if (path === '/gzip') {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.from('compressed body')));
    } else if (path === '/bomb') {
      // 20 MB of zeros compress to ~20 KB: must be cut off after decompression.
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' });
      res.end(gzipSync(Buffer.alloc(20 * 1024 * 1024)));
    } else if (path === '/large-declared') {
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': String(3 * 1024 * 1024) });
      res.end(Buffer.alloc(3 * 1024 * 1024, 0x61));
    } else if (path === '/large-chunked') {
      res.writeHead(200, { 'content-type': 'text/html' });
      for (let i = 0; i < 40; i += 1) res.write(Buffer.alloc(64 * 1024, 0x62));
      res.end();
    } else if (path === '/slow') {
      // Never answers; the client deadline must fire.
    } else if (path === '/missing') {
      res.writeHead(404, { 'content-type': 'text/html' });
      res.end('not here');
    } else if (path === '/redirect-relative') {
      res.writeHead(302, { location: '/ok' });
      res.end();
    } else if (path === '/redirect-metadata') {
      res.writeHead(301, { location: 'http://169.254.169.254/latest/meta-data/' });
      res.end();
    } else if (path === '/redirect-private-name') {
      res.writeHead(307, { location: `http://private.fixture.test:${port}/ok` });
      res.end();
    } else if (path === '/redirect-file') {
      res.writeHead(302, { location: 'file:///etc/passwd' });
      res.end();
    } else if (path.startsWith('/loop/')) {
      const n = Number(path.slice('/loop/'.length));
      res.writeHead(302, { location: `/loop/${n + 1}` });
      res.end();
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://site.fixture.test:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const client = new SafeHttpClient(testPolicy);
const opts = { accept: 'text/html', maxBytes: 1024 * 1024 };

async function codeOf(promise: Promise<unknown>): Promise<ImportErrorCode | 'RESOLVED'> {
  try {
    await promise;
    return 'RESOLVED';
  } catch (error) {
    if (error instanceof ImportError) return error.code;
    throw error;
  }
}

describe('SafeHttpClient', () => {
  it('fetches a page with browser-like headers', async () => {
    const result = await client.fetch(`${base}/ok`, opts);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html; charset=utf-8');
    expect(result.body.toString('utf8')).toBe('<h1>سلام</h1>');
    expect(lastHeaders['user-agent']).toBe(BROWSER_USER_AGENT);
    expect(lastHeaders['accept']).toBe('text/html');
    expect(lastHeaders['accept-language']).toContain('fa-IR');
  });

  it('decompresses gzip responses', async () => {
    const result = await client.fetch(`${base}/gzip`, opts);
    expect(result.body.toString('utf8')).toBe('compressed body');
  });

  it('follows a relative redirect and reports the final URL', async () => {
    const result = await client.fetch(`${base}/redirect-relative`, opts);
    expect(result.status).toBe(200);
    expect(result.url.pathname).toBe('/ok');
  });

  it('returns non-2xx statuses without a body', async () => {
    const result = await client.fetch(`${base}/missing`, opts);
    expect(result.status).toBe(404);
    expect(result.body.length).toBe(0);
  });

  describe('SSRF', () => {
    it('refuses a redirect to the cloud metadata address', async () => {
      await expect(codeOf(client.fetch(`${base}/redirect-metadata`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('refuses a redirect to a host name that resolves to a private address', async () => {
      await expect(codeOf(client.fetch(`${base}/redirect-private-name`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('refuses a redirect to a non-http scheme', async () => {
      await expect(codeOf(client.fetch(`${base}/redirect-file`, opts))).resolves.toBe('INVALID_URL');
    });

    it('refuses host names whose DNS answer is private (checked at connect time)', async () => {
      const port = (server.address() as AddressInfo).port;
      await expect(codeOf(client.fetch(`http://private.fixture.test:${port}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(client.fetch(`http://metadata.fixture.test:${port}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('refuses a mixed DNS answer if any address is private', async () => {
      const port = (server.address() as AddressInfo).port;
      await expect(codeOf(client.fetch(`http://mixed.fixture.test:${port}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
    });

    it('reports an unresolvable name as a network error', async () => {
      const port = (server.address() as AddressInfo).port;
      await expect(codeOf(client.fetch(`http://empty.fixture.test:${port}/ok`, opts))).resolves.toBe('NETWORK');
    });

    it('with the production policy, never connects to 127.0.0.1:4000 or 192.168.1.1', async () => {
      const production = new SafeHttpClient(PUBLIC_INTERNET_POLICY);
      await expect(codeOf(production.fetch('http://127.0.0.1:4000', opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(production.fetch('http://192.168.1.1', opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(production.fetch('http://127.0.0.1/', opts))).resolves.toBe('BLOCKED_TARGET');
      await expect(codeOf(production.fetch('http://localhost/', opts))).resolves.toBe('BLOCKED_TARGET');
      // The local test server (non-standard port, loopback) is only reachable through the test policy.
      await expect(codeOf(production.fetch(`${base}/ok`, opts))).resolves.toBe('BLOCKED_TARGET');
    });
  });

  it('gives up after 5 redirects', async () => {
    await expect(codeOf(client.fetch(`${base}/loop/0`, opts))).resolves.toBe('TOO_MANY_REDIRECTS');
  });

  it('enforces the deadline', async () => {
    const started = Date.now();
    await expect(codeOf(client.fetch(`${base}/slow`, { ...opts, timeoutMs: 300 }))).resolves.toBe('TIMEOUT');
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('rejects a declared Content-Length above the cap before reading it', async () => {
    await expect(codeOf(client.fetch(`${base}/large-declared`, opts))).resolves.toBe('TOO_LARGE');
  });

  it('rejects a chunked body once it passes the cap', async () => {
    await expect(codeOf(client.fetch(`${base}/large-chunked`, opts))).resolves.toBe('TOO_LARGE');
  });

  it('cuts off a compression bomb after decompression', async () => {
    const before = process.memoryUsage().rss;
    await expect(codeOf(client.fetch(`${base}/bomb`, opts))).resolves.toBe('TOO_LARGE');
    // It must not have inflated the whole 20 MB.
    expect(process.memoryUsage().rss - before).toBeLessThan(15 * 1024 * 1024);
  });
});
```

### `apps/backend/src/modules/importer/net/safe-http-client.ts`

```ts
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { LookupAddress, LookupAllOptions, LookupOneOptions } from 'node:dns';
import { request as httpRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { ImportError } from '../import-error';
import { IMPORT_NETWORK_POLICY, type ImportNetworkPolicy } from './address-policy';
import { parseImportUrl, socketHostname } from './import-url';

/** Hard ceiling for one fetch, redirects included (TM requirement: max 10 s). */
export const IMPORT_FETCH_TIMEOUT_MS = 10_000;
export const IMPORT_MAX_REDIRECTS = 5;

/**
 * A current desktop Chrome identity. Many storefronts (and their CDNs/WAFs)
 * answer non-browser user agents with a bot wall or a stripped page, which
 * would make extraction fail for reasons unrelated to the page itself.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';

export interface SafeFetchOptions {
  /** `Accept` header, e.g. `text/html` or `application/json`. */
  accept: string;
  /** Largest (decompressed) body accepted; larger responses are aborted. */
  maxBytes: number;
  /** Defaults to {@link IMPORT_FETCH_TIMEOUT_MS}; can only be shorter. */
  timeoutMs?: number;
  /** Extra request headers (never overriding the security-relevant ones). */
  headers?: Record<string, string>;
}

export interface SafeFetchResult {
  /** URL of the final response after redirects. */
  url: URL;
  status: number;
  contentType: string | null;
  body: Buffer;
}

type LookupCallback = (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * HTTP(S) GET for user-supplied URLs, hardened against SSRF and abuse.
 *
 * - every URL (including each redirect target) passes `parseImportUrl`;
 * - host names are resolved by the socket's own `lookup`, which rejects the
 *   connection if *any* resolved address is private/reserved — the validated
 *   address is the connected address, so DNS rebinding cannot bypass the check;
 * - redirects are followed manually (max 5) so each hop is re-validated;
 * - one deadline (≤ 10 s) covers the whole chain; bodies are size-capped *after*
 *   decompression, so a compression bomb is cut off as early as a large file;
 * - no connection pooling (`agent: false`): a socket is never reused for a
 *   different, unvalidated request.
 */
@Injectable()
export class SafeHttpClient {
  private readonly logger = new Logger(SafeHttpClient.name);

  constructor(@Inject(IMPORT_NETWORK_POLICY) private readonly policy: ImportNetworkPolicy) {}

  /** Validates a URL without fetching it (same rules as {@link fetch}). */
  validate(raw: string): URL {
    return parseImportUrl(raw, this.policy);
  }

  async fetch(raw: string | URL, options: SafeFetchOptions): Promise<SafeFetchResult> {
    const timeoutMs = Math.min(options.timeoutMs ?? IMPORT_FETCH_TIMEOUT_MS, IMPORT_FETCH_TIMEOUT_MS);
    const deadline = Date.now() + timeoutMs;
    let url = parseImportUrl(typeof raw === 'string' ? raw : raw.toString(), this.policy);

    for (let hop = 0; ; hop += 1) {
      const response = await this.requestOnce(url, options, deadline);
      if (REDIRECT_STATUSES.has(response.status) && response.location !== null) {
        if (hop >= IMPORT_MAX_REDIRECTS) {
          throw new ImportError('TOO_MANY_REDIRECTS', `The site redirected more than ${IMPORT_MAX_REDIRECTS} times`);
        }
        let next: URL;
        try {
          next = new URL(response.location, url);
        } catch {
          throw new ImportError('NETWORK', 'The site answered with an invalid redirect');
        }
        url = parseImportUrl(next.toString(), this.policy);
        continue;
      }
      return { url, status: response.status, contentType: response.contentType, body: response.body };
    }
  }

  private requestOnce(
    url: URL,
    options: SafeFetchOptions,
    deadline: number,
  ): Promise<{ status: number; location: string | null; contentType: string | null; body: Buffer }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return Promise.reject(new ImportError('TIMEOUT', `The site did not answer within ${IMPORT_FETCH_TIMEOUT_MS / 1000} seconds`));
    }

    const host = socketHostname(url);
    const isHttps = url.protocol === 'https:';
    const requestOptions: RequestOptions = {
      method: 'GET',
      host,
      port: url.port === '' ? (isHttps ? 443 : 80) : Number(url.port),
      path: `${url.pathname}${url.search}`,
      agent: false,
      headers: {
        ...options.headers,
        host: url.host,
        'user-agent': BROWSER_USER_AGENT,
        accept: options.accept,
        'accept-language': 'fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7',
        'accept-encoding': 'gzip, deflate, br',
        connection: 'close',
      },
      // IP literals never reach `lookup`; `parseImportUrl` has already checked them.
      ...(isIP(host) === 0 ? { lookup: this.guardedLookup } : {}),
      ...(isHttps && isIP(host) === 0 ? { servername: host } : {}),
    };

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof ImportError ? error : this.translate(error));
      };

      const req = (isHttps ? httpsRequest : httpRequest)(requestOptions, (res) => {
        const status = res.statusCode ?? 0;
        const location = typeof res.headers.location === 'string' ? res.headers.location : null;
        const contentType = typeof res.headers['content-type'] === 'string' ? res.headers['content-type'] : null;

        // Redirects and errors: the body is irrelevant, drop the connection.
        if (REDIRECT_STATUSES.has(status) || status < 200 || status >= 300) {
          res.resume();
          settled = true;
          clearTimeout(timer);
          req.destroy();
          resolve({ status, location, contentType, body: Buffer.alloc(0) });
          return;
        }

        const declaredLength = Number(res.headers['content-length']);
        if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes && !res.headers['content-encoding']) {
          fail(new ImportError('TOO_LARGE', `The response is larger than ${formatBytes(options.maxBytes)}`));
          req.destroy();
          return;
        }

        let stream: Readable;
        try {
          stream = decode(res);
        } catch (error) {
          fail(error);
          req.destroy();
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            fail(new ImportError('TOO_LARGE', `The response is larger than ${formatBytes(options.maxBytes)}`));
            stream.destroy();
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', fail);
        stream.on('end', () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ status, location, contentType, body: Buffer.concat(chunks, total) });
        });
      });

      const timer = setTimeout(() => {
        fail(new ImportError('TIMEOUT', `The site did not answer within ${IMPORT_FETCH_TIMEOUT_MS / 1000} seconds`));
        req.destroy();
      }, remaining);

      req.on('error', fail);
      req.end();
    });
  }

  /**
   * `lookup` for the socket: resolve all addresses, refuse the connection if any
   * of them is reserved. Refusing on *any* (not just the chosen one) keeps a
   * mixed answer from being used to reach an internal address on a retry or a
   * Happy-Eyeballs fallback.
   */
  private readonly guardedLookup = (
    hostname: string,
    options: LookupOneOptions | LookupAllOptions | number,
    callback: LookupCallback,
  ): void => {
    const wantsAll = typeof options === 'object' && options.all === true;
    this.policy
      .resolve(hostname)
      .then((addresses) => {
        if (addresses.length === 0) {
          callback(Object.assign(new Error(`No address found for ${hostname}`), { code: 'ENOTFOUND' }), '');
          return;
        }
        const blocked = addresses.find((entry) => this.policy.isBlockedAddress(entry.address));
        if (blocked !== undefined) {
          this.logger.warn(`Blocked importer connection to ${hostname} (${blocked.address})`);
          callback(new ImportError('BLOCKED_TARGET', 'The URL resolves to a private, loopback or reserved network address'), '');
          return;
        }
        if (wantsAll) {
          callback(null, addresses.map((entry) => ({ address: entry.address, family: entry.family })));
        } else {
          callback(null, addresses[0]!.address, addresses[0]!.family);
        }
      })
      .catch((error: unknown) => {
        callback(Object.assign(new Error(`DNS lookup failed for ${hostname}`), { code: errorCode(error) ?? 'ENOTFOUND' }), '');
      });
  };

  private translate(error: unknown): ImportError {
    const code = errorCode(error);
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return new ImportError('NETWORK', 'The site’s domain name could not be resolved');
    }
    if (code === 'ECONNREFUSED') {
      return new ImportError('NETWORK', 'The site refused the connection');
    }
    if (code === 'ECONNRESET' || code === 'EPIPE') {
      return new ImportError('NETWORK', 'The site closed the connection unexpectedly');
    }
    if (typeof code === 'string' && (code.startsWith('ERR_TLS') || code.includes('CERT') || code === 'DEPTH_ZERO_SELF_SIGNED_CERT')) {
      return new ImportError('NETWORK', 'The site’s TLS certificate could not be verified');
    }
    if (code === 'Z_DATA_ERROR' || code === 'ERR__ERROR_FORMAT_PADDING_1') {
      return new ImportError('NETWORK', 'The site sent a corrupt compressed response');
    }
    return new ImportError('NETWORK', 'The site could not be reached');
  }
}

function decode(res: IncomingMessage): Readable {
  const encoding = String(res.headers['content-encoding'] ?? 'identity').trim().toLowerCase();
  switch (encoding) {
    case '':
    case 'identity':
      return res;
    case 'gzip':
    case 'x-gzip':
      return res.pipe(createGunzip());
    case 'deflate':
      return res.pipe(createInflate());
    case 'br':
      return res.pipe(createBrotliDecompress());
    default:
      throw new ImportError('UNSUPPORTED_CONTENT', `Unsupported content encoding "${encoding}"`);
  }
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.round(bytes / 1024)} KB`;
}
```

### `apps/backend/src/modules/importer/product-importer.service.spec.ts`

```ts
import { categoryMatchKey, importerRateKeys } from './product-importer.service';

describe('categoryMatchKey', () => {
  it('matches spelling variants of the same category name', () => {
    const key = categoryMatchKey('گوشی موبایل');
    for (const variant of ['گوشي موبايل', 'گوشی‌موبایل', ' گوشی  موبایل ', 'گوشی-موبایل']) {
      expect(categoryMatchKey(variant)).toBe(key);
    }
  });

  it('matches Arabic kaf/yeh, punctuation and case differences', () => {
    expect(categoryMatchKey('كيف و كاور گوشی')).toBe(categoryMatchKey('کیف و کاور گوشی'));
    expect(categoryMatchKey('Mobile Phone')).toBe(categoryMatchKey('mobile-phone'));
    expect(categoryMatchKey('لوازم جانبی (موبایل)')).toBe(categoryMatchKey('لوازم جانبی موبایل'));
  });

  it('keeps genuinely different names apart', () => {
    expect(categoryMatchKey('گوشی موبایل')).not.toBe(categoryMatchKey('لوازم جانبی گوشی موبایل'));
    expect(categoryMatchKey('تبلت')).not.toBe(categoryMatchKey('لپ تاپ'));
  });
});

describe('importerRateKeys', () => {
  it('namespaces quota counters per vendor user', () => {
    expect(importerRateKeys.extract('u1')).toBe('importer:extract:u1');
    expect(importerRateKeys.images('u1')).toBe('importer:images:u1');
  });
});
```

### `apps/backend/src/modules/importer/product-importer.service.ts`

```ts
import { BadRequestException, ForbiddenException, HttpException, Injectable, Logger } from '@nestjs/common';
import { VendorStatus } from '@prisma/client';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { RedisService } from '../../infra/redis/redis.service';
import { CategoriesService } from '../categories/categories.service';
import { MediaService } from '../media/media.service';
import { PRODUCT_IMAGE_PURPOSE } from '../products/products.service';
import { normalizePersianText } from '../products/catalog-text';
import type { ExtractSpecResponseDto, FailedImageDto, IngestImagesResponseDto, IngestedImageDto } from './dto/import.dto';
import { DigikalaExtractor } from './extractors/digikala.extractor';
import type { ExtractedProduct } from './extractors/extracted-product';
import { GenericSchemaOrgExtractor } from './extractors/generic-schema.extractor';
import { ImportError, toHttpException } from './import-error';
import { SafeHttpClient } from './net/safe-http-client';

/** Extractions per vendor per window; each one is up to two outbound requests. */
export const EXTRACT_LIMIT = 30;
export const EXTRACT_WINDOW_SECONDS = 10 * 60;
/** Imported images per vendor per window (≈ 10 full galleries an hour). */
export const IMAGE_LIMIT = 120;
export const IMAGE_WINDOW_SECONDS = 60 * 60;
/** Parallel image downloads per request: fast enough, polite to the source. */
const IMAGE_CONCURRENCY = 3;
const IMAGE_ACCEPT = 'image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.5';

export const importerRateKeys = {
  extract: (userId: string): string => `importer:extract:${userId}`,
  images: (userId: string): string => `importer:images:${userId}`,
};

/** Name comparison for category matching: Persian-normalised, no ZWNJ/spaces/punctuation, case-insensitive. */
export function categoryMatchKey(value: string): string {
  return normalizePersianText(value)
    .replace(/[\u200c\u200d\s\-_/،,.()]+/g, '')
    .toLocaleLowerCase('fa');
}

/**
 * Orchestrates product import for vendors: picks the extraction strategy,
 * enforces per-vendor quotas, matches the source category against the local
 * tree and pushes remote images through the regular media pipeline.
 *
 * Nothing here creates a product. The draft goes back to the vendor, who
 * completes price/stock/variants and saves through `POST /vendor/products` —
 * the same validation and audit path as a hand-typed product.
 */
@Injectable()
export class ProductImporterService {
  private readonly logger = new Logger(ProductImporterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly categories: CategoriesService,
    private readonly media: MediaService,
    private readonly http: SafeHttpClient,
    private readonly digikala: DigikalaExtractor,
    private readonly generic: GenericSchemaOrgExtractor,
  ) {}

  async extract(userId: string, rawUrl: string): Promise<ExtractSpecResponseDto> {
    await this.requireApprovedStore(userId);
    const url = this.validateOrThrow(rawUrl);
    await this.consume(importerRateKeys.extract(userId), 1, EXTRACT_LIMIT, EXTRACT_WINDOW_SECONDS, 'Too many product imports; try again later');

    let product: ExtractedProduct;
    try {
      product = this.digikala.matches(url) ? await this.digikala.extract(url) : await this.generic.extract(url);
    } catch (error) {
      throw this.toHttp(error, url);
    }

    const suggestedCategoryId = await this.matchCategory(product.categoryCandidates);
    this.logger.log(
      `Extracted ${product.source} product from ${url.hostname} for user ${userId}: ` +
        `${product.specifications.length} specs, ${product.imageUrls.length} images [${product.strategies.join(', ')}]`,
    );

    return {
      source: product.source,
      strategies: product.strategies,
      sourceUrl: product.sourceUrl,
      sourceProductId: product.sourceProductId,
      title: product.title,
      titleEn: product.titleEn,
      brand: product.brand,
      description: product.description,
      suggestedCategory: product.suggestedCategory,
      suggestedCategoryId,
      specifications: product.specifications,
      imageUrls: product.imageUrls,
    };
  }

  /**
   * Downloads remote images and stores them exactly like an upload through
   * `POST /media/upload/image` with purpose `product_image`: magic-byte check,
   * Sharp decode, WebP re-encode (≤ 1600 px) plus a 300×300 thumbnail, storage
   * through the active provider and a `media_assets` row owned by the caller.
   *
   * Every URL is validated before anything is fetched — one private/internal
   * target rejects the whole request. After that, a failing image (404, too
   * large, not an image) is reported in `failures` while the rest are stored.
   */
  async ingestImages(userId: string, imageUrls: string[]): Promise<IngestImagesResponseDto> {
    await this.requireApprovedStore(userId);
    const urls = [...new Set(imageUrls)];
    const parsed = urls.map((raw) => this.validateOrThrow(raw));
    await this.consume(importerRateKeys.images(userId), parsed.length, IMAGE_LIMIT, IMAGE_WINDOW_SECONDS, 'Too many imported images; try again later');

    const results = new Array<IngestedImageDto | FailedImageDto>(parsed.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < parsed.length) {
        const index = next;
        next += 1;
        results[index] = await this.ingestOne(userId, urls[index]!, parsed[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(IMAGE_CONCURRENCY, parsed.length) }, () => worker()));

    const items = results.filter((entry): entry is IngestedImageDto => 'id' in entry);
    const failures = results.filter((entry): entry is FailedImageDto => 'code' in entry);
    this.logger.log(`Imported ${items.length}/${parsed.length} remote images for user ${userId} (${failures.length} failed)`);
    return { items, failures };
  }

  private async ingestOne(userId: string, sourceUrl: string, url: URL): Promise<IngestedImageDto | FailedImageDto> {
    try {
      const response = await this.http.fetch(url, { accept: IMAGE_ACCEPT, maxBytes: this.media.limits.imageBytes });
      if (response.status < 200 || response.status >= 300) {
        return { sourceUrl, code: 'UPSTREAM_STATUS', message: `The image server answered HTTP ${response.status}` };
      }
      const stored = await this.media.uploadImage(
        { originalName: fileNameOf(response.url), declaredMimeType: response.contentType ?? '', buffer: response.body },
        { ownerUserId: userId, purpose: PRODUCT_IMAGE_PURPOSE, isPublic: true },
      );
      return {
        sourceUrl,
        id: stored.id,
        url: stored.url,
        thumbnailUrl: stored.thumbnailUrl,
        width: stored.width,
        height: stored.height,
        sizeBytes: stored.sizeBytes,
      };
    } catch (error) {
      if (error instanceof ImportError) {
        return { sourceUrl, code: error.code, message: error.message };
      }
      if (error instanceof BadRequestException) {
        return { sourceUrl, code: 'INVALID_IMAGE', message: messageOf(error) };
      }
      throw error;
    }
  }

  /** First active, visible local category whose name equals a source category (most specific first). */
  private async matchCategory(candidates: string[]): Promise<string | null> {
    if (candidates.length === 0) {
      return null;
    }
    const visible = new Set(await this.categories.visibleCategoryIds());
    const rows = await this.prisma.category.findMany({
      where: { isActive: true },
      select: { id: true, titleFa: true, titleEn: true },
    });
    const byName = new Map<string, string>();
    for (const row of rows) {
      if (!visible.has(row.id)) continue;
      for (const name of [row.titleFa, row.titleEn]) {
        if (name) {
          const key = categoryMatchKey(name);
          if (key.length > 0 && !byName.has(key)) byName.set(key, row.id);
        }
      }
    }
    for (const candidate of candidates) {
      const id = byName.get(categoryMatchKey(candidate));
      if (id !== undefined) return id;
    }
    return null;
  }

  private validateOrThrow(raw: string): URL {
    try {
      return this.http.validate(raw);
    } catch (error) {
      throw this.toHttp(error);
    }
  }

  private toHttp(error: unknown, url?: URL): unknown {
    if (error instanceof ImportError) {
      if (error.code === 'BLOCKED_TARGET') {
        this.logger.warn(`Refused importer target${url ? ` ${url.host}` : ''}: ${error.message}`);
      }
      return toHttpException(error);
    }
    return error;
  }

  private async requireApprovedStore(userId: string): Promise<void> {
    const store = await this.prisma.vendor.findUnique({ where: { userId }, select: { status: true } });
    if (store === null || store.status !== VendorStatus.APPROVED) {
      throw new ForbiddenException('Only an approved store can import products');
    }
  }

  /** Fixed-window quota in Redis; `amount` units are charged at once. */
  private async consume(key: string, amount: number, limit: number, windowSeconds: number, message: string): Promise<void> {
    const count = await this.redis.client.incrby(key, amount);
    if (count === amount) {
      await this.redis.client.expire(key, windowSeconds);
    }
    if (count > limit) {
      await this.redis.client.decrby(key, amount);
      const ttl = await this.redis.client.ttl(key);
      throw new TooManyRequestsException(message, ttl > 0 ? ttl : windowSeconds);
    }
  }
}

function fileNameOf(url: URL): string {
  const segment = url.pathname.split('/').pop() ?? '';
  let name = segment;
  try {
    name = decodeURIComponent(segment);
  } catch {
    // keep the raw segment; sanitizeOriginalName cleans it downstream
  }
  name = name.trim();
  return name.length > 0 ? name.slice(0, 120) : 'imported-image';
}

function messageOf(error: HttpException): string {
  const response = error.getResponse();
  if (typeof response === 'object' && response !== null && 'message' in response) {
    const message = (response).message;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
  return error.message;
}
```

### `apps/backend/src/modules/importer/vendor-product-import.controller.ts`

```ts
import { Body, Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiGatewayTimeoutResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import type { AuthenticatedUser } from '../../common/types/authenticated-user';
import { setAuditSnapshot } from '../audit/audit-context';
import { Auditable } from '../audit/audit.decorator';
import {
  ExtractSpecDto,
  ExtractSpecResponseDto,
  IngestImagesDto,
  IngestImagesResponseDto,
} from './dto/import.dto';
import { ProductImporterService } from './product-importer.service';

/**
 * Product importer for vendors: read a product page into a draft, and pull its
 * images into the media pipeline. `VENDOR` role only, and the store must be
 * `APPROVED`.
 *
 * Both calls are audited with the source URL/hosts, so the origin of imported
 * text and images stays traceable (content-rights questions are answered from
 * the audit trail).
 */
@ApiTags('vendor-product-import')
@ApiBearerAuth('access-token')
@Roles(UserRole.VENDOR)
@ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
@ApiForbiddenResponse({ description: 'Not a vendor, or the store is not APPROVED' })
@ApiTooManyRequestsResponse({ description: 'Per-vendor import quota exhausted (see retryAfterSeconds)' })
@Controller('vendor/products/import')
export class VendorProductImportController {
  constructor(private readonly importer: ProductImporterService) {}

  @Post('extract-spec')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'ProductImport' })
  @ApiOperation({
    summary: 'Read a product page into a draft (title, brand, description, specifications, image URLs)',
    description:
      'Digikala product URLs are read through Digikala’s public product API (full specification table and gallery); ' +
      'any other URL is parsed for schema.org Product JSON-LD, product microdata, WooCommerce attribute tables and ' +
      'OpenGraph tags. SSRF-guarded: http/https on ports 80/443, private/loopback/link-local/reserved targets are ' +
      'refused (also after DNS resolution and on every redirect); 10 s timeout; nothing is persisted.',
  })
  @ApiOkResponse({ type: ExtractSpecResponseDto })
  @ApiBadRequestResponse({ description: 'Invalid URL, or a private/internal/reserved target (code IMPORT_INVALID_URL / IMPORT_BLOCKED_TARGET)' })
  @ApiUnprocessableEntityResponse({ description: 'Not a product page, product not found, unsupported content or too large (code IMPORT_NOT_A_PRODUCT / IMPORT_NOT_FOUND / IMPORT_UNSUPPORTED_CONTENT / IMPORT_TOO_LARGE)' })
  @ApiBadGatewayResponse({ description: 'The source site failed (code IMPORT_NETWORK / IMPORT_UPSTREAM_STATUS / IMPORT_TOO_MANY_REDIRECTS)' })
  @ApiGatewayTimeoutResponse({ description: 'The source site did not answer within 10 seconds (code IMPORT_TIMEOUT)' })
  async extractSpec(
    @Body() dto: ExtractSpecDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<ExtractSpecResponseDto> {
    const draft = await this.importer.extract(user.id, dto.url);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: {
        url: dto.url,
        source: draft.source,
        sourceUrl: draft.sourceUrl,
        strategies: draft.strategies,
        specificationCount: draft.specifications.length,
        imageCount: draft.imageUrls.length,
      },
    });
    return draft;
  }

  @Post('ingest-images')
  @HttpCode(HttpStatus.OK)
  @Auditable({ entityName: 'MediaAsset' })
  @ApiOperation({
    summary: 'Download remote images into the media pipeline (WebP + thumbnail) for a product gallery',
    description:
      'Each image is fetched (SSRF-guarded, 10 s, size-capped at the image upload limit) and processed exactly like ' +
      'POST /media/upload/image with purpose product_image. The returned ids go into mediaIds of POST /vendor/products. ' +
      'An invalid or internal URL rejects the whole request; a failing download is reported in failures while the others are stored.',
  })
  @ApiOkResponse({ type: IngestImagesResponseDto })
  @ApiBadRequestResponse({ description: 'Validation failed, or one of the URLs is invalid/private/internal' })
  async ingestImages(
    @Body() dto: IngestImagesDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: unknown,
  ): Promise<IngestImagesResponseDto> {
    const result = await this.importer.ingestImages(user.id, dto.imageUrls);
    setAuditSnapshot(request, {
      actorId: user.id,
      newValue: {
        purpose: 'product_image',
        imported: result.items.map((item) => ({ id: item.id, sourceUrl: item.sourceUrl })),
        failed: result.failures.map((failure) => ({ sourceUrl: failure.sourceUrl, code: failure.code })),
      },
    });
    return result;
  }
}
```

### `apps/backend/src/modules/payments/payments.service.ts`

```ts
import { HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditAction, InstallmentStatus, ParentOrderPaymentStatus, PaymentPurpose, PaymentStatus, Prisma } from '@prisma/client';
import { badRequestWith, conflictWith } from '../../common/http-errors';
import { TooManyRequestsException } from '../../common/exceptions/too-many-requests.exception';
import type { EnvironmentVariables } from '../../config/env.validation';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { CreditLedgerService } from '../credit/credit-ledger.service';
import { CreditOrderService, type ProviderFollowUp } from '../credit/credit-order.service';
import { lockParentOrder, writeOrderAudit, type OrderActor } from '../orders/order-audit';
import { OrderLifecycleService } from '../orders/order-lifecycle.service';
import type { InitiatePaymentResponseDto, PaymentOutcome, PaymentOutcomeDto } from './dto/payment.dto';
import {
  PAYMENT_GATEWAY,
  PaymentGatewayError,
  type GatewayInitiation,
  type GatewayVerification,
  type PaymentGatewayProvider,
} from './gateway/payment-gateway.interface';
import { PLATFORM_DISPLAY_NAME } from '../../common/brand';

type Tx = Prisma.TransactionClient;

/** Open attempts one order may have inside the grace window (each one opens a bank session). */
export const MAX_OPEN_ATTEMPTS = 5;

const paymentSelect = {
  id: true,
  status: true,
  parentOrderId: true,
  purpose: true,
  paymentMethod: true,
  cashAmount: true,
  creditAmount: true,
  creditAccountId: true,
  creditReservationRef: true,
  installmentPlanId: true,
  installmentScheduleId: true,
  installmentSchedule: { select: { status: true } },
  bankRrn: true,
  metadata: true,
  gatewayTrackingToken: true,
  parentOrder: { select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true } },
} satisfies Prisma.PaymentSelect;

type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof paymentSelect }>;

/** What `startGatewaySession` needs to open a bank session for an already-created INITIATED payment. */
export interface GatewaySessionRequest {
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  amount: Prisma.Decimal;
  description: string;
  customerMobile: string;
}

/**
 * Card payments through the active IPG.
 *
 * Money safety rules:
 * - success is decided only by the gateway's server-to-server verify, never by
 *   the redirect parameters, and verify always sends the amount *we* stored;
 * - the gateway is called outside database transactions; the result is then
 *   applied in one transaction that locks the parent order (the same lock the
 *   expiry sweeper, cancellations and vendors use) and re-reads the payment,
 *   so concurrent or repeated callbacks apply at most once;
 * - order completion (stock commit, escrow holds, PAID) and Payment SUCCESSFUL
 *   commit together or not at all;
 * - a captured payment for an order that is no longer payable is recorded as
 *   SUCCESSFUL with `requiresManualRefund` and audited — never dropped.
 *
 * Phase 8 (credit): a HYBRID attempt carries a credit reservation next to its
 * card part. On a verified card payment the reservation is committed and the
 * instalment schedule written before the order completes (same transaction;
 * lock order parent → credit account → stock → wallets); on failure — or if the
 * gateway cannot even open a session — the reservation is released. When any
 * attempt pays the order, the still-held reservations of the other attempts are
 * released. INSTALLMENT_REPAYMENT payments settle one instalment and restore its
 * principal to the credit line. Provider calls follow after the commit.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly callbackUrl: string;
  private readonly graceMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly creditLedger: CreditLedgerService,
    private readonly creditOrders: CreditOrderService,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: PaymentGatewayProvider,
    config: ConfigService<EnvironmentVariables, true>,
  ) {
    this.callbackUrl = `${config.getOrThrow<string>('PUBLIC_API_ORIGIN')}/api/v1/payments/callback`;
    this.graceMs = config.getOrThrow<number>('PAYMENT_CALLBACK_GRACE_MINUTES') * 60_000;
  }

  get gatewayName(): PaymentGatewayProvider['name'] {
    return this.gateway.name;
  }

  async initiate(userId: string, parentOrderId: string, actor: OrderActor): Promise<InitiatePaymentResponseDto> {
    const now = new Date();
    const order = await this.prisma.parentOrder.findFirst({
      where: { id: parentOrderId, userId },
      select: { id: true, orderNumber: true, paymentStatus: true, paymentExpiresAt: true, finalPayableAmount: true, user: { select: { mobile: true } } },
    });
    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
      throw conflictWith('ORDER_NOT_PAYABLE', `This order is ${order.paymentStatus}; only PENDING orders can be paid`, {
        paymentStatus: order.paymentStatus,
      });
    }
    if (order.paymentExpiresAt !== null && order.paymentExpiresAt <= now) {
      throw conflictWith('ORDER_PAYMENT_EXPIRED', 'The payment window of this order has closed; place the order again', {
        paymentExpiresAt: order.paymentExpiresAt,
      });
    }
    const open = await this.prisma.payment.count({
      where: { parentOrderId, status: PaymentStatus.INITIATED, createdAt: { gt: new Date(now.getTime() - this.graceMs) } },
    });
    if (open >= MAX_OPEN_ATTEMPTS) {
      throw new TooManyRequestsException('Too many open payment attempts for this order; finish or wait for one of them', this.graceMs / 1000);
    }

    const payment = await this.prisma.$transaction(async (tx) => {
      const created = await tx.payment.create({
        data: { parentOrderId, gatewayName: this.gateway.name, cashAmount: order.finalPayableAmount, creditAmount: 0, status: PaymentStatus.INITIATED },
        select: { id: true },
      });
      await writeOrderAudit(tx, actor, {
        action: AuditAction.CREATE,
        entityName: 'Payment',
        entityId: created.id,
        newValue: { parentOrderId, orderNumber: order.orderNumber, gatewayName: this.gateway.name, amount: order.finalPayableAmount.toFixed(2) },
      });
      return created;
    });

    const initiation = await this.startGatewaySession({
      paymentId: payment.id,
      parentOrderId,
      orderNumber: order.orderNumber,
      amount: order.finalPayableAmount,
      description: `پرداخت سفارش ${order.orderNumber} — ${PLATFORM_DISPLAY_NAME}`,
      customerMobile: order.user.mobile,
    });
    return {
      paymentId: payment.id,
      redirectUrl: initiation.redirectUrl,
      gatewayName: this.gateway.name,
      amount: order.finalPayableAmount.toFixed(2),
      currency: 'IRR',
      orderNumber: order.orderNumber,
      paymentExpiresAt: order.paymentExpiresAt,
    };
  }

  /**
   * Opens the bank session of an INITIATED payment (card-only, the card part of
   * a HYBRID attempt, or an instalment repayment). If the gateway refuses or
   * cannot be reached, the payment becomes FAILED, its credit reservation (if
   * any) is released, and 502 GATEWAY_UNAVAILABLE is thrown.
   */
  async startGatewaySession(request: GatewaySessionRequest): Promise<GatewayInitiation> {
    let initiation: GatewayInitiation;
    try {
      initiation = await this.gateway.initiatePayment(
        {
          paymentId: request.paymentId,
          orderNumber: request.orderNumber,
          amount: request.amount,
          description: request.description,
          customerMobile: request.customerMobile,
        },
        this.callbackUrl,
      );
    } catch (error) {
      const gatewayError = error instanceof PaymentGatewayError ? error : new PaymentGatewayError(String(error), 'GATEWAY_ERROR', true);
      const followUps = await this.prisma.$transaction(async (tx) => {
        await lockParentOrder(tx, request.parentOrderId);
        const current = await tx.payment.findUniqueOrThrow({ where: { id: request.paymentId }, select: paymentSelect });
        const released = current.status === PaymentStatus.INITIATED ? await this.creditOrders.releaseLocked(tx, current) : null;
        await tx.payment.update({
          where: { id: request.paymentId },
          data: {
            status: PaymentStatus.FAILED,
            metadata: {
              stage: 'initiate',
              code: gatewayError.code,
              message: gatewayError.message.slice(0, 500),
              ...(released ? { creditReservationReleased: true } : {}),
            },
          },
        });
        return released ? [released] : [];
      });
      await this.creditOrders.followUp(followUps);
      this.logger.warn(`Gateway ${this.gateway.name} refused to open a session for payment ${request.paymentId}: ${gatewayError.message}`);
      throw new HttpException(
        { statusCode: HttpStatus.BAD_GATEWAY, error: 'Bad Gateway', code: 'GATEWAY_UNAVAILABLE', message: 'The payment gateway could not open a payment session; try again', gatewayCode: gatewayError.code },
        HttpStatus.BAD_GATEWAY,
      );
    }
    await this.prisma.payment.update({
      where: { id: request.paymentId },
      data: { gatewayTrackingToken: initiation.gatewayToken, metadata: { stage: 'initiated', gateway: initiation.details } as Prisma.InputJsonValue },
    });
    return initiation;
  }

  /** Public bank callback (GET query or POST form/JSON). Idempotent. */
  async handleCallback(params: Record<string, unknown>, actor: OrderActor): Promise<PaymentOutcomeDto> {
    const callback = this.gateway.parseCallback(params);
    if (callback.gatewayToken === null) {
      throw badRequestWith('INVALID_CALLBACK', 'The callback does not carry a payment token');
    }
    const found = await this.prisma.payment.findFirst({
      where: { gatewayName: this.gateway.name, gatewayTrackingToken: callback.gatewayToken },
      select: paymentSelect,
    });
    if (!found) {
      throw new NotFoundException('Unknown payment');
    }
    if (found.status !== PaymentStatus.INITIATED) {
      return this.outcomeOf(found); // repeated callback: same answer, no second verify
    }

    let verification: GatewayVerification;
    try {
      verification = await this.gateway.verifyPayment(callback.gatewayToken, { amount: found.cashAmount, bankStatus: callback.bankStatus });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Verify of payment ${found.id} failed; it stays INITIATED: ${message}`);
      return {
        ...this.outcomeOf(found),
        outcome: 'VERIFICATION_PENDING',
        message: 'The bank could not confirm the payment yet. If money was taken, retry this page shortly; unconfirmed payments are reversed by the bank.',
      };
    }

    const followUps: ProviderFollowUp[] = [];
    const settled = await this.prisma.$transaction(async (tx) => {
      await lockParentOrder(tx, found.parentOrder.id);
      const current = await tx.payment.findUniqueOrThrow({ where: { id: found.id }, select: paymentSelect });
      if (current.status !== PaymentStatus.INITIATED) {
        return current; // another callback won the race
      }
      return verification.success
        ? this.applySuccess(tx, current, verification, actor, followUps)
        : this.applyFailure(tx, current, verification, actor, followUps);
    });
    await this.creditOrders.followUp(followUps);
    return this.outcomeOf(settled);
  }

  private async applySuccess(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<PaymentRow> {
    const paidAt = new Date();
    const effect =
      payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT
        ? await this.applyRepayment(tx, payment, verification, paidAt)
        : await this.applyCheckout(tx, payment, verification, actor, paidAt, followUps);
    const requiresManualRefund = !effect.applied;
    const metadata = {
      ...asObject(payment.metadata),
      stage: 'verified',
      verifyCode: verification.code,
      alreadyVerified: verification.alreadyVerified,
      cardPanMasked: verification.cardPanMasked,
      ...(requiresManualRefund
        ? { requiresManualRefund: true, orderStatusAtCapture: payment.parentOrder.paymentStatus, ...effect.details }
        : effect.details),
    } as Prisma.InputJsonValue;
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: { status: PaymentStatus.SUCCESSFUL, paidAt, bankRrn: verification.bankRrn, metadata: metadata },
      select: paymentSelect,
    });
    await writeOrderAudit(tx, actor, {
      action: AuditAction.PAYMENT_CAPTURE,
      entityName: 'Payment',
      entityId: payment.id,
      oldValue: { status: PaymentStatus.INITIATED },
      newValue: {
        status: PaymentStatus.SUCCESSFUL,
        orderNumber: payment.parentOrder.orderNumber,
        purpose: payment.purpose,
        paymentMethod: payment.paymentMethod,
        amount: payment.cashAmount.toFixed(2),
        creditAmount: payment.creditAmount.toFixed(2),
        bankRrn: verification.bankRrn,
        verifyCode: verification.code,
        ...(payment.installmentScheduleId ? { installmentScheduleId: payment.installmentScheduleId } : {}),
        ...(requiresManualRefund ? { requiresManualRefund: true, orderPaymentStatus: updated.parentOrder.paymentStatus, ...effect.details } : {}),
      },
    });
    if (requiresManualRefund) {
      this.logger.error(
        `Payment ${payment.id} (RRN ${verification.bankRrn ?? '-'}) was captured for order ${payment.parentOrder.orderNumber}, ` +
          `which is ${updated.parentOrder.paymentStatus}: MANUAL REFUND REQUIRED`,
      );
    }
    return updated;
  }

  /**
   * Card payment (or the card part of a HYBRID attempt) for an order. The order
   * must still be PENDING and, for HYBRID, the credit reservation still held;
   * then credit is committed + scheduled first and the order completes.
   */
  private async applyCheckout(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    paidAt: Date,
    followUps: ProviderFollowUp[],
  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
    const orderId = payment.parentOrder.id;
    if (payment.parentOrder.paymentStatus !== ParentOrderPaymentStatus.PENDING) {
      return { applied: false, details: {} };
    }
    const details: Record<string, unknown> = {};
    if (payment.creditAmount.greaterThan(0)) {
      const state = await this.creditLedger.reservationState(tx, payment.creditAccountId!, payment.creditReservationRef!);
      if (state !== 'HELD') {
        // Defensive: a PENDING order whose hybrid reservation is gone cannot be completed with this card part.
        return { applied: false, details: { creditReservationState: state } };
      }
      const committed = await this.creditOrders.commitAndScheduleLocked(tx, payment, paidAt);
      followUps.push(committed.followUp);
      details['schedule'] = committed.schedule;
    }
    const application = await this.lifecycle.applyPaymentLocked(tx, orderId, actor, {
      paymentId: payment.id,
      paymentMethod: payment.paymentMethod,
      ...(verification.bankRrn ? { bankRrn: verification.bankRrn } : {}),
    });
    if (!application.applied) {
      throw new Error(`Order ${orderId} was PENDING under lock but the payment could not be applied`);
    }
    followUps.push(...(await this.creditOrders.releaseOpenReservationsLocked(tx, orderId, payment.id)));
    details['escrowHeld'] = application.escrowHeld;
    return { applied: true, details };
  }

  private async applyRepayment(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    paidAt: Date,
  ): Promise<{ applied: boolean; details: Record<string, unknown> }> {
    const result = await this.creditOrders.applyRepaymentLocked(tx, payment.installmentScheduleId!, payment.cashAmount, { bankRrn: verification.bankRrn, paidAt });
    return { applied: result.applied, details: { installmentStatus: result.installmentStatus, restoredPrincipal: result.restoredPrincipal } };
  }

  private async applyFailure(
    tx: Tx,
    payment: PaymentRow,
    verification: GatewayVerification,
    actor: OrderActor,
    followUps: ProviderFollowUp[],
  ): Promise<PaymentRow> {
    // HYBRID: the card part failed, so the credit reservation is rolled back.
    const released = await this.creditOrders.releaseLocked(tx, payment);
    if (released) followUps.push(released);
    const updated = await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: PaymentStatus.FAILED,
        metadata: {
          ...asObject(payment.metadata),
          stage: 'failed',
          code: verification.code,
          message: verification.message.slice(0, 500),
          ...(released ? { creditReservationReleased: true } : {}),
        },
      },
      select: paymentSelect,
    });
    // The order itself stays PENDING with its stock reserved: the customer can
    // try again until paymentExpiresAt, then the expiry sweeper releases it.
    await writeOrderAudit(tx, actor, {
      action: AuditAction.STATUS_CHANGE,
      entityName: 'Payment',
      entityId: payment.id,
      oldValue: { status: PaymentStatus.INITIATED },
      newValue: {
        status: PaymentStatus.FAILED,
        orderNumber: payment.parentOrder.orderNumber,
        purpose: payment.purpose,
        paymentMethod: payment.paymentMethod,
        code: verification.code,
        message: verification.message,
        ...(released ? { creditReservationReleased: released.reservationRef } : {}),
      },
    });
    return updated;
  }

  private outcomeOf(payment: PaymentRow): PaymentOutcomeDto {
    const order = payment.parentOrder;
    const repayment = payment.purpose === PaymentPurpose.INSTALLMENT_REPAYMENT;
    const canRetry = repayment
      ? payment.installmentSchedule?.status === InstallmentStatus.PENDING || payment.installmentSchedule?.status === InstallmentStatus.OVERDUE
      : order.paymentStatus === ParentOrderPaymentStatus.PENDING && (order.paymentExpiresAt === null || order.paymentExpiresAt > new Date());
    const metadata = asObject(payment.metadata);
    let outcome: PaymentOutcome;
    let message: string;
    if (payment.status === PaymentStatus.SUCCESSFUL) {
      outcome = metadata['requiresManualRefund'] === true ? 'PAID_REQUIRES_REFUND' : 'PAID';
      message = repayment
        ? outcome === 'PAID'
          ? 'Payment confirmed; the instalment is paid'
          : 'The bank captured this payment but the instalment was already settled; it will be refunded by our finance team'
        : outcome === 'PAID'
          ? 'Payment confirmed; the order is paid'
          : 'The bank captured this payment but the order had already been paid or closed; it will be refunded by our finance team';
    } else if (payment.status === PaymentStatus.INITIATED) {
      outcome = 'VERIFICATION_PENDING';
      message = 'The payment has not been confirmed yet';
    } else {
      outcome = 'FAILED';
      message = canRetry ? 'The payment was not completed; you can try again' : 'The payment was not completed';
    }
    return {
      outcome,
      paymentId: payment.id,
      paymentStatus: payment.status,
      parentOrderId: order.id,
      orderNumber: order.orderNumber,
      orderPaymentStatus: order.paymentStatus,
      bankRrn: payment.bankRrn,
      message,
      canRetry: outcome === 'FAILED' && canRetry,
      paymentExpiresAt: order.paymentExpiresAt,
      purpose: payment.purpose,
      paymentMethod: payment.paymentMethod,
      cashAmount: payment.cashAmount.toFixed(2),
      creditAmount: payment.creditAmount.toFixed(2),
      installmentScheduleId: payment.installmentScheduleId,
    };
  }
}

function asObject(value: Prisma.JsonValue | null): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value) : {};
}
```

### `apps/backend/src/modules/payments/sandbox-bank.controller.ts`

```ts
import { Body, Controller, Get, HttpStatus, Inject, NotFoundException, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import { ApiBadRequestResponse, ApiNotFoundResponse, ApiOperation, ApiProduces, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { FastifyReply } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { SkipAudit } from '../audit/audit.decorator';
import { SandboxDecisionDto } from './dto/sandbox.dto';
import { PAYMENT_GATEWAY, PaymentGatewayError, type PaymentGatewayProvider } from './gateway/payment-gateway.interface';
import { SandboxPaymentGatewayProvider, type SandboxSession } from './gateway/sandbox-payment-gateway.provider';

const UUID = new ParseUUIDPipe({ version: '4' });

/**
 * DEVELOPMENT / TEST ONLY — the simulated bank page of the sandbox gateway.
 * Every route answers 404 unless PAYMENT_GATEWAY_PROVIDER=sandbox, and the API
 * cannot boot with the sandbox provider in production, so this page never
 * exists in production.
 */
@ApiTags('sandbox-payments')
@Public()
@Controller('sandbox/payment-page')
export class SandboxBankController {
  private readonly sandbox: SandboxPaymentGatewayProvider | null;

  constructor(@Inject(PAYMENT_GATEWAY) gateway: PaymentGatewayProvider) {
    this.sandbox = gateway instanceof SandboxPaymentGatewayProvider ? gateway : null;
  }

  @Get(':paymentId')
  @ApiOperation({ summary: 'Simulated bank payment page (HTML)', description: 'Shows the order and amount with “Pay” and “Decline” buttons.' })
  @ApiProduces('text/html')
  @ApiResponse({ status: HttpStatus.OK, description: 'HTML page' })
  @ApiNotFoundResponse({ description: 'Sandbox gateway not active, or unknown/expired session' })
  async page(@Param('paymentId', UUID) paymentId: string, @Res() reply: FastifyReply): Promise<void> {
    const session = await this.requireSandbox().sessionByPayment(paymentId);
    if (!session) {
      throw new NotFoundException('Unknown or expired sandbox bank session');
    }
    await reply
      .status(HttpStatus.OK)
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'no-store')
      .header('X-Robots-Tag', 'noindex')
      .send(renderPage(session));
  }

  @Post(':paymentId/decision')
  @SkipAudit() // the resulting callback is audited
  @ApiOperation({
    summary: 'Simulated payer decision',
    description: 'PAY settles the session with a 12-digit RRN, DECLINE fails it; then 303-redirects the browser to the payment callback with Authority and Status=OK|NOK.',
  })
  @ApiResponse({ status: HttpStatus.SEE_OTHER, description: 'Redirect to /api/v1/payments/callback?Authority=…&Status=OK|NOK' })
  @ApiBadRequestResponse({ description: 'decision must be PAY or DECLINE' })
  @ApiNotFoundResponse({ description: 'Sandbox gateway not active, or unknown/expired session' })
  async decide(@Param('paymentId', UUID) paymentId: string, @Body() dto: SandboxDecisionDto, @Res() reply: FastifyReply): Promise<void> {
    try {
      const { redirectTo } = await this.requireSandbox().settle(paymentId, dto.decision);
      await reply.status(HttpStatus.SEE_OTHER).header('Location', redirectTo).header('Cache-Control', 'no-store').send();
    } catch (error) {
      if (error instanceof PaymentGatewayError && error.code === 'SESSION_NOT_FOUND') {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  private requireSandbox(): SandboxPaymentGatewayProvider {
    if (!this.sandbox) {
      throw new NotFoundException();
    }
    return this.sandbox;
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char);
}

function renderPage(session: SandboxSession): string {
  const amount = new Intl.NumberFormat('fa-IR').format(Number(session.amount));
  const action = `/api/v1/sandbox/payment-page/${encodeURIComponent(session.paymentId)}/decision`;
  const settled = session.status !== 'AWAITING_PAYER';
  const statusText = session.status === 'PAID' ? 'پرداخت شده' : session.status === 'DECLINED' ? 'رد شده' : 'در انتظار پرداخت';
  const buttons = settled
    ? `<form method="post" action="${action}"><input type="hidden" name="decision" value="PAY"><button class="btn secondary" type="submit">بازگشت به فروشگاه</button></form>`
    : `<form method="post" action="${action}"><input type="hidden" name="decision" value="PAY"><button class="btn pay" type="submit">پرداخت موفق</button></form>
       <form method="post" action="${action}"><input type="hidden" name="decision" value="DECLINE"><button class="btn fail" type="submit">انصراف / پرداخت ناموفق</button></form>`;
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>درگاه پرداخت آزمایشی شاگردم</title>
<style>
  body { margin: 0; font-family: Tahoma, "Segoe UI", sans-serif; background: #f1f5f9; color: #0f172a; }
  .banner { background: #b45309; color: #fff; text-align: center; padding: 10px; font-size: 14px; }
  .card { max-width: 420px; margin: 40px auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 20px rgba(15,23,42,.08); padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 20px; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: 10px 16px; margin: 0 0 24px; }
  dt { color: #64748b; } dd { margin: 0; font-weight: bold; direction: ltr; text-align: left; }
  .amount { font-size: 22px; color: #047857; }
  form { margin: 0 0 10px; }
  .btn { width: 100%; border: 0; border-radius: 8px; padding: 14px; font-size: 16px; cursor: pointer; font-family: inherit; }
  .pay { background: #059669; color: #fff; } .fail { background: #e2e8f0; color: #b91c1c; } .secondary { background: #1d4ed8; color: #fff; }
</style>
</head>
<body>
<div class="banner">محیط آزمایشی (SANDBOX) — هیچ پولی جابه‌جا نمی‌شود. این صفحه فقط در محیط توسعه وجود دارد.</div>
<main class="card">
  <h1>درگاه پرداخت آزمایشی</h1>
  <dl>
    <dt>پذیرنده</dt><dd>Shagerdam (sandbox)</dd>
    <dt>شماره سفارش</dt><dd>${escapeHtml(session.orderNumber)}</dd>
    <dt>مبلغ</dt><dd class="amount">${escapeHtml(amount)} ریال</dd>
    <dt>وضعیت</dt><dd>${escapeHtml(statusText)}</dd>
    ${session.bankRrn ? `<dt>شماره مرجع</dt><dd>${escapeHtml(session.bankRrn)}</dd>` : ''}
  </dl>
  ${buttons}
</main>
</body>
</html>`;
}
```

### `apps/backend/src/modules/products/catalog-search.service.ts`

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { visibleProductSql, visibleProductWhere } from '../categories/catalog-visibility';
import { CategoriesService } from '../categories/categories.service';
import { CategorySummaryDto } from '../categories/dto/category-response.dto';
import { escapeLikePattern, searchTermVariants } from './catalog-text';
import type { ProductSort, PublicProductQueryDto } from './dto/product-query.dto';
import type { PublicProductDetailDto, PublicProductListItemDto } from './dto/product-response.dto';
import { COLOR_HEX_PATTERN } from './product-rules';
import {
  imageRef,
  maxDiscountPercent,
  startingCompareAtPrice,
  mediaSelect,
  priceRange,
  specificationOrder,
  specificationSelect,
  toPublicVariant,
  variantOptions,
  variantSelect,
  type VariantRow,
} from './product-views';

/** Sub-orders in these states did not result in a sale and do not count as "popular". */
const NON_SALE_STATUSES = Prisma.sql`('CANCELLED', 'REFUNDED')`;

const listingSelect = {
  id: true,
  slug: true,
  title: true,
  brand: true,
  createdAt: true,
  category: { select: { id: true, slug: true, titleFa: true, titleEn: true } },
  vendor: { select: { storeName: true, storeSlug: true, logoUrl: true } },
  variants: { where: { isActive: true }, select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 1 },
} satisfies Prisma.ProductSelect;

/**
 * Public catalogue discovery.
 *
 * The listing is one parameterised SQL statement (plus a COUNT with the same
 * predicate) so that every filter is evaluated by PostgreSQL on indexed columns:
 *
 * - text search: `ILIKE '%term%'` on title / brand / description, served by the
 *   pg_trgm GIN indexes (`products_*_trgm_idx`); each term is also tried with
 *   ASCII and Persian digits;
 * - variant filters (price range, stock, colours, sizes) must hold for the
 *   **same** active variant — "red, size L, under 1,000,000" never matches a
 *   product whose only red variant is size M;
 * - category filters include every descendant, resolved from the cached tree;
 * - sorting: newest, lowest matching price asc/desc, or units sold.
 *
 * Only ids come back from the SQL; the page is then hydrated through Prisma
 * with the same visibility predicate, so the response shape is typed end to end.
 */
@Injectable()
export class CatalogSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly categories: CategoriesService,
  ) {}

  async search(query: PublicProductQueryDto): Promise<{ items: PublicProductListItemDto[]; total: number }> {
    if (query.categorySlug !== undefined && query.categoryId !== undefined) {
      throw new BadRequestException('Use either categorySlug or categoryId, not both');
    }
    if (query.minPrice !== undefined && query.maxPrice !== undefined && query.minPrice > query.maxPrice) {
      throw new BadRequestException('minPrice must not be greater than maxPrice');
    }

    const categoryIds = await this.scopeCategoryIds(query);
    if (categoryIds.length === 0) {
      return { items: [], total: 0 };
    }

    const where = this.buildWhere(query, categoryIds);
    const variantMatch = this.buildVariantMatch(query);
    const needsSales = query.sortBy === 'popular';

    const from = Prisma.sql`
      FROM products p
      JOIN vendors v ON v.id = p.vendor_id
      JOIN LATERAL (
        SELECT MIN(pv.price) AS min_price
          FROM product_variants pv
         WHERE ${variantMatch}
      ) mv ON mv.min_price IS NOT NULL`;

    const sales = needsSales
      ? Prisma.sql`
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(oi.quantity), 0)::int AS sold
          FROM order_items oi
          JOIN product_variants sv ON sv.id = oi.product_variant_id
          JOIN sub_orders so ON so.id = oi.sub_order_id
         WHERE sv.product_id = p.id AND so.status NOT IN ${NON_SALE_STATUSES}
      ) sales ON true`
      : Prisma.empty;

    const [pageRows, countRows] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT p.id
        ${from}
        ${sales}
        WHERE ${where}
        ORDER BY ${orderBy(query.sortBy)}
        LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`),
      this.prisma.$queryRaw<Array<{ total: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS total
        ${from}
        WHERE ${where}`),
    ]);

    const total = countRows[0]?.total ?? 0;
    const ids = pageRows.map((row) => row.id);
    if (ids.length === 0) {
      return { items: [], total };
    }

    const products = await this.prisma.product.findMany({
      where: { id: { in: ids }, ...visibleProductWhere() },
      select: listingSelect,
    });
    const byId = new Map(products.map((product) => [product.id, product]));

    const items = ids
      .map((id) => byId.get(id))
      .filter((product): product is NonNullable<typeof product> => product !== undefined)
      .map((product): PublicProductListItemDto => {
        const options = variantOptions(product.variants);
        return {
          id: product.id,
          slug: product.slug,
          title: product.title,
          brand: product.brand,
          primaryImage: imageRef(product.media[0]),
          priceRange: priceRange(product.variants) ?? { min: '0.00', max: '0.00' },
          maxDiscountPercent: maxDiscountPercent(product.variants),
          startingCompareAtPrice: startingCompareAtPrice(product.variants),
          colors: options.colors,
          sizes: options.sizes,
          inStock: product.variants.some(hasStock),
          vendor: product.vendor,
          category: CategorySummaryDto.from(product.category),
          createdAt: product.createdAt,
        };
      });

    return { items, total };
  }

  /** A publicly visible product by slug, with live stock. 404 otherwise. */
  async getBySlug(slug: string): Promise<PublicProductDetailDto> {
    const visibleIds = await this.categories.visibleCategoryIds();
    const product = await this.prisma.product.findFirst({
      where: { slug, ...visibleProductWhere(), categoryId: { in: visibleIds } },
      select: {
        id: true,
        slug: true,
        title: true,
        description: true,
        brand: true,
        categoryId: true,
        createdAt: true,
        updatedAt: true,
        vendor: {
          select: { storeName: true, storeSlug: true, logoUrl: true, bio: true, instagramHandle: true, verifiedAt: true },
        },
        variants: { where: { isActive: true }, select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
        media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
        specifications: { select: specificationSelect, orderBy: specificationOrder },
      },
    });
    if (!product) {
      throw new NotFoundException(`Product "${slug}" was not found`);
    }

    const breadcrumbs = await this.categories.breadcrumbFor(product.categoryId);
    const options = variantOptions(product.variants);

    return {
      id: product.id,
      slug: product.slug,
      title: product.title,
      description: product.description,
      brand: product.brand,
      breadcrumbs: breadcrumbs.map((node) => CategorySummaryDto.from(node)),
      vendor: product.vendor,
      media: product.media.map((media) => ({ url: media.url, thumbnailUrl: media.thumbnailUrl })),
      variants: product.variants.map((variant) => toPublicVariant(variant)),
      specifications: product.specifications.map((row) => ({ ...row })),
      priceRange: priceRange(product.variants) ?? { min: '0.00', max: '0.00' },
      maxDiscountPercent: maxDiscountPercent(product.variants),
      colors: options.colors,
      sizes: options.sizes,
      inStock: product.variants.some(hasStock),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  // ---------------------------------------------------------------------------

  private async scopeCategoryIds(query: PublicProductQueryDto): Promise<string[]> {
    if (query.categorySlug !== undefined || query.categoryId !== undefined) {
      const subtree = await this.categories.visibleSubtreeIds({
        ...(query.categorySlug !== undefined ? { slug: query.categorySlug.trim().toLowerCase() } : {}),
        ...(query.categoryId !== undefined ? { id: query.categoryId } : {}),
      });
      return subtree ?? [];
    }
    return this.categories.visibleCategoryIds();
  }

  private buildWhere(query: PublicProductQueryDto, categoryIds: string[]): Prisma.Sql {
    const conditions: Prisma.Sql[] = [visibleProductSql(), Prisma.sql`p.category_id = ANY(${categoryIds}::uuid[])`];

    if (query.vendorSlug !== undefined) {
      conditions.push(Prisma.sql`v.store_slug = ${query.vendorSlug.trim().toLowerCase()}`);
    }

    if (query.search !== undefined) {
      const patterns = searchTermVariants(query.search).map((term) => `%${escapeLikePattern(term)}%`);
      if (patterns.length > 0) {
        // One ILIKE per column and pattern (not ILIKE ANY): the planner turns an
        // OR of simple ILIKEs into a BitmapOr over the trigram GIN indexes.
        const matches = patterns.flatMap((pattern) => [
          Prisma.sql`p.title ILIKE ${pattern}`,
          Prisma.sql`p.brand ILIKE ${pattern}`,
          Prisma.sql`p.description ILIKE ${pattern}`,
        ]);
        conditions.push(Prisma.sql`(${Prisma.join(matches, ' OR ')})`);
      }
    }

    return Prisma.join(conditions, ' AND ');
  }

  /** Predicate over `product_variants pv` for the variant a product must have. */
  private buildVariantMatch(query: PublicProductQueryDto): Prisma.Sql {
    const conditions: Prisma.Sql[] = [Prisma.sql`pv.product_id = p.id`, Prisma.sql`pv.is_active = true`];

    if (query.minPrice !== undefined) {
      conditions.push(Prisma.sql`pv.price >= ${query.minPrice.toFixed(2)}::numeric`);
    }
    if (query.maxPrice !== undefined) {
      conditions.push(Prisma.sql`pv.price <= ${query.maxPrice.toFixed(2)}::numeric`);
    }
    if (query.inStockOnly === true) {
      conditions.push(Prisma.sql`pv.stock_quantity - pv.reserved_quantity > 0`);
    }
    if (query.colors !== undefined && query.colors.length > 0) {
      const hexes = query.colors.map((color) => color.toUpperCase()).filter((color) => COLOR_HEX_PATTERN.test(color));
      const names = query.colors
        .filter((color) => !COLOR_HEX_PATTERN.test(color.toUpperCase()))
        .flatMap((color) => searchTermVariants(color))
        .map((color) => color.toLowerCase());
      const colorMatches: Prisma.Sql[] = [];
      if (names.length > 0) colorMatches.push(Prisma.sql`lower(pv.color_name) = ANY(${names}::text[])`);
      if (hexes.length > 0) colorMatches.push(Prisma.sql`upper(pv.color_hex) = ANY(${hexes}::text[])`);
      conditions.push(colorMatches.length > 0 ? Prisma.sql`(${Prisma.join(colorMatches, ' OR ')})` : Prisma.sql`false`);
    }
    if (query.sizes !== undefined && query.sizes.length > 0) {
      const sizes = query.sizes.map((size) => size.toUpperCase());
      conditions.push(Prisma.sql`upper(pv.size) = ANY(${sizes}::text[])`);
    }

    return Prisma.join(conditions, ' AND ');
  }
}

function orderBy(sort: ProductSort): Prisma.Sql {
  switch (sort) {
    case 'price_asc':
      return Prisma.sql`mv.min_price ASC, p.created_at DESC, p.id ASC`;
    case 'price_desc':
      return Prisma.sql`mv.min_price DESC, p.created_at DESC, p.id ASC`;
    case 'popular':
      return Prisma.sql`sales.sold DESC, p.created_at DESC, p.id ASC`;
    case 'newest':
    default:
      return Prisma.sql`p.created_at DESC, p.id ASC`;
  }
}

function hasStock(variant: Pick<VariantRow, 'stockQuantity' | 'reservedQuantity'>): boolean {
  return variant.stockQuantity - variant.reservedQuantity > 0;
}
```

### `apps/backend/src/modules/products/dto/product-input.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  NotEquals,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { IsOptionalNonNullable } from '../../../common/validators/is-optional-nonnullable';
import { PRODUCT_SLUG_MAX_LENGTH, PRODUCT_SLUG_PATTERN } from '../catalog-text';
import {
  COLOR_HEX_PATTERN,
  MAX_MEDIA_PER_PRODUCT,
  MAX_MONEY,
  MAX_SPECIFICATIONS_PER_PRODUCT,
  SPECIFICATION_GROUP_MAX_LENGTH,
  SPECIFICATION_TITLE_MAX_LENGTH,
  SPECIFICATION_VALUE_MAX_LENGTH,
  MAX_STOCK,
  MAX_VARIANTS_PER_PRODUCT,
  SKU_PATTERN,
  normalizeColorHex,
  normalizeSku,
} from '../product-rules';

const MONEY = { maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false } as const;
const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);
const toSku = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? normalizeSku(value) : value);
const toHex = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? normalizeColorHex(value) : value);
const toSlug = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;
const nullable = (_object: object, value: unknown): boolean => value !== null && value !== undefined;

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

export class CreateVariantDto {
  @ApiProperty({
    example: 'SHP-A55-256-BLK',
    maxLength: 64,
    description: 'Globally unique stock-keeping unit. Upper-cased on input; letters, digits, ".", "_" and "-".',
  })
  @Transform(toSku)
  @IsString()
  @Matches(SKU_PATTERN, {
    message: 'sku must be 1–64 characters of A–Z, 0–9, ".", "_" or "-", starting and ending with a letter or digit',
  })
  sku!: string;

  @ApiPropertyOptional({ example: 'مشکی', maxLength: 40, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  colorName?: string | null;

  @ApiPropertyOptional({ example: '#111827', pattern: COLOR_HEX_PATTERN.source, nullable: true, type: String })
  @Transform(toHex)
  @ValidateIf(nullable)
  @IsString()
  @Matches(COLOR_HEX_PATTERN, { message: 'colorHex must be a 6-digit hex colour such as #1D4ED8' })
  colorHex?: string | null;

  @ApiPropertyOptional({ example: 'XL', maxLength: 20, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  size?: string | null;

  @ApiPropertyOptional({ example: '۱۸ ماه گارانتی شرکتی', maxLength: 60, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  guarantee?: string | null;

  @ApiProperty({ example: 42500000, description: 'Selling price the buyer pays (IRR, two decimals, > 0).' })
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  price!: number;

  @ApiPropertyOptional({
    example: 45000000,
    nullable: true,
    type: Number,
    description: 'Original (strike-through) price. When present it must be strictly greater than price.',
  })
  @ValidateIf(nullable)
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  compareAtPrice?: number | null;

  @ApiProperty({ example: 12, minimum: 0, maximum: MAX_STOCK })
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  stockQuantity!: number;

  @ApiPropertyOptional({ example: 202, minimum: 1, maximum: MAX_STOCK, nullable: true, type: Number })
  @ValidateIf(nullable)
  @IsInt()
  @Min(1)
  @Max(MAX_STOCK)
  weightGrams?: number | null;

  @ApiPropertyOptional({ default: true, description: 'Inactive variants are kept but never sold or listed.' })
  @IsOptionalNonNullable()
  @IsBoolean()
  isActive?: boolean;
}

/**
 * Quick update of one variant. `stockQuantity` sets an absolute value;
 * `stockDelta` adjusts atomically relative to the current value (e.g. `-3`
 * after a manual sale). They are mutually exclusive.
 */
export class UpdateVariantDto {
  @ApiPropertyOptional({ example: 41900000, description: 'New selling price (> 0).' })
  @IsOptionalNonNullable()
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  price?: number;

  @ApiPropertyOptional({
    example: 45000000,
    nullable: true,
    type: Number,
    description: 'New strike-through price; null removes the discount. Must stay greater than the (new) price.',
  })
  @ValidateIf(nullable)
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  compareAtPrice?: number | null;

  @ApiPropertyOptional({ example: 20, minimum: 0, maximum: MAX_STOCK, description: 'Absolute on-hand stock.' })
  @IsOptionalNonNullable()
  @IsInt()
  @Min(0)
  @Max(MAX_STOCK)
  stockQuantity?: number;

  @ApiPropertyOptional({
    example: -3,
    minimum: -MAX_STOCK,
    maximum: MAX_STOCK,
    description: 'Relative, atomic stock change. Refused when it would take stock below the reserved quantity.',
  })
  @IsOptionalNonNullable()
  @IsInt()
  @Min(-MAX_STOCK)
  @Max(MAX_STOCK)
  @NotEquals(0, { message: 'stockDelta must not be 0' })
  stockDelta?: number;

  @ApiPropertyOptional({ description: 'Deactivating the last active variant of a published product is refused.' })
  @IsOptionalNonNullable()
  @IsBoolean()
  isActive?: boolean;
}

// ---------------------------------------------------------------------------
// Technical specifications
// ---------------------------------------------------------------------------

export class ProductSpecificationInputDto {
  @ApiPropertyOptional({ example: 'حافظه', maxLength: SPECIFICATION_GROUP_MAX_LENGTH, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(SPECIFICATION_GROUP_MAX_LENGTH)
  groupTitle?: string | null;

  @ApiProperty({ example: 'حافظه داخلی', minLength: 1, maxLength: SPECIFICATION_TITLE_MAX_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(SPECIFICATION_TITLE_MAX_LENGTH)
  title!: string;

  @ApiProperty({ example: '256 گیگابایت', minLength: 1, maxLength: SPECIFICATION_VALUE_MAX_LENGTH, description: 'May contain line breaks.' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(SPECIFICATION_VALUE_MAX_LENGTH)
  value!: string;
}

// ---------------------------------------------------------------------------
// Products
// ---------------------------------------------------------------------------

export class CreateProductDto {
  @ApiProperty({ example: 'گوشی موبایل سامسونگ Galaxy A55 ظرفیت ۲۵۶ گیگابایت', minLength: 3, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string;

  @ApiPropertyOptional({
    example: 'galaxy-a55-256',
    maxLength: PRODUCT_SLUG_MAX_LENGTH,
    description:
      'Custom unique slug (lowercase letters of any script, digits, single hyphens). ' +
      'Omit it to generate one from the title; a numeric suffix is added when the generated slug is taken.',
  })
  @Transform(toSlug)
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(PRODUCT_SLUG_MAX_LENGTH)
  @Matches(PRODUCT_SLUG_PATTERN, { message: 'slug must contain lowercase letters, digits and single hyphens only' })
  slug?: string;

  @ApiPropertyOptional({ example: 'نمایشگر ۶٫۶ اینچی Super AMOLED…', maxLength: 20000, nullable: true, type: String })
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(20000)
  description?: string | null;

  @ApiProperty({ format: 'uuid', description: 'An active category.' })
  @IsUUID('4', { message: 'categoryId must be a UUID' })
  categoryId!: string;

  @ApiPropertyOptional({ example: 'Samsung', maxLength: 80, nullable: true, type: String })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brand?: string | null;

  @ApiProperty({ example: 42500000, description: 'Reference price of the product (IRR, > 0). Variants carry the selling prices.' })
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  basePrice!: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_MEDIA_PER_PRODUCT,
    description:
      'Ordered gallery: ids returned by POST /media/upload/image with purpose "product_image", uploaded by this account. ' +
      'The first image is the primary one.',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_PER_PRODUCT)
  @ArrayUnique({ message: 'mediaIds must not contain the same image twice' })
  @IsUUID('4', { each: true, message: 'each mediaIds entry must be a UUID' })
  mediaIds?: string[];

  @ApiPropertyOptional({
    type: () => [ProductSpecificationInputDto],
    maxItems: MAX_SPECIFICATIONS_PER_PRODUCT,
    description: 'Technical specifications in display order (typed, or pre-filled by the product importer).',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_SPECIFICATIONS_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => ProductSpecificationInputDto)
  specifications?: ProductSpecificationInputDto[];

  @ApiProperty({ type: () => [CreateVariantDto], minItems: 1, maxItems: MAX_VARIANTS_PER_PRODUCT })
  @IsArray()
  @ArrayMinSize(1, { message: 'a product needs at least one variant' })
  @ArrayMaxSize(MAX_VARIANTS_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => CreateVariantDto)
  variants!: CreateVariantDto[];

  @ApiPropertyOptional({
    default: false,
    description: 'Publish immediately. Requires at least one active variant; otherwise the product is saved as a draft.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isPublished?: boolean;
}

export class UpdateProductDto {
  @ApiPropertyOptional({ minLength: 3, maxLength: 200 })
  @Transform(trim)
  @IsOptionalNonNullable()
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ maxLength: PRODUCT_SLUG_MAX_LENGTH })
  @Transform(toSlug)
  @IsOptionalNonNullable()
  @IsString()
  @MaxLength(PRODUCT_SLUG_MAX_LENGTH)
  @Matches(PRODUCT_SLUG_PATTERN, { message: 'slug must contain lowercase letters, digits and single hyphens only' })
  slug?: string;

  @ApiPropertyOptional({ maxLength: 20000, nullable: true, type: String, description: 'null clears the description.' })
  @ValidateIf(nullable)
  @IsString()
  @MaxLength(20000)
  description?: string | null;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptionalNonNullable()
  @IsUUID('4', { message: 'categoryId must be a UUID' })
  categoryId?: string;

  @ApiPropertyOptional({ maxLength: 80, nullable: true, type: String, description: 'null clears the brand.' })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  brand?: string | null;

  @ApiPropertyOptional({ example: 41900000 })
  @IsOptionalNonNullable()
  @IsNumber(MONEY)
  @IsPositive()
  @Max(MAX_MONEY)
  basePrice?: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: MAX_MEDIA_PER_PRODUCT,
    description: 'Replaces the whole gallery in the given order (use it to re-order, add or remove images). [] clears it.',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_PER_PRODUCT)
  @ArrayUnique({ message: 'mediaIds must not contain the same image twice' })
  @IsUUID('4', { each: true, message: 'each mediaIds entry must be a UUID' })
  mediaIds?: string[];

  @ApiPropertyOptional({
    type: () => [ProductSpecificationInputDto],
    maxItems: MAX_SPECIFICATIONS_PER_PRODUCT,
    description: 'Replaces the whole specification list in the given order. [] clears it.',
  })
  @IsOptionalNonNullable()
  @IsArray()
  @ArrayMaxSize(MAX_SPECIFICATIONS_PER_PRODUCT)
  @ValidateNested({ each: true })
  @Type(() => ProductSpecificationInputDto)
  specifications?: ProductSpecificationInputDto[];

  @ApiPropertyOptional({
    description:
      'Publish or unpublish. Publishing needs at least one active variant and is refused while the product is blocked by staff.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isPublished?: boolean;
}

/** Staff moderation of one product. */
export class AdminProductStatusDto {
  @ApiPropertyOptional({
    description:
      'true blocks the product (it disappears from the storefront and is unpublished); false lifts the block. ' +
      'Lifting a block does not re-publish: the vendor decides when to publish again.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isBlockedByAdmin?: boolean;

  @ApiPropertyOptional({
    example: 'تصاویر محصول با مشخصات درج‌شده مطابقت ندارد.',
    minLength: 10,
    maxLength: 500,
    nullable: true,
    type: String,
    description: 'Required when blocking; shown to the vendor. Must be omitted or null otherwise.',
  })
  @Transform(trim)
  @ValidateIf(nullable)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  blockedReason?: string | null;

  @ApiPropertyOptional({
    description: 'Staff may unpublish any product; publishing is only possible for an unblocked product with an active variant.',
  })
  @IsOptionalNonNullable()
  @IsBoolean()
  isPublished?: boolean;
}
```

### `apps/backend/src/modules/products/dto/product-response.dto.ts`

```ts
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { VendorStatus } from '@prisma/client';
import { CategorySummaryDto } from '../../categories/dto/category-response.dto';

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

export class PriceRangeDto {
  @ApiProperty({ example: '42500000.00', description: 'Lowest selling price among the variants considered.' })
  min!: string;

  @ApiProperty({ example: '42900000.00', description: 'Highest selling price among the variants considered.' })
  max!: string;
}

export class StockSummaryDto {
  @ApiProperty({ example: 3 })
  variantCount!: number;

  @ApiProperty({ example: 2 })
  activeVariantCount!: number;

  @ApiProperty({ example: 19, description: 'On-hand units across active variants.' })
  totalStock!: number;

  @ApiProperty({ example: 1, description: 'Units reserved by open checkouts across active variants.' })
  totalReserved!: number;

  @ApiProperty({ example: 18, description: 'Sellable units: totalStock - totalReserved.' })
  totalAvailable!: number;
}

export class ColorOptionDto {
  @ApiProperty({ example: 'مشکی' })
  name!: string;

  @ApiProperty({ example: '#111827', nullable: true, type: String })
  hex!: string | null;
}

export class ImageRefDto {
  @ApiProperty({ example: '/api/v1/media/files/images/product_image/2026/09/0f2c….webp' })
  url!: string;

  @ApiProperty({ nullable: true, type: String, example: '/api/v1/media/files/images/product_image/2026/09/0f2c…_thumb.webp' })
  thumbnailUrl!: string | null;
}

export class ProductSpecificationDto {
  @ApiProperty({ example: 'حافظه', nullable: true, type: String })
  groupTitle!: string | null;

  @ApiProperty({ example: 'حافظه داخلی' })
  title!: string;

  @ApiProperty({ example: '256 گیگابایت', description: 'May contain line breaks.' })
  value!: string;
}

export class ProductMediaDto extends ImageRefDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Uploaded file this entry was created from.' })
  mediaAssetId!: string | null;

  @ApiProperty()
  isPrimary!: boolean;

  @ApiProperty({ example: 10 })
  sortOrder!: number;
}

export class ProductModerationDto {
  @ApiProperty()
  isBlockedByAdmin!: boolean;

  @ApiProperty({ nullable: true, type: String, description: 'Reason given by staff; visible to the vendor.' })
  blockedReason!: string | null;

  @ApiProperty({ nullable: true, type: Date })
  blockedAt!: Date | null;
}

// ---------------------------------------------------------------------------
// Vendor views
// ---------------------------------------------------------------------------

export class VendorVariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'SHP-A55-256-BLK' })
  sku!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ example: '42500000.00' })
  price!: string;

  @ApiProperty({ example: '45000000.00', nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ example: 5, nullable: true, type: Number, description: 'floor((compareAtPrice - price) / compareAtPrice × 100)' })
  discountPercent!: number | null;

  @ApiProperty({ example: 12 })
  stockQuantity!: number;

  @ApiProperty({ example: 1 })
  reservedQuantity!: number;

  @ApiProperty({ example: 11 })
  availableQuantity!: number;

  @ApiProperty({ nullable: true, type: Number })
  weightGrams!: number | null;

  @ApiProperty()
  isActive!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class VendorProductSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ example: '42500000.00' })
  basePrice!: string;

  @ApiProperty()
  isPublished!: boolean;

  @ApiProperty({ description: 'Published, not blocked, store approved and at least one active variant.' })
  isSellable!: boolean;

  @ApiProperty({ type: () => ProductModerationDto })
  moderation!: ProductModerationDto;

  @ApiProperty({ type: () => CategorySummaryDto })
  category!: CategorySummaryDto;

  @ApiProperty({ type: () => ImageRefDto, nullable: true })
  primaryImage!: ImageRefDto | null;

  @ApiProperty({ type: () => PriceRangeDto, nullable: true, description: 'Across active variants; null when none is active.' })
  priceRange!: PriceRangeDto | null;

  @ApiProperty({ type: () => StockSummaryDto })
  stock!: StockSummaryDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class VendorProductDetailDto extends VendorProductSummaryDto {
  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ type: () => [ProductMediaDto] })
  media!: ProductMediaDto[];

  @ApiProperty({ type: () => [VendorVariantDto], description: 'All variants, active or not.' })
  variants!: VendorVariantDto[];

  @ApiProperty({ type: () => [ProductSpecificationDto], description: 'Technical specifications in display order.' })
  specifications!: ProductSpecificationDto[];
}

export class PaginatedVendorProductsDto {
  @ApiProperty({ type: () => [VendorProductSummaryDto] })
  items!: VendorProductSummaryDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class ArchiveProductResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ example: false })
  isPublished!: boolean;

  @ApiProperty({ description: 'Whether the product was live before this call (false: the call was a no-op).' })
  wasPublished!: boolean;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Audit row, when the state changed.' })
  auditLogId!: string | null;
}

// ---------------------------------------------------------------------------
// Public views
// ---------------------------------------------------------------------------

export class PublicVendorSummaryDto {
  @ApiProperty({ example: 'فروشگاه نمونهٔ شاگردم' })
  storeName!: string;

  @ApiProperty({ example: 'shopino-sample-store' })
  storeSlug!: string;

  @ApiProperty({ nullable: true, type: String })
  logoUrl!: string | null;
}

export class PublicVendorDetailDto extends PublicVendorSummaryDto {
  @ApiProperty({ nullable: true, type: String })
  bio!: string | null;

  @ApiProperty({ nullable: true, type: String })
  instagramHandle!: string | null;

  @ApiProperty({ nullable: true, type: Date, description: 'When the store was approved.' })
  verifiedAt!: Date | null;
}

export class PublicProductListItemDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ type: () => ImageRefDto, nullable: true, description: 'Primary image (use thumbnailUrl in listings).' })
  primaryImage!: ImageRefDto | null;

  @ApiProperty({ type: () => PriceRangeDto, description: 'Across all active variants.' })
  priceRange!: PriceRangeDto;

  @ApiProperty({ nullable: true, type: Number, example: 22, description: 'Largest discount among active variants.' })
  maxDiscountPercent!: number | null;

  @ApiProperty({
    nullable: true,
    type: String,
    example: '52000000.00',
    description: 'Compare-at (strike-through) price of the cheapest active variant — the one priceRange.min comes from; null when that variant has no discount.',
  })
  startingCompareAtPrice!: string | null;

  @ApiProperty({ type: () => [ColorOptionDto] })
  colors!: ColorOptionDto[];

  @ApiProperty({ type: [String], example: ['L', 'XL'] })
  sizes!: string[];

  @ApiProperty({ description: 'At least one active variant has sellable stock.' })
  inStock!: boolean;

  @ApiProperty({ type: () => PublicVendorSummaryDto })
  vendor!: PublicVendorSummaryDto;

  @ApiProperty({ type: () => CategorySummaryDto })
  category!: CategorySummaryDto;

  @ApiProperty()
  createdAt!: Date;
}

export class PaginatedPublicProductsDto {
  @ApiProperty({ type: () => [PublicProductListItemDto] })
  items!: PublicProductListItemDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 42, description: 'Total number of matching products.' })
  total!: number;

  @ApiProperty({ example: 3 })
  totalPages!: number;
}

export class PublicVariantDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty({ nullable: true, type: String })
  colorName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  colorHex!: string | null;

  @ApiProperty({ nullable: true, type: String })
  size!: string | null;

  @ApiProperty({ nullable: true, type: String })
  guarantee!: string | null;

  @ApiProperty({ example: '42500000.00' })
  price!: string;

  @ApiProperty({ nullable: true, type: String })
  compareAtPrice!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  discountPercent!: number | null;

  @ApiProperty({ example: 11, description: 'Real-time sellable units (stock minus open reservations).' })
  availableQuantity!: number;

  @ApiProperty()
  inStock!: boolean;

  @ApiProperty({ nullable: true, type: Number })
  weightGrams!: number | null;
}

export class PublicProductDetailDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ nullable: true, type: String })
  brand!: string | null;

  @ApiProperty({ type: () => [CategorySummaryDto], description: 'Root → product category.' })
  breadcrumbs!: CategorySummaryDto[];

  @ApiProperty({ type: () => PublicVendorDetailDto })
  vendor!: PublicVendorDetailDto;

  @ApiProperty({ type: () => [ImageRefDto], description: 'Full gallery in display order; the first image is the primary one.' })
  media!: ImageRefDto[];

  @ApiProperty({ type: () => [PublicVariantDto], description: 'Active variants only.' })
  variants!: PublicVariantDto[];

  @ApiProperty({ type: () => [ProductSpecificationDto], description: 'Technical specifications in display order.' })
  specifications!: ProductSpecificationDto[];

  @ApiProperty({ type: () => PriceRangeDto })
  priceRange!: PriceRangeDto;

  @ApiProperty({ nullable: true, type: Number })
  maxDiscountPercent!: number | null;

  @ApiProperty({ type: () => [ColorOptionDto] })
  colors!: ColorOptionDto[];

  @ApiProperty({ type: [String] })
  sizes!: string[];

  @ApiProperty()
  inStock!: boolean;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

// ---------------------------------------------------------------------------
// Staff views
// ---------------------------------------------------------------------------

export class AdminProductVendorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  storeName!: string;

  @ApiProperty()
  storeSlug!: string;

  @ApiProperty({ enum: VendorStatus })
  status!: VendorStatus;
}

export class AdminProductDto extends VendorProductSummaryDto {
  @ApiProperty({ type: () => AdminProductVendorDto })
  vendor!: AdminProductVendorDto;

  @ApiProperty({ format: 'uuid', nullable: true, type: String, description: 'Staff member who blocked the product.' })
  blockedByUserId!: string | null;
}

export class PaginatedAdminProductsDto {
  @ApiProperty({ type: () => [AdminProductDto] })
  items!: AdminProductDto[];

  @ApiProperty({ example: 1 })
  page!: number;

  @ApiProperty({ example: 20 })
  pageSize!: number;

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 1 })
  totalPages!: number;
}

export class AdminProductStatusResponseDto {
  @ApiProperty({ type: () => AdminProductDto })
  product!: AdminProductDto;

  @ApiProperty({ format: 'uuid' })
  auditLogId!: string;

  @ApiPropertyOptional({ type: [String], example: ['isBlockedByAdmin', 'isPublished'], description: 'Fields that changed.' })
  changed!: string[];
}
```

### `apps/backend/src/modules/products/product-rules.spec.ts`

```ts
import {
  escapeLikePattern,
  normalizePersianParagraphs,
  normalizePersianText,
  PRODUCT_SLUG_PATTERN,
  searchTermVariants,
  slugify,
  toAsciiDigits,
  toPersianDigits,
} from './catalog-text';
import {
  discountPercent,
  duplicates,
  matrixProblems,
  normalizeSku,
  normalizeSpecifications,
  SKU_PATTERN,
  toMoney,
  variantFieldProblems,
  variantMatrixKey,
} from './product-rules';

describe('catalog text', () => {
  it('canonicalises Arabic letters, strips control characters and collapses spaces', () => {
    expect(normalizePersianText('  كتاب\u0000   علي  ')).toBe('کتاب علی');
  });

  it('keeps paragraph breaks in descriptions but trims each line', () => {
    expect(normalizePersianParagraphs('خط اول  \r\n\r\n\r\n\r\n  خط دوم ')).toBe('خط اول\n\nخط دوم');
  });

  it('converts between Persian, Arabic-Indic and ASCII digits', () => {
    expect(toAsciiDigits('۱۵ و ٢٥')).toBe('15 و 25');
    expect(toPersianDigits('256GB')).toBe('۲۵۶GB');
  });

  it('matches a search term in every digit script', () => {
    expect(searchTermVariants('آیفون ۱۵')).toEqual(['آیفون ۱۵', 'آیفون 15']);
    expect(searchTermVariants('X1 256')).toEqual(['X1 256', 'X۱ ۲۵۶']);
    expect(searchTermVariants('گوشي')).toEqual(['گوشی']);
    expect(searchTermVariants('   ')).toEqual([]);
  });

  it('escapes LIKE wildcards so input is matched literally', () => {
    expect(escapeLikePattern('100%_off\\')).toBe('100\\%\\_off\\\\');
  });

  it('slugifies Persian and Latin titles into URL-safe slugs', () => {
    expect(slugify('گوشی موبایل سامسونگ Galaxy A55 – ۲۵۶ گیگ')).toBe('گوشی-موبایل-سامسونگ-galaxy-a55-256-گیگ');
    expect(slugify('تی‌شرت نخی')).toBe('تی-شرت-نخی');
    expect(slugify('!!!')).toBe('');
    expect(PRODUCT_SLUG_PATTERN.test(slugify('کفش ورزشی Nike'))).toBe(true);
  });

  it('caps long slugs on a word boundary', () => {
    const slug = slugify(`${'کلمه '.repeat(80)}پایان`);
    expect(slug.length).toBeLessThanOrEqual(200);
    expect(slug.endsWith('-')).toBe(false);
    expect(PRODUCT_SLUG_PATTERN.test(slug)).toBe(true);
  });

  it('rejects slugs with upper case, spaces or doubled hyphens', () => {
    expect(PRODUCT_SLUG_PATTERN.test('Samsung-a55')).toBe(false);
    expect(PRODUCT_SLUG_PATTERN.test('a--b')).toBe(false);
    expect(PRODUCT_SLUG_PATTERN.test('گوشی موبایل')).toBe(false);
  });
});

describe('product rules', () => {
  it('normalises and validates SKUs', () => {
    expect(normalizeSku('  shp-x1-blk ')).toBe('SHP-X1-BLK');
    expect(SKU_PATTERN.test('SHP-X1.256_BLK')).toBe(true);
    expect(SKU_PATTERN.test('-LEADING')).toBe(false);
    expect(SKU_PATTERN.test('HAS SPACE')).toBe(false);
    expect(SKU_PATTERN.test('A'.repeat(65))).toBe(false);
  });

  it('computes the discount percent from compareAtPrice, rounded down', () => {
    expect(discountPercent('42500000', '45000000')).toBe(5); // 5.55… → 5
    expect(discountPercent(890000, 1150000)).toBe(22); // 22.6… → 22
    expect(discountPercent(100, null)).toBeNull();
    expect(discountPercent(100, 100)).toBeNull();
    expect(discountPercent(100, 90)).toBeNull();
  });

  it('converts numbers to two-decimal money without float noise', () => {
    expect(toMoney(0.1 + 0.2).toFixed(2)).toBe('0.30');
    expect(toMoney(42500000).toFixed(2)).toBe('42500000.00');
  });

  it('rejects compareAtPrice that is not strictly greater than price', () => {
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: 100 })).toEqual([
      'A: compareAtPrice (100.00) must be greater than price (100.00)',
    ]);
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: 99 })).toHaveLength(1);
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: 120 })).toEqual([]);
    expect(variantFieldProblems({ sku: 'A', price: 100, compareAtPrice: null })).toEqual([]);
  });

  it('rejects a non-positive price and a colour code without a colour name', () => {
    expect(variantFieldProblems({ sku: 'A', price: 0 })).toEqual(['A: price must be greater than 0']);
    expect(variantFieldProblems({ sku: 'A', price: 10, colorHex: '#000000' })).toEqual(['A: colorHex requires colorName']);
  });

  it('treats colour/size/guarantee cells case- and keyboard-insensitively', () => {
    expect(variantMatrixKey({ colorName: 'مشكي', size: 'xl' })).toBe(variantMatrixKey({ colorName: 'مشکی', size: 'XL' }));
    expect(variantMatrixKey({ colorName: 'مشکی', size: 'L' })).not.toBe(variantMatrixKey({ colorName: 'مشکی', size: 'XL' }));
  });

  it('reports duplicate SKUs and duplicate matrix cells in one request', () => {
    const problems = matrixProblems([
      { sku: 'A', colorName: 'سفید', size: 'L', price: 10 },
      { sku: 'A', colorName: 'سفید', size: 'XL', price: 10 },
      { sku: 'B', colorName: 'سفيد', size: 'l', price: 10 },
    ]);
    expect(problems).toEqual([
      'Duplicate SKU in request: A',
      'Two variants share the same colour/size/guarantee: سفید / l / —',
    ]);
  });

  it('lists repeated values once, in first-seen order', () => {
    expect(duplicates(['a', 'b', 'a', 'c', 'b', 'a'])).toEqual(['a', 'b']);
    expect(duplicates([])).toEqual([]);
  });
});

describe('normalizeSpecifications', () => {
  it('normalises text, keeps line breaks, numbers the order and drops blanks and exact duplicates', () => {
    expect(
      normalizeSpecifications([
        { groupTitle: ' مشخصات  كلی ', title: 'وزن', value: '188  گرم' },
        { groupTitle: null, title: 'سایر توضیحات', value: 'خط اول\r\n\r\n  خط دوم  \r\n' },
        { title: 'رنگ', value: '   ' },
        { title: '  ', value: 'x' },
        { groupTitle: 'مشخصات کلی', title: 'وزن', value: '188 گرم' },
        { groupTitle: 'مشخصات کلی', title: 'وزن', value: '190 گرم' },
      ]),
    ).toEqual([
      { groupTitle: 'مشخصات کلی', title: 'وزن', value: '188 گرم', sortOrder: 10 },
      { groupTitle: null, title: 'سایر توضیحات', value: 'خط اول\nخط دوم', sortOrder: 20 },
      { groupTitle: 'مشخصات کلی', title: 'وزن', value: '190 گرم', sortOrder: 30 },
    ]);
  });
});
```

### `apps/backend/src/modules/products/product-rules.ts`

```ts
import { Prisma } from '@prisma/client';
import { normalizePersianText } from './catalog-text';

/**
 * Business rules of the variant matrix that do not need the database. The
 * service applies them before any write; the database CHECK constraints
 * (`product_variants_price_check`, `product_variants_inventory_check`) are the
 * backstop for any path that bypasses the service.
 */

/** Upper-case letters, digits, dot, underscore and hyphen; 1–64 characters, alphanumeric at both ends. */
export const SKU_PATTERN = /^[A-Z0-9](?:[A-Z0-9._-]{0,62}[A-Z0-9])?$/;
export const COLOR_HEX_PATTERN = /^#[0-9A-F]{6}$/;

export const MAX_VARIANTS_PER_PRODUCT = 100;
export const MAX_MEDIA_PER_PRODUCT = 12;
/** Largest amount a `Decimal(15,2)` column can hold. */
export const MAX_MONEY = 9_999_999_999_999.99;
export const MAX_STOCK = 1_000_000;

/** Technical-specification limits (mirrored by the `product_specifications` columns). */
export const MAX_SPECIFICATIONS_PER_PRODUCT = 150;
export const SPECIFICATION_GROUP_MAX_LENGTH = 100;
export const SPECIFICATION_TITLE_MAX_LENGTH = 150;
export const SPECIFICATION_VALUE_MAX_LENGTH = 2000;

export interface SpecificationInput {
  groupTitle?: string | null;
  title: string;
  value: string;
}

export interface NormalizedSpecification {
  groupTitle: string | null;
  title: string;
  value: string;
  sortOrder: number;
}

/**
 * Canonical form of a specification list: Persian-normalised text (values keep
 * their line breaks), blank groups become `null`, exact duplicates (same group,
 * title and value) are dropped, and the order the vendor sent is kept through
 * `sortOrder` (steps of 10 so a later insert never needs a renumbering).
 */
export function normalizeSpecifications(list: readonly SpecificationInput[]): NormalizedSpecification[] {
  const seen = new Set<string>();
  const result: NormalizedSpecification[] = [];
  for (const entry of list) {
    const groupTitle = entry.groupTitle ? normalizePersianText(entry.groupTitle) : '';
    const title = normalizePersianText(entry.title);
    const value = entry.value
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => normalizePersianText(line))
      .filter((line) => line.length > 0)
      .join('\n');
    if (title.length === 0 || value.length === 0) {
      continue;
    }
    const key = `${groupTitle}\u0000${title}\u0000${value}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push({ groupTitle: groupTitle.length > 0 ? groupTitle : null, title, value, sortOrder: (result.length + 1) * 10 });
  }
  return result;
}

export function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

export function normalizeColorHex(value: string): string {
  return value.trim().toUpperCase();
}

/**
 * Discount shown to the buyer, rounded **down** to a whole percent so the badge
 * never promises more than the real reduction:
 * `floor((compareAtPrice - price) / compareAtPrice * 100)`.
 * `null` when there is no strike-through price or it is not above the price.
 */
export function discountPercent(
  price: Prisma.Decimal | string | number,
  compareAtPrice: Prisma.Decimal | string | number | null | undefined,
): number | null {
  if (compareAtPrice === null || compareAtPrice === undefined) {
    return null;
  }
  const selling = new Prisma.Decimal(price);
  const original = new Prisma.Decimal(compareAtPrice);
  if (original.lte(selling) || original.lte(0)) {
    return null;
  }
  return original.minus(selling).div(original).mul(100).floor().toNumber();
}

/** Converts a validated JS number to a two-decimal `Decimal` without float noise. */
export function toMoney(value: number): Prisma.Decimal {
  return new Prisma.Decimal(value.toFixed(2));
}

export interface VariantShape {
  sku: string;
  colorName?: string | null;
  colorHex?: string | null;
  size?: string | null;
  guarantee?: string | null;
  price: number | Prisma.Decimal;
  compareAtPrice?: number | Prisma.Decimal | null;
}

/**
 * Identity of a cell in the variant matrix. Two variants with the same colour,
 * size and guarantee would be indistinguishable to the buyer, so the pair is
 * rejected. Comparison is case- and keyboard-insensitive.
 */
export function variantMatrixKey(variant: Pick<VariantShape, 'colorName' | 'size' | 'guarantee'>): string {
  const part = (value: string | null | undefined): string =>
    value ? normalizePersianText(value).toLocaleLowerCase('fa') : '';
  return `${part(variant.colorName)}|${part(variant.size)}|${part(variant.guarantee)}`;
}

/** Values that occur more than once, in first-seen order. */
export function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      repeated.add(value);
    }
    seen.add(value);
  }
  return [...repeated];
}

/**
 * Human-readable problems with one variant's own fields (no cross-variant
 * checks). Empty when the variant is valid.
 */
export function variantFieldProblems(variant: VariantShape): string[] {
  const problems: string[] = [];
  const price = new Prisma.Decimal(variant.price);

  if (price.lte(0)) {
    problems.push(`${variant.sku}: price must be greater than 0`);
  }
  if (variant.compareAtPrice !== null && variant.compareAtPrice !== undefined) {
    const original = new Prisma.Decimal(variant.compareAtPrice);
    if (original.lte(price)) {
      problems.push(
        `${variant.sku}: compareAtPrice (${original.toFixed(2)}) must be greater than price (${price.toFixed(2)})`,
      );
    }
  }
  if (variant.colorHex && !variant.colorName) {
    problems.push(`${variant.sku}: colorHex requires colorName`);
  }
  return problems;
}

/**
 * Validates a whole matrix submitted in one request: field rules on every
 * variant, unique SKUs and unique colour/size/guarantee cells.
 */
export function matrixProblems(variants: readonly VariantShape[]): string[] {
  const problems = variants.flatMap((variant) => variantFieldProblems(variant));

  const repeatedSkus = duplicates(variants.map((variant) => variant.sku));
  if (repeatedSkus.length > 0) {
    problems.push(`Duplicate SKU in request: ${repeatedSkus.join(', ')}`);
  }

  const repeatedCells = duplicates(variants.map((variant) => variantMatrixKey(variant)));
  if (repeatedCells.length > 0) {
    problems.push(
      `Two variants share the same colour/size/guarantee: ${repeatedCells
        .map((key) => key.split('|').map((part) => part || '—').join(' / '))
        .join('; ')}`,
    );
  }
  return problems;
}
```

### `apps/backend/src/modules/products/product-views.ts`

```ts
import { VendorStatus, type Prisma } from '@prisma/client';
import { CategorySummaryDto } from '../categories/dto/category-response.dto';
import type {
  AdminProductDto,
  ColorOptionDto,
  ImageRefDto,
  PriceRangeDto,
  ProductMediaDto,
  PublicVariantDto,
  StockSummaryDto,
  VendorProductDetailDto,
  VendorProductSummaryDto,
  VendorVariantDto,
} from './dto/product-response.dto';
import { discountPercent } from './product-rules';

/**
 * Prisma selections and the pure mappers that turn their rows into response
 * DTOs. Keeping the `select` next to the mapper guarantees the mapper never
 * reads a field the query did not load.
 */

export const variantSelect = {
  id: true,
  sku: true,
  colorName: true,
  colorHex: true,
  size: true,
  guarantee: true,
  price: true,
  compareAtPrice: true,
  stockQuantity: true,
  reservedQuantity: true,
  weightGrams: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductVariantSelect;

export const mediaSelect = {
  id: true,
  mediaAssetId: true,
  url: true,
  thumbnailUrl: true,
  isPrimary: true,
  sortOrder: true,
} satisfies Prisma.ProductMediaSelect;

export const specificationSelect = {
  groupTitle: true,
  title: true,
  value: true,
} satisfies Prisma.ProductSpecificationSelect;

/** Display order of a product's specifications. */
export const specificationOrder = [{ sortOrder: 'asc' }, { createdAt: 'asc' }] satisfies Prisma.ProductSpecificationOrderByWithRelationInput[];

const categorySelect = { id: true, slug: true, titleFa: true, titleEn: true } satisfies Prisma.CategorySelect;

export const productSummarySelect = {
  id: true,
  slug: true,
  title: true,
  brand: true,
  basePrice: true,
  isPublished: true,
  isBlockedByAdmin: true,
  blockedReason: true,
  blockedAt: true,
  blockedByUserId: true,
  createdAt: true,
  updatedAt: true,
  category: { select: categorySelect },
  vendor: { select: { id: true, storeName: true, storeSlug: true, status: true } },
  variants: { select: variantSelect, orderBy: [{ createdAt: 'asc' }, { sku: 'asc' }] },
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], take: 1 },
} satisfies Prisma.ProductSelect;

export const productDetailSelect = {
  ...productSummarySelect,
  description: true,
  media: { select: mediaSelect, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  specifications: { select: specificationSelect, orderBy: specificationOrder },
} satisfies Prisma.ProductSelect;

export type VariantRow = Prisma.ProductVariantGetPayload<{ select: typeof variantSelect }>;
export type MediaRow = Prisma.ProductMediaGetPayload<{ select: typeof mediaSelect }>;
export type ProductSummaryRow = Prisma.ProductGetPayload<{ select: typeof productSummarySelect }>;
export type ProductDetailRow = Prisma.ProductGetPayload<{ select: typeof productDetailSelect }>;

type PricedVariant = Pick<VariantRow, 'price' | 'compareAtPrice' | 'isActive'>;
type StockedVariant = Pick<VariantRow, 'stockQuantity' | 'reservedQuantity' | 'isActive'>;
type OptionVariant = Pick<VariantRow, 'colorName' | 'colorHex' | 'size'>;

export function money(value: Prisma.Decimal): string {
  return value.toFixed(2);
}

export function priceRange(variants: readonly PricedVariant[]): PriceRangeDto | null {
  const prices = variants.filter((variant) => variant.isActive).map((variant) => variant.price);
  if (prices.length === 0) {
    return null;
  }
  const min = prices.reduce((lowest, price) => (price.lt(lowest) ? price : lowest));
  const max = prices.reduce((highest, price) => (price.gt(highest) ? price : highest));
  return { min: money(min), max: money(max) };
}

export function maxDiscountPercent(variants: readonly PricedVariant[]): number | null {
  let best: number | null = null;
  for (const variant of variants) {
    if (!variant.isActive) continue;
    const percent = discountPercent(variant.price, variant.compareAtPrice);
    if (percent !== null && (best === null || percent > best)) {
      best = percent;
    }
  }
  return best;
}

/**
 * Strike-through price that belongs to the listing's "from" price: the
 * compare-at price of the cheapest active variant, or null when that variant
 * is not discounted. (A product card shows `priceRange.min` next to it, so a
 * compare-at price of a different variant would misstate the discount.)
 */
export function startingCompareAtPrice(variants: readonly PricedVariant[]): string | null {
  let cheapest: PricedVariant | null = null;
  for (const variant of variants) {
    if (!variant.isActive) continue;
    if (cheapest === null || variant.price.lt(cheapest.price)) {
      cheapest = variant;
    }
  }
  if (cheapest === null || cheapest.compareAtPrice === null || !cheapest.compareAtPrice.greaterThan(cheapest.price)) {
    return null;
  }
  return money(cheapest.compareAtPrice);
}

export function stockSummary(variants: readonly StockedVariant[]): StockSummaryDto {
  const active = variants.filter((variant) => variant.isActive);
  const totalStock = active.reduce((sum, variant) => sum + variant.stockQuantity, 0);
  const totalReserved = active.reduce((sum, variant) => sum + variant.reservedQuantity, 0);
  return {
    variantCount: variants.length,
    activeVariantCount: active.length,
    totalStock,
    totalReserved,
    totalAvailable: totalStock - totalReserved,
  };
}

/** Distinct colours (by case-insensitive name, first hex wins) and sizes, in variant order. */
export function variantOptions(variants: readonly OptionVariant[]): { colors: ColorOptionDto[]; sizes: string[] } {
  const colors = new Map<string, ColorOptionDto>();
  const sizes = new Map<string, string>();
  for (const variant of variants) {
    if (variant.colorName) {
      const key = variant.colorName.toLocaleLowerCase('fa');
      if (!colors.has(key)) {
        colors.set(key, { name: variant.colorName, hex: variant.colorHex });
      }
    }
    if (variant.size) {
      const key = variant.size.toLocaleUpperCase('en');
      if (!sizes.has(key)) {
        sizes.set(key, variant.size);
      }
    }
  }
  return { colors: [...colors.values()], sizes: [...sizes.values()] };
}

export function imageRef(media: Pick<MediaRow, 'url' | 'thumbnailUrl'> | undefined): ImageRefDto | null {
  return media ? { url: media.url, thumbnailUrl: media.thumbnailUrl } : null;
}

export function toVendorVariant(variant: VariantRow): VendorVariantDto {
  return {
    id: variant.id,
    sku: variant.sku,
    colorName: variant.colorName,
    colorHex: variant.colorHex,
    size: variant.size,
    guarantee: variant.guarantee,
    price: money(variant.price),
    compareAtPrice: variant.compareAtPrice ? money(variant.compareAtPrice) : null,
    discountPercent: discountPercent(variant.price, variant.compareAtPrice),
    stockQuantity: variant.stockQuantity,
    reservedQuantity: variant.reservedQuantity,
    availableQuantity: variant.stockQuantity - variant.reservedQuantity,
    weightGrams: variant.weightGrams,
    isActive: variant.isActive,
    createdAt: variant.createdAt,
    updatedAt: variant.updatedAt,
  };
}

export function toPublicVariant(variant: VariantRow): PublicVariantDto {
  const available = Math.max(0, variant.stockQuantity - variant.reservedQuantity);
  return {
    id: variant.id,
    sku: variant.sku,
    colorName: variant.colorName,
    colorHex: variant.colorHex,
    size: variant.size,
    guarantee: variant.guarantee,
    price: money(variant.price),
    compareAtPrice: variant.compareAtPrice ? money(variant.compareAtPrice) : null,
    discountPercent: discountPercent(variant.price, variant.compareAtPrice),
    availableQuantity: available,
    inStock: available > 0,
    weightGrams: variant.weightGrams,
  };
}

export function toMediaDto(media: MediaRow): ProductMediaDto {
  return { ...media };
}

/** Sellable = what the storefront would list (category visibility is checked separately). */
export function isSellable(product: Pick<ProductSummaryRow, 'isPublished' | 'isBlockedByAdmin' | 'variants' | 'vendor'>): boolean {
  return (
    product.isPublished &&
    !product.isBlockedByAdmin &&
    product.vendor.status === VendorStatus.APPROVED &&
    product.variants.some((variant) => variant.isActive)
  );
}

export function toVendorSummary(product: ProductSummaryRow): VendorProductSummaryDto {
  return {
    id: product.id,
    slug: product.slug,
    title: product.title,
    brand: product.brand,
    basePrice: money(product.basePrice),
    isPublished: product.isPublished,
    isSellable: isSellable(product),
    moderation: {
      isBlockedByAdmin: product.isBlockedByAdmin,
      blockedReason: product.blockedReason,
      blockedAt: product.blockedAt,
    },
    category: CategorySummaryDto.from(product.category),
    primaryImage: imageRef(product.media[0]),
    priceRange: priceRange(product.variants),
    stock: stockSummary(product.variants),
    createdAt: product.createdAt,
    updatedAt: product.updatedAt,
  };
}

export function toVendorDetail(product: ProductDetailRow): VendorProductDetailDto {
  return {
    ...toVendorSummary(product),
    description: product.description,
    media: product.media.map((media) => toMediaDto(media)),
    variants: product.variants.map((variant) => toVendorVariant(variant)),
    specifications: product.specifications.map((row) => ({ ...row })),
  };
}

export function toAdminProduct(product: ProductSummaryRow): AdminProductDto {
  return {
    ...toVendorSummary(product),
    vendor: { ...product.vendor },
    blockedByUserId: product.blockedByUserId,
  };
}
```

### `apps/backend/src/modules/products/products.service.ts`

```ts
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, MediaKind, Prisma, VendorStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import type { RequestContext } from '../../common/types/request-context';
import { PrismaService } from '../../infra/prisma/prisma.service';
import { sanitize } from '../audit/audit-log.service';
import { CategoriesService } from '../categories/categories.service';
import { normalizePersianParagraphs, normalizePersianText, PRODUCT_SLUG_MAX_LENGTH, slugify } from './catalog-text';
import type {
  AdminProductStatusDto,
  CreateProductDto,
  CreateVariantDto,
  UpdateProductDto,
  UpdateVariantDto,
} from './dto/product-input.dto';
import type { AdminProductQueryDto, VendorProductQueryDto } from './dto/product-query.dto';
import type {
  AdminProductDto,
  AdminProductStatusResponseDto,
  ArchiveProductResponseDto,
  VendorProductDetailDto,
  VendorProductSummaryDto,
  VendorVariantDto,
} from './dto/product-response.dto';
import { InventoryService, type StockLevel } from './inventory.service';
import {
  matrixProblems,
  MAX_VARIANTS_PER_PRODUCT,
  normalizeSpecifications,
  toMoney,
  variantFieldProblems,
  variantMatrixKey,
} from './product-rules';
import {
  productDetailSelect,
  productSummarySelect,
  toAdminProduct,
  toVendorDetail,
  toVendorSummary,
  toVendorVariant,
  variantSelect,
} from './product-views';

/** Only images uploaded for this purpose can be attached to a product gallery. */
export const PRODUCT_IMAGE_PURPOSE = 'product_image';

interface ActorParams {
  actorId: string;
  context: RequestContext;
}

interface StoreRef {
  id: string;
  storeSlug: string;
  status: VendorStatus;
}

interface NormalizedVariant {
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: number;
  compareAtPrice: number | null;
  stockQuantity: number;
  weightGrams: number | null;
  isActive: boolean;
}

interface GalleryEntry {
  mediaAssetId: string;
  url: string;
  thumbnailUrl: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

type Tx = Prisma.TransactionClient;

/**
 * Vendor catalogue management and staff moderation.
 *
 * Ownership model: every vendor route resolves the caller's store from the
 * authenticated user id — never from the request — and every product/variant
 * lookup is scoped to that store. A product of another store is therefore
 * indistinguishable from a missing one (404), which also avoids leaking which
 * ids exist.
 *
 * Invariants maintained here (with database CHECK constraints as backstop):
 * - only `APPROVED` stores write; a `SUSPENDED` store can still read its catalogue;
 * - `price > 0`, `compareAtPrice > price`, SKU globally unique, one variant per
 *   colour/size/guarantee cell;
 * - a published product always has at least one active variant (publishing and
 *   deactivating are serialised per product with `SELECT … FOR UPDATE`);
 * - a product blocked by staff cannot be published by its vendor;
 * - every write records its audit row inside the same transaction.
 */
@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly inventory: InventoryService,
    private readonly categories: CategoriesService,
  ) {}

  // ===========================================================================
  // Vendor: products
  // ===========================================================================

  async create(userId: string, dto: CreateProductDto, params: ActorParams): Promise<VendorProductDetailDto> {
    const store = await this.requireStore(userId, 'write');
    await this.requireActiveCategory(dto.categoryId);

    const title = normalizePersianText(dto.title);
    const variants = dto.variants.map((variant) => normalizeVariant(variant));
    const problems = matrixProblems(variants);
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }
    if (dto.isPublished === true && !variants.some((variant) => variant.isActive)) {
      throw new BadRequestException('Publishing requires at least one active variant');
    }
    await this.assertSkusAvailable(variants.map((variant) => variant.sku));
    const gallery = await this.resolveGallery(userId, dto.mediaIds ?? []);
    const specifications = normalizeSpecifications(dto.specifications ?? []);

    const baseSlug = dto.slug ?? slugify(title);
    if (baseSlug.length === 0) {
      throw new BadRequestException('A slug cannot be derived from this title; send a custom slug');
    }
    if (dto.slug !== undefined) {
      await this.assertSlugAvailable(dto.slug);
    }

    const productData = {
      vendorId: store.id,
      categoryId: dto.categoryId,
      title,
      description: dto.description ? normalizePersianParagraphs(dto.description) : null,
      brand: dto.brand ? normalizePersianText(dto.brand) : null,
      basePrice: toMoney(dto.basePrice),
      isPublished: dto.isPublished ?? false,
    };

    // A generated slug may collide with a concurrent insert between the check
    // and the write; retry with a random suffix. A custom slug is never altered.
    for (let attempt = 0; ; attempt += 1) {
      const slug =
        dto.slug ?? (attempt === 0 ? await this.nextFreeSlug(baseSlug) : withSuffix(baseSlug, randomSuffix()));
      try {
        const productId = await this.prisma.$transaction(async (tx) => {
          const created = await tx.product.create({
            data: {
              ...productData,
              slug,
              variants: {
                create: variants.map((variant) => ({
                  ...variant,
                  price: toMoney(variant.price),
                  compareAtPrice: variant.compareAtPrice === null ? null : toMoney(variant.compareAtPrice),
                })),
              },
              media: { create: gallery },
              specifications: { create: specifications },
            },
            select: { id: true },
          });

          if (gallery.length > 0) {
            await tx.mediaAsset.updateMany({
              where: { id: { in: gallery.map((entry) => entry.mediaAssetId) }, vendorId: null },
              data: { vendorId: store.id },
            });
          }

          await this.audit(tx, {
            ...params,
            action: AuditAction.CREATE,
            entityId: created.id,
            newValue: {
              slug,
              title,
              categoryId: dto.categoryId,
              basePrice: productData.basePrice.toFixed(2),
              isPublished: productData.isPublished,
              skus: variants.map((variant) => variant.sku),
              mediaIds: gallery.map((entry) => entry.mediaAssetId),
              specificationCount: specifications.length,
            },
          });
          return created.id;
        });

        this.logger.log(`Product ${productId} (${slug}) created by store ${store.storeSlug}`);
        await this.categories.invalidateTree();
        return this.requireOwnDetail(store.id, productId);
      } catch (error) {
        const target = uniqueViolationTarget(error);
        if (target === 'sku') {
          throw new ConflictException('One of the SKUs was taken by another product in the meantime; retry with unique SKUs');
        }
        if (target === 'slug') {
          if (dto.slug !== undefined) {
            throw new ConflictException(`Slug "${dto.slug}" is already taken`);
          }
          if (attempt < 3) {
            continue;
          }
        }
        throw translateCheckViolation(error);
      }
    }
  }

  async listOwn(userId: string, query: VendorProductQueryDto): Promise<{ rows: VendorProductSummaryDto[]; total: number }> {
    const store = await this.requireStore(userId, 'read');
    const where: Prisma.ProductWhereInput = {
      vendorId: store.id,
      ...statusFilter(query.status),
      ...searchFilter(query.search),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: productSummarySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { rows: rows.map((row) => toVendorSummary(row)), total };
  }

  async getOwn(userId: string, productId: string): Promise<VendorProductDetailDto> {
    const store = await this.requireStore(userId, 'read');
    return this.requireOwnDetail(store.id, productId);
  }

  async update(
    userId: string,
    productId: string,
    dto: UpdateProductDto,
    params: ActorParams,
  ): Promise<VendorProductDetailDto> {
    assertNotEmpty(dto);
    const store = await this.requireStore(userId, 'write');
    const current = await this.requireOwnProduct(store.id, productId);

    if (dto.categoryId !== undefined && dto.categoryId !== current.categoryId) {
      await this.requireActiveCategory(dto.categoryId);
    }
    if (dto.slug !== undefined && dto.slug !== current.slug) {
      await this.assertSlugAvailable(dto.slug);
    }
    if (dto.isPublished === true && current.isBlockedByAdmin) {
      throw new ForbiddenException(
        `This product is blocked by staff and cannot be published${current.blockedReason ? `: ${current.blockedReason}` : ''}`,
      );
    }
    const gallery = dto.mediaIds !== undefined ? await this.resolveGallery(userId, dto.mediaIds) : undefined;
    const specifications = dto.specifications !== undefined ? normalizeSpecifications(dto.specifications) : undefined;

    const data: Prisma.ProductUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const change = (key: keyof Prisma.ProductUncheckedUpdateInput, previous: unknown, next: unknown, stored: unknown = next): void => {
      (data as Record<string, unknown>)[key] = stored;
      before[key] = previous;
      after[key] = next;
    };

    if (dto.title !== undefined) change('title', current.title, normalizePersianText(dto.title));
    if (dto.slug !== undefined) change('slug', current.slug, dto.slug);
    if (dto.description !== undefined)
      change('description', current.description, dto.description === null ? null : normalizePersianParagraphs(dto.description));
    if (dto.categoryId !== undefined) change('categoryId', current.categoryId, dto.categoryId);
    if (dto.brand !== undefined) change('brand', current.brand, dto.brand === null ? null : normalizePersianText(dto.brand));
    if (dto.basePrice !== undefined) {
      const basePrice = toMoney(dto.basePrice);
      change('basePrice', current.basePrice.toFixed(2), basePrice.toFixed(2), basePrice);
    }
    if (dto.isPublished !== undefined) change('isPublished', current.isPublished, dto.isPublished);

    try {
      await this.prisma.$transaction(async (tx) => {
        await lockProduct(tx, productId);

        if (dto.isPublished === true) {
          const locked = await tx.product.findUniqueOrThrow({
            where: { id: productId },
            select: { isBlockedByAdmin: true, _count: { select: { variants: { where: { isActive: true } } } } },
          });
          if (locked.isBlockedByAdmin) {
            throw new ForbiddenException('This product is blocked by staff and cannot be published');
          }
          if (locked._count.variants === 0) {
            throw new ConflictException('Publishing requires at least one active variant');
          }
        }

        await tx.product.update({ where: { id: productId }, data, select: { id: true } });

        if (gallery !== undefined) {
          before.mediaIds = current.media.map((media) => media.mediaAssetId);
          after.mediaIds = gallery.map((entry) => entry.mediaAssetId);
          await tx.productMedia.deleteMany({ where: { productId } });
          if (gallery.length > 0) {
            await tx.productMedia.createMany({ data: gallery.map((entry) => ({ ...entry, productId })) });
            await tx.mediaAsset.updateMany({
              where: { id: { in: gallery.map((entry) => entry.mediaAssetId) }, vendorId: null },
              data: { vendorId: store.id },
            });
          }
        }

        if (specifications !== undefined) {
          before.specificationCount = await tx.productSpecification.count({ where: { productId } });
          after.specificationCount = specifications.length;
          await tx.productSpecification.deleteMany({ where: { productId } });
          if (specifications.length > 0) {
            await tx.productSpecification.createMany({ data: specifications.map((row) => ({ ...row, productId })) });
          }
        }

        await this.audit(tx, { ...params, action: AuditAction.UPDATE, entityId: productId, oldValue: before, newValue: after });
      });
    } catch (error) {
      if (uniqueViolationTarget(error) === 'slug') {
        throw new ConflictException(`Slug "${dto.slug ?? ''}" is already taken`);
      }
      throw translateCheckViolation(error);
    }

    await this.categories.invalidateTree();
    return this.requireOwnDetail(store.id, productId);
  }

  /** Archives a product: it is unpublished and leaves the storefront; data and history are kept. */
  async archive(userId: string, productId: string, params: ActorParams): Promise<ArchiveProductResponseDto> {
    const store = await this.requireStore(userId, 'write');
    const current = await this.requireOwnProduct(store.id, productId);

    if (!current.isPublished) {
      return { id: current.id, slug: current.slug, isPublished: false, wasPublished: false, auditLogId: null };
    }

    const auditLogId = await this.prisma.$transaction(async (tx) => {
      await tx.product.update({ where: { id: productId }, data: { isPublished: false }, select: { id: true } });
      return this.audit(tx, {
        ...params,
        action: AuditAction.STATUS_CHANGE,
        entityId: productId,
        oldValue: { isPublished: true },
        newValue: { isPublished: false, reason: 'archived by vendor' },
      });
    });

    await this.categories.invalidateTree();
    return { id: current.id, slug: current.slug, isPublished: false, wasPublished: true, auditLogId };
  }

  // ===========================================================================
  // Vendor: variants
  // ===========================================================================

  async addVariant(userId: string, productId: string, dto: CreateVariantDto, params: ActorParams): Promise<VendorVariantDto> {
    const store = await this.requireStore(userId, 'write');
    await this.requireOwnProduct(store.id, productId);

    const variant = normalizeVariant(dto);
    const problems = variantFieldProblems(variant);
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }
    await this.assertSkusAvailable([variant.sku]);

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await lockProduct(tx, productId);
        const siblings = await tx.productVariant.findMany({
          where: { productId },
          select: { colorName: true, size: true, guarantee: true },
        });
        if (siblings.length >= MAX_VARIANTS_PER_PRODUCT) {
          throw new ConflictException(`A product can have at most ${MAX_VARIANTS_PER_PRODUCT} variants`);
        }
        const key = variantMatrixKey(variant);
        if (siblings.some((sibling) => variantMatrixKey(sibling) === key)) {
          throw new ConflictException('A variant with the same colour, size and guarantee already exists on this product');
        }

        const row = await tx.productVariant.create({
          data: {
            ...variant,
            productId,
            price: toMoney(variant.price),
            compareAtPrice: variant.compareAtPrice === null ? null : toMoney(variant.compareAtPrice),
          },
          select: variantSelect,
        });
        await this.audit(tx, {
          ...params,
          action: AuditAction.CREATE,
          entityName: 'ProductVariant',
          entityId: row.id,
          newValue: { productId, ...variant },
        });
        return row;
      });

      await this.categories.invalidateTree();
      return toVendorVariant(created);
    } catch (error) {
      if (uniqueViolationTarget(error) === 'sku') {
        throw new ConflictException(`SKU ${variant.sku} is already used by another variant`);
      }
      throw translateCheckViolation(error);
    }
  }

  async updateVariant(
    userId: string,
    variantId: string,
    dto: UpdateVariantDto,
    params: ActorParams,
  ): Promise<VendorVariantDto> {
    assertNotEmpty(dto);
    if (dto.stockQuantity !== undefined && dto.stockDelta !== undefined) {
      throw new BadRequestException('Send either stockQuantity (absolute) or stockDelta (relative), not both');
    }

    const store = await this.requireStore(userId, 'write');
    const current = await this.prisma.productVariant.findFirst({
      where: { id: variantId, product: { vendorId: store.id } },
      select: { ...variantSelect, productId: true },
    });
    if (!current) {
      throw new NotFoundException('Variant not found');
    }

    const nextPrice = dto.price ?? current.price.toNumber();
    const nextCompareAt =
      dto.compareAtPrice !== undefined ? dto.compareAtPrice : (current.compareAtPrice?.toNumber() ?? null);
    const problems = variantFieldProblems({ sku: current.sku, price: nextPrice, compareAtPrice: nextCompareAt });
    if (problems.length > 0) {
      throw new BadRequestException(problems);
    }

    const scalar: Prisma.ProductVariantUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    if (dto.price !== undefined) {
      scalar.price = toMoney(dto.price);
      before.price = current.price.toFixed(2);
      after.price = toMoney(dto.price).toFixed(2);
    }
    if (dto.compareAtPrice !== undefined) {
      scalar.compareAtPrice = dto.compareAtPrice === null ? null : toMoney(dto.compareAtPrice);
      before.compareAtPrice = current.compareAtPrice?.toFixed(2) ?? null;
      after.compareAtPrice = dto.compareAtPrice === null ? null : toMoney(dto.compareAtPrice).toFixed(2);
    }
    if (dto.isActive !== undefined) {
      scalar.isActive = dto.isActive;
      before.isActive = current.isActive;
      after.isActive = dto.isActive;
    }

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await lockProduct(tx, current.productId);

        if (dto.isActive === false && current.isActive) {
          const product = await tx.product.findUniqueOrThrow({
            where: { id: current.productId },
            select: {
              isPublished: true,
              _count: { select: { variants: { where: { isActive: true, id: { not: variantId } } } } },
            },
          });
          if (product.isPublished && product._count.variants === 0) {
            throw new ConflictException(
              'This is the last active variant of a published product; unpublish the product first or activate another variant',
            );
          }
        }

        if (Object.keys(scalar).length > 0) {
          await tx.productVariant.update({ where: { id: variantId }, data: scalar, select: { id: true } });
        }

        let level: StockLevel | undefined;
        if (dto.stockQuantity !== undefined) {
          level = await this.inventory.setStock(variantId, dto.stockQuantity, tx);
        } else if (dto.stockDelta !== undefined) {
          level = await this.inventory.adjustStock(variantId, dto.stockDelta, tx);
        }
        if (level) {
          before.stockQuantity = current.stockQuantity;
          after.stockQuantity = level.stockQuantity;
          if (dto.stockDelta !== undefined) after.stockDelta = dto.stockDelta;
        }

        await this.audit(tx, {
          ...params,
          action: AuditAction.UPDATE,
          entityName: 'ProductVariant',
          entityId: variantId,
          oldValue: before,
          newValue: after,
        });
        return tx.productVariant.findUniqueOrThrow({ where: { id: variantId }, select: variantSelect });
      });

      await this.categories.invalidateTree();
      return toVendorVariant(updated);
    } catch (error) {
      throw translateCheckViolation(error);
    }
  }

  // ===========================================================================
  // Staff
  // ===========================================================================

  async listForAdmin(query: AdminProductQueryDto): Promise<{ rows: AdminProductDto[]; total: number }> {
    const where: Prisma.ProductWhereInput = {
      ...searchFilter(query.search),
      ...(query.vendorSlug !== undefined ? { vendor: { storeSlug: query.vendorSlug.trim().toLowerCase() } } : {}),
      ...(query.isBlockedByAdmin !== undefined ? { isBlockedByAdmin: query.isBlockedByAdmin } : {}),
      ...(query.isPublished !== undefined ? { isPublished: query.isPublished } : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.product.findMany({
        where,
        select: productSummarySelect,
        orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { rows: rows.map((row) => toAdminProduct(row)), total };
  }

  async setStatus(productId: string, dto: AdminProductStatusDto, params: ActorParams): Promise<AdminProductStatusResponseDto> {
    if (dto.isBlockedByAdmin === undefined && dto.isPublished === undefined) {
      throw new BadRequestException('Send isBlockedByAdmin and/or isPublished');
    }
    if (dto.isBlockedByAdmin === true && !dto.blockedReason) {
      throw new BadRequestException('blockedReason is required when blocking a product');
    }
    if (dto.isBlockedByAdmin !== true && dto.blockedReason) {
      throw new BadRequestException('blockedReason is only accepted together with isBlockedByAdmin: true');
    }

    const { auditLogId, changed } = await this.prisma.$transaction(async (tx) => {
      await lockProduct(tx, productId);
      const current = await tx.product.findUnique({
        where: { id: productId },
        select: {
          isPublished: true,
          isBlockedByAdmin: true,
          blockedReason: true,
          blockedAt: true,
          vendor: { select: { status: true } },
          _count: { select: { variants: { where: { isActive: true } } } },
        },
      });
      if (!current) {
        throw new NotFoundException('Product not found');
      }

      const data: Prisma.ProductUncheckedUpdateInput = {};
      const willBeBlocked = dto.isBlockedByAdmin ?? current.isBlockedByAdmin;

      if (dto.isBlockedByAdmin === true) {
        // Blocking also unpublishes, so lifting the block later never makes the
        // product reappear without the vendor deciding to publish it again.
        Object.assign(data, {
          isBlockedByAdmin: true,
          blockedReason: dto.blockedReason,
          blockedAt: new Date(),
          blockedByUserId: params.actorId,
          isPublished: false,
        });
      } else if (dto.isBlockedByAdmin === false) {
        Object.assign(data, { isBlockedByAdmin: false, blockedReason: null, blockedAt: null, blockedByUserId: null });
      }

      if (dto.isPublished === true) {
        if (willBeBlocked) {
          throw new ConflictException('A blocked product cannot be published; lift the block first');
        }
        if (current.vendor.status !== VendorStatus.APPROVED) {
          throw new ConflictException(`The store is ${current.vendor.status}; only products of APPROVED stores can be published`);
        }
        if (current._count.variants === 0) {
          throw new ConflictException('Publishing requires at least one active variant');
        }
        data.isPublished = true;
      } else if (dto.isPublished === false) {
        data.isPublished = false;
      }

      const before = {
        isPublished: current.isPublished,
        isBlockedByAdmin: current.isBlockedByAdmin,
        blockedReason: current.blockedReason,
      };
      const after = {
        isPublished: (data.isPublished as boolean | undefined) ?? current.isPublished,
        isBlockedByAdmin: (data.isBlockedByAdmin as boolean | undefined) ?? current.isBlockedByAdmin,
        blockedReason: data.blockedReason !== undefined ? (data.blockedReason as string | null) : current.blockedReason,
      };
      const changedKeys = (Object.keys(after) as Array<keyof typeof after>).filter((key) => after[key] !== before[key]);

      await tx.product.update({ where: { id: productId }, data, select: { id: true } });
      const auditId = await this.audit(tx, {
        ...params,
        action: AuditAction.STATUS_CHANGE,
        entityId: productId,
        oldValue: before,
        newValue: { ...after, changed: changedKeys, by: 'staff' },
      });
      return { auditLogId: auditId, changed: changedKeys };
    });

    this.logger.log(`Product ${productId} moderated by ${params.actorId}: ${changed.join(', ') || 'no change'}`);
    await this.categories.invalidateTree();

    const product = await this.prisma.product.findUniqueOrThrow({ where: { id: productId }, select: productSummarySelect });
    return { product: toAdminProduct(product), auditLogId, changed };
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  /**
   * The caller's store. Reads are allowed for APPROVED and SUSPENDED stores (a
   * suspended vendor may still see what it sells); writes only for APPROVED.
   */
  private async requireStore(userId: string, mode: 'read' | 'write'): Promise<StoreRef> {
    const store = await this.prisma.vendor.findUnique({
      where: { userId },
      select: { id: true, storeSlug: true, status: true },
    });
    if (!store) {
      throw new ForbiddenException('This account has no store; register one with POST /vendors/register');
    }
    const allowed =
      store.status === VendorStatus.APPROVED || (mode === 'read' && store.status === VendorStatus.SUSPENDED);
    if (!allowed) {
      throw new ForbiddenException(
        `The store is ${store.status}; only APPROVED stores can ${mode === 'write' ? 'manage' : 'view'} products`,
      );
    }
    return store;
  }

  private async requireOwnProduct(
    vendorId: string,
    productId: string,
  ): Promise<
    Prisma.ProductGetPayload<{ include: { media: { select: { mediaAssetId: true } } } }>
  > {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, vendorId },
      include: { media: { select: { mediaAssetId: true }, orderBy: { sortOrder: 'asc' } } },
    });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  private async requireOwnDetail(vendorId: string, productId: string): Promise<VendorProductDetailDto> {
    const product = await this.prisma.product.findFirst({ where: { id: productId, vendorId }, select: productDetailSelect });
    if (!product) {
      throw new NotFoundException('Product not found');
    }
    return toVendorDetail(product);
  }

  private async requireActiveCategory(categoryId: string): Promise<void> {
    const category = await this.prisma.category.findUnique({ where: { id: categoryId }, select: { isActive: true } });
    if (!category || !category.isActive) {
      throw new BadRequestException('categoryId does not reference an active category');
    }
  }

  private async assertSkusAvailable(skus: string[]): Promise<void> {
    const taken = await this.prisma.productVariant.findMany({ where: { sku: { in: skus } }, select: { sku: true } });
    if (taken.length > 0) {
      throw new ConflictException(`SKU already in use: ${taken.map((row) => row.sku).sort().join(', ')}`);
    }
  }

  private async assertSlugAvailable(slug: string): Promise<void> {
    const taken = await this.prisma.product.findUnique({ where: { slug }, select: { id: true } });
    if (taken) {
      throw new ConflictException(`Slug "${slug}" is already taken`);
    }
  }

  /** `base`, or `base-2`, `base-3`… — the first one not taken. */
  private async nextFreeSlug(base: string): Promise<string> {
    const rows = await this.prisma.product.findMany({
      where: { slug: { startsWith: base } },
      select: { slug: true },
    });
    const taken = new Set(rows.map((row) => row.slug));
    if (!taken.has(base)) {
      return base;
    }
    for (let n = 2; n < 1000; n += 1) {
      const candidate = withSuffix(base, String(n));
      if (!taken.has(candidate)) {
        return candidate;
      }
    }
    return withSuffix(base, randomSuffix());
  }

  /**
   * Resolves an ordered list of media ids into gallery rows. Each id must be a
   * public image uploaded by the caller with purpose `product_image`; anything
   * else (another user's file, a KYC document, a store logo) is refused.
   */
  private async resolveGallery(ownerUserId: string, mediaIds: string[]): Promise<GalleryEntry[]> {
    if (mediaIds.length === 0) {
      return [];
    }
    const assets = await this.prisma.mediaAsset.findMany({
      where: { id: { in: mediaIds } },
      select: { id: true, ownerUserId: true, kind: true, purpose: true, isPublic: true, url: true, thumbnailUrl: true },
    });
    const byId = new Map(assets.map((asset) => [asset.id, asset]));
    const unusable = mediaIds.filter((id) => {
      const asset = byId.get(id);
      return (
        !asset ||
        asset.ownerUserId !== ownerUserId ||
        asset.kind !== MediaKind.IMAGE ||
        !asset.isPublic ||
        asset.purpose !== PRODUCT_IMAGE_PURPOSE
      );
    });
    if (unusable.length > 0) {
      throw new BadRequestException(
        `mediaIds must be images uploaded by this account with purpose "${PRODUCT_IMAGE_PURPOSE}": ${unusable.join(', ')}`,
      );
    }
    return mediaIds.map((id, index) => {
      const asset = byId.get(id) as NonNullable<ReturnType<typeof byId.get>>;
      return {
        mediaAssetId: asset.id,
        url: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
        isPrimary: index === 0,
        sortOrder: (index + 1) * 10,
      };
    });
  }

  private async audit(
    tx: Tx,
    entry: ActorParams & {
      action: AuditAction;
      entityId: string;
      entityName?: string;
      oldValue?: Record<string, unknown>;
      newValue: Record<string, unknown>;
    },
  ): Promise<string> {
    const row = await tx.auditLog.create({
      data: {
        userId: entry.actorId,
        action: entry.action,
        entityName: entry.entityName ?? 'Product',
        entityId: entry.entityId,
        ipAddress: entry.context.ipAddress,
        userAgent: entry.context.userAgent,
        ...(entry.oldValue !== undefined ? { oldValue: sanitize(entry.oldValue) as Prisma.InputJsonValue } : {}),
        newValue: sanitize(entry.newValue) as Prisma.InputJsonValue,
      },
      select: { id: true },
    });
    return row.id;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function normalizeVariant(dto: CreateVariantDto): NormalizedVariant {
  const text = (value: string | null | undefined): string | null =>
    value === null || value === undefined ? null : normalizePersianText(value) || null;
  return {
    sku: dto.sku,
    colorName: text(dto.colorName),
    colorHex: dto.colorHex ?? null,
    size: text(dto.size),
    guarantee: text(dto.guarantee),
    price: dto.price,
    compareAtPrice: dto.compareAtPrice ?? null,
    stockQuantity: dto.stockQuantity,
    weightGrams: dto.weightGrams ?? null,
    isActive: dto.isActive ?? true,
  };
}

/** Row-locks a product for the rest of the transaction (serialises publish/deactivate races). */
async function lockProduct(tx: Tx, productId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT id FROM products WHERE id = ${productId}::uuid FOR UPDATE`,
  );
  if (rows.length === 0) {
    throw new NotFoundException('Product not found');
  }
}

function assertNotEmpty(dto: object): void {
  if (!Object.values(dto).some((value) => value !== undefined)) {
    throw new BadRequestException('Send at least one field to update');
  }
}

function statusFilter(status: VendorProductQueryDto['status']): Prisma.ProductWhereInput {
  switch (status) {
    case 'published':
      return { isPublished: true, isBlockedByAdmin: false };
    case 'draft':
      return { isPublished: false, isBlockedByAdmin: false };
    case 'blocked':
      return { isBlockedByAdmin: true };
    default:
      return {};
  }
}

function searchFilter(search: string | undefined): Prisma.ProductWhereInput {
  const term = search === undefined ? '' : normalizePersianText(search);
  if (term.length === 0) {
    return {};
  }
  return {
    OR: [
      { title: { contains: term, mode: 'insensitive' } },
      { slug: { contains: term.toLowerCase() } },
      { variants: { some: { sku: { contains: term.toUpperCase() } } } },
    ],
  };
}

function withSuffix(base: string, suffix: string): string {
  const room = PRODUCT_SLUG_MAX_LENGTH - suffix.length - 1;
  return `${base.slice(0, room).replace(/-+$/, '')}-${suffix}`;
}

function randomSuffix(): string {
  return randomBytes(3).toString('hex');
}

/** `'sku' | 'slug' | null` for a unique-constraint violation on products/variants. */
function uniqueViolationTarget(error: unknown): 'sku' | 'slug' | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return null;
  }
  const target: unknown = error.meta?.target;
  const fields = Array.isArray(target) ? target.filter((item): item is string => typeof item === 'string') : typeof target === 'string' ? [target] : [];
  if (fields.some((field) => field.includes('sku'))) return 'sku';
  if (fields.some((field) => field.includes('slug'))) return 'slug';
  return null;
}

/** A CHECK constraint fired (a path the service did not pre-validate): report it as a 400. */
function translateCheckViolation(error: unknown): unknown {
  const message = error instanceof Error ? error.message : '';
  if (message.includes('23514') || message.includes('violates check constraint')) {
    const constraint = /constraint "([^"]+)"/.exec(message)?.[1];
    return new BadRequestException(
      `The change violates a catalogue invariant${constraint ? ` (${constraint})` : ''}: price must be > 0, ` +
        'compareAtPrice > price, and 0 <= reserved <= stock',
    );
  }
  return error;
}
```

### `apps/backend/src/setup/app.setup.ts`

```ts
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import multipart from '@fastify/multipart';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from '@nestjs/swagger';
import { GLOBAL_API_PREFIX, SWAGGER_JSON_PATH, SWAGGER_PATH } from '../common/constants';
import { buildCorsOptions } from '../config/cors.config';

/**
 * Applies the HTTP contract of the API: URL prefix, CORS policy and request
 * validation. Called from `main.ts` and from the end-to-end tests so both run
 * the exact same configuration.
 */
export function applyGlobalPolicies(app: INestApplication, config: ConfigService): void {
  app.setGlobalPrefix(GLOBAL_API_PREFIX);
  app.enableCors(buildCorsOptions(config));
  registerMultipart(app, config);

  app.useGlobalPipes(
    new ValidationPipe({
      // Strip properties that carry no decorator, and reject the request when
      // unknown properties are present: clients get a loud error instead of
      // silently ignored input.
      whitelist: true,
      forbidNonWhitelisted: true,
      // Convert plain payloads into DTO instances so decorators transform values.
      transform: true,
      validateCustomDecorators: true,
    }),
  );
}

/**
 * Registers `@fastify/multipart` so `POST /media/upload/*` can accept
 * `multipart/form-data`.
 *
 * The limits here are the transport-level guard: a request body larger than the
 * document ceiling is aborted while it is still being received, so an oversized
 * upload never consumes memory in the application. The media service applies the
 * stricter per-kind limits (5 MB images / 10 MB documents) afterwards, because at
 * this level the kind is not yet known.
 *
 * `files: 1` is deliberate — one file per request. A batch endpoint, if it is
 * ever needed, should be its own route with its own accounting.
 */
export function registerMultipart(app: INestApplication, config: ConfigService): void {
  const maxDocumentBytes = config.get<number>('MEDIA_MAX_DOCUMENT_BYTES') ?? 10_485_760;
  // `register` lives on the Fastify adapter; the app is always created with it.
  const fastifyApp = app as NestFastifyApplication;
  // `@fastify/multipart` types its plugin against its own copy of `fastify`, which
  // TypeScript treats as a distinct module instance from the one the Nest adapter
  // ships. The runtime contract is the standard Fastify plugin signature, so the
  // cast is a version-drift workaround, not a behaviour change.
  const plugin = multipart as unknown as Parameters<NestFastifyApplication['register']>[0];

  void fastifyApp.register(plugin, {
    limits: {
      fileSize: maxDocumentBytes,
      files: 1,
      fields: 10,
      fieldNameSize: 100,
      fieldSize: 4_096,
    },
    // Streams are not thrown away silently: the media service reads the whole
    // buffer and decides, so a truncated file fails magic-byte detection.
    throwFileSizeLimit: true,
  });
}

/**
 * Builds the OpenAPI document from the registered controllers. Kept separate
 * from {@link setupSwagger} because generating the document is pure routing
 * metadata, while serving the UI needs the Fastify static-assets plugin. Tests
 * assert the contract in-process without pulling in the plugin.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle('Shagerdam (شاگردم) API')
      .setDescription(
        'Multi-vendor marketplace with banking credit (BNPL). Every endpoint is namespaced under /api/v1.\n\n' +
          '**Authentication:** the two anonymous entry points are `POST /api/v1/auth/otp/request` and ' +
          '`POST /api/v1/auth/login/password`, both of which return an access token (15 minutes) and a ' +
          'rotating refresh token (7 days). Send the access token as `Authorization: Bearer <token>`; ' +
          'every other endpoint rejects requests without it.',
      )
      .setVersion('1.0.0')
      .addBearerAuth(
        {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Access token issued by /api/v1/auth/otp/verify or /api/v1/auth/login/password',
        },
        'access-token',
      )
      .addTag('auth', 'Authentication, sessions and self-service profile')
      .addTag('admin-users', 'Staff-only identity lookup and search')
      .addTag('admin-audit', 'Immutable audit trail (admins only)')
      .addTag('media', 'File uploads: images are converted to WebP, documents stay private')
      .addTag('vendors', 'Store onboarding, KYC submission and storefront profile')
      .addTag('admin-vendors', 'Store review: listing, full detail and the verification decision')
      .addTag('categories', 'Public category tree and category pages with breadcrumbs')
      .addTag('admin-categories', 'Category management and commission rates (admins only)')
      .addTag('products', 'Public catalogue search, filtering and product pages')
      .addTag('vendor-products', "A vendor's own products, variant matrix and stock")
      .addTag('admin-products', 'Staff product review and moderation')
      .addTag('customer-addresses', "A customer's address book (copied into orders at checkout)")
      .addTag('cart', 'Guest and account cart, grouped by store, with live stock and price checks')
      .addTag('orders', 'Checkout: one order, one package per store, stock reserved in one transaction')
      .addTag('customer-orders', "A customer's orders, tracking and cancellation of unpaid orders")
      .addTag('vendor-orders', "A store's paid packages and fulfilment status")
      .addTag('admin-orders', 'Staff order search and forced package resolutions')
      .addTag('payments', 'Card payment (IPG): initiate a payment and the public bank callback')
      .addTag('sandbox-payments', 'DEVELOPMENT ONLY — simulated bank page of the sandbox gateway (404 unless PAYMENT_GATEWAY_PROVIDER=sandbox)')
      .addTag('vendor-wallet', "A store's escrow wallet, ledger and settlement (payout) requests")
      .addTag('admin-settlements', 'Finance: review and pay out vendor settlement requests')
      .addTag('admin-financial', 'Finance: platform GMV, commission, escrow and settlement overview')
      .addTag('credit', 'Credit engine (BNPL): apply for a credit line, my credit account, instalment plans on offer')
      .addTag('credit-payments', 'Pay an order with bank credit (BANK_CREDIT) or credit + card (HYBRID)')
      .addTag('credit-installments', 'My instalments grouped by order, and paying an instalment by card')
      .addTag('admin-credit', 'Finance: credit applications, credit accounts and the aggregated credit exposure')
      .addTag('customer-disputes', 'Disputes: open a dispute about a package (escrow is frozen), follow it, cancel it')
      .addTag('vendor-disputes', 'Disputes against my store: read the complaint and evidence, accept the return or defend')
      .addTag('admin-disputes', 'Trust & Safety: dispute dossiers and arbitration with automatic financial resolution')
      .build(),
  );
}

/**
 * Publishes the OpenAPI document. The UI is served at `/api/docs` and the raw
 * document at `/api/docs-json`; neither is affected by the global API prefix.
 */
export function setupSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);

  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    jsonDocumentUrl: SWAGGER_JSON_PATH,
    customSiteTitle: 'Shagerdam API',
    swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
  });

  return document;
}
```

### `apps/backend/test/fixtures/importer/README.md`

```md
# Importer fixtures

Offline inputs for the product importer's unit and E2E tests.

| File | Origin |
| --- | --- |
| `digikala-dkp-13196935.json` | Response of `GET https://api.digikala.com/v2/product/13196935/` captured 2026-09-28, trimmed to the fields the parser reads (long review texts shortened to their first sentence). Values, including trailing spaces, `\r\n` and the Arabic «ك» in «امكان», are verbatim. |
| `digikala-dkp-18010600.json` | Response of `GET https://api.digikala.com/v2/product/18010600/` (Galaxy S24 Ultra) captured 2026-09-28, trimmed. Titles, gallery and specification values are verbatim; only a subset of the specification groups is kept. The response's `category`/`brand` objects were not captured in full and are rebuilt from its `data_layer` (`item_category3`, `brand`). The group title «ارتباطات» of the second group was not captured and is assumed. The description combines two verbatim fragments of the expert review, including its `&zwnj;` entity. |
| `woocommerce-product.html` | Markup of a WooCommerce 8.x single-product page (Yoast `@graph` JSON-LD, gallery with `data-large_image`, `table.woocommerce-product-attributes`) with an invented product. |
| `shopify-product.html` | Shopify `ProductGroup` JSON-LD with `hasVariant` and `width=` resized CDN images. |
| `microdata-product.html` | A product described only with schema.org microdata (`itemscope`/`itemprop`). |

Digikala cannot be reached from the CI network, so these captures stand in for live responses.
```

### `apps/backend/test/fixtures/importer/digikala-dkp-13196935.json`

```json
{"status":200,"data":{"product":{"id":13196935,"title_fa":"\u0628\u0631\u0686\u0633\u0628 \u067e\u0648\u0634\u0634\u06cc \u0645\u0627\u0647\u0648\u062a \u0645\u062f\u0644 Iran Tile 11 \u0645\u0646\u0627\u0633\u0628 \u0628\u0631\u0627\u06cc \u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644 \u0647\u0648\u0622\u0648\u06cc Y5 Lite","title_en":"MAHOOT Iran Tile 11 Cover Sticker for Huawei Y5 Lite","url":{"base":null,"uri":"\/product\/dkp-13196935\/\u0628\u0631\u0686\u0633\u0628-\u067e\u0648\u0634\u0634\u06cc-\u0645\u0627\u0647\u0648\u062a-\u0645\u062f\u0644-iran-tile-11-\u0645\u0646\u0627\u0633\u0628-\u0628\u0631\u0627\u06cc-\u06af\u0648\u0634\u06cc-\u0645\u0648\u0628\u0627\u06cc\u0644-\u0647\u0648\u0627\u0648\u06cc-y5-lite"},"status":"marketable","images":{"main":{"storage_ids":[],"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/47ed1a2e4cc50360e929b6e8a1ca3f0696d69be8_1698777217.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"],"thumbnail_url":null,"temporary_id":null,"webp_url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/47ed1a2e4cc50360e929b6e8a1ca3f0696d69be8_1698777217.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/format,webp\/quality,q_90"]},"list":[{"storage_ids":[],"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/47ed1a2e4cc50360e929b6e8a1ca3f0696d69be8_1698777217.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"storage_ids":[],"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/c12f7a31bc4120ac140cbc4ea7af7feb153fe23c_1698777218.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"storage_ids":[],"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/2a77338a8ae4b75f5f1c8c33e697290058d69fb7_1698777219.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"storage_ids":[],"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/fb5a186a8e1ab7e1f76f9fae3eec7ba17c0541e6_1698777218.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]}]},"category":{"id":77,"title_fa":"\u06a9\u06cc\u0641 \u0648 \u06a9\u0627\u0648\u0631 \u06af\u0648\u0634\u06cc","title_en":"Cell Phone Pouch Cover","code":"cell-phone-pouch-cover"},"brand":{"id":5288,"code":"mahoot","title_fa":"\u0645\u0627\u0647\u0648\u062a","title_en":"MAHOOT","is_premium":false,"is_miscellaneous":false},"review":{"description":"\u0637\u0631\u062d \u06a9\u0627\u0634\u06cc 11 \u0627\u0632 \u0633\u0631\u06cc \u0637\u0631\u062d \u0647\u0627\u06cc \u0645\u062d\u0635\u0648\u0644\u0627\u062a \u0645\u0627\u0647\u0648\u062a.","attributes":[]},"specifications":[{"title":"\u0645\u0634\u062e\u0635\u0627\u062a","attributes":[{"title":"\u062c\u0646\u0633","values":["\u067e\u0644\u06cc \u06a9\u0631\u0628\u0646\u0627\u062a "]},{"title":"\u0648\u0632\u0646","values":["5 \u06af\u0631\u0645"]},{"title":"\u0633\u0627\u0632\u06af\u0627\u0631 \u0628\u0627 \u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644","values":["\u0633\u0627\u06cc\u0631 \u06af\u0648\u0634\u06cc\u200c\u0647\u0627\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644 "]},{"title":"\u0633\u0627\u062e\u062a\u0627\u0631","values":["\u0645\u0627\u062a "]},{"title":"\u0633\u0637\u062d \u067e\u0648\u0634\u0634","values":["\u0642\u0627\u0628 \u067e\u0634\u062a\u06cc "]},{"title":"\u0648\u06cc\u0698\u06af\u06cc\u200c\u0647\u0627\u06cc \u06a9\u06cc\u0641 \u0648 \u06a9\u0627\u0648\u0631","values":["\u0645\u0642\u0627\u0648\u0645 \u062f\u0631 \u0628\u0631\u0627\u0628\u0631 \u0622\u0628 "]},{"title":"\u0633\u0627\u06cc\u0631 \u062a\u0648\u0636\u06cc\u062d\u0627\u062a","values":["\u0636\u062e\u0627\u0645\u062a 0.2 \u0645\u06cc\u0644\u06cc\u0645\u062a\u0631\r\n\u0633\u0631\u06cc \u0645\u062d\u0635\u0648\u0644: \u0637\u0631\u062d\r\n\u0633\u0637\u062d \u0645\u0642\u0627\u0648\u0645 \u062f\u0631 \u0628\u0631\u0627\u0628\u0631 \u0645\u0648\u0627\u062f \u0634\u06cc\u0645\u06cc\u0627\u06cc\u06cc \u0648 \u0633\u0627\u06cc\u06cc\u062f\u06af\u06cc\r\n\u0636\u062e\u0627\u0645\u062a \u06a9\u0645\r\n\u0686\u0633\u0628\u0646\u062f\u06af\u06cc \u0628\u0627\u0644\u0627\r\n\u0627\u0645\u0643\u0627\u0646 \u0627\u0633\u062a\u0641\u0627\u062f\u0647 \u0647\u0645\u0632\u0645\u0627\u0646 \u0628\u0627 \u06af\u0627\u0631\u062f \u0648 \u0628\u0627\u0645\u067e\u0631\r\n\u0645\u062d\u062a\u0648\u06cc\u0627\u062a \u062c\u0639\u0628\u0647: \u0628\u0631\u067e\u0648\u0634 \u0645\u0627\u0647\u0648\u062a- \u067e\u062f \u0627\u0644\u06a9\u0644 -\u0631\u0627\u0647\u0646\u0645\u0627 \u062a\u0635\u0648\u06cc\u0631-\u06a9\u0627\u0631\u062f\u06a9 \u0648\u06cc\u0698\u0647 \u0646\u0635\u0628\r\n "]}]}],"expert_reviews":{"attributes":[],"description":"\u0637\u0631\u062d \u06a9\u0627\u0634\u06cc 11 \u0627\u0632 \u0633\u0631\u06cc \u0637\u0631\u062d \u0647\u0627\u06cc \u0645\u062d\u0635\u0648\u0644\u0627\u062a \u0645\u0627\u0647\u0648\u062a.","short_review":"","review_sections":[]},"breadcrumb":[{"category_id":null,"title":"\u062f\u06cc\u062c\u06cc\u200c\u06a9\u0627\u0644\u0627","url":{"base":null,"uri":"\/"}},{"category_id":5966,"title":"\u06a9\u0627\u0644\u0627\u06cc \u062f\u06cc\u062c\u06cc\u062a\u0627\u0644","url":{"base":null,"uri":"\/main\/electronic-devices\/"}},{"category_id":6060,"title":"\u0644\u0648\u0627\u0632\u0645 \u062c\u0627\u0646\u0628\u06cc \u06a9\u0627\u0644\u0627\u06cc \u062f\u06cc\u062c\u06cc\u062a\u0627\u0644","url":{"base":null,"uri":"\/search\/category-accessories-main\/"}},{"category_id":12,"title":"\u0644\u0648\u0627\u0632\u0645 \u062c\u0627\u0646\u0628\u06cc \u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644","url":{"base":null,"uri":"\/search\/category-mobile-accessories\/"}},{"category_id":77,"title":"\u06a9\u06cc\u0641 \u0648 \u06a9\u0627\u0648\u0631 \u06af\u0648\u0634\u06cc","url":{"base":null,"uri":"\/search\/category-cell-phone-pouch-cover\/"}},{"category_id":null,"title":"\u0628\u0631\u0686\u0633\u0628 \u067e\u0648\u0634\u0634\u06cc \u0645\u0627\u0647\u0648\u062a \u0645\u062f\u0644 Iran Tile 11","url":{"base":null,"uri":"\/product\/dkp-13196935\/"}}]}}}
```

### `apps/backend/test/fixtures/importer/digikala-dkp-18010600.json`

```json
{"status":200,"data":{"product":{"id":18010600,"title_fa":"\u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644 \u0633\u0627\u0645\u0633\u0648\u0646\u06af \u0645\u062f\u0644 Galaxy S24 Ultra \u062f\u0648 \u0633\u06cc\u0645 \u06a9\u0627\u0631\u062a \u0638\u0631\u0641\u06cc\u062a 256 \u06af\u06cc\u06af\u0627\u0628\u0627\u06cc\u062a \u0648 \u0631\u0645 12 \u06af\u06cc\u06af\u0627\u0628\u0627\u06cc\u062a - \u0648\u06cc\u062a\u0646\u0627\u0645  - \u0628\u0647 \u0647\u0645\u0631\u0627\u0647 \u0628\u0633\u062a\u0647 \u0627\u06cc\u0646\u062a\u0631\u0646\u062a 100 \u06af\u06cc\u06af\u0627\u0628\u0627\u06cc\u062a\u06cc \u06cc\u06a9 \u0645\u0627\u0647\u0647 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644","title_en":"Samsung Galaxy S24 Ultra Dual SIM 256GB And 12GB RAM Mobile Phone - Vietnam","status":"out_of_stock","data_layer":{"brand":"\u0633\u0627\u0645\u0633\u0648\u0646\u06af","category":"[MO,\u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644]","item_category2":"\u0645\u0648\u0628\u0627\u06cc\u0644","item_category3":"\u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644"},"images":{"main":{"storage_ids":[],"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/3f87fdaacf66adf0a256fe384aa58aeab8efaf41_1746616101.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},"list":[{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/ab2adee3936a361bbb7069eb244e6a7dbf107dfd_1741531562.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/1927e0996ba08bcca0cbe3151d95c925cb743099_1736777474.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/97023f1f29b31ab1a93fd67777378ac9b0030518_1736777474.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/78f0248011d57eb8226821fc04493e4dc2943623_1736777474.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/dd5aeaf553a146cffbed0779a6d53e718a87ed15_1736777474.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/1d0d8476827c4f27559de9525b77291a9d63a0a3_1736777475.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/368413e77de9b8d4d4099bef54b73b32cd744edc_1736777475.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/198aec5822adcece0602ee9bfedc0295ce5d8303_1736777475.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]},{"url":["https:\/\/dkstatics-public.digikala.com\/digikala-products\/f8be8d595569aedd26ad69a66aa13f745ce600a6_1736777475.jpg?x-oss-process=image\/resize,m_lfit,h_800,w_800\/quality,q_90"]}]},"category":{"title_fa":"\u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644"},"brand":{"title_fa":"\u0633\u0627\u0645\u0633\u0648\u0646\u06af","is_miscellaneous":false},"specifications":[{"title":"\u062f\u0648\u0631\u0628\u06cc\u0646","attributes":[{"title":"\u062a\u0639\u062f\u0627\u062f \u062f\u0648\u0631\u0628\u06cc\u0646\u200c\u0647\u0627\u06cc \u067e\u0634\u062a \u06af\u0648\u0634\u06cc","values":["4 \u0645\u0627\u0698\u0648\u0644 \u062f\u0648\u0631\u0628\u06cc\u0646 "]},{"title":"\u0646\u0648\u0639 \u0644\u0646\u0632 \u062f\u0648\u0631\u0628\u06cc\u0646 \u0627\u0635\u0644\u06cc","values":["\u0639\u0631\u06cc\u0636 "]},{"title":"\u0631\u0632\u0648\u0644\u0648\u0634\u0646 \u062f\u0648\u0631\u0628\u06cc\u0646 \u0627\u0635\u0644\u06cc","values":["200 \u0645\u06af\u0627\u067e\u06cc\u06a9\u0633\u0644 "]},{"title":"\u0631\u0632\u0648\u0644\u0648\u0634\u0646 \u062f\u0648\u0631\u0628\u06cc\u0646 \u062f\u0648\u0645","values":["50 \u0645\u06af\u0627\u067e\u06cc\u06a9\u0633\u0644"]},{"title":"\u0646\u0648\u0639 \u0644\u0646\u0632 \u062f\u0648\u0631\u0628\u06cc\u0646 \u0686\u0647\u0627\u0631\u0645","values":["\u0641\u0648\u0642 \u0639\u0631\u06cc\u0636 "]},{"title":"\u0641\u0646\u0627\u0648\u0631\u06cc \u0641\u0648\u06a9\u0648\u0633","values":["PDAF "]},{"title":"\u0631\u0632\u0648\u0644\u0648\u0634\u0646 \u0641\u06cc\u0644\u0645\u0628\u0631\u062f\u0627\u0631\u06cc","values":["8K "]}]},{"title":"\u0627\u0631\u062a\u0628\u0627\u0637\u0627\u062a","attributes":[{"title":"\u0641\u0646\u0627\u0648\u0631\u06cc \u0645\u06a9\u0627\u0646\u200c\u06cc\u0627\u0628\u06cc (GPS)","values":["GPS ","GLONASS ","GALILEO ","BDS(Beidou) "]},{"title":"\u0631\u0627\u062f\u06cc\u0648","values":["\u0641\u0627\u0642\u062f \u067e\u0634\u062a\u06cc\u0628\u0627\u0646\u06cc "]},{"title":"\u062f\u0631\u06af\u0627\u0647\u200c\u0647\u0627 \u0648 \u0641\u0646\u0627\u0648\u0631\u06cc\u200c\u0647\u0627\u06cc \u0627\u0631\u062a\u0628\u0627\u0637\u06cc","values":["USB Type-C "]},{"title":"\u0634\u0628\u06a9\u0647\u200c\u0647\u0627\u06cc \u0627\u0631\u062a\u0628\u0627\u0637\u06cc \u0642\u0627\u0628\u0644 \u067e\u0634\u062a\u06cc\u0628\u0627\u0646\u06cc","values":["Wi-Fi ","\u0628\u0644\u0648\u062a\u0648\u062b "]}]}],"expert_reviews":{"description":"\u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644 Samsung Galaxy S24 Ultra \u06cc\u06a9\u06cc \u0627\u0632 \u06af\u0648\u0634\u06cc&zwnj;\u0647\u0627\u06cc \u067e\u0631\u0686\u0645\u062f\u0627\u0631 \u0648 \u0642\u062f\u0631\u062a\u0645\u0646\u062f \u0633\u0627\u0645\u0633\u0648\u0646\u06af \u0627\u0633\u062a.\r\n\u0628\u0633\u062a\u0647 \u0627\u06cc\u0646\u062a\u0631\u0646\u062a \u06cc\u06a9\u200c\u0645\u0627\u0647\u0647 100 \u06af\u06cc\u06af\u0627\u0628\u0627\u06cc\u062a\u06cc \u0627\u06cc\u0646 \u06af\u0648\u0634\u06cc \u0641\u0642\u0637 \u0628\u0631\u0627\u06cc \u062e\u0637\u0648\u0637 \u0647\u0645\u0631\u0627\u0647 \u0627\u0648\u0644 \u0641\u0639\u0627\u0644 \u0645\u06cc\u200c\u0634\u0648\u062f.","short_review":"","review_sections":[]}}}}
```

### `apps/backend/test/fixtures/importer/microdata-product.html`

```html
<!DOCTYPE html>
<html lang="fa">
<head><meta charset="utf-8"><title>لپ‌تاپ نمونه | فروشگاه مایکرو</title></head>
<body>
<div itemscope itemtype="https://schema.org/Product">
  <h1 itemprop="name">لپ‌تاپ ۱۴ اینچی مدل X14</h1>
  <div itemprop="brand" itemscope itemtype="https://schema.org/Brand"><span itemprop="name">نمونه‌تک</span></div>
  <img itemprop="image" src="/images/x14-front.jpg" alt="">
  <img itemprop="image" data-src="https://micro.fixture.test/images/x14-open.jpg" alt="">
  <div itemprop="description"><p>پردازنده هشت‌هسته‌ای و <strong>باتری</strong> ۱۲ ساعته.</p></div>
  <ul>
    <li itemprop="additionalProperty" itemscope itemtype="https://schema.org/PropertyValue"><span itemprop="name">پردازنده</span>: <span itemprop="value">Core i7-1360P</span></li>
    <li itemprop="additionalProperty" itemscope itemtype="https://schema.org/PropertyValue"><span itemprop="name">حافظه</span>: <meta itemprop="value" content="16 گیگابایت">16GB</li>
  </ul>
  <div itemprop="offers" itemscope itemtype="https://schema.org/Offer"><meta itemprop="price" content="620000000"><meta itemprop="priceCurrency" content="IRR"></div>
</div>
</body>
</html>
```

### `apps/backend/test/fixtures/importer/shopify-product.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Trail Runner Wool &ndash; Fixture Outfitters</title>
<meta property="og:site_name" content="Fixture Outfitters">
<meta property="og:type" content="product">
<meta property="og:title" content="Trail Runner Wool">
<meta property="og:image" content="http://outfitters.fixture.test/cdn/shop/files/trail-runner-side.png?v=1751165486&width=1200">
<meta property="og:price:amount" content="98.00">
<script type="application/ld+json">
{
  "@context": "http://schema.org/",
  "@type": "ProductGroup",
  "@id": "https://outfitters.fixture.test/products/trail-runner-wool#product",
  "name": "Trail Runner Wool",
  "description": "A breathable\nwool runner, with a <b>sugarcane</b> sole.",
  "brand": { "@type": "Brand", "name": "Fixture Outfitters" },
  "productGroupID": "7421",
  "material": "Merino wool",
  "hasVariant": [
    { "@type": "Product", "name": "Trail Runner Wool - Black / 42", "sku": "TRW-BLK-42", "image": "//cdn.shopify.com/s/files/1/0001/files/trail-runner-side.png?v=1751165486&width=100",
      "offers": { "@type": "Offer", "price": "98.00", "priceCurrency": "USD" } },
    { "@type": "Product", "name": "Trail Runner Wool - Grey / 42", "sku": "TRW-GRY-42", "image": "//cdn.shopify.com/s/files/1/0001/files/trail-runner-grey.png?v=1751165490&width=100",
      "offers": { "@type": "Offer", "price": "98.00", "priceCurrency": "USD" } },
  ],
  "image": ["//cdn.shopify.com/s/files/1/0001/files/trail-runner-side.png?v=1751165486&width=300&height=300&crop=center"]
}
</script>
</head>
<body><h1>Trail Runner Wool</h1></body>
</html>
```

### `apps/backend/test/fixtures/importer/woocommerce-product.html`

```html
<!DOCTYPE html>
<html dir="rtl" lang="fa-IR">
<head>
<meta charset="UTF-8">
<title>گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت - فروشگاه نمونه</title>
<meta name="description" content="خرید گوشی Redmi Note 13 با گارانتی 18 ماهه">
<link rel="canonical" href="https://shop.fixture.test/product/redmi-note-13/">
<meta property="og:locale" content="fa_IR">
<meta property="og:type" content="product">
<meta property="og:title" content="گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت - فروشگاه نمونه">
<meta property="og:description" content="خرید گوشی Redmi Note 13 با گارانتی 18 ماهه">
<meta property="og:url" content="https://shop.fixture.test/product/redmi-note-13/">
<meta property="og:site_name" content="فروشگاه نمونه">
<meta property="og:image" content="https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front.jpg">
<meta property="product:price:amount" content="185000000">
<meta property="product:price:currency" content="IRR">
<script type="application/ld+json" class="yoast-schema-graph">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","@id":"https://shop.fixture.test/product/redmi-note-13/","name":"گوشی موبایل شیائومی Redmi Note 13 - فروشگاه نمونه"},{"@type":"BreadcrumbList","@id":"https://shop.fixture.test/product/redmi-note-13/#breadcrumb","itemListElement":[{"@type":"ListItem","position":1,"name":"خانه","item":"https://shop.fixture.test/"},{"@type":"ListItem","position":2,"name":"موبایل","item":"https://shop.fixture.test/product-category/mobile/"},{"@type":"ListItem","position":3,"name":"گوشی موبایل","item":"https://shop.fixture.test/product-category/mobile/phone/"},{"@type":"ListItem","position":4,"name":"گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت"}]},{"@type":"Organization","name":"فروشگاه نمونه","url":"https://shop.fixture.test/"}]}</script>
</head>
<body class="product-template-default single single-product woocommerce">
<div id="product-4821" class="product type-product has-post-thumbnail product_cat-phone">
  <div class="woocommerce-product-gallery woocommerce-product-gallery--with-images images" data-columns="4">
    <div class="woocommerce-product-gallery__wrapper">
      <div data-thumb="https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front-100x100.jpg" class="woocommerce-product-gallery__image"><a href="https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front.jpg"><img width="600" height="600" src="https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front-600x600.jpg" class="wp-post-image" alt="" data-src="https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front.jpg" data-large_image="https://shop.fixture.test/wp-content/uploads/2026/01/redmi-note-13-front.jpg" data-large_image_width="1600" data-large_image_height="1600"></a></div>
      <div data-thumb="/wp-content/uploads/2026/01/redmi-note-13-back-100x100.jpg" class="woocommerce-product-gallery__image"><a href="/wp-content/uploads/2026/01/redmi-note-13-back.jpg"><img width="600" height="600" src="/wp-content/uploads/2026/01/redmi-note-13-back-600x600.jpg" alt="" data-large_image="/wp-content/uploads/2026/01/redmi-note-13-back.jpg"></a></div>
    </div>
  </div>
  <div class="summary entry-summary">
    <h1 class="product_title entry-title">گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت</h1>
    <p class="price"><span class="woocommerce-Price-amount amount"><bdi>18,500,000&nbsp;<span class="woocommerce-Price-currencySymbol">تومان</span></bdi></span></p>
  </div>
  <div class="woocommerce-tabs wc-tabs-wrapper">
    <div class="woocommerce-Tabs-panel woocommerce-Tabs-panel--additional_information panel entry-content wc-tab" id="tab-additional_information">
      <h2>توضیحات تکمیلی</h2>
      <table class="woocommerce-product-attributes shop_attributes" aria-label="جزئیات محصول">
        <tr class="woocommerce-product-attributes-item woocommerce-product-attributes-item--weight">
          <th class="woocommerce-product-attributes-item__label" scope="row">وزن</th>
          <td class="woocommerce-product-attributes-item__value">188 گرم</td>
        </tr>
        <tr class="woocommerce-product-attributes-item woocommerce-product-attributes-item--attribute_pa_ram">
          <th class="woocommerce-product-attributes-item__label" scope="row">حافظه RAM</th>
          <td class="woocommerce-product-attributes-item__value"><p>8 گیگابایت</p></td>
        </tr>
        <tr class="woocommerce-product-attributes-item woocommerce-product-attributes-item--attribute_pa_network">
          <th class="woocommerce-product-attributes-item__label" scope="row">شبکه ارتباطی</th>
          <td class="woocommerce-product-attributes-item__value"><p><a href="https://shop.fixture.test/network/4g/" rel="tag">4G</a>, <a href="https://shop.fixture.test/network/3g/" rel="tag">3G</a></p></td>
        </tr>
        <tr class="woocommerce-product-attributes-item woocommerce-product-attributes-item--attribute_pa_color">
          <th class="woocommerce-product-attributes-item__label" scope="row">رنگ</th>
          <td class="woocommerce-product-attributes-item__value"><p>مشکی، آبی</p></td>
        </tr>
      </table>
    </div>
  </div>
</div>
<script type="application/ld+json">{"@context":"https:\/\/schema.org\/","@graph":[{"@context":"https:\/\/schema.org\/","@type":"Product","@id":"https:\/\/shop.fixture.test\/product\/redmi-note-13\/#product","name":"\u06af\u0648\u0634\u06cc \u0645\u0648\u0628\u0627\u06cc\u0644 \u0634\u06cc\u0627\u0626\u0648\u0645\u06cc Redmi Note 13 \u0638\u0631\u0641\u06cc\u062a 256 \u06af\u06cc\u06af\u0627\u0628\u0627\u06cc\u062a","url":"https:\/\/shop.fixture.test\/product\/redmi-note-13\/","description":"<p>\u0635\u0641\u062d\u0647 \u0646\u0645\u0627\u06cc\u0634 AMOLED &amp; \u0628\u0627\u062a\u0631\u06cc 5000 \u0645\u06cc\u0644\u06cc\u200c\u0622\u0645\u067e\u0631.<\/p><script>alert(1)<\/script><p>\u06af\u0627\u0631\u0627\u0646\u062a\u06cc 18 \u0645\u0627\u0647\u0647<\/p>","image":"https:\/\/shop.fixture.test\/wp-content\/uploads\/2026\/01\/redmi-note-13-front.jpg","sku":"RN13-256","brand":{"@type":"Brand","name":"\u0634\u06cc\u0627\u0626\u0648\u0645\u06cc"},"offers":[{"@type":"Offer","price":"185000000","priceCurrency":"IRR","availability":"http:\/\/schema.org\/InStock"}]}]}</script>
</body>
</html>
```

### `apps/backend/test/health.e2e-spec.ts`

```ts
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { applyGlobalPolicies, buildOpenApiDocument } from '../src/setup/app.setup';

/**
 * End-to-end verification against the real infrastructure: this suite talks to
 * the PostgreSQL and Redis instances started by docker-compose — nothing is
 * stubbed. Run `docker compose up -d` first, then
 * `pnpm --filter @shopino/backend run test:e2e`.
 *
 * Note on Swagger: the DocumentBuilder contract is asserted here, while the
 * served UI is verified over HTTP by `pnpm run verify:http` (see
 * scripts/smoke-http.ts). Serving the UI pulls in @fastify/static → glob@13,
 * which is ESM-only: Node 22 loads it through require(esm), whereas Jest's
 * CommonJS runtime cannot, so the HTTP layer is exercised where it actually
 * matters — against a running server.
 */
describe('Health endpoint (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

    const config = app.get(ConfigService);
    applyGlobalPolicies(app, config);

    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/v1/health reports database and redis as up', async () => {
    const response = await app.inject({ method: 'GET', url: `/${GLOBAL_API_PREFIX}/health` });

    expect(response.statusCode).toBe(200);

    const body = response.json<{ status: string; info: Record<string, { status: string }> }>();
    expect(body.status).toBe('ok');
    expect(body.info.database?.status).toBe('up');
    expect(body.info.redis?.status).toBe('up');
    expect(body.info.memory?.status).toBe('up');
    expect(body.info.uptime?.status).toBe('up');
  });

  it('publishes the health route in the OpenAPI document', () => {
    const document = buildOpenApiDocument(app);

    expect(document.info.title).toBe('Shagerdam (شاگردم) API');
    expect(Object.keys(document.paths)).toContain(`/${GLOBAL_API_PREFIX}/health`);
  });

  it('rejects unknown routes with 404', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/${GLOBAL_API_PREFIX}/does-not-exist`,
    });

    expect(response.statusCode).toBe(404);
  });
});
```

### `apps/backend/test/importer.e2e-spec.ts`

```ts
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ConfigService } from '@nestjs/config';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import sharp from 'sharp';
import { AppModule } from '../src/app.module';
import { GLOBAL_API_PREFIX } from '../src/common/constants';
import { PrismaService } from '../src/infra/prisma/prisma.service';
import { RedisService } from '../src/infra/redis/redis.service';
import { normalizeIdentifier } from '../src/modules/auth/auth.service';
import { OtpKeys } from '../src/modules/auth/otp.service';
import { loginAttemptsKey, loginLockKey } from '../src/modules/auth/token.service';
import { DIGIKALA_API_ORIGIN } from '../src/modules/importer/extractors/digikala.extractor';
import {
  IMPORT_NETWORK_POLICY,
  isReservedAddress,
  PUBLIC_INTERNET_POLICY,
  type ImportNetworkPolicy,
} from '../src/modules/importer/net/address-policy';
import { EXTRACT_LIMIT, importerRateKeys } from '../src/modules/importer/product-importer.service';
import { MAX_MEDIA_PER_PRODUCT } from '../src/modules/products/product-rules';
import { SMS_PROVIDER, type SmsProvider } from '../src/modules/sms/sms-provider.interface';
import type { SandboxSmsProvider } from '../src/modules/sms/providers/sandbox-sms.provider';
import { STORAGE_PROVIDER, type StorageProvider } from '../src/modules/storage/storage-provider.interface';
import { applyGlobalPolicies } from '../src/setup/app.setup';

/**
 * End-to-end verification of the product importer against the real stack:
 * PostgreSQL (media assets, products, specifications, audit log), Redis
 * (per-vendor quotas, auth state), the real media pipeline (Sharp → WebP +
 * thumbnail → storage provider) and the real vendor onboarding flow.
 *
 * Remote sites are replaced by a local HTTP server that serves captured
 * Digikala API responses and a WooCommerce page (test/fixtures/importer). To
 * reach it, the suite swaps the network policy — the only test seam — for one
 * that has a "fixture mode" switch:
 *
 *   - fixture mode ON: the production reserved-address rules, plus exactly
 *     127.0.0.1 on the fixture port, and `*.fixture.test` resolving to it;
 *   - fixture mode OFF: behaves exactly like PUBLIC_INTERNET_POLICY. All SSRF
 *     assertions run in this mode, i.e. against the production policy.
 */

const TEST_UA = 'shopino-importer-e2e/1.0';
const RUN = Date.now().toString(36);
const TAG = RUN.toUpperCase();

const VENDOR_MOBILE = '+989971190001';
const PENDING_VENDOR_MOBILE = '+989971190002';
const CUSTOMER_MOBILE = '+989971190003';
const SUITE_MOBILES = [VENDOR_MOBILE, PENDING_VENDOR_MOBILE, CUSTOMER_MOBILE];
const IBANS = ['IR820540102680020817909002', 'IR570629600000001003242001'];
const SEEDED_ADMIN_EMAIL = 'admin@shopino.local';

const FIXTURES = join(__dirname, 'fixtures/importer');

interface HttpResult<T> {
  status: number;
  body: T;
}

interface ExtractResponse {
  source: 'DIGIKALA' | 'GENERIC';
  strategies: string[];
  sourceUrl: string;
  sourceProductId: string | null;
  title: string;
  titleEn: string | null;
  brand: string | null;
  description: string | null;
  suggestedCategory: string | null;
  suggestedCategoryId: string | null;
  specifications: Array<{ group: string | null; title: string; value: string }>;
  imageUrls: string[];
}

interface IngestResponse {
  items: Array<{ sourceUrl: string; id: string; url: string; thumbnailUrl: string; width: number; height: number; sizeBytes: number }>;
  failures: Array<{ sourceUrl: string; code: string; message: string }>;
}

interface ErrorBody {
  statusCode: number;
  code?: string;
  message: string | string[];
}

// ─── Fixture network ────────────────────────────────────────────────────────

const network = { fixtureMode: true, port: 0 };

const fixturePolicy: ImportNetworkPolicy = {
  isBlockedAddress: (address) =>
    network.fixtureMode ? address !== '127.0.0.1' && isReservedAddress(address) : PUBLIC_INTERNET_POLICY.isBlockedAddress(address),
  isAllowedPort: (port) =>
    PUBLIC_INTERNET_POLICY.isAllowedPort(port) || (network.fixtureMode && port === network.port),
  resolve: (hostname) => {
    if (network.fixtureMode && hostname === 'evil.fixture.test') return Promise.resolve([{ address: '10.0.0.7', family: 4 as const }]);
    if (network.fixtureMode && hostname.endsWith('.fixture.test')) return Promise.resolve([{ address: '127.0.0.1', family: 4 as const }]);
    return PUBLIC_INTERNET_POLICY.resolve(hostname);
  },
};

let fixtureServer: Server;
const shopOrigin = (): string => `http://shop.fixture.test:${network.port}`;

async function startFixtureServer(): Promise<void> {
  const digikala = (id: string): string => readFileSync(join(FIXTURES, `digikala-dkp-${id}.json`), 'utf8');
  const frontJpeg = await sharp({ create: { width: 1800, height: 1200, channels: 3, background: { r: 200, g: 40, b: 40 } } })
    .jpeg({ quality: 90 })
    .toBuffer();
  const backPng = await sharp({ create: { width: 640, height: 640, channels: 4, background: { r: 30, g: 90, b: 200, alpha: 1 } } })
    .png()
    .toBuffer();

  fixtureServer = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    const send = (status: number, type: string, body: string | Buffer): void => {
      res.writeHead(status, { 'content-type': type });
      res.end(body);
    };
    switch (path) {
      case '/v2/product/13196935/':
        return send(200, 'application/json', digikala('13196935'));
      case '/v2/product/18010600/':
        return send(200, 'application/json', digikala('18010600'));
      case '/v2/product/999999/':
        return send(404, 'application/json', '{"status":404}');
      case '/product/redmi-note-13/':
        // The captured page references https://shop.fixture.test; serve it from this server instead.
        return send(
          200,
          'text/html; charset=UTF-8',
          readFileSync(join(FIXTURES, 'woocommerce-product.html'), 'utf8')
            .replaceAll('https://shop.fixture.test', shopOrigin())
            .replaceAll('https:\\/\\/shop.fixture.test', shopOrigin().replaceAll('/', '\\/')),
        );
      case '/wp-content/uploads/2026/01/redmi-note-13-front.jpg':
        return send(200, 'image/jpeg', frontJpeg);
      case '/wp-content/uploads/2026/01/redmi-note-13-back.jpg':
        return send(200, 'image/png', backPng);
      case '/images/not-an-image.jpg':
        return send(200, 'image/jpeg', '<html>this is not an image</html>');
      case '/about/':
        return send(200, 'text/html', '<html><head><title>About us</title></head><body>Hello</body></html>');
      case '/redirect-to-metadata':
        res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
        return res.end();
      default:
        return send(404, 'text/html', 'not found');
    }
  });
  await new Promise<void>((resolve) => fixtureServer.listen(0, '127.0.0.1', resolve));
  network.port = (fixtureServer.address() as AddressInfo).port;
}

// ─── Suite ──────────────────────────────────────────────────────────────────

describe('Product importer — extract-spec, ingest-images, create (live stack)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let storage: StorageProvider;

  let adminToken: string;
  let vendor: { token: string; userId: string; vendorId: string };
  let pending: { token: string; userId: string };
  let customer: { token: string; userId: string };
  let categoryIds: { mobile: string; digital: string };

  const API = `/${GLOBAL_API_PREFIX}`;

  const request = async <T>(
    url: string,
    options: { method?: 'GET' | 'POST'; token?: string; body?: unknown; form?: FormData } = {},
  ): Promise<HttpResult<T>> => {
    const headers: Record<string, string> = { 'user-agent': TEST_UA };
    if (options.token !== undefined) headers.authorization = `Bearer ${options.token}`;
    let payload: string | Buffer | undefined;
    if (options.form !== undefined) {
      const serialized = new Response(options.form);
      payload = Buffer.from(await serialized.arrayBuffer());
      headers['content-type'] = serialized.headers.get('content-type') ?? '';
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(options.body);
    }
    const response = await app.inject({ method: options.method ?? 'GET', url: `${API}${url}`, headers, ...(payload === undefined ? {} : { payload }) });
    return { status: response.statusCode, body: response.body.length > 0 ? (JSON.parse(response.body) as T) : (undefined as T) };
  };

  const extract = (url: string, token = vendor.token): Promise<HttpResult<ExtractResponse & ErrorBody>> =>
    request('/vendor/products/import/extract-spec', { method: 'POST', token, body: { url } });
  const ingest = (imageUrls: string[], token = vendor.token): Promise<HttpResult<IngestResponse & ErrorBody>> =>
    request('/vendor/products/import/ingest-images', { method: 'POST', token, body: { imageUrls } });

  const loginWithOtp = async (mobile: string): Promise<{ token: string; userId: string }> => {
    expect((await request('/auth/otp/request', { method: 'POST', body: { mobile } })).status).toBe(200);
    const code = (app.get<SmsProvider>(SMS_PROVIDER) as SandboxSmsProvider).latestOtpCode(mobile);
    const verified = await request<{ accessToken: string; user: { id: string } }>('/auth/otp/verify', { method: 'POST', body: { mobile, code } });
    expect(verified.status).toBe(200);
    return { token: verified.body.accessToken, userId: verified.body.user.id };
  };

  const registerStore = async (token: string, storeSlug: string, iban: string): Promise<string> => {
    const response = await request<{ id: string }>('/vendors/register', {
      method: 'POST',
      token,
      body: { storeName: `فروشگاه آزمون واردکننده ${storeSlug}`, storeSlug, bio: 'فروشگاه آزمون واردکردن کالا', bankIban: iban, bankAccountHolder: 'شرکت آزمون' },
    });
    expect(response.status).toBe(201);
    return response.body.id;
  };

  async function resetKeys(): Promise<void> {
    const keys = [
      ...(await redis.client.keys('auth:otp:hourly:ip:*')),
      ...SUITE_MOBILES.flatMap((mobile) => [
        OtpKeys.challenge(mobile),
        OtpKeys.lock(mobile),
        OtpKeys.cooldown(mobile),
        OtpKeys.hourlyByMobile(mobile),
        loginAttemptsKey(normalizeIdentifier(mobile)),
        loginLockKey(normalizeIdentifier(mobile)),
      ]),
      loginAttemptsKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
      loginLockKey(normalizeIdentifier(SEEDED_ADMIN_EMAIL)),
      ...(vendor ? [importerRateKeys.extract(vendor.userId), importerRateKeys.images(vendor.userId)] : []),
    ];
    if (keys.length > 0) await redis.client.del(...keys);
  }

  beforeAll(async () => {
    await startFixtureServer();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(IMPORT_NETWORK_POLICY)
      .useValue(fixturePolicy)
      .overrideProvider(DIGIKALA_API_ORIGIN)
      .useValue(`http://dk-api.fixture.test:${network.port}`)
      .compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    applyGlobalPolicies(app, app.get(ConfigService));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    storage = app.get<StorageProvider>(STORAGE_PROVIDER);
    await resetKeys();

    const adminPassword = process.env['SUPER_ADMIN_PASSWORD'];
    if (adminPassword === undefined) throw new Error('This suite needs SUPER_ADMIN_PASSWORD from the root .env.');
    const admin = await request<{ accessToken: string }>('/auth/login/password', {
      method: 'POST',
      body: { identifier: SEEDED_ADMIN_EMAIL, password: adminPassword },
    });
    expect(admin.status).toBe(200);
    adminToken = admin.body.accessToken;

    const v = await loginWithOtp(VENDOR_MOBILE);
    pending = await loginWithOtp(PENDING_VENDOR_MOBILE);
    customer = await loginWithOtp(CUSTOMER_MOBILE);
    const vendorId = await registerStore(v.token, `imp-e2e-${RUN}`, IBANS[0]!);
    await registerStore(pending.token, `imp-e2e-p-${RUN}`, IBANS[1]!);

    const form = new FormData();
    const pdf = Buffer.concat([Buffer.from(`%PDF-1.7\n% importer e2e ${RUN}\n`, 'latin1'), Buffer.from('%%EOF', 'latin1')]);
    form.append('file', new Blob([new Uint8Array(pdf)], { type: 'application/pdf' }), 'national-id.pdf');
    form.append('purpose', 'kyc_national_id');
    const doc = await request<{ url: string }>('/media/upload/document', { method: 'POST', token: v.token, form });
    expect(doc.status).toBe(201);
    expect((await request('/vendors/verification/documents', { method: 'POST', token: v.token, body: { nationalIdCardUrl: doc.body.url } })).status).toBe(200);
    const approved = await request(`/admin/vendors/${vendorId}/verify`, {
      method: 'POST',
      token: adminToken,
      body: { status: 'APPROVED', rejectionReason: null },
    });
    expect(approved.status).toBe(200);
    vendor = { ...v, vendorId };

    const categories = await prisma.category.findMany({ where: { slug: { in: ['mobile', 'digital'] } }, select: { id: true, slug: true } });
    const bySlug = new Map(categories.map((row) => [row.slug, row.id]));
    if (!bySlug.has('mobile') || !bySlug.has('digital')) throw new Error('The seeded categories "mobile" and "digital" are required (pnpm db:seed).');
    categoryIds = { mobile: bySlug.get('mobile')!, digital: bySlug.get('digital')! };
  }, 120_000);

  afterAll(async () => {
    if (prisma !== undefined) {
      const users = await prisma.user.findMany({ where: { mobile: { in: SUITE_MOBILES } }, select: { id: true } });
      const userIds = users.map((user) => user.id);
      const vendors = await prisma.vendor.findMany({ where: { userId: { in: userIds } }, select: { id: true } });
      const vendorIds = vendors.map((row) => row.id);
      const products = await prisma.product.findMany({ where: { vendorId: { in: vendorIds } }, select: { id: true } });
      const productIds = products.map((row) => row.id);

      await prisma.productMedia.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.productVariant.deleteMany({ where: { productId: { in: productIds } } });
      await prisma.product.deleteMany({ where: { id: { in: productIds } } }); // specifications cascade

      const assets = await prisma.mediaAsset.findMany({ where: { ownerUserId: { in: userIds } }, select: { path: true, thumbnailPath: true } });
      for (const asset of assets) {
        await storage.delete(asset.path).catch(() => false);
        if (asset.thumbnailPath !== null) await storage.delete(asset.thumbnailPath).catch(() => false);
      }
      await prisma.auditLog.deleteMany({
        where: { OR: [{ userId: { in: userIds } }, { userAgent: TEST_UA }, { entityId: { in: [...vendorIds, ...productIds] } }] },
      });
      await prisma.vendorVerification.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.vendorWallet.deleteMany({ where: { vendorId: { in: vendorIds } } });
      await prisma.mediaAsset.deleteMany({ where: { ownerUserId: { in: userIds } } });
      await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
      await resetKeys();
    }
    await app?.close();
    fixtureServer?.closeAllConnections();
    await new Promise<void>((resolve) => (fixtureServer ? fixtureServer.close(() => resolve()) : resolve()));
  }, 120_000);

  // ─── Access control and validation ───────────────────────────────────────

  describe('access control', () => {
    it('requires authentication', async () => {
      const response = await request('/vendor/products/import/extract-spec', { method: 'POST', body: { url: 'https://example.com/' } });
      expect(response.status).toBe(401);
    });

    it('is closed to customers', async () => {
      expect((await extract('https://example.com/', customer.token)).status).toBe(403);
      expect((await ingest(['https://example.com/a.jpg'], customer.token)).status).toBe(403);
    });

    it('is closed to stores that are not approved yet', async () => {
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`, pending.token);
      expect(response.status).toBe(403);
    });

    it('validates the request body', async () => {
      expect((await request('/vendor/products/import/extract-spec', { method: 'POST', token: vendor.token, body: {} })).status).toBe(400);
      expect((await ingest([])).status).toBe(400);
      expect((await ingest(Array.from({ length: MAX_MEDIA_PER_PRODUCT + 1 }, (_, i) => `https://example.com/${i}.jpg`))).status).toBe(400);
    });
  });

  // ─── SSRF — production policy (fixture mode off) ─────────────────────────

  describe('SSRF protection (production network policy)', () => {
    beforeAll(() => {
      network.fixtureMode = false;
    });
    afterAll(() => {
      network.fixtureMode = true;
    });

    it.each([
      ['http://127.0.0.1:4000', 'BLOCKED_TARGET'],
      ['http://192.168.1.1', 'BLOCKED_TARGET'],
      ['http://10.0.0.1/', 'BLOCKED_TARGET'],
      ['http://172.16.0.10/', 'BLOCKED_TARGET'],
      ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_TARGET'],
      ['http://localhost/', 'BLOCKED_TARGET'],
      ['http://[::1]/', 'BLOCKED_TARGET'],
      ['http://2130706433/', 'BLOCKED_TARGET'],
      ['http://postgres:5432/', 'BLOCKED_TARGET'],
      ['file:///etc/passwd', 'INVALID_URL'],
      ['gopher://example.com/', 'INVALID_URL'],
    ])('extract-spec rejects %s with 400 %s', async (url, code) => {
      const response = await extract(url);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe(`IMPORT_${code}`);
    });

    it('the fixture server itself is unreachable under the production policy', async () => {
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
    });

    it('ingest-images validates every URL before downloading anything', async () => {
      const before = await prisma.mediaAsset.count({ where: { ownerUserId: vendor.userId } });
      const response = await ingest(['https://example.com/a.jpg', 'http://127.0.0.1:4000/a.png', 'http://192.168.1.1/x.jpg']);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
      expect(await prisma.mediaAsset.count({ where: { ownerUserId: vendor.userId } })).toBe(before);
    });
  });

  describe('SSRF protection at connect time and on redirects', () => {
    it('refuses a public-looking name that resolves to a private address', async () => {
      const response = await extract(`http://evil.fixture.test:${network.port}/product/x/`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
    });

    it('refuses a redirect to the cloud metadata endpoint', async () => {
      const response = await extract(`${shopOrigin()}/redirect-to-metadata`);
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('IMPORT_BLOCKED_TARGET');
    });
  });

  // ─── Extraction ───────────────────────────────────────────────────────────

  describe('extract-spec', () => {
    it('Digikala: reads title, brand, description, grouped specs and gallery through the API', async () => {
      const response = await extract('https://www.digikala.com/product/dkp-13196935/%D8%A8%D8%B1%DA%86%D8%B3%D8%A8/');
      expect(response.status).toBe(200);
      const draft = response.body;
      expect(draft.source).toBe('DIGIKALA');
      expect(draft.strategies).toEqual(['DIGIKALA_API']);
      expect(draft.sourceProductId).toBe('dkp-13196935');
      expect(draft.title).toBe('برچسب پوششی ماهوت مدل Iran Tile 11 مناسب برای گوشی موبایل هوآوی Y5 Lite');
      expect(draft.titleEn).toBe('MAHOOT Iran Tile 11 Cover Sticker for Huawei Y5 Lite');
      expect(draft.brand).toBe('ماهوت');
      expect(draft.description).toContain('ماهوت');
      expect(draft.specifications).toHaveLength(7);
      expect(draft.specifications[0]).toEqual({ group: 'مشخصات', title: 'جنس', value: 'پلی کربنات' });
      expect(draft.imageUrls).toHaveLength(4);
      // «کیف و کاور گوشی» has no local match; the breadcrumb's «کالای دیجیتال» does.
      expect(draft.suggestedCategory).toBe('کیف و کاور گوشی');
      expect(draft.suggestedCategoryId).toBe(categoryIds.digital);
    });

    it('Digikala: maps a phone to the local «گوشی موبایل» category', async () => {
      const response = await extract('https://www.digikala.com/product/dkp-18010600/');
      expect(response.status).toBe(200);
      expect(response.body.brand).toBe('سامسونگ');
      expect(response.body.suggestedCategoryId).toBe(categoryIds.mobile);
      expect(response.body.specifications).toContainEqual({ group: 'ارتباطات', title: 'شبکه‌های ارتباطی قابل پشتیبانی', value: 'Wi-Fi، بلوتوث' });
      expect(response.body.imageUrls).toHaveLength(10);
    });

    it('Digikala: an unknown product is 422 NOT_FOUND', async () => {
      const response = await extract('https://www.digikala.com/product/dkp-999999/');
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('IMPORT_NOT_FOUND');
    });

    it('generic: reads a WooCommerce product page', async () => {
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(response.status).toBe(200);
      const draft = response.body;
      expect(draft.source).toBe('GENERIC');
      expect(draft.title).toBe('گوشی موبایل شیائومی Redmi Note 13 ظرفیت 256 گیگابایت');
      expect(draft.brand).toBe('شیائومی');
      expect(draft.suggestedCategoryId).toBe(categoryIds.mobile);
      expect(draft.specifications.map((spec) => spec.title)).toEqual(['وزن', 'حافظه RAM', 'شبکه ارتباطی', 'رنگ']);
      expect(draft.imageUrls).toEqual([
        `${shopOrigin()}/wp-content/uploads/2026/01/redmi-note-13-front.jpg`,
        `${shopOrigin()}/wp-content/uploads/2026/01/redmi-note-13-back.jpg`,
      ]);
    });

    it('generic: a page without product data is 422 NOT_A_PRODUCT', async () => {
      const response = await extract(`${shopOrigin()}/about/`);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('IMPORT_NOT_A_PRODUCT');
    });

    it('generic: a missing page is 422 NOT_FOUND', async () => {
      const response = await extract(`${shopOrigin()}/product/gone/`);
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('IMPORT_NOT_FOUND');
    });

    it('writes an audit entry per extraction', async () => {
      const entries = await prisma.auditLog.findMany({ where: { userId: vendor.userId, entityName: 'ProductImport' } });
      expect(entries.length).toBeGreaterThanOrEqual(3);
    });
  });

  // ─── Full flow: extract → ingest → create ────────────────────────────────

  describe('extract → ingest-images → create product', () => {
    let draft: ExtractResponse;
    let ingested: IngestResponse;

    it('ingests remote images as WebP assets with thumbnails, reporting per-image failures', async () => {
      const extracted = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(extracted.status).toBe(200);
      draft = extracted.body;

      const broken = `${shopOrigin()}/images/not-an-image.jpg`;
      const missing = `${shopOrigin()}/images/missing.jpg`;
      const response = await ingest([...draft.imageUrls, broken, missing]);
      expect(response.status).toBe(200);
      ingested = response.body;

      expect(ingested.items.map((item) => item.sourceUrl)).toEqual(draft.imageUrls);
      expect(ingested.failures).toEqual([
        expect.objectContaining({ sourceUrl: broken, code: 'INVALID_IMAGE' }),
        expect.objectContaining({ sourceUrl: missing, code: 'UPSTREAM_STATUS' }),
      ]);

      const [front, back] = ingested.items;
      expect(front).toMatchObject({ width: 1600, height: 1067 }); // 1800×1200 JPEG, bounded to 1600 px
      expect(back).toMatchObject({ width: 640, height: 640 });

      for (const item of ingested.items) {
        const asset = await prisma.mediaAsset.findUniqueOrThrow({ where: { id: item.id } });
        expect(asset).toMatchObject({ ownerUserId: vendor.userId, purpose: 'product_image', mimeType: 'image/webp', isPublic: true, kind: 'IMAGE' });
        expect(asset.url).toBe(item.url);
        expect(asset.thumbnailUrl).toBe(item.thumbnailUrl);

        const file = await storage.read(asset.path);
        expect(file.subarray(0, 4).toString('latin1')).toBe('RIFF');
        expect(file.subarray(8, 12).toString('latin1')).toBe('WEBP');
        expect(file.length).toBe(asset.sizeBytes);
        const thumbnail = await sharp(await storage.read(asset.thumbnailPath!)).metadata();
        expect(thumbnail).toMatchObject({ format: 'webp', width: 300, height: 300 });
      }
    });

    it('charges the image quota per image in Redis', async () => {
      const used = Number(await redis.client.get(importerRateKeys.images(vendor.userId)));
      expect(used).toBeGreaterThanOrEqual(4);
    });

    it('creates the product from the draft; specifications and gallery persist in PostgreSQL', async () => {
      const response = await request<{ id: string; slug: string; title: string; brand: string | null; specifications: Array<{ groupTitle: string | null; title: string; value: string }> }>(
        '/vendor/products',
        {
          method: 'POST',
          token: vendor.token,
          body: {
            title: `${draft.title} ${RUN}`,
            brand: draft.brand,
            description: draft.description,
            categoryId: draft.suggestedCategoryId,
            basePrice: 185_000_000,
            mediaIds: ingested.items.map((item) => item.id),
            specifications: draft.specifications.map((spec) => ({ groupTitle: spec.group, title: spec.title, value: spec.value })),
            isPublished: true,
            // The only data the vendor types: price, stock and variants.
            variants: [
              { sku: `IMP-${TAG}-BLK`, colorName: 'مشکی', colorHex: '#000000', price: 185_000_000, stockQuantity: 4 },
              { sku: `IMP-${TAG}-BLU`, colorName: 'آبی', colorHex: '#1E40AF', price: 187_000_000, stockQuantity: 2 },
            ],
          },
        },
      );
      expect(response.status).toBe(201);
      expect(response.body.brand).toBe('شیائومی');

      const stored = await prisma.product.findUniqueOrThrow({
        where: { id: response.body.id },
        include: { specifications: { orderBy: { sortOrder: 'asc' } }, media: { orderBy: { sortOrder: 'asc' } }, variants: true },
      });
      expect(stored.categoryId).toBe(categoryIds.mobile);
      expect(stored.specifications.map((spec) => [spec.title, spec.value, spec.sortOrder])).toEqual([
        ['وزن', '188 گرم', 10],
        ['حافظه RAM', '8 گیگابایت', 20],
        ['شبکه ارتباطی', '4G, 3G', 30],
        ['رنگ', 'مشکی، آبی', 40],
      ]);
      expect(stored.media.map((row) => row.mediaAssetId)).toEqual(ingested.items.map((item) => item.id));
      expect(stored.media[0]?.isPrimary).toBe(true);
      expect(stored.variants).toHaveLength(2);

      // The public product page shows the specification table.
      const page = await request<{ specifications: Array<{ groupTitle: string | null; title: string; value: string }> }>(`/products/${response.body.slug}`);
      expect(page.status).toBe(200);
      expect(page.body.specifications.map((spec) => spec.title)).toEqual(['وزن', 'حافظه RAM', 'شبکه ارتباطی', 'رنگ']);
    });

    it('creates a product from a Digikala draft with grouped specifications', async () => {
      const extracted = await extract('https://www.digikala.com/product/dkp-18010600/');
      const images = await ingest([`${shopOrigin()}/wp-content/uploads/2026/01/redmi-note-13-back.jpg`]);
      const response = await request<{ id: string }>('/vendor/products', {
        method: 'POST',
        token: vendor.token,
        body: {
          title: `${extracted.body.title.slice(0, 150)} ${RUN}`,
          brand: extracted.body.brand,
          description: extracted.body.description,
          categoryId: extracted.body.suggestedCategoryId,
          basePrice: 294_000_000,
          mediaIds: images.body.items.map((item) => item.id),
          specifications: extracted.body.specifications.map((spec) => ({ groupTitle: spec.group, title: spec.title, value: spec.value })),
          variants: [{ sku: `IMP-${TAG}-S24`, price: 294_000_000, stockQuantity: 1 }],
        },
      });
      expect(response.status).toBe(201);
      const specs = await prisma.productSpecification.findMany({ where: { productId: response.body.id }, orderBy: { sortOrder: 'asc' } });
      expect(specs).toHaveLength(11);
      expect(new Set(specs.map((spec) => spec.groupTitle))).toEqual(new Set(['دوربین', 'ارتباطات']));
    });
  });

  // ─── Quotas ───────────────────────────────────────────────────────────────

  describe('per-vendor quota', () => {
    it('answers 429 once the extraction quota is used up', async () => {
      await redis.client.set(importerRateKeys.extract(vendor.userId), String(EXTRACT_LIMIT), 'EX', 600);
      const response = await extract(`${shopOrigin()}/product/redmi-note-13/`);
      expect(response.status).toBe(429);
      await redis.client.del(importerRateKeys.extract(vendor.userId));
    });
  });
});
```

### `apps/frontend/src/app/(store)/categories/[slug]/page.tsx`

```tsx
import { ChevronLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Suspense } from 'react';

import { ProductBrowser } from '@/components/catalog/product-browser';
import { SkeletonCards } from '@/components/ui/states';
import { isBnplEnabled, loadCreditPlans } from '@/lib/api/catalog.server';
import { serverApiOrNull } from '@/lib/api/server';
import type { CategoryDetail, CategoryTree, CategoryTreeNode } from '@/lib/api/types';
import { formatCount } from '@/lib/format';
import { PLATFORM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const category = await serverApiOrNull<CategoryDetail>(`categories/${encodeURIComponent(slug)}`).catch(() => null);
  return { title: category ? category.titleFa : 'دسته‌بندی' };
}

function findNode(nodes: CategoryTreeNode[], id: string): CategoryTreeNode | null {
  for (const node of nodes) {
    if (node.id === id) return node;
    const found = findNode(node.children, id);
    if (found) return found;
  }
  return null;
}

export default async function CategoryPage({ params }: Props) {
  const { slug } = await params;
  const [category, tree, plans] = await Promise.all([
    serverApiOrNull<CategoryDetail>(`categories/${encodeURIComponent(slug)}`),
    serverApiOrNull<CategoryTree>('categories/tree'),
    loadCreditPlans(),
  ]);
  if (!category) {
    notFound();
  }
  // Sidebar tree: the root this category belongs to, so siblings and children are one click away.
  const rootId = category.breadcrumbs[0]?.id ?? category.id;
  const root = tree ? findNode(tree.items, rootId) : null;

  return (
    <>
      <nav aria-label="مسیر" className="mb-3 flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          {PLATFORM_NAME}
        </Link>
        {category.breadcrumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronLeft className="size-3" />
            {crumb.id === category.id ? (
              <span className="font-medium text-slate-800">{crumb.titleFa}</span>
            ) : (
              <Link href={`/categories/${crumb.slug}`} className="hover:text-brand-700">
                {crumb.titleFa}
              </Link>
            )}
          </span>
        ))}
      </nav>
      <div className="mb-6 flex flex-col gap-3">
        <h1 className="text-2xl font-black text-slate-900">{category.titleFa}</h1>
        <p className="text-sm text-slate-500">{formatCount(category.totalProductCount)} محصول</p>
        {category.children.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {category.children.map((child) => (
              <Link key={child.id} href={`/categories/${child.slug}`} className="rounded-full border border-slate-300 bg-white px-3 py-1 text-sm text-slate-700 hover:border-brand-400 hover:text-brand-700">
                {child.titleFa} <span className="text-xs text-slate-400">({formatCount(child.totalProductCount)})</span>
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      <Suspense fallback={<SkeletonCards />}>
        <ProductBrowser fixedCategorySlug={category.slug} tree={root ? [root] : []} bnplEnabled={isBnplEnabled(plans)} />
      </Suspense>
    </>
  );
}
```

### `apps/frontend/src/app/(store)/checkout/page.tsx`

```tsx
'use client';

import { CalendarClock, Check, CreditCard, Layers, MapPin, Plus, ShieldCheck } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { AddressFormModal } from '@/components/customer/address-form';
import { useCart } from '@/components/providers/cart-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError, Textarea } from '@/components/ui/field';
import { Card, Money, PageHeader } from '@/components/ui/misc';
import { EmptyState, ErrorState, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AddressList, CheckoutResponse, CreditAccount, CreditPaymentInitiateResponse, CreditPlans, InitiatePaymentResponse, PaymentMethod } from '@/lib/api/types';
import { formatToman } from '@/lib/currency';
import { formatMobile, formatPercent, toPersianDigits } from '@/lib/format';
import { previewInstallments, splitCreditPayment } from '@/lib/installments';
import { useApi } from '@/lib/hooks/use-api';
import { PAYMENT_METHOD_LABELS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

type Stage = 'idle' | 'placing' | 'redirecting';

export default function CheckoutPage() {
  const router = useRouter();
  const { cart, loading: cartLoading, error: cartError, reload: reloadCart } = useCart();
  const addresses = useApi<AddressList>('/customer/addresses');
  const account = useApi<CreditAccount>('/credit/account');
  const plans = useApi<CreditPlans>('/credit/plans');

  const [addressId, setAddressId] = useState<string | null>(null);
  const [addressModal, setAddressModal] = useState(false);
  const [method, setMethod] = useState<PaymentMethod>('CASH_IPG');
  const [planId, setPlanId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [error, setError] = useState<string | null>(null);
  const [placedOrder, setPlacedOrder] = useState<CheckoutResponse | null>(null);

  // Preselect the default address.
  useEffect(() => {
    if (addressId === null && addresses.data && addresses.data.items.length > 0) {
      setAddressId((addresses.data.items.find((item) => item.isDefault) ?? addresses.data.items[0])!.id);
    }
  }, [addresses.data, addressId]);

  useEffect(() => {
    if (planId === null && plans.data && plans.data.items.length > 0) {
      setPlanId([...plans.data.items].sort((a, b) => a.durationMonths - b.durationMonths)[0]!.id);
    }
  }, [plans.data, planId]);

  // 404 CREDIT_ACCOUNT_NOT_FOUND simply means "no credit line yet".
  const creditAccount = account.data && account.data.status === 'ACTIVE' ? account.data : null;
  const creditEnabled = Boolean(plans.data?.creditEnabled && plans.data.items.length > 0);
  const payable = cart?.payableAmount ?? '0';

  const creditSplit = useMemo(() => (creditAccount ? splitCreditPayment('BANK_CREDIT', payable, creditAccount.availableAmount) : null), [creditAccount, payable]);
  const hybridSplit = useMemo(() => (creditAccount ? splitCreditPayment('HYBRID', payable, creditAccount.availableAmount) : null), [creditAccount, payable]);
  const selectedPlan = plans.data?.items.find((plan) => plan.id === planId) ?? null;

  const creditPortion = method === 'BANK_CREDIT' && creditSplit?.ok ? creditSplit.creditAmount : method === 'HYBRID' && hybridSplit?.ok ? hybridSplit.creditAmount : null;
  const schedulePreview = creditPortion && selectedPlan ? previewInstallments(creditPortion, selectedPlan.interestRatePercent, selectedPlan.durationMonths) : null;

  async function pay(order: { parentOrderId: string; orderNumber: string }) {
    if (method === 'CASH_IPG') {
      const payment = await apiPost<InitiatePaymentResponse>('/payments/initiate', { parentOrderId: order.parentOrderId });
      setStage('redirecting');
      window.location.assign(payment.redirectUrl);
      return;
    }
    const result = await apiPost<CreditPaymentInitiateResponse>('/payments/credit/initiate', { parentOrderId: order.parentOrderId, planId, paymentMethod: method });
    if (result.status === 'IPG_REQUIRED' && result.redirectUrl) {
      setStage('redirecting');
      window.location.assign(result.redirectUrl);
      return;
    }
    const query = new URLSearchParams({ orderNumber: result.orderNumber, outcome: 'PAID', paymentId: result.paymentId, parentOrderId: result.parentOrderId });
    router.push(`/payment/result?${query.toString()}`);
  }

  async function submit() {
    if (!addressId) {
      setError('یک نشانی برای ارسال انتخاب یا اضافه کنید.');
      return;
    }
    if (method !== 'CASH_IPG' && !planId) {
      setError('طرح اقساط را انتخاب کنید.');
      return;
    }
    setError(null);
    setStage('placing');
    let order = placedOrder;
    try {
      if (!order) {
        order = await apiPost<CheckoutResponse>('/orders/checkout', { addressId, customerNote: note.trim() || undefined });
        setPlacedOrder(order);
        void reloadCart();
      }
      await pay(order);
    } catch (caught) {
      setStage('idle');
      const apiError = toApiError(caught);
      setError(order ? `سفارش ${order.orderNumber} ثبت شد اما شروع پرداخت ممکن نشد: ${apiError.message}` : apiError.message);
    }
  }

  if (cartLoading && !cart) {
    return (
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]" role="status" aria-label="در حال بارگذاری">
        <div className="flex flex-col gap-4">
          <Skeleton className="h-40" />
          <Skeleton className="h-64" />
        </div>
        <Skeleton className="h-72" />
      </div>
    );
  }
  if (cartError && !cart) {
    return <ErrorState error={cartError} onRetry={() => void reloadCart()} />;
  }
  if (!placedOrder && (!cart || cart.lineCount === 0)) {
    return <EmptyState title="سبد خرید خالی است" description="برای ثبت سفارش ابتدا کالایی به سبد اضافه کنید." action={<LinkButton href="/search">مشاهدهٔ محصولات</LinkButton>} />;
  }
  if (!placedOrder && cart && !cart.canCheckout) {
    return <EmptyState title="سبد خرید نیاز به اصلاح دارد" description="برخی کالاها ناموجود یا غیرفعال شده‌اند." action={<LinkButton href="/cart">بازگشت به سبد خرید</LinkButton>} />;
  }

  const totals = placedOrder
    ? { items: placedOrder.totalItemsAmount, shipping: placedOrder.totalShippingFee, payable: placedOrder.finalPayableAmount, packages: placedOrder.subOrders.length }
    : { items: cart!.itemsSubtotal, shipping: cart!.shippingTotal, payable: cart!.payableAmount, packages: cart!.groups.length };

  return (
    <>
      <PageHeader title="تکمیل خرید" description="نشانی ارسال و شیوهٔ پرداخت را انتخاب کنید." />
      <div className="grid items-start gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex flex-col gap-6">
          <Card
            title={
              <span className="flex items-center gap-2">
                <MapPin className="size-5 text-brand-600" /> نشانی ارسال
              </span>
            }
            action={
              !placedOrder ? (
                <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} onClick={() => setAddressModal(true)}>
                  نشانی جدید
                </Button>
              ) : null
            }
          >
            {addresses.loading && !addresses.data ? (
              <Skeleton className="h-24" />
            ) : addresses.error && !addresses.data ? (
              <ErrorState error={addresses.error} onRetry={() => void addresses.reload()} />
            ) : addresses.data && addresses.data.items.length === 0 ? (
              <EmptyState title="هنوز نشانی ثبت نکرده‌اید" action={<Button onClick={() => setAddressModal(true)}>افزودن نشانی</Button>} />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="نشانی ارسال">
                {addresses.data?.items.map((address) => {
                  const active = address.id === addressId;
                  return (
                    <button
                      key={address.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={Boolean(placedOrder)}
                      onClick={() => setAddressId(address.id)}
                      className={`flex flex-col gap-1 rounded-2xl border p-4 text-start text-sm ${active ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300'}`}
                    >
                      <span className="flex items-center justify-between font-bold text-slate-900">
                        {address.province}، {address.city}
                        {active ? <Check className="size-4 text-brand-600" /> : null}
                      </span>
                      <span className="line-clamp-2 leading-6 text-slate-600">{address.postalAddress}</span>
                      <span className="text-xs text-slate-500">
                        {address.recipientName} · {formatMobile(address.recipientMobile)} · کد پستی {toPersianDigits(address.postalCode)}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </Card>

          <Card
            title={
              <span className="flex items-center gap-2">
                <CreditCard className="size-5 text-brand-600" /> شیوهٔ پرداخت
              </span>
            }
          >
            <div className="flex flex-col gap-3" role="radiogroup" aria-label="شیوهٔ پرداخت">
              <MethodOption
                active={method === 'CASH_IPG'}
                disabled={Boolean(placedOrder)}
                onSelect={() => setMethod('CASH_IPG')}
                icon={<CreditCard className="size-5" />}
                title={PAYMENT_METHOD_LABELS.CASH_IPG}
                description="پرداخت کامل با کارت‌های عضو شتاب از طریق درگاه بانکی."
              />
              {account.loading || plans.loading ? (
                <Skeleton className="h-20" />
              ) : !creditEnabled ? (
                <p className="rounded-xl bg-slate-50 px-4 py-3 text-xs text-slate-500">خرید اعتباری در حال حاضر فعال نیست.</p>
              ) : !creditAccount ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-dashed border-emerald-300 bg-emerald-50/50 px-4 py-3 text-sm">
                  <span className="text-emerald-900">{account.data ? 'حساب اعتباری شما فعال نیست.' : 'برای خرید اقساطی ابتدا اعتبار دریافت کنید.'}</span>
                  <Link href="/customer/credit" className="font-bold text-emerald-700 hover:underline">
                    درخواست اعتبار ←
                  </Link>
                </div>
              ) : (
                <>
                  <MethodOption
                    active={method === 'BANK_CREDIT'}
                    disabled={Boolean(placedOrder) || !creditSplit?.ok}
                    onSelect={() => setMethod('BANK_CREDIT')}
                    icon={<CalendarClock className="size-5" />}
                    title={PAYMENT_METHOD_LABELS.BANK_CREDIT}
                    description={
                      creditSplit?.ok
                        ? `کل مبلغ از اعتبار شما (${formatToman(creditAccount.availableAmount)} در دسترس) کسر و اقساطی پرداخت می‌شود.`
                        : `اعتبار در دسترس (${formatToman(creditAccount.availableAmount)}) برای کل مبلغ کافی نیست؛ پرداخت ترکیبی را انتخاب کنید.`
                    }
                  />
                  <MethodOption
                    active={method === 'HYBRID'}
                    disabled={Boolean(placedOrder) || !hybridSplit?.ok}
                    onSelect={() => setMethod('HYBRID')}
                    icon={<Layers className="size-5" />}
                    title={PAYMENT_METHOD_LABELS.HYBRID}
                    description={
                      hybridSplit?.ok
                        ? `${formatToman(hybridSplit.creditAmount)} از اعتبار کسر و ${formatToman(hybridSplit.cashAmount)} باقی‌مانده با درگاه بانکی پرداخت می‌شود.`
                        : 'اعتبار شما کل مبلغ را پوشش می‌دهد؛ پرداخت ترکیبی لازم نیست.'
                    }
                  />
                </>
              )}
            </div>

            {method !== 'CASH_IPG' && plans.data ? (
              <div className="mt-5 flex flex-col gap-3 border-t border-slate-100 pt-4">
                <p className="text-sm font-bold text-slate-800">طرح اقساط</p>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" role="radiogroup" aria-label="طرح اقساط">
                  {[...plans.data.items]
                    .sort((a, b) => a.durationMonths - b.durationMonths)
                    .map((plan) => (
                      <button
                        key={plan.id}
                        type="button"
                        role="radio"
                        aria-checked={plan.id === planId}
                        disabled={Boolean(placedOrder)}
                        onClick={() => setPlanId(plan.id)}
                        className={`rounded-xl border px-3 py-2 text-sm ${plan.id === planId ? 'border-emerald-600 bg-emerald-50 font-bold ring-2 ring-emerald-100' : 'border-slate-200'}`}
                      >
                        {plan.title}
                        <span className="block text-xs font-normal text-slate-500">
                          {toPersianDigits(plan.durationMonths)} قسط · {Number(plan.interestRatePercent) === 0 ? 'بدون سود' : `سود ${formatPercent(plan.interestRatePercent)}`}
                        </span>
                      </button>
                    ))}
                </div>
                {schedulePreview ? (
                  <p className="rounded-xl bg-emerald-50 px-3 py-2 text-xs leading-6 text-emerald-900">
                    {toPersianDigits(schedulePreview.lines.length)} قسط حدوداً {formatToman(schedulePreview.regularInstallment)}؛ مجموع بازپرداخت اعتبار {formatToman(schedulePreview.totalPayable)}
                    {Number(selectedPlan?.interestRatePercent) === 0 ? ' (بدون سود)' : ` (شامل ${formatToman(schedulePreview.totalInterest)} سود)`}.
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>

          {!placedOrder ? (
            <Card title="توضیحات سفارش (اختیاری)">
              <Textarea value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder="مثلاً: قبل از ارسال تماس بگیرید." aria-label="توضیحات سفارش" />
            </Card>
          ) : null}
        </div>

        <aside className="flex flex-col gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:sticky lg:top-20">
          <h2 className="text-base font-bold">{placedOrder ? `سفارش ${placedOrder.orderNumber}` : 'خلاصهٔ پرداخت'}</h2>
          <dl className="flex flex-col gap-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-slate-600">مبلغ کالاها</dt>
              <dd><Money rials={totals.items} /></dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-slate-600">ارسال ({toPersianDigits(totals.packages)} مرسوله)</dt>
              <dd><Money rials={totals.shipping} /></dd>
            </div>
            {creditPortion ? (
              <div className="flex justify-between text-emerald-800">
                <dt>از اعتبار</dt>
                <dd><Money rials={creditPortion} /></dd>
              </div>
            ) : null}
            <div className="flex justify-between border-t border-slate-100 pt-3 text-base font-black">
              <dt>{method === 'HYBRID' ? 'پرداخت با درگاه' : method === 'BANK_CREDIT' ? 'پرداخت نقدی' : 'مبلغ قابل پرداخت'}</dt>
              <dd>
                <Money rials={method === 'HYBRID' && hybridSplit?.ok ? hybridSplit.cashAmount : method === 'BANK_CREDIT' ? '0' : totals.payable} />
              </dd>
            </div>
          </dl>
          <FormError message={error} />
          <Button size="lg" onClick={() => void submit()} loading={stage !== 'idle'} disabled={!addressId || (method !== 'CASH_IPG' && !creditPortion)}>
            {stage === 'redirecting' ? 'در حال انتقال به درگاه…' : method === 'BANK_CREDIT' ? 'ثبت سفارش و پرداخت اعتباری' : 'ثبت سفارش و پرداخت'}
          </Button>
          {placedOrder ? (
            <Link href={`/customer/orders/${placedOrder.parentOrderId}`} className="text-center text-sm text-brand-700 hover:underline">
              مشاهدهٔ سفارش ثبت‌شده
            </Link>
          ) : null}
          <p className="flex items-start gap-2 text-xs leading-5 text-slate-500">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-600" />
            مبلغ تا تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند و سپس به فروشنده پرداخت می‌شود.
          </p>
        </aside>
      </div>

      {addressModal ? (
        <AddressFormModal
          open
          onClose={() => setAddressModal(false)}
          onSaved={(saved) => {
            setAddressModal(false);
            setAddressId(saved.id);
            void addresses.reload();
          }}
        />
      ) : null}
    </>
  );
}

function MethodOption({ active, disabled, onSelect, icon, title, description }: { active: boolean; disabled: boolean; onSelect: () => void; icon: React.ReactNode; title: string; description: string }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
      className={`flex items-start gap-3 rounded-2xl border p-4 text-start disabled:cursor-not-allowed disabled:opacity-50 ${active ? 'border-brand-600 bg-brand-50/50 ring-2 ring-brand-100' : 'border-slate-200 hover:border-slate-300'}`}
    >
      <span className={`mt-0.5 ${active ? 'text-brand-600' : 'text-slate-500'}`}>{icon}</span>
      <span className="flex flex-col gap-1">
        <span className="text-sm font-bold text-slate-900">{title}</span>
        <span className="text-xs leading-5 text-slate-600">{description}</span>
      </span>
    </button>
  );
}
```

### `apps/frontend/src/app/(store)/page.tsx`

```tsx
import { ArrowLeft, BadgeCheck, CalendarClock, LayoutGrid, ShieldCheck, Sparkles, Truck } from 'lucide-react';
import Link from 'next/link';

import { ProductGrid } from '@/components/catalog/product-card';
import { LinkButton } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { isBnplEnabled, loadCategoryTree, loadCreditPlans, loadProducts } from '@/lib/api/catalog.server';
import type { InstallmentPlan } from '@/lib/api/types';
import { formatCount, formatPercent, toPersianDigits } from '@/lib/format';
import { PLATFORM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const [tree, popular, newest, plans] = await Promise.all([
    loadCategoryTree(),
    loadProducts({ sortBy: 'popular', pageSize: 8, inStockOnly: true }),
    loadProducts({ sortBy: 'newest', pageSize: 8 }),
    loadCreditPlans(),
  ]);
  const bnpl = isBnplEnabled(plans);
  const planItems: InstallmentPlan[] = plans.ok ? plans.data.items : [];
  const zeroInterest = planItems.filter((plan) => Number(plan.interestRatePercent) === 0);

  return (
    <div className="flex flex-col gap-12">
      {/* Hero */}
      <section className="relative overflow-hidden rounded-3xl bg-gradient-to-l from-brand-700 via-brand-600 to-sky-500 px-6 py-12 text-white md:px-12 md:py-16">
        <div className="relative z-10 flex max-w-2xl flex-col gap-5">
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-xs font-medium">
            <Sparkles className="size-3.5" /> بازار آنلاین چندفروشندگی
          </span>
          <h1 className="text-3xl font-black leading-tight md:text-5xl">هر چه می‌خواهید، از فروشگاه‌های تأییدشده؛ نقدی یا اقساطی</h1>
          <p className="text-sm leading-7 text-white/85 md:text-base">
            پول شما تا زمان تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند. سفارش از چند فروشگاه را یک‌جا پرداخت کنید و هر مرسوله را جداگانه پیگیری کنید.
          </p>
          <div className="flex flex-wrap gap-3">
            <LinkButton href="/search" variant="secondary" size="lg" className="border-0 text-brand-700">
              شروع خرید <ArrowLeft className="size-4" />
            </LinkButton>
            {bnpl ? (
              <LinkButton href="/customer/credit" size="lg" className="bg-white/15 hover:bg-white/25">
                دریافت اعتبار خرید
              </LinkButton>
            ) : null}
          </div>
          {tree.ok ? (
            <p className="text-xs text-white/75">
              {formatCount(tree.data.totalProducts)} محصول در {formatCount(tree.data.totalCategories)} دسته‌بندی
            </p>
          ) : null}
        </div>
        <div className="pointer-events-none absolute -bottom-24 -left-24 size-80 rounded-full bg-white/10" />
        <div className="pointer-events-none absolute -top-16 left-40 size-48 rounded-full bg-white/10" />
      </section>

      {/* Trust strip */}
      <section className="grid gap-3 sm:grid-cols-3">
        {[
          { icon: ShieldCheck, title: 'پرداخت امن و امانی', text: 'مبلغ تا تأیید تحویل به فروشنده پرداخت نمی‌شود.' },
          { icon: BadgeCheck, title: 'فروشندگان احرازشده', text: 'مدارک هویتی و حساب بانکی هر فروشگاه بررسی می‌شود.' },
          { icon: Truck, title: 'پیگیری هر مرسوله', text: 'کد رهگیری و وضعیت هر بسته جداگانه نمایش داده می‌شود.' },
        ].map((item) => (
          <div key={item.title} className="flex items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4">
            <item.icon className="mt-0.5 size-6 shrink-0 text-brand-600" />
            <div>
              <p className="text-sm font-bold text-slate-900">{item.title}</p>
              <p className="mt-1 text-xs leading-6 text-slate-500">{item.text}</p>
            </div>
          </div>
        ))}
      </section>

      {/* Category grid */}
      <section className="flex flex-col gap-4">
        <SectionTitle icon={<LayoutGrid className="size-5" />} title="دسته‌بندی‌ها" href="/search" />
        {!tree.ok ? (
          <ErrorState error={tree.message} title="دسته‌بندی‌ها بارگذاری نشد" />
        ) : tree.data.items.length === 0 ? (
          <EmptyState title="هنوز دسته‌بندی فعالی وجود ندارد" />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {tree.data.items.map((category) => (
              <Link
                key={category.id}
                href={`/categories/${category.slug}`}
                className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-4 text-center transition hover:border-brand-300 hover:shadow-sm"
              >
                <span className="flex size-12 items-center justify-center rounded-2xl bg-brand-50 text-lg font-black text-brand-700">{category.titleFa.charAt(0)}</span>
                <span className="text-sm font-bold text-slate-800">{category.titleFa}</span>
                <span className="text-xs text-slate-500">{formatCount(category.totalProductCount)} محصول</span>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* BNPL promo — driven by the live installment plans */}
      {bnpl ? (
        <section className="grid items-center gap-6 overflow-hidden rounded-3xl border border-emerald-200 bg-gradient-to-l from-emerald-50 to-white p-6 md:grid-cols-[1.2fr_1fr] md:p-10">
          <div className="flex flex-col gap-4">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-emerald-600 px-3 py-1 text-xs font-bold text-white">
              <CalendarClock className="size-3.5" /> الان بخر، بعداً پرداخت کن
            </span>
            <h2 className="text-2xl font-black text-slate-900 md:text-3xl">
              {zeroInterest.length > 0
                ? `خرید اقساطی ${toPersianDigits(zeroInterest[0]!.durationMonths)} ماهه بدون سود`
                : 'خرید اقساطی با اعتبار بانکی'}
            </h2>
            <p className="text-sm leading-7 text-slate-600">
              با یک بار دریافت اعتبار از {plans.ok && plans.data.provider ? plans.data.provider.name : 'بانک همکار'}، سبد خرید خود را از همهٔ فروشگاه‌ها به‌صورت اقساطی پرداخت کنید. اگر اعتبارتان کمتر از مبلغ سفارش باشد، باقی‌مانده را با کارت بانکی بپردازید.
            </p>
            <div>
              <LinkButton href="/customer/credit" variant="success">
                درخواست اعتبار
              </LinkButton>
            </div>
          </div>
          <ul className="grid gap-3">
            {planItems.map((plan) => (
              <li key={plan.id} className="flex items-center justify-between rounded-2xl border border-emerald-100 bg-white px-4 py-3">
                <span className="text-sm font-bold text-slate-800">{plan.title}</span>
                <span className="text-xs text-slate-600">
                  {toPersianDigits(plan.durationMonths)} قسط ·{' '}
                  {Number(plan.interestRatePercent) === 0 ? <b className="text-emerald-700">بدون سود</b> : `سود کل ${formatPercent(plan.interestRatePercent)}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Featured (best sellers) */}
      <section className="flex flex-col gap-4">
        <SectionTitle icon={<Sparkles className="size-5" />} title="پرفروش‌ترین‌ها" href="/search?sort=popular" />
        {!popular.ok ? (
          <ErrorState error={popular.message} title="محصولات بارگذاری نشد" />
        ) : popular.data.items.length === 0 ? (
          <EmptyState title="هنوز محصولی برای نمایش وجود ندارد" description="به‌محض انتشار محصولات توسط فروشندگان، این بخش پر می‌شود." />
        ) : (
          <ProductGrid products={popular.data.items} bnplEnabled={bnpl} />
        )}
      </section>

      <section className="flex flex-col gap-4">
        <SectionTitle title="تازه‌ترین محصولات" href="/search?sort=newest" />
        {!newest.ok ? (
          <ErrorState error={newest.message} title="محصولات بارگذاری نشد" />
        ) : newest.data.items.length === 0 ? (
          <EmptyState title="محصولی ثبت نشده است" />
        ) : (
          <ProductGrid products={newest.data.items} bnplEnabled={bnpl} />
        )}
      </section>
    </div>
  );
}

function SectionTitle({ title, href, icon }: { title: string; href: string; icon?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-center gap-2 text-lg font-black text-slate-900 md:text-xl">
        {icon ? <span className="text-brand-600">{icon}</span> : null}
        {title}
      </h2>
      <Link href={href} className="inline-flex items-center gap-1 text-sm font-medium text-brand-700 hover:underline">
        مشاهدهٔ همه <ArrowLeft className="size-4" />
      </Link>
    </div>
  );
}
```

### `apps/frontend/src/app/(store)/products/[slug]/page.tsx`

```tsx
import { AtSign, BadgeCheck, ChevronLeft, Store } from 'lucide-react';
import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { ProductGallery } from '@/components/catalog/product-gallery';
import { ProductSpecifications } from '@/components/catalog/product-specifications';
import { VariantPanel } from '@/components/catalog/variant-panel';
import { Badge } from '@/components/ui/misc';
import { loadCreditPlans } from '@/lib/api/catalog.server';
import { PLATFORM_NAME } from '@/lib/brand';
import { serverApiOrNull } from '@/lib/api/server';
import type { ProductDetail } from '@/lib/api/types';
import { formatDate } from '@/lib/format';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const product = await serverApiOrNull<ProductDetail>(`products/${encodeURIComponent(slug)}`).catch(() => null);
  return product ? { title: product.title, description: product.description?.slice(0, 160) ?? undefined } : { title: 'محصول' };
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params;
  const [product, plans] = await Promise.all([serverApiOrNull<ProductDetail>(`products/${encodeURIComponent(slug)}`), loadCreditPlans()]);
  if (!product) {
    notFound();
  }
  const vendor = product.vendor;
  const instagram = vendor.instagramHandle?.replace(/^@/, '');

  return (
    <div className="flex flex-col gap-8">
      <nav aria-label="مسیر" className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
        <Link href="/" className="hover:text-brand-700">
          {PLATFORM_NAME}
        </Link>
        {product.breadcrumbs.map((crumb) => (
          <span key={crumb.id} className="flex items-center gap-1">
            <ChevronLeft className="size-3" />
            <Link href={`/categories/${crumb.slug}`} className="hover:text-brand-700">
              {crumb.titleFa}
            </Link>
          </span>
        ))}
      </nav>

      <div className="grid gap-8 lg:grid-cols-2">
        <ProductGallery media={product.media} title={product.title} />

        <div className="flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            {product.brand ? <span className="text-sm font-medium text-brand-700">{product.brand}</span> : null}
            <h1 className="text-2xl font-black leading-snug text-slate-900">{product.title}</h1>
          </div>

          {product.variants.length === 0 ? (
            <p className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-600">این محصول در حال حاضر گزینهٔ قابل فروشی ندارد.</p>
          ) : (
            <VariantPanel product={product} plans={plans.ok ? plans.data : null} />
          )}

          {/* Vendor card */}
          <section className="flex items-start gap-4 rounded-2xl border border-slate-200 bg-white p-4" aria-label="فروشنده">
            <div className="relative size-14 shrink-0 overflow-hidden rounded-2xl border border-slate-200 bg-slate-100">
              {vendor.logoUrl ? (
                <Image src={vendor.logoUrl} alt={vendor.storeName} fill sizes="56px" className="object-cover" unoptimized />
              ) : (
                <Store className="m-auto mt-3.5 size-7 text-slate-400" />
              )}
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-bold text-slate-900">{vendor.storeName}</p>
                {vendor.verifiedAt ? (
                  <Badge tone="success">
                    <BadgeCheck className="size-3.5" /> فروشگاه احرازشده
                  </Badge>
                ) : null}
              </div>
              {vendor.verifiedAt ? <p className="text-xs text-slate-500">عضو تأییدشده از {formatDate(vendor.verifiedAt)}</p> : null}
              {vendor.bio ? <p className="line-clamp-3 text-sm leading-6 text-slate-600">{vendor.bio}</p> : null}
              <div className="flex flex-wrap gap-3 text-sm">
                <Link href={`/search?vendor=${encodeURIComponent(vendor.storeSlug)}`} className="font-medium text-brand-700 hover:underline">
                  سایر محصولات این فروشگاه
                </Link>
                {instagram ? (
                  <a href={`https://instagram.com/${encodeURIComponent(instagram)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-pink-700 hover:underline">
                    <AtSign className="size-4" /> اینستاگرام <span dir="ltr">@{instagram}</span>
                  </a>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      </div>

      {product.description ? (
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-3 text-lg font-bold text-slate-900">معرفی محصول</h2>
          <p className="whitespace-pre-line text-sm leading-8 text-slate-700">{product.description}</p>
        </section>
      ) : null}

      <ProductSpecifications specifications={product.specifications ?? []} />
    </div>
  );
}
```

### `apps/frontend/src/app/customer/profile/page.tsx`

```tsx
'use client';

import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { Card, DefinitionList, PageHeader, StatusBadge } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPatch } from '@/lib/api/client';
import type { Me, UpdateProfileInput } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDate, formatMobile, toLatinDigits } from '@/lib/format';
import { isValidNationalCode } from '@/lib/iran';
import { ROLE_LABELS, VENDOR_STATUS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function CustomerProfilePage() {
  const state = useApi<Me>('/auth/me');
  return (
    <>
      <PageHeader title="پروفایل من" description="اطلاعات حساب کاربری و هویتی" />
      <AsyncView state={state} skeleton={<Skeleton className="h-96" />}>
        {(me) => <ProfileForm me={me} onSaved={state.setData} />}
      </AsyncView>
    </>
  );
}

function ProfileForm({ me, onSaved }: { me: Me; onSaved: (me: Me) => void }) {
  const toast = useToast();
  const { refresh } = useSession();
  const router = useRouter();

  // The BFF rotates the session when the account's role changed (store approved → VENDOR).
  async function enterVendorPanel() {
    await refresh();
    router.push('/vendor/dashboard');
    router.refresh();
  }
  const [fullName, setFullName] = useState(me.user.fullName);
  const [email, setEmail] = useState(me.user.email ?? '');
  const [nationalCode, setNationalCode] = useState('');
  const [birthDate, setBirthDate] = useState(me.customerProfile?.birthDate?.slice(0, 10) ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation((body: UpdateProfileInput) => apiPatch<Me & { updated: boolean }>('/auth/profile', body));

  useEffect(() => {
    setFullName(me.user.fullName);
    setEmail(me.user.email ?? '');
  }, [me]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: UpdateProfileInput = {};
    const nextErrors: Record<string, string> = {};
    const name = fullName.trim();
    if (name !== me.user.fullName) {
      if (name.length < 2 || name.length > 120) nextErrors.fullName = 'نام باید بین ۲ تا ۱۲۰ نویسه باشد.';
      body.fullName = name;
    }
    const mail = email.trim();
    if (mail && mail !== (me.user.email ?? '')) {
      if (!EMAIL.test(mail)) nextErrors.email = 'ایمیل معتبر نیست.';
      body.email = mail;
    }
    const code = toLatinDigits(nationalCode.trim());
    if (code) {
      if (!isValidNationalCode(code)) nextErrors.nationalCode = 'کد ملی معتبر نیست.';
      body.nationalCode = code;
    }
    if (birthDate && birthDate !== (me.customerProfile?.birthDate?.slice(0, 10) ?? '')) body.birthDate = birthDate;
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    if (Object.keys(body).length === 0) {
      toast.info('تغییری برای ذخیره وجود ندارد.');
      return;
    }
    const result = await save.run(body);
    if (result) {
      onSaved({ user: result.user, customerProfile: result.customerProfile, vendor: result.vendor });
      setNationalCode('');
      await refresh();
      toast.success('پروفایل ذخیره شد.');
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <Card title="ویرایش اطلاعات">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4 sm:grid-cols-2" noValidate>
          <Field label="نام و نام خانوادگی" error={errors.fullName} required>
            {(id, described) => <Input id={id} aria-describedby={described} value={fullName} onChange={(event) => setFullName(event.target.value)} maxLength={120} />}
          </Field>
          <Field label="ایمیل" error={errors.email}>
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} />}
          </Field>
          <Field label="کد ملی" error={errors.nationalCode} hint="برای درخواست اعتبار خرید اقساطی لازم است. کد ثبت‌شده قابل تغییر نیست.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="numeric" maxLength={10} value={nationalCode} onChange={(event) => setNationalCode(event.target.value)} placeholder="۱۰ رقم" />}
          </Field>
          <Field label="تاریخ تولد (میلادی)">
            {(id) => <Input id={id} type="date" dir="ltr" value={birthDate} onChange={(event) => setBirthDate(event.target.value)} max={new Date().toISOString().slice(0, 10)} />}
          </Field>
          <div className="sm:col-span-2">
            <FormError message={save.error?.message} />
          </div>
          <div className="sm:col-span-2">
            <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
              ذخیرهٔ تغییرات
            </Button>
          </div>
        </form>
      </Card>
      <div className="flex flex-col gap-6">
        <Card title="حساب کاربری">
          <DefinitionList
            items={[
              { label: 'موبایل', value: <span dir="ltr">{formatMobile(me.user.mobile)}</span> },
              { label: 'نقش', value: ROLE_LABELS[me.user.role] },
              { label: 'تاریخ تولد', value: me.customerProfile?.birthDate ? formatDate(me.customerProfile.birthDate) : '—' },
            ]}
          />
        </Card>
        <Card title="فروشگاه">
          {me.vendor ? (
            <div className="flex flex-col gap-3 text-sm">
              <div className="flex items-center justify-between">
                <b>{me.vendor.storeName}</b>
                <StatusBadge value={me.vendor.status} map={VENDOR_STATUS} />
              </div>
              {me.vendor.status === 'APPROVED' ? (
                <Button variant="secondary" onClick={() => void enterVendorPanel()}>
                  ورود به پنل فروشنده
                </Button>
              ) : (
                <p className="text-slate-600">درخواست فروشندگی شما در حال بررسی توسط تیم {PLATFORM_NAME} است.</p>
              )}
            </div>
          ) : (
            <div className="flex flex-col gap-3 text-sm text-slate-600">
              <p>محصولات خود را در {PLATFORM_NAME} بفروشید.</p>
              <LinkButton href="/vendor/register" variant="secondary">
                درخواست فروشندگی
              </LinkButton>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
```

### `apps/frontend/src/app/globals.css`

```css
@import "tailwindcss";

/*
 * Shagerdam design tokens. Vazirmatn is self-hosted through next/font (see
 * src/app/fonts.ts, exposed as --font-vazirmatn); the rest of the stack is the
 * system fallback with full Arabic-script coverage.
 */
@theme {
  --font-sans: var(--font-vazirmatn), "Vazirmatn", "IRANSansX", "IRANSans", "Segoe UI", Tahoma, system-ui, sans-serif;

  --color-brand-50: #eff6ff;
  --color-brand-100: #dbeafe;
  --color-brand-400: #60a5fa;
  --color-brand-500: #2563eb;
  --color-brand-600: #1d4ed8;
  --color-brand-700: #1e40af;
  --color-brand-900: #172554;

  --color-surface: #ffffff;
  --color-surface-muted: #f8fafc;
}

html {
  color-scheme: light;
}

body {
  font-family: var(--font-sans);
}

/* Dual-thumb price slider: two range inputs stacked on one track. */
.range-thumb {
  pointer-events: none;
  appearance: none;
  background: transparent;
}
.range-thumb::-webkit-slider-thumb {
  pointer-events: auto;
  appearance: none;
  height: 1.1rem;
  width: 1.1rem;
  border-radius: 9999px;
  background: #fff;
  border: 3px solid var(--color-brand-600);
  cursor: pointer;
}
.range-thumb::-moz-range-thumb {
  pointer-events: auto;
  height: 1.1rem;
  width: 1.1rem;
  border-radius: 9999px;
  background: #fff;
  border: 3px solid var(--color-brand-600);
  cursor: pointer;
}
```

### `apps/frontend/src/app/layout.tsx`

```tsx
import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import { CartProvider } from '@/components/providers/cart-provider';
import { SessionProvider } from '@/components/providers/session-provider';
import { ToastProvider } from '@/components/providers/toast-provider';
import { getServerSession } from '@/lib/api/server';

import { vazirmatn } from './fonts';
import './globals.css';
import { PLATFORM_NAME, PLATFORM_TAGLINE, PLATFORM_TITLE } from '@/lib/brand';

export const metadata: Metadata = {
  title: { default: PLATFORM_TITLE, template: `%s | ${PLATFORM_NAME}` },
  applicationName: PLATFORM_NAME,
  description: `${PLATFORM_NAME}، ${PLATFORM_TAGLINE} — خرید نقدی یا اقساطی (BNPL) از فروشگاه‌های تأییدشده.`,
};

export const viewport: Viewport = {
  themeColor: '#1d4ed8',
};

export default async function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  // First render already knows who is signed in (no flash of the anonymous header).
  const session = await getServerSession();
  return (
    // dir="rtl" + lang="fa": the whole application is right-to-left; Tailwind's
    // logical utilities (ps-*, pe-*, ms-*, me-*, text-start…) follow it.
    <html lang="fa" dir="rtl" className={vazirmatn.variable}>
      <body className="min-h-screen bg-surface-muted text-slate-900 antialiased">
        <SessionProvider initial={session}>
          <ToastProvider>
            <CartProvider>{children}</CartProvider>
          </ToastProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
```

### `apps/frontend/src/app/status/page.tsx`

```tsx
import { SystemHealthPanel } from '@/components/system-health-panel';
import { getSystemHealthServerSide } from '@/lib/api/health.server';
import type { SystemHealth } from '@/lib/api/health';
import { PLATFORM_NAME } from '@/lib/brand';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  // Server-side call at request time: the page always shows the live state of
  // the API (database, Redis, memory, uptime), never cached output.
  let initialHealth: SystemHealth | null = null;
  let initialError: string | null = null;

  try {
    initialHealth = await getSystemHealthServerSide();
  } catch (error) {
    initialError = error instanceof Error ? error.message : 'خطای نامشخص در ارتباط با API';
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-14">
      <header className="flex flex-col gap-2">
        <p className="text-sm font-medium text-brand-600">{PLATFORM_NAME}</p>
        <h1 className="text-3xl font-bold text-slate-900">وضعیت سامانه</h1>
        <p className="text-sm leading-6 text-slate-600">
          این صفحه وضعیت زندهٔ سرویس‌های زیرساختی (PostgreSQL و Redis) و همچنین وضعیت پردازش API
          را نمایش می‌دهد. داده‌های نمایش‌داده‌شده از خود سرویس‌ها خوانده می‌شوند.
        </p>
      </header>

      <SystemHealthPanel initialHealth={initialHealth} initialError={initialError} />

      <footer className="border-t border-slate-200 pt-4 text-xs text-slate-500">
        <p>{PLATFORM_NAME} — نسخهٔ ۰.۱.۰ | API: مسیر امن از طریق پروکسی Next.js به سرویس Backend</p>
      </footer>
    </main>
  );
}
```

### `apps/frontend/src/app/vendor/disputes/[id]/page.tsx`

```tsx
'use client';

import { Shield, Undo2 } from 'lucide-react';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { DisputeView } from '@/components/disputes/dispute-view';
import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { Checkbox, Field, FormError, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Card, Money, PageHeader } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPost } from '@/lib/api/client';
import type { DisputeActionResult, DisputeVendorAction, VendorDispute } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { WALLET_BUCKET_LABELS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const NOTES_MIN = 10;
const NOTES_MAX = 2000;

export default function VendorDisputeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<VendorDispute>(`/vendor/disputes/${id}`);
  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
      {(dispute) => (
        <>
          <PageHeader
            title="رسیدگی به اختلاف"
            description={`خریدار: ${dispute.customerName} (${dispute.customerMobileMasked})`}
            action={
              <LinkButton href="/vendor/disputes" variant="secondary">
                بازگشت
              </LinkButton>
            }
          />
          <DisputeView
            dispute={dispute}
            extra={
              <>
                <Card title="مبلغ مسدودشده">
                  <p className="text-sm">
                    <Money rials={dispute.hold.amount} className="font-bold" />
                    {dispute.hold.source ? <span className="text-slate-500"> — از صندوق «{WALLET_BUCKET_LABELS[dispute.hold.source]}»</span> : null}
                  </p>
                </Card>
                {dispute.status === 'OPEN' ? <RespondForm disputeId={dispute.id} onDone={() => void state.reload()} /> : null}
              </>
            }
          />
        </>
      )}
    </AsyncView>
  );
}

function RespondForm({ disputeId, onDone }: { disputeId: string; onDone: () => void }) {
  const toast = useToast();
  const [action, setAction] = useState<DisputeVendorAction>('REJECT_WITH_DEFENSE');
  const [notes, setNotes] = useState('');
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [itemReturned, setItemReturned] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const respond = useMutation((body: Record<string, unknown>) => apiPost<DisputeActionResult>(`/vendor/disputes/${disputeId}/respond`, body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = notes.trim();
    if (text.length < NOTES_MIN) return setLocalError(`توضیحات باید دست‌کم ${toPersianDigits(NOTES_MIN)} نویسه باشد.`);
    setLocalError(null);
    const body: Record<string, unknown> = { action, defenseNotes: text };
    if (files.length) body.evidenceUrls = files.map((file) => file.url);
    if (action === 'ACCEPT_RETURN') body.itemReturned = itemReturned;
    const result = await respond.run(body);
    if (result) {
      toast.success(action === 'ACCEPT_RETURN' ? 'مرجوعی پذیرفته شد و مبلغ به خریدار بازگردانده می‌شود.' : 'دفاعیه ثبت شد و پرونده برای داوری ارسال شد.');
      onDone();
    }
  }

  return (
    <Card title="پاسخ شما">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="grid gap-3 sm:grid-cols-2" role="radiogroup" aria-label="نوع پاسخ">
          {(
            [
              { value: 'REJECT_WITH_DEFENSE', title: 'دفاع و ارجاع به داوری', text: `مستندات خود را ارسال کنید؛ کارشناس ${PLATFORM_NAME} رأی می‌دهد.`, icon: Shield },
              { value: 'ACCEPT_RETURN', title: 'پذیرش مرجوعی', text: 'اختلاف به نفع خریدار بسته و مبلغ مرسوله بازگردانده می‌شود.', icon: Undo2 },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={action === option.value}
              onClick={() => setAction(option.value)}
              className={`flex items-start gap-3 rounded-xl border p-3 text-start ${action === option.value ? 'border-brand-500 bg-brand-50 ring-1 ring-brand-300' : 'border-slate-200'}`}
            >
              <option.icon className="mt-0.5 size-5 text-brand-600" />
              <span>
                <span className="block text-sm font-bold">{option.title}</span>
                <span className="text-xs text-slate-600">{option.text}</span>
              </span>
            </button>
          ))}
        </div>
        <Field label={action === 'ACCEPT_RETURN' ? 'توضیح برای خریدار' : 'دفاعیه'} required hint={`${toPersianDigits(notes.trim().length)} / ${toPersianDigits(NOTES_MAX)}`}>
          {(id, described) => <Textarea id={id} aria-describedby={described} rows={5} maxLength={NOTES_MAX} value={notes} onChange={(event) => setNotes(event.target.value)} />}
        </Field>
        <FileDrop upload={{ kind: 'document', purpose: 'dispute_evidence' }} value={files} onChange={setFiles} max={10} accept="image/jpeg,image/png,image/webp,application/pdf" label="تصاویر و مستندات" hint="مثلاً عکس بسته‌بندی پیش از ارسال یا رسید حمل." />
        {action === 'ACCEPT_RETURN' ? <Checkbox label="کالا به فروشگاه بازگشته است (موجودی دوباره افزوده شود)" checked={itemReturned} onChange={(event) => setItemReturned(event.target.checked)} /> : null}
        <FormError message={localError ?? respond.error?.message} />
        <Button type="submit" variant={action === 'ACCEPT_RETURN' ? 'danger' : 'primary'} loading={respond.pending}>
          {action === 'ACCEPT_RETURN' ? 'پذیرش مرجوعی' : 'ارسال دفاعیه'}
        </Button>
      </form>
    </Card>
  );
}
```

### `apps/frontend/src/app/vendor/products/[id]/page.tsx`

```tsx
'use client';

import { ExternalLink, Plus, Save, ShieldAlert } from 'lucide-react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError, Input } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { ProductBasicsFields, validateBasics, type ProductBasics } from '@/components/vendor/product-basics';
import { ProductStatusBadge } from '@/components/vendor/product-status-badge';
import { SpecificationEditor } from '@/components/vendor/specification-editor';
import { VariantEditor } from '@/components/vendor/variant-editor';
import { apiPatch, apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { UpdateProductInput, UpdateVariantInput, VendorProductDetail, VendorVariant } from '@/lib/api/types';
import { rialsToToman, tomanToRials } from '@/lib/currency';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatCount, formatDateTime, toLatinDigits, toPersianDigits } from '@/lib/format';
import { MAX_STOCK, MAX_VARIANTS_PER_PRODUCT, duplicateSkus, variantRowToInput, type VariantRow } from '@/lib/product-form';
import { specRowsFrom, specRowsToInput, type SpecRow } from '@/lib/product-specs';

function basicsFrom(product: VendorProductDetail): ProductBasics {
  return {
    title: product.title,
    slug: product.slug,
    categoryId: product.category.id,
    brand: product.brand ?? '',
    basePriceToman: rialsToToman(product.basePrice),
    description: product.description ?? '',
    // Only gallery entries backed by an uploaded asset can be re-sent as mediaIds.
    images: product.media.filter((media) => media.mediaAssetId !== null).map((media) => ({ id: media.mediaAssetId ?? '', url: media.url, thumbnailUrl: media.thumbnailUrl, name: media.url.split('/').pop() ?? 'image' })),
    isPublished: product.isPublished,
  };
}

export default function EditVendorProductPage() {
  const { id } = useParams<{ id: string }>();
  const state = useApi<VendorProductDetail>(`/vendor/products/${id}`);
  return (
    <AsyncView state={state} skeleton={<Skeleton className="h-[600px]" />}>
      {(product) => <Editor key={product.updatedAt} product={product} reload={state.reload} />}
    </AsyncView>
  );
}

function Editor({ product, reload }: { product: VendorProductDetail; reload: () => Promise<void> }) {
  const toast = useToast();
  const [basics, setBasics] = useState<ProductBasics>(() => basicsFrom(product));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [newRows, setNewRows] = useState<VariantRow[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [addingVariants, setAddingVariants] = useState(false);
  const [specRows, setSpecRows] = useState<SpecRow[]>(() => specRowsFrom(product.specifications));
  const [specError, setSpecError] = useState<string | null>(null);
  const saveSpecs = useMutation((body: UpdateProductInput) => apiPatch<VendorProductDetail>(`/vendor/products/${product.id}`, body));
  const save = useMutation((body: UpdateProductInput) => apiPatch<VendorProductDetail>(`/vendor/products/${product.id}`, body));
  const blocked = product.moderation.isBlockedByAdmin;

  async function saveBasics(event: FormEvent) {
    event.preventDefault();
    const { errors: fieldErrors, payload } = validateBasics(basics);
    setErrors(fieldErrors);
    if (!payload) return;
    const body: UpdateProductInput = { ...payload };
    if (blocked) delete body.isPublished; // staff block wins; publishing is refused anyway
    const result = await save.run(body);
    if (result) {
      toast.success('مشخصات محصول ذخیره شد.');
      await reload();
    }
  }

  async function saveSpecifications(event: FormEvent) {
    event.preventDefault();
    const specs = specRowsToInput(specRows);
    if (!specs.ok) return setSpecError(specs.error);
    setSpecError(null);
    const result = await saveSpecs.run({ specifications: specs.value });
    if (result) {
      toast.success('مشخصات فنی ذخیره شد.');
      await reload();
    }
  }

  async function addVariants() {
    const existing = new Set(product.variants.map((variant) => variant.sku));
    const duplicates = duplicateSkus(newRows).concat(newRows.map((row) => row.sku.trim().toUpperCase()).filter((sku) => existing.has(sku)));
    if (duplicates.length) return setRowsError(`SKU تکراری: ${[...new Set(duplicates)].join('، ')}`);
    const inputs = [];
    for (const row of newRows) {
      const result = variantRowToInput(row);
      if (!result.ok) return setRowsError(result.error);
      inputs.push({ key: row.key, input: result.value });
    }
    setRowsError(null);
    setAddingVariants(true);
    // One POST per variant; rows that succeed are removed so a retry only resends the failures.
    const failed = new Set<string>();
    let firstError: string | null = null;
    for (const { key, input } of inputs) {
      try {
        await apiPost(`/vendor/products/${product.id}/variants`, input);
      } catch (caught) {
        failed.add(key);
        firstError ??= `${input.sku}: ${toApiError(caught).message}`;
      }
    }
    setAddingVariants(false);
    const added = inputs.length - failed.size;
    if (added > 0) toast.success(`${toPersianDigits(added)} تنوع افزوده شد.`);
    if (firstError) {
      setRowsError(firstError);
      setNewRows((rows) => rows.filter((row) => failed.has(row.key)));
    }
    if (added > 0) await reload();
  }

  return (
    <>
      <PageHeader
        title={product.title}
        description={`آخرین به‌روزرسانی: ${formatDateTime(product.updatedAt)}`}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <ProductStatusBadge product={product} />
            {product.isPublished && !blocked ? (
              <Link href={`/products/${product.slug}`} target="_blank" className="flex items-center gap-1 text-sm text-brand-700 hover:underline">
                مشاهده در فروشگاه <ExternalLink className="size-4" />
              </Link>
            ) : null}
            <LinkButton href="/vendor/products" variant="secondary">
              بازگشت
            </LinkButton>
          </div>
        }
      />
      {blocked ? (
        <div className="mb-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
          <ShieldAlert className="mt-0.5 size-5 shrink-0" />
          <div>
            این محصول توسط مدیریت مسدود شده و در فروشگاه نمایش داده نمی‌شود.
            {product.moderation.blockedReason ? <div className="mt-1">علت: {product.moderation.blockedReason}</div> : null}
          </div>
        </div>
      ) : null}

      <div className="flex flex-col gap-6">
        <Card title="مشخصات و تصاویر">
          <form onSubmit={(event) => void saveBasics(event)} noValidate className="flex flex-col gap-4">
            <ProductBasicsFields value={basics} onChange={setBasics} errors={errors} />
            <FormError message={save.error?.message} />
            <div>
              <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
                ذخیرهٔ مشخصات
              </Button>
            </div>
          </form>
        </Card>

        <Card title="مشخصات فنی">
          <form onSubmit={(event) => void saveSpecifications(event)} noValidate className="flex flex-col gap-4">
            <SpecificationEditor rows={specRows} onChange={setSpecRows} />
            <FormError message={specError ?? saveSpecs.error?.message} />
            <div>
              <Button type="submit" loading={saveSpecs.pending} icon={<Save className="size-4" />}>
                ذخیرهٔ مشخصات فنی
              </Button>
            </div>
          </form>
        </Card>

        <Card title={`تنوع‌ها (${toPersianDigits(product.variants.length)})`}>
          <div className="overflow-x-auto rounded-xl border border-slate-200">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="px-2 py-2 text-start font-medium">SKU</th>
                  <th className="px-2 py-2 text-start font-medium">رنگ / سایز</th>
                  <th className="px-2 py-2 text-start font-medium">قیمت (تومان)</th>
                  <th className="px-2 py-2 text-start font-medium">قبل از تخفیف</th>
                  <th className="px-2 py-2 text-start font-medium">موجودی</th>
                  <th className="px-2 py-2 text-start font-medium">رزرو / قابل فروش</th>
                  <th className="px-2 py-2 text-start font-medium">فعال</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {product.variants.map((variant) => (
                  <VariantRowEditor key={`${variant.id}-${variant.updatedAt}`} variant={variant} onSaved={() => void reload()} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="افزودن تنوع جدید">
          <VariantEditor rows={newRows} onChange={setNewRows} skuPrefix={product.slug} capacity={MAX_VARIANTS_PER_PRODUCT - product.variants.length} />
          <FormError message={rowsError} />
          {newRows.length > 0 ? (
            <div className="mt-4">
              <Button loading={addingVariants} icon={<Plus className="size-4" />} onClick={() => void addVariants()}>
                ثبت {toPersianDigits(newRows.length)} تنوع جدید
              </Button>
            </div>
          ) : null}
        </Card>
      </div>
    </>
  );
}

function VariantRowEditor({ variant, onSaved }: { variant: VendorVariant; onSaved: () => void }) {
  const toast = useToast();
  const [price, setPrice] = useState(rialsToToman(variant.price));
  const [compare, setCompare] = useState(variant.compareAtPrice ? rialsToToman(variant.compareAtPrice) : '');
  const [stock, setStock] = useState(String(variant.stockQuantity));
  const [active, setActive] = useState(variant.isActive);
  const [error, setError] = useState<string | null>(null);
  const update = useMutation((body: UpdateVariantInput) => apiPatch<VendorVariant>(`/vendor/products/variants/${variant.id}`, body));

  async function saveRow() {
    const body: UpdateVariantInput = {};
    try {
      const nextPrice = tomanToRials(price);
      if (nextPrice <= 0) return setError('قیمت باید بیشتر از صفر باشد.');
      if (nextPrice !== Number(variant.price)) body.price = nextPrice;
      const nextCompare = compare.trim() ? tomanToRials(compare) : null;
      if (nextCompare !== null && nextCompare <= nextPrice) return setError('قیمت قبل از تخفیف باید بیشتر از قیمت فروش باشد.');
      if (nextCompare !== (variant.compareAtPrice === null ? null : Number(variant.compareAtPrice))) body.compareAtPrice = nextCompare;
    } catch (caught) {
      return setError(caught instanceof Error ? caught.message : 'مبلغ نامعتبر است.');
    }
    const stockText = toLatinDigits(stock.trim());
    if (!/^\d+$/.test(stockText) || Number(stockText) > MAX_STOCK) return setError('موجودی باید عدد صحیح نامنفی باشد.');
    if (Number(stockText) !== variant.stockQuantity) body.stockQuantity = Number(stockText);
    if (active !== variant.isActive) body.isActive = active;
    setError(null);
    if (Object.keys(body).length === 0) return;
    const result = await update.run(body);
    if (result) {
      toast.success(`تنوع ${variant.sku} به‌روزرسانی شد.`);
      onSaved();
    }
  }

  const dirty =
    price !== rialsToToman(variant.price) || compare !== (variant.compareAtPrice ? rialsToToman(variant.compareAtPrice) : '') || stock !== String(variant.stockQuantity) || active !== variant.isActive;

  return (
    <>
      <tr className={variant.isActive ? '' : 'bg-slate-50 text-slate-500'}>
        <td className="px-2 py-1.5">
          <span dir="ltr" className="font-mono text-xs">
            {variant.sku}
          </span>
        </td>
        <td className="px-2 py-1.5">
          <span className="flex items-center gap-1.5 text-xs">
            {variant.colorHex ? <span className="size-3 rounded-full border" style={{ background: variant.colorHex }} /> : null}
            {[variant.colorName, variant.size].filter(Boolean).join(' / ') || '—'}
          </span>
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="قیمت" dir="ltr" value={price} onChange={(event) => setPrice(event.target.value)} className="h-9 w-32" />
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="قیمت قبل از تخفیف" dir="ltr" value={compare} onChange={(event) => setCompare(event.target.value)} className="h-9 w-32" />
        </td>
        <td className="px-2 py-1.5">
          <Input aria-label="موجودی" dir="ltr" inputMode="numeric" value={stock} onChange={(event) => setStock(event.target.value)} className="h-9 w-24" />
        </td>
        <td className="px-2 py-1.5 text-xs">
          {formatCount(variant.reservedQuantity)} / <b>{formatCount(variant.availableQuantity)}</b>
        </td>
        <td className="px-2 py-1.5">
          <input type="checkbox" aria-label="فعال" checked={active} onChange={(event) => setActive(event.target.checked)} className="size-4 accent-brand-600" />
        </td>
        <td className="px-2 py-1.5">
          <Button size="sm" variant={dirty ? 'primary' : 'ghost'} disabled={!dirty} loading={update.pending} onClick={() => void saveRow()}>
            ذخیره
          </Button>
        </td>
      </tr>
      {error ?? update.error ? (
        <tr>
          <td colSpan={8} className="px-2 pb-2 text-xs text-rose-700">
            {error ?? update.error?.message}
          </td>
        </tr>
      ) : null}
    </>
  );
}
```

### `apps/frontend/src/app/vendor/products/new/page.tsx`

```tsx
'use client';

import { Save } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useToast } from '@/components/providers/toast-provider';
import { Button, LinkButton } from '@/components/ui/button';
import { FormError } from '@/components/ui/field';
import { Card, PageHeader } from '@/components/ui/misc';
import { EMPTY_BASICS, ProductBasicsFields, validateBasics, type ProductBasics } from '@/components/vendor/product-basics';
import { ProductImportPanel, type ImportResult } from '@/components/vendor/product-import-panel';
import { SpecificationEditor } from '@/components/vendor/specification-editor';
import { VariantEditor } from '@/components/vendor/variant-editor';
import { apiPost } from '@/lib/api/client';
import type { CreateProductInput, CreateVariantInput, VendorProductDetail } from '@/lib/api/types';
import { useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { MAX_MEDIA_PER_PRODUCT, duplicateSkus, variantRowToInput, type VariantRow } from '@/lib/product-form';
import { draftSpecRows, imageFailureMessage, specRowsToInput, type SpecRow } from '@/lib/product-specs';

const FORM_ID = 'new-product-form';

export default function NewVendorProductPage() {
  const router = useRouter();
  const toast = useToast();
  const [basics, setBasics] = useState<ProductBasics>(EMPTY_BASICS);
  const [specRows, setSpecRows] = useState<SpecRow[]>([]);
  const [rows, setRows] = useState<VariantRow[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [specError, setSpecError] = useState<string | null>(null);
  const [variantError, setVariantError] = useState<string | null>(null);
  const [importNotes, setImportNotes] = useState<string[]>([]);
  const create = useMutation((body: CreateProductInput) => apiPost<VendorProductDetail>('/vendor/products', body));

  const hasExistingData = Boolean(basics.title.trim() || basics.brand.trim() || basics.description.trim() || specRows.length);

  function applyImport({ draft, images, failures }: ImportResult) {
    setBasics((current) => ({
      ...current,
      title: draft.title.slice(0, 200),
      brand: (draft.brand ?? '').slice(0, 80),
      description: draft.description ?? '',
      categoryId: draft.suggestedCategoryId ?? current.categoryId,
      images: [...current.images, ...images].slice(0, MAX_MEDIA_PER_PRODUCT),
    }));
    setSpecRows(draftSpecRows(draft));
    setErrors({});
    setSpecError(null);

    const notes: string[] = [];
    if (!draft.suggestedCategoryId) notes.push('دسته‌بندی منطبقی پیدا نشد؛ دسته را انتخاب کنید.');
    for (const failure of failures) notes.push(`تصویر «${failure.sourceUrl.split('/').pop() ?? failure.sourceUrl}» منتقل نشد: ${imageFailureMessage(failure.code)}`);
    setImportNotes(notes);
    toast.success(
      `اطلاعات کالا اعمال شد: ${toPersianDigits(draft.specifications.length)} ردیف مشخصات و ${toPersianDigits(images.length)} تصویر. قیمت، موجودی و تنوع‌ها را وارد کنید.`,
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const { errors: fieldErrors, payload } = validateBasics(basics);
    setErrors(fieldErrors);
    const specs = specRowsToInput(specRows);
    setSpecError(specs.ok ? null : specs.error);
    let rowError: string | null = null;
    const variants: CreateVariantInput[] = [];
    if (rows.length === 0) rowError = 'دست‌کم یک تنوع (رنگ/سایز/قیمت/موجودی) لازم است.';
    const duplicates = duplicateSkus(rows);
    if (!rowError && duplicates.length) rowError = `SKU تکراری: ${duplicates.join('، ')}`;
    for (const row of rows) {
      if (rowError) break;
      const result = variantRowToInput(row);
      if (result.ok) variants.push(result.value);
      else rowError = result.error;
    }
    setVariantError(rowError);
    if (!payload || !specs.ok || rowError) return;
    const product = await create.run({ ...payload, specifications: specs.value, variants });
    if (product) {
      toast.success('محصول ذخیره شد.');
      router.push(`/vendor/products/${product.id}`);
    }
  }

  const skuPrefix = basics.slug || basics.title;

  return (
    <>
      <PageHeader
        title="افزودن محصول"
        action={
          <div className="flex gap-2">
            <LinkButton href="/vendor/products" variant="secondary">
              انصراف
            </LinkButton>
            <Button type="submit" form={FORM_ID} loading={create.pending} icon={<Save className="size-4" />}>
              ذخیرهٔ محصول
            </Button>
          </div>
        }
      />
      <div className="flex flex-col gap-6">
        {/* Outside the product <form>: the import panel has its own form, and forms must not nest. */}
        <Card title="واردکردن هوشمند از لینک کالا">
          <ProductImportPanel imageSlots={MAX_MEDIA_PER_PRODUCT - basics.images.length} hasExistingData={hasExistingData} onApply={applyImport} />
          {importNotes.length > 0 ? (
            <ul className="mt-3 list-inside list-disc rounded-xl bg-amber-50 px-4 py-2 text-sm text-amber-800">
              {importNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
        </Card>
        <form id={FORM_ID} onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-6">
          <Card title="مشخصات و تصاویر">
            <ProductBasicsFields value={basics} onChange={setBasics} errors={errors} />
          </Card>
          <Card title="مشخصات فنی">
            <SpecificationEditor rows={specRows} onChange={setSpecRows} />
            <FormError message={specError} />
          </Card>
          <Card title="تنوع‌ها (رنگ × سایز)">
            <VariantEditor rows={rows} onChange={setRows} skuPrefix={skuPrefix} />
          </Card>
          <FormError message={variantError ?? create.error?.message} />
          <div className="flex justify-end">
            <Button type="submit" size="lg" loading={create.pending} icon={<Save className="size-5" />}>
              ذخیرهٔ محصول
            </Button>
          </div>
        </form>
      </div>
    </>
  );
}
```

### `apps/frontend/src/app/vendor/register/page.tsx`

```tsx
'use client';

import { BadgeCheck, FileCheck2, Save, Store } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { useToast } from '@/components/providers/toast-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input, Textarea } from '@/components/ui/field';
import { FileDrop, type UploadedFile } from '@/components/ui/file-drop';
import { Card, DefinitionList, PageHeader, StatusBadge } from '@/components/ui/misc';
import { AsyncView, Skeleton } from '@/components/ui/states';
import { apiPatch, apiPost } from '@/lib/api/client';
import type { RegisterVendorInput, VendorProfile } from '@/lib/api/types';
import { useApi, useMutation } from '@/lib/hooks/use-api';
import { formatDateTime } from '@/lib/format';
import { isValidSheba } from '@/lib/iran';
import { VENDOR_STATUS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DOC_ACCEPT = 'image/jpeg,image/png,image/webp,application/pdf';

function normaliseIban(value: string): string {
  return value.replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Vendor onboarding and store settings:
 *  1. no store yet → POST /vendors/register;
 *  2. store exists → KYC documents (POST /vendors/verification/documents) and
 *     profile editing (PATCH /vendors/me). Staff review the documents in /admin/vendors.
 */
export default function VendorRegisterPage() {
  const { me } = useSession();
  const hasStore = Boolean(me?.vendor);
  return hasStore ? <StoreSettings /> : <RegisterForm />;
}

function RegisterForm() {
  const toast = useToast();
  const { refresh } = useSession();
  const router = useRouter();
  const [form, setForm] = useState<RegisterVendorInput>({ storeName: '', storeSlug: '', instagramHandle: '', bio: '', bankIban: 'IR', bankAccountHolder: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const register = useMutation((body: RegisterVendorInput) => apiPost<VendorProfile>('/vendors/register', body));
  const set = (key: keyof RegisterVendorInput) => (value: string) => setForm((current) => ({ ...current, [key]: value }));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const iban = normaliseIban(form.bankIban);
    const next: Record<string, string> = {};
    if (form.storeName.trim().length < 2) next.storeName = 'نام فروشگاه دست‌کم ۲ نویسه است.';
    if (!SLUG.test(form.storeSlug) || form.storeSlug.length < 3) next.storeSlug = 'فقط حروف کوچک لاتین، رقم و خط تیره (دست‌کم ۳ نویسه).';
    if (!isValidSheba(iban)) next.bankIban = 'شمارهٔ شبا معتبر نیست.';
    if (form.bankAccountHolder.trim().length < 3) next.bankAccountHolder = 'نام صاحب حساب را وارد کنید.';
    setErrors(next);
    if (Object.keys(next).length) return;
    const body: RegisterVendorInput = {
      storeName: form.storeName.trim(),
      storeSlug: form.storeSlug,
      bankIban: iban,
      bankAccountHolder: form.bankAccountHolder.trim(),
      ...(form.instagramHandle?.trim() ? { instagramHandle: form.instagramHandle.trim().replace(/^@/, '') } : {}),
      ...(form.bio?.trim() ? { bio: form.bio.trim() } : {}),
    };
    const vendor = await register.run(body);
    if (vendor) {
      toast.success('فروشگاه ساخته شد. اکنون مدارک احراز هویت را بارگذاری کنید.');
      await refresh();
      router.refresh();
    }
  }

  return (
    <>
      <PageHeader title="فروشنده شوید" description={`ثبت فروشگاه در ${PLATFORM_NAME} — پس از بارگذاری مدارک و تأیید کارشناسان، پنل فروشنده فعال می‌شود.`} />
      <Card title="اطلاعات فروشگاه">
        <form onSubmit={(event) => void submit(event)} className="grid gap-4 md:grid-cols-2" noValidate>
          <Field label="نام فروشگاه" required error={errors.storeName}>
            {(id, described) => <Input id={id} aria-describedby={described} maxLength={120} value={form.storeName} onChange={(event) => set('storeName')(event.target.value)} />}
          </Field>
          <Field label="نامک (آدرس فروشگاه)" required error={errors.storeSlug} hint="مثال: pars-digital">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={140} value={form.storeSlug} onChange={(event) => set('storeSlug')(event.target.value.toLowerCase())} />}
          </Field>
          <Field label="شمارهٔ شبا" required error={errors.bankIban} hint="تسویه‌ها فقط به این حساب واریز می‌شود.">
            {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={34} value={form.bankIban} onChange={(event) => set('bankIban')(event.target.value)} />}
          </Field>
          <Field label="نام صاحب حساب" required error={errors.bankAccountHolder}>
            {(id, described) => <Input id={id} aria-describedby={described} maxLength={120} value={form.bankAccountHolder} onChange={(event) => set('bankAccountHolder')(event.target.value)} />}
          </Field>
          <Field label="اینستاگرام (اختیاری)">{(id) => <Input id={id} dir="ltr" maxLength={60} placeholder="@store" value={form.instagramHandle} onChange={(event) => set('instagramHandle')(event.target.value)} />}</Field>
          <Field label="معرفی فروشگاه (اختیاری)" className="md:col-span-2">
            {(id) => <Textarea id={id} rows={3} maxLength={2000} value={form.bio} onChange={(event) => set('bio')(event.target.value)} />}
          </Field>
          <div className="md:col-span-2">
            <FormError message={register.error?.message} />
          </div>
          <div className="md:col-span-2">
            <Button type="submit" size="lg" loading={register.pending} icon={<Store className="size-5" />}>
              ساخت فروشگاه
            </Button>
          </div>
        </form>
      </Card>
    </>
  );
}

function StoreSettings() {
  const state = useApi<VendorProfile>('/vendors/me');
  return (
    <>
      <PageHeader title="فروشگاه و مدارک" description="وضعیت احراز هویت، مدارک و مشخصات فروشگاه" />
      <AsyncView state={state} skeleton={<Skeleton className="h-[480px]" />}>
        {(vendor) => (
          <div className="grid gap-6 lg:grid-cols-2">
            <VerificationCard vendor={vendor} onChange={state.setData} />
            <ProfileCard vendor={vendor} onChange={state.setData} />
          </div>
        )}
      </AsyncView>
    </>
  );
}

function VerificationCard({ vendor, onChange }: { vendor: VendorProfile; onChange: (vendor: VendorProfile) => void }) {
  const toast = useToast();
  const [nationalId, setNationalId] = useState<UploadedFile[]>([]);
  const [license, setLicense] = useState<UploadedFile[]>([]);
  const [bankProof, setBankProof] = useState<UploadedFile[]>([]);
  const submit = useMutation((body: Record<string, string>) => apiPost<VendorProfile>('/vendors/verification/documents', body));
  const verification = vendor.verification;
  const awaitingReview = verification !== null && verification.reviewedAt === null;

  async function send() {
    const [id] = nationalId;
    if (!id) {
      toast.error('تصویر کارت ملی الزامی است.');
      return;
    }
    const body: Record<string, string> = { nationalIdCardUrl: id.url };
    if (license[0]) body.businessLicenseUrl = license[0].url;
    if (bankProof[0]) body.bankAccountProofUrl = bankProof[0].url;
    const result = await submit.run(body);
    if (result) {
      onChange(result);
      setNationalId([]);
      setLicense([]);
      setBankProof([]);
      toast.success('مدارک ارسال شد و در صف بررسی قرار گرفت.');
    }
  }

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <BadgeCheck className="size-5 text-brand-600" /> احراز هویت
        </span>
      }
      action={<StatusBadge value={vendor.status} map={VENDOR_STATUS} />}
    >
      <div className="flex flex-col gap-4">
        {vendor.status === 'APPROVED' ? <p className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800">فروشگاه در {vendor.verifiedAt ? formatDateTime(vendor.verifiedAt) : '—'} تأیید شد.</p> : null}
        {verification?.rejectionReason ? <p className="rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-800">علت رد: {verification.rejectionReason}</p> : null}
        {verification ? (
          <DefinitionList
            items={[
              { label: 'آخرین ارسال', value: formatDateTime(verification.createdAt) },
              { label: 'بررسی', value: verification.reviewedAt ? `${formatDateTime(verification.reviewedAt)}${verification.reviewedByName ? ` — ${verification.reviewedByName}` : ''}` : 'در انتظار بررسی' },
              {
                label: 'مدارک',
                value: (
                  <span className="flex flex-wrap gap-2">
                    <a className="text-brand-700 underline" href={verification.nationalIdCardUrl} target="_blank" rel="noopener noreferrer">
                      کارت ملی
                    </a>
                    {verification.businessLicenseUrl ? (
                      <a className="text-brand-700 underline" href={verification.businessLicenseUrl} target="_blank" rel="noopener noreferrer">
                        جواز کسب
                      </a>
                    ) : null}
                    {verification.bankAccountProofUrl ? (
                      <a className="text-brand-700 underline" href={verification.bankAccountProofUrl} target="_blank" rel="noopener noreferrer">
                        مالکیت حساب
                      </a>
                    ) : null}
                  </span>
                ),
              },
            ]}
          />
        ) : (
          <p className="text-sm text-slate-600">برای فعال شدن فروشگاه، مدارک زیر را بارگذاری کنید.</p>
        )}
        {vendor.status !== 'APPROVED' && !awaitingReview ? (
          <>
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_national_id' }} value={nationalId} onChange={setNationalId} max={1} accept={DOC_ACCEPT} label="کارت ملی (الزامی)" />
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_business_license' }} value={license} onChange={setLicense} max={1} accept={DOC_ACCEPT} label="جواز کسب (اختیاری)" />
            <FileDrop upload={{ kind: 'document', purpose: 'kyc_bank_proof' }} value={bankProof} onChange={setBankProof} max={1} accept={DOC_ACCEPT} label="گواهی مالکیت حساب (اختیاری)" />
            <FormError message={submit.error?.message} />
            <Button loading={submit.pending} icon={<FileCheck2 className="size-4" />} onClick={() => void send()}>
              ارسال مدارک برای بررسی
            </Button>
          </>
        ) : null}
        {awaitingReview && vendor.status !== 'APPROVED' ? <p className="rounded-xl bg-sky-50 px-3 py-2 text-sm text-sky-900">مدارک شما دریافت شده و در صف بررسی کارشناسان است.</p> : null}
      </div>
    </Card>
  );
}

function ProfileCard({ vendor, onChange }: { vendor: VendorProfile; onChange: (vendor: VendorProfile) => void }) {
  const toast = useToast();
  const { refresh } = useSession();
  const [storeName, setStoreName] = useState(vendor.storeName);
  const [bio, setBio] = useState(vendor.bio ?? '');
  const [instagram, setInstagram] = useState(vendor.instagramHandle ?? '');
  const [logo, setLogo] = useState<UploadedFile[]>([]);
  const [iban, setIban] = useState(vendor.bankIban);
  const [ibanProof, setIbanProof] = useState<UploadedFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation((body: Record<string, string>) => apiPatch<VendorProfile>('/vendors/me', body));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const body: Record<string, string> = {};
    if (storeName.trim() !== vendor.storeName) body.storeName = storeName.trim();
    if (bio.trim() !== (vendor.bio ?? '')) body.bio = bio.trim();
    const handle = instagram.trim().replace(/^@/, '');
    if (handle !== (vendor.instagramHandle ?? '')) body.instagramHandle = handle;
    if (logo[0]) body.logoUrl = logo[0].url;
    const nextIban = normaliseIban(iban);
    if (nextIban !== vendor.bankIban) {
      if (!isValidSheba(nextIban)) return setError('شمارهٔ شبا معتبر نیست.');
      if (!ibanProof[0]) return setError('برای تغییر شبا، گواهی مالکیت حساب جدید را بارگذاری کنید.');
      body.bankIban = nextIban;
      body.bankAccountProofUrl = ibanProof[0].url;
    }
    setError(null);
    if (Object.keys(body).length === 0) {
      toast.info('تغییری برای ذخیره وجود ندارد.');
      return;
    }
    const result = await save.run(body);
    if (result) {
      onChange(result);
      setLogo([]);
      setIbanProof([]);
      await refresh();
      toast.success(body.bankIban ? 'ذخیره شد. تا تأیید شبای جدید، فروشگاه در وضعیت بررسی است.' : 'مشخصات فروشگاه ذخیره شد.');
    }
  }

  const ibanChanged = normaliseIban(iban) !== vendor.bankIban;

  return (
    <Card title="مشخصات فروشگاه">
      <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
        <div className="flex items-center gap-3 text-sm text-slate-600">
          {vendor.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- media URL from the API
            <img src={vendor.logoUrl} alt="" className="size-14 rounded-xl border object-cover" />
          ) : null}
          <span dir="ltr">/{vendor.storeSlug}</span>
        </div>
        <Field label="نام فروشگاه">{(id) => <Input id={id} maxLength={120} value={storeName} onChange={(event) => setStoreName(event.target.value)} />}</Field>
        <Field label="اینستاگرام">{(id) => <Input id={id} dir="ltr" maxLength={60} value={instagram} onChange={(event) => setInstagram(event.target.value)} />}</Field>
        <Field label="معرفی">{(id) => <Textarea id={id} rows={3} maxLength={2000} value={bio} onChange={(event) => setBio(event.target.value)} />}</Field>
        <FileDrop upload={{ kind: 'image', purpose: 'store_logo' }} value={logo} onChange={setLogo} max={1} accept="image/jpeg,image/png,image/webp" label="لوگوی جدید" />
        <Field label="شمارهٔ شبا" hint="تغییر شبا نیازمند گواهی مالکیت و تأیید دوباره است.">
          {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" maxLength={34} value={iban} onChange={(event) => setIban(event.target.value)} />}
        </Field>
        {ibanChanged ? <FileDrop upload={{ kind: 'document', purpose: 'kyc_bank_proof' }} value={ibanProof} onChange={setIbanProof} max={1} accept={DOC_ACCEPT} label="گواهی مالکیت حساب جدید" /> : null}
        <FormError message={error ?? save.error?.message} />
        <Button type="submit" loading={save.pending} icon={<Save className="size-4" />}>
          ذخیره
        </Button>
      </form>
    </Card>
  );
}
```

### `apps/frontend/src/components/auth/login-form.tsx`

```tsx
'use client';

import { FlaskConical, KeyRound, Smartphone } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type FormEvent } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { Button } from '@/components/ui/button';
import { Field, FormError, Input } from '@/components/ui/field';
import { apiGet, sessionClient } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { AuthUser, OtpRequestResponse } from '@/lib/api/types';
import { homeForRole, safeNextPath } from '@/lib/auth/access';
import { formatMobile, toLatinDigits, toPersianDigits } from '@/lib/format';
import { IRAN_MOBILE_PATTERN } from '@/lib/iran';
import { PLATFORM_NAME } from '@/lib/brand';

type Mode = 'otp' | 'password';

/**
 * Sign-in: mobile + one-time code (customers, sign-up on first login) or
 * email/mobile + password (staff and vendors). Both post to the BFF, which
 * stores the tokens in httpOnly cookies and merges the guest cart.
 */
export function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const { refresh } = useSession();
  const next = safeNextPath(params.get('next'));

  const [mode, setMode] = useState<Mode>('otp');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState<OtpRequestResponse | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testSms, setTestSms] = useState(false);

  useEffect(() => {
    apiGet<{ provider: string; isTestProvider: boolean }>('/auth/sms-provider')
      .then((info) => setTestSms(info.isTestProvider))
      .catch(() => setTestSms(false));
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((value) => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function finish(user: AuthUser) {
    await refresh();
    router.replace(next ?? homeForRole(user.role));
    router.refresh();
  }

  async function requestCode(event?: FormEvent) {
    event?.preventDefault();
    const normalised = toLatinDigits(mobile).replace(/[\s-]/g, '');
    if (!IRAN_MOBILE_PATTERN.test(normalised)) {
      setError('شمارهٔ موبایل معتبر نیست (مثال: ۰۹۱۲۱۲۳۴۵۶۷).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<OtpRequestResponse>('/otp', { mobile: normalised });
      setSent(data);
      setSecondsLeft(Math.min(data.expiresInSeconds, 120));
      setCode('');
    } catch (caught) {
      setError(toApiError(caught).message);
    } finally {
      setBusy(false);
    }
  }

  async function verify(event: FormEvent) {
    event.preventDefault();
    const normalisedCode = toLatinDigits(code).trim();
    if (!/^\d{4,8}$/.test(normalisedCode)) {
      setError('کد تأیید را کامل وارد کنید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<{ user: AuthUser }>('/verify', { mobile: toLatinDigits(mobile).replace(/[\s-]/g, ''), code: normalisedCode });
      await finish(data.user);
    } catch (caught) {
      setError(toApiError(caught).message);
      setBusy(false);
    }
  }

  async function passwordLogin(event: FormEvent) {
    event.preventDefault();
    if (!identifier.trim() || !password) {
      setError('شناسه و رمز عبور را وارد کنید.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { data } = await sessionClient.post<{ user: AuthUser }>('/password', { identifier: toLatinDigits(identifier.trim()), password });
      await finish(data.user);
    } catch (caught) {
      setError(toApiError(caught).message);
      setBusy(false);
    }
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm md:p-8">
      <h1 className="mb-1 text-xl font-black text-slate-900">ورود به {PLATFORM_NAME}</h1>
      <p className="mb-6 text-sm text-slate-500">{next ? 'برای ادامه وارد حساب خود شوید.' : 'خرید، پیگیری سفارش و مدیریت فروشگاه'}</p>

      <div className="mb-6 grid grid-cols-2 gap-1 rounded-xl bg-slate-100 p-1" role="tablist">
        {(
          [
            { id: 'otp', label: 'ورود با کد یکبارمصرف', icon: Smartphone },
            { id: 'password', label: 'ورود با رمز عبور', icon: KeyRound },
          ] as const
        ).map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            onClick={() => {
              setMode(tab.id);
              setError(null);
            }}
            className={`flex items-center justify-center gap-1.5 rounded-lg py-2 text-xs font-medium sm:text-sm ${mode === tab.id ? 'bg-white text-brand-700 shadow-sm' : 'text-slate-600'}`}
          >
            <tab.icon className="size-4" /> {tab.label}
          </button>
        ))}
      </div>

      {mode === 'otp' ? (
        !sent ? (
          <form onSubmit={(event) => void requestCode(event)} className="flex flex-col gap-4" noValidate>
            <Field label="شمارهٔ موبایل" hint="اگر حساب ندارید، با همین شماره ساخته می‌شود.">
              {(id, described) => <Input id={id} aria-describedby={described} dir="ltr" inputMode="tel" autoComplete="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} placeholder="09121234567" autoFocus />}
            </Field>
            <FormError message={error} />
            <Button type="submit" size="lg" loading={busy}>
              دریافت کد تأیید
            </Button>
          </form>
        ) : (
          <form onSubmit={(event) => void verify(event)} className="flex flex-col gap-4" noValidate>
            <p className="text-sm text-slate-600">
              کد ارسال‌شده به <b dir="ltr">{formatMobile(toLatinDigits(mobile))}</b> را وارد کنید.{' '}
              <button type="button" className="text-brand-700 hover:underline" onClick={() => setSent(null)}>
                تغییر شماره
              </button>
            </p>
            <Field label="کد تأیید">
              {(id) => <Input id={id} dir="ltr" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} maxLength={8} className="text-center text-lg tracking-[0.5em]" autoFocus />}
            </Field>
            <FormError message={error} />
            <Button type="submit" size="lg" loading={busy}>
              ورود
            </Button>
            <button type="button" disabled={secondsLeft > 0 || busy} onClick={() => void requestCode()} className="text-sm text-brand-700 disabled:text-slate-400">
              {secondsLeft > 0 ? `ارسال دوباره تا ${toPersianDigits(secondsLeft)} ثانیهٔ دیگر` : 'ارسال دوبارهٔ کد'}
            </button>
          </form>
        )
      ) : (
        <form onSubmit={(event) => void passwordLogin(event)} className="flex flex-col gap-4" noValidate>
          <Field label="ایمیل یا شمارهٔ موبایل">
            {(id) => <Input id={id} dir="ltr" autoComplete="username" value={identifier} onChange={(event) => setIdentifier(event.target.value)} autoFocus />}
          </Field>
          <Field label="رمز عبور">
            {(id) => <Input id={id} type="password" dir="ltr" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} />}
          </Field>
          <FormError message={error} />
          <Button type="submit" size="lg" loading={busy}>
            ورود
          </Button>
          <p className="text-xs leading-5 text-slate-500">ورود با رمز برای کارکنان و فروشندگانی است که رمز عبور تعیین کرده‌اند.</p>
        </form>
      )}

      {testSms && mode === 'otp' ? (
        <p className="mt-6 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-900">
          <FlaskConical className="mt-0.5 size-4 shrink-0" />
          محیط توسعه: سرویس پیامک آزمایشی (Sandbox) فعال است و پیامک واقعی ارسال نمی‌شود؛ کد در لاگ سرور ثبت می‌شود.
        </p>
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/components/catalog/product-specifications.tsx`

```tsx
import type { ProductSpecification } from '@/lib/api/types';
import { groupSpecifications } from '@/lib/product-specs';

/** Storefront specification table, grouped the way the vendor ordered it. */
export function ProductSpecifications({ specifications }: { specifications: ProductSpecification[] }) {
  if (specifications.length === 0) return null;
  const groups = groupSpecifications(specifications);
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-6" aria-labelledby="product-specs-title">
      <h2 id="product-specs-title" className="mb-4 text-lg font-bold text-slate-900">
        مشخصات فنی
      </h2>
      <div className="flex flex-col gap-6">
        {groups.map((group, index) => (
          <div key={`${group.groupTitle ?? ''}-${index}`} className="grid gap-3 md:grid-cols-[10rem_1fr]">
            <h3 className="text-sm font-bold text-slate-800">{group.groupTitle ?? ''}</h3>
            <dl className="divide-y divide-slate-100">
              {group.items.map((item, itemIndex) => (
                <div key={`${item.title}-${itemIndex}`} className="grid gap-1 py-2.5 text-sm sm:grid-cols-[12rem_1fr] sm:gap-4">
                  <dt className="text-slate-500">{item.title}</dt>
                  <dd className="whitespace-pre-line leading-7 text-slate-800">{item.value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>
    </section>
  );
}
```

### `apps/frontend/src/components/disputes/dispute-view.tsx`

```tsx
import { FileText, Paperclip } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card, Money, StatusBadge } from '@/components/ui/misc';
import type { Dispute, DisputeEvidence } from '@/lib/api/types';
import { formatDateTime } from '@/lib/format';
import { DISPUTE_EVENT_LABELS, DISPUTE_REASON_LABELS, DISPUTE_STATUS, SUB_ORDER_STATUS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

const UPLOADER_LABEL: Record<DisputeEvidence['uploadedBy'], string> = { CUSTOMER: 'خریدار', VENDOR: 'فروشنده', STAFF: 'داور' };
const ACTOR_LABEL: Record<string, string> = { CUSTOMER: 'خریدار', VENDOR: 'فروشنده', SYSTEM: 'سیستم' };

/** Private evidence files are served by /api/v1/media/documents/:id/download through the BFF (session cookie). */
export function EvidenceList({ evidence }: { evidence: DisputeEvidence[] }) {
  if (evidence.length === 0) return <p className="text-sm text-slate-500">مستندی بارگذاری نشده است.</p>;
  return (
    <ul className="grid gap-2 sm:grid-cols-2">
      {evidence.map((item) => (
        <li key={item.id}>
          <a href={item.fileUrl} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 rounded-xl border border-slate-200 px-3 py-2 text-sm hover:border-brand-300 hover:bg-brand-50">
            {item.fileType?.startsWith('image/') ? <Paperclip className="size-4 text-brand-600" /> : <FileText className="size-4 text-brand-600" />}
            <span className="flex-1 truncate">{item.caption ?? (item.fileType?.startsWith('image/') ? 'تصویر' : 'فایل')}</span>
            <span className="text-xs text-slate-500">
              {UPLOADER_LABEL[item.uploadedBy]} · {formatDateTime(item.createdAt)}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** Case summary, both sides' statements, evidence and timeline — shared by customer, vendor and admin views. */
export function DisputeView({ dispute, extra }: { dispute: Dispute; extra?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <Card title="شرح اختلاف" action={<StatusBadge value={dispute.status} map={DISPUTE_STATUS} />}>
        <dl className="mb-4 grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <dt className="text-slate-500">علت</dt>
            <dd className="font-medium">{DISPUTE_REASON_LABELS[dispute.reason]}</dd>
          </div>
          <div>
            <dt className="text-slate-500">مرسوله</dt>
            <dd dir="ltr" className="text-end font-mono sm:text-start">
              {dispute.package.subOrderNumber}
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">فروشگاه</dt>
            <dd>{dispute.package.storeName}</dd>
          </div>
          <div>
            <dt className="text-slate-500">مبلغ مرسوله</dt>
            <dd>
              <Money rials={dispute.package.itemsSubtotal} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">وضعیت مرسوله</dt>
            <dd>
              <StatusBadge value={dispute.package.status} map={SUB_ORDER_STATUS} />
            </dd>
          </div>
          <div>
            <dt className="text-slate-500">ثبت</dt>
            <dd>{formatDateTime(dispute.createdAt)}</dd>
          </div>
        </dl>
        <p className="whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm leading-7">{dispute.description}</p>
      </Card>

      {dispute.vendorResponse ? (
        <Card title={dispute.vendorResponse.action === 'ACCEPT_RETURN' ? 'پاسخ فروشنده: پذیرش مرجوعی' : 'دفاعیهٔ فروشنده'}>
          <p className="whitespace-pre-line text-sm leading-7">{dispute.vendorResponse.defenseNotes}</p>
          <p className="mt-2 text-xs text-slate-500">{formatDateTime(dispute.vendorResponse.respondedAt)}</p>
        </Card>
      ) : null}

      {dispute.resolution ? (
        <Card title="نتیجه">
          <div className="flex flex-col gap-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge value={dispute.resolution.outcome} map={DISPUTE_STATUS} />
              <span className="text-slate-500">
                {dispute.resolution.decidedBy === 'STAFF' ? 'رأی داور' : 'پذیرش فروشنده'} — {formatDateTime(dispute.resolution.resolvedAt)}
              </span>
            </div>
            {dispute.resolution.refundAmount ? (
              <span>
                مبلغ بازپرداخت: <Money rials={dispute.resolution.refundAmount} className="font-bold" />
              </span>
            ) : null}
            {dispute.resolution.notes ? <p className="whitespace-pre-line leading-7">{dispute.resolution.notes}</p> : null}
          </div>
        </Card>
      ) : null}

      {extra}

      <Card title="مستندات">
        <EvidenceList evidence={dispute.evidence} />
      </Card>

      <Card title="روند رسیدگی">
        <ol className="relative flex flex-col gap-4 border-s-2 border-slate-100 ps-5">
          {dispute.timeline.map((event, index) => (
            <li key={`${event.createdAt}-${index}`} className="relative text-sm">
              <span className="absolute -start-[27px] top-1 size-3 rounded-full border-2 border-white bg-brand-500" />
              <div className="font-medium">{DISPUTE_EVENT_LABELS[event.type]}</div>
              <div className="text-xs text-slate-500">
                {ACTOR_LABEL[event.actorRole] ?? `کارشناس ${PLATFORM_NAME}`} · {formatDateTime(event.createdAt)}
              </div>
              {event.note ? <div className="mt-1 whitespace-pre-line text-xs text-slate-600">{event.note}</div> : null}
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
```

### `apps/frontend/src/components/layout/dashboard-shell.tsx`

```tsx
'use client';

import {
  Banknote,
  BarChart3,
  CreditCard,
  Gavel,
  LayoutDashboard,
  MapPin,
  Package,
  PackageCheck,
  Scale,
  ShieldCheck,
  ShoppingBag,
  Store,
  User,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { useSession } from '@/components/providers/session-provider';
import { canAccess } from '@/lib/auth/access';
import { ROLE_LABELS } from '@/lib/labels';
import { PLATFORM_NAME } from '@/lib/brand';

export type DashboardArea = 'customer' | 'vendor' | 'admin';

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: Record<DashboardArea, { title: string; items: NavItem[] }> = {
  customer: {
    title: 'حساب کاربری',
    items: [
      { href: '/customer/orders', label: 'سفارش‌ها', icon: ShoppingBag },
      { href: '/customer/credit', label: 'اعتبار و اقساط', icon: CreditCard },
      { href: '/customer/disputes', label: 'اختلاف‌ها و مرجوعی', icon: Scale },
      { href: '/customer/addresses', label: 'نشانی‌ها', icon: MapPin },
      { href: '/customer/profile', label: 'اطلاعات حساب', icon: User },
    ],
  },
  vendor: {
    title: 'پنل فروشنده',
    items: [
      { href: '/vendor/dashboard', label: 'پیشخوان', icon: LayoutDashboard },
      { href: '/vendor/orders', label: 'مرسوله‌ها', icon: PackageCheck },
      { href: '/vendor/products', label: 'محصولات', icon: Package },
      { href: '/vendor/wallet', label: 'کیف پول و تسویه', icon: Wallet },
      { href: '/vendor/disputes', label: 'اختلاف‌ها', icon: Scale },
      { href: '/vendor/register', label: 'فروشگاه و مدارک', icon: Store },
    ],
  },
  admin: {
    title: 'پنل مدیریت',
    items: [
      { href: '/admin/vendors', label: 'فروشندگان و احراز هویت', icon: ShieldCheck },
      { href: '/admin/products', label: 'نظارت بر محصولات', icon: Package },
      { href: '/admin/financial', label: 'گزارش مالی', icon: BarChart3 },
      { href: '/admin/settlements', label: 'تسویه‌ها', icon: Banknote },
      { href: '/admin/disputes', label: 'داوری اختلاف‌ها', icon: Gavel },
    ],
  },
};

export function DashboardShell({ area, children }: { area: DashboardArea; children: ReactNode }) {
  const pathname = usePathname();
  const { user } = useSession();
  const nav = NAV[area];
  // Only links whose pages (and API guards) accept the current role.
  const items = nav.items.filter((item) => canAccess(item.href, user?.role));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 lg:flex-row">
      <aside className="lg:w-60 lg:shrink-0">
        <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm lg:sticky lg:top-20">
          <div className="border-b border-slate-100 px-2 pb-3">
            <p className="text-sm font-bold text-slate-900">{nav.title}</p>
            {user ? (
              <p className="mt-0.5 truncate text-xs text-slate-500">
                {user.fullName || `کاربر ${PLATFORM_NAME}`} · {ROLE_LABELS[user.role]}
              </p>
            ) : null}
          </div>
          <nav className="mt-2 flex gap-1 overflow-x-auto lg:flex-col" aria-label={nav.title}>
            {items.map((item) => {
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? 'page' : undefined}
                  className={`flex shrink-0 items-center gap-2 rounded-xl px-3 py-2 text-sm ${active ? 'bg-brand-50 font-bold text-brand-700' : 'text-slate-700 hover:bg-slate-50'}`}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      </aside>
      <main className="min-w-0 flex-1">{children}</main>
    </div>
  );
}
```

### `apps/frontend/src/components/layout/header-bar.tsx`

```tsx
'use client';

import {
  ChevronDown,
  LayoutDashboard,
  LayoutGrid,
  LoaderCircle,
  LogIn,
  LogOut,
  Search,
  ShoppingCart,
  Store,
  User,
} from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';

import { useCart } from '@/components/providers/cart-provider';
import { useSession } from '@/components/providers/session-provider';
import { apiGet } from '@/lib/api/client';
import type { CategoryTreeNode, Page, ProductListItem } from '@/lib/api/types';
import { homeForRole } from '@/lib/auth/access';
import { formatToman } from '@/lib/currency';
import { toPersianDigits } from '@/lib/format';
import { useDebounced } from '@/lib/hooks/use-api';
import { ROLE_LABELS } from '@/lib/labels';
import { PLATFORM_MONOGRAM, PLATFORM_NAME } from '@/lib/brand';

export function HeaderBar({ categories, categoriesError }: { categories: CategoryTreeNode[]; categoriesError: boolean }) {
  return (
    <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
      <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-lg font-black text-brand-700">
          <span className="flex size-9 items-center justify-center rounded-xl bg-brand-600 text-white" aria-hidden>{PLATFORM_MONOGRAM}</span>
          <span className="hidden sm:inline">{PLATFORM_NAME}</span>
        </Link>
        <CategoryMenu categories={categories} failed={categoriesError} />
        <HeaderSearch />
        <div className="ms-auto flex items-center gap-1">
          <CartButton />
          <UserMenu />
        </div>
      </div>
    </header>
  );
}

function CategoryMenu({ categories, failed }: { categories: CategoryTreeNode[]; failed: boolean }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const pathname = usePathname();

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const activeNode = categories.find((node) => node.id === active) ?? categories[0];

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="inline-flex h-10 items-center gap-1.5 rounded-xl px-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
      >
        <LayoutGrid className="size-4" />
        <span className="hidden md:inline">دسته‌بندی‌ها</span>
        <ChevronDown className="size-4" />
      </button>
      {open ? (
        <div className="absolute start-0 top-12 z-50 w-[min(90vw,44rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          {failed ? (
            <p className="p-4 text-sm text-rose-700">فهرست دسته‌بندی‌ها بارگذاری نشد. صفحه را دوباره باز کنید.</p>
          ) : categories.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">هنوز دسته‌بندی فعالی ثبت نشده است.</p>
          ) : (
            <div className="flex max-h-[70vh]">
              <ul className="w-48 shrink-0 overflow-y-auto border-e border-slate-100 bg-slate-50 py-2">
                {categories.map((node) => (
                  <li key={node.id}>
                    <Link
                      href={`/categories/${node.slug}`}
                      onMouseEnter={() => setActive(node.id)}
                      onFocus={() => setActive(node.id)}
                      className={`flex items-center justify-between px-4 py-2 text-sm ${activeNode?.id === node.id ? 'bg-white font-bold text-brand-700' : 'text-slate-700'}`}
                    >
                      {node.titleFa}
                      <span className="text-xs text-slate-400">{toPersianDigits(node.totalProductCount)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="flex-1 overflow-y-auto p-4">
                {activeNode ? (
                  <>
                    <Link href={`/categories/${activeNode.slug}`} className="mb-3 inline-block text-sm font-bold text-brand-700">
                      همهٔ {activeNode.titleFa} ←
                    </Link>
                    {activeNode.children.length === 0 ? (
                      <p className="text-sm text-slate-500">زیرشاخه‌ای ندارد.</p>
                    ) : (
                      <div className="grid grid-cols-2 gap-4">
                        {activeNode.children.map((child) => (
                          <div key={child.id}>
                            <Link href={`/categories/${child.slug}`} className="text-sm font-medium text-slate-800 hover:text-brand-700">
                              {child.titleFa}
                            </Link>
                            {child.children.length > 0 ? (
                              <ul className="mt-1 flex flex-col gap-1">
                                {child.children.map((leaf) => (
                                  <li key={leaf.id}>
                                    <Link href={`/categories/${leaf.slug}`} className="text-xs text-slate-500 hover:text-brand-700">
                                      {leaf.titleFa}
                                    </Link>
                                  </li>
                                ))}
                              </ul>
                            ) : null}
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function HeaderSearch() {
  const router = useRouter();
  const pathname = usePathname();
  const [term, setTerm] = useState('');
  const [focused, setFocused] = useState(false);
  const [results, setResults] = useState<ProductListItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const debounced = useDebounced(term.trim(), 300);

  useEffect(() => {
    setFocused(false);
  }, [pathname]);

  useEffect(() => {
    if (debounced.length < 2) {
      setResults(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    apiGet<Page<ProductListItem>>('/products', { query: { search: debounced, pageSize: 6 } })
      .then((page) => {
        if (!cancelled) {
          setResults(page.items);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debounced]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = term.trim();
    setFocused(false);
    router.push(q ? `/search?q=${encodeURIComponent(q)}` : '/search');
  }

  const showPanel = focused && debounced.length >= 2;

  return (
    <form onSubmit={submit} role="search" className="relative min-w-0 flex-1 md:max-w-xl">
      <label htmlFor="header-search" className="sr-only">
        جست‌وجوی محصولات
      </label>
      <Search className="pointer-events-none absolute inset-y-0 start-3 my-auto size-4 text-slate-400" />
      <input
        id="header-search"
        type="search"
        value={term}
        onChange={(event) => setTerm(event.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 150)}
        placeholder="جست‌وجو در محصولات، برندها و فروشگاه‌ها…"
        autoComplete="off"
        className="h-10 w-full rounded-xl border border-slate-200 bg-slate-100 pe-3 ps-9 text-sm focus:border-brand-500 focus:bg-white focus:outline-none focus:ring-2 focus:ring-brand-100"
      />
      {showPanel ? (
        <div className="absolute inset-x-0 top-12 z-50 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          {loading && results === null ? (
            <p className="flex items-center gap-2 p-4 text-sm text-slate-500">
              <LoaderCircle className="size-4 animate-spin" /> در حال جست‌وجو…
            </p>
          ) : failed ? (
            <p className="p-4 text-sm text-rose-700">جست‌وجو انجام نشد؛ دوباره تلاش کنید.</p>
          ) : results && results.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">محصولی با «{debounced}» پیدا نشد.</p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {(results ?? []).map((item) => (
                <li key={item.id}>
                  <Link href={`/products/${item.slug}`} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <span className="relative size-10 shrink-0 overflow-hidden rounded-lg bg-slate-100">
                      {item.primaryImage ? (
                        <Image src={item.primaryImage.thumbnailUrl ?? item.primaryImage.url} alt="" fill sizes="40px" className="object-cover" unoptimized />
                      ) : null}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-slate-800">{item.title}</span>
                      <span className="block text-xs text-slate-500">{item.vendor.storeName}</span>
                    </span>
                    <span className="text-xs font-bold text-slate-700">{formatToman(item.priceRange.min)}</span>
                  </Link>
                </li>
              ))}
              <li>
                <button type="submit" className="w-full px-4 py-2.5 text-start text-sm font-medium text-brand-700 hover:bg-brand-50">
                  مشاهدهٔ همهٔ نتایج «{debounced}»
                </button>
              </li>
            </ul>
          )}
        </div>
      ) : null}
    </form>
  );
}

function CartButton() {
  const { count, loading } = useCart();
  return (
    <Link href="/cart" className="relative inline-flex size-10 items-center justify-center rounded-xl text-slate-700 hover:bg-slate-100" aria-label={`سبد خرید، ${toPersianDigits(count)} کالا`}>
      <ShoppingCart className="size-5" />
      {!loading && count > 0 ? (
        <span className="absolute -end-0.5 -top-0.5 flex min-w-5 items-center justify-center rounded-full bg-rose-600 px-1 text-[11px] font-bold leading-5 text-white">
          {toPersianDigits(count > 99 ? '99+' : count)}
        </span>
      ) : null}
    </Link>
  );
}

function UserMenu() {
  const { me, user, signOut } = useSession();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  if (!user) {
    return (
      <Link href={`/login?next=${encodeURIComponent(pathname)}`} className="inline-flex h-10 items-center gap-2 rounded-xl border border-slate-300 px-3 text-sm font-medium text-slate-800 hover:bg-slate-50">
        <LogIn className="size-4" /> <span className="hidden sm:inline">ورود | ثبت‌نام</span>
      </Link>
    );
  }

  const links: Array<{ href: string; label: string; icon: typeof User }> = [{ href: homeForRole(user.role), label: 'پنل کاربری', icon: LayoutDashboard }];
  if (user.role === 'CUSTOMER') {
    links.push({ href: '/customer/profile', label: 'حساب کاربری', icon: User });
    links.push({ href: '/vendor/register', label: me?.vendor ? 'وضعیت فروشگاه من' : 'فروشنده شوید', icon: Store });
  }

  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="inline-flex h-10 items-center gap-2 rounded-xl px-3 text-sm font-medium text-slate-800 hover:bg-slate-100">
        <User className="size-4" />
        <span className="hidden max-w-32 truncate sm:inline">{user.fullName || `کاربر ${PLATFORM_NAME}`}</span>
        <ChevronDown className="size-4" />
      </button>
      {open ? (
        <div className="absolute end-0 top-12 z-50 w-60 overflow-hidden rounded-2xl border border-slate-200 bg-white py-2 shadow-xl">
          <div className="border-b border-slate-100 px-4 pb-2">
            <p className="truncate text-sm font-bold text-slate-900">{user.fullName || `کاربر ${PLATFORM_NAME}`}</p>
            <p className="text-xs text-slate-500">{ROLE_LABELS[user.role]}</p>
          </div>
          {links.map((link) => (
            <Link key={link.href} href={link.href} className="flex items-center gap-2 px-4 py-2 text-sm text-slate-700 hover:bg-slate-50">
              <link.icon className="size-4" /> {link.label}
            </Link>
          ))}
          <button type="button" onClick={() => void signOut()} className="flex w-full items-center gap-2 px-4 py-2 text-sm text-rose-700 hover:bg-rose-50">
            <LogOut className="size-4" /> خروج
          </button>
        </div>
      ) : null}
    </div>
  );
}
```

### `apps/frontend/src/components/layout/site-footer.tsx`

```tsx
import Link from 'next/link';
import { PLATFORM_NAME, PLATFORM_TAGLINE } from '@/lib/brand';

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-slate-200 bg-white">
      <div className="mx-auto grid max-w-7xl gap-8 px-4 py-10 text-sm text-slate-600 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <p className="text-base font-black text-brand-700">{PLATFORM_NAME}</p>
          <p className="text-xs font-medium text-slate-500">{PLATFORM_TAGLINE}</p>
          <p className="leading-7">بازار آنلاین چندفروشندگی با پرداخت امن درگاه بانکی و خرید اقساطی. پول شما تا تحویل کالا نزد {PLATFORM_NAME} امانت می‌ماند.</p>
        </div>
        <nav className="flex flex-col gap-2" aria-label="خرید">
          <p className="font-bold text-slate-800">خرید</p>
          <Link href="/search" className="hover:text-brand-700">همهٔ محصولات</Link>
          <Link href="/search?sort=popular" className="hover:text-brand-700">پرفروش‌ترین‌ها</Link>
          <Link href="/customer/credit" className="hover:text-brand-700">خرید اقساطی</Link>
        </nav>
        <nav className="flex flex-col gap-2" aria-label="همکاری">
          <p className="font-bold text-slate-800">همکاری</p>
          <Link href="/vendor/register" className="hover:text-brand-700">فروشنده شوید</Link>
          <Link href="/customer/disputes" className="hover:text-brand-700">پیگیری اختلاف و مرجوعی</Link>
          <Link href="/status" className="hover:text-brand-700">وضعیت سامانه</Link>
        </nav>
      </div>
    </footer>
  );
}
```

### `apps/frontend/src/components/vendor/product-import-panel.tsx`

```tsx
'use client';

import { CircleAlert, DownloadCloud, ImageDown, Link2, Sparkles } from 'lucide-react';
import { useState, type FormEvent } from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox, FormError, Input } from '@/components/ui/field';
import type { UploadedFile } from '@/components/ui/file-drop';
import { Badge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/modal';
import { IMPORT_EXTRACT_TIMEOUT_MS, IMPORT_IMAGES_TIMEOUT_MS, apiPost } from '@/lib/api/client';
import { toApiError } from '@/lib/api/errors';
import type { FailedImage, ImportedProductDraft, IngestImagesResponse } from '@/lib/api/types';
import { useMutation } from '@/lib/hooks/use-api';
import { toPersianDigits } from '@/lib/format';
import { importSourceLabel, importStrategyLabels, ingestedToUploaded } from '@/lib/product-specs';

export interface ImportResult {
  draft: ImportedProductDraft;
  images: UploadedFile[];
  failures: FailedImage[];
}

interface ProductImportPanelProps {
  /** Free gallery slots (the product limit minus images already in the form). */
  imageSlots: number;
  /** The form already has content that applying the draft would overwrite. */
  hasExistingData: boolean;
  onApply: (result: ImportResult) => void;
}

const fileName = (url: string): string => {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() ?? parsed.hostname);
  } catch {
    return url;
  }
};

/**
 * "Import from a link" for the new-product form. Step 1 fetches the draft
 * (POST /vendor/products/import/extract-spec — nothing is stored); step 2, in
 * a preview dialog, the vendor picks the images to keep and applies the draft:
 * the chosen images are copied into our media storage (ingest-images) and the
 * form is filled. The vendor then only adds price, stock and variants.
 */
export function ProductImportPanel({ imageSlots, hasExistingData, onApply }: ProductImportPanelProps) {
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportedProductDraft | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [withImages, setWithImages] = useState(true);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);

  const extract = useMutation((link: string) =>
    apiPost<ImportedProductDraft>('/vendor/products/import/extract-spec', { url: link }, { timeout: IMPORT_EXTRACT_TIMEOUT_MS }),
  );

  async function fetchDraft(event: FormEvent) {
    event.preventDefault();
    const link = url.trim();
    if (!/^https?:\/\/\S+$/i.test(link)) {
      setUrlError('نشانی کامل صفحهٔ کالا را وارد کنید (با http:// یا https://).');
      return;
    }
    setUrlError(null);
    const result = await extract.run(link);
    if (result) {
      setDraft(result);
      setSelected(new Set(result.imageUrls.slice(0, imageSlots)));
      setWithImages(result.imageUrls.length > 0 && imageSlots > 0);
      setApplyError(null);
    }
  }

  function toggleImage(imageUrl: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(imageUrl)) next.delete(imageUrl);
      else if (next.size < imageSlots) next.add(imageUrl);
      return next;
    });
  }

  async function apply() {
    if (!draft) return;
    const imageUrls = withImages ? draft.imageUrls.filter((imageUrl) => selected.has(imageUrl)).slice(0, imageSlots) : [];
    setApplying(true);
    setApplyError(null);
    try {
      let images: UploadedFile[] = [];
      let failures: FailedImage[] = [];
      if (imageUrls.length > 0) {
        const ingested = await apiPost<IngestImagesResponse>('/vendor/products/import/ingest-images', { imageUrls }, { timeout: IMPORT_IMAGES_TIMEOUT_MS });
        images = ingested.items.map((item) => ingestedToUploaded(item));
        failures = ingested.failures;
      }
      onApply({ draft, images, failures });
      setDraft(null);
      setUrl('');
    } catch (caught) {
      setApplyError(toApiError(caught).message);
    } finally {
      setApplying(false);
    }
  }

  const selectedCount = draft ? draft.imageUrls.filter((imageUrl) => selected.has(imageUrl)).length : 0;

  return (
    <>
      <form onSubmit={(event) => void fetchDraft(event)} noValidate className="flex flex-col gap-3">
        <p className="flex items-start gap-2 text-sm text-slate-600">
          <Sparkles className="mt-0.5 size-4 shrink-0 text-brand-600" />
          لینک صفحهٔ کالا در دیجی‌کالا یا هر فروشگاه اینترنتی دیگر را وارد کنید تا عنوان، برند، توضیحات، جدول مشخصات و تصاویر به‌صورت خودکار پر شود. شما فقط قیمت، موجودی و تنوع‌ها را وارد می‌کنید.
        </p>
        <div className="flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Link2 className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <Input
              type="url"
              dir="ltr"
              inputMode="url"
              aria-label="لینک صفحهٔ کالا"
              aria-invalid={urlError ? true : undefined}
              placeholder="https://www.digikala.com/product/dkp-…"
              className="ps-9"
              maxLength={2048}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              disabled={extract.pending}
            />
          </div>
          <Button type="submit" loading={extract.pending} icon={<DownloadCloud className="size-4" />}>
            {extract.pending ? 'در حال دریافت…' : 'دریافت اطلاعات کالا'}
          </Button>
        </div>
        <FormError message={urlError ?? extract.error?.message} />
      </form>

      <Modal
        open={draft !== null}
        title="پیش‌نمایش اطلاعات دریافت‌شده"
        size="lg"
        onClose={() => (applying ? undefined : setDraft(null))}
        footer={
          <>
            <Button variant="secondary" onClick={() => setDraft(null)} disabled={applying}>
              انصراف
            </Button>
            <Button onClick={() => void apply()} loading={applying} icon={<ImageDown className="size-4" />}>
              {applying ? 'در حال انتقال تصاویر…' : 'اعمال در فرم'}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="flex flex-col gap-4 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="info">منبع: {importSourceLabel(draft)}</Badge>
              {importStrategyLabels(draft).map((label) => (
                <Badge key={label}>{label}</Badge>
              ))}
            </div>

            <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[8rem_1fr]">
              <dt className="text-slate-500">عنوان</dt>
              <dd className="font-medium">{draft.title}</dd>
              {draft.titleEn ? (
                <>
                  <dt className="text-slate-500">عنوان لاتین</dt>
                  <dd dir="ltr" className="text-start">
                    {draft.titleEn}
                  </dd>
                </>
              ) : null}
              <dt className="text-slate-500">برند</dt>
              <dd>{draft.brand ?? '—'}</dd>
              <dt className="text-slate-500">دسته‌بندی</dt>
              <dd>
                {draft.suggestedCategoryId ? (
                  <span>{draft.suggestedCategory ?? 'پیشنهاد شد'} — دستهٔ منطبق در فروشگاه انتخاب می‌شود.</span>
                ) : (
                  <span className="text-amber-700">
                    {draft.suggestedCategory ? `«${draft.suggestedCategory}» در دسته‌های فروشگاه پیدا نشد` : 'دسته‌بندی مشخص نشد'}؛ پس از اعمال، دسته را خودتان انتخاب کنید.
                  </span>
                )}
              </dd>
              <dt className="text-slate-500">مشخصات فنی</dt>
              <dd>{toPersianDigits(draft.specifications.length)} ردیف</dd>
              <dt className="text-slate-500">توضیحات</dt>
              <dd className="line-clamp-3 whitespace-pre-line text-slate-600">{draft.description ?? '—'}</dd>
            </dl>

            <div className="rounded-xl border border-slate-200 p-3">
              {draft.imageUrls.length === 0 ? (
                <p className="text-slate-500">تصویری در این صفحه پیدا نشد.</p>
              ) : imageSlots === 0 ? (
                <p className="text-amber-700">گالری محصول پر است؛ برای افزودن تصویر، ابتدا تصویری را از فرم حذف کنید.</p>
              ) : (
                <>
                  <Checkbox
                    label={`انتقال تصاویر به فروشگاه (${toPersianDigits(selectedCount)} از ${toPersianDigits(draft.imageUrls.length)} تصویر؛ حداکثر ${toPersianDigits(imageSlots)})`}
                    checked={withImages}
                    onChange={(event) => setWithImages(event.target.checked)}
                  />
                  {withImages ? (
                    <ul className="mt-3 grid max-h-48 gap-1 overflow-y-auto sm:grid-cols-2">
                      {draft.imageUrls.map((imageUrl, index) => (
                        <li key={imageUrl}>
                          <label className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 hover:bg-slate-50">
                            <input
                              type="checkbox"
                              className="size-4 accent-brand-600"
                              checked={selected.has(imageUrl)}
                              disabled={!selected.has(imageUrl) && selectedCount >= imageSlots}
                              onChange={() => toggleImage(imageUrl)}
                            />
                            <span className="text-xs text-slate-500">{toPersianDigits(index + 1)}.</span>
                            <span dir="ltr" className="truncate text-xs text-slate-700" title={imageUrl}>
                              {fileName(imageUrl)}
                            </span>
                            {index === 0 ? <Badge tone="success">اصلی</Badge> : null}
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  <p className="mt-2 text-xs text-slate-500">تصاویر روی سرور فروشگاه ذخیره و به WebP با تصویر بندانگشتی تبدیل می‌شوند.</p>
                </>
              )}
            </div>

            {hasExistingData ? (
              <p className="flex items-start gap-2 rounded-xl bg-amber-50 px-3 py-2 text-amber-800">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                عنوان، برند، توضیحات، دسته‌بندی و جدول مشخصاتِ فعلی فرم با این اطلاعات جایگزین می‌شود؛ تصاویر فعلی حفظ و تصاویر جدید به انتهای گالری افزوده می‌شوند.
              </p>
            ) : null}
            <p className="text-xs text-slate-500">
              مسئولیت درستی اطلاعات و داشتن اجازهٔ استفاده از متن و تصاویر منبع با فروشنده است؛ پیش از انتشار، اطلاعات را بازبینی کنید.
            </p>
            <FormError message={applyError} />
          </div>
        ) : null}
      </Modal>
    </>
  );
}
```

### `apps/frontend/src/components/vendor/specification-editor.tsx`

```tsx
'use client';

import { ArrowDown, ArrowUp, ListPlus, Plus, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input, Textarea } from '@/components/ui/field';
import { toPersianDigits } from '@/lib/format';
import {
  MAX_SPECIFICATIONS_PER_PRODUCT,
  SPECIFICATION_GROUP_MAX_LENGTH,
  SPECIFICATION_TITLE_MAX_LENGTH,
  SPECIFICATION_VALUE_MAX_LENGTH,
  emptySpecRow,
  type SpecRow,
} from '@/lib/product-specs';

interface SpecificationEditorProps {
  rows: SpecRow[];
  onChange: (rows: SpecRow[]) => void;
}

/**
 * Technical-specification table: group (optional), title and value per row.
 * Filled by hand or by the product importer; rows can be re-ordered, and the
 * order is the order shown on the product page.
 */
export function SpecificationEditor({ rows, onChange }: SpecificationEditorProps) {
  const full = rows.length >= MAX_SPECIFICATIONS_PER_PRODUCT;
  const update = (key: string, patch: Partial<SpecRow>) => onChange(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const remove = (key: string) => onChange(rows.filter((row) => row.key !== key));
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= rows.length) return;
    const next = [...rows];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  /** A new row right after `index`, in the same group (typing a group once is enough). */
  const insertAfter = (index: number) => {
    const next = [...rows];
    next.splice(index + 1, 0, emptySpecRow(rows[index]?.groupTitle ?? ''));
    onChange(next);
  };

  return (
    <div className="flex flex-col gap-3">
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
          هنوز مشخصاتی ثبت نشده است. ردیف اضافه کنید یا اطلاعات را از لینک کالا دریافت کنید.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600">
              <tr>
                <th className="w-40 px-2 py-2 text-start font-medium">گروه (اختیاری)</th>
                <th className="w-52 px-2 py-2 text-start font-medium">عنوان ویژگی</th>
                <th className="px-2 py-2 text-start font-medium">مقدار</th>
                <th className="w-36 px-2 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row, index) => (
                <tr key={row.key} className="align-top">
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`گروه ردیف ${toPersianDigits(index + 1)}`}
                      maxLength={SPECIFICATION_GROUP_MAX_LENGTH}
                      value={row.groupTitle}
                      placeholder="مثلاً دوربین"
                      onChange={(event) => update(row.key, { groupTitle: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Input
                      aria-label={`عنوان ردیف ${toPersianDigits(index + 1)}`}
                      maxLength={SPECIFICATION_TITLE_MAX_LENGTH}
                      value={row.title}
                      placeholder="مثلاً رزولوشن"
                      onChange={(event) => update(row.key, { title: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <Textarea
                      aria-label={`مقدار ردیف ${toPersianDigits(index + 1)}`}
                      rows={Math.min(4, Math.max(1, row.value.split('\n').length))}
                      maxLength={SPECIFICATION_VALUE_MAX_LENGTH}
                      value={row.value}
                      onChange={(event) => update(row.key, { value: event.target.value })}
                    />
                  </td>
                  <td className="px-2 py-2">
                    <div className="flex items-center justify-end gap-1">
                      <IconButton label="انتقال به بالا" disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp className="size-4" />
                      </IconButton>
                      <IconButton label="انتقال به پایین" disabled={index === rows.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown className="size-4" />
                      </IconButton>
                      <IconButton label="ردیف جدید در همین گروه" disabled={full} onClick={() => insertAfter(index)}>
                        <ListPlus className="size-4" />
                      </IconButton>
                      <IconButton label="حذف ردیف" tone="danger" onClick={() => remove(row.key)}>
                        <Trash2 className="size-4" />
                      </IconButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" size="sm" icon={<Plus className="size-4" />} disabled={full} onClick={() => onChange([...rows, emptySpecRow(rows[rows.length - 1]?.groupTitle ?? '')])}>
          افزودن ردیف
        </Button>
        <span className="text-xs text-slate-500">
          {toPersianDigits(rows.length)} از {toPersianDigits(MAX_SPECIFICATIONS_PER_PRODUCT)} ردیف
          {rows.length > 0 ? (
            <button type="button" className="ms-3 text-rose-600 hover:underline" onClick={() => onChange([])}>
              حذف همه
            </button>
          ) : null}
        </span>
      </div>
    </div>
  );
}

function IconButton({ label, onClick, disabled, tone = 'neutral', children }: { label: string; onClick: () => void; disabled?: boolean; tone?: 'neutral' | 'danger'; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg p-1.5 disabled:cursor-not-allowed disabled:opacity-30 ${tone === 'danger' ? 'text-rose-600 hover:bg-rose-50' : 'text-slate-600 hover:bg-slate-100'}`}
    >
      {children}
    </button>
  );
}
```

### `apps/frontend/src/lib/api/client.ts`

```ts
import axios, { type AxiosInstance, type AxiosRequestConfig } from 'axios';

import { resolvePublicApiBaseUrl } from '../env';
import { toApiError } from './errors';

/** Upper bound for a browser request before it is reported as a timeout. */
export const REQUEST_TIMEOUT_MS = 15_000;
/** Uploads carry images/documents of several megabytes. */
export const UPLOAD_TIMEOUT_MS = 90_000;
/** Product import: the API may try Digikala's API and then the product page (10 s each). */
export const IMPORT_EXTRACT_TIMEOUT_MS = 30_000;
/** Up to 12 remote images, 3 at a time, each ≤ 10 s plus WebP processing. */
export const IMPORT_IMAGES_TIMEOUT_MS = 120_000;

/**
 * Creates an axios instance that always talks to the Shagerdam BFF (same
 * origin, `/api/v1`) and never leaks transport-specific errors to the callers:
 * every rejection is an {@link import('./errors').ApiError}.
 *
 * No token handling happens here: the BFF attaches the httpOnly session
 * cookies' access token server-side and refreshes it transparently.
 */
export function createApiClient(baseURL: string = resolvePublicApiBaseUrl()): AxiosInstance {
  const instance = axios.create({
    baseURL,
    timeout: REQUEST_TIMEOUT_MS,
    withCredentials: true,
    headers: {
      Accept: 'application/json',
    },
    // Arrays as repeated keys (colors=a&colors=b), which the backend expects.
    paramsSerializer: { indexes: null },
  });

  instance.interceptors.response.use(
    (response) => response,
    (error: unknown) => Promise.reject(toApiError(error)),
  );

  return instance;
}

/** Shared client for browser components. */
export const apiClient = createApiClient();

export type QueryValue = string | number | boolean | readonly string[] | null | undefined;
export type Query = Record<string, QueryValue>;

/** Drops empty values so optional filters never reach the API as "". */
export function cleanQuery(query: Query | undefined): Record<string, string | number | boolean | readonly string[]> {
  const result: Record<string, string | number | boolean | readonly string[]> = {};
  if (!query) {
    return result;
  }
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;
    result[key] = value as string | number | boolean | readonly string[];
  }
  return result;
}

/** Query string in the same format the axios client sends. */
export function toQueryString(query: Query | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(cleanQuery(query))) {
    if (Array.isArray(value)) {
      for (const item of value) params.append(key, String(item));
    } else {
      params.set(key, String(value));
    }
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

export async function apiGet<TResponse>(path: string, config?: AxiosRequestConfig & { query?: Query }): Promise<TResponse> {
  const { query, ...rest } = config ?? {};
  const { data } = await apiClient.get<TResponse>(path, { ...rest, params: cleanQuery(query) });
  return data;
}

export async function apiPost<TResponse, TBody = unknown>(path: string, body?: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.post<TResponse>(path, body ?? {}, config);
  return data;
}

export async function apiPatch<TResponse, TBody = unknown>(path: string, body: TBody, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.patch<TResponse>(path, body, config);
  return data;
}

export async function apiDelete<TResponse>(path: string, config?: AxiosRequestConfig): Promise<TResponse> {
  const { data } = await apiClient.delete<TResponse>(path, config);
  return data;
}

/**
 * Multipart upload (media endpoints). `purpose` is written before the file:
 * the backend reads the parts in order.
 */
export async function apiUpload<TResponse>(path: string, file: File, purpose: string, onProgress?: (fraction: number) => void): Promise<TResponse> {
  const form = new FormData();
  form.append('purpose', purpose);
  form.append('file', file, file.name);
  const { data } = await apiClient.post<TResponse>(path, form, {
    timeout: UPLOAD_TIMEOUT_MS,
    onUploadProgress: (event) => {
      if (onProgress && event.total) {
        onProgress(event.loaded / event.total);
      }
    },
  });
  return data;
}

/** Same-origin session endpoints (sign-in/out) of the BFF — not under /api/v1. */
export const sessionClient = createApiClient('/api/session');
```

### `apps/frontend/src/lib/api/error-messages.ts`

```ts
import { formatToman } from '@/lib/currency';

/**
 * Persian texts for the backend's stable error codes. The backend keeps some
 * messages in English (they are also read by API clients and logs); the UI is
 * Persian-only, so known codes are translated here and unknown English
 * messages fall back to a status-based Persian sentence.
 */
const CODE_MESSAGES: Record<string, string | ((details: Record<string, unknown>) => string)> = {
  AMOUNT_BELOW_MINIMUM: (details) => (typeof details.minimumAmount === 'string' ? `حداقل مبلغ تسویه ${formatToman(details.minimumAmount)} است.` : 'مبلغ کمتر از حداقل مجاز است.'),
  AMOUNT_NOT_WHOLE_RIALS: 'مبلغ باید عدد صحیح ریال باشد.',
  BANK_ACCOUNT_MISSING: 'حساب بانکی فروشگاه ثبت نشده است.',
  CART_EMPTY: 'سبد خرید خالی است.',
  CART_FULL: 'سبد خرید به حداکثر ظرفیت رسیده است.',
  CONCURRENT_UPDATE: 'اطلاعات هم‌زمان تغییر کرد؛ صفحه را تازه کنید و دوباره تلاش کنید.',
  CREDIT_ORDER_REFUND_UNSUPPORTED: 'بازپرداخت یا لغو مرسوله‌های سفارش اعتباری/ترکیبی به‌صورت خودکار پشتیبانی نمی‌شود؛ باید با بانک اعتباردهنده به‌صورت دستی پیگیری شود.',
  CREDIT_ACCOUNT_EXISTS: 'شما از قبل حساب اعتباری فعال دارید.',
  CREDIT_ACCOUNT_EXPIRED: 'اعتبار شما منقضی شده است.',
  CREDIT_ACCOUNT_NOT_ACTIVE: 'حساب اعتباری شما فعال نیست.',
  CREDIT_ACCOUNT_NOT_FOUND: 'حساب اعتباری ندارید.',
  CREDIT_ACCOUNT_REQUIRED: 'برای خرید اقساطی ابتدا اعتبار دریافت کنید.',
  CREDIT_APPLICATION_IN_PROGRESS: 'درخواست اعتبار قبلی شما هنوز در حال بررسی است.',
  CREDIT_PROVIDER_NOT_ACTIVE: 'این تأمین‌کنندهٔ اعتبار فعال نیست.',
  CREDIT_PROVIDER_UNAVAILABLE: 'سامانهٔ بانک در دسترس نیست؛ کمی بعد دوباره تلاش کنید.',
  CREDIT_RESERVATION_NOT_HELD: 'رزرو اعتبار این سفارش معتبر نیست.',
  DISPUTE_ALREADY_ACTIVE: 'برای این مرسوله اختلاف فعالی وجود دارد.',
  DISPUTE_ALREADY_CLOSED: 'این اختلاف بسته شده است.',
  DISPUTE_ALREADY_DECIDED: 'برای این مرسوله قبلاً رأی صادر شده است.',
  DISPUTE_NOT_AWAITING_VENDOR: 'این اختلاف در انتظار پاسخ فروشنده نیست.',
  DISPUTE_NOT_CANCELLABLE: 'این اختلاف دیگر قابل پس گرفتن نیست.',
  ESCROW_FROZEN_BY_DISPUTE: 'مبلغ این مرسوله به‌دلیل اختلاف مسدود است.',
  ESCROW_NOT_FREEZABLE: 'مبلغ این مرسوله قابل مسدودسازی نیست.',
  ESCROW_NOT_FROZEN: 'مبلغ این مرسوله مسدود نیست.',
  GATEWAY_UNAVAILABLE: 'درگاه پرداخت در دسترس نیست؛ کمی بعد دوباره تلاش کنید.',
  GATEWAY_UNREACHABLE: 'ارتباط با درگاه پرداخت برقرار نشد.',
  HYBRID_NOT_REQUIRED: 'اعتبار شما برای کل مبلغ کافی است؛ «پرداخت اعتباری» را انتخاب کنید.',
  IBAN_MISMATCH: 'شبای مقصد باید همان شبای ثبت‌شده در پروفایل فروشگاه باشد.',
  IMPORT_BLOCKED_TARGET: 'این نشانی به شبکهٔ داخلی یا یک نشانی غیرعمومی اشاره می‌کند و قابل دریافت نیست.',
  IMPORT_INVALID_URL: 'لینک معتبر نیست؛ نشانی کامل صفحهٔ کالا را با http:// یا https:// وارد کنید.',
  IMPORT_NETWORK: 'ارتباط با سایت مبدأ برقرار نشد.',
  IMPORT_NOT_A_PRODUCT: 'در این صفحه اطلاعات ساخت‌یافتهٔ کالا پیدا نشد؛ لینک صفحهٔ خود کالا را وارد کنید.',
  IMPORT_NOT_FOUND: 'این کالا در سایت مبدأ پیدا نشد یا دیگر فعال نیست.',
  IMPORT_TIMEOUT: 'سایت مبدأ در ۱۰ ثانیه پاسخ نداد؛ کمی بعد دوباره تلاش کنید.',
  IMPORT_TOO_LARGE: 'حجم صفحهٔ مبدأ بیش از حد مجاز است.',
  IMPORT_TOO_MANY_REDIRECTS: 'سایت مبدأ بیش از حد تغییر مسیر داد.',
  IMPORT_UNSUPPORTED_CONTENT: 'این لینک به یک صفحهٔ وب اشاره نمی‌کند.',
  IMPORT_UPSTREAM_STATUS: 'سایت مبدأ درخواست را رد کرد یا با خطا پاسخ داد.',
  INSTALLMENT_NOT_PAYABLE: 'این قسط قابل پرداخت نیست.',
  INSTALLMENT_PLAN_NOT_AVAILABLE: 'این طرح اقساطی در دسترس نیست.',
  INSUFFICIENT_CREDIT: 'اعتبار قابل استفادهٔ شما کافی نیست.',
  INSUFFICIENT_STOCK: 'موجودی کالا کافی نیست.',
  INSUFFICIENT_WALLET_BALANCE: 'موجودی قابل برداشت کافی نیست.',
  INVALID_AMOUNT: 'مبلغ نامعتبر است.',
  INVALID_CART_TOKEN: 'سبد خرید نامعتبر است؛ صفحه را تازه کنید.',
  INVALID_DOCUMENTS: 'مدارک ارسالی نامعتبر است.',
  INVALID_STATUS_TRANSITION: 'این تغییر وضعیت در حالت فعلی مجاز نیست.',
  NATIONAL_CODE_IN_USE: 'این کد ملی برای حساب دیگری ثبت شده است.',
  NATIONAL_CODE_MISMATCH: 'کد ملی با کد ملی پروفایل شما یکسان نیست.',
  ORDER_NOT_PAID: 'این سفارش پرداخت نشده است.',
  ORDER_NOT_PAYABLE: 'این سفارش قابل پرداخت نیست.',
  ORDER_PAYMENT_EXPIRED: 'مهلت پرداخت این سفارش به پایان رسیده است.',
  OUT_OF_STOCK: 'کالا ناموجود است.',
  PAYA_REFERENCE_IN_USE: 'این شمارهٔ پیگیری پایا قبلاً ثبت شده است.',
  PRICE_CHANGED: 'قیمت کالا تغییر کرده است.',
  SETTLEMENT_ALREADY_PROCESSED: 'این درخواست تسویه قبلاً رسیدگی شده است.',
  SUB_ORDER_NOT_DISPUTABLE: 'برای این مرسوله در وضعیت فعلی نمی‌توان اختلاف ثبت کرد.',
  SUB_ORDER_UNDER_DISPUTE: 'این مرسوله اختلاف فعال دارد و تا پایان رسیدگی قابل تغییر نیست.',
};

const STATUS_MESSAGES: Record<number, string> = {
  400: 'اطلاعات ارسالی معتبر نیست.',
  401: 'نشست شما به پایان رسیده است؛ دوباره وارد شوید.',
  403: 'اجازهٔ انجام این کار را ندارید.',
  404: 'مورد درخواستی پیدا نشد.',
  409: 'این عملیات با وضعیت فعلی سازگار نیست.',
  413: 'حجم فایل بیش از حد مجاز است.',
  415: 'نوع فایل پشتیبانی نمی‌شود.',
  422: 'اطلاعات ارسالی قابل پردازش نیست.',
  429: 'تعداد درخواست‌ها بیش از حد مجاز است؛ کمی بعد دوباره تلاش کنید.',
  500: 'خطای داخلی سرور رخ داد.',
  502: 'سرویس بیرونی پاسخ نداد؛ کمی بعد دوباره تلاش کنید.',
  503: 'سرویس موقتاً در دسترس نیست.',
};

const PERSIAN_LETTER = /[\u0600-\u06FF]/;

/** Persian UI message for a failed HTTP response. */
export function localizeErrorMessage(status: number, code: string | undefined, backendMessage: string | undefined, details: unknown): string {
  const mapped = code ? CODE_MESSAGES[code] : undefined;
  if (mapped) {
    return typeof mapped === 'function' ? mapped(typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {}) : mapped;
  }
  if (backendMessage && PERSIAN_LETTER.test(backendMessage)) {
    return backendMessage;
  }
  const generic = STATUS_MESSAGES[status] ?? (status >= 500 ? STATUS_MESSAGES[500] : `درخواست با خطای ${status} رد شد.`);
  // Validation details stay visible (they name the offending field) for 400/422.
  return backendMessage && (status === 400 || status === 422) ? `${generic} (${backendMessage})` : (generic ?? `درخواست با خطای ${status} رد شد.`);
}
```

### `apps/frontend/src/lib/api/types.ts`

```ts
/**
 * Response/request shapes of the Shagerdam API (`/api/v1`), mirrored from the
 * backend DTO classes (apps/backend/src/modules/<module>/dto). Money fields
 * are Rial decimal strings ("35000000.00"); dates are ISO strings.
 */

/* ─── Enums ─────────────────────────────────────────────────────────────── */

export const USER_ROLES = ['SUPER_ADMIN', 'ADMIN', 'VENDOR', 'CUSTOMER', 'FINANCIAL_OFFICER', 'SUPPORT'] as const;
export type UserRole = (typeof USER_ROLES)[number];
export const STAFF_ROLES: readonly UserRole[] = ['SUPER_ADMIN', 'ADMIN', 'FINANCIAL_OFFICER', 'SUPPORT'];

export type VendorStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
export type PaymentMethod = 'CASH_IPG' | 'BANK_CREDIT' | 'HYBRID';
export type ParentOrderPaymentStatus = 'PENDING' | 'PAID' | 'FAILED' | 'CANCELLED';
export const SUB_ORDER_STATUSES = ['PENDING_APPROVAL', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED'] as const;
export type SubOrderStatus = (typeof SUB_ORDER_STATUSES)[number];
export type PaymentStatus = 'INITIATED' | 'SUCCESSFUL' | 'FAILED' | 'REFUNDED';
export type PaymentPurpose = 'ORDER_CHECKOUT' | 'INSTALLMENT_REPAYMENT';
export type PaymentOutcome = 'PAID' | 'FAILED' | 'VERIFICATION_PENDING' | 'PAID_REQUIRES_REFUND';
export type WalletTransactionType =
  | 'CREDIT_SALE_ESCROW_HOLD'
  | 'ESCROW_RELEASE_TO_WITHDRAWABLE'
  | 'COMMISSION_DEDUCTION'
  | 'SETTLEMENT_PAYOUT'
  | 'REFUND_DEDUCTION'
  | 'SETTLEMENT_HOLD'
  | 'SETTLEMENT_HOLD_RELEASE'
  | 'DISPUTE_HOLD_LOCK'
  | 'DISPUTE_HOLD_RELEASE';
export const WALLET_BUCKETS = ['PENDING', 'WITHDRAWABLE', 'SETTLEMENT_HOLD', 'DISPUTE_HOLD'] as const;
export type WalletBalanceBucket = (typeof WALLET_BUCKETS)[number];
export const SETTLEMENT_STATUSES = ['REQUESTED', 'PROCESSING', 'PAID_PAYA', 'REJECTED'] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];
export type CreditAccountStatus = 'ACTIVE' | 'FROZEN' | 'CLOSED';
export type CreditApplicationStatus = 'DRAFT' | 'PENDING_BANK_INQUIRY' | 'DOCS_REQUIRED' | 'APPROVED' | 'REJECTED';
export type InstallmentStatus = 'PENDING' | 'PAID' | 'OVERDUE' | 'WAIVED';
export const DISPUTE_REASONS = ['WRONG_ITEM', 'DAMAGED', 'NOT_AS_DESCRIBED', 'NOT_DELIVERED', 'COUNTERFEIT'] as const;
export type DisputeReason = (typeof DISPUTE_REASONS)[number];
export const DISPUTE_STATUSES = ['OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION', 'RESOLVED_BUYER_FAVOR', 'RESOLVED_VENDOR_FAVOR', 'CANCELLED'] as const;
export type DisputeStatus = (typeof DISPUTE_STATUSES)[number];
export type DisputeVendorAction = 'ACCEPT_RETURN' | 'REJECT_WITH_DEFENSE';
export type DisputeEventType =
  | 'OPENED'
  | 'EVIDENCE_ADDED'
  | 'VENDOR_ACCEPTED_RETURN'
  | 'VENDOR_DEFENDED'
  | 'ARBITRATED_BUYER_FAVOR'
  | 'ARBITRATED_VENDOR_FAVOR'
  | 'CANCELLED_BY_CUSTOMER'
  | 'REFUND_NOTICE_SENT'
  | 'REFUND_NOTICE_FAILED';
export type ArbitrationDecision = 'BUYER_FAVOR' | 'VENDOR_FAVOR';
export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'popular'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];
export type VendorProductStatus = 'published' | 'draft' | 'blocked';

/* ─── Shared ────────────────────────────────────────────────────────────── */

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface ImageRef {
  url: string;
  thumbnailUrl: string | null;
}

export interface PriceRange {
  min: string;
  max: string;
}

/* ─── Auth ──────────────────────────────────────────────────────────────── */

export interface AuthUser {
  id: string;
  mobile: string;
  role: UserRole;
  fullName: string;
  email: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  refreshExpiresIn: number;
  sessionId: string;
  user: AuthUser;
}

export interface OtpRequestResponse {
  status: 'sent';
  expiresInSeconds: number;
  trackingId: string;
}

export interface CustomerProfile {
  birthDate: string | null;
  gender: string | null;
  bankIban: string | null;
  defaultAddressId: string | null;
}

export interface MeVendorSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  status: VendorStatus;
  logoUrl: string | null;
}

export interface Me {
  user: AuthUser;
  customerProfile: CustomerProfile | null;
  vendor: MeVendorSummary | null;
}

export interface UpdateProfileInput {
  fullName?: string;
  email?: string;
  nationalCode?: string;
  birthDate?: string;
}

/* ─── Categories ────────────────────────────────────────────────────────── */

export interface CategorySummary {
  id: string;
  slug: string;
  titleFa: string;
  titleEn: string | null;
}

export interface CategoryTreeNode extends CategorySummary {
  parentId: string | null;
  defaultCommissionRate: string;
  sortOrder: number;
  depth: number;
  productCount: number;
  totalProductCount: number;
  children: CategoryTreeNode[];
}

export interface CategoryTree {
  items: CategoryTreeNode[];
  totalCategories: number;
  totalProducts: number;
}

export interface Subcategory extends CategorySummary {
  sortOrder: number;
  totalProductCount: number;
  childCount: number;
}

export interface CategoryDetail extends CategorySummary {
  parentId: string | null;
  defaultCommissionRate: string;
  depth: number;
  productCount: number;
  totalProductCount: number;
  breadcrumbs: CategorySummary[];
  children: Subcategory[];
}

/* ─── Catalog ───────────────────────────────────────────────────────────── */

export interface ColorOption {
  name: string;
  hex: string | null;
}

export interface PublicVendorSummary {
  storeName: string;
  storeSlug: string;
  logoUrl: string | null;
}

export interface PublicVendorDetail extends PublicVendorSummary {
  bio: string | null;
  instagramHandle: string | null;
  verifiedAt: string | null;
}

export interface ProductListItem {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  primaryImage: ImageRef | null;
  priceRange: PriceRange;
  maxDiscountPercent: number | null;
  startingCompareAtPrice: string | null;
  colors: ColorOption[];
  sizes: string[];
  inStock: boolean;
  vendor: PublicVendorSummary;
  category: CategorySummary;
  createdAt: string;
}

export interface PublicVariant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  availableQuantity: number;
  inStock: boolean;
  weightGrams: number | null;
}

/** One row of a product's technical specification table, in display order. */
export interface ProductSpecification {
  groupTitle: string | null;
  title: string;
  value: string;
}

export interface ProductDetail {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  brand: string | null;
  breadcrumbs: CategorySummary[];
  vendor: PublicVendorDetail;
  media: ImageRef[];
  variants: PublicVariant[];
  priceRange: PriceRange;
  maxDiscountPercent: number | null;
  colors: ColorOption[];
  sizes: string[];
  inStock: boolean;
  specifications: ProductSpecification[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductQuery {
  search?: string;
  categorySlug?: string;
  vendorSlug?: string;
  minPrice?: number;
  maxPrice?: number;
  inStockOnly?: boolean;
  colors?: string[];
  sizes?: string[];
  sortBy?: ProductSort;
  page?: number;
  pageSize?: number;
}

/* ─── Vendor products ───────────────────────────────────────────────────── */

export interface StockSummary {
  variantCount: number;
  activeVariantCount: number;
  totalStock: number;
  totalReserved: number;
  totalAvailable: number;
}

export interface ProductModeration {
  isBlockedByAdmin: boolean;
  blockedReason: string | null;
  blockedAt: string | null;
}

export interface VendorVariant {
  id: string;
  sku: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  price: string;
  compareAtPrice: string | null;
  discountPercent: number | null;
  stockQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
  weightGrams: number | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface VendorProductSummary {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  basePrice: string;
  isPublished: boolean;
  isSellable: boolean;
  moderation: ProductModeration;
  category: CategorySummary;
  primaryImage: ImageRef | null;
  priceRange: PriceRange | null;
  stock: StockSummary;
  createdAt: string;
  updatedAt: string;
}

export interface ProductMedia extends ImageRef {
  id: string;
  mediaAssetId: string | null;
  isPrimary: boolean;
  sortOrder: number;
}

export interface VendorProductDetail extends VendorProductSummary {
  description: string | null;
  media: ProductMedia[];
  variants: VendorVariant[];
  specifications: ProductSpecification[];
}

export interface CreateVariantInput {
  sku: string;
  colorName?: string | null;
  colorHex?: string | null;
  size?: string | null;
  guarantee?: string | null;
  price: number;
  compareAtPrice?: number | null;
  stockQuantity: number;
  weightGrams?: number | null;
  isActive?: boolean;
}

export interface UpdateVariantInput {
  price?: number;
  compareAtPrice?: number | null;
  /** Absolute stock; mutually exclusive with stockDelta. */
  stockQuantity?: number;
  stockDelta?: number;
  isActive?: boolean;
}

export interface CreateProductInput {
  title: string;
  slug?: string;
  description?: string | null;
  categoryId: string;
  brand?: string | null;
  basePrice: number;
  mediaIds?: string[];
  /** Full list in display order; on update it replaces the stored table. */
  specifications?: ProductSpecification[];
  variants: CreateVariantInput[];
  isPublished?: boolean;
}

export type UpdateProductInput = Partial<Omit<CreateProductInput, 'variants'>>;

/* ─── Product importer ──────────────────────────────────────────────────── */

export type ImportSource = 'DIGIKALA' | 'GENERIC';
export type ImportStrategy = 'DIGIKALA_API' | 'JSON_LD' | 'MICRODATA' | 'WOOCOMMERCE_ATTRIBUTES' | 'OPEN_GRAPH' | 'HTML_META';

/** POST /vendor/products/import/extract-spec — a draft only; nothing is stored. */
export interface ImportedProductDraft {
  source: ImportSource;
  strategies: ImportStrategy[];
  sourceUrl: string;
  sourceProductId: string | null;
  title: string;
  titleEn: string | null;
  brand: string | null;
  description: string | null;
  suggestedCategory: string | null;
  /** Local category whose name matches the source's category or breadcrumb. */
  suggestedCategoryId: string | null;
  specifications: Array<{ group: string | null; title: string; value: string }>;
  imageUrls: string[];
}

export interface IngestedImage {
  sourceUrl: string;
  id: string;
  url: string;
  thumbnailUrl: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface FailedImage {
  sourceUrl: string;
  code: string;
  message: string;
}

/** POST /vendor/products/import/ingest-images */
export interface IngestImagesResponse {
  items: IngestedImage[];
  failures: FailedImage[];
}

export interface ArchiveProductResponse {
  id: string;
  slug: string;
  isPublished: boolean;
  wasPublished: boolean;
  auditLogId: string | null;
}

export interface AdminProduct extends VendorProductSummary {
  vendor: { id: string; storeName: string; storeSlug: string; status: VendorStatus };
  blockedByUserId: string | null;
}

/* ─── Media ─────────────────────────────────────────────────────────────── */

export interface ImageUploadResponse {
  id: string;
  url: string;
  thumbnailUrl: string;
  mimeType: 'image/webp';
  sizeBytes: number;
  width: number;
  height: number;
}

export interface DocumentUploadResponse {
  id: string;
  url: string;
  originalName: string;
  sizeBytes: number;
  mimeType: string;
  isPublic: false;
}

export type ImagePurpose = 'avatar' | 'store_logo' | 'store_banner' | 'product_image';
export type DocumentPurpose = 'kyc_national_id' | 'kyc_business_license' | 'kyc_bank_proof' | 'dispute_evidence' | 'other';

/* ─── Cart ──────────────────────────────────────────────────────────────── */

export interface CartIssue {
  code: string;
  message: string;
}

export interface CartLine {
  id: string;
  productVariantId: string;
  sku: string;
  productId: string;
  productSlug: string;
  productTitle: string;
  colorName: string | null;
  colorHex: string | null;
  size: string | null;
  guarantee: string | null;
  image: ImageRef | null;
  quantity: number;
  unitPrice: string;
  priceWhenAdded: string;
  compareAtPrice: string | null;
  lineTotal: string;
  availableQuantity: number;
  isPurchasable: boolean;
  issues: CartIssue[];
  addedAt: string;
}

export interface CartShipping {
  fee: string;
  isFree: boolean;
  freeThreshold: string;
  remainingForFreeShipping: string | null;
}

export interface CartVendorGroup {
  vendor: { storeName: string; storeSlug: string };
  lines: CartLine[];
  itemsSubtotal: string;
  shipping: CartShipping;
  packageTotal: string;
}

export interface Cart {
  cartToken: string | null;
  owner: 'user' | 'guest' | 'none';
  groups: CartVendorGroup[];
  itemCount: number;
  lineCount: number;
  itemsSubtotal: string;
  shippingTotal: string;
  payableAmount: string;
  hasPriceChanges: boolean;
  canCheckout: boolean;
}

/* ─── Addresses ─────────────────────────────────────────────────────────── */

export interface Address {
  id: string;
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber: string | null;
  unitNumber: string | null;
  recipientName: string;
  recipientMobile: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AddressList {
  items: Address[];
  total: number;
  limit: number;
}

export interface AddressInput {
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber?: string | null;
  unitNumber?: string | null;
  recipientName: string;
  recipientMobile: string;
  isDefault?: boolean;
}

/* ─── Orders ────────────────────────────────────────────────────────────── */

export interface AddressSnapshot {
  province: string;
  city: string;
  postalAddress: string;
  postalCode: string;
  buildingNumber: string | null;
  unitNumber: string | null;
  recipientName: string;
  recipientMobile: string;
}

export interface OrderItem {
  id: string;
  productVariantId: string | null;
  productTitle: string;
  sku: string;
  vendorStoreName: string;
  variantDetails: { colorName: string | null; colorHex: string | null; size: string | null; guarantee: string | null };
  unitPrice: string;
  quantity: number;
  discount: string;
  lineTotal: string;
}

export interface VendorOrderItem extends OrderItem {
  commissionRate: string;
  commissionAmount: string;
}

export interface StoreRef {
  id: string;
  storeName: string;
  storeSlug: string;
}

export interface TimelineEvent {
  at: string;
  type: 'ORDER_PLACED' | 'PAYMENT_CONFIRMED' | 'ORDER_CANCELLED' | 'PAYMENT_FAILED' | 'SUB_ORDER_STATUS';
  subOrderNumber: string | null;
  fromStatus: SubOrderStatus | null;
  toStatus: SubOrderStatus | null;
  actor: string;
  note: string | null;
}

export interface CustomerSubOrder {
  id: string;
  subOrderNumber: string;
  store: StoreRef;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  total: string;
  trackingCode: string | null;
  carrierName: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: OrderItem[];
}

export interface OrderMoney {
  id: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: PaymentMethod;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string | null;
  createdAt: string;
}

export interface CustomerSubOrderSummary {
  id: string;
  subOrderNumber: string;
  storeName: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  itemCount: number;
  trackingCode: string | null;
}

export interface CustomerOrderSummary extends OrderMoney {
  subOrders: CustomerSubOrderSummary[];
}

export interface CustomerOrderDetail extends OrderMoney {
  shippingAddress: AddressSnapshot;
  customerNote: string | null;
  paidAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  canCancel: boolean;
  subOrders: CustomerSubOrder[];
  timeline: TimelineEvent[];
}

export interface CheckoutResponse {
  parentOrderId: string;
  orderNumber: string;
  paymentStatus: ParentOrderPaymentStatus;
  paymentMethod: PaymentMethod;
  totalItemsAmount: string;
  totalShippingFee: string;
  totalDiscountAmount: string;
  finalPayableAmount: string;
  paymentExpiresAt: string | null;
  subOrders: CustomerSubOrder[];
}

export interface StatusHistoryEntry {
  fromStatus: SubOrderStatus | null;
  toStatus: SubOrderStatus;
  actorRole: string;
  note: string | null;
  at: string;
}

export interface VendorSubOrderSummary {
  id: string;
  subOrderNumber: string;
  orderNumber: string;
  status: SubOrderStatus;
  itemsSubtotal: string;
  shippingFee: string;
  platformCommissionAmount: string;
  vendorEarningsAmount: string;
  itemCount: number;
  trackingCode: string | null;
  carrierName: string | null;
  placedAt: string;
  paidAt: string | null;
  allowedTransitions: SubOrderStatus[];
}

export interface VendorSubOrderDetail extends Omit<VendorSubOrderSummary, 'itemCount'> {
  itemCount: number;
  shippingAddress: AddressSnapshot;
  customerNote: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancellationReason: string | null;
  items: VendorOrderItem[];
  history: StatusHistoryEntry[];
}

export type WalletAction = 'ESCROW_RELEASED' | 'ESCROW_REVERSED' | 'EARNINGS_REVERSED' | 'DISPUTE_HOLD_REFUNDED' | 'DISPUTE_HOLD_RELEASED' | 'NONE';

export interface VendorSubOrderTransition {
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
  subOrder: VendorSubOrderDetail;
}

export interface CustomerDeliveryConfirmation {
  previousStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
  walletAction: WalletAction;
  auditLogId: string;
  order: CustomerOrderDetail;
}

/* ─── Payments & credit ─────────────────────────────────────────────────── */

export interface InitiatePaymentResponse {
  paymentId: string;
  redirectUrl: string;
  gatewayName: 'SANDBOX' | 'ZARINPAL';
  amount: string;
  currency: string;
  orderNumber: string;
  paymentExpiresAt: string | null;
}

export interface InstallmentPlanRef {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
}

export interface CreditPaymentInitiateResponse {
  status: 'COMPLETED' | 'IPG_REQUIRED';
  paymentId: string;
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: 'BANK_CREDIT' | 'HYBRID';
  creditAmount: string;
  cashAmount: string;
  currency: string;
  plan: InstallmentPlanRef;
  orderPaymentStatus: ParentOrderPaymentStatus;
  redirectUrl: string | null;
  gatewayName: string | null;
  paymentExpiresAt: string | null;
  schedule: {
    installments: number;
    creditAmount: string;
    totalInterest: string;
    totalPayable: string;
    firstDueDate: string;
    lastDueDate: string;
  } | null;
}

export interface CreditProviderSummary {
  code: string;
  name: string;
  isSandbox: boolean;
}

export interface CreditAccount {
  id: string;
  provider: CreditProviderSummary;
  status: CreditAccountStatus;
  totalLimit: string;
  usedAmount: string;
  reservedAmount: string;
  availableAmount: string;
  currency: string;
  expiresAt: string | null;
  createdAt: string;
  outstanding: { count: number; overdueCount: number; principal: string; interest: string; nextDueDate: string | null };
}

export interface CreditApplication {
  id: string;
  status: CreditApplicationStatus;
  provider: CreditProviderSummary;
  requestedLimit: string;
  approvedLimit: string | null;
  trackingCode: string | null;
  score: number | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
  account: CreditAccount | null;
}

export interface InstallmentPlan {
  id: string;
  title: string;
  durationMonths: number;
  interestRatePercent: string;
  penaltyRatePercentPerMonth: string;
  installmentIntervalDays: number;
}

export interface CreditPlans {
  creditEnabled: boolean;
  provider: CreditProviderSummary | null;
  items: InstallmentPlan[];
}

export interface Installment {
  id: string;
  installmentNumber: number;
  totalInstallments: number;
  dueDate: string;
  principalAmount: string;
  interestAmount: string;
  penaltyAmount: string;
  totalAmount: string;
  paidAmount: string;
  amountDue: string;
  status: InstallmentStatus;
  paidAt: string | null;
}

export interface OrderInstallments {
  parentOrderId: string;
  orderNumber: string;
  paymentMethod: PaymentMethod;
  paidAt: string | null;
  plan: InstallmentPlanRef | null;
  creditAmount: string;
  totalInterest: string;
  totalPayable: string;
  paidAmount: string;
  remainingAmount: string;
  paidCount: number;
  overdueCount: number;
  installments: Installment[];
}

export interface InstallmentsOverview {
  orders: OrderInstallments[];
  totalRemaining: string;
  overdueCount: number;
}

export interface InstallmentPaymentResponse {
  paymentId: string;
  installmentId: string;
  installmentNumber: number;
  totalInstallments: number;
  orderNumber: string;
  redirectUrl: string;
  gatewayName: string;
  amount: string;
  currency: string;
}

/* ─── Disputes ──────────────────────────────────────────────────────────── */

export interface DisputeEvidence {
  id: string;
  uploadedBy: 'CUSTOMER' | 'VENDOR' | 'STAFF';
  fileUrl: string;
  fileType: string | null;
  caption: string | null;
  createdAt: string;
}

export interface DisputeEvent {
  type: DisputeEventType;
  actorRole: string;
  fromStatus: DisputeStatus | null;
  toStatus: DisputeStatus | null;
  note: string | null;
  createdAt: string;
}

export interface Dispute {
  id: string;
  status: DisputeStatus;
  reason: DisputeReason;
  description: string;
  package: {
    subOrderId: string;
    subOrderNumber: string;
    orderNumber: string;
    status: SubOrderStatus;
    vendorId: string;
    storeName: string;
    itemsSubtotal: string;
    shippingFee: string;
  };
  subOrderStatusAtOpen: SubOrderStatus;
  vendorResponse: { action: DisputeVendorAction; defenseNotes: string; respondedAt: string } | null;
  resolution: {
    outcome: DisputeStatus;
    notes: string | null;
    resolvedAt: string;
    decidedBy: 'VENDOR' | 'STAFF';
    refundAmount: string | null;
    itemReturned: boolean | null;
    restocked: boolean;
  } | null;
  cancelledAt: string | null;
  evidence: DisputeEvidence[];
  timeline: DisputeEvent[];
  createdAt: string;
  updatedAt: string;
}

export interface DisputeHold {
  source: WalletBalanceBucket | null;
  amount: string;
  shortfall: string;
  unrecovered: string;
}

export interface VendorDispute extends Dispute {
  customerName: string;
  customerMobileMasked: string;
  hold: DisputeHold;
}

export interface DisputeParty {
  userId: string;
  name: string;
  mobile: string;
}

export interface AdminDisputeSummary extends Dispute {
  customer: DisputeParty;
  hold: DisputeHold;
}

export interface AdminDisputeDossier extends AdminDisputeSummary {
  order: {
    id: string;
    orderNumber: string;
    paymentStatus: ParentOrderPaymentStatus;
    paymentMethod: PaymentMethod;
    finalPayableAmount: string;
    createdAt: string;
  };
  items: Array<{ productTitle: string; sku: string; quantity: number; unitPrice: string; totalLineAmount: string }>;
  packageHistory: Array<{ fromStatus: SubOrderStatus | null; toStatus: SubOrderStatus; actorRole: string; note: string | null; createdAt: string }>;
  payments: Array<{
    id: string;
    gatewayName: string;
    paymentMethod: PaymentMethod;
    status: string;
    cashAmount: string;
    creditAmount: string;
    bankRrn: string | null;
    paidAt: string | null;
  }>;
  vendorWallet: {
    pendingBalance: string;
    withdrawableBalance: string;
    settlementHoldBalance: string;
    disputeHoldBalance: string;
    totalEarnedBalance: string;
    totalWithdrawnAmount: string;
  };
  vendorEarningsAmount: string;
}

export interface DisputeActionResult {
  dispute: Dispute;
  walletAction: 'FROZEN' | 'REFUNDED' | 'RELEASED_TO_WITHDRAWABLE' | 'RETURNED_TO_ESCROW' | 'NONE';
  subOrderStatus: SubOrderStatus;
  stockAction: 'RESTOCKED' | 'NONE';
}

/* ─── Vendors ───────────────────────────────────────────────────────────── */

export interface VendorWalletSummary {
  pendingBalance: string;
  withdrawableBalance: string;
  totalEarnedBalance: string;
  updatedAt: string;
}

export interface VendorVerification {
  id: string;
  nationalIdCardUrl: string;
  businessLicenseUrl: string | null;
  bankAccountProofUrl: string | null;
  rejectionReason: string | null;
  reviewedByUserId: string | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  createdAt: string;
}

export interface MediaAssetSummary {
  id: string;
  kind: 'IMAGE' | 'DOCUMENT';
  purpose: string;
  url: string;
  thumbnailUrl: string | null;
  isPublic: boolean;
  createdAt: string;
}

export interface VendorProfile {
  id: string;
  userId: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: string | null;
  status: VendorStatus;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  wallet: VendorWalletSummary | null;
  verification: VendorVerification | null;
  mediaAssets: MediaAssetSummary[];
}

export interface RegisterVendorInput {
  storeName: string;
  storeSlug: string;
  instagramHandle?: string;
  bio?: string;
  bankIban: string;
  bankAccountHolder: string;
}

export interface VendorOwner {
  id: string;
  mobile: string;
  email: string | null;
  fullName: string;
  role: UserRole;
  isActive: boolean;
}

export interface VendorAdminSummary {
  id: string;
  storeName: string;
  storeSlug: string;
  instagramHandle: string | null;
  logoUrl: string | null;
  status: VendorStatus;
  verifiedAt: string | null;
  productCount: number;
  wallet: VendorWalletSummary | null;
  owner: VendorOwner;
  createdAt: string;
}

export interface VendorAuditEntry {
  id: string;
  action: string;
  entityName: string;
  entityId: string | null;
  actorId: string | null;
  actorName: string | null;
  ipAddress: string | null;
  oldValue: unknown;
  newValue: unknown;
  createdAt: string;
}

export interface VendorAdminDetail extends VendorAdminSummary {
  bio: string | null;
  bankIban: string;
  bankAccountHolder: string | null;
  commissionRateOverride: string | null;
  verifications: VendorVerification[];
  mediaAssets: MediaAssetSummary[];
  auditTrail: VendorAuditEntry[];
}

/* ─── Wallet & settlements ──────────────────────────────────────────────── */

export interface WalletSummary {
  pendingBalance: string;
  withdrawableBalance: string;
  settlementHoldBalance: string;
  disputeHoldBalance: string;
  totalEarnedBalance: string;
  totalWithdrawnAmount: string;
  currency: string;
}

export interface WalletTransaction {
  id: string;
  type: WalletTransactionType;
  bucket: WalletBalanceBucket;
  amount: string;
  balanceAfter: string;
  subOrderId: string | null;
  subOrderNumber: string | null;
  settlementRequestId: string | null;
  description: string | null;
  createdAt: string;
}

export interface SettlementRequest {
  id: string;
  vendorId: string;
  storeName: string;
  amount: string;
  targetIban: string;
  status: SettlementStatus;
  bankPayaReference: string | null;
  rejectionReason: string | null;
  processedAt: string | null;
  processedBy: { id: string; fullName: string | null } | null;
  createdAt: string;
}

/* ─── Admin financial ───────────────────────────────────────────────────── */

export interface FinancialOverview {
  currency: string;
  from: string | null;
  to: string | null;
  generatedAt: string;
  sales: {
    paidOrders: number;
    activePackages: number;
    gmv: string;
    shippingFees: string;
    collectedByGateway: string;
    fundedByCredit: string;
    installmentsCollected: string;
  };
  commission: { earned: string; pending: string; total: string };
  wallets: {
    escrowHeld: string;
    withdrawable: string;
    settlementHold: string;
    disputeHold: string;
    totalWithdrawn: string;
    ledgerConsistent: boolean;
    inconsistentWallets: number;
  };
  settlements: { pendingCount: number; pendingAmount: string; paidCount: number; paidAmount: string };
  paymentsRequiringManualRefund: number;
  disputes: {
    open: number;
    underArbitration: number;
    resolvedForBuyer: number;
    refundsOwedToCustomers: string;
    unrecoveredVendorEarnings: string;
  };
}
```

### `apps/frontend/src/lib/brand.ts`

```ts
/**
 * Platform identity shown in the UI. Mirrors apps/backend/src/common/brand.ts
 * (and the `platform.name` system config seeded by the backend).
 */
export const PLATFORM_NAME = 'شاگردم';
export const PLATFORM_NAME_EN = 'Shagerdam';
export const PLATFORM_TAGLINE = 'پلتفرم هوشمند خرید و فروش اقساطی';
/** Document title of the home page and default for pages without their own title. */
export const PLATFORM_TITLE = `${PLATFORM_NAME} | ${PLATFORM_TAGLINE}`;
/** Monogram shown in the header/footer logo box. */
export const PLATFORM_MONOGRAM = 'ش';
```

### `apps/frontend/src/lib/product-specs.test.ts`

```ts
import { describe, expect, it } from 'vitest';

import type { ImportedProductDraft } from './api/types';
import {
  MAX_SPECIFICATIONS_PER_PRODUCT,
  draftSpecRows,
  emptySpecRow,
  groupSpecifications,
  imageFailureMessage,
  importStrategyLabels,
  ingestedToUploaded,
  specRowsFrom,
  specRowsToInput,
} from './product-specs';

const row = (groupTitle: string, title: string, value: string) => ({ ...emptySpecRow(), groupTitle, title, value });

describe('specRowsToInput', () => {
  it('trims, maps empty groups to null, normalises line breaks and drops untouched rows', () => {
    const result = specRowsToInput([row(' دوربین ', ' رزولوشن ', ' 200 مگاپیکسل '), emptySpecRow(), row('', 'سایر', 'خط ۱\r\nخط ۲')]);
    expect(result).toEqual({
      ok: true,
      value: [
        { groupTitle: 'دوربین', title: 'رزولوشن', value: '200 مگاپیکسل' },
        { groupTitle: null, title: 'سایر', value: 'خط ۱\nخط ۲' },
      ],
    });
  });

  it('rejects half-filled rows instead of dropping them', () => {
    expect(specRowsToInput([row('', 'وزن', '  ')])).toEqual({ ok: false, error: 'ردیف 1 مشخصات: مقدار «وزن» خالی است.' });
    expect(specRowsToInput([row('کلی', '', '5')])).toMatchObject({ ok: false });
  });

  it('enforces the backend length and count limits', () => {
    expect(specRowsToInput([row('', 'x'.repeat(151), '1')])).toMatchObject({ ok: false });
    expect(specRowsToInput([row('', 'x', 'v'.repeat(2001))])).toMatchObject({ ok: false });
    const many = Array.from({ length: MAX_SPECIFICATIONS_PER_PRODUCT + 1 }, (_, i) => row('', `t${i}`, 'v'));
    expect(specRowsToInput(many)).toMatchObject({ ok: false });
  });
});

describe('groupSpecifications', () => {
  it('groups consecutive rows by group title, keeping order', () => {
    const groups = groupSpecifications([
      { groupTitle: 'دوربین', title: 'a', value: '1' },
      { groupTitle: 'دوربین', title: 'b', value: '2' },
      { groupTitle: null, title: 'c', value: '3' },
      { groupTitle: 'دوربین', title: 'd', value: '4' },
    ]);
    expect(groups.map((group) => [group.groupTitle, group.items.map((item) => item.title)])).toEqual([
      ['دوربین', ['a', 'b']],
      [null, ['c']],
      ['دوربین', ['d']],
    ]);
  });
});

describe('import helpers', () => {
  const draft: ImportedProductDraft = {
    source: 'DIGIKALA',
    strategies: ['DIGIKALA_API'],
    sourceUrl: 'https://www.digikala.com/product/dkp-1/',
    sourceProductId: 'dkp-1',
    title: 't',
    titleEn: null,
    brand: null,
    description: null,
    suggestedCategory: null,
    suggestedCategoryId: null,
    specifications: [
      { group: 'مشخصات', title: 'جنس', value: 'پلی کربنات' },
      { group: null, title: 'وزن', value: '5 گرم' },
    ],
    imageUrls: [],
  };

  it('turns draft specifications into editable rows', () => {
    expect(draftSpecRows(draft).map(({ groupTitle, title, value }) => ({ groupTitle, title, value }))).toEqual([
      { groupTitle: 'مشخصات', title: 'جنس', value: 'پلی کربنات' },
      { groupTitle: '', title: 'وزن', value: '5 گرم' },
    ]);
  });

  it('gives each row a unique key', () => {
    const keys = specRowsFrom([{ groupTitle: null, title: 'a', value: '1' }, { groupTitle: null, title: 'b', value: '2' }]).map((r) => r.key);
    expect(new Set(keys).size).toBe(2);
  });

  it('maps an ingested image to a gallery entry named after the source file', () => {
    expect(
      ingestedToUploaded({
        sourceUrl: 'https://dkstatics-public.digikala.com/digikala-products/abc_1.jpg',
        id: 'id-1',
        url: '/media/images/x.webp',
        thumbnailUrl: '/media/images/x_thumb.webp',
        width: 800,
        height: 800,
        sizeBytes: 1000,
      }),
    ).toEqual({ id: 'id-1', url: '/media/images/x.webp', thumbnailUrl: '/media/images/x_thumb.webp', name: 'abc_1.jpg' });
  });

  it('labels strategies and image failures in Persian', () => {
    expect(importStrategyLabels(draft)).toEqual(['API دیجی‌کالا']);
    expect(imageFailureMessage('INVALID_IMAGE')).toContain('معتبر نیست');
    expect(imageFailureMessage('SOMETHING_NEW')).toBe('تصویر دریافت نشد.');
  });
});
```

### `apps/frontend/src/lib/product-specs.ts`

```ts
import type { UploadedFile } from '@/components/ui/file-drop';
import type { ImportedProductDraft, IngestedImage, ProductSpecification } from '@/lib/api/types';

/** Mirrors backend product-rules.ts (and the product_specifications columns). */
export const MAX_SPECIFICATIONS_PER_PRODUCT = 150;
export const SPECIFICATION_GROUP_MAX_LENGTH = 100;
export const SPECIFICATION_TITLE_MAX_LENGTH = 150;
export const SPECIFICATION_VALUE_MAX_LENGTH = 2000;

/** Editable specification row (a stable `key` keeps React inputs attached while rows move). */
export interface SpecRow {
  key: string;
  groupTitle: string;
  title: string;
  value: string;
}

let specCounter = 0;
export function newSpecKey(): string {
  specCounter += 1;
  return `spec-${specCounter}`;
}

export function emptySpecRow(groupTitle = ''): SpecRow {
  return { key: newSpecKey(), groupTitle, title: '', value: '' };
}

export function specRowsFrom(list: ReadonlyArray<ProductSpecification>): SpecRow[] {
  return list.map((spec) => ({ key: newSpecKey(), groupTitle: spec.groupTitle ?? '', title: spec.title, value: spec.value }));
}

export type SpecResult = { ok: true; value: ProductSpecification[] } | { ok: false; error: string };

/**
 * Validates the rows and returns the API payload. Completely empty rows are
 * dropped silently (an "add row" the vendor never filled); a half-filled row is
 * an error so nothing the vendor typed disappears without notice.
 */
export function specRowsToInput(rows: ReadonlyArray<SpecRow>): SpecResult {
  const value: ProductSpecification[] = [];
  for (const [index, row] of rows.entries()) {
    const groupTitle = row.groupTitle.trim();
    const title = row.title.trim();
    const text = row.value.replace(/\r\n?/g, '\n').trim();
    if (!groupTitle && !title && !text) continue;
    const label = `ردیف ${index + 1} مشخصات`;
    if (!title) return { ok: false, error: `${label}: عنوان ویژگی خالی است.` };
    if (!text) return { ok: false, error: `${label}: مقدار «${title}» خالی است.` };
    if (groupTitle.length > SPECIFICATION_GROUP_MAX_LENGTH) return { ok: false, error: `${label}: نام گروه حداکثر ${SPECIFICATION_GROUP_MAX_LENGTH} نویسه است.` };
    if (title.length > SPECIFICATION_TITLE_MAX_LENGTH) return { ok: false, error: `${label}: عنوان حداکثر ${SPECIFICATION_TITLE_MAX_LENGTH} نویسه است.` };
    if (text.length > SPECIFICATION_VALUE_MAX_LENGTH) return { ok: false, error: `${label}: مقدار حداکثر ${SPECIFICATION_VALUE_MAX_LENGTH} نویسه است.` };
    value.push({ groupTitle: groupTitle || null, title, value: text });
  }
  if (value.length > MAX_SPECIFICATIONS_PER_PRODUCT) {
    return { ok: false, error: `حداکثر ${MAX_SPECIFICATIONS_PER_PRODUCT} ردیف مشخصات مجاز است.` };
  }
  return { ok: true, value };
}

/** Consecutive rows with the same group, for display (the storefront table and the editor). */
export function groupSpecifications<T extends { groupTitle: string | null }>(list: ReadonlyArray<T>): Array<{ groupTitle: string | null; items: T[] }> {
  const groups: Array<{ groupTitle: string | null; items: T[] }> = [];
  for (const item of list) {
    const last = groups[groups.length - 1];
    if (last && last.groupTitle === item.groupTitle) last.items.push(item);
    else groups.push({ groupTitle: item.groupTitle, items: [item] });
  }
  return groups;
}

/** Gallery entry for an image the importer stored in our media pipeline. */
export function ingestedToUploaded(image: IngestedImage): UploadedFile {
  const name = decodeURIComponent(new URL(image.sourceUrl).pathname.split('/').filter(Boolean).pop() ?? 'image');
  return { id: image.id, url: image.url, thumbnailUrl: image.thumbnailUrl, name };
}

/** Specification rows from an import draft (group → groupTitle). */
export function draftSpecRows(draft: ImportedProductDraft): SpecRow[] {
  return specRowsFrom(draft.specifications.map((spec) => ({ groupTitle: spec.group, title: spec.title, value: spec.value })));
}

const SOURCE_LABELS: Record<ImportedProductDraft['source'], string> = { DIGIKALA: 'دیجی‌کالا', GENERIC: 'سایت فروشگاهی' };
const STRATEGY_LABELS: Record<ImportedProductDraft['strategies'][number], string> = {
  DIGIKALA_API: 'API دیجی‌کالا',
  JSON_LD: 'Schema.org (JSON-LD)',
  MICRODATA: 'Microdata',
  WOOCOMMERCE_ATTRIBUTES: 'جدول ویژگی‌های ووکامرس',
  OPEN_GRAPH: 'OpenGraph',
  HTML_META: 'عنوان و توضیح صفحه',
};

export function importSourceLabel(draft: ImportedProductDraft): string {
  return SOURCE_LABELS[draft.source];
}

export function importStrategyLabels(draft: ImportedProductDraft): string[] {
  return draft.strategies.map((strategy) => STRATEGY_LABELS[strategy] ?? strategy);
}

const IMAGE_FAILURE_MESSAGES: Record<string, string> = {
  INVALID_IMAGE: 'فایل تصویر معتبر نیست یا قالب آن پشتیبانی نمی‌شود.',
  UPSTREAM_STATUS: 'سرور تصویر خطا داد.',
  TIMEOUT: 'دریافت تصویر بیش از ۱۰ ثانیه طول کشید.',
  TOO_LARGE: 'حجم تصویر بیش از حد مجاز است.',
  NETWORK: 'ارتباط با سرور تصویر برقرار نشد.',
  BLOCKED_TARGET: 'نشانی تصویر غیرعمومی است.',
  TOO_MANY_REDIRECTS: 'سرور تصویر بیش از حد تغییر مسیر داد.',
  UNSUPPORTED_CONTENT: 'قالب پاسخ پشتیبانی نمی‌شود.',
};

export function imageFailureMessage(code: string): string {
  return IMAGE_FAILURE_MESSAGES[code] ?? 'تصویر دریافت نشد.';
}
```

### `deploy/nginx/templates/shopino.conf.template`

```nginx
# =============================================================================
# Shopino site — rendered by docker-entrypoint.sh (envsubst) at container start.
# Variables: ${SHOPINO_DOMAIN} ${SHOPINO_SERVER_NAMES} ${SHOPINO_CSP}
#            ${FRONTEND_UPSTREAM}
#
# Routing (matches the Phase-10 architecture):
#   every public request → Next.js (storefront, panels, BFF /api/v1 + /api/session)
#   The NestJS API is NOT published: it listens on the private compose network
#   and is reached only by the BFF (server-to-server, Bearer tokens from the
#   httpOnly session cookies). Swagger (/api/docs) is therefore not public.
# =============================================================================

upstream shopino_frontend {
    server ${FRONTEND_UPSTREAM} max_fails=3 fail_timeout=10s;
    keepalive 32;
}

map $host $shopino_csp {
    default "${SHOPINO_CSP}";
}

# ── Port 80: ACME challenges, health probe, redirect everything else ────────
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Let's Encrypt HTTP-01 (certbot --webroot writes here).
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type text/plain;
        try_files $uri =404;
    }

    # Container health check (local only).
    location = /nginx-health {
        access_log off;
        allow 127.0.0.1;
        allow ::1;
        deny all;
        default_type text/plain;
        return 200 "ok\n";
    }

    location / {
        return 301 https://${SHOPINO_DOMAIN}$request_uri;
    }
}

# ── Port 443, unknown Host / SNI: refuse the TLS handshake ─────────────────
server {
    listen 443 ssl default_server;
    listen [::]:443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
}

# ── Port 443, the shop ──────────────────────────────────────────────────────
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    http2 on;
    server_name ${SHOPINO_SERVER_NAMES};

    # Certificate: Let's Encrypt when issued, otherwise a 7-day self-signed
    # placeholder (the entrypoint switches automatically on the next reload).
    ssl_certificate     /etc/nginx/certs/active/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/active/privkey.pem;

    # Mozilla "intermediate" profile (TLS 1.2 + 1.3).
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384;
    ssl_prefer_server_ciphers off;
    ssl_session_cache shared:shopino_tls:10m;
    ssl_session_timeout 1d;
    ssl_session_tickets off;

    # Connection cap per client address (DDoS / scraping guard).
    limit_conn shopino_conn 60;

    # Non-www canonical host.
    if ($host != "${SHOPINO_DOMAIN}") {
        return 301 https://${SHOPINO_DOMAIN}$request_uri;
    }

    include /etc/nginx/snippets/security-headers.conf;

    # JSON body for rate-limited API calls (the web UI localises status 429).
    error_page 429 = @rate_limited;
    location @rate_limited {
        include /etc/nginx/snippets/security-headers.conf;
        default_type application/json;
        return 429 '{"statusCode":429,"error":"Too Many Requests","message":"تعداد درخواست‌ها بیش از حد مجاز است؛ لطفاً کمی بعد دوباره تلاش کنید."}';
    }

    # Hidden files (except ACME, served on :80) are never proxied.
    location ~ /\.(?!well-known/) {
        deny all;
    }

    # Sign-in endpoints: strict per-IP budget on top of the API's own OTP
    # limits. Exact/prefix matches (not regex): the `^~ /api/` prefix below
    # would otherwise stop nginx from evaluating a regex location.
    #   /api/session/{otp,verify,password}  — BFF sign-in routes
    #   /api/v1/auth/                       — the generic BFF also forwards
    #                                         auth/otp/request; the browser never
    #                                         calls /api/v1/auth/* directly.
    location = /api/session/otp {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
    location = /api/session/verify {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
    location = /api/session/password {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
    location ^~ /api/v1/auth/ {
        limit_req zone=shopino_auth burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }

    # Uploads (product images, KYC and dispute evidence): 15 MB cap here only.
    # The API still enforces MEDIA_MAX_IMAGE_BYTES / MEDIA_MAX_DOCUMENT_BYTES and
    # checks file signatures.
    location ^~ /api/v1/media/upload/ {
        client_max_body_size 15m;
        client_body_timeout 60s;
        proxy_read_timeout 120s;
        proxy_send_timeout 120s;
        limit_req zone=shopino_upload burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }

    # Product importer: the API fetches a remote page (≤ 10 s; for Digikala the
    # API and then the product page) or copies up to 12 remote images (3 at a
    # time, ≤ 10 s each, plus WebP processing), so answers can exceed the
    # default 60 s read timeout. The API also enforces per-vendor quotas.
    location ^~ /api/v1/vendor/products/import/ {
        proxy_read_timeout 150s;
        proxy_send_timeout 150s;
        limit_req zone=shopino_api burst=10 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }

    # Same-origin BFF (JSON API for the browser).
    location ^~ /api/ {
        limit_req zone=shopino_api burst=60 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }

    # Content-hashed build assets: immutable, no rate limit, no access log.
    location ^~ /_next/static/ {
        access_log off;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
        proxy_hide_header Cache-Control;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
    }

    # Pages (SSR/streaming).
    location / {
        limit_req zone=shopino_web burst=80 nodelay;
        include /etc/nginx/snippets/security-headers.conf;
        include /etc/nginx/snippets/proxy-frontend.conf;
    }
}
```

### `docs/importer-verification.md`

```md
# Smart Product Spec Importer + «شاگردم» rebrand — verification report

Base commit: `0765a1e` (Phase 11). Everything below was run in the development
sandbox against **real PostgreSQL 16 and Redis 7 containers** (`shopino_postgres`,
`shopino_redis`). The full suite used a freshly created database
(`shopino_e2e_tm`: `prisma migrate deploy` + seed), because the long-lived dev DB
is polluted by earlier manual runs (a known issue, see Phase 10).

## 1. Results

| Check | Command | Result |
| --- | --- | --- |
| Lint + typecheck (backend + frontend) | `pnpm exec turbo run lint typecheck --concurrency=1` | 4/4 tasks OK, 0 errors |
| Backend unit | `cd apps/backend && pnpm exec jest` | **522/522** (37 suites; importer alone 179) |
| Backend E2E (all suites) | `cd apps/backend && pnpm test:e2e` | **305/305** (11 suites, 80.9 s), incl. `importer.e2e-spec.ts` 31/31 |
| Frontend unit (vitest) | `cd apps/frontend && pnpm exec vitest run` | **68/68** (10 files; +8 in `product-specs.test.ts`) |
| Build | `pnpm exec turbo run build --concurrency=1 --force` | backend + frontend OK |
| nginx | image built, container booted, `nginx -t` | healthy, syntax OK, import location rendered |
| Live browser check (Playwright/Chromium) | `tmpdoc/tm-import-browser.py` (not shipped) | **22/22** |

## 2. Acceptance criteria

| Criterion | Evidence |
| --- | --- |
| Unit tests for `DigikalaExtractor` and `GenericSchemaOrgExtractor` | `extractors/digikala.extractor.spec.ts`, `extractors/generic-schema.extractor.spec.ts` (fixtures: two Digikala API payloads, WooCommerce, Shopify, microdata) |
| SSRF rejects `http://127.0.0.1:4000` and `http://192.168.1.1` | unit (`net/address-policy.spec.ts`, `net/import-url.spec.ts`) and E2E (11 blocked targets, including those two, DNS rebinding and a redirect to 169.254.169.254) |
| E2E extract from a valid payload | E2E: Digikala API payload served from a local fixture server (only the test overrides the network policy); generic WooCommerce page |
| Ingest creates WebP assets in storage | E2E: the files exist in local storage, `image/webp`, with thumbnails; per-image failures are reported |
| Creating the product with the extracted data persists in PostgreSQL | E2E, and the browser check: product `e26f89b5-…` → `products` row with brand, 2 `product_media` (WebP `media_assets`), a `product_specifications` row updated from the edit page |
| `pnpm build` passes | see §1 |

## 3. Live browser run (real public page, no mocks)

Source page: `https://www.allbirds.com/products/mens-tree-runners` (Shopify).

- Home `<title>` = «شاگردم | پلتفرم هوشمند خرید و فروش اقساطی»; header/footer show the new brand; no «شاپینو» in the rendered HTML.
- Vendor (seeded, approved) → `/vendor/products/new`: the import panel is at the top.
- `ftp://…` is rejected client-side. `http://127.0.0.1:4000/…` is rejected by the API with the Persian `IMPORT_BLOCKED_TARGET` message.
- Fetch: the pending label is shown; the preview opens in 0.9 s. It shows source «سایت فروشگاهی», strategies JSON-LD + OpenGraph, title, brand, a category warning, and a list of 2 images (no remote `<img>`, per the CSP).
- «اعمال در فرم»: title, brand and description are filled; 2 images are ingested and shown from our storage; notes appear in the panel.
- The vendor adds category, price, 1 spec row and 1 variant → saved → redirected to the edit page.
- DB check done; the spec is edited and saved on the edit page (DB check done); no console errors, no 5xx.

Screenshots (not shipped): `tmpdoc/tm-shots/01-home.png … 04-edit.png`.

## 4. Not verified / limits

- **Digikala live**: the sandbox is geoblocked by Digikala (API and CDN). The parser is tested against real API payloads captured with a page fetcher (`dkp-13196935` verbatim; `dkp-18010600` a partly reconstructed subset). It must be re-checked from a server inside Iran.
- The storefront spec table (`components/catalog/product-specifications.tsx`) is covered by typecheck, build and `groupSpecifications` unit tests. It was not browser-checked, because the new product awaits admin moderation.
- The nginx import location (150 s timeouts, `burst=10`) was validated with `nginx -t`, not under load.
```

