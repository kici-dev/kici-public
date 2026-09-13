/**
 * Unit tests for the routing-key-scope helpers.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { enforceRoutingKeyScope, requireUnscopedToken } from './routing-key-scope.js';

interface Env {
  Variables: {
    routingKey: string | null;
  };
}

/**
 * Drive the helpers through a real Hono app so the `Context` shape and
 * `c.get('routingKey')` plumbing match production exactly.
 */
function makeApp(opts: { tokenRoutingKey: string | null }) {
  const app = new Hono<Env>();
  app.use('*', async (c, next) => {
    c.set('routingKey', opts.tokenRoutingKey);
    await next();
  });
  return app;
}

describe('enforceRoutingKeyScope', () => {
  it('allows the request when the token is unscoped (routingKey === null)', async () => {
    const app = makeApp({ tokenRoutingKey: null });
    app.get('/probe', (c) => {
      const denied = enforceRoutingKeyScope(c, 'github:42');
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('allows the request when scoped token matches the requested routing key', async () => {
    const app = makeApp({ tokenRoutingKey: 'github:42' });
    app.get('/probe', (c) => {
      const denied = enforceRoutingKeyScope(c, 'github:42');
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
  });

  it('rejects with 403 when the scoped token targets a different routing key', async () => {
    const app = makeApp({ tokenRoutingKey: 'github:42' });
    app.get('/probe', (c) => {
      const denied = enforceRoutingKeyScope(c, 'github:99');
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Access denied/);
  });

  it('rejects with 403 when the scoped token requests a null routing key', async () => {
    const app = makeApp({ tokenRoutingKey: 'github:42' });
    app.get('/probe', (c) => {
      const denied = enforceRoutingKeyScope(c, null);
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(403);
  });

  it('rejects with 403 when the scoped token requests an empty-string routing key', async () => {
    const app = makeApp({ tokenRoutingKey: 'github:42' });
    app.get('/probe', (c) => {
      const denied = enforceRoutingKeyScope(c, '');
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(403);
  });

  it('rejects with 403 when the scoped token requests an undefined routing key', async () => {
    const app = makeApp({ tokenRoutingKey: 'github:42' });
    app.get('/probe', (c) => {
      const denied = enforceRoutingKeyScope(c, undefined);
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(403);
  });

  it('returns a JSON 403 with the documented error shape', async () => {
    const app = makeApp({ tokenRoutingKey: 'github:42' });
    app.get('/probe', (c) => {
      const denied = enforceRoutingKeyScope(c, 'github:99');
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const body = await res.json();
    expect(body).toHaveProperty('error');
    expect(typeof body.error).toBe('string');
  });
});

describe('requireUnscopedToken', () => {
  it('allows the request when the token is unscoped', async () => {
    const app = makeApp({ tokenRoutingKey: null });
    app.get('/probe', (c) => {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(200);
  });

  it('rejects with 403 when the token has any routing-key scope', async () => {
    const app = makeApp({ tokenRoutingKey: 'github:42' });
    app.get('/probe', (c) => {
      const denied = requireUnscopedToken(c);
      if (denied) return denied;
      return c.json({ ok: true });
    });
    const res = await app.request('http://localhost/probe');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/unscoped admin token/);
  });
});
