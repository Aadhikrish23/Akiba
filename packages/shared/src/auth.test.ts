import { describe, expect, it } from 'vitest';
import {
  changePasswordRequestSchema,
  CLIENT_HEADER_PATTERN,
  forgotPasswordRequestSchema,
  loginRequestSchema,
  newPasswordSchema,
  refreshRequestSchema,
  refreshTokenSchema,
  registerRequestSchema,
  resetPasswordRequestSchema,
  verifyEmailRequestSchema,
} from './auth.js';

describe('auth DTOs', () => {
  const valid = { email: 'ada@example.test', password: 'correct horse', displayName: 'Ada' };

  it('S-AUTH-2: accepts 10 to 128 characters with no composition rules', () => {
    expect(newPasswordSchema.safeParse('a'.repeat(10)).success).toBe(true);
    expect(newPasswordSchema.safeParse('a'.repeat(128)).success).toBe(true);
    expect(newPasswordSchema.safeParse('          ').success).toBe(true);
    expect(newPasswordSchema.safeParse('a'.repeat(9)).success).toBe(false);
    expect(newPasswordSchema.safeParse('a'.repeat(129)).success).toBe(false);
  });

  it('S-AUTH-2: counts code points, not UTF-16 units, and does not trim', () => {
    // Ten emoji are 20 UTF-16 units but 10 characters.
    expect(newPasswordSchema.safeParse('😀'.repeat(10)).success).toBe(true);
    expect(newPasswordSchema.safeParse('😀'.repeat(9)).success).toBe(false);
    expect(newPasswordSchema.safeParse('😀'.repeat(128)).success).toBe(true);
    expect(newPasswordSchema.parse('  padded pw  ')).toBe('  padded pw  ');
  });

  it('register: trims email and display name, rejects unknown fields', () => {
    const parsed = registerRequestSchema.parse({
      ...valid,
      email: '  ada@example.test ',
      displayName: ' Ada ',
    });
    expect(parsed).toEqual(valid);
    expect(registerRequestSchema.safeParse({ ...valid, role: 'admin' }).success).toBe(false);
    expect(registerRequestSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(
      false,
    );
    expect(registerRequestSchema.safeParse({ ...valid, displayName: '   ' }).success).toBe(false);
  });

  it('login: does not apply the password policy', () => {
    expect(loginRequestSchema.safeParse({ email: valid.email, password: 'short' }).success).toBe(
      true,
    );
    expect(loginRequestSchema.safeParse({ email: valid.email, password: '' }).success).toBe(false);
  });

  it('refresh body is optional and strict', () => {
    expect(refreshRequestSchema.safeParse(undefined).success).toBe(true);
    expect(refreshRequestSchema.safeParse({}).success).toBe(true);
    expect(refreshRequestSchema.safeParse({ refreshToken: 'x', other: 1 }).success).toBe(false);
  });

  it('recognises issued refresh tokens and client headers', () => {
    expect(refreshTokenSchema.safeParse('A'.repeat(43)).success).toBe(true);
    expect(refreshTokenSchema.safeParse('A'.repeat(42)).success).toBe(false);
    for (const ok of ['web', 'web/1.2.3', 'mobile/0.1.0', 'desktop']) {
      expect(CLIENT_HEADER_PATTERN.test(ok)).toBe(true);
    }
    for (const bad of ['', 'mobile/', 'tv/1', 'web/1 2', 'Mobile/1', 'mobile/1\n']) {
      expect(CLIENT_HEADER_PATTERN.test(bad)).toBe(false);
    }
  });

  it('FR-AUTH-005/006: one-time-token bodies are strict and do not describe the token format', () => {
    expect(verifyEmailRequestSchema.safeParse({ token: 'anything at all' }).success).toBe(true);
    expect(verifyEmailRequestSchema.safeParse({ token: '' }).success).toBe(false);
    expect(verifyEmailRequestSchema.safeParse({ token: 'x'.repeat(513) }).success).toBe(false);
    expect(verifyEmailRequestSchema.safeParse({ token: 'x', userId: 'y' }).success).toBe(false);
    expect(forgotPasswordRequestSchema.parse({ email: ' ada@example.test ' })).toEqual({
      email: 'ada@example.test',
    });
    expect(forgotPasswordRequestSchema.safeParse({ email: 'nope' }).success).toBe(false);
  });

  it('S-AUTH-2: reset and change apply the new-password policy; the current password is not policed', () => {
    const token = 'x'.repeat(43);
    expect(
      resetPasswordRequestSchema.safeParse({ token, newPassword: 'long enough pw' }).success,
    ).toBe(true);
    expect(resetPasswordRequestSchema.safeParse({ token, newPassword: 'short' }).success).toBe(
      false,
    );
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'old',
        newPassword: 'long enough pw',
      }).success,
    ).toBe(true);
    expect(
      changePasswordRequestSchema.safeParse({ currentPassword: '', newPassword: 'long enough pw' })
        .success,
    ).toBe(false);
    expect(
      changePasswordRequestSchema.safeParse({
        currentPassword: 'old',
        newPassword: 'long enough pw',
        userId: 'someone-else',
      }).success,
    ).toBe(false);
  });
});
