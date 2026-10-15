/**
 * Composes `registerOrchestratorScheduledJob()` calls for all the
 * orchestrator's periodic work. The returned handles let orchestrator-core.ts
 * thread them into `setupGracefulShutdown`.
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

/** The per-job tick functions and cadences; this helper only composes registrations. */
export interface OrchestratorScheduledJobRegistrations {
  cleanup?: { intervalMs: number; handler: () => Promise<void> };
  /** Short-tick probe that fast-fails jobs nothing in the fleet can route. */
  unroutableProbe?: { intervalMs: number; handler: () => Promise<void> };
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
  if (registrations.unroutableProbe) {
    handles.push(
      registerOrchestratorScheduledJob({
        ...common,
        name: 'unroutable-probe',
        intervalMs: registrations.unroutableProbe.intervalMs,
        handler: registrations.unroutableProbe.handler,
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
