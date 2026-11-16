-- T4 (auth-core): S-AUTH-6 needs two deadlines per refresh token. `expires_at` is the idle
-- deadline of one token (14 days); `family_expires_at` is the absolute deadline of the whole
-- login session (30 days), fixed at login and copied unchanged on every rotation.
--
-- Added in three steps so the migration also succeeds on a table that already has rows: those
-- get the absolute deadline they would have had (30 days after the token was created; an upper
-- bound for rotated tokens, which is acceptable because `expires_at` still limits them).
ALTER TABLE "refresh_token" ADD COLUMN "family_expires_at" TIMESTAMPTZ(3);

UPDATE "refresh_token" SET "family_expires_at" = "created_at" + INTERVAL '30 days';

ALTER TABLE "refresh_token" ALTER COLUMN "family_expires_at" SET NOT NULL;

-- A token must never outlive its family.
ALTER TABLE "refresh_token"
  ADD CONSTRAINT "refresh_token_expiry_within_family_check"
  CHECK ("expires_at" <= "family_expires_at");
