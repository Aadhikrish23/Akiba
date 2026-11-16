import { randomBytes } from 'node:crypto';
import { hash, verify, type Options } from '@node-rs/argon2';
import { ARGON2_FLOOR } from '../../config/constants.js';

/**
 * Password hashing seam (doc 09 S-AUTH-1, S-AUTH-12). The rest of the auth module depends on
 * this interface only, so the algorithm can be replaced (and tests can observe calls).
 */
export interface PasswordHasher {
  /** Returns a self-describing hash string (PHC format) with a fresh random salt. */
  hash(password: string): Promise<string>;
  /** True only when `password` produces `storedHash`. Never throws for a malformed hash. */
  verify(storedHash: string, password: string): Promise<boolean>;
}

/** `Algorithm.Argon2id` and `Version.V0x13` of `@node-rs/argon2`. */
const ARGON2ID = 2;
const ARGON2_VERSION_0X13 = 1;

export interface Argon2idOptions {
  /** Memory in KiB; at least the S-AUTH-1 floor (19 MiB). */
  readonly memoryKib: number;
  /** Iterations; at least the S-AUTH-1 floor (2). */
  readonly timeCost: number;
  /** Optional pepper: a server-side secret that is not stored with the hashes. */
  readonly pepper?: string | undefined;
}

/**
 * Unicode-normalise a password before hashing or verifying (NIST SP 800-63B §5.1.1.2), so the
 * same characters typed on different keyboards/platforms give the same bytes. Nothing is trimmed
 * or truncated: every code point takes part in the hash (S-AUTH-2).
 */
export function normalisePassword(password: string): string {
  return password.normalize('NFKC');
}

/**
 * argon2id through `@node-rs/argon2` (the reference Rust implementation, prebuilt binaries).
 * The library generates a random 16-byte salt per hash and compares digests in constant time.
 * The pepper is passed as argon2's own `secret` input, not concatenated by hand.
 */
export class Argon2idHasher implements PasswordHasher {
  readonly #options: Options;

  constructor(options: Argon2idOptions) {
    if (options.memoryKib < ARGON2_FLOOR.memoryKib || options.timeCost < ARGON2_FLOOR.timeCost) {
      throw new Error('argon2id parameters are below the floor of doc 09 S-AUTH-1');
    }
    this.#options = {
      // The library types these as ambient `const enum`s, which do not survive per-file
      // transpilation, so the numeric values are given here. A unit test asserts that the
      // produced hash starts with `$argon2id$v=19$`.
      algorithm: ARGON2ID,
      version: ARGON2_VERSION_0X13,
      memoryCost: options.memoryKib,
      timeCost: options.timeCost,
      parallelism: ARGON2_FLOOR.parallelism,
      outputLen: 32,
      ...(options.pepper === undefined ? {} : { secret: Buffer.from(options.pepper, 'utf8') }),
    };
  }

  hash(password: string): Promise<string> {
    return hash(normalisePassword(password), this.#options);
  }

  async verify(storedHash: string, password: string): Promise<boolean> {
    // Only hashes this class could have produced are checked; anything else is simply "no".
    if (!storedHash.startsWith('$argon2id$')) return false;
    try {
      return await verify(storedHash, normalisePassword(password), this.#options);
    } catch {
      return false;
    }
  }
}

/**
 * A valid hash of a password nobody knows. Login verifies against it when the account does not
 * exist (or has no password), so that path costs the same as a wrong password (S-AUTH-3).
 */
export function createDummyHash(hasher: PasswordHasher): Promise<string> {
  return hasher.hash(randomBytes(32).toString('base64url'));
}
