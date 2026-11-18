-- T9 (akiba-id-mapping): the community ID-mapping dataset (doc 05 §5, Q-02) is stored so that
-- a title can be resolved through it the first time it is seen. One row = the IDs one title has
-- at each source. Imported by the mapping-refresh job; never written by user requests.

-- CreateTable
CREATE TABLE "mapping_dataset_entry" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "anilist_id" TEXT,
    "mal_id" TEXT,
    "kitsu_id" TEXT,
    "imported_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mapping_dataset_entry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mapping_dataset_entry_anilist_id_key" ON "mapping_dataset_entry"("anilist_id");

-- CreateIndex
CREATE UNIQUE INDEX "mapping_dataset_entry_mal_id_key" ON "mapping_dataset_entry"("mal_id");

-- CreateIndex
CREATE UNIQUE INDEX "mapping_dataset_entry_kitsu_id_key" ON "mapping_dataset_entry"("kitsu_id");

-- Hand-written: a row with a single ID maps nothing (doc 06 §4 style CHECK; invisible to db:check).
ALTER TABLE "mapping_dataset_entry"
    ADD CONSTRAINT "mapping_dataset_entry_two_ids_check"
    CHECK (num_nonnulls("anilist_id", "mal_id", "kitsu_id") >= 2);
