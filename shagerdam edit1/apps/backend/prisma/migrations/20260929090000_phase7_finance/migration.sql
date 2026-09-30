-- Phase 7: payments, escrow wallet ledger and vendor settlements.
--
-- The new enum values are only *added* here; no statement in this migration
-- uses them (PostgreSQL forbids using an enum value in the transaction that
-- added it), so the partial indexes below reference pre-existing values only.

-- CreateEnum
CREATE TYPE "WalletBalanceBucket" AS ENUM ('PENDING', 'WITHDRAWABLE', 'SETTLEMENT_HOLD');

-- AlterEnum
ALTER TYPE "WalletTransactionType" ADD VALUE 'SETTLEMENT_HOLD';
ALTER TYPE "WalletTransactionType" ADD VALUE 'SETTLEMENT_HOLD_RELEASE';

-- AlterTable
ALTER TABLE "settlement_requests" ADD COLUMN "rejection_reason" VARCHAR(500);

-- AlterTable
ALTER TABLE "vendor_wallets"
  ADD COLUMN "settlement_hold_balance" DECIMAL(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN "total_withdrawn_amount" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- AlterTable
-- No ledger rows were written before Phase 7 (nothing credited wallets), so the
-- column can be added as NOT NULL. If rows ever exist, this statement fails
-- loudly instead of guessing their bucket.
ALTER TABLE "wallet_transactions" ADD COLUMN "bucket" "WalletBalanceBucket" NOT NULL;

-- CreateIndex
CREATE INDEX "wallet_transactions_wallet_id_bucket_idx" ON "wallet_transactions"("wallet_id", "bucket");

-- ─── Integrity rules the Prisma schema language cannot express ───────────────

-- Balances never go negative: every debit is checked by the service under a row
-- lock, and the database refuses the write if that check is ever bypassed.
ALTER TABLE "vendor_wallets"
  ADD CONSTRAINT "vendor_wallets_balances_non_negative" CHECK (
    "pending_balance" >= 0
    AND "withdrawable_balance" >= 0
    AND "settlement_hold_balance" >= 0
    AND "total_earned_balance" >= 0
    AND "total_withdrawn_amount" >= 0
  );

-- A ledger row always moves money, and never leaves its bucket negative.
ALTER TABLE "wallet_transactions"
  ADD CONSTRAINT "wallet_transactions_amount_non_zero" CHECK ("amount" <> 0),
  ADD CONSTRAINT "wallet_transactions_balance_after_non_negative" CHECK ("balance_after" >= 0);

-- Idempotency at the database level: a package is escrowed, released and
-- refunded at most once per bucket; a settlement request moves money at most
-- once per type and bucket (hold, release, payout).
CREATE UNIQUE INDEX "wallet_transactions_sub_order_movement_key"
  ON "wallet_transactions"("sub_order_id", "type", "bucket")
  WHERE "sub_order_id" IS NOT NULL
    AND "type" IN ('CREDIT_SALE_ESCROW_HOLD', 'ESCROW_RELEASE_TO_WITHDRAWABLE', 'REFUND_DEDUCTION');

CREATE UNIQUE INDEX "wallet_transactions_settlement_movement_key"
  ON "wallet_transactions"("settlement_request_id", "type", "bucket")
  WHERE "settlement_request_id" IS NOT NULL;

ALTER TABLE "settlement_requests"
  ADD CONSTRAINT "settlement_requests_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "settlement_requests_paid_has_reference" CHECK (
    "status" <> 'PAID_PAYA' OR ("bank_paya_reference" IS NOT NULL AND "processed_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "settlement_requests_rejected_has_reason" CHECK (
    "status" <> 'REJECTED' OR ("rejection_reason" IS NOT NULL AND "processed_at" IS NOT NULL)
  );

-- One gateway token identifies one payment attempt (callbacks look it up).
CREATE UNIQUE INDEX "payments_gateway_token_key"
  ON "payments"("gateway_name", "gateway_tracking_token")
  WHERE "gateway_tracking_token" IS NOT NULL;

ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amounts_non_negative" CHECK ("cash_amount" >= 0 AND "credit_amount" >= 0),
  ADD CONSTRAINT "payments_successful_has_paid_at" CHECK ("status" <> 'SUCCESSFUL' OR "paid_at" IS NOT NULL);
