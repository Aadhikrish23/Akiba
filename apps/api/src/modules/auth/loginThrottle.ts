import { LOGIN_BACKOFF } from '../../config/constants.js';

export interface ThrottleDecision {
  readonly allowed: boolean;
  /** When refused: how long until the next attempt will be considered. */
  readonly retryAfterMs: number;
}

/**
 * Per-account brute-force protection (doc 09 S-AUTH-4). Asynchronous so a shared store can
 * replace the in-memory one when the API runs on more than one instance.
 *
 * The key is the normalised email whether or not an account exists for it, so throttling
 * behaves the same for unknown addresses and reveals nothing (S-AUTH-3).
 */
export interface LoginThrottle {
  /**
   * Ask to make a login attempt. An allowed attempt is counted as a failure immediately; call
   * {@link succeed} when the credentials turn out to be right. Counting up front (rather than
   * after the password check) means parallel guesses cannot all slip through one open window.
   */
  attempt(key: string, now: number): Promise<ThrottleDecision>;
  /** Forget the failures for a key after a successful login. */
  succeed(key: string): Promise<void>;
}

export interface BackoffOptions {
  readonly freeAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly forgetAfterMs: number;
  readonly maxTrackedKeys: number;
}

interface Entry {
  failures: number;
  /** No attempt is considered before this time. */
  blockedUntil: number;
  lastAttemptAt: number;
}

/**
 * Exponential backoff held in process memory (single instance only, like the rate-limit store).
 *
 * After `freeAttempts` failures the wait doubles with each further failure and is capped at
 * `maxDelayMs`; there is no permanent lockout. A refused attempt is not counted, so hammering a
 * locked account does not extend the lock. The legitimate owner can still be delayed by an
 * attacker who keeps guessing, by at most `maxDelayMs` at a time: that is the accepted cost of
 * per-account throttling.
 */
export class MemoryLoginThrottle implements LoginThrottle {
  readonly #entries = new Map<string, Entry>();
  readonly #options: BackoffOptions;

  constructor(options: BackoffOptions = LOGIN_BACKOFF) {
    this.#options = options;
  }

  attempt(key: string, now: number): Promise<ThrottleDecision> {
    const { freeAttempts, baseDelayMs, maxDelayMs, forgetAfterMs } = this.#options;
    let entry = this.#entries.get(key);
    if (entry !== undefined && now - entry.lastAttemptAt >= forgetAfterMs) {
      this.#entries.delete(key);
      entry = undefined;
    }
    if (entry !== undefined && entry.blockedUntil > now) {
      return Promise.resolve({ allowed: false, retryAfterMs: entry.blockedUntil - now });
    }

    const failures = (entry?.failures ?? 0) + 1;
    const over = failures - freeAttempts;
    // 2^over grows past any cap quickly; bound the exponent so the arithmetic stays exact.
    const delay = over < 0 ? 0 : Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(over, 30));
    // Re-insert so the Map's insertion order is also "least recently attempted first".
    this.#entries.delete(key);
    this.#entries.set(key, { failures, blockedUntil: now + delay, lastAttemptAt: now });
    this.#evict();
    return Promise.resolve({ allowed: true, retryAfterMs: 0 });
  }

  succeed(key: string): Promise<void> {
    this.#entries.delete(key);
    return Promise.resolve();
  }

  /** Number of tracked keys (for tests and diagnostics). */
  get size(): number {
    return this.#entries.size;
  }

  /** Bound memory: an attacker spraying addresses must not be able to grow the map forever. */
  #evict(): void {
    while (this.#entries.size > this.#options.maxTrackedKeys) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) return;
      this.#entries.delete(oldest.value);
    }
  }
}
