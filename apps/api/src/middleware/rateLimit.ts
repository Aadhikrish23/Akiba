import type { Request, RequestHandler } from 'express';
import { rateLimited } from '../lib/errors.js';

export interface RateLimitHit {
  /** Requests counted for the key in the current window, including this one. */
  readonly count: number;
  /** Epoch milliseconds at which the window ends and the count resets. */
  readonly resetAt: number;
}

/**
 * Counter storage for the limiter. Asynchronous so a shared store (Postgres/Redis) can replace
 * the in-memory one when the API runs on more than one instance.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

/** Fixed-window counters held in process memory. Correct for a single instance only. */
export class MemoryRateLimitStore implements RateLimitStore {
  readonly #windows = new Map<string, { count: number; resetAt: number }>();
  #nextSweepAt = 0;

  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    this.#sweep(now, windowMs);
    const current = this.#windows.get(key);
    if (current && current.resetAt > now) {
      current.count += 1;
      return Promise.resolve({ count: current.count, resetAt: current.resetAt });
    }
    const fresh = { count: 1, resetAt: now + windowMs };
    this.#windows.set(key, fresh);
    return Promise.resolve({ ...fresh });
  }

  /** Number of tracked keys (for tests and diagnostics). */
  get size(): number {
    return this.#windows.size;
  }

  /** Drop expired windows at most once per window so memory stays bounded by active clients. */
  #sweep(now: number, windowMs: number): void {
    if (now < this.#nextSweepAt) return;
    this.#nextSweepAt = now + windowMs;
    for (const [key, window] of this.#windows) {
      if (window.resetAt <= now) this.#windows.delete(key);
    }
  }
}

export interface RateLimiterOptions {
  /** Namespace for the counters, so limiters sharing a store do not share budgets. */
  readonly name: string;
  readonly windowMs: number;
  /** Requests allowed per key per window. */
  readonly max: number;
  readonly store: RateLimitStore;
  /** Identifies the client. Defaults to the IP address; authenticated routes can key by user. */
  readonly keyGenerator?: (req: Request) => string;
  /** Return true to exempt a request (it is not counted). */
  readonly skip?: (req: Request) => boolean;
  readonly now?: () => number;
}

const clientIp = (req: Request): string => req.ip ?? 'unknown';

/**
 * Fixed-window rate limiter (NFR-SEC-005). Over the limit it responds 429 with `Retry-After`
 * (doc 07 §1); every counted response carries `RateLimit-*` headers.
 *
 * A store failure is passed to the error handler (the request fails with 500) rather than being
 * let through unlimited.
 */
export function createRateLimiter(options: RateLimiterOptions): RequestHandler {
  const { name, windowMs, max, store } = options;
  const keyGenerator = options.keyGenerator ?? clientIp;
  const now = options.now ?? Date.now;

  return (req, res, next) => {
    if (options.skip?.(req)) {
      next();
      return;
    }
    const at = now();
    store
      .hit(`${name}:${keyGenerator(req)}`, windowMs, at)
      .then(({ count, resetAt }) => {
        const resetSeconds = Math.max(1, Math.ceil((resetAt - at) / 1000));
        res.setHeader('RateLimit-Limit', String(max));
        res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
        res.setHeader('RateLimit-Reset', String(resetSeconds));
        if (count > max) {
          next(rateLimited(resetSeconds));
          return;
        }
        next();
      })
      .catch(next);
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** True for state-changing requests, which get the stricter write budget. */
export const isWriteRequest = (req: Request): boolean => !SAFE_METHODS.has(req.method);
