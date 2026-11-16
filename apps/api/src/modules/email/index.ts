import type { AppConfig } from '../../config/env.js';
import type { Logger } from '../../lib/logger.js';
import { ConsoleEmailSender, type EmailSender } from './emailSender.js';

export {
  ConsoleEmailSender,
  MemoryEmailSender,
  type EmailKind,
  type EmailMessage,
  type EmailSender,
} from './emailSender.js';
export { createEmailTemplates, type EmailTemplates, type Recipient } from './templates.js';

/** Messages the console sender keeps in memory outside production (for local inspection). */
const DEV_KEEP = 20;

/**
 * Pick the sender named by `EMAIL_PROVIDER`. `console` is the only provider today (the real one
 * is an open decision), and the environment loader has already refused any other name; the
 * `default` branch is the same refusal for a provider that is added to the config but not here.
 */
export function createEmailSender(config: AppConfig, logger: Logger): EmailSender {
  const provider: string = config.email.provider;
  switch (provider) {
    case 'console': {
      if (config.nodeEnv === 'production') {
        logger.warn(
          'EMAIL_PROVIDER=console: emails are NOT delivered (verification and password-reset ' +
            'links reach nobody). Configure a real provider before real users sign up.',
        );
      }
      return new ConsoleEmailSender({
        logger,
        printLinks: config.email.devPrintLinks,
        keep: config.nodeEnv === 'production' ? 0 : DEV_KEEP,
      });
    }
    default:
      throw new Error(`EMAIL_PROVIDER names an email provider that is not implemented`);
  }
}
