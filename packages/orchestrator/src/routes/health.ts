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

/**
 * The fields the orchestrator adds to its `/health` body. The route below
 * returns this type, and `kici-admin orchestrator status` renders it.
 */
export interface OrchestratorLivenessInfo extends BuildFingerprint {
  /** ISO-8601 time the orchestrator bundle was built. */
  buildDate: string;
}

export interface HealthRoutesDeps {
  /** Optional DB instance for readiness checks */
  db?: Kysely<Database>;
  /**
   * Optional warmth latch. Returns `true` only once the orchestrator boot
   * sequence has finished (all subsystems started, HTTP server serving). When
   * provided, `/ready` returns `503` until it flips `true`, so a caller can
   * gate on the orchestrator being ready to serve rather than merely live.
   * Absent → warm defaults to `true` (callers that don't wire the latch are
   * unaffected).
   */
  isWarm?: () => boolean;
}

/**
 * Create orchestrator health routes with database readiness check.
 *
 * Delegates to the shared health route helper, providing
 * a database connectivity check as the readiness probe.
 *
 * - GET /health - Liveness probe (always 200)
 * - GET /ready  - Readiness probe (checks DB if provided)
 *
 * @param deps - Dependencies (optional database for readiness)
 * @returns Hono app with health routes
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
          // Boot-completion latch: false until every startup subsystem is wired
          // and the HTTP server is serving. Absent latch defaults to warm.
          checks.warm = deps.isWarm ? deps.isWarm() : true;
          return checks;
        }
      : undefined,
  });
}
