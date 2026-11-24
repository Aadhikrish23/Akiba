-- Where to watch: the Crunchyroll series page and, as far as AniList lists them, each episode.
ALTER TABLE "title" ADD COLUMN "crunchyroll_url" TEXT;
ALTER TABLE "title" ADD COLUMN "crunchyroll_episodes" JSONB;
