-- Storefront taxonomy: exactly four active root departments.
--
-- 1. Create (or re-activate as roots) the four departments with the commission
--    rates set by the architect. Existing rows keep their id, so no product or
--    order reference changes.
-- 2. Move products of clearly equivalent earlier categories:
--      digital, mobile, laptop, digital-accessories   -> digital-goods
--      beauty-health, skincare, personal-care         -> beauty-products
-- 3. Deactivate every other category. Their products are kept untouched but stop
--    being publicly visible (catalog rule 4: the category must be in the active
--    tree) until the vendor picks one of the four departments.

INSERT INTO "categories" ("id", "parent_id", "slug", "title_fa", "title_en", "default_commission_rate", "sort_order", "is_active", "created_at", "updated_at")
VALUES
  (gen_random_uuid(), NULL, 'digital-goods',          'کالای دیجیتال',               'Digital Goods',            5.00, 10, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), NULL, 'home-decor',             'دکوراسیون',                   'Home Decor',               9.00, 20, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), NULL, 'beauty-products',        'محصولات زیبایی',              'Beauty Products',         11.00, 30, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), NULL, 'barber-salon-equipment', 'محصولات و تجهیزات آرایشگاهی', 'Barber & Salon Equipment', 9.00, 40, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("slug") DO UPDATE SET
  "parent_id" = NULL,
  "title_fa" = EXCLUDED."title_fa",
  "title_en" = EXCLUDED."title_en",
  "default_commission_rate" = EXCLUDED."default_commission_rate",
  "sort_order" = EXCLUDED."sort_order",
  "is_active" = true,
  "updated_at" = CURRENT_TIMESTAMP;

UPDATE "products"
SET "category_id" = (SELECT "id" FROM "categories" WHERE "slug" = 'digital-goods'),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "category_id" IN (SELECT "id" FROM "categories" WHERE "slug" IN ('digital', 'mobile', 'laptop', 'digital-accessories'));

UPDATE "products"
SET "category_id" = (SELECT "id" FROM "categories" WHERE "slug" = 'beauty-products'),
    "updated_at" = CURRENT_TIMESTAMP
WHERE "category_id" IN (SELECT "id" FROM "categories" WHERE "slug" IN ('beauty-health', 'skincare', 'personal-care'));

UPDATE "categories"
SET "is_active" = false,
    "updated_at" = CURRENT_TIMESTAMP
WHERE "slug" NOT IN ('digital-goods', 'home-decor', 'beauty-products', 'barber-salon-equipment')
  AND "is_active" = true;
