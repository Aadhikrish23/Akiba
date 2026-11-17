import { describe, expect, it } from 'vitest';
import { createLogger } from '../../lib/logger.js';
import { LogSink, TEST_SIGNING_JWK, testConfig } from '../../testing/harness.js';
import { ConsoleEmailSender, MemoryEmailSender } from './emailSender.js';
import { createEmailSender } from './index.js';
import { createEmailTemplates, escapeHtml, webLink } from './templates.js';

const TOKEN = 'tok_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_x';
const BASE = 'https://app.akiba.test';
const templates = createEmailTemplates({ webBaseUrl: BASE });
const ada = { email: 'ada@example.test', displayName: 'Ada' };

function sink() {
  const logs = new LogSink();
  return { logs, logger: createLogger({ level: 'trace', destination: logs }) };
}

const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

describe('email templates (T5)', () => {
  const tokenMessages = [
    { message: templates.verifyEmail(ada, TOKEN), path: '/verify-email' },
    { message: templates.resetPassword(ada, TOKEN), path: '/reset-password' },
  ];
  const plainMessages = [
    templates.registrationAttempt(ada),
    templates.passwordChanged(ada),
    templates.emailChanged(ada),
    templates.signInMethodChanged(ada, { provider: 'google', action: 'linked' }),
    templates.signInMethodChanged(ada, { provider: 'apple', action: 'unlinked' }),
  ];
  const all = [...tokenMessages.map((entry) => entry.message), ...plainMessages];

  it('FR-AUTH-005/006: the token appears only inside the link, which points at WEB_BASE_URL and keeps the token in the fragment', () => {
    for (const { message, path } of tokenMessages) {
      const link = `${BASE}${path}#token=${TOKEN}`;
      expect(occurrences(message.text, link)).toBe(1);
      expect(message.text.replaceAll(link, '')).not.toContain(TOKEN);
      // HTML: once as the href, once as the visible text of the same link.
      expect(occurrences(message.html, link)).toBe(2);
      expect(message.html.replaceAll(link, '')).not.toContain(TOKEN);
      expect(message.subject).not.toContain(TOKEN);
      // Fragment, not query: the token is never sent to the web server.
      expect(new URL(link).search).toBe('');
      expect(link).not.toContain('?');
    }
  });

  it('FR-AUTH-005/006: the links say how long they last', () => {
    expect(templates.verifyEmail(ada, TOKEN).text).toContain('expires in 24 hours');
    expect(templates.resetPassword(ada, TOKEN).text).toContain('expires in 1 hour');
  });

  it('S-AUTH-11: notices carry no token and the registration notice confirms nothing sensitive', () => {
    for (const message of plainMessages) {
      expect(message.text).not.toContain('token=');
      expect(message.html).not.toContain('token=');
    }
    expect(templates.passwordChanged(ada).text).toContain(`${BASE}/forgot-password`);
    expect(templates.registrationAttempt(ada).text).toContain(`${BASE}/login`);
    expect(templates.emailChanged(ada).subject).toContain('email address');
    const linked = templates.signInMethodChanged(ada, { provider: 'google', action: 'linked' });
    expect(linked.subject).toBe('Google sign-in was added to your Akiba account');
    expect(linked.text).toContain(`${BASE}/forgot-password`);
    const unlinked = templates.signInMethodChanged(ada, { provider: 'apple', action: 'unlinked' });
    expect(unlinked.subject).toBe('Apple sign-in was removed from your Akiba account');
  });

  it('doc 09 §7: no tracking pixels, images, scripts, styles or remote content; every link goes to the web app', () => {
    for (const message of all) {
      expect(message.html).not.toMatch(/<img|<script|<style|<link|<iframe|<object|src=|url\(/i);
      const urls = [...`${message.html} ${message.text}`.matchAll(/https?:\/\/[^\s"<]+/g)].map(
        (match) => match[0],
      );
      for (const url of urls) expect(new URL(url).origin).toBe(BASE);
      expect(message.to).toBe(ada.email);
      expect(message.text).toContain('Hi Ada,');
      expect(message.text.endsWith('\n')).toBe(true);
    }
  });

  it('doc 09 §4: a hostile display name cannot inject markup or extra lines', () => {
    const hostile = {
      email: 'eve@example.test',
      displayName: '<script>alert(1)</script>"\r\nBcc: victim@example.test',
    };
    const message = templates.verifyEmail(hostile, TOKEN);
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;&quot;');
    expect(message.text.split('\n')[0]).toBe(
      'Hi <script>alert(1)</script>" Bcc: victim@example.test,',
    );
    expect(message.subject).not.toContain('script');
    expect(
      templates.verifyEmail({ email: 'x@example.test', displayName: null }, TOKEN).text,
    ).toMatch(/^Hi there,/);
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#39;');
  });

  it('builds links from the configured origin only', () => {
    expect(webLink('http://localhost:5173', '/verify-email', 'a b/c')).toBe(
      'http://localhost:5173/verify-email#token=a%20b%2Fc',
    );
    expect(webLink(BASE, '/login')).toBe(`${BASE}/login`);
  });
});

describe('ConsoleEmailSender (T5)', () => {
  const message = templates.resetPassword(ada, TOKEN);

  it('S-AUTH-10: logs that an email was produced, never the recipient, subject, body, link or token', async () => {
    const { logs, logger } = sink();
    const printed: string[] = [];
    const sender = new ConsoleEmailSender({
      logger,
      printLinks: false,
      keep: 0,
      print: (text) => printed.push(text),
    });
    await sender.send(message);
    await sender.send(templates.verifyEmail(ada, TOKEN));

    expect(logs.lines).toHaveLength(2);
    expect(logs.lines[0]).toMatchObject({
      event: 'email_not_delivered',
      kind: 'reset_password',
      provider: 'console',
    });
    for (const secret of [TOKEN, 'token=', ada.email, 'reset-password', message.subject, 'Ada']) {
      expect(logs.text).not.toContain(secret);
    }
    expect(printed).toEqual([]);
    expect(sender.recent).toEqual([]);
  });

  it('S-AUTH-10: in production mode the configured sender prints nothing, keeps nothing and warns that mail is not delivered', async () => {
    const { logs, logger } = sink();
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array) => {
      written.push(chunk.toString());
      return true;
    };
    try {
      const sender = createEmailSender(
        testConfig({
          NODE_ENV: 'production',
          DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
          AUTH_JWT_PRIVATE_JWK: JSON.stringify(TEST_SIGNING_JWK),
          WEB_BASE_URL: BASE,
        }),
        logger,
      );
      await sender.send(message);
      expect(sender).toBeInstanceOf(ConsoleEmailSender);
      expect((sender as ConsoleEmailSender).recent).toEqual([]);
    } finally {
      process.stdout.write = original;
    }
    expect(written.join('')).toBe('');
    expect(logs.text).not.toContain(TOKEN);
    expect(logs.text).not.toContain(ada.email);
    expect(logs.lines[0]).toMatchObject({ level: 40 });
    expect(String(logs.lines[0]?.['msg'])).toContain('emails are NOT delivered');
  });

  it('EMAIL_DEV_PRINT_LINKS=true prints the message with its link to the console, and still not to the log', async () => {
    const { logs, logger } = sink();
    const printed: string[] = [];
    const sender = new ConsoleEmailSender({
      logger,
      printLinks: true,
      keep: 2,
      print: (text) => printed.push(text),
    });
    await sender.send(message);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain(`${BASE}/reset-password#token=${TOKEN}`);
    expect(printed[0]).toContain(`To: ${ada.email}`);
    expect(logs.text).not.toContain(TOKEN);
  });

  it('keeps only the latest N messages outside production', async () => {
    const { logger } = sink();
    const sender = new ConsoleEmailSender({ logger, printLinks: false, keep: 2, print: () => {} });
    const first = templates.passwordChanged(ada);
    const second = templates.verifyEmail(ada, TOKEN);
    await sender.send(first);
    await sender.send(second);
    await sender.send(message);
    expect(sender.recent).toEqual([second, message]);

    const development = createEmailSender(testConfig({ NODE_ENV: 'development' }), logger);
    await development.send(message);
    expect((development as ConsoleEmailSender).recent).toEqual([message]);
  });

  it('an unknown provider that got past the configuration is refused, without echoing it', () => {
    const { logger } = sink();
    const config = testConfig();
    const broken = { ...config, email: { ...config.email, provider: 'smtp-secret-host' } };
    expect(() => createEmailSender(broken as unknown as typeof config, logger)).toThrow(
      /not implemented/,
    );
    expect(() => createEmailSender(broken as unknown as typeof config, logger)).not.toThrow(
      /smtp-secret-host/,
    );
  });
});

describe('MemoryEmailSender (test double)', () => {
  it('captures messages, finds them case-insensitively, and can fail on demand', async () => {
    const sender = new MemoryEmailSender();
    await sender.send(templates.verifyEmail(ada, TOKEN));
    await sender.send(templates.passwordChanged(ada));
    expect(sender.to('ADA@example.test')).toHaveLength(2);
    expect(sender.last(ada.email, 'verify_email').kind).toBe('verify_email');
    expect(() => sender.last(ada.email, 'reset_password')).toThrow(/no reset_password email/);

    sender.failWith = new Error('down');
    await expect(sender.send(templates.passwordChanged(ada))).rejects.toThrow('down');
    expect(sender.sent).toHaveLength(2);
    sender.clear();
    expect(sender.sent).toEqual([]);
  });
});
