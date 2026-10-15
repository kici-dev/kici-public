/**
 * Shape assertions for the admin-config Bearer-token comparison.
 *
 * The check runs crypto.timingSafeEqual behind a byte-length guard: a wrong
 * same-length token is compared in constant time, a byte-length mismatch is
 * refused before the compare (so timingSafeEqual never throws a RangeError and
 * turns a 401 into a 500), and the 401/503 outcomes stay unchanged. Timing
 * itself is deliberately never asserted: it is load-sensitive.
 *
 * node:crypto is mocked module-wide (spreading the real module) so
 * timingSafeEqual can be observed. The spy-call assertion in the first test is
 * the positive control: without it, every not.toHaveBeenCalled() below could
 * pass with the mock not applied.
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
      // Same byte length as ADMIN_TOKEN, so the compare reaches timingSafeEqual.
      headers: { Authorization: 'Bearer wrongtok' },
    });
    expect(res.status).toBe(401);
    // Body contract pinned by admin-config.test.ts: this router wants the
    // orchestrator secret key, not the bootstrap admin token, and must say so
    // without echoing the token it saw.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('KICI_SECRET_KEY');
    expect(body.error).toContain('bootstrap admin token');
    expect(body.error).not.toContain('wrongtok');
    // Positive control for the file: the node:crypto mock applied.
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
    // Same body contract as above.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('KICI_SECRET_KEY');
    expect(body.error).toContain('bootstrap admin token');
    expect(body.error).not.toContain('short');
    expect(cryptoMock.timingSafeEqualSpy).not.toHaveBeenCalled();
  });

  it('refuses a multi-byte mismatch (equal String.length, differing byte length) without calling timingSafeEqual', async () => {
    const app = createApp(ADMIN_TOKEN);
    // Equal String.length, one more UTF-8 byte: a String.length guard would let
    // this reach timingSafeEqual, which throws RangeError (401 → 500).
    const multibyte = 'abcdefgé';
    expect(multibyte.length).toBe(ADMIN_TOKEN.length);
    expect(Buffer.byteLength(multibyte, 'utf8')).not.toBe(Buffer.byteLength(ADMIN_TOKEN, 'utf8'));
    const res = await app.request('/admin/config/export', {
      method: 'GET',
      headers: { Authorization: `Bearer ${multibyte}` },
    });
    expect(res.status).toBe(401);
    // Same body contract as above.
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('KICI_SECRET_KEY');
    expect(body.error).toContain('bootstrap admin token');
    expect(body.error).not.toContain(multibyte);
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
