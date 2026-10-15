import {
  createHealthRoutes as createBaseHealthRoutes,
  retryOnBrokenConnection,
  type BuildFingerprint,
} from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

// Build-time constants injected by Rolldown (scripts/build-service.mjs).
// Workspace dep fingerprints are mirrored on /health so operators can diff
// agent.sdkBundleHash against orchestrator.sdkBundleHash in one curl pair.
declare const KICI_PKG_VERSION: string;
declare const KICI_BUILD_DATE: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;

/** Fields the orchestrator adds to `/health`, rendered by `kici-admin orchestrator status`. */
export interface OrchestratorLivenessInfo extends BuildFingerprint {
  /** ISO-8601 time the orchestrator bundle was built. */
  buildDate: string;
}

export interface HealthRoutesDeps {
  /** Enables the DB readiness check. */
  db?: Kysely<Database>;
  /**
   * Warmth latch: `true` only once boot has finished (all subsystems started,
   * HTTP server serving). When provided, `/ready` returns `503` until it flips,
   * so a caller can gate on ready-to-serve rather than merely live. Absent →
   * warm defaults to `true`.
   */
  isWarm?: () => boolean;
}

/**
 * - GET /health - Liveness probe (always 200)
 * - GET /ready  - Readiness probe (checks DB if provided)
 */
export function createHealthRoutes(deps: HealthRoutesDeps = {}) {
  return createBaseHealthRoutes({
    livenessInfo: (): OrchestratorLivenessInfo => {
      const version = typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : 'unknown';
      return {
        version,
        buildDate: typeof KICI_BUILD_DATE !== 'undefined' ? KICI_BUILD_DATE : 'unknown',
        sdkVersion: typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : 'unknown',
        sdkBundleHash:
          typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : 'unknown',
        sharedVersion: typeof KICI_SHARED_VERSION !== 'undefined' ? KICI_SHARED_VERSION : 'unknown',
        sharedBundleHash:
          typeof KICI_SHARED_BUNDLE_HASH !== 'undefined' ? KICI_SHARED_BUNDLE_HASH : 'unknown',
        engineVersion: typeof KICI_ENGINE_VERSION !== 'undefined' ? KICI_ENGINE_VERSION : 'unknown',
        engineBundleHash:
          typeof KICI_ENGINE_BUNDLE_HASH !== 'undefined' ? KICI_ENGINE_BUNDLE_HASH : 'unknown',
      };
    },
    readinessCheck: deps.db
      ? async () => {
          const checks: Record<string, boolean> = {};
          try {
            // A pooled connection killed by a switchover is not an outage: the
            // probe asks again on another connection before it reports one.
            await retryOnBrokenConnection(() =>
              deps.db!.selectFrom('dedup_cache').select('delivery_id').limit(1).execute(),
            );
            checks.database = true;
          } catch {
            checks.database = false;
          }
          // Absent latch defaults to warm.
          checks.warm = deps.isWarm ? deps.isWarm() : true;
          return checks;
        }
      : undefined,
  });
}
