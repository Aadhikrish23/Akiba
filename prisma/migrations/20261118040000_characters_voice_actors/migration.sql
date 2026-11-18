-- T21 (explore-api): voice actors, and one row per character / voice actor per source ID.

-- CreateTable
CREATE TABLE "voice_actor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "native_name" TEXT,
    "image_url" TEXT,
    "external_ids" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "voice_actor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "character_voice_actor" (
    "character_id" UUID NOT NULL,
    "voice_actor_id" UUID NOT NULL,
    "language" TEXT NOT NULL,

    CONSTRAINT "character_voice_actor_pkey" PRIMARY KEY ("character_id","voice_actor_id","language")
);

-- CreateIndex
CREATE INDEX "character_voice_actor_voice_actor_id_idx" ON "character_voice_actor"("voice_actor_id");

-- AddForeignKey
ALTER TABLE "character_voice_actor" ADD CONSTRAINT "character_voice_actor_character_id_fkey" FOREIGN KEY ("character_id") REFERENCES "character"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "character_voice_actor" ADD CONSTRAINT "character_voice_actor_voice_actor_id_fkey" FOREIGN KEY ("voice_actor_id") REFERENCES "voice_actor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The AniList ID is the identity of a character or a voice actor (the same rule as titles): two
-- refreshes of two titles that share a character must find the same row, even when they race.
-- Not expressible in the Prisma schema (like the one-open-run index); the importer upserts on it.
CREATE UNIQUE INDEX "character_anilist_id_key" ON "character" ((external_ids ->> 'anilist'))
    WHERE external_ids ? 'anilist';
CREATE UNIQUE INDEX "voice_actor_anilist_id_key" ON "voice_actor" ((external_ids ->> 'anilist'))
    WHERE external_ids ? 'anilist';
