import { ApiError, NetworkError } from './errors.js';

/**
 * Plain-language wording for failed requests, shared by every client (doc 08 §8).
 */

/** What a screen shows for a failed request: one sentence, and the fields the server blamed. */
export interface Described {
  readonly message: string;
  readonly fields: Readonly<Record<string, string>>;
}

const FIELD_LABELS: Readonly<Record<string, string>> = {
  email: 'Email',
  password: 'Password',
  displayName: 'Name',
  newPassword: 'New password',
  currentPassword: 'Current password',
};

export function fieldLabel(path: string): string {
  return FIELD_LABELS[path] ?? path;
}

/**
 * Turn any failure into plain language (doc 08 §8: say what happened and what to do). Server
 * messages are never shown raw, except the field-level validation text, which is written to be read.
 */
export function describeError(error: unknown): Described {
  if (error instanceof ApiError) {
    if (error.status === 422 && error.errors.length > 0) {
      const fields: Record<string, string> = {};
      for (const item of error.errors)
        fields[item.path] ??= `${fieldLabel(item.path)} ${item.message}`;
      return { message: 'Check the highlighted fields.', fields };
    }
    switch (error.code) {
      case 'INVALID_CREDENTIALS':
        return { message: 'The email or password is incorrect.', fields: {} };
      case 'INVALID_TOKEN':
        return {
          message: 'This link is invalid, has expired or was already used. Request a new one.',
          fields: {},
        };
      case 'REAUTHENTICATION_FAILED':
        return { message: 'The current password is incorrect.', fields: {} };
      case 'RATE_LIMITED': {
        const wait = error.retryAfterSeconds;
        return {
          message:
            wait === undefined
              ? 'Too many attempts. Wait a moment and try again.'
              : `Too many attempts. Try again in ${wait} second${wait === 1 ? '' : 's'}.`,
          fields: {},
        };
      }
      default:
        if (error.status >= 500) {
          return {
            message: 'Something went wrong on our side. Try again in a moment.',
            fields: {},
          };
        }
        return { message: 'That did not work. Check what you entered and try again.', fields: {} };
    }
  }
  if (error instanceof NetworkError) {
    return {
      message: 'Cannot reach the server. Check your connection and try again.',
      fields: {},
    };
  }
  return { message: 'Something went wrong. Try again.', fields: {} };
}

/** Field messages from a failed zod parse, in the same shape as server field errors. */
export function describeIssues(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of issues) {
    const path = String(issue.path[0] ?? '');
    if (path !== '') fields[path] ??= `${fieldLabel(path)} ${issue.message}`;
  }
  return fields;
}
