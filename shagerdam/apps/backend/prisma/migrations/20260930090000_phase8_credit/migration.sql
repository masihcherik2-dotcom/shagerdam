-- Phase 8: banking credit engine, BNPL instalments and hybrid (credit + card) payments.
--
-- Only a new enum *type* is created here (usable in the same migration); no
-- value is added to an existing enum.

-- CreateEnum
CREATE TYPE "PaymentPurpose" AS ENUM ('ORDER_CHECKOUT', 'INSTALLMENT_REPAYMENT');

-- AlterTable
ALTER TABLE "credit_applications" ADD COLUMN     "decided_at" TIMESTAMPTZ(3),
ADD COLUMN     "decision_reason" VARCHAR(120);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "credit_account_id" UUID,
ADD COLUMN     "credit_reservation_ref" VARCHAR(80),
ADD COLUMN     "installment_plan_id" UUID,
ADD COLUMN     "installment_schedule_id" UUID,
ADD COLUMN     "payment_method" "PaymentMethod" NOT NULL DEFAULT 'CASH_IPG',
ADD COLUMN     "purpose" "PaymentPurpose" NOT NULL DEFAULT 'ORDER_CHECKOUT';

-- CreateIndex
CREATE INDEX "payments_installment_schedule_id_status_idx" ON "payments"("installment_schedule_id", "status");

-- CreateIndex
CREATE INDEX "payments_credit_account_id_idx" ON "payments"("credit_account_id");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_credit_account_id_fkey" FOREIGN KEY ("credit_account_id") REFERENCES "credit_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_installment_plan_id_fkey" FOREIGN KEY ("installment_plan_id") REFERENCES "installment_plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_installment_schedule_id_fkey" FOREIGN KEY ("installment_schedule_id") REFERENCES "installment_schedules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ─── Integrity rules the Prisma schema language cannot express ───────────────

-- Credit invariant, enforced by the database on every write:
--   totalLimit = usedAmount + reservedAmount + availableAmount, all ≥ 0.
ALTER TABLE "credit_accounts"
  ADD CONSTRAINT "credit_accounts_amounts_non_negative" CHECK (
    "total_limit" >= 0 AND "used_amount" >= 0 AND "reserved_amount" >= 0 AND "available_amount" >= 0
  ),
  ADD CONSTRAINT "credit_accounts_limit_invariant" CHECK (
    "total_limit" = "used_amount" + "reserved_amount" + "available_amount"
  );

-- A credit movement always moves money; the direction is carried by the type.
ALTER TABLE "credit_transactions"
  ADD CONSTRAINT "credit_transactions_amount_positive" CHECK ("amount" > 0),
  ADD CONSTRAINT "credit_transactions_balance_after_non_negative" CHECK ("balance_after" >= 0);

-- Idempotency: one allocation per application, one hold / commit / release per
-- reservation, one repayment restore per instalment …
CREATE UNIQUE INDEX "credit_transactions_type_reference_key"
  ON "credit_transactions"("type", "reference_code");

-- … and a reservation ends exactly once: committed XOR released.
CREATE UNIQUE INDEX "credit_transactions_reservation_end_key"
  ON "credit_transactions"("reference_code")
  WHERE "type" IN ('PURCHASE_COMMIT', 'RESERVATION_RELEASE');

-- Instalment rows are whole rials (Iranian banking has no fractional unit) and
-- total = principal + interest.
ALTER TABLE "installment_schedules"
  ADD CONSTRAINT "installment_schedules_amounts_valid" CHECK (
    "principal_amount" >= 0 AND "interest_amount" >= 0 AND "penalty_amount" >= 0 AND "paid_amount" >= 0
    AND "total_amount" = "principal_amount" + "interest_amount"
    AND "principal_amount" = TRUNC("principal_amount") AND "interest_amount" = TRUNC("interest_amount")
  ),
  ADD CONSTRAINT "installment_schedules_number_in_range" CHECK (
    "installment_number" >= 1 AND "installment_number" <= "total_installments"
  ),
  ADD CONSTRAINT "installment_schedules_paid_has_paid_at" CHECK ("status" <> 'PAID' OR "paid_at" IS NOT NULL);

ALTER TABLE "installment_plans"
  ADD CONSTRAINT "installment_plans_terms_valid" CHECK (
    "duration_months" BETWEEN 1 AND 60 AND "interest_rate_percent" >= 0 AND "penalty_rate_percent_per_month" >= 0
  );

-- One reservation belongs to one payment attempt.
CREATE UNIQUE INDEX "payments_credit_reservation_ref_key"
  ON "payments"("credit_reservation_ref")
  WHERE "credit_reservation_ref" IS NOT NULL;

-- Shape of a payment by purpose and method.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_installment_purpose_shape" CHECK (
    ("purpose" = 'INSTALLMENT_REPAYMENT') = ("installment_schedule_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "payments_credit_part_shape" CHECK (
    ("credit_amount" > 0) = ("credit_account_id" IS NOT NULL AND "credit_reservation_ref" IS NOT NULL AND "installment_plan_id" IS NOT NULL)
  ),
  ADD CONSTRAINT "payments_method_matches_split" CHECK (
    ("payment_method" = 'CASH_IPG' AND "credit_amount" = 0)
    OR ("payment_method" = 'BANK_CREDIT' AND "credit_amount" > 0 AND "cash_amount" = 0)
    OR ("payment_method" = 'HYBRID' AND "credit_amount" > 0 AND "cash_amount" > 0)
  );
