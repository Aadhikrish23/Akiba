import type { Logger } from '../../lib/logger.js';

/** What a message is for. Logged instead of its content. */
export type EmailKind =
  | 'verify_email'
  | 'reset_password'
  | 'registration_attempt'
  | 'password_changed'
  | 'email_changed'
  | 'sign_in_method_changed';

/**
 * One outgoing email. `text` and `html` may contain a one-time link, so a message is as secret
 * as a password until it is delivered: implementations must not log it.
 */
export interface EmailMessage {
  readonly kind: EmailKind;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/**
 * The seam between the application and whatever delivers email (doc 09 S-AUTH-12 applies the
 * same idea to auth). The delivery provider is an open decision; nothing outside this folder
 * knows which implementation is in use.
 */
export interface EmailSender {
  /** Hand one message over for delivery. Rejects when it could not be handed over. */
  send(message: EmailMessage): Promise<void>;
}

export interface ConsoleEmailSenderOptions {
  readonly logger: Logger;
  /**
   * Development aid: also write the whole message, link included, to the console. The
   * environment loader refuses to turn this on in production (`EMAIL_DEV_PRINT_LINKS`).
   */
  readonly printLinks: boolean;
  /** How many of the latest messages to keep in memory (0 = none, the production value). */
  readonly keep: number;
  /** Where printed messages go. Defaults to standard output. */
  readonly print?: (text: string) => void;
}

/**
 * The default sender: delivers nothing. It records in the log THAT a message of some kind was
 * produced, never its recipient, subject line, body or link (doc 09 §7).
 */
export class ConsoleEmailSender implements EmailSender {
  readonly #log: Logger;
  readonly #printLinks: boolean;
  readonly #keep: number;
  readonly #print: (text: string) => void;
  readonly #recent: EmailMessage[] = [];

  constructor(options: ConsoleEmailSenderOptions) {
    this.#log = options.logger.child({ module: 'email' });
    this.#printLinks = options.printLinks;
    this.#keep = Math.max(0, options.keep);
    this.#print =
      options.print ??
      ((text) => {
        process.stdout.write(`${text}\n`);
      });
  }

  /** The latest messages, oldest first (development and tests; always empty in production). */
  get recent(): readonly EmailMessage[] {
    return [...this.#recent];
  }

  send(message: EmailMessage): Promise<void> {
    if (this.#keep > 0) {
      this.#recent.push(message);
      if (this.#recent.length > this.#keep) this.#recent.shift();
    }
    this.#log.info(
      { event: 'email_not_delivered', kind: message.kind, provider: 'console' },
      'email produced but not delivered: no delivery provider is configured',
    );
    if (this.#printLinks) {
      this.#print(
        [
          '----- email (EMAIL_DEV_PRINT_LINKS=true; development only) -----',
          `To: ${message.to}`,
          `Subject: ${message.subject}`,
          '',
          message.text,
          '----- end of email -----',
        ].join('\n'),
      );
    }
    return Promise.resolve();
  }
}

/** Test double: keeps every message, and can be told to fail or to hang. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];
  /** When set, `send` rejects with this error (after recording nothing). */
  failWith: Error | undefined;
  /** When true, `send` records the message and never settles. */
  hang = false;

  send(message: EmailMessage): Promise<void> {
    if (this.failWith !== undefined) return Promise.reject(this.failWith);
    this.sent.push(message);
    if (this.hang) return new Promise<void>(() => undefined);
    return Promise.resolve();
  }

  to(address: string): EmailMessage[] {
    const wanted = address.toLowerCase();
    return this.sent.filter((message) => message.to.toLowerCase() === wanted);
  }

  /** The newest message of a kind sent to an address; throws when there is none. */
  last(address: string, kind: EmailKind): EmailMessage {
    const message = this.to(address).findLast((candidate) => candidate.kind === kind);
    if (message === undefined) throw new Error(`no ${kind} email was sent to that address`);
    return message;
  }

  clear(): void {
    this.sent.length = 0;
  }
}
