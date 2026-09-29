-- ============================================================================
-- Phase 3 — one canonical spelling for `users.mobile`
-- ----------------------------------------------------------------------------
-- Phase 2 stored mobile numbers in the national format (`09XXXXXXXXX`) while the
-- authentication contract normalizes every input to E.164 (`+989XXXXXXXXX`).
-- Two spellings of the same number would defeat the unique index on
-- `users.mobile` — the same person could register twice and the OTP rate limiter
-- would count their attempts in two separate buckets.
--
-- This migration converts existing rows in place. It is data-preserving and
-- idempotent: rows that are already E.164 are left untouched.
--
-- Only rows matching the national pattern are rewritten, so an unexpected value
-- (a legacy foreign number, a placeholder) fails loudly on the check below
-- instead of being silently mangled.
-- ============================================================================

UPDATE "users"
SET "mobile" = '+98' || substring("mobile" from 2)
WHERE "mobile" ~ '^09[0-9]{9}$';

-- Fail fast if anything is left in a non-canonical shape: a half-migrated
-- identity table is worse than a failed deployment.
DO $$
DECLARE
    offenders integer;
BEGIN
    SELECT count(*) INTO offenders
    FROM "users"
    WHERE "mobile" !~ '^\+989[0-9]{9}$';

    IF offenders > 0 THEN
        RAISE EXCEPTION
            'users.mobile contains % row(s) that are not canonical E.164 (+989XXXXXXXXX). '
            'Normalize them before applying this migration.', offenders;
    END IF;
END
$$;

-- The existing unique index on `mobile` keeps enforcing one row per number now
-- that every row uses the same spelling; no index change is required.
