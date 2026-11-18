-- T12 (titles-read-api): a title first seen in a search or a season chart has card data only.
-- `detail_fetched_at` says when studios, relations and the next airing were last fetched, so the
-- title page knows whether it has to ask the source again.
ALTER TABLE "title" ADD COLUMN "detail_fetched_at" TIMESTAMPTZ(3);
