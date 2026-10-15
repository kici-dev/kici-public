import { Hono } from 'hono';
import {
  createHealthRoutes as createBaseHealthRoutes,
  createMetricsRoutes,
  type AgentLivenessInfo,
  type MetricsRoutesDeps,
} from '@kici-dev/shared';

// Injected by Rolldown (scripts/build-service.mjs); mirrored on /health so
// operators can correlate across services without tailing logs.
declare const KICI_PKG_VERSION: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;

function safe(name: string, fallback = 'unknown'): string {
  // Unbuilt (ts-source tests, dev) the identifier is undefined; `typeof` is the only safe check.
  switch (name) {
    case 'version':
      return typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : fallback;
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

interface HealthStatus {
  agentId: string;
  connected: boolean;
  activeJobs: number;
}

export interface HealthRoutesDeps extends MetricsRoutesDeps {
  getStatus: () => HealthStatus;
}

/**
 * - GET /health  - Liveness probe (always 200, includes agent status)
 * - GET /ready   - Readiness probe (200 if connected, 503 if not)
 * - GET /metrics - Prometheus metrics
 */
export function createHealthRoutes(deps: HealthRoutesDeps): Hono {
  const app = new Hono();

  const baseRoutes = createBaseHealthRoutes({
    livenessInfo: (): AgentLivenessInfo => {
      const status = deps.getStatus();
      return {
        agentId: status.agentId,
        activeJobs: status.activeJobs,
        connected: status.connected,
        version: safe('version'),
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

  const metricsRoutes = createMetricsRoutes({ getMetrics: deps.getMetrics });
  app.route('/', metricsRoutes);

  return app;
}
