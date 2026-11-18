import { SourceError, type BreakerState, type SourceName } from './types.js';

/**
 * The resilience toolkit of the source layer (doc 05 §4): per-source token bucket, circuit
 * breaker (opens for 60 s after 5 failures), retries with jitter (at most 2), request
 * coalescing and a 5 s timeout. Every piece takes its clock, sleep and randomness as parameters,
 * so the tests drive time by hand instead of waiting.
 */

export type Clock = () => number;
export type Sleep = (ms: number) => Promise<void>;

export const realSleep: Sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// ── Token bucket ──────────────────────────────────────────────────────────

export interface TokenBucketOptions {
  /** Burst size: how many requests may go out back to back. */
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly now?: Clock;
}

/** Keeps requests under a source's published limit. `acquire` waits for a token. */
export class TokenBucket {
  readonly #capacity: number;
  readonly #refillPerMs: number;
  readonly #now: Clock;
  #tokens: number;
  #updatedAt: number;

  constructor(options: TokenBucketOptions) {
    this.#capacity = options.capacity;
    this.#refillPerMs = options.refillPerSecond / 1000;
    this.#now = options.now ?? Date.now;
    this.#tokens = options.capacity;
    this.#updatedAt = this.#now();
  }

  #refill(): void {
    const now = this.#now();
    this.#tokens = Math.min(
      this.#capacity,
      this.#tokens + (now - this.#updatedAt) * this.#refillPerMs,
    );
    this.#updatedAt = now;
  }

  /** Take a token if one is there. Resolves with 0, or with how many ms until one will be. */
  take(): number {
    this.#refill();
    if (this.#tokens >= 1) {
      this.#tokens -= 1;
      return 0;
    }
    return Math.ceil((1 - this.#tokens) / this.#refillPerMs);
  }

  /** Wait until a token is available, then take it. Concurrent callers queue fairly enough. */
  async acquire(sleep: Sleep = realSleep): Promise<void> {
    for (;;) {
      const wait = this.take();
      if (wait === 0) return;
      await sleep(wait);
    }
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────────

export interface CircuitBreakerOptions {
  readonly source: SourceName;
  /** Consecutive failures that open the breaker. Default 5. */
  readonly failureThreshold?: number;
  /** How long it stays open. Default 60 s. */
  readonly openMs?: number;
  readonly now?: Clock;
  readonly onStateChange?: (state: BreakerState) => void;
}

/**
 * Stops hammering a source that is down. Closed: calls go through, consecutive failures are
 * counted. Open: calls fail at once with `circuit_open`. After `openMs` one probe is let through
 * (half-open): success closes the breaker, failure opens it again.
 */
export class CircuitBreaker {
  readonly #source: SourceName;
  readonly #threshold: number;
  readonly #openMs: number;
  readonly #now: Clock;
  readonly #onStateChange: ((state: BreakerState) => void) | undefined;
  #state: BreakerState = 'closed';
  #failures = 0;
  #openedAt = 0;
  #probing = false;

  constructor(options: CircuitBreakerOptions) {
    this.#source = options.source;
    this.#threshold = options.failureThreshold ?? 5;
    this.#openMs = options.openMs ?? 60_000;
    this.#now = options.now ?? Date.now;
    this.#onStateChange = options.onStateChange;
  }

  get state(): BreakerState {
    if (this.#state === 'open' && this.#now() - this.#openedAt >= this.#openMs) return 'half_open';
    return this.#state;
  }

  #set(state: BreakerState): void {
    if (this.#state !== state) {
      this.#state = state;
      this.#onStateChange?.(state);
    }
  }

  /** Run `operation` through the breaker. Only failures of the source count; `not_found` does not. */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === 'open' || (state === 'half_open' && this.#probing)) {
      throw new SourceError({
        source: this.#source,
        kind: 'circuit_open',
        message: `${this.#source} circuit is open`,
      });
    }
    if (state === 'half_open') {
      this.#probing = true;
      this.#set('half_open');
    }
    try {
      const result = await operation();
      this.#failures = 0;
      this.#probing = false;
      this.#set('closed');
      return result;
    } catch (error) {
      if (error instanceof SourceError && !error.isFailure) {
        // "No such title" says nothing about the source's health: it answered.
        this.#failures = 0;
        this.#probing = false;
        if (this.#state !== 'closed') this.#set('closed');
        throw error;
      }
      this.#failures += 1;
      if (state === 'half_open' || this.#failures >= this.#threshold) {
        this.#openedAt = this.#now();
        this.#probing = false;
        this.#set('open');
      }
      throw error;
    }
  }
}

// ── Retry with jitter ─────────────────────────────────────────────────────

export interface RetryOptions {
  /** Retries after the first attempt. Default 2 (so at most 3 attempts). */
  readonly retries?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly sleep?: Sleep;
  /** Uniform in [0, 1). */
  readonly random?: () => number;
}

const RETRYABLE: ReadonlySet<string> = new Set(['timeout', 'rate_limited', 'unavailable']);

/**
 * Retry transient failures with exponential backoff and full jitter. A `Retry-After` from the
 * source is honoured (capped by `maxDelayMs`); `bad_response`, `not_found` and an open circuit are
 * not retried because trying again cannot help.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const base = options.baseDelayMs ?? 250;
  const cap = options.maxDelayMs ?? 5_000;
  const sleep = options.sleep ?? realSleep;
  const random = options.random ?? Math.random;
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const retryable = error instanceof SourceError && RETRYABLE.has(error.kind);
      if (!retryable || attempt >= retries) throw error;
      const backoff = Math.min(cap, base * 2 ** attempt);
      const jittered = Math.floor(random() * backoff);
      const asked = error.retryAfterMs === undefined ? 0 : Math.min(cap, error.retryAfterMs);
      await sleep(Math.max(jittered, asked));
    }
  }
}

// ── Coalescing ────────────────────────────────────────────────────────────

/** Identical requests in flight at the same moment share one upstream call. */
export class Coalescer {
  readonly #inFlight = new Map<string, Promise<unknown>>();

  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const existing = this.#inFlight.get(key) as Promise<T> | undefined;
    if (existing !== undefined) return existing;
    const promise = operation().finally(() => {
      this.#inFlight.delete(key);
    });
    this.#inFlight.set(key, promise);
    return promise;
  }

  get size(): number {
    return this.#inFlight.size;
  }
}

// ── HTTP ──────────────────────────────────────────────────────────────────

export interface HttpOptions {
  readonly source: SourceName;
  readonly fetch?: typeof fetch;
  /** Default 5 s (doc 05 §4). */
  readonly timeoutMs?: number;
  readonly userAgent?: string;
}

function parseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get('Retry-After');
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * One JSON request with a timeout, and every failure mapped onto a {@link SourceError}: a
 * timeout, 429, 5xx or dropped connection is retryable; a 404 is `not_found`; anything else the
 * source sends that is not JSON or not a success is `bad_response`.
 */
export interface HttpResult {
  readonly status: number;
  readonly json: unknown;
}

export function createHttpJson(options: HttpOptions) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const { source } = options;

  return async function httpJson(
    url: string,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<HttpResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    try {
      let response: Response;
      let text: string;
      try {
        const headers: Record<string, string> = { Accept: 'application/json' };
        if (options.userAgent !== undefined) headers['User-Agent'] = options.userAgent;
        if (init.body !== undefined) headers['Content-Type'] = 'application/json';
        response = await fetchImpl(url, {
          method: init.method ?? 'GET',
          headers,
          ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
          signal: controller.signal,
        });
        text = await response.text();
      } catch (cause) {
        if (controller.signal.aborted) {
          throw new SourceError({
            source,
            kind: 'timeout',
            message: `${source} did not answer within ${timeoutMs} ms`,
            cause,
          });
        }
        throw new SourceError({
          source,
          kind: 'unavailable',
          message: `${source} could not be reached`,
          cause,
        });
      }

      if (response.status === 404) {
        throw new SourceError({ source, kind: 'not_found', message: 'not found', status: 404 });
      }
      if (response.status === 429) {
        throw new SourceError({
          source,
          kind: 'rate_limited',
          message: `${source} rate limit reached`,
          status: 429,
          retryAfterMs: parseRetryAfter(response),
        });
      }
      if (response.status >= 500) {
        throw new SourceError({
          source,
          kind: 'unavailable',
          message: `${source} answered ${response.status}`,
          status: response.status,
        });
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (cause) {
        throw new SourceError({
          source,
          kind: 'bad_response',
          message: `${source} answered ${response.status} with a body that is not JSON`,
          status: response.status,
          cause,
        });
      }
      // Other 4xx statuses are passed on with their body: AniList reports GraphQL errors that
      // way and the adapter decides what they mean.
      return { status: response.status, json };
    } finally {
      clearTimeout(timer);
    }
  };
}

// ── Composition ───────────────────────────────────────────────────────────

export interface ResilientClientOptions {
  readonly source: SourceName;
  readonly bucket: TokenBucket;
  readonly breaker: CircuitBreaker;
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly retries?: number;
}

/**
 * Wraps one source's calls in the whole stack. A request is coalesced with identical ones, goes
 * through the breaker once (so a request that fails after its retries is ONE failure), and takes
 * a token from the bucket for every attempt, retries included.
 */
export function createResilientClient(options: ResilientClientOptions) {
  const coalescer = new Coalescer();
  const sleep = options.sleep ?? realSleep;
  return {
    run<T>(key: string, operation: () => Promise<T>): Promise<T> {
      return coalescer.run(key, () =>
        options.breaker.execute(() =>
          withRetry(
            async () => {
              await options.bucket.acquire(sleep);
              return operation();
            },
            {
              sleep,
              ...(options.random === undefined ? {} : { random: options.random }),
              ...(options.retries === undefined ? {} : { retries: options.retries }),
            },
          ),
        ),
      );
    },
    get inFlight(): number {
      return coalescer.size;
    },
  };
}
