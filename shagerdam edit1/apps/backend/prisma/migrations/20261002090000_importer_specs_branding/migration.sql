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
