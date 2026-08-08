import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import { createOnErrorHandler } from './app-on-error.js';

describe('createOnErrorHandler', () => {
  it('turns an unhandled route throw into a structured 500 JSON body', async () => {
    const logger = { error: vi.fn() };
    const app = new Hono();
    app.onError(createOnErrorHandler({ role: 'coordinator', logger }));
    app.get('/boom', () => {
      throw new Error('unexpected failure');
    });

    const res = await app.request('/boom');

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });

  it('logs the error with the route, at error level', async () => {
    const logger = { error: vi.fn() };
    const app = new Hono();
    app.onError(createOnErrorHandler({ role: 'coordinator', logger }));
    app.post('/boom', () => {
      throw new Error('unexpected failure');
    });

    await app.request('/boom', { method: 'POST' });

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [msg, meta] = logger.error.mock.calls[0]!;
    expect(msg).toBe('Unhandled request error');
    expect(meta).toMatchObject({ role: 'coordinator', method: 'POST', path: '/boom' });
    expect(String(meta!.error)).toContain('unexpected failure');
  });

  it('never serializes request headers (no credential leak through the backstop)', async () => {
    const SENTINEL = 'kici-sentinel-credential-8f3a2b1c9d4e';
    const logger = { error: vi.fn() };
    const app = new Hono();
    app.onError(createOnErrorHandler({ role: 'coordinator', logger }));
    app.get('/boom', () => {
      throw new Error('unexpected failure');
    });

    await app.request('/boom', { headers: { Authorization: `Bearer ${SENTINEL}` } });

    const serialized = JSON.stringify(logger.error.mock.calls);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('Bearer');
  });
});

describe('createOnErrorHandler -- a deliberate HTTPException is not rewritten to 500', () => {
  it('passes an explicitly thrown HTTPException through with its own status', async () => {
    const logger = { error: vi.fn() };
    const app = new Hono();
    app.onError(createOnErrorHandler({ role: 'coordinator', logger }));
    app.get('/gone', () => {
      throw new HTTPException(410, { message: 'Gone' });
    });

    const res = await app.request('/gone');

    expect(res.status).toBe(410);
    // A considered 4xx is not a fault, so it must not be logged as one -- that
    // is the error-rate signal this handler exists to keep honest.
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps hono bodyLimit's 413 a 413 on the app that registers the handler", async () => {
    const logger = { error: vi.fn() };
    const app = new Hono();
    app.onError(createOnErrorHandler({ role: 'coordinator', logger }));
    app.post('/upload', bodyLimit({ maxSize: 10 }), (c) => c.json({ ok: true }));

    const res = await app.request('/upload', { method: 'POST', body: 'x'.repeat(100) });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('Payload Too Large');
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("keeps bodyLimit's 413 a 413 for a mounted sub-app that inherits the handler", async () => {
    // This is the shape the orchestrator actually runs: the webhook and
    // blob-cache routers carry their own bodyLimit and are mounted into the
    // root app, which owns the only onError.
    const logger = { error: vi.fn() };
    const sub = new Hono();
    sub.post('/upload', bodyLimit({ maxSize: 10 }), (c) => c.json({ ok: true }));
    const root = new Hono();
    root.onError(createOnErrorHandler({ role: 'coordinator', logger }));
    root.route('/', sub);

    const res = await root.request('/upload', { method: 'POST', body: 'x'.repeat(100) });

    expect(res.status).toBe(413);
    expect(logger.error).not.toHaveBeenCalled();
  });
});
