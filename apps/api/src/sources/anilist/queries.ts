/**
 * The GraphQL documents sent to AniList. They are plain strings so the fixtures recorded from them
 * can be replayed by the contract tests.
 */

const MEDIA_CARD = `
  id
  idMal
  title { romaji english native }
  synonyms
  description(asHtml: false)
  coverImage { extraLarge large color }
  externalLinks { site url type }
  bannerImage
  format
  status
  episodes
  duration
  season
  seasonYear
  startDate { year month day }
  endDate { year month day }
  averageScore
  popularity
  isAdult
  genres
  updatedAt
`;

const PAGE_INFO = 'pageInfo { currentPage hasNextPage }';

const MEDIA_ARGUMENTS = `
  type: ANIME
  search: $search
  genre: $genre
  season: $season
  seasonYear: $seasonYear
  format: $format
  status: $status
  isAdult: $isAdult
  sort: $sort
`;

const PAGE_VARIABLES = `
  $page: Int, $perPage: Int, $search: String, $genre: String, $season: MediaSeason,
  $seasonYear: Int, $format: MediaFormat, $status: MediaStatus, $isAdult: Boolean,
  $sort: [MediaSort]
`;

/** Search and browse share one document: browse simply sends no `search`. */
export const MEDIA_PAGE_QUERY = `
query MediaPage(${PAGE_VARIABLES}) {
  Page(page: $page, perPage: $perPage) {
    ${PAGE_INFO}
    media(${MEDIA_ARGUMENTS}) {${MEDIA_CARD}
      relations { edges { relationType(version: 2) node { id idMal type format title { romaji } } } }
    }
  }
}`;

export const MEDIA_DETAIL_QUERY = `
query MediaDetail($id: Int) {
  Media(id: $id, type: ANIME) {
    ${MEDIA_CARD}
    studios { edges { isMain node { id name isAnimationStudio } } }
    relations { edges { relationType(version: 2) node { id idMal type format title { romaji } } } }
    nextAiringEpisode { episode airingAt }
    streamingEpisodes { title url site }
    characters(perPage: 25, sort: [ROLE, RELEVANCE]) {
      edges {
        role
        node { id name { full native } image { large } description(asHtml: false) }
        voiceActors(language: JAPANESE) { id name { full native } image { large } languageV2 }
      }
    }
  }
}`;

export const AIRING_QUERY = `
query Airing($ids: [Int], $from: Int, $to: Int, $page: Int, $perPage: Int) {
  Page(page: $page, perPage: $perPage) {
    ${PAGE_INFO}
    airingSchedules(mediaId_in: $ids, airingAt_greater: $from, airingAt_lesser: $to, sort: TIME) {
      episode
      airingAt
      mediaId
    }
  }
}`;

export const GENRES_QUERY = `query Genres { GenreCollection }`;
