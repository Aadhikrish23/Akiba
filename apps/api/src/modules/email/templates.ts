import { APP_NAME } from '@akiba/shared';
import type { EmailMessage } from './emailSender.js';

/**
 * Every email the API sends. Plain text plus minimal HTML with the same words; no images, no
 * remote content, no tracking pixels, no link-wrapping (doc 09 §7). The only links are to the
 * web app at the configured base URL.
 *
 * A one-time token travels in the URL FRAGMENT (`#token=…`): browsers do not send fragments to
 * servers, so the token stays out of access logs, proxies and `Referer` headers. The page reads
 * it with script and posts it to the API.
 */

export interface Recipient {
  readonly email: string;
  readonly displayName: string | null;
}

/** Paths in the web app that the links point to (implemented by the web shell, T10). */
export const WEB_PATHS = {
  verifyEmail: '/verify-email',
  resetPassword: '/reset-password',
  forgotPassword: '/forgot-password',
  login: '/login',
} as const;

export function webLink(webBaseUrl: string, path: string, token?: string): string {
  const url = new URL(path, webBaseUrl);
  if (token !== undefined) url.hash = `token=${encodeURIComponent(token)}`;
  return url.toString();
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character] ?? character);
}

/** A display name is user input: strip line breaks and control characters before using it. */
function greetingName(recipient: Recipient): string {
  // eslint-disable-next-line no-control-regex
  const name = (recipient.displayName ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return name === '' ? 'there' : name;
}

interface Content {
  readonly subject: string;
  /** Paragraphs of plain text. */
  readonly paragraphs: readonly string[];
  /** A link shown on its own line after the first paragraph. */
  readonly link?: string;
}

function build(kind: EmailMessage['kind'], recipient: Recipient, content: Content): EmailMessage {
  const [first, ...rest] = content.paragraphs;
  const greeting = `Hi ${greetingName(recipient)},`;
  const signature = `${APP_NAME}`;
  const textParts = [greeting, first ?? ''];
  if (content.link !== undefined) textParts.push(content.link);
  textParts.push(...rest, signature);

  const paragraph = (value: string): string => `<p>${escapeHtml(value)}</p>`;
  const htmlParts = [paragraph(greeting), paragraph(first ?? '')];
  if (content.link !== undefined) {
    const link = escapeHtml(content.link);
    htmlParts.push(`<p><a href="${link}">${link}</a></p>`);
  }
  htmlParts.push(...rest.map(paragraph), paragraph(signature));

  return {
    kind,
    to: recipient.email,
    subject: content.subject,
    text: `${textParts.join('\n\n')}\n`,
    html: `<!doctype html><html lang="en"><body>${htmlParts.join('')}</body></html>`,
  };
}

export interface TemplateOptions {
  /** Origin of the web app, e.g. `https://app.example.com`. */
  readonly webBaseUrl: string;
}

export interface EmailTemplates {
  verifyEmail(recipient: Recipient, token: string): EmailMessage;
  resetPassword(recipient: Recipient, token: string): EmailMessage;
  /** Someone tried to register an address that already has an account. Contains no token. */
  registrationAttempt(recipient: Recipient): EmailMessage;
  passwordChanged(recipient: Recipient): EmailMessage;
  /** Sent to the OLD address when the email changes (S-AUTH-11). Not used before the settings task. */
  emailChanged(recipient: Recipient): EmailMessage;
  /** A sign-in provider was linked to or unlinked from the account (S-AUTH-11 in spirit). */
  signInMethodChanged(
    recipient: Recipient,
    change: { readonly provider: 'google' | 'apple'; readonly action: 'linked' | 'unlinked' },
  ): EmailMessage;
}

export function createEmailTemplates(options: TemplateOptions): EmailTemplates {
  const link = (path: string, token?: string): string => webLink(options.webBaseUrl, path, token);

  return {
    verifyEmail: (recipient, token) =>
      build('verify_email', recipient, {
        subject: `Confirm your email address for ${APP_NAME}`,
        paragraphs: [
          `Confirm that this is your email address to finish setting up your ${APP_NAME} account. Open this link:`,
          'The link works once and expires in 24 hours.',
          `If you did not create an ${APP_NAME} account, do not open the link. You can ignore this email.`,
        ],
        link: link(WEB_PATHS.verifyEmail, token),
      }),

    resetPassword: (recipient, token) =>
      build('reset_password', recipient, {
        subject: `Reset your ${APP_NAME} password`,
        paragraphs: [
          `We received a request to reset the password of your ${APP_NAME} account. To choose a new password, open this link:`,
          'The link works once and expires in 1 hour. Using it signs you out on every device.',
          'If you did not ask for this, you can ignore this email. Your password stays the same.',
        ],
        link: link(WEB_PATHS.resetPassword, token),
      }),

    registrationAttempt: (recipient) =>
      build('registration_attempt', recipient, {
        subject: `You already have an ${APP_NAME} account`,
        paragraphs: [
          `Someone tried to create an ${APP_NAME} account with this email address, but it already has one. Nothing was changed. If that was you, sign in here:`,
          `If you do not remember your password, you can reset it: ${link(WEB_PATHS.forgotPassword)}`,
          'If that was not you, you do not need to do anything.',
        ],
        link: link(WEB_PATHS.login),
      }),

    passwordChanged: (recipient) =>
      build('password_changed', recipient, {
        subject: `Your ${APP_NAME} password was changed`,
        paragraphs: [
          `The password of your ${APP_NAME} account was just changed. If you did this, you do not need to do anything.`,
          `If you did not change it, reset your password now: ${link(WEB_PATHS.forgotPassword)}`,
        ],
      }),

    emailChanged: (recipient) =>
      build('email_changed', recipient, {
        subject: `The email address of your ${APP_NAME} account was changed`,
        paragraphs: [
          `The email address of your ${APP_NAME} account was just changed, so this address is no longer used for it. If you did this, you do not need to do anything.`,
          'If you did not change it, someone else may have access to your account. Contact support.',
        ],
      }),

    signInMethodChanged: (recipient, change) => {
      const provider = change.provider === 'google' ? 'Google' : 'Apple';
      return build('sign_in_method_changed', recipient, {
        subject:
          change.action === 'linked'
            ? `${provider} sign-in was added to your ${APP_NAME} account`
            : `${provider} sign-in was removed from your ${APP_NAME} account`,
        paragraphs:
          change.action === 'linked'
            ? [
                `Sign-in with ${provider} was just added to your ${APP_NAME} account. If you did this, you do not need to do anything.`,
                `If you did not, someone else may have access to your account. Reset your password now, then remove the ${provider} sign-in in your settings: ${link(WEB_PATHS.forgotPassword)}`,
                `If the account has a password that you did not set yourself, reset it as well.`,
              ]
            : [
                `Sign-in with ${provider} was just removed from your ${APP_NAME} account. If you did this, you do not need to do anything.`,
                `If you did not, someone else may have access to your account. Reset your password now: ${link(WEB_PATHS.forgotPassword)}`,
              ],
      });
    },
  };
}
