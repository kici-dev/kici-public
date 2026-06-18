import { describe, it, expect } from 'vitest';
import { createHealthRoutes, type HealthStatus } from './health.js';

function createTestDeps(overrides: Partial<HealthStatus> = {}) {
  const status: HealthStatus = {
    agentId: 'test-agent-01',
    connected: true,
    activeJobs: 1,
    ...overrides,
  };

  return {
    app: createHealthRoutes({
      getMetrics: async () => ({
        contentType: 'text/plain; version=0.0.4; charset=utf-8',
        body: '# HELP test_metric A test\n# TYPE test_metric counter\ntest_metric 1\n',
      }),
      getStatus: () => status,
    }),
  };
}

describe('health routes', () => {
  describe('GET /health', () => {
    it('returns 200 with expected JSON shape', async () => {
      const { app } = createTestDeps();

      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.agentId).toBe('test-agent-01');
      expect(body.activeJobs).toBe(1);
      expect(body.connected).toBe(true);
      expect(typeof body.timestamp).toBe('string');
      expect(typeof body.uptime).toBe('number');
    });

    it('returns 200 even when disconnected', async () => {
      const { app } = createTestDeps({ connected: false });

      const res = await app.request('/health');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ok');
      expect(body.connected).toBe(false);
    });
  });

  describe('GET /ready', () => {
    it('returns 200 when connected', async () => {
      const { app } = createTestDeps({ connected: true });

      const res = await app.request('/ready');

      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.status).toBe('ready');
      expect(body.checks.connected).toBe(true);
    });

    it('returns 503 when disconnected', async () => {
      const { app } = createTestDeps({ connected: false });

      const res = await app.request('/ready');

      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body.status).toBe('not ready');
      expect(body.checks.connected).toBe(false);
    });
  });

  describe('GET /metrics', () => {
    it('returns text/plain with Prometheus format', async () => {
      const { app } = createTestDeps();

      const res = await app.request('/metrics');

      expect(res.status).toBe(200);
      const contentType = res.headers.get('content-type');
      expect(contentType).toContain('text/plain');

      const body = await res.text();
      expect(body).toContain('# HELP');
      expect(body).toContain('# TYPE');
    });
  });
});
