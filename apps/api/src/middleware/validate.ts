import type { RequestHandler, Response } from 'express';
import type { z } from 'zod';
import { validationFailed, type FieldError } from '../lib/errors.js';

/**
 * Schemas for the parts of a request a route accepts. Write routes should use `z.strictObject`
 * for the body so unknown fields are rejected (doc 09 §4).
 */
export interface RequestSchemas {
  readonly body?: z.ZodType;
  readonly query?: z.ZodType;
  readonly params?: z.ZodType;
}

type Output<T> = T extends z.ZodType ? z.output<T> : undefined;

export interface ValidatedRequest<S extends RequestSchemas> {
  readonly body: Output<S['body']>;
  readonly query: Output<S['query']>;
  readonly params: Output<S['params']>;
}

const PARTS = ['params', 'query', 'body'] as const;

function fieldPath(part: (typeof PARTS)[number], path: readonly PropertyKey[]): string {
  const joined = path.map(String).join('.');
  // Body fields are reported bare (`progress`), as in doc 07 §1; other parts are prefixed.
  if (part === 'body') return joined === '' ? 'body' : joined;
  return joined === '' ? part : `${part}.${joined}`;
}

/**
 * Validate params, query and body against Zod schemas. On success the parsed (coerced, stripped)
 * values are available through {@link getValidated}; on failure every issue from every part is
 * returned in one 422 problem document.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, res, next) => {
    const errors: FieldError[] = [];
    const parsed: Record<string, unknown> = {};
    for (const part of PARTS) {
      const schema = schemas[part];
      if (!schema) continue;
      const result = schema.safeParse(req[part]);
      if (result.success) {
        parsed[part] = result.data;
      } else {
        for (const issue of result.error.issues) {
          errors.push({ path: fieldPath(part, issue.path), message: issue.message });
        }
      }
    }
    if (errors.length > 0) {
      next(validationFailed(errors));
      return;
    }
    res.locals.validated = parsed;
    next();
  };
}

/**
 * Read what {@link validate} parsed. Pass the same schemas object so the result is typed from it;
 * handlers should use this instead of `req.body`/`req.query`, which stay unvalidated.
 */
export function getValidated<S extends RequestSchemas>(
  res: Response,
  schemas: S,
): ValidatedRequest<S>;
export function getValidated(res: Response): unknown {
  const validated: unknown = res.locals.validated;
  if (validated === undefined) {
    throw new Error('getValidated() called on a route without the validate() middleware');
  }
  return validated;
}
