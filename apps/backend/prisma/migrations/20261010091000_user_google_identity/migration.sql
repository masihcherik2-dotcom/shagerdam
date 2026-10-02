-- Google sign-in (OpenID Connect): the linked Google subject and the profile
-- picture URL reported by Google.
ALTER TABLE "users" ADD COLUMN "google_subject" VARCHAR(255),
ADD COLUMN "avatar_url" VARCHAR(2048);

-- CreateIndex
CREATE UNIQUE INDEX "users_google_subject_key" ON "users"("google_subject");
