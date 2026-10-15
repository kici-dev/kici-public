/**
 * GET /admin/diagnose for monitoring systems: structured JSON with per-check
 * results and an overall status.
 */

import { Hono } from 'hono';
import { runDiagnostics } from '../diagnostics/runner.js';
import type { DiagnosticDeps } from '../diagnostics/types.js';

export function createDiagnosticsRoutes(deps: DiagnosticDeps): Hono {
  const app = new Hono();

  app.get('/admin/diagnose', async (c) => {
    const checks = await runDiagnostics(deps);

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (checks.some((check) => check.status === 'fail')) {
      status = 'unhealthy';
    } else if (checks.some((check) => check.status === 'warn')) {
      status = 'degraded';
    }

    return c.json({
      status,
      checks,
      timestamp: new Date().toISOString(),
    });
  });

  return app;
}
