import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { AUTH_ERROR, createBearerAuthMiddleware, resolveBearerAuth } from './admin-auth.js';

/** A validator that resolves `null` for everything except the one good token. */
function fakeValidator(goodToken: string) {
  return {
    validate: vi.fn(async (token: string) =>
      token === goodToken
        ? { id: 'user-1', role: 'admin' as const, routingKey: null, label: 'test' }
        : null,
    ),
  };
}

/** Mount the middleware on a throwaway app with one protected route. */
function appWith(deps: Parameters<typeof createBearerAuthMiddleware>[0]) {
  const app = new Hono();
  app.use('/protected', createBearerAuthMiddleware(deps));
  app.get('/protected', (c) =>
    c.json({ ok: true, role: c.get('role'), userId: c.get('userId') }, 200),
  );
  return app;
}

describe('createBearerAuthMiddleware -- credential shapes stay 401', () => {
  // The nine shapes probed against deployed staging on 2026-08-04. Every one
  // returned 401 then; every one must still return 401 (never 500, never 503).
  const cases: Array<{ name: string; header?: string; body: string }> = [
    { name: 'header absent', header: undefined, body: AUTH_ERROR.missing },
    { name: 'Bearer with empty token', header: 'Bearer ', body: AUTH_ERROR.missing },
    { name: 'Bearer with no trailing space', header: 'Bearer', body: AUTH_ERROR.missing },
    { name: 'wrong scheme', header: 'Basic abc', body: AUTH_ERROR.missing },
    { name: 'unknown token', header: 'Bearer nope-not-a-token', body: AUTH_ERROR.invalid },
    { name: '8000-char token', header: `Bearer ${'a'.repeat(8000)}`, body: AUTH_ERROR.invalid },
    { name: 'unicode token', header: 'Bearer tokén-ünïcødé', body: AUTH_ERROR.invalid },
    { name: 'sql-injection shape', header: "Bearer ' OR 1=1--", body: AUTH_ERROR.invalid },
    { name: 'percent-encoded nul/traversal', header: 'Bearer %00%2e%2e', body: AUTH_ERROR.invalid },
  ];

  for (const tc of cases) {
    it(`${tc.name} -> 401 ${tc.body}`, async () => {
      const app = appWith({ tokenManager: fakeValidator('good'), scope: 'test' });
      const res = await app.request(
        '/protected',
        tc.header === undefined ? {} : { headers: { Authorization: tc.header } },
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: tc.body });
    });
  }

  it('a valid token passes through and sets the context variables', async () => {
    const app = appWith({ tokenManager: fakeValidator('good'), scope: 'test' });
    const res = await app.request('/protected', { headers: { Authorization: 'Bearer good' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: 'admin', userId: 'user-1' });
  });
});

describe('createBearerAuthMiddleware -- validation failure is 503, not 500', () => {
  it('a throwing validate returns a structured 503 and logs at error level', async () => {
    const logger = { error: vi.fn() };
    const app = appWith({
      tokenManager: {
        validate: vi.fn(async () => {
          throw new Error('connection terminated unexpectedly');
        }),
      },
      scope: 'test-scope',
      logger,
    });

    const res = await app.request('/protected', {
      headers: { Authorization: 'Bearer some-real-looking-token' },
    });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: AUTH_ERROR.unavailable });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.error.mock.calls[0]!;
    expect(msg).toBe('Admin auth validation failed');
    expect(meta).toMatchObject({ scope: 'test-scope', method: 'GET', path: '/protected' });
    expect(String(meta!.error)).toContain('connection terminated unexpectedly');
  });

  it('a rejected promise (not a thrown Error) is handled the same way', async () => {
    const logger = { error: vi.fn() };
    const app = appWith({
      tokenManager: { validate: vi.fn(() => Promise.reject(new Error('pool exhausted'))) },
      scope: 'test-scope',
      logger,
    });
    const res = await app.request('/protected', { headers: { Authorization: 'Bearer t' } });
    expect(res.status).toBe(503);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('fails closed -- a validation failure never reaches the protected handler', async () => {
    const handler = vi.fn((c: any) => c.json({ ok: true }, 200));
    const app = new Hono();
    app.use(
      '/protected',
      createBearerAuthMiddleware({
        tokenManager: {
          validate: vi.fn(async () => {
            throw new Error('DB down');
          }),
        },
        scope: 'test-scope',
        logger: { error: vi.fn() },
      }),
    );
    app.get('/protected', handler);

    const res = await app.request('/protected', { headers: { Authorization: 'Bearer t' } });

    expect(res.status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('createBearerAuthMiddleware -- the presented token never reaches the logs', () => {
  it('no part of the credential appears in the emitted log output', async () => {
    const SENTINEL = 'kici-sentinel-credential-8f3a2b1c9d4e';
    const logger = { error: vi.fn() };
    const app = appWith({
      tokenManager: {
        validate: vi.fn(async () => {
          throw new Error('DB down');
        }),
      },
      scope: 'test-scope',
      logger,
    });

    await app.request('/protected', { headers: { Authorization: `Bearer ${SENTINEL}` } });

    // Serialize the whole call -- message AND metadata -- and assert the token
    // is absent, including any prefix long enough to correlate.
    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(SENTINEL.slice(0, 12));
    expect(serialized).not.toContain('Bearer');
  });
});

describe('resolveBearerAuth -- the inline form used by the run-cancel route', () => {
  /** Drive resolveBearerAuth through a real Hono context. */
  async function resolveVia(
    deps: Parameters<typeof resolveBearerAuth>[1],
    header?: string,
  ): Promise<unknown> {
    let outcome: unknown;
    const app = new Hono();
    app.get('/x', async (c) => {
      outcome = await resolveBearerAuth(c, deps);
      return c.json({}, 200);
    });
    await app.request('/x', header === undefined ? {} : { headers: { Authorization: header } });
    return outcome;
  }

  it('returns the token info for a valid credential', async () => {
    const outcome = await resolveVia(
      { tokenManager: fakeValidator('good'), scope: 'app-admin' },
      'Bearer good',
    );
    expect(outcome).toEqual({
      ok: true,
      tokenInfo: { id: 'user-1', role: 'admin', routingKey: null, label: 'test' },
    });
  });

  it('returns a 401 outcome for an absent header and for an unknown token', async () => {
    const deps = { tokenManager: fakeValidator('good'), scope: 'app-admin' };
    expect(await resolveVia(deps, undefined)).toEqual({
      ok: false,
      status: 401,
      error: AUTH_ERROR.missing,
    });
    expect(await resolveVia(deps, 'Bearer nope')).toEqual({
      ok: false,
      status: 401,
      error: AUTH_ERROR.invalid,
    });
  });

  it('returns a 503 outcome -- never a success -- when validation cannot complete', async () => {
    const outcome = await resolveVia(
      {
        tokenManager: {
          validate: vi.fn(async () => {
            throw new Error('pool exhausted');
          }),
        },
        scope: 'app-admin',
        logger: { error: vi.fn() },
      },
      'Bearer t',
    );
    expect(outcome).toEqual({ ok: false, status: 503, error: AUTH_ERROR.unavailable });
  });
});
