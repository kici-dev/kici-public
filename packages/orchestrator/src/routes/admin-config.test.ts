/**
 * Unit tests for admin config REST API routes.
 */

import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { createConfigAdminRoutes, type ConfigRouteDeps } from './admin-config.js';
import type { SharedConfigStore } from '../config/shared-store.js';
import type { ConfigReloader } from '../config/reload.js';
import type { AppConfig } from '../config/types.js';

function mockSharedStore(): SharedConfigStore {
  return {
    getLatest: vi.fn().mockResolvedValue({
      config: { providers: { github: [{ name: 'test', appId: '123', privateKey: 'pk' }] } },
      version: 3,
    }),
    getByVersion: vi.fn().mockResolvedValue(null),
    save: vi.fn().mockResolvedValue(4),
    listHistory: vi.fn().mockResolvedValue([
      { version: 3, createdAt: new Date(), createdBy: 'test', description: 'initial' },
      { version: 2, createdAt: new Date(), createdBy: 'test', description: 'prev' },
    ]),
    rollback: vi.fn().mockResolvedValue(5),
    getCurrentVersion: vi.fn().mockResolvedValue(3),
    exportRedacted: vi.fn().mockResolvedValue({
      providers: { github: [{ name: 'test', appId: '123', privateKey: '***REDACTED***' }] },
    }),
  } as unknown as SharedConfigStore;
}

function mockConfigReloader(): ConfigReloader {
  return {
    getCurrentConfig: vi.fn().mockReturnValue({
      instanceId: 'test-1',
      mode: 'independent',
      databaseUrl: 'postgresql://localhost/kici',
      port: 4000,
      basePath: '/',
      providers: { github: [{ name: 'test', appId: '123', privateKey: 'pk' }] },
      agentAuth: 'token',
      cluster: { joinToken: 'secret-join-token' },
    } as Partial<AppConfig>),
    getCurrentVersion: vi.fn().mockReturnValue(3),
    executeReload: vi.fn().mockResolvedValue({ success: true, version: 4 }),
  } as unknown as ConfigReloader;
}

function createTestApp(overrides?: Partial<ConfigRouteDeps>) {
  const deps: ConfigRouteDeps = {
    sharedStore: mockSharedStore(),
    configReloader: mockConfigReloader(),
    adminToken: 'test-admin-token',
    loadLocalConfig: vi.fn().mockResolvedValue({ database: { url: 'pg://localhost' } }),
    ...overrides,
  };

  const app = new Hono();
  app.route('/admin/config', createConfigAdminRoutes(deps));
  return { app, deps };
}

const AUTH = { Authorization: 'Bearer test-admin-token' };
const JSON_HEADERS = { ...AUTH, 'Content-Type': 'application/json' };

describe('admin-config routes', () => {
  describe('auth middleware', () => {
    it('returns 401 without auth header', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/export', { method: 'GET' });
      expect(res.status).toBe(401);
    });

    it('returns 401 with invalid token', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/export', {
        method: 'GET',
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 503 when admin token not configured', async () => {
      const { app } = createTestApp({ adminToken: undefined });
      const res = await app.request('/admin/config/export', {
        method: 'GET',
        headers: { Authorization: 'Bearer anything' },
      });
      expect(res.status).toBe(503);
    });
  });

  describe('POST /seed', () => {
    it('seeds shared config and returns version', async () => {
      const { app, deps } = createTestApp();
      const res = await app.request('/admin/config/seed', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          config: { providers: { github: [{ name: 'a', appId: '1' }] } },
          description: 'test seed',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe(4);
      expect(deps.sharedStore.save).toHaveBeenCalledWith(
        { providers: { github: [{ name: 'a', appId: '1' }] } },
        'api:seed',
        'test seed',
      );
    });

    it('returns 400 when config is missing', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/seed', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('GET / (current effective config)', () => {
    it('returns current merged config (redacted)', async () => {
      const { app } = createTestApp();
      // Use a known sub-path to test -- we need to use the root mount
      const res = await app.request('http://localhost/admin/config', {
        method: 'GET',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.source).toBe('merged');
      expect(body.version).toBe(3);
      // Sensitive fields should be redacted
      expect(body.config.cluster.joinToken).toBe('***REDACTED***');
    });

    it('returns filtered config by path', async () => {
      const { app } = createTestApp();
      const res = await app.request('http://localhost/admin/config?path=port', {
        method: 'GET',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toBe(4000);
    });

    it('returns 404 for non-existent path', async () => {
      const { app } = createTestApp();
      const res = await app.request('http://localhost/admin/config?path=nonexistent.deep.path', {
        method: 'GET',
        headers: AUTH,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT / (update single field)', () => {
    it('updates a single field and returns version', async () => {
      const { app, deps } = createTestApp();
      const res = await app.request('http://localhost/admin/config', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ path: 'agentAuth', value: 'none' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe(4);
      expect(deps.sharedStore.save).toHaveBeenCalled();
    });

    it('returns 400 when path is missing', async () => {
      const { app } = createTestApp();
      const res = await app.request('http://localhost/admin/config', {
        method: 'PUT',
        headers: JSON_HEADERS,
        body: JSON.stringify({ value: 'test' }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE / (remove field)', () => {
    it('removes a field and returns version', async () => {
      const { app, deps } = createTestApp();
      const res = await app.request('http://localhost/admin/config', {
        method: 'DELETE',
        headers: JSON_HEADERS,
        body: JSON.stringify({ path: 'webhookPayloadDir' }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.version).toBe(4);
      expect(deps.sharedStore.save).toHaveBeenCalled();
    });

    it('returns 404 when no shared config exists', async () => {
      const store = mockSharedStore();
      (store.getLatest as any).mockResolvedValue(null);
      const { app } = createTestApp({ sharedStore: store });
      const res = await app.request('http://localhost/admin/config', {
        method: 'DELETE',
        headers: JSON_HEADERS,
        body: JSON.stringify({ path: 'something' }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe('GET /export', () => {
    it('returns redacted shared config', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/export', {
        method: 'GET',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config.providers.github[0].privateKey).toBe('***REDACTED***');
      expect(body.version).toBe(3);
    });

    it('returns empty config when no versions exist', async () => {
      const store = mockSharedStore();
      (store.exportRedacted as any).mockResolvedValue(null);
      (store.getCurrentVersion as any).mockResolvedValue(0);
      const { app } = createTestApp({ sharedStore: store });
      const res = await app.request('/admin/config/export', {
        method: 'GET',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.config).toEqual({});
      expect(body.version).toBe(0);
    });
  });

  describe('POST /validate', () => {
    it('validates valid shared config', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/validate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          config: { providers: { github: [{ name: 'a', appId: '1' }] } },
          type: 'shared',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(true);
    });

    it('returns validation errors for invalid config', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/validate', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({
          config: { database: {} }, // missing url
          type: 'local',
        }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.valid).toBe(false);
      expect(body.errors).toBeDefined();
      expect(body.errors.length).toBeGreaterThan(0);
    });
  });

  describe('GET /diff', () => {
    it('returns diff between local and shared config', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/diff', {
        method: 'GET',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveProperty('local');
      expect(body).toHaveProperty('shared');
      expect(body).toHaveProperty('differences');
      expect(Array.isArray(body.differences)).toBe(true);
    });
  });

  describe('GET /history', () => {
    it('returns version history', async () => {
      const { app, deps } = createTestApp();
      const res = await app.request('/admin/config/history?limit=10', {
        method: 'GET',
        headers: AUTH,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.versions).toHaveLength(2);
      expect(deps.sharedStore.listHistory).toHaveBeenCalledWith(10);
    });

    it('uses default limit when not specified', async () => {
      const { app, deps } = createTestApp();
      await app.request('/admin/config/history', {
        method: 'GET',
        headers: AUTH,
      });
      expect(deps.sharedStore.listHistory).toHaveBeenCalledWith(20);
    });
  });

  describe('POST /rollback', () => {
    it('rolls back to specified version', async () => {
      const { app, deps } = createTestApp();
      const res = await app.request('/admin/config/rollback', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ version: 2 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.newVersion).toBe(5);
      expect(deps.sharedStore.rollback).toHaveBeenCalledWith(2, 'api:rollback');
    });

    it('returns 400 for invalid version', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/rollback', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ version: -1 }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /reload', () => {
    it('triggers reload and returns result', async () => {
      const { app, deps } = createTestApp();
      const res = await app.request('/admin/config/reload', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect((deps.configReloader as any).executeReload).toHaveBeenCalledWith({
        source: 'http',
        drain: undefined,
      });
    });

    it('passes drain option', async () => {
      const { app, deps } = createTestApp();
      await app.request('/admin/config/reload', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ drain: true }),
      });
      expect((deps.configReloader as any).executeReload).toHaveBeenCalledWith({
        source: 'http',
        drain: true,
      });
    });

    it('returns 501 when target is specified but no forwarder configured', async () => {
      const { app } = createTestApp();
      const res = await app.request('/admin/config/reload', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: 'instance-2' }),
      });
      expect(res.status).toBe(501);
    });

    it('forwards to peer when target is specified and forwarder is available', async () => {
      const forwardReloadToPeer = vi
        .fn()
        .mockResolvedValue({ success: true, version: 7, fieldsChanged: ['agentAuth'] });
      const { app } = createTestApp({ forwardReloadToPeer });
      const res = await app.request('/admin/config/reload', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: 'instance-2', drain: true }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);
      expect(body.version).toBe(7);
      expect(forwardReloadToPeer).toHaveBeenCalledWith('instance-2', { drain: true });
    });

    it('returns 404 when target peer is not connected', async () => {
      const forwardReloadToPeer = vi.fn().mockResolvedValue(null);
      const { app } = createTestApp({ forwardReloadToPeer });
      const res = await app.request('/admin/config/reload', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: 'unknown-instance' }),
      });
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error).toMatch(/unknown-instance/);
    });

    it('returns peer error result when forwarded reload fails', async () => {
      const forwardReloadToPeer = vi
        .fn()
        .mockResolvedValue({ success: false, errors: ['validation failed'] });
      const { app } = createTestApp({ forwardReloadToPeer });
      const res = await app.request('/admin/config/reload', {
        method: 'POST',
        headers: JSON_HEADERS,
        body: JSON.stringify({ target: 'instance-2' }),
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.success).toBe(false);
      expect(body.errors).toEqual(['validation failed']);
    });
  });
});
