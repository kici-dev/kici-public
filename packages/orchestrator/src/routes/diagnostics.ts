/**
 * Diagnostic health check HTTP endpoint.
 *
 * Provides GET /admin/diagnose for monitoring system integration.
 * Returns structured JSON with per-check results and overall status.
 */

import { Hono } from 'hono';
import { runDiagnostics } from '../diagnostics/runner.js';
import type { DiagnosticDeps } from '../diagnostics/types.js';

/**
 * Create diagnostic routes.
 *
 * @param deps - Dependencies for diagnostic checks
 * @returns Hono app with /admin/diagnose endpoint
 */
export function createDiagnosticsRoutes(deps: DiagnosticDeps): Hono {
  const app = new Hono();

  app.get('/admin/diagnose', async (c) => {
    const checks = await runDiagnostics(deps);

    // Determine overall status from individual check results
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
