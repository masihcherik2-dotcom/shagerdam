-- Phase 9: disputes, evidence, dispute timeline and the DISPUTE_HOLD wallet bucket.
--
-- New enum values (DISPUTE_HOLD, DISPUTE_HOLD_LOCK, DISPUTE_HOLD_RELEASE) are only
-- *added* here: PostgreSQL forbids using a freshly added enum value in the same
-- transaction, so the rules that mention them live in the next migration
-- (20261001090100_phase9_dispute_ledger_rules).
--
-- No dispute rows existed before Phase 9 (no endpoint created them), so the new
-- NOT NULL columns of "disputes" need no backfill.

-- CreateEnum
CREATE TYPE "DisputeVendorAction" AS ENUM ('ACCEPT_RETURN', 'REJECT_WITH_DEFENSE');

-- CreateEnum
CREATE TYPE "DisputeEventType" AS ENUM ('OPENED', 'EVIDENCE_ADDED', 'VENDOR_ACCEPTED_RETURN', 'VENDOR_DEFENDED', 'ARBITRATED_BUYER_FAVOR', 'ARBITRATED_VENDOR_FAVOR', 'CANCELLED_BY_CUSTOMER', 'REFUND_NOTICE_SENT', 'REFUND_NOTICE_FAILED');

-- AlterEnum
ALTER TYPE "WalletBalanceBucket" ADD VALUE 'DISPUTE_HOLD';

-- AlterEnum
ALTER TYPE "WalletTransactionType" ADD VALUE 'DISPUTE_HOLD_LOCK';
ALTER TYPE "WalletTransactionType" ADD VALUE 'DISPUTE_HOLD_RELEASE';

-- AlterTable
ALTER TABLE "dispute_evidence" ADD COLUMN     "media_asset_id" UUID;

-- AlterTable
ALTER TABLE "disputes" ADD COLUMN     "cancelled_at" TIMESTAMPTZ(3),
ADD COLUMN     "hold_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "hold_shortfall" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "hold_source" "WalletBalanceBucket",
ADD COLUMN     "item_returned" BOOLEAN,
ADD COLUMN     "refund_amount" DECIMAL(15,2),
ADD COLUMN     "refund_unrecovered_amount" DECIMAL(15,2) NOT NULL DEFAULT 0,
ADD COLUMN     "resolved_by_user_id" UUID,
ADD COLUMN     "restocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "sub_order_status_at_open" "SubOrderStatus" NOT NULL,
ADD COLUMN     "vendor_action" "DisputeVendorAction",
ADD COLUMN     "vendor_defense_notes" TEXT,
ADD COLUMN     "vendor_id" UUID NOT NULL,
ADD COLUMN     "vendor_responded_at" TIMESTAMPTZ(3),
ADD COLUMN     "vendor_responded_by_user_id" UUID;

-- AlterTable
ALTER TABLE "vendor_wallets" ADD COLUMN     "dispute_hold_balance" DECIMAL(15,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "wallet_transactions" ADD COLUMN     "dispute_id" UUID;

-- CreateTable
CREATE TABLE "dispute_events" (
    "id" UUID NOT NULL,
    "dispute_id" UUID NOT NULL,
    "type" "DisputeEventType" NOT NULL,
    "actor_user_id" UUID,
    "actor_role" VARCHAR(20) NOT NULL,
    "from_status" "DisputeStatus",
    "to_status" "DisputeStatus",
    "note" VARCHAR(1000),
    "data" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dispute_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dispute_events_dispute_id_created_at_idx" ON "dispute_events"("dispute_id", "created_at");

-- CreateIndex
CREATE INDEX "dispute_evidence_media_asset_id_idx" ON "dispute_evidence"("media_asset_id");

-- CreateIndex
CREATE UNIQUE INDEX "dispute_evidence_dispute_id_media_asset_id_key" ON "dispute_evidence"("dispute_id", "media_asset_id");

-- CreateIndex
CREATE INDEX "disputes_vendor_id_status_created_at_idx" ON "disputes"("vendor_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "wallet_transactions_dispute_id_idx" ON "wallet_transactions"("dispute_id");

-- AddForeignKey
ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_vendor_responded_by_user_id_fkey" FOREIGN KEY ("vendor_responded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disputes" ADD CONSTRAINT "disputes_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_evidence" ADD CONSTRAINT "dispute_evidence_media_asset_id_fkey" FOREIGN KEY ("media_asset_id") REFERENCES "media_assets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_dispute_id_fkey" FOREIGN KEY ("dispute_id") REFERENCES "disputes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_events" ADD CONSTRAINT "dispute_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── Integrity rules the Prisma schema language cannot express ───────────────

-- The dispute hold is a balance like the others: never negative. And the
-- TM invariant: everything the vendor was credited with (totalEarned) covers
-- what was paid out plus what is withdrawable plus what is frozen by disputes.
ALTER TABLE "vendor_wallets"
  ADD CONSTRAINT "vendor_wallets_dispute_hold_non_negative" CHECK ("dispute_hold_balance" >= 0),
  ADD CONSTRAINT "vendor_wallets_earned_covers_balances" CHECK (
    "total_earned_balance" >= "total_withdrawn_amount" + "withdrawable_balance" + "dispute_hold_balance"
  );

-- At most one active dispute per package (OPEN / VENDOR_RESPONDED / UNDER_ARBITRATION).
CREATE UNIQUE INDEX "disputes_one_active_per_sub_order_key"
  ON "disputes"("sub_order_id")
  WHERE "status" IN ('OPEN', 'VENDOR_RESPONDED', 'UNDER_ARBITRATION');

ALTER TABLE "disputes"
  ADD CONSTRAINT "disputes_amounts_non_negative" CHECK (
    "hold_amount" >= 0 AND "hold_shortfall" >= 0 AND "refund_unrecovered_amount" >= 0
    AND ("refund_amount" IS NULL OR "refund_amount" >= 0)
  ),
  ADD CONSTRAINT "disputes_hold_source_valid" CHECK (
    ("hold_source" IS NULL AND "hold_amount" = 0) OR ("hold_source" IN ('PENDING', 'WITHDRAWABLE') AND "hold_amount" > 0)
  ),
  ADD CONSTRAINT "disputes_status_at_open_valid" CHECK ("sub_order_status_at_open" IN ('PROCESSING', 'SHIPPED', 'DELIVERED')),
  ADD CONSTRAINT "disputes_resolved_has_resolved_at" CHECK (
    "status" NOT IN ('RESOLVED_BUYER_FAVOR', 'RESOLVED_VENDOR_FAVOR') OR "resolved_at" IS NOT NULL
  ),
  ADD CONSTRAINT "disputes_cancelled_has_cancelled_at" CHECK ("status" <> 'CANCELLED' OR "cancelled_at" IS NOT NULL),
  ADD CONSTRAINT "disputes_refund_only_buyer_favor" CHECK ("refund_amount" IS NULL OR "status" = 'RESOLVED_BUYER_FAVOR');

-- A dispute freezes, releases and refunds at most once per type and bucket.
CREATE UNIQUE INDEX "wallet_transactions_dispute_movement_key"
  ON "wallet_transactions"("dispute_id", "type", "bucket")
  WHERE "dispute_id" IS NOT NULL;
