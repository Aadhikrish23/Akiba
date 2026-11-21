import { createAniListAdapter, type AniListAdapterOptions } from './anilist/anilistAdapter.js';
import { SourceGateway } from './gateway.js';
import { createJikanAdapter, type JikanAdapterOptions } from './jikan/jikanAdapter.js';

export * from './types.js';
export {
  SourceGateway,
  SourcesUnavailableError,
  type Sourced,
  type SourceStatus,
} from './gateway.js';
export { createAniListAdapter, ANILIST_URL } from './anilist/anilistAdapter.js';
export { createJikanAdapter, JIKAN_URL } from './jikan/jikanAdapter.js';

export interface SourcesOptions {
  readonly anilist?: AniListAdapterOptions;
  readonly jikan?: JikanAdapterOptions;
  /** Disable the fallback source (tests, or an operator who wants AniList only). */
  readonly fallback?: boolean;
  readonly onFallback?: ConstructorParameters<typeof SourceGateway>[0]['onFallback'];
}

/** AniList primary, Jikan fallback (D-02, Q-01). */
export function createSourceGateway(options: SourcesOptions = {}): SourceGateway {
  return new SourceGateway({
    primary: createAniListAdapter(options.anilist),
    ...(options.fallback === false ? {} : { fallback: createJikanAdapter(options.jikan) }),
    ...(options.onFallback === undefined ? {} : { onFallback: options.onFallback }),
  });
}
