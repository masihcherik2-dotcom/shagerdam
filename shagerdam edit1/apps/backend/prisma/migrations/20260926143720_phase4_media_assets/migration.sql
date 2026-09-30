-- CreateEnum
CREATE TYPE "MediaKind" AS ENUM ('IMAGE', 'DOCUMENT');

-- CreateTable
CREATE TABLE "media_assets" (
    "id" UUID NOT NULL,
    "owner_user_id" UUID,
    "vendor_id" UUID,
    "kind" "MediaKind" NOT NULL,
    "purpose" VARCHAR(60) NOT NULL,
    "storage_provider" VARCHAR(20) NOT NULL,
    "path" VARCHAR(512) NOT NULL,
    "thumbnail_path" VARCHAR(512),
    "url" VARCHAR(1024) NOT NULL,
    "thumbnail_url" VARCHAR(1024),
    "mime_type" VARCHAR(100) NOT NULL,
    "original_name" VARCHAR(255),
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "is_public" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_assets_path_key" ON "media_assets"("path");

-- CreateIndex
CREATE INDEX "media_assets_owner_user_id_kind_created_at_idx" ON "media_assets"("owner_user_id", "kind", "created_at");

-- CreateIndex
CREATE INDEX "media_assets_vendor_id_purpose_idx" ON "media_assets"("vendor_id", "purpose");

-- CreateIndex
CREATE INDEX "media_assets_kind_is_public_created_at_idx" ON "media_assets"("kind", "is_public", "created_at");

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_user_id_fkey" FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
