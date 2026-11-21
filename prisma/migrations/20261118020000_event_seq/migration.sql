-- T15 (library-api): a total order of writing for events. Several events of one request share one
-- `occurred_at`; the timeline and the entry history need them in the order they were written.
-- The append-only trigger is unaffected (it guards UPDATE/DELETE, and `seq` is set on INSERT).

-- DropIndex
DROP INDEX "event_entry_id_occurred_at_idx";

-- DropIndex
DROP INDEX "event_user_id_occurred_at_idx";

-- AlterTable
ALTER TABLE "event" ADD COLUMN     "seq" BIGSERIAL NOT NULL;

-- CreateIndex
CREATE INDEX "event_user_id_occurred_at_seq_idx" ON "event"("user_id", "occurred_at" DESC, "seq" DESC);

-- CreateIndex
CREATE INDEX "event_entry_id_occurred_at_seq_idx" ON "event"("entry_id", "occurred_at", "seq");
