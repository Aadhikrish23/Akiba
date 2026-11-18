import { z } from 'zod';

/**
 * Contracts shared by every endpoint: the error document (doc 07 §1) and the operational probes
 * (doc 07 §7). Clients validate what they receive with these, so an API change that breaks the
 * contract fails at the edge instead of deep inside a screen.
 */

/** One field-level validation failure inside a problem document. */
export const fieldErrorSchema = z.object({
  path: z.string(),
  message: z.string(),
});
export type FieldError = z.infer<typeof fieldErrorSchema>;

/**
 * RFC 9457 problem document with Akiba's extension members. Loose on purpose: clients must ignore
 * members they do not know (doc 07 §9), so unknown ones pass through untouched.
 */
export const problemDocumentSchema = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string(),
  detail: z.string(),
  errors: z.array(fieldErrorSchema).optional(),
  requestId: z.string().optional(),
});
export type ProblemDocument = z.infer<typeof problemDocumentSchema>;

/** `GET /health`: liveness. Touches no dependency. */
export const healthResponseSchema = z.object({ status: z.literal('ok') });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/** What one readiness check can report. `not_configured` means there is nothing to probe. */
export const readinessCheckSchema = z.enum(['ok', 'degraded', 'not_configured']);
export type ReadinessCheck = z.infer<typeof readinessCheckSchema>;

/** `GET /ready` when every dependency answers (otherwise a 503 problem document). */
export const readyResponseSchema = z.object({
  status: z.literal('ready'),
  checks: z.looseObject({
    database: readinessCheckSchema,
    sources: readinessCheckSchema,
  }),
});
export type ReadyResponse = z.infer<typeof readyResponseSchema>;
