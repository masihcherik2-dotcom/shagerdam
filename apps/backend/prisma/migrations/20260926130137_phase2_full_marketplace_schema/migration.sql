/*
  Phase 2 — full marketplace + BNPL schema.

  REVIEWED AND TUNED BY HAND after generation. Two generated statements were
  destructive and were replaced by data-preserving equivalents:

  1. `categories.title` is RENAMED to `title_fa` instead of being dropped and
     re-added. The column keeps its data; the field name now states the language
     explicitly (title_fa / title_en), matching the Prisma model.
  2. `users.mobile` is mandatory from Phase 2 on and cannot be derived from any
     Phase 1 column. Rather than inventing identifiers, the migration checks that
     the table is empty (true for the pre-launch rollout this targets) and aborts
     with an explicit message if rows must be backfilled first. The unique index
     on `users.mobile` and `users.national_code` is created afterwards.

  Everything else is additive: new tables, new enum values, new nullable columns
  and new indexes.

  Note for a future rollout onto a populated database: split this file into
  (a) add-nullable → (b) backfill from the identity provider → (c) set-not-null,
  and deploy the three steps separately.
*/
-- CreateEnum
CREATE TYPE "Gender" AS ENUM ('MALE', 'FEMALE', 'OTHER');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('CREATE', 'UPDATE', 'DELETE', 'LOGIN', 'LOGOUT', 'STATUS_CHANGE', 'SETTLEMENT_TRIGGER', 'PAYMENT_CAPTURE', 'CREDIT_DECISION', 'DISPUTE_RESOLUTION');

-- CreateEnum
CREATE TYPE "VendorStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH_IPG', 'BANK_CREDIT', 'HYBRID');

-- CreateEnum
CREATE TYPE "ParentOrderPaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SubOrderStatus" AS ENUM ('PENDING_APPROVAL', 'PROCESSING', 'SHIPPED', 'DELIVERED', 'CANCELLED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('INITIATED', 'SUCCESSFUL', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "WalletTransactionType" AS ENUM ('CREDIT_SALE_ESCROW_HOLD', 'ESCROW_RELEASE_TO_WITHDRAWABLE', 'COMMISSION_DEDUCTION', 'SETTLEMENT_PAYOUT', 'REFUND_DEDUCTION');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('REQUESTED', 'PROCESSING', 'PAID_PAYA', 'REJECTED');

-- CreateEnum
CREATE TYPE "CreditAccountStatus" AS ENUM ('ACTIVE', 'FROZEN', 'CLOSED');

-- CreateEnum
CREATE TYPE "CreditApplicationStatus" AS ENUM ('DRAFT', 'PENDING_BANK_INQUIRY', 'DOCS_REQUIRED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "CreditTransactionType" AS ENUM ('CREDIT_ALLOCATION', 'PURCHASE_RESERVE_HOLD', 'PURCHASE_COMMIT', 'RESERVATION_RELEASE', 'INSTALLMENT_REPAYMENT_RESTORE', 'REFUND_RESTORE');

-- CreateEnum
CREATE TYPE "InstallmentStatus" AS ENUM ('PENDING', 'PAID', 'OVERDUE', 'WAIVED');

-- CreateEnum
CREATE TYPE "DisputeReason" AS ENUM ('WRONG_ITEM', 'DAMAGED', 'NOT_AS_DESCRIBED', 'NOT_DELIVERED', 'COUNTERFEIT');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION', 'RESOLVED_BUYER_FAVOR', 'RESOLVED_VENDOR_FAVOR', 'CANCELLED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserRole" ADD VALUE 'FINANCIAL_OFFICER';
ALTER TYPE "UserRole" ADD VALUE 'SUPPORT';

-- AlterTable
-- AlterTable (data-preserving: rename, then add the commission rate with a default)
ALTER TABLE "categories" RENAME COLUMN "title" TO "title_fa";
ALTER TABLE "categories"
ADD COLUMN "default_commission_rate" DECIMAL(5,2) NOT NULL DEFAULT 0;

-- AlterTable
-- AlterTable
-- `mobile` is the mandatory business key of a platform user from Phase 2 on.
-- Phase 1 stored no mobile number, so the value cannot be derived from existing
-- data. Guard first, then add: a populated database must be backfilled with real
-- numbers instead of receiving fabricated ones.
DO $$
DECLARE
  existing_rows bigint;
BEGIN
  SELECT count(*) INTO existing_rows FROM "users";
  IF existing_rows > 0 THEN
    RAISE EXCEPTION
      'Phase 2 makes users.mobile mandatory and it cannot be derived from Phase 1 data. % row(s) in "users" need a real mobile number before this migration can run.',
      existing_rows;
  END IF;
END
$$;

ALTER TABLE "users"
ADD COLUMN "mobile" VARCHAR(15) NOT NULL,
ADD COLUMN "national_code" VARCHAR(10),
ALTER COLUMN "email" DROP NOT NULL,
ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "customer_profiles" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "birth_date" DATE,
    "gender" "Gender",
    "bank_iban" VARCHAR(26),
    "default_address_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "customer_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "addresses" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "province" VARCHAR(60) NOT NULL,
    "city" VARCHAR(60) NOT NULL,
    "postal_address" TEXT NOT NULL,
    "postal_code" VARCHAR(10) NOT NULL,
    "building_number" VARCHAR(20),
    "unit_number" VARCHAR(20),
    "recipient_name" VARCHAR(120) NOT NULL,
    "recipient_mobile" VARCHAR(15) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "action" "AuditAction" NOT NULL,
    "entity_name" VARCHAR(80) NOT NULL,
    "entity_id" VARCHAR(64),
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(512),
    "old_value" JSONB,
    "new_value" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "store_name" VARCHAR(120) NOT NULL,
    "store_slug" VARCHAR(140) NOT NULL,
    "instagram_handle" VARCHAR(60),
    "logo_url" VARCHAR(512),
    "bio" TEXT,
    "bank_iban" VARCHAR(26) NOT NULL,
    "commission_rate_override" DECIMAL(5,2),
    "status" "VendorStatus" NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_verifications" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "national_card_doc_url" VARCHAR(512) NOT NULL,
    "business_doc_url" VARCHAR(512),
    "rejection_reason" TEXT,
    "reviewed_by_user_id" UUID,
    "reviewed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vendor_verifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "category_id" UUID NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "slug" VARCHAR(220) NOT NULL,
    "description" TEXT,
    "brand" VARCHAR(80),
    "base_price" DECIMAL(15,2) NOT NULL,
    "is_published" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_variants" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "sku" VARCHAR(64) NOT NULL,
    "color_name" VARCHAR(40),
    "color_hex" VARCHAR(7),
    "size" VARCHAR(20),
    "guarantee" VARCHAR(60),
    "price" DECIMAL(15,2) NOT NULL,
    "compare_at_price" DECIMAL(15,2),
    "stock_quantity" INTEGER NOT NULL DEFAULT 0,
    "weight_grams" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "product_variants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "product_media" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "url" VARCHAR(512) NOT NULL,
    "thumbnail_url" VARCHAR(512),
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "product_media_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "session_token" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cart_items" (
    "id" UUID NOT NULL,
    "cart_id" UUID NOT NULL,
    "product_variant_id" UUID NOT NULL,
    "quantity" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "cart_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "parent_orders" (
    "id" UUID NOT NULL,
    "order_number" VARCHAR(20) NOT NULL,
    "user_id" UUID NOT NULL,
    "shipping_address_snapshot" JSONB NOT NULL,
    "total_items_amount" DECIMAL(15,2) NOT NULL,
    "total_shipping_fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_discount_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "final_payable_amount" DECIMAL(15,2) NOT NULL,
    "payment_method" "PaymentMethod" NOT NULL,
    "payment_status" "ParentOrderPaymentStatus" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "parent_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sub_orders" (
    "id" UUID NOT NULL,
    "parent_order_id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "sub_order_number" VARCHAR(24) NOT NULL,
    "items_subtotal" DECIMAL(15,2) NOT NULL,
    "shipping_fee" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "platform_commission_amount" DECIMAL(15,2) NOT NULL,
    "vendor_earnings_amount" DECIMAL(15,2) NOT NULL,
    "status" "SubOrderStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "tracking_code" VARCHAR(40),
    "carrier_name" VARCHAR(80),
    "delivered_at" TIMESTAMPTZ(3),
    "escrow_released_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sub_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" UUID NOT NULL,
    "sub_order_id" UUID NOT NULL,
    "product_variant_id" UUID,
    "product_title_snapshot" VARCHAR(200) NOT NULL,
    "variant_details_snapshot" JSONB NOT NULL,
    "unit_price_snapshot" DECIMAL(15,2) NOT NULL,
    "discount_snapshot" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "commission_rate_snapshot" DECIMAL(5,2) NOT NULL,
    "quantity" INTEGER NOT NULL,
    "total_line_amount" DECIMAL(15,2) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "parent_order_id" UUID NOT NULL,
    "gateway_name" VARCHAR(40) NOT NULL,
    "gateway_tracking_token" VARCHAR(120),
    "bank_rrn" VARCHAR(40),
    "cash_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "status" "PaymentStatus" NOT NULL DEFAULT 'INITIATED',
    "paid_at" TIMESTAMPTZ(3),
    "metadata" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_wallets" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "pending_balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "withdrawable_balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_earned_balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "vendor_wallets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wallet_transactions" (
    "id" UUID NOT NULL,
    "wallet_id" UUID NOT NULL,
    "sub_order_id" UUID,
    "settlement_request_id" UUID,
    "type" "WalletTransactionType" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "balance_after" DECIMAL(15,2) NOT NULL,
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wallet_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settlement_requests" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "target_iban" VARCHAR(26) NOT NULL,
    "status" "SettlementStatus" NOT NULL DEFAULT 'REQUESTED',
    "bank_paya_reference" VARCHAR(60),
    "processed_by_user_id" UUID,
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "settlement_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_providers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(80) NOT NULL,
    "code" VARCHAR(40) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "total_limit" DECIMAL(15,2) NOT NULL,
    "used_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "reserved_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "available_amount" DECIMAL(15,2) NOT NULL,
    "status" "CreditAccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "expires_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_applications" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "requested_limit" DECIMAL(15,2) NOT NULL,
    "approved_limit" DECIMAL(15,2),
    "status" "CreditApplicationStatus" NOT NULL DEFAULT 'DRAFT',
    "bank_application_tracking_code" VARCHAR(60),
    "bank_score_response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_transactions" (
    "id" UUID NOT NULL,
    "credit_account_id" UUID NOT NULL,
    "parent_order_id" UUID,
    "type" "CreditTransactionType" NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "balance_after" DECIMAL(15,2) NOT NULL,
    "reference_code" VARCHAR(80) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installment_plans" (
    "id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "duration_months" INTEGER NOT NULL,
    "interest_rate_percent" DECIMAL(5,2) NOT NULL,
    "penalty_rate_percent_per_month" DECIMAL(5,2) NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "installment_plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "installment_schedules" (
    "id" UUID NOT NULL,
    "parent_order_id" UUID NOT NULL,
    "credit_account_id" UUID NOT NULL,
    "installment_number" INTEGER NOT NULL,
    "total_installments" INTEGER NOT NULL,
    "due_date" DATE NOT NULL,
    "principal_amount" DECIMAL(15,2) NOT NULL,
    "interest_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(15,2) NOT NULL,
    "penalty_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "paid_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "status" "InstallmentStatus" NOT NULL DEFAULT 'PENDING',
    "paid_at" TIMESTAMPTZ(3),
    "bank_transaction_id" VARCHAR(80),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "installment_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disputes" (
    "id" UUID NOT NULL,
    "sub_order_id" UUID NOT NULL,
    "raised_by_user_id" UUID NOT NULL,
    "reason" "DisputeReason" NOT NULL,
    "description" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "resolution_notes" TEXT,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_evidence" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "uploaded_by_user_id" UUID NOT NULL,
    "file_url" VARCHAR(512) NOT NULL,
    "file_type" VARCHAR(40),
    "caption" VARCHAR(255),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_user_id_key" ON "customer_profiles"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_profiles_default_address_id_key" ON "customer_profiles"("default_address_id");

-- CreateIndex
CREATE INDEX "addresses_user_id_is_default_idx" ON "addresses"("user_id", "is_default");

-- CreateIndex
CREATE INDEX "addresses_user_id_created_at_idx" ON "addresses"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_name_entity_id_idx" ON "audit_logs"("entity_name", "entity_id");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_created_at_idx" ON "audit_logs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_action_created_at_idx" ON "audit_logs"("action", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_user_id_key" ON "vendors"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "vendors_store_slug_key" ON "vendors"("store_slug");

-- CreateIndex
CREATE INDEX "vendors_status_idx" ON "vendors"("status");

-- CreateIndex
CREATE INDEX "vendors_status_created_at_idx" ON "vendors"("status", "created_at");

-- CreateIndex
CREATE INDEX "vendor_verifications_vendor_id_created_at_idx" ON "vendor_verifications"("vendor_id", "created_at");

-- CreateIndex
CREATE INDEX "vendor_verifications_reviewed_by_user_id_idx" ON "vendor_verifications"("reviewed_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "products_slug_key" ON "products"("slug");

-- CreateIndex
CREATE INDEX "products_vendor_id_is_published_idx" ON "products"("vendor_id", "is_published");

-- CreateIndex
CREATE INDEX "products_category_id_is_published_idx" ON "products"("category_id", "is_published");

-- CreateIndex
CREATE INDEX "products_is_published_created_at_idx" ON "products"("is_published", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "product_variants_sku_key" ON "product_variants"("sku");

-- CreateIndex
CREATE INDEX "product_variants_product_id_is_active_idx" ON "product_variants"("product_id", "is_active");

-- CreateIndex
CREATE INDEX "product_variants_is_active_price_idx" ON "product_variants"("is_active", "price");

-- CreateIndex
CREATE INDEX "product_media_product_id_sort_order_idx" ON "product_media"("product_id", "sort_order");

-- CreateIndex
CREATE UNIQUE INDEX "carts_user_id_key" ON "carts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "carts_session_token_key" ON "carts"("session_token");

-- CreateIndex
CREATE INDEX "carts_updated_at_idx" ON "carts"("updated_at");

-- CreateIndex
CREATE INDEX "cart_items_product_variant_id_idx" ON "cart_items"("product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "cart_items_cart_id_product_variant_id_key" ON "cart_items"("cart_id", "product_variant_id");

-- CreateIndex
CREATE UNIQUE INDEX "parent_orders_order_number_key" ON "parent_orders"("order_number");

-- CreateIndex
CREATE INDEX "parent_orders_user_id_created_at_idx" ON "parent_orders"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "parent_orders_payment_status_created_at_idx" ON "parent_orders"("payment_status", "created_at");

-- CreateIndex
CREATE INDEX "parent_orders_created_at_idx" ON "parent_orders"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sub_orders_sub_order_number_key" ON "sub_orders"("sub_order_number");

-- CreateIndex
CREATE INDEX "sub_orders_parent_order_id_idx" ON "sub_orders"("parent_order_id");

-- CreateIndex
CREATE INDEX "sub_orders_vendor_id_status_created_at_idx" ON "sub_orders"("vendor_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "sub_orders_status_created_at_idx" ON "sub_orders"("status", "created_at");

-- CreateIndex
CREATE INDEX "order_items_sub_order_id_idx" ON "order_items"("sub_order_id");

-- CreateIndex
CREATE INDEX "order_items_product_variant_id_idx" ON "order_items"("product_variant_id");

-- CreateIndex
CREATE INDEX "payments_parent_order_id_status_idx" ON "payments"("parent_order_id", "status");

-- CreateIndex
CREATE INDEX "payments_status_created_at_idx" ON "payments"("status", "created_at");

-- CreateIndex
CREATE INDEX "payments_gateway_tracking_token_idx" ON "payments"("gateway_tracking_token");

-- CreateIndex
CREATE UNIQUE INDEX "vendor_wallets_vendor_id_key" ON "vendor_wallets"("vendor_id");

-- CreateIndex
CREATE INDEX "vendor_wallets_updated_at_idx" ON "vendor_wallets"("updated_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_id_created_at_idx" ON "wallet_transactions"("wallet_id", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_sub_order_id_idx" ON "wallet_transactions"("sub_order_id");

-- CreateIndex
CREATE INDEX "wallet_transactions_settlement_request_id_idx" ON "wallet_transactions"("settlement_request_id");

-- CreateIndex
CREATE INDEX "settlement_requests_vendor_id_status_created_at_idx" ON "settlement_requests"("vendor_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "settlement_requests_status_created_at_idx" ON "settlement_requests"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "credit_providers_code_key" ON "credit_providers"("code");

-- CreateIndex
CREATE INDEX "credit_providers_is_active_idx" ON "credit_providers"("is_active");

-- CreateIndex
CREATE INDEX "credit_accounts_user_id_status_idx" ON "credit_accounts"("user_id", "status");

-- CreateIndex
CREATE INDEX "credit_accounts_provider_id_status_idx" ON "credit_accounts"("provider_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "credit_accounts_user_id_provider_id_key" ON "credit_accounts"("user_id", "provider_id");

-- CreateIndex
CREATE INDEX "credit_applications_user_id_status_created_at_idx" ON "credit_applications"("user_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "credit_applications_provider_id_status_idx" ON "credit_applications"("provider_id", "status");

-- CreateIndex
CREATE INDEX "credit_applications_bank_application_tracking_code_idx" ON "credit_applications"("bank_application_tracking_code");

-- CreateIndex
CREATE INDEX "credit_transactions_credit_account_id_created_at_idx" ON "credit_transactions"("credit_account_id", "created_at");

-- CreateIndex
CREATE INDEX "credit_transactions_parent_order_id_idx" ON "credit_transactions"("parent_order_id");

-- CreateIndex
CREATE INDEX "credit_transactions_reference_code_idx" ON "credit_transactions"("reference_code");

-- CreateIndex
CREATE INDEX "installment_plans_provider_id_is_active_idx" ON "installment_plans"("provider_id", "is_active");

-- CreateIndex
CREATE UNIQUE INDEX "installment_plans_provider_id_duration_months_key" ON "installment_plans"("provider_id", "duration_months");

-- CreateIndex
CREATE INDEX "installment_schedules_credit_account_id_status_idx" ON "installment_schedules"("credit_account_id", "status");

-- CreateIndex
CREATE INDEX "installment_schedules_status_due_date_idx" ON "installment_schedules"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "installment_schedules_parent_order_id_installment_number_key" ON "installment_schedules"("parent_order_id", "installment_number");

-- CreateIndex
CREATE INDEX "disputes_sub_order_id_idx" ON "disputes"("sub_order_id");

-- CreateIndex
CREATE INDEX "disputes_status_created_at_idx" ON "disputes"("status", "created_at");

-- CreateIndex
CREATE INDEX "disputes_raised_by_user_id_created_at_idx" ON "disputes"("raised_by_user_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_evidence_dispute_id_created_at_idx" ON "dispute_evidence"("dispute_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_evidence_uploaded_by_user_id_idx" ON "dispute_evidence"("uploaded_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_mobile_key" ON "users"("mobile");

-- CreateIndex
CREATE UNIQUE INDEX "users_national_code_key" ON "users"("national_code");

-- CreateIndex
CREATE INDEX "users_created_at_idx" ON "users"("created_at");

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_profiles" ADD CONSTRAINT "customer_profiles_default_address_id_fkey" FOREIGN KEY ("default_address_id") REFERENCES "addresses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "addresses" ADD CONSTRAINT "addresses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_verifications" ADD CONSTRAINT "vendor_verifications_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_verifications" ADD CONSTRAINT "vendor_verifications_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_variants" ADD CONSTRAINT "product_variants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_cart_id_fkey" FOREIGN KEY ("cart_id") REFERENCES "carts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "parent_orders" ADD CONSTRAINT "parent_orders_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_parent_order_id_fkey" FOREIGN KEY ("parent_order_id") REFERENCES "parent_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_sub_order_id_fkey" FOREIGN KEY ("sub_order_id") REFERENCES "sub_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_variant_id_fkey" FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_parent_order_id_fkey" FOREIGN KEY ("parent_order_id") REFERENCES "parent_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_wallets" ADD CONSTRAINT "vendor_wallets_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_wallet_id_fkey" FOREIGN KEY ("wallet_id") REFERENCES "vendor_wallets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_sub_order_id_fkey" FOREIGN KEY ("sub_order_id") REFERENCES "sub_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_settlement_request_id_fkey" FOREIGN KEY ("settlement_request_id") REFERENCES "settlement_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_requests" ADD CONSTRAINT "settlement_requests_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settlement_requests" ADD CONSTRAINT "settlement_requests_processed_by_user_id_fkey" FOREIGN KEY ("processed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_accounts" ADD CONSTRAINT "credit_accounts_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "credit_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_applications" ADD CONSTRAINT "credit_applications_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "credit_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_parent_order_id_fkey" FOREIGN KEY ("parent_order_id") REFERENCES "parent_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_plans" ADD CONSTRAINT "installment_plans_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "credit_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_schedules" ADD CONSTRAINT "installment_schedules_parent_order_id_fkey" FOREIGN KEY ("parent_order_id") REFERENCES "parent_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "installment_schedules" ADD CONSTRAINT "installment_schedules_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_sub_order_id_fkey" FOREIGN KEY ("sub_order_id") REFERENCES "sub_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_raised_by_user_id_fkey" FOREIGN KEY ("raised_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_uploaded_by_user_id_fkey" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
