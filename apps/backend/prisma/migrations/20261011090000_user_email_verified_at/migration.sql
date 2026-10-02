-- Sign-in by e-mailed code: remember when an address was proven.
-- Existing addresses were typed into the profile without proof, so they start
-- unverified (NULL); the first e-mail sign-in confirms them via the mobile step.
ALTER TABLE "users" ADD COLUMN "email_verified_at" TIMESTAMPTZ(3);

-- A verified timestamp without an address is meaningless.
ALTER TABLE "users" ADD CONSTRAINT "users_email_verified_requires_email" CHECK ("email_verified_at" IS NULL OR "email" IS NOT NULL);
