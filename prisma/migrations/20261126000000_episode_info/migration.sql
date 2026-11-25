-- The title and synopsis of single episodes, fetched on demand from Jikan (MyAnimeList) and kept here.
CREATE TABLE "episode_info" (
    "title_id" UUID NOT NULL,
    "episode_number" INTEGER NOT NULL,
    "name" TEXT,
    "synopsis" TEXT,
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "episode_info_pkey" PRIMARY KEY ("title_id","episode_number")
);

ALTER TABLE "episode_info" ADD CONSTRAINT "episode_info_title_id_fkey" FOREIGN KEY ("title_id") REFERENCES "title"("id") ON DELETE CASCADE ON UPDATE CASCADE;
