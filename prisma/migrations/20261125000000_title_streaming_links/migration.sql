-- Every streaming service AniList lists for a show (Crunchyroll, Netflix, Hulu...), for the "watch on" links.
ALTER TABLE "title" ADD COLUMN "streaming_links" JSONB;
