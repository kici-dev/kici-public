/**
 * Shape assertions for the admin-config Bearer-token comparison.
 *
 * The token check routes through crypto.timingSafeEqual behind a byte-length
 * guard. These tests assert that shape: a wrong same-length token is compared
 * in constant time, a byte-length mismatch is refused before the compare (so
 * timingSafeEqual never throws a RangeError and turns a 401 into a 500), and
 * the 401/503 outcomes stay unchanged. Timing itself is deliberately never
 * asserted — a timing test is load-sensitive and flaky.
 *
 * node:crypto is mocked module-wide so timingSafeEqual can be observed. The
 * mock spreads the real module, so every other crypto export (and the wrapped
 * timingSafeEqual's real behavior) stays intact. The spy-call assertion in the
 * first test is the positive control: if it passes before the constant-time
 * comparison lands, the mock did not apply and every not.toHaveBeenCalled()
 * below is worthless.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

const cryptoMock = vi.hoisted(() => ({ timingSafeEqualSpy: vi.fn() }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      cryptoMock.timingSafeEqualSpy(a, b);
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { createConfigAdminRoutes, type ConfigRouteDeps } from './admin-config.js';
import { AUTH_ERROR } from './admin-auth.js';
import type { SharedConfigStore } from '../config/shared-store.js';
import type { ConfigReloader } from '../config/reload.js';

// 8 characters, 8 UTF-8 bytes.
const ADMIN_TOKEN = 'abcdefgh';

function createApp(adminToken: string | undefined) {
  const sharedStore = {
    exportRedacted: vi.fn().mockResolvedValue({ foo: 'bar' }),
    getCurrentVersion: vi.fn().mockResolvedValue(1),
  } as unknown as SharedConfigStore;
  const configReloader = {} as unknown as ConfigReloader;
  const deps: ConfigRouteDeps = {
    sharedStore,
    configReloader,
    adminToken,
    loadLocalConfig: vi.fn().mockResolvedValue({}),
  };
  const app = new Hono();
  app.route('/admin/config', createConfigAdminRoutes(deps));
  return app;
}

describe('admin-config Bearer token comparison (shape)', () => {
  beforeEach(() => {
    cryptoMock.timingSafeEqualSpy.mockClear();
  });

  it('compares a same-length wrong token through timingSafeEqual and returns 401', async () => {
    const app = createApp(ADMIN_TOKEN);
    const res = await app.request('/admin/config/export', {
      method: 'GET',
      // 8 characters / 8 bytes — same byte length as ADMIN_TOKEN, so the
      // guard passes and the compare reaches timingSafeEqual.
      headers: { Authorization: 'Bearer wrongtok' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid token' });
    // Positive control for the whole file: proves the node:crypto mock applied.
    expect(cryptoMock.timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('accepts the correct token, comparing it through timingSafeEqual', async () => {
    const app = createApp(ADMIN_TOKEN);
    const res = await app.request('/admin/config/export', {
      method: 'GET',
      headers: { Authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    expect(cryptoMock.timingSafeEqualSpy).toHaveBeenCalledTimes(1);
  });

  it('refuses an ASCII byte-length mismatch without calling timingSafeEqual', async () => {
    const app = createApp(ADMIN_TOKEN);
    const res = await app.request('/admin/config/export', {
      method: 'GET',
      // 5 bytes vs 8 — refused by the length guard before the compare.
      headers: { Authorization: 'Bearer short' },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid token' });
    expect(cryptoMock.timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('refuses a multi-byte mismatch (equal String.length, differing byte length) without calling timingSafeEqual', async () => {
    const app = createApp(ADMIN_TOKEN);
    // 8 characters (String.length 8) but 9 UTF-8 bytes: a String.length guard
    // would let this reach timingSafeEqual, which throws RangeError and turns a
    // 401 into a 500. The byte-length guard refuses it first.
    const multibyte = 'abcdefgé';
    expect(multibyte.length).toBe(ADMIN_TOKEN.length);
    expect(Buffer.byteLength(multibyte, 'utf8')).not.toBe(Buffer.byteLength(ADMIN_TOKEN, 'utf8'));
    const res = await app.request('/admin/config/export', {
      method: 'GET',
      headers: { Authorization: `Bearer ${multibyte}` },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Invalid token' });
    expect(cryptoMock.timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('returns 401 with the missing-auth body when no Authorization header is present', async () => {
    const app = createApp(ADMIN_TOKEN);
    const res = await app.request('/admin/config/export', { method: 'GET' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: AUTH_ERROR.missing });
    expect(cryptoMock.timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('returns 503 when the admin token is not configured', async () => {
    const app = createApp(undefined);
    const res = await app.request('/admin/config/export', {
      method: 'GET',
      headers: { Authorization: 'Bearer anything' },
    });
    expect(res.status).toBe(503);
    expect(cryptoMock.timingSafeEqualSpy).not.toHaveBeenCalled();
  });
});
