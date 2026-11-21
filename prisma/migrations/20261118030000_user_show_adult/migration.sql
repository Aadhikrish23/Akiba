-- T17 (account-api): the adult-content setting (Q-10). Off by default: adult-rated titles are left
-- out of discovery and cannot be opened or added until the user turns this on in Settings.
-- AlterTable
ALTER TABLE "user" ADD COLUMN     "show_adult" BOOLEAN NOT NULL DEFAULT false;
