-- T6 (auth-oauth).
--
-- 1. `oauth_state`: one row per started web sign-in (authorization code + PKCE, doc 09 S-AUTH-9).
--    Holds the SHA-256 of the `state` value, the nonce sent to the provider and the PKCE
--    challenge for ten minutes. A row is used once (`used_at`) and deleted after it expires.
--
-- 2. `oauth_account`: at most one identity per provider per user, enforced here so that two
--    concurrent link requests cannot both succeed. The new unique index starts with `user_id`,
--    so it also serves the lookups the dropped plain index was for. No code wrote to this table
--    before T6; if rows exist anyway and break the rule, this migration fails rather than
--    choosing which identity to keep.
-- DropIndex
DROP INDEX "oauth_account_user_id_idx";

-- CreateTable
CREATE TABLE "oauth_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state_hash" TEXT NOT NULL,
    "provider" "oauth_provider" NOT NULL,
    "nonce" TEXT NOT NULL,
    "code_challenge" TEXT NOT NULL,
    "redirect_uri" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),

    CONSTRAINT "oauth_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_state_state_hash_key" ON "oauth_state"("state_hash");

-- CreateIndex
CREATE INDEX "oauth_state_expires_at_idx" ON "oauth_state"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_account_user_id_provider_key" ON "oauth_account"("user_id", "provider");

