-- AlterTable
ALTER TABLE "vendor_verifications" ADD COLUMN     "bank_account_proof_url" VARCHAR(512);

-- AlterTable
ALTER TABLE "vendors" ADD COLUMN     "bank_account_holder" VARCHAR(120);
