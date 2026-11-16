import { describe, expect, it } from 'vitest';
import { ARGON2_FLOOR } from '../../config/constants.js';
import {
  AnyChecker,
  HibpRangeChecker,
  LocalListChecker,
  type BreachedPasswordChecker,
} from './breachedPasswords.js';
import { COMMON_PASSWORDS } from './commonPasswords.js';
import { Argon2idHasher, createDummyHash } from './password.js';

const floor = { memoryKib: ARGON2_FLOOR.memoryKib, timeCost: ARGON2_FLOOR.timeCost };

describe('Argon2idHasher (S-AUTH-1, NFR-SEC-001)', () => {
  const hasher = new Argon2idHasher(floor);

  it('S-AUTH-1: produces argon2id v19 hashes with m=19456 KiB, t=2, p=1', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(hash).toMatch(
      /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/,
    );
    expect(hash).not.toContain('correct horse');
  });

  it('S-AUTH-1: uses a fresh salt per hash', async () => {
    const [first, second] = await Promise.all([
      hasher.hash('correct horse battery'),
      hasher.hash('correct horse battery'),
    ]);
    expect(first).not.toBe(second);
    expect(await hasher.verify(first, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(second, 'correct horse battery')).toBe(true);
  });

  it('S-AUTH-1: verifies the right password and rejects a wrong one', async () => {
    const hash = await hasher.hash('correct horse battery');
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(true);
    expect(await hasher.verify(hash, 'correct horse batterz')).toBe(false);
    expect(await hasher.verify(hash, '')).toBe(false);
  });

  it('S-AUTH-1: refuses parameters below the floor', () => {
    expect(() => new Argon2idHasher({ ...floor, memoryKib: ARGON2_FLOOR.memoryKib - 1 })).toThrow(
      /below the floor/,
    );
    expect(() => new Argon2idHasher({ ...floor, timeCost: 1 })).toThrow(/below the floor/);
  });

  it('S-AUTH-1: honours raised parameters', async () => {
    const stronger = new Argon2idHasher({ memoryKib: 32_768, timeCost: 3 });
    expect(await stronger.hash('correct horse battery')).toContain('$m=32768,t=3,p=1$');
  });

  it('S-AUTH-1: a pepper is required to verify hashes made with it', async () => {
    const peppered = new Argon2idHasher({ ...floor, pepper: 'p'.repeat(32) });
    const otherPepper = new Argon2idHasher({ ...floor, pepper: 'q'.repeat(32) });
    const hash = await peppered.hash('correct horse battery');
    expect(hash).not.toContain('pppp');
    expect(await peppered.verify(hash, 'correct horse battery')).toBe(true);
    expect(await otherPepper.verify(hash, 'correct horse battery')).toBe(false);
    expect(await hasher.verify(hash, 'correct horse battery')).toBe(false);
  });

  it('S-AUTH-2: does not truncate (128-character passwords differing only at the end)', async () => {
    const base = 'x'.repeat(127);
    const hash = await hasher.hash(`${base}a`);
    expect(await hasher.verify(hash, `${base}a`)).toBe(true);
    expect(await hasher.verify(hash, `${base}b`)).toBe(false);
    expect(await hasher.verify(hash, base)).toBe(false);
  });

  it('S-AUTH-2: does not trim; whitespace is part of the password', async () => {
    const hash = await hasher.hash(' leading and trailing ');
    expect(await hasher.verify(hash, ' leading and trailing ')).toBe(true);
    expect(await hasher.verify(hash, 'leading and trailing')).toBe(false);
  });

  it('S-AUTH-2: treats Unicode-equivalent spellings as the same password (NFKC)', async () => {
    const composed = 'café au lait 123';
    const decomposed = 'café au lait 123';
    expect(composed).not.toBe(decomposed);
    const hash = await hasher.hash(composed);
    expect(await hasher.verify(hash, decomposed)).toBe(true);
  });

  it('S-AUTH-3: never throws for a malformed or foreign stored hash', async () => {
    for (const stored of ['', 'not-a-hash', '$argon2id$garbage', '$2b$10$abcdefghijklmnopqrstuv']) {
      expect(await hasher.verify(stored, 'correct horse battery')).toBe(false);
    }
    // argon2i/argon2d hashes are not accepted even if well-formed: the algorithm is pinned.
    expect(
      await hasher.verify(
        '$argon2i$v=19$m=19456,t=2,p=1$c29tZXNhbHRzb21lc2FsdA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        'correct horse battery',
      ),
    ).toBe(false);
  });

  it('S-AUTH-3: the dummy hash is a real hash that no supplied password matches', async () => {
    const dummy = await createDummyHash(hasher);
    expect(dummy).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await hasher.verify(dummy, 'correct horse battery')).toBe(false);
    expect(await createDummyHash(hasher)).not.toBe(dummy);
  });
});

describe('breached-password checkers (S-AUTH-2)', () => {
  it('S-AUTH-2: the local list flags common passwords, case-insensitively', async () => {
    const checker = new LocalListChecker();
    expect(await checker.isBreached('password123')).toBe(true);
    expect(await checker.isBreached('PassWord123')).toBe(true);
    expect(await checker.isBreached('qwertyuiop')).toBe(true);
    expect(await checker.isBreached('correct horse battery staple')).toBe(false);
  });

  it('S-AUTH-2: every list entry can actually be hit (passes the length rule, lower-case, unique)', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThanOrEqual(100);
    for (const entry of COMMON_PASSWORDS) {
      expect([...entry].length).toBeGreaterThanOrEqual(10);
      expect(entry).toBe(entry.toLowerCase());
    }
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
  });

  // SHA-1("password123") = CBFDAC6008F9CAB4083784CBD1874F76618D2A97
  const PREFIX = 'CBFDA';
  const SUFFIX = 'C6008F9CAB4083784CBD1874F76618D2A97';

  it('S-AUTH-2: the range checker sends only a 5-character hash prefix and matches locally', async () => {
    const prefixes: string[] = [];
    const checker = new HibpRangeChecker((prefix) => {
      prefixes.push(prefix);
      return Promise.resolve(
        `0018A45C4D1DEF81644B54AB7F969B88D65:3\r\n${SUFFIX}:251682\r\nFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:0`,
      );
    });
    expect(await checker.isBreached('password123')).toBe(true);
    expect(await checker.isBreached('a password nobody has used')).toBe(false);
    expect(prefixes[0]).toBe(PREFIX);
    for (const prefix of prefixes) expect(prefix).toMatch(/^[0-9A-F]{5}$/);
  });

  it('S-AUTH-2: the range checker ignores padding rows (count 0)', async () => {
    const checker = new HibpRangeChecker(() => Promise.resolve(`${SUFFIX}:0`));
    expect(await checker.isBreached('password123')).toBe(false);
  });

  it('S-AUTH-2: the range checker fails open and reports the error', async () => {
    const errors: unknown[] = [];
    const checker = new HibpRangeChecker(
      () => Promise.reject(new Error('network down')),
      (error) => errors.push(error),
    );
    expect(await checker.isBreached('password123')).toBe(false);
    expect(errors).toHaveLength(1);
  });

  it('S-AUTH-2: AnyChecker is breached when any member says so and stops at the first hit', async () => {
    const calls: string[] = [];
    const member = (name: string, result: boolean): BreachedPasswordChecker => ({
      isBreached: () => {
        calls.push(name);
        return Promise.resolve(result);
      },
    });
    expect(await new AnyChecker([member('a', false), member('b', false)]).isBreached('x')).toBe(
      false,
    );
    expect(await new AnyChecker([member('c', true), member('d', false)]).isBreached('x')).toBe(
      true,
    );
    expect(calls).toEqual(['a', 'b', 'c']);
  });
});
