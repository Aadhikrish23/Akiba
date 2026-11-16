import { describe, expect, it } from 'vitest';
import { LOGIN_BACKOFF } from '../../config/constants.js';
import { MemoryLoginThrottle } from './loginThrottle.js';

const options = {
  freeAttempts: 3,
  baseDelayMs: 1_000,
  maxDelayMs: 8_000,
  forgetAfterMs: 60_000,
  maxTrackedKeys: 3,
};

describe('MemoryLoginThrottle (S-AUTH-4)', () => {
  it('S-AUTH-4: allows the free attempts back to back, then demands a wait', async () => {
    const throttle = new MemoryLoginThrottle(options);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await throttle.attempt('a', 0)).toEqual({ allowed: true, retryAfterMs: 0 });
    }
    expect(await throttle.attempt('a', 0)).toEqual({ allowed: false, retryAfterMs: 1_000 });
    expect(await throttle.attempt('a', 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect((await throttle.attempt('a', 1_000)).allowed).toBe(true);
  });

  it('S-AUTH-4: the wait doubles with each further failure and is capped (no permanent lockout)', async () => {
    const throttle = new MemoryLoginThrottle(options);
    let now = 0;
    for (let attempt = 1; attempt <= 3; attempt++) await throttle.attempt('a', now);
    const waits: number[] = [];
    for (let round = 0; round < 8; round++) {
      const refused = await throttle.attempt('a', now);
      expect(refused.allowed).toBe(false);
      waits.push(refused.retryAfterMs);
      now += refused.retryAfterMs;
      expect((await throttle.attempt('a', now)).allowed).toBe(true);
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 8_000, 8_000, 8_000, 8_000]);
  });

  it('S-AUTH-4: a refused attempt does not extend the wait', async () => {
    const throttle = new MemoryLoginThrottle(options);
    for (let attempt = 1; attempt <= 3; attempt++) await throttle.attempt('a', 0);
    for (let hammer = 0; hammer < 50; hammer++) await throttle.attempt('a', 500);
    expect(await throttle.attempt('a', 999)).toEqual({ allowed: false, retryAfterMs: 1 });
    expect((await throttle.attempt('a', 1_000)).allowed).toBe(true);
  });

  it('S-AUTH-4: success clears the failures', async () => {
    const throttle = new MemoryLoginThrottle(options);
    for (let attempt = 1; attempt <= 3; attempt++) await throttle.attempt('a', 0);
    expect((await throttle.attempt('a', 1_000)).allowed).toBe(true);
    await throttle.succeed('a');
    expect(throttle.size).toBe(0);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await throttle.attempt('a', 1_000)).allowed).toBe(true);
    }
  });

  it('S-AUTH-4: keys are independent', async () => {
    const throttle = new MemoryLoginThrottle(options);
    for (let attempt = 1; attempt <= 3; attempt++) await throttle.attempt('a', 0);
    expect((await throttle.attempt('a', 0)).allowed).toBe(false);
    expect((await throttle.attempt('b', 0)).allowed).toBe(true);
  });

  it('S-AUTH-4: failures are forgotten after the quiet period', async () => {
    const throttle = new MemoryLoginThrottle(options);
    for (let attempt = 1; attempt <= 3; attempt++) await throttle.attempt('a', 0);
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect((await throttle.attempt('a', 60_000)).allowed).toBe(true);
    }
  });

  it('S-AUTH-4: memory is bounded; the least recently attempted key is dropped first', async () => {
    const throttle = new MemoryLoginThrottle(options);
    await throttle.attempt('a', 0);
    await throttle.attempt('b', 1);
    await throttle.attempt('c', 2);
    await throttle.attempt('a', 3);
    await throttle.attempt('d', 4);
    expect(throttle.size).toBe(3);
    // 'b' was dropped: it starts over; 'a' was kept with its two failures.
    await throttle.attempt('a', 5);
    expect((await throttle.attempt('a', 5)).allowed).toBe(false);
  });

  it('S-AUTH-4: production settings: 5 free attempts, 1 s base, 15 min cap', () => {
    expect(LOGIN_BACKOFF).toMatchObject({
      freeAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 15 * 60 * 1000,
    });
  });
});
