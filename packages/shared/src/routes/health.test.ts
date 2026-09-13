import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHealthRoutes } from './health.js';

describe('createHealthRoutes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const app = createHealthRoutes();

      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.timestamp).toBe('2026-01-15T12:00:00.000Z');
      expect(typeof body.uptime).toBe('number');
    });

    it('includes extra info from livenessInfo callback', async () => {
      const app = createHealthRoutes({
        livenessInfo: () => ({
          agentId: 'agent-01',
          activeJobs: 3,
        }),
      });

      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.agentId).toBe('agent-01');
      expect(body.activeJobs).toBe(3);
    });
  });

  describe('GET /ready', () => {
    it('returns 200 when no readiness check is provided', async () => {
      const app = createHealthRoutes();

      const res = await app.request('/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ready');
      expect(body.checks).toEqual({});
    });

    it('returns 200 when all checks pass', async () => {
      const app = createHealthRoutes({
        readinessCheck: async () => ({
          database: true,
          cache: true,
        }),
      });

      const res = await app.request('/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ready');
      expect(body.checks).toEqual({ database: true, cache: true });
    });

    it('returns 503 when any check fails', async () => {
      const app = createHealthRoutes({
        readinessCheck: async () => ({
          database: true,
          cache: false,
        }),
      });

      const res = await app.request('/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('not ready');
      expect(body.checks).toEqual({ database: true, cache: false });
    });

    it('returns 503 when all checks fail', async () => {
      const app = createHealthRoutes({
        readinessCheck: async () => ({
          database: false,
        }),
      });

      const res = await app.request('/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('not ready');
    });
  });
});
