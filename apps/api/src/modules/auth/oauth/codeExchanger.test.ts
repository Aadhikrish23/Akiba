import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { decodeProtectedHeader, jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../../testing/harness.js';
import { TestClock } from '../../../testing/auth.js';
import {
  APPLE_SERVICES_ID,
  generateApplePrivateKeyPem,
  GOOGLE_MOBILE_CLIENT,
  GOOGLE_WEB_CLIENT,
  OAUTH_REDIRECT_URI,
  TEST_GOOGLE_CLIENT_SECRET,
} from '../../../testing/oauth.js';
import {
  appleClientSecret,
  HttpOAuthCodeExchanger,
  OAuthCodeExchangeError,
} from './codeExchanger.js';

interface Recorded {
  readonly method: string | undefined;
  readonly url: string | undefined;
  readonly headers: IncomingMessage['headers'];
  readonly body: string;
}

/**
 * The REAL exchanger against a stand-in token endpoint on the loopback interface. This proves
 * what it sends and how it reads answers. It does NOT prove that Google or Apple accept the
 * request: no request from this code has reached either provider.
 */
describe('HttpOAuthCodeExchanger (T6): authorization-code exchange', () => {
  let server: Server;
  let endpoint: string;
  let requests: Recorded[];
  let respond: (req: IncomingMessage, res: ServerResponse) => void;

  const json =
    (status: number, body: unknown) =>
    (_req: IncomingMessage, res: ServerResponse): void => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        });
        respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/token`;
  });
  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const apple = generateApplePrivateKeyPem();
  const clock = new TestClock();
  const config = testConfig({
    GOOGLE_CLIENT_IDS: `${GOOGLE_WEB_CLIENT},${GOOGLE_MOBILE_CLIENT}`,
    GOOGLE_CLIENT_SECRET: TEST_GOOGLE_CLIENT_SECRET,
    APPLE_CLIENT_IDS: APPLE_SERVICES_ID,
    APPLE_TEAM_ID: 'TEAM123456',
    APPLE_KEY_ID: 'KEY1234567',
    APPLE_PRIVATE_KEY: apple.pem,
  }).auth.oauth;

  const request = {
    code: 'the-authorization-code/with+odd=chars',
    codeVerifier: 'v'.repeat(43),
    redirectUri: OAUTH_REDIRECT_URI,
  };

  let exchanger: HttpOAuthCodeExchanger;
  beforeEach(() => {
    requests = [];
    respond = json(200, { id_token: 'header.payload.signature', access_token: 'ignored' });
    exchanger = new HttpOAuthCodeExchanger({
      config,
      now: clock.now,
      timeoutMs: 500,
      tokenEndpoints: { google: endpoint, apple: endpoint },
    });
  });

  async function failure(run: Promise<unknown>): Promise<OAuthCodeExchangeError> {
    try {
      await run;
    } catch (error) {
      if (error instanceof OAuthCodeExchangeError) return error;
      throw error;
    }
    throw new Error('expected the exchange to fail');
  }

  it('S-AUTH-9: Google code exchange sends the code, the PKCE verifier, the redirect URI and the web client', async () => {
    await expect(exchanger.exchange('google', request)).resolves.toEqual({
      idToken: 'header.payload.signature',
    });
    expect(requests).toHaveLength(1);
    const sent = requests[0] as Recorded;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe('/token');
    expect(sent.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(sent.headers.accept).toBe('application/json');
    expect(Object.fromEntries(new URLSearchParams(sent.body))).toEqual({
      grant_type: 'authorization_code',
      code: request.code,
      code_verifier: request.codeVerifier,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: GOOGLE_WEB_CLIENT, // the FIRST configured client ID
      client_secret: TEST_GOOGLE_CLIENT_SECRET,
    });
  });

  it('S-AUTH-9: Apple code exchange signs a short-lived ES256 client secret', async () => {
    await exchanger.exchange('apple', request);
    const form = Object.fromEntries(new URLSearchParams((requests[0] as Recorded).body));
    expect(form).toMatchObject({
      grant_type: 'authorization_code',
      code: request.code,
      code_verifier: request.codeVerifier,
      redirect_uri: OAUTH_REDIRECT_URI,
      client_id: APPLE_SERVICES_ID,
    });
    const secret = form['client_secret'] as string;
    expect(decodeProtectedHeader(secret)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    const { payload } = await jwtVerify(secret, apple.publicKey, {
      algorithms: ['ES256'],
      currentDate: clock.now(),
    });
    const issuedAt = Math.floor(clock.now().getTime() / 1000);
    expect(payload).toEqual({
      iss: 'TEAM123456',
      sub: APPLE_SERVICES_ID,
      aud: 'https://appleid.apple.com',
      iat: issuedAt,
      exp: issuedAt + 300,
    });
  });

  it('S-AUTH-9: appleClientSecret refuses a key that is not usable for ES256', async () => {
    await expect(
      appleClientSecret({
        teamId: 'TEAM123456',
        keyId: 'KEY1234567',
        clientId: APPLE_SERVICES_ID,
        privateKeyPem: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----',
        now: clock.now(),
      }),
    ).rejects.toThrow();
  });

  it('S-AUTH-9: invalid_grant means the code was refused', async () => {
    respond = json(400, { error: 'invalid_grant', error_description: 'Bad Request' });
    const error = await failure(exchanger.exchange('google', request));
    expect(error.reason).toBe('rejected');
  });

  it('S-AUTH-9: every other provider answer is "unavailable", not a refusal of the user', async () => {
    const cases: [string, (req: IncomingMessage, res: ServerResponse) => void][] = [
      ['invalid_client', json(401, { error: 'invalid_client' })],
      ['invalid_client as 400', json(400, { error: 'invalid_client' })],
      ['server error', json(500, { error: 'server_error' })],
      ['200 without id_token', json(200, { access_token: 'only' })],
      ['200 with an empty id_token', json(200, { id_token: '' })],
      [
        '200 that is not JSON',
        (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<html>maintenance</html>');
        },
      ],
      [
        'oversized answer',
        (_req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ id_token: 'x', padding: 'p'.repeat(70_000) }));
        },
      ],
    ];
    for (const [name, handler] of cases) {
      respond = handler;
      const error = await failure(exchanger.exchange('google', request));
      expect(error.reason, name).toBe('unavailable');
    }
  });

  it('S-AUTH-9: a redirect from the token endpoint is not followed', async () => {
    respond = (_req, res) => {
      res.writeHead(307, { Location: endpoint.replace('/token', '/elsewhere') });
      res.end();
    };
    const error = await failure(exchanger.exchange('google', request));
    expect(error.reason).toBe('unavailable');
    expect(requests.map((sent) => sent.url)).toEqual(['/token']);
  });

  it('S-AUTH-9: a token endpoint that does not answer in time is "unavailable"', async () => {
    respond = () => undefined; // never answers
    const started = Date.now();
    const error = await failure(exchanger.exchange('google', request));
    expect(error.reason).toBe('unavailable');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('S-AUTH-9: an unconfigured web flow sends nothing', async () => {
    const bare = new HttpOAuthCodeExchanger({
      config: testConfig({ GOOGLE_CLIENT_IDS: GOOGLE_WEB_CLIENT }).auth.oauth,
      now: clock.now,
      tokenEndpoints: { google: endpoint, apple: endpoint },
    });
    expect((await failure(bare.exchange('google', request))).reason).toBe('unavailable');
    expect((await failure(bare.exchange('apple', request))).reason).toBe('unavailable');
    expect(requests).toHaveLength(0);
  });

  it('S-AUTH-9 / doc 09 §7: failures never carry the code, the verifier or a secret', async () => {
    respond = json(400, { error: 'invalid_grant', error_description: request.code });
    const refused = await failure(exchanger.exchange('google', request));
    respond = json(401, { error: 'invalid_client' });
    const unavailable = await failure(exchanger.exchange('google', request));
    for (const error of [refused, unavailable]) {
      const text = `${error.message} ${error.detail} ${String(error.cause)}`;
      expect(text).not.toContain(request.code);
      expect(text).not.toContain(request.codeVerifier);
      expect(text).not.toContain(TEST_GOOGLE_CLIENT_SECRET);
    }
  });
});
