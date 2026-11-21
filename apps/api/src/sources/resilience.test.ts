import { describe, expect, it } from 'vitest';
import {
  CircuitBreaker,
  Coalescer,
  TokenBucket,
  createHttpJson,
  createResilientClient,
  withRetry,
} from './resilience.js';
import { FakeNet, ManualTime, jsonResponse } from '../testing/sources.js';
import { SourceError, type SourceErrorKind } from './types.js';

const fail = (kind: SourceErrorKind, extra: { retryAfterMs?: number } = {}): SourceError =>
  new SourceError({ source: 'anilist', kind, message: kind, ...extra });

describe('TokenBucket (NFR-COMP-001: stay under the source rate limit)', () => {
  it('lets a burst through, then makes callers wait for refills', async () => {
    const time = new ManualTime();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: time.now });
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(1000); // empty: one second until the next token

    await bucket.acquire(time.sleep);
    expect(time.slept).toEqual([1000]);
  });

  it('never holds more than its capacity however long it idles', () => {
    const time = new ManualTime();
    const bucket = new TokenBucket({ capacity: 2, refillPerSecond: 1, now: time.now });
    bucket.take();
    time.advance(60_000);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBe(0);
    expect(bucket.take()).toBeGreaterThan(0);
  });
});

describe('CircuitBreaker (doc 05 §4: open 60 s after 5 failures)', () => {
  const failing = (): Promise<never> => Promise.reject(fail('unavailable'));

  it('opens after 5 consecutive failures and then refuses without calling the source', async () => {
    const time = new ManualTime();
    const breaker = new CircuitBreaker({ source: 'anilist', now: time.now });
    for (let i = 0; i < 5; i += 1) {
      await expect(breaker.execute(failing)).rejects.toMatchObject({ kind: 'unavailable' });
    }
    expect(breaker.state).toBe('open');

    let called = false;
    await expect(
      breaker.execute(() => {
        called = true;
        return Promise.resolve('x');
      }),
    ).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(called).toBe(false);
  });

  it('a success resets the count: four failures, a success, four failures stays closed', async () => {
    const breaker = new CircuitBreaker({ source: 'anilist', now: new ManualTime().now });
    for (let i = 0; i < 4; i += 1) await breaker.execute(failing).catch(() => undefined);
    await breaker.execute(() => Promise.resolve('ok'));
    for (let i = 0; i < 4; i += 1) await breaker.execute(failing).catch(() => undefined);
    expect(breaker.state).toBe('closed');
  });

  it('"not found" is an answer, not a failure: it never opens the breaker', async () => {
    const breaker = new CircuitBreaker({ source: 'anilist', now: new ManualTime().now });
    for (let i = 0; i < 20; i += 1) {
      await breaker.execute(() => Promise.reject(fail('not_found'))).catch(() => undefined);
    }
    expect(breaker.state).toBe('closed');
  });

  it('half-opens after 60 s: one probe; success closes, failure re-opens for another 60 s', async () => {
    const time = new ManualTime();
    const breaker = new CircuitBreaker({ source: 'anilist', now: time.now });
    for (let i = 0; i < 5; i += 1) await breaker.execute(failing).catch(() => undefined);

    time.advance(59_999);
    expect(breaker.state).toBe('open');
    time.advance(1);
    expect(breaker.state).toBe('half_open');

    // The probe fails: open again.
    await breaker.execute(failing).catch(() => undefined);
    expect(breaker.state).toBe('open');
    time.advance(60_000);

    await expect(breaker.execute(() => Promise.resolve('back'))).resolves.toBe('back');
    expect(breaker.state).toBe('closed');
  });

  it('lets only ONE probe through while half-open', async () => {
    const time = new ManualTime();
    const breaker = new CircuitBreaker({ source: 'anilist', now: time.now });
    for (let i = 0; i < 5; i += 1) await breaker.execute(failing).catch(() => undefined);
    time.advance(60_000);

    let release: () => void = () => undefined;
    const probe = breaker.execute(
      () =>
        new Promise<string>((resolve) => {
          release = () => {
            resolve('ok');
          };
        }),
    );
    await expect(breaker.execute(() => Promise.resolve('second'))).rejects.toMatchObject({
      kind: 'circuit_open',
    });
    release();
    await expect(probe).resolves.toBe('ok');
  });

  it('reports state changes', async () => {
    const states: string[] = [];
    const time = new ManualTime();
    const breaker = new CircuitBreaker({
      source: 'anilist',
      now: time.now,
      onStateChange: (state) => states.push(state),
    });
    for (let i = 0; i < 5; i += 1) await breaker.execute(failing).catch(() => undefined);
    time.advance(60_000);
    await breaker.execute(() => Promise.resolve(1));
    expect(states).toEqual(['open', 'half_open', 'closed']);
  });
});

describe('withRetry (doc 05 §4: retries with jitter, at most 2)', () => {
  it('retries transient failures twice (three attempts) and then gives up', async () => {
    const time = new ManualTime();
    let attempts = 0;
    await expect(
      withRetry(
        () => {
          attempts += 1;
          return Promise.reject(fail('unavailable'));
        },
        { sleep: time.sleep, random: () => 0.5 },
      ),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(attempts).toBe(3);
    // Full jitter: half of the exponential cap (250, 500) each time.
    expect(time.slept).toEqual([125, 250]);
  });

  it('succeeds when a later attempt does', async () => {
    let attempts = 0;
    const result = await withRetry(
      () => {
        attempts += 1;
        return attempts < 3 ? Promise.reject(fail('timeout')) : Promise.resolve('done');
      },
      { sleep: new ManualTime().sleep },
    );
    expect(result).toBe('done');
  });

  it.each(['bad_response', 'not_found', 'circuit_open', 'unsupported'] as const)(
    'does not retry %s',
    async (kind) => {
      let attempts = 0;
      await expect(
        withRetry(
          () => {
            attempts += 1;
            return Promise.reject(fail(kind));
          },
          { sleep: new ManualTime().sleep },
        ),
      ).rejects.toMatchObject({ kind });
      expect(attempts).toBe(1);
    },
  );

  it('waits at least as long as the source asked (Retry-After), within the cap', async () => {
    const time = new ManualTime();
    let attempts = 0;
    await withRetry(
      () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(fail('rate_limited', { retryAfterMs: 3000 }))
          : Promise.resolve('ok');
      },
      { sleep: time.sleep, random: () => 0 },
    );
    expect(time.slept).toEqual([3000]);
  });

  it('does not retry a plain Error (a bug is not a transient failure)', async () => {
    let attempts = 0;
    await expect(
      withRetry(() => {
        attempts += 1;
        return Promise.reject(new Error('bug'));
      }),
    ).rejects.toThrow('bug');
    expect(attempts).toBe(1);
  });
});

describe('Coalescer (doc 05 §4: identical in-flight queries share one call)', () => {
  it('runs identical keys once and different keys separately', async () => {
    const coalescer = new Coalescer();
    let calls = 0;
    let release: () => void = () => undefined;
    const slow = (): Promise<number> => {
      calls += 1;
      return new Promise((resolve) => {
        release = () => {
          resolve(calls);
        };
      });
    };
    const a = coalescer.run('same', slow);
    const b = coalescer.run('same', slow);
    expect(coalescer.size).toBe(1);
    release();
    await expect(Promise.all([a, b])).resolves.toEqual([1, 1]);
    expect(calls).toBe(1);

    // Finished: the next identical request goes to the source again.
    const c = coalescer.run('same', () => Promise.resolve(99));
    await expect(c).resolves.toBe(99);
    expect(coalescer.size).toBe(0);
  });

  it('hands every waiter the same failure, and forgets it afterwards', async () => {
    const coalescer = new Coalescer();
    const failing = (): Promise<never> => Promise.reject(new Error('boom'));
    const results = await Promise.allSettled([
      coalescer.run('k', failing),
      coalescer.run('k', failing),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'rejected']);
    expect(coalescer.size).toBe(0);
  });
});

describe('createHttpJson (NFR-REL-001: every failure is classified)', () => {
  const run = (net: FakeNet, timeoutMs = 5000) =>
    createHttpJson({ source: 'jikan', fetch: net.fetch, timeoutMs })('https://example.test/x');

  it('returns the status and parsed body of a success', async () => {
    const net = new FakeNet(() => jsonResponse(200, { a: 1 }));
    await expect(run(net)).resolves.toEqual({ status: 200, json: { a: 1 } });
  });

  it.each([
    [404, 'not_found'],
    [429, 'rate_limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('maps HTTP %s to %s', async (status, kind) => {
    const net = new FakeNet(() => jsonResponse(status, {}));
    await expect(run(net)).rejects.toMatchObject({ kind, status });
  });

  it('reads Retry-After from a 429, in seconds', async () => {
    const net = new FakeNet(() => jsonResponse(429, {}, { 'Retry-After': '7' }));
    await expect(run(net)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterMs: 7000 });
  });

  it('treats an HTML error page as bad_response, not as data', async () => {
    const net = new FakeNet(() => new Response('<html>oops</html>', { status: 200 }));
    await expect(run(net)).rejects.toMatchObject({ kind: 'bad_response' });
  });

  it('maps a dropped connection to unavailable', async () => {
    const net = new FakeNet(() => {
      throw new TypeError('fetch failed');
    });
    await expect(run(net)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('maps a request that outlives the timeout to timeout', async () => {
    const hanging: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    const http = createHttpJson({ source: 'anilist', fetch: hanging, timeoutMs: 10 });
    await expect(http('https://example.test/x')).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('sends JSON bodies with a content type and no cookies or credentials of ours', async () => {
    const net = new FakeNet(() => jsonResponse(200, {}));
    await createHttpJson({ source: 'anilist', fetch: net.fetch })('https://example.test/x', {
      method: 'POST',
      body: { query: 'q' },
    });
    expect(net.requests[0]?.headers['content-type']).toBe('application/json');
    expect(net.requests[0]?.headers['cookie']).toBeUndefined();
    expect(net.requests[0]?.headers['authorization']).toBeUndefined();
  });
});

describe('createResilientClient (the whole stack)', () => {
  function stack(net: FakeNet) {
    const time = new ManualTime();
    const breaker = new CircuitBreaker({ source: 'anilist', now: time.now });
    const bucket = new TokenBucket({ capacity: 100, refillPerSecond: 100, now: time.now });
    const client = createResilientClient({
      source: 'anilist',
      bucket,
      breaker,
      sleep: time.sleep,
      random: () => 0,
    });
    const http = createHttpJson({ source: 'anilist', fetch: net.fetch });
    return {
      time,
      breaker,
      client,
      call: () => client.run('k', () => http('https://example.test/x')),
    };
  }

  it('counts a request that fails after its retries as ONE failure for the breaker', async () => {
    const net = new FakeNet(() => jsonResponse(503, {}));
    const { breaker, call } = stack(net);
    for (let i = 0; i < 4; i += 1) await call().catch(() => undefined);
    expect(net.requests).toHaveLength(12); // 4 operations × 3 attempts
    expect(breaker.state).toBe('closed');
    await call().catch(() => undefined);
    expect(breaker.state).toBe('open');
  });

  it('stops calling the network once the breaker is open', async () => {
    const net = new FakeNet(() => jsonResponse(503, {}));
    const { call } = stack(net);
    for (let i = 0; i < 5; i += 1) await call().catch(() => undefined);
    const before = net.requests.length;
    await expect(call()).rejects.toMatchObject({ kind: 'circuit_open' });
    expect(net.requests).toHaveLength(before);
  });
});
