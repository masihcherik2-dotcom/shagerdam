-- Phase 5 — catalogue: admin moderation, inventory reservation, media linkage,
-- trigram search indexes and database-level price/stock invariants.
--
-- Every change is additive. Existing rows are valid under the new CHECK
-- constraints (the seed sells at price > 0 with compare_at_price > price and
-- non-negative stock); the migration fails loudly instead of silently rewriting
-- data if a database ever contains a row that violates them.

-- pg_trgm ships with the official PostgreSQL image (contrib). It powers the
-- GIN indexes below, which make ILIKE '%…%' searches on Persian text indexable.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- AlterTable: inventory reservation
ALTER TABLE "product_variants" ADD COLUMN "reserved_quantity" INTEGER NOT NULL DEFAULT 0;

-- AlterTable: admin moderation
ALTER TABLE "products" ADD COLUMN "blocked_at" TIMESTAMPTZ(3),
ADD COLUMN "blocked_by_user_id" UUID,
ADD COLUMN "blocked_reason" VARCHAR(500),
ADD COLUMN "is_blocked_by_admin" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: gallery entries point back at the uploaded file
ALTER TABLE "product_media" ADD COLUMN "media_asset_id" UUID;

-- Invariants enforced by the database itself, so no code path (including raw
-- SQL and future services) can persist an oversold or mispriced variant.
ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_inventory_check"
  CHECK ("stock_quantity" >= 0 AND "reserved_quantity" >= 0 AND "reserved_quantity" <= "stock_quantity");

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_price_check"
  CHECK ("price" > 0 AND ("compare_at_price" IS NULL OR "compare_at_price" > "price"));

ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_weight_check"
  CHECK ("weight_grams" IS NULL OR "weight_grams" > 0);

ALTER TABLE "products"
  ADD CONSTRAINT "products_base_price_check" CHECK ("base_price" > 0);

-- A blocked product always carries who blocked it, when and why.
ALTER TABLE "products"
  ADD CONSTRAINT "products_block_consistency_check"
  CHECK (
    ("is_blocked_by_admin" = false AND "blocked_at" IS NULL AND "blocked_reason" IS NULL)
    OR ("is_blocked_by_admin" = true AND "blocked_at" IS NOT NULL AND "blocked_reason" IS NOT NULL)
  );

-- A category rate is a percentage.
ALTER TABLE "categories"
  ADD CONSTRAINT "categories_commission_rate_check"
  CHECK ("default_commission_rate" >= 0 AND "default_commission_rate" <= 100);

-- CreateIndex
CREATE INDEX "product_media_media_asset_id_idx" ON "product_media"("media_asset_id");

-- CreateIndex
CREATE INDEX "products_is_published_is_blocked_by_admin_created_at_idx" ON "products"("is_published", "is_blocked_by_admin", "created_at");

-- CreateIndex
CREATE INDEX "products_title_trgm_idx" ON "products" USING GIN ("title" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_description_trgm_idx" ON "products" USING GIN ("description" gin_trgm_ops);

-- CreateIndex
CREATE INDEX "products_brand_trgm_idx" ON "products" USING GIN ("brand" gin_trgm_ops);

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_blocked_by_user_id_fkey" FOREIGN KEY ("blocked_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "product_media" ADD CONSTRAINT "product_media_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;
