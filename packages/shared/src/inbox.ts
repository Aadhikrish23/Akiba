import { z } from 'zod';
import { titleCardSchema } from './titles.js';

/** T23: the Inbox (doc 07 §5, FR-NOTE-001…005). Notifications live in the app only: no push, no email. */

export const NOTIFICATION_KINDS = ['episode_aired'] as const;
export const notificationKindSchema = z.enum(NOTIFICATION_KINDS);
export type NotificationKind = z.infer<typeof notificationKindSchema>;

export const notificationSchema = z.object({
  id: z.uuid(),
  kind: notificationKindSchema,
  createdAt: z.iso.datetime(),
  /** Null while unread. */
  readAt: z.iso.datetime().nullable(),
  /** The episode that aired, and when. */
  episode: z.object({ number: z.number().int(), airsAt: z.iso.datetime() }),
  title: titleCardSchema,
});
export type Notification = z.infer<typeof notificationSchema>;

export const inboxQuerySchema = z.strictObject({
  /** `unread=true` lists only what has not been read. */
  unread: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(512).optional(),
});
export type InboxQuery = z.infer<typeof inboxQuerySchema>;

export const inboxListResponseSchema = z.object({
  data: z.array(notificationSchema),
  nextCursor: z.string().nullable(),
});
export type InboxListResponse = z.infer<typeof inboxListResponseSchema>;

export const unreadCountResponseSchema = z.object({ data: z.object({ count: z.number().int() }) });
export type UnreadCountResponse = z.infer<typeof unreadCountResponseSchema>;

export const notificationResponseSchema = z.object({ data: notificationSchema });
export type NotificationResponse = z.infer<typeof notificationResponseSchema>;

export const readAllResponseSchema = z.object({ data: z.object({ updated: z.number().int() }) });
export type ReadAllResponse = z.infer<typeof readAllResponseSchema>;
