-- Phase 0 trust layer: public contact form messages (/contact → /admin/support).
-- CreateEnum
CREATE TYPE "ContactMessageTopic" AS ENUM ('ORDER', 'PAYMENT', 'BNPL', 'RETURN', 'VENDOR', 'TECHNICAL', 'OTHER');

-- CreateEnum
CREATE TYPE "ContactMessageStatus" AS ENUM ('NEW', 'IN_PROGRESS', 'RESOLVED');

-- CreateTable
CREATE TABLE "contact_messages" (
    "id" UUID NOT NULL,
    "full_name" VARCHAR(120) NOT NULL,
    "mobile" VARCHAR(15) NOT NULL,
    "email" VARCHAR(254),
    "topic" "ContactMessageTopic" NOT NULL,
    "subject" VARCHAR(150) NOT NULL,
    "message" TEXT NOT NULL,
    "status" "ContactMessageStatus" NOT NULL DEFAULT 'NEW',
    "user_id" UUID,
    "ip_address" VARCHAR(45),
    "user_agent" VARCHAR(255),
    "staff_note" TEXT,
    "handled_by_user_id" UUID,
    "handled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "contact_messages_pkey" PRIMARY KEY ("id"),
    -- Same bounds as the API validation; the database refuses anything else.
    CONSTRAINT "contact_messages_message_length" CHECK (char_length("message") BETWEEN 10 AND 2000),
    CONSTRAINT "contact_messages_staff_note_length" CHECK ("staff_note" IS NULL OR char_length("staff_note") <= 2000)
);

-- CreateIndex
CREATE INDEX "contact_messages_status_created_at_idx" ON "contact_messages"("status", "created_at");

-- CreateIndex
CREATE INDEX "contact_messages_mobile_created_at_idx" ON "contact_messages"("mobile", "created_at");

-- CreateIndex
CREATE INDEX "contact_messages_user_id_idx" ON "contact_messages"("user_id");

-- AddForeignKey
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_messages" ADD CONSTRAINT "contact_messages_handled_by_user_id_fkey" FOREIGN KEY ("handled_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

