import { execFileSync } from 'node:child_process';
import { createHmac, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { calculateJwkThumbprint, importJWK, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadEnv, type Ed25519Jwk } from '../../config/env.js';
import {
  generateSigningJwk,
  JwtAccessTokenService,
  loadAccessTokenKeys,
  type AccessTokenKeys,
} from './accessTokens.js';

const USER = '0b8f5a52-6d0c-4c56-9d0b-4a8f3f0e2a11';
const SESSION = '7e0f1c7e-2f43-4a41-8f0e-0d8f6c1f9b22';
const ISSUER = 'akiba-api';
const AUDIENCE = 'akiba';
const START = Date.parse('2026-11-16T12:00:00.000Z');

const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const publicOf = (jwk: Ed25519Jwk): Ed25519Jwk => ({
  kty: jwk.kty,
  crv: jwk.crv,
  x: jwk.x,
  kid: jwk.kid,
});

describe('JwtAccessTokenService (S-AUTH-5, FR-AUTH-003)', () => {
  let jwk: Ed25519Jwk;
  let keys: AccessTokenKeys;
  let nowMs: number;
  let service: JwtAccessTokenService;

  const serviceWith = (overrides: Partial<{ keys: AccessTokenKeys; audience: string }> = {}) =>
    new JwtAccessTokenService({
      keys,
      issuer: ISSUER,
      audience: AUDIENCE,
      lifetimeSeconds: 900,
      now: () => new Date(nowMs),
      ...overrides,
    });

  /** Sign arbitrary claims/header with the REAL key, to isolate each claim check. */
  async function signWithRealKey(
    claims: Record<string, unknown>,
    header: Record<string, unknown> = {},
    options: { iat?: number; exp?: number } = {},
  ): Promise<string> {
    const iat = options.iat ?? Math.floor(nowMs / 1000);
    return new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: USER, sid: SESSION, ...claims })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid, ...header })
      .setIssuedAt(iat)
      .setExpirationTime(options.exp ?? iat + 900)
      .sign(await importJWK({ ...jwk }, 'EdDSA'));
  }

  beforeAll(async () => {
    jwk = await generateSigningJwk();
    keys = await loadAccessTokenKeys({ privateJwk: jwk, previousPublicJwk: undefined });
  });

  beforeAll(() => {
    nowMs = START;
    service = serviceWith();
  });

  it('S-AUTH-5: issues an EdDSA JWT with kid and exactly iss/aud/sub/sid/iat/exp (15 min)', async () => {
    nowMs = START;
    const { token, expiresInSeconds } = await service.issue({ userId: USER, sessionId: SESSION });
    expect(expiresInSeconds).toBe(900);
    const decode = (part: string | undefined): unknown =>
      JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
    const parts = token.split('.');
    expect(parts).toHaveLength(3);
    const header = decode(parts[0]);
    const payload = decode(parts[1]);
    expect(header).toEqual({ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid });
    const iat = Math.floor(START / 1000);
    // Identifiers only: no email, name or other personal data in the claims.
    expect(payload).toEqual({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: USER,
      sid: SESSION,
      iat,
      exp: iat + 900,
    });
    expect(await service.verify(token)).toEqual({ userId: USER, sessionId: SESSION });
  });

  it('S-AUTH-5: a token is valid until its expiry and rejected from that second on', async () => {
    nowMs = START;
    const { token } = await service.issue({ userId: USER, sessionId: SESSION });
    nowMs = START + 899_000;
    expect(await service.verify(token)).not.toBeNull();
    nowMs = START + 900_000;
    expect(await service.verify(token)).toBeNull();
    nowMs = START + 86_400_000;
    expect(await service.verify(token)).toBeNull();
    nowMs = START;
  });

  it('S-AUTH-5: rejects alg "none" (unsigned token)', async () => {
    const iat = Math.floor(nowMs / 1000);
    const payload = { iss: ISSUER, aud: AUDIENCE, sub: USER, sid: SESSION, iat, exp: iat + 900 };
    for (const alg of ['none', 'None', 'NONE']) {
      const header = b64({ alg, typ: 'JWT', kid: jwk.kid });
      expect(await service.verify(`${header}.${b64(payload)}.`)).toBeNull();
      expect(await service.verify(`${header}.${b64(payload)}`)).toBeNull();
    }
  });

  it('S-AUTH-5: rejects algorithm confusion (HS256 keyed with the public key)', async () => {
    const iat = Math.floor(nowMs / 1000);
    const payload = b64({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: USER,
      sid: SESSION,
      iat,
      exp: iat + 900,
    });
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x },
      format: 'jwk',
    });
    const secrets = [
      publicKey.export({ format: 'pem', type: 'spki' }),
      publicKey.export({ format: 'der', type: 'spki' }),
      Buffer.from(jwk.x, 'base64url'),
      JSON.stringify(publicOf(jwk)),
    ];
    for (const alg of ['HS256', 'HS384', 'HS512']) {
      for (const secret of secrets) {
        const header = b64({ alg, typ: 'JWT', kid: jwk.kid });
        const signature = createHmac(`sha${alg.slice(2)}`, secret)
          .update(`${header}.${payload}`)
          .digest('base64url');
        expect(await service.verify(`${header}.${payload}.${signature}`)).toBeNull();
      }
    }
  });

  it('S-AUTH-5: rejects a tampered payload, a tampered signature and a swapped signature', async () => {
    const { token } = await service.issue({ userId: USER, sessionId: SESSION });
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as object;
    const forgedPayload = b64({ ...claims, sub: '11111111-1111-4111-8111-111111111111' });
    expect(await service.verify(`${header}.${forgedPayload}.${signature}`)).toBeNull();

    const bytes = Buffer.from(signature, 'base64url');
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    expect(await service.verify(`${header}.${payload}.${bytes.toString('base64url')}`)).toBeNull();

    const other = await service.issue({ userId: USER, sessionId: USER });
    expect(await service.verify(`${header}.${payload}.${other.token.split('.')[2]}`)).toBeNull();
    expect(await service.verify(`${header}.${payload}.`)).toBeNull();
  });

  it('S-AUTH-5: rejects a token signed by a different key, even one claiming our kid', async () => {
    const attacker = await generateSigningJwk();
    const attackerKey = await importJWK({ ...attacker }, 'EdDSA');
    const iat = Math.floor(nowMs / 1000);
    for (const kid of [jwk.kid, attacker.kid]) {
      const token = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: USER, sid: SESSION })
        .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid })
        .setIssuedAt(iat)
        .setExpirationTime(iat + 900)
        .sign(attackerKey);
      expect(await service.verify(token)).toBeNull();
    }
  });

  it('S-AUTH-5: rejects a missing kid and ignores key material embedded in the header', async () => {
    const attacker = await generateSigningJwk();
    const iat = Math.floor(nowMs / 1000);
    const missingKid = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: USER, sid: SESSION })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(await importJWK({ ...jwk }, 'EdDSA'));
    expect(await service.verify(missingKid)).toBeNull();

    const embeddedJwk = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: USER, sid: SESSION })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: attacker.kid, jwk: publicOf(attacker) })
      .setIssuedAt(iat)
      .setExpirationTime(iat + 900)
      .sign(await importJWK({ ...attacker }, 'EdDSA'));
    expect(await service.verify(embeddedJwk)).toBeNull();
  });

  it('S-AUTH-5: rejects a wrong or missing issuer', async () => {
    expect(await service.verify(await signWithRealKey({}))).not.toBeNull();
    expect(await service.verify(await signWithRealKey({ iss: 'someone-else' }))).toBeNull();
    expect(await service.verify(await signWithRealKey({ iss: undefined }))).toBeNull();
  });

  it('S-AUTH-5: rejects a wrong or missing audience', async () => {
    expect(await service.verify(await signWithRealKey({ aud: 'another-api' }))).toBeNull();
    expect(await service.verify(await signWithRealKey({ aud: ['another-api', 'x'] }))).toBeNull();
    expect(await service.verify(await signWithRealKey({ aud: undefined }))).toBeNull();
    // A token minted for this audience is not accepted by a service expecting another.
    const { token } = await service.issue({ userId: USER, sessionId: SESSION });
    expect(await serviceWith({ audience: 'another-api' }).verify(token)).toBeNull();
  });

  it('S-AUTH-5: rejects missing or malformed sub/sid and a missing exp', async () => {
    expect(await service.verify(await signWithRealKey({ sub: undefined }))).toBeNull();
    expect(await service.verify(await signWithRealKey({ sid: undefined }))).toBeNull();
    expect(await service.verify(await signWithRealKey({ sub: 'admin' }))).toBeNull();
    expect(await service.verify(await signWithRealKey({ sid: "' OR 1=1 --" }))).toBeNull();
    expect(await service.verify(await signWithRealKey({ sid: 42 }))).toBeNull();

    const noExpiry = await new SignJWT({ iss: ISSUER, aud: AUDIENCE, sub: USER, sid: SESSION })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid })
      .setIssuedAt(Math.floor(nowMs / 1000))
      .sign(await importJWK({ ...jwk }, 'EdDSA'));
    expect(await service.verify(noExpiry)).toBeNull();
  });

  it('S-AUTH-5: rejects a wrong typ and unknown critical headers', async () => {
    expect(await service.verify(await signWithRealKey({}, { typ: 'refresh+jwt' }))).toBeNull();
    // An otherwise valid token, really signed with our key, that marks an extension the
    // verifier does not understand as critical (RFC 7515 §4.1.11) must be refused.
    const iat = Math.floor(nowMs / 1000);
    const header = b64({ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid, crit: ['x'], x: true });
    const payload = b64({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: USER,
      sid: SESSION,
      iat,
      exp: iat + 900,
    });
    const privateKey = createPrivateKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x, d: jwk.d ?? '' },
      format: 'jwk',
    });
    const signature = sign(null, Buffer.from(`${header}.${payload}`), privateKey);
    const critical = `${header}.${payload}.${signature.toString('base64url')}`;
    expect(await service.verify(critical)).toBeNull();
    // Control: the same hand-built token without `crit` is accepted, so the refusal is the
    // critical header and not the way the token was assembled.
    const plainHeader = b64({ alg: 'EdDSA', typ: 'JWT', kid: jwk.kid });
    const plainSignature = sign(null, Buffer.from(`${plainHeader}.${payload}`), privateKey);
    expect(
      await service.verify(`${plainHeader}.${payload}.${plainSignature.toString('base64url')}`),
    ).not.toBeNull();
  });

  it('S-AUTH-5: rejects garbage without throwing', async () => {
    for (const garbage of ['', 'a', 'a.b', 'a.b.c', '....', 'e30.e30.e30', 'x'.repeat(5000)]) {
      expect(await service.verify(garbage)).toBeNull();
    }
  });

  it('S-AUTH-5: key rotation: the previous public key still verifies, an unknown kid does not', async () => {
    const oldJwk = await generateSigningJwk();
    const oldKeys = await loadAccessTokenKeys({ privateJwk: oldJwk, previousPublicJwk: undefined });
    const before = serviceWith({ keys: oldKeys });
    const { token: oldToken } = await before.issue({ userId: USER, sessionId: SESSION });

    const newJwk = await generateSigningJwk();
    const rotated = serviceWith({
      keys: await loadAccessTokenKeys({ privateJwk: newJwk, previousPublicJwk: publicOf(oldJwk) }),
    });
    expect(await rotated.verify(oldToken)).toEqual({ userId: USER, sessionId: SESSION });
    const { token: newToken } = await rotated.issue({ userId: USER, sessionId: SESSION });
    expect(
      JSON.parse(Buffer.from(newToken.split('.')[0] ?? '', 'base64url').toString()),
    ).toMatchObject({ kid: newJwk.kid });
    expect(await rotated.verify(newToken)).not.toBeNull();

    // Once the previous key is dropped, its tokens die; the old service never accepts new ones.
    const dropped = serviceWith({
      keys: await loadAccessTokenKeys({ privateJwk: newJwk, previousPublicJwk: undefined }),
    });
    expect(await dropped.verify(oldToken)).toBeNull();
    expect(await before.verify(newToken)).toBeNull();
  });

  it('S-AUTH-5: generated keys are distinct, carry a thumbprint kid, and are flagged when ephemeral', async () => {
    const [a, b] = await Promise.all([generateSigningJwk(), generateSigningJwk()]);
    expect(a.kid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.kid).not.toBe(b.kid);
    expect(a.d).not.toBe(b.d);
    expect(keys.ephemeral).toBe(false);
    const generated = await loadAccessTokenKeys({
      privateJwk: undefined,
      previousPublicJwk: undefined,
    });
    expect(generated.ephemeral).toBe(true);
    expect(generated.verification.has(generated.signing.kid)).toBe(true);
  });
});

describe('scripts/gen-jwt-key.mjs (`pnpm auth:gen-key`)', () => {
  const script = fileURLToPath(new URL('../../../../../scripts/gen-jwt-key.mjs', import.meta.url));
  const run = (...args: string[]): string =>
    execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' });

  it('S-AUTH-5: --raw prints a private JWK the API accepts, with the RFC 7638 thumbprint as kid', async () => {
    const raw = run('--raw').trim();
    const config = loadEnv({ AUTH_JWT_PRIVATE_JWK: raw });
    const jwk = config.auth.jwt.privateJwk;
    expect(jwk).toBeDefined();
    if (jwk === undefined) return;
    expect(jwk.kid).toBe(
      await calculateJwkThumbprint({ kty: 'OKP', crv: 'Ed25519', x: jwk.x }, 'sha256'),
    );
    // The key really signs and verifies.
    const keys = await loadAccessTokenKeys({ privateJwk: jwk, previousPublicJwk: undefined });
    const service = new JwtAccessTokenService({
      keys,
      issuer: ISSUER,
      audience: AUDIENCE,
      lifetimeSeconds: 900,
      now: () => new Date(START),
    });
    const { token } = await service.issue({ userId: USER, sessionId: SESSION });
    expect(await service.verify(token)).toEqual({ userId: USER, sessionId: SESSION });
    expect(run('--raw').trim()).not.toBe(raw);
  });

  it('S-AUTH-5: the default output is an env line plus a public half that fits the rotation slot', () => {
    const output = run();
    const privateLine = /^AUTH_JWT_PRIVATE_JWK='(.+)'$/m.exec(output)?.[1];
    const publicLine = /^# (\{.+\})$/m.exec(output)?.[1];
    expect(privateLine).toBeDefined();
    expect(publicLine).toBeDefined();
    expect(publicLine).not.toContain('"d"');
    const other = run('--raw').trim();
    const config = loadEnv({
      AUTH_JWT_PRIVATE_JWK: other,
      AUTH_JWT_PREVIOUS_PUBLIC_JWK: publicLine ?? '',
    });
    expect(config.auth.jwt.previousPublicJwk?.kid).toBe(
      (JSON.parse(privateLine ?? '{}') as { kid: string }).kid,
    );
  });
});
