import { z } from 'zod';

/**
 * Request/response contracts of the auth endpoints (doc 07 §2). The API validates with these and
 * clients build on them (T7 extends this file; T4 added only what the API needs).
 */

/** Password policy bounds (doc 09 S-AUTH-2). Length is counted in Unicode code points. */
export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;
export const DISPLAY_NAME_MAX_LENGTH = 50;
/** RFC 5321 limit for a mailbox path. */
export const EMAIL_MAX_LENGTH = 254;

/**
 * Header naming the client (doc 07 §9): `web/<version>`, `desktop/<version>` or
 * `mobile/<version>`; the version is optional. It selects the refresh-token transport
 * (doc 09 S-AUTH-7/8): web and desktop use an HttpOnly cookie, mobile uses the JSON body.
 */
export const CLIENT_HEADER = 'X-Client';
export const CLIENT_HEADER_PATTERN = /^(web|desktop|mobile)(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,31})?$/;

const codePoints = (value: string): number => [...value].length;

export const emailSchema = z
  .string()
  .trim()
  .max(EMAIL_MAX_LENGTH, `must be at most ${EMAIL_MAX_LENGTH} characters`)
  .pipe(z.email('must be a valid email address'));

/**
 * A NEW password (register, later reset/change). No composition rules, no trimming and no
 * truncation: what the user typed is what is hashed. The breached-password check runs on the
 * server and is not part of this schema.
 */
export const newPasswordSchema = z
  .string()
  .refine((value) => codePoints(value) >= PASSWORD_MIN_LENGTH, {
    error: `must be at least ${PASSWORD_MIN_LENGTH} characters`,
  })
  .refine((value) => codePoints(value) <= PASSWORD_MAX_LENGTH, {
    error: `must be at most ${PASSWORD_MAX_LENGTH} characters`,
  });

/**
 * A password presented at login. Deliberately NOT the policy schema: an account whose password
 * predates a policy change must still be able to sign in, and a policy error here would tell an
 * attacker something. The cap only bounds the work done per request.
 */
export const presentedPasswordSchema = z.string().min(1, 'is required').max(1024, 'is too long');

export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'is required')
  .max(DISPLAY_NAME_MAX_LENGTH, `must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`);

export const registerRequestSchema = z.strictObject({
  email: emailSchema,
  password: newPasswordSchema,
  displayName: displayNameSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * Registration always answers the same way, whether or not the address already had an account
 * (no user enumeration); the next step reaches the user by email.
 */
export const registerResponseSchema = z.object({
  status: z.literal('verification_pending'),
});
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: presentedPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** Opaque refresh token as issued by the API: 32 random bytes, base64url. */
export const refreshTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'is not a refresh token');

/**
 * Body of `/auth/refresh` and `/auth/logout`. Mobile clients send the refresh token here; web and
 * desktop clients send no body (or `{}`) because theirs travels in the cookie.
 */
export const refreshRequestSchema = z
  .strictObject({ refreshToken: z.string().min(1).max(512).optional() })
  .optional();
export type RefreshRequest = z.infer<typeof refreshRequestSchema>;
export const logoutRequestSchema = refreshRequestSchema;
export type LogoutRequest = RefreshRequest;

export const authUserSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  displayName: z.string().nullable(),
  emailVerified: z.boolean(),
});
export type AuthUser = z.infer<typeof authUserSchema>;

const accessTokenFields = {
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
  /** Lifetime of the access token in seconds. */
  expiresIn: z.number().int().positive(),
  /** Present only for mobile clients; web and desktop receive it as an HttpOnly cookie. */
  refreshToken: refreshTokenSchema.optional(),
};

export const loginResponseSchema = z.object({ ...accessTokenFields, user: authUserSchema });
export type LoginResponse = z.infer<typeof loginResponseSchema>;

export const refreshResponseSchema = z.object(accessTokenFields);
export type RefreshResponse = z.infer<typeof refreshResponseSchema>;


/**
 * A one-time token from an emailed link (verify email, reset password). Deliberately loose: a
 * token of the wrong shape gets the same "invalid or expired" answer as a wrong one, not a
 * validation error that describes the real format.
 */
export const oneTimeTokenSchema = z.string().min(1, 'is required').max(512, 'is too long');

export const verifyEmailRequestSchema = z.strictObject({ token: oneTimeTokenSchema });
export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const verifyEmailResponseSchema = z.object({ status: z.literal('verified') });
export type VerifyEmailResponse = z.infer<typeof verifyEmailResponseSchema>;

export const forgotPasswordRequestSchema = z.strictObject({ email: emailSchema });
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/**
 * The answer to every request that may or may not lead to an email (forgot password, resend
 * verification). It is the same whatever happened, so it says nothing about the account.
 */
export const acceptedResponseSchema = z.object({ status: z.literal('accepted') });
export type AcceptedResponse = z.infer<typeof acceptedResponseSchema>;

export const resetPasswordRequestSchema = z.strictObject({
  token: oneTimeTokenSchema,
  newPassword: newPasswordSchema,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const resetPasswordResponseSchema = z.object({ status: z.literal('password_reset') });
export type ResetPasswordResponse = z.infer<typeof resetPasswordResponseSchema>;

export const changePasswordRequestSchema = z.strictObject({
  currentPassword: presentedPasswordSchema,
  newPassword: newPasswordSchema,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
