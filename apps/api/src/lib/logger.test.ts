import { describe, expect, it } from 'vitest';
import { LogSink } from '../testing/harness.js';
import { createLogger } from './logger.js';

describe('logger redaction (doc 05 §9: no tokens in logs)', () => {
  it('redacts credentials wherever they appear in a logged object', () => {
    const sink = new LogSink();
    const logger = createLogger({ level: 'info', destination: sink });

    logger.info(
      {
        authorization: 'Bearer top-level-secret',
        req: {
          headers: {
            authorization: 'Bearer header-secret',
            cookie: 'refresh=cookie-secret',
            'user-agent': 'vitest',
          },
        },
        res: { headers: { 'set-cookie': ['refresh=set-cookie-secret'] } },
        body: { email: 'kept', password: 'password-secret', refreshToken: 'refresh-secret' },
        user: { accessToken: 'access-secret', idToken: 'id-secret', token: 'token-secret' },
        config: { databaseUrl: 'postgresql://u:db-secret@h/d', secret: 'pepper-secret' },
      },
      'sample',
    );

    expect(sink.text).not.toMatch(/-secret/);
    const [line] = sink.lines;
    expect(line).toMatchObject({
      msg: 'sample',
      service: 'akiba-api',
      authorization: '[REDACTED]',
      req: {
        headers: { authorization: '[REDACTED]', cookie: '[REDACTED]', 'user-agent': 'vitest' },
      },
      res: { headers: { 'set-cookie': '[REDACTED]' } },
      body: { email: 'kept', password: '[REDACTED]', refreshToken: '[REDACTED]' },
    });
  });

  it('honours the configured level', () => {
    const sink = new LogSink();
    const logger = createLogger({ level: 'warn', destination: sink });
    logger.info('quiet');
    logger.warn('loud');
    expect(sink.lines.map((line) => line.msg)).toEqual(['loud']);
  });
});
