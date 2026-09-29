-- Phase 9 (part 2): ledger rules that reference the enum values added by
-- 20261001090000_phase9_disputes (they cannot be used in the migration that adds them).

-- Dispute movements always name their dispute, and the DISPUTE_HOLD bucket is only
-- moved by a dispute lock, a dispute release or a refund deduction.
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_dispute_rows_reference_dispute" CHECK (
    ("type" NOT IN ('DISPUTE_HOLD_LOCK', 'DISPUTE_HOLD_RELEASE') AND "bucket" <> 'DISPUTE_HOLD') OR "dispute_id" IS NOT NULL
  ),
  ADD CONSTRAINT "wallet_transactions_dispute_hold_bucket_types" CHECK (
    "bucket" <> 'DISPUTE_HOLD' OR "type" IN ('DISPUTE_HOLD_LOCK', 'DISPUTE_HOLD_RELEASE', 'REFUND_DEDUCTION')
  );
