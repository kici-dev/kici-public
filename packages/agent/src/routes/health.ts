import { Hono } from 'hono';
import {
  createHealthRoutes as createBaseHealthRoutes,
  createMetricsRoutes,
  type MetricsRoutesDeps,
} from '@kici-dev/shared';

// Build-time constants injected by Rolldown (scripts/build-service.mjs).
// Mirrored on /health so operators can correlate across services without tailing logs.
declare const KICI_PKG_VERSION: string;
declare const KICI_BUILD_COMMIT: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;

function safe(name: string, fallback = 'unknown'): string {
  // Rolldown rewrites `typeof KICI_*` at build time; at runtime (ts-source tests,
  // dev), the identifier is undefined, and `typeof` is the only safe check.
  switch (name) {
    case 'version':
      return typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : fallback;
    case 'buildCommit':
      return typeof KICI_BUILD_COMMIT !== 'undefined' ? KICI_BUILD_COMMIT : fallback;
    case 'sdkVersion':
      return typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : fallback;
    case 'sdkBundleHash':
      return typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : fallback;
    case 'sharedVersion':
      return typeof KICI_SHARED_VERSION !== 'undefined' ? KICI_SHARED_VERSION : fallback;
    case 'sharedBundleHash':
      return typeof KICI_SHARED_BUNDLE_HASH !== 'undefined' ? KICI_SHARED_BUNDLE_HASH : fallback;
    case 'engineVersion':
      return typeof KICI_ENGINE_VERSION !== 'undefined' ? KICI_ENGINE_VERSION : fallback;
    case 'engineBundleHash':
      return typeof KICI_ENGINE_BUNDLE_HASH !== 'undefined' ? KICI_ENGINE_BUNDLE_HASH : fallback;
    default:
      return fallback;
  }
}

/**
 * Health status provided by the agent runtime.
 */
interface HealthStatus {
  agentId: string;
  connected: boolean;
  activeJobs: number;
}

export interface HealthRoutesDeps extends MetricsRoutesDeps {
  /** Function returning current agent health status */
  getStatus: () => HealthStatus;
}

/**
 * Create health, readiness, and metrics routes.
 *
 * Delegates liveness and readiness to the shared health route helper,
 * adding agent-specific status info and a /metrics endpoint.
 *
 * - GET /health  - Liveness probe (always 200, includes agent status)
 * - GET /ready   - Readiness probe (200 if connected, 503 if not)
 * - GET /metrics - Prometheus metrics
 */
export function createHealthRoutes(deps: HealthRoutesDeps): Hono {
  const app = new Hono();

  // Mount shared health + readiness routes
  const baseRoutes = createBaseHealthRoutes({
    livenessInfo: () => {
      const status = deps.getStatus();
      return {
        agentId: status.agentId,
        activeJobs: status.activeJobs,
        connected: status.connected,
        version: safe('version'),
        buildCommit: safe('buildCommit'),
        sdkVersion: safe('sdkVersion'),
        sdkBundleHash: safe('sdkBundleHash'),
        sharedVersion: safe('sharedVersion'),
        sharedBundleHash: safe('sharedBundleHash'),
        engineVersion: safe('engineVersion'),
        engineBundleHash: safe('engineBundleHash'),
      };
    },
    readinessCheck: async () => {
      const status = deps.getStatus();
      return { connected: status.connected };
    },
  });

  app.route('/', baseRoutes);

  // Mount shared metrics route (uses callback pattern)
  const metricsRoutes = createMetricsRoutes({ getMetrics: deps.getMetrics });
  app.route('/', metricsRoutes);

  return app;
}
