import { createHash } from 'node:crypto';
import { COMMON_PASSWORDS } from './commonPasswords.js';

/**
 * Answers "is this password known to attackers?" (doc 09 S-AUTH-2). Implementations must not log
 * or transmit the password.
 */
export interface BreachedPasswordChecker {
  isBreached(password: string): Promise<boolean>;
}

const fold = (password: string): string => password.normalize('NFKC').toLowerCase();

/**
 * Default checker: a list shipped with the API, compared case-insensitively. No network access.
 * See `commonPasswords.ts` for what the list is (and is not).
 */
export class LocalListChecker implements BreachedPasswordChecker {
  readonly #list: ReadonlySet<string>;

  constructor(passwords: readonly string[] = COMMON_PASSWORDS) {
    this.#list = new Set(passwords.map(fold));
  }

  isBreached(password: string): Promise<boolean> {
    return Promise.resolve(this.#list.has(fold(password)));
  }
}

/** Fetches the body of a Have I Been Pwned range response for a 5-character SHA-1 prefix. */
export type HibpRangeFetcher = (prefix: string) => Promise<string>;

/**
 * OPTIONAL, OFF BY DEFAULT (`AUTH_HIBP_ENABLED=false`), and NOT VERIFIED AGAINST THE LIVE SERVICE.
 *
 * k-anonymity lookup against the Pwned Passwords range API: only the first five hex characters
 * of the password's SHA-1 leave the process; the suffix is matched locally. SHA-1 is what that
 * API is keyed on; it is not used to store anything.
 *
 * Fails OPEN: if the lookup fails, the password is treated as not breached (the local list has
 * already run) so that an outage of a third party cannot block registration. `onError` is told.
 */
export class HibpRangeChecker implements BreachedPasswordChecker {
  readonly #fetchRange: HibpRangeFetcher;
  readonly #onError: (error: unknown) => void;

  constructor(fetchRange: HibpRangeFetcher, onError: (error: unknown) => void = () => undefined) {
    this.#fetchRange = fetchRange;
    this.#onError = onError;
  }

  async isBreached(password: string): Promise<boolean> {
    const digest = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    let body: string;
    try {
      body = await this.#fetchRange(prefix);
    } catch (error) {
      this.#onError(error);
      return false;
    }
    for (const line of body.split('\n')) {
      const [candidate, count] = line.trim().split(':');
      // Padded responses contain decoy suffixes with a count of 0.
      if (candidate?.toUpperCase() === suffix && Number(count) > 0) return true;
    }
    return false;
  }
}

/** The production fetcher for {@link HibpRangeChecker}. Never used by tests or default config. */
export function createHibpFetcher(timeoutMs = 2_000): HibpRangeFetcher {
  return async (prefix) => {
    const response = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'akiba-api' },
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok)
      throw new Error(`pwnedpasswords range lookup failed: HTTP ${response.status}`);
    return response.text();
  };
}

/** Breached if ANY checker says so; checkers run in order and stop at the first hit. */
export class AnyChecker implements BreachedPasswordChecker {
  readonly #checkers: readonly BreachedPasswordChecker[];

  constructor(checkers: readonly BreachedPasswordChecker[]) {
    this.#checkers = checkers;
  }

  async isBreached(password: string): Promise<boolean> {
    for (const checker of this.#checkers) {
      if (await checker.isBreached(password)) return true;
    }
    return false;
  }
}
