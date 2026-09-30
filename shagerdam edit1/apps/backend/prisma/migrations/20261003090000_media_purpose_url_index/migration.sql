-- Branding: PATCH /admin/branding checks that every image URL it stores is a
-- public asset uploaded for the matching branding slot (purpose + url lookup).
CREATE INDEX "media_assets_purpose_url_idx" ON "media_assets"("purpose", "url");
