import { describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import { createAdminApp, requireUnscoped, type AdminEnv } from './admin-env.js';
import { PermissionDeniedError } from '../secrets/rbac.js';
import { SecretScopeExistsError, SecretScopeNotFoundError } from '../secrets/pg-secret-store.js';

const PARENT_BODY = { error: 'parent' };

function mount(thrower: () => unknown, opts?: { logBeforeHandling?: string }) {
  const logger = { error: vi.fn() };
  const sub = createAdminApp(logger, opts);
  sub.get('/x', () => {
    throw thrower();
  });
  const parent = new Hono();
  // The parent's own handler must NOT be what answers an admin error.
  parent.onError((_e, c) => c.json(PARENT_BODY, 500));
  parent.route('/api/v1/admin', sub);
  return { parent, logger };
}

describe('createAdminApp onError', () => {
  // Control: a plain sub-app with no handler of its own falls through to the parent, so the
  // assertions below can tell the two handlers apart.
  it('a plain Hono sub-app is answered by the parent handler', async () => {
    const sub = new Hono();
    sub.get('/x', () => {
      throw new PermissionDeniedError('auditor', 'secret.write');
    });
    const parent = new Hono();
    parent.onError((_e, c) => c.json(PARENT_BODY, 500));
    parent.route('/api/v1/admin', sub);
    const res = await parent.request('/api/v1/admin/x');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual(PARENT_BODY);
  });

  // fails-when: errors bubble to the parent handler (every case becomes the parent's 500 body)
  it.each([
    [
      'PermissionDeniedError',
      () => new PermissionDeniedError('auditor', 'secret.write'),
      403,
      {
        error: 'Role "auditor" does not have permission "secret.write"',
      },
    ],
    [
      'SecretScopeNotFoundError',
      () => new SecretScopeNotFoundError('s'),
      404,
      {
        error: "Secret scope 's' not found",
      },
    ],
    [
      'SecretScopeExistsError',
      () => new SecretScopeExistsError('s'),
      409,
      {
        error: "Secret scope 's' already exists",
      },
    ],
    [
      'pg 23505',
      () => Object.assign(new Error('dup'), { code: '23505' }),
      409,
      {
        error: 'Conflict: resource already exists',
      },
    ],
    [
      'pg 22P02',
      () => Object.assign(new Error('bad'), { code: '22P02' }),
      400,
      {
        error: 'Invalid request: malformed value for a typed field',
      },
    ],
    [
      // A real parse failure: zod 4's thrown error is an Error subclass, which is what
      // Hono's compose hands to onError (a bare `new z.ZodError()` is not).
      'ZodError',
      () => z.string().safeParse(1).error,
      400,
      {
        error: 'Validation error',
        details: [expect.objectContaining({ code: 'invalid_type', path: [] })],
      },
    ],
    ['generic Error', () => new Error('boom'), 500, { error: 'Internal server error' }],
  ])('maps %s to its admin status and body', async (_name, thrower, status, body) => {
    const { parent } = mount(thrower);
    const res = await parent.request('/api/v1/admin/x');
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
  });

  // breaks-if-wrong: a deliberate HTTPException (bodyLimit's 413) must keep its own response
  it('passes an HTTPException through unchanged', async () => {
    const { parent, logger } = mount(() => new HTTPException(413, { message: 'too big' }));
    const res = await parent.request('/api/v1/admin/x');
    expect(res.status).toBe(413);
    expect(await res.text()).toBe('too big');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs an unmapped error at error level', async () => {
    const { parent, logger } = mount(() => new Error('boom'));
    await parent.request('/api/v1/admin/x');
    expect(logger.error).toHaveBeenCalledWith('Admin API error', expect.anything());
  });

  it('logs every error under logBeforeHandling before mapping it', async () => {
    const { parent, logger } = mount(() => new SecretScopeNotFoundError('s'), {
      logBeforeHandling: 'admin-x route failed',
    });
    const res = await parent.request('/api/v1/admin/x');
    expect(res.status).toBe(404);
    expect(logger.error).toHaveBeenCalledWith('admin-x route failed', {
      error: "Secret scope 's' not found",
    });
  });

  it('answers errors thrown by middleware the sub-app registers', async () => {
    const sub = createAdminApp({ error: vi.fn() });
    sub.use('/y', () => {
      throw new PermissionDeniedError('auditor', 'secret.read');
    });
    sub.get('/y', (c) => c.json({ ok: true }));
    const parent = new Hono();
    parent.onError((_e, c) => c.json(PARENT_BODY, 500));
    parent.route('/api/v1/admin', sub);
    const res = await parent.request('/api/v1/admin/y');
    expect(res.status).toBe(403);
  });
});

describe('requireUnscoped', () => {
  function guarded(routingKey: string | null) {
    const app = new Hono<AdminEnv>();
    app.use('*', async (c, next) => {
      c.set('routingKey', routingKey);
      await next();
    });
    app.get('/z', requireUnscoped, (c) => c.json({ ok: true }));
    return app;
  }

  // fails-when: a routing-key-scoped token reaches the handler
  it('refuses a routing-key-scoped token with 403', async () => {
    const res = await guarded('github:1').request('/z');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /requires an unscoped admin token/,
    );
  });

  // breaks-if-wrong: an unscoped token must still reach the handler
  it('lets an unscoped token through', async () => {
    const res = await guarded(null).request('/z');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});
