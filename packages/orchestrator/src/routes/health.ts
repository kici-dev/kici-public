import { createHealthRoutes as createBaseHealthRoutes } from '@kici-dev/shared';
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';

// Build-time constants injected by Rolldown (scripts/build-service.mjs).
// Workspace dep fingerprints are mirrored on /health so operators can diff
// agent.sdkBundleHash against orchestrator.sdkBundleHash in one curl pair.
declare const KICI_PKG_VERSION: string;
declare const KICI_BUILD_DATE: string;
declare const KICI_BUILD_COMMIT: string;
declare const KICI_SDK_VERSION: string;
declare const KICI_SDK_BUNDLE_HASH: string;
declare const KICI_SHARED_VERSION: string;
declare const KICI_SHARED_BUNDLE_HASH: string;
declare const KICI_ENGINE_VERSION: string;
declare const KICI_ENGINE_BUNDLE_HASH: string;

export interface HealthRoutesDeps {
  /** Optional DB instance for readiness checks */
  db?: Kysely<Database>;
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
    livenessInfo: () => ({
      version: typeof KICI_PKG_VERSION !== 'undefined' ? KICI_PKG_VERSION : 'unknown',
      buildDate: typeof KICI_BUILD_DATE !== 'undefined' ? KICI_BUILD_DATE : 'unknown',
      buildCommit: typeof KICI_BUILD_COMMIT !== 'undefined' ? KICI_BUILD_COMMIT : 'unknown',
      sdkVersion: typeof KICI_SDK_VERSION !== 'undefined' ? KICI_SDK_VERSION : 'unknown',
      sdkBundleHash: typeof KICI_SDK_BUNDLE_HASH !== 'undefined' ? KICI_SDK_BUNDLE_HASH : 'unknown',
      sharedVersion: typeof KICI_SHARED_VERSION !== 'undefined' ? KICI_SHARED_VERSION : 'unknown',
      sharedBundleHash:
        typeof KICI_SHARED_BUNDLE_HASH !== 'undefined' ? KICI_SHARED_BUNDLE_HASH : 'unknown',
      engineVersion: typeof KICI_ENGINE_VERSION !== 'undefined' ? KICI_ENGINE_VERSION : 'unknown',
      engineBundleHash:
        typeof KICI_ENGINE_BUNDLE_HASH !== 'undefined' ? KICI_ENGINE_BUNDLE_HASH : 'unknown',
    }),
    readinessCheck: deps.db
      ? async () => {
          const checks: Record<string, boolean> = {};
          try {
            await deps.db!.selectFrom('dedup_cache').select('delivery_id').limit(1).execute();
            checks.database = true;
          } catch {
            checks.database = false;
          }
          return checks;
        }
      : undefined,
  });
}
