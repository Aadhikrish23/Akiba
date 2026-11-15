/** Product name, used anywhere the app identifies itself. */
export const APP_NAME = 'Akiba';

/** Client platforms the API serves (architecture §2). */
export const PLATFORMS = ['web', 'mobile', 'desktop'] as const;

export type Platform = (typeof PLATFORMS)[number];

/** Narrow an untrusted value to a known {@link Platform}. */
export function isPlatform(value: unknown): value is Platform {
  return typeof value === 'string' && (PLATFORMS as readonly string[]).includes(value);
}
