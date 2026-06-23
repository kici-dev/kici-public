/**
 * Shared error handler for admin route files.
 *
 * Handles common error types: RBAC permission denied, secret-scope not found
 * (→ 404), Zod validation, PostgreSQL unique constraint violations, PostgreSQL
 * invalid-text-representation (malformed typed input → 400), and generic errors.
 */
import { z } from 'zod';
import { PermissionDeniedError } from '../secrets/rbac.js';
import { SecretScopeNotFoundError } from '../secrets/pg-secret-store.js';
import { toErrorMessage } from '@kici-dev/shared';

export function handleAdminError(
  c: any,
  err: unknown,
  logger: { error: (msg: string, meta?: Record<string, unknown>) => void },
) {
  if (err instanceof PermissionDeniedError) {
    return c.json({ error: err.message }, 403);
  }
  // A rename/lookup against a scope that doesn't exist is a clean client-side
  // not-found, not a server fault → 404 (and never logged at error level).
  if (err instanceof SecretScopeNotFoundError) {
    return c.json({ error: err.message }, 404);
  }
  if (err instanceof z.ZodError) {
    return c.json({ error: 'Validation error', details: err.issues }, 400);
  }
  // PostgreSQL unique constraint violation → 409 Conflict
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
    return c.json({ error: 'Conflict: resource already exists' }, 409);
  }
  // PostgreSQL invalid text representation (e.g. a malformed UUID/integer path
  // param or body value) → 400 Bad Request. The client sent a value the column
  // type cannot parse; this is bad input, not a server fault, so it must not be
  // logged at error level (would pollute error dashboards/alerts).
  if (err instanceof Error && 'code' in err && (err as { code: string }).code === '22P02') {
    return c.json({ error: 'Invalid request: malformed value for a typed field' }, 400);
  }
  logger.error('Admin API error', {
    error: toErrorMessage(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  return c.json({ error: 'Internal server error' }, 500);
}
