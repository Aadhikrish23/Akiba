-- T5 (auth-email): a one-time token is proof that its holder can read ONE mailbox: the address
-- the link was sent to. `sent_to` records that address, so that using the token marks the email
-- as verified only while the account still has that address (a later change of email must not
-- be verified by a link that went to the old mailbox).
--
-- No code wrote to this table before T5. Any row that exists anyway is given the account's
-- current address, which is where its link would have gone.
ALTER TABLE "one_time_token" ADD COLUMN "sent_to" CITEXT;

UPDATE "one_time_token" AS t SET "sent_to" = u."email" FROM "user" AS u WHERE u."id" = t."user_id";

ALTER TABLE "one_time_token" ALTER COLUMN "sent_to" SET NOT NULL;
