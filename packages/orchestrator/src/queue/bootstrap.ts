/**
 * Orchestrator scheduled-jobs bootstrap helper.
 *
 * Composes `registerOrchestratorScheduledJob()` calls for all the
 * orchestrator's periodic work. Returns an array of handles so the
 * caller (orchestrator-core.ts) can thread them into
 * `setupGracefulShutdown`.
 *
 * Commit 5 ships the infrastructure; Commit 6 migrates the three
 * legacy setInterval schedulers (queue cleanup, secret cleanup,
 * token cleanup) into this helper. Commit 7 adds the
 * `cold-store-archive` entry.
 */
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import {
  type OrchestratorScheduledJobHandle,
  registerOrchestratorScheduledJob,
} from './scheduled-job.js';

export interface OrchestratorScheduledJobsDeps {
  db: Kysely<Database>;
  instanceId: string;
  routingKey?: string;
}

/**
 * Overrides for the per-job handler + cadence. Callers pass the
 * actual tick functions here — the bootstrap helper only composes
 * registrations.
 */
export interface OrchestratorScheduledJobRegistrations {
  cleanup?: { intervalMs: number; handler: () => Promise<void> };
  orphanSecretCleanup?: { intervalMs: number; handler: () => Promise<void> };
  tokenCleanup?: { intervalMs: number; handler: () => Promise<void> };
  coldStoreArchive?: { intervalMs: number; handler: () => Promise<void> };
  coldStorePurge?: { intervalMs: number; handler: () => Promise<void> };
}

export function bootstrapOrchestratorScheduledJobs(
  deps: OrchestratorScheduledJobsDeps,
  registrations: OrchestratorScheduledJobRegistrations,
): OrchestratorScheduledJobHandle[] {
  const handles: OrchestratorScheduledJobHandle[] = [];
  const common = {
    instanceId: deps.instanceId,
    db: deps.db,
    routingKey: deps.routingKey,
  };

  if (registrations.cleanup) {
    handles.push(
      registerOrchestratorScheduledJob({
        ...common,
        name: 'cleanup',
        intervalMs: registrations.cleanup.intervalMs,
        handler: registrations.cleanup.handler,
      }),
    );
  }
  if (registrations.orphanSecretCleanup) {
    handles.push(
      registerOrchestratorScheduledJob({
        ...common,
        name: 'orphan-secret-cleanup',
        intervalMs: registrations.orphanSecretCleanup.intervalMs,
        handler: registrations.orphanSecretCleanup.handler,
      }),
    );
  }
  if (registrations.tokenCleanup) {
    handles.push(
      registerOrchestratorScheduledJob({
        ...common,
        name: 'token-cleanup',
        intervalMs: registrations.tokenCleanup.intervalMs,
        handler: registrations.tokenCleanup.handler,
      }),
    );
  }
  if (registrations.coldStoreArchive) {
    handles.push(
      registerOrchestratorScheduledJob({
        ...common,
        name: 'cold-store-archive',
        intervalMs: registrations.coldStoreArchive.intervalMs,
        handler: registrations.coldStoreArchive.handler,
      }),
    );
  }
  if (registrations.coldStorePurge) {
    handles.push(
      registerOrchestratorScheduledJob({
        ...common,
        name: 'cold-store-purge',
        intervalMs: registrations.coldStorePurge.intervalMs,
        handler: registrations.coldStorePurge.handler,
      }),
    );
  }

  return handles;
}
