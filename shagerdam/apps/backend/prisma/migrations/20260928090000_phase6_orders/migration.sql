-- Phase 6: cart price snapshots, order lifecycle fields, status timeline,
-- per-store shipping settings, order-number sequence and money invariants.

-- AlterTable
-- Added nullable, back-filled from the live price, then made mandatory, so the
-- migration is safe on a database that already holds carts.
ALTER TABLE "cart_items" ADD COLUMN "unit_price_snapshot" DECIMAL(15,2);
UPDATE "cart_items" ci SET "unit_price_snapshot" = pv."price"
  FROM "product_variants" pv WHERE pv."id" = ci."product_variant_id";
ALTER TABLE "cart_items" ALTER COLUMN "unit_price_snapshot" SET NOT NULL;

-- AlterTable
-- Same pattern for the new snapshots: back-fill from the current rows where the
-- variant still exists; otherwise record that the source is gone.
ALTER TABLE "order_items" ADD COLUMN "sku_snapshot" VARCHAR(64),
ADD COLUMN "vendor_store_name_snapshot" VARCHAR(120);
UPDATE "order_items" oi SET "sku_snapshot" = pv."sku"
  FROM "product_variants" pv WHERE pv."id" = oi."product_variant_id";
UPDATE "order_items" SET "sku_snapshot" = 'UNKNOWN' WHERE "sku_snapshot" IS NULL;
UPDATE "order_items" oi SET "vendor_store_name_snapshot" = v."store_name"
  FROM "sub_orders" so JOIN "vendors" v ON v."id" = so."vendor_id"
 WHERE so."id" = oi."sub_order_id" AND oi."vendor_store_name_snapshot" IS NULL;
ALTER TABLE "order_items" ALTER COLUMN "sku_snapshot" SET NOT NULL,
ALTER COLUMN "vendor_store_name_snapshot" SET NOT NULL;

-- AlterTable
ALTER TABLE "parent_orders" ADD COLUMN     "cancellation_reason" VARCHAR(500),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "customer_note" VARCHAR(500),
ADD COLUMN     "paid_at" TIMESTAMPTZ(3),
ADD COLUMN     "payment_expires_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "sub_orders" ADD COLUMN     "cancellation_reason" VARCHAR(500),
ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "shipped_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "free_shipping_threshold" DECIMAL(15,2),
ADD COLUMN     "shipping_fee_override" DECIMAL(15,2);

-- CreateTable
CREATE TABLE "sub_order_status_history" (
    "id" UUID NOT NULL,
    "sub_order_id" UUID NOT NULL,
    "from_status" "SubOrderStatus",
    "to_status" "SubOrderStatus" NOT NULL,
    "actor_user_id" UUID,
    "actor_role" VARCHAR(20) NOT NULL,
    "note" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sub_order_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sub_order_status_history_sub_order_id_created_at_idx" ON "sub_order_status_history"("sub_order_id", "created_at");

-- CreateIndex
CREATE INDEX "parent_orders_payment_status_payment_expires_at_idx" ON "parent_orders"("payment_status", "payment_expires_at");

-- AddForeignKey
ALTER TABLE "sub_order_status_history" ADD CONSTRAINT "sub_order_status_history_sub_order_id_fkey" FOREIGN KEY ("sub_order_id") REFERENCES "sub_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sub_order_status_history" ADD CONSTRAINT "sub_order_status_history_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- ─── Order numbers ──────────────────────────────────────────────────────────
-- Monotonic, gap-tolerant, collision-free across instances: SHP-100000001 …
CREATE SEQUENCE IF NOT EXISTS "parent_order_number_seq" START WITH 100000001 INCREMENT BY 1 NO CYCLE;

-- ─── Invariants the database enforces on its own ────────────────────────────
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_shipping_settings_check"
  CHECK (("shipping_fee_override" IS NULL OR "shipping_fee_override" >= 0)
     AND ("free_shipping_threshold" IS NULL OR "free_shipping_threshold" >= 0));

ALTER TABLE "cart_items" ADD CONSTRAINT "cart_items_quantity_check"
  CHECK ("quantity" > 0 AND "unit_price_snapshot" > 0);

-- Money identities of the split: the parent adds up, each sub-order's
-- commission and earnings add up to its subtotal, nothing is negative.
ALTER TABLE "parent_orders" ADD CONSTRAINT "parent_orders_amounts_check"
  CHECK ("total_items_amount" >= 0 AND "total_shipping_fee" >= 0 AND "total_discount_amount" >= 0
     AND "final_payable_amount" >= 0
     AND "final_payable_amount" = "total_items_amount" + "total_shipping_fee" - "total_discount_amount");

ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_amounts_check"
  CHECK ("items_subtotal" >= 0 AND "shipping_fee" >= 0
     AND "platform_commission_amount" >= 0 AND "vendor_earnings_amount" >= 0
     AND "platform_commission_amount" + "vendor_earnings_amount" = "items_subtotal");

-- A shipped package always carries its tracking data.
ALTER TABLE "sub_orders" ADD CONSTRAINT "sub_orders_shipped_tracking_check"
  CHECK ("status" <> 'SHIPPED' OR ("tracking_code" IS NOT NULL AND "carrier_name" IS NOT NULL));

ALTER TABLE "order_items" ADD CONSTRAINT "order_items_amounts_check"
  CHECK ("quantity" > 0 AND "unit_price_snapshot" > 0 AND "discount_snapshot" >= 0
     AND "commission_rate_snapshot" >= 0 AND "commission_rate_snapshot" <= 100
     AND "total_line_amount" = "unit_price_snapshot" * "quantity" - "discount_snapshot");
