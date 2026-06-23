import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { handleAdminError } from './admin-errors.js';
import { PermissionDeniedError } from '../secrets/rbac.js';
import { SecretScopeNotFoundError } from '../secrets/pg-secret-store.js';

/** Minimal Hono-context stub: records the (body, status) passed to c.json. */
function makeCtx() {
  const calls: Array<{ body: unknown; status: number }> = [];
  const c = {
    json: (body: unknown, status: number) => {
      calls.push({ body, status });
      return { body, status };
    },
  };
  return { c, calls };
}

function makeLogger() {
  return { error: vi.fn() };
}

describe('handleAdminError', () => {
  it('maps a PostgreSQL 22P02 (invalid_text_representation) error to 400 without logging at error level', () => {
    const { c, calls } = makeCtx();
    const logger = makeLogger();
    const err = Object.assign(new Error('invalid input syntax for type uuid: "not-a-uuid"'), {
      code: '22P02',
    });

    handleAdminError(c as never, err, logger);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe(400);
    expect(calls[0]!.body).toEqual({ error: 'Invalid request: malformed value for a typed field' });
    // A client error must NOT pollute error logs/alerts.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('maps a PermissionDeniedError to 403', () => {
    const { c, calls } = makeCtx();
    handleAdminError(c as never, new PermissionDeniedError('admin', 'context.read'), makeLogger());
    expect(calls[0]!.status).toBe(403);
  });

  it('maps a SecretScopeNotFoundError to 404 without logging at error level', () => {
    const { c, calls } = makeCtx();
    const logger = makeLogger();
    handleAdminError(c as never, new SecretScopeNotFoundError('does-not-exist'), logger);
    expect(calls[0]!.status).toBe(404);
    expect(calls[0]!.body).toEqual({ error: "Secret scope 'does-not-exist' not found" });
    // A not-found is a client error, not a server fault.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('maps a ZodError to 400 with details', () => {
    const { c, calls } = makeCtx();
    const zodErr = z.string().uuid().safeParse('nope');
    expect(zodErr.success).toBe(false);
    handleAdminError(c as never, (zodErr as { error: z.ZodError }).error, makeLogger());
    expect(calls[0]!.status).toBe(400);
    expect((calls[0]!.body as { details?: unknown }).details).toBeDefined();
  });

  it('maps a PostgreSQL 23505 (unique violation) to 409', () => {
    const { c, calls } = makeCtx();
    const err = Object.assign(new Error('duplicate key'), { code: '23505' });
    handleAdminError(c as never, err, makeLogger());
    expect(calls[0]!.status).toBe(409);
  });

  it('falls through to 500 and logs at error level for an unrecognized error', () => {
    const { c, calls } = makeCtx();
    const logger = makeLogger();
    handleAdminError(c as never, new Error('kaboom'), logger);
    expect(calls[0]!.status).toBe(500);
    expect(logger.error).toHaveBeenCalledOnce();
  });
});
