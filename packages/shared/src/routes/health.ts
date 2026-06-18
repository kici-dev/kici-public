import { Hono } from 'hono';

export interface HealthRoutesDeps {
  /**
   * Optional extra fields to include in the liveness response.
   * Called on every `/health` request.
   */
  livenessInfo?: () => Record<string, unknown>;

  /**
   * Optional readiness checks. Each key is a check name, each value
   * indicates whether that check passed.
   * Called on every `/ready` request.
   * If omitted, the service is always considered ready.
   */
  readinessCheck?: () => Promise<Record<string, boolean>>;
}

/**
 * Create health and readiness routes.
 *
 * - GET /health - Liveness probe (always 200)
 * - GET /ready  - Readiness probe (200 if all checks pass, 503 if any fail)
 *
 * @param deps - Optional liveness info provider and readiness check function
 * @returns Hono app with /health and /ready endpoints
 */
export function createHealthRoutes(deps: HealthRoutesDeps = {}): Hono {
  const app = new Hono();

  /**
   * Liveness probe - always returns 200.
   * Includes timestamp, uptime, and any extra info from livenessInfo().
   */
  app.get('/health', (c) => {
    const extra = deps.livenessInfo?.() ?? {};
    return c.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      ...extra,
    });
  });

  /**
   * Readiness probe - returns 200 when all checks pass, 503 otherwise.
   * If no readiness check is provided, always returns 200.
   */
  app.get('/ready', async (c) => {
    const checks = deps.readinessCheck ? await deps.readinessCheck() : {};
    const ready = Object.values(checks).every((v) => v);

    return c.json(
      {
        status: ready ? 'ready' : 'not ready',
        checks,
      },
      ready ? 200 : 503,
    );
  });

  return app;
}
