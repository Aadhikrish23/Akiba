import { describe, expect, it } from 'vitest';
import { MemoryRateLimitStore } from './rateLimit.js';

describe('MemoryRateLimitStore', () => {
  it('counts hits per key within a window and resets after it', async () => {
    const store = new MemoryRateLimitStore();
    expect(await store.hit('a', 1000, 0)).toEqual({ count: 1, resetAt: 1000 });
    expect(await store.hit('a', 1000, 400)).toEqual({ count: 2, resetAt: 1000 });
    expect(await store.hit('b', 1000, 400)).toEqual({ count: 1, resetAt: 1400 });
    expect(await store.hit('a', 1000, 1000)).toEqual({ count: 1, resetAt: 2000 });
  });

  it('forgets expired keys so memory is bounded by active clients', async () => {
    const store = new MemoryRateLimitStore();
    for (let client = 0; client < 100; client += 1) {
      await store.hit(`ip-${client}`, 1000, 0);
    }
    expect(store.size).toBe(100);
    await store.hit('late', 1000, 5000);
    expect(store.size).toBe(1);
  });
});
